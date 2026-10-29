import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { runFile } from './runtime.mjs';

export function inspectAudio(file, duration) {
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8' }
    )
  );
  if (!metadata.streams.some((s) => s.codec_type === 'audio'))
    throw new Error('所选音乐没有音频轨道。');
  if (Number(metadata.format.duration) < duration)
    throw new Error('音乐短于视频，请缩短 --duration 或选择更长的音乐。');
}

export function verifyPreparedMusic(videoFile, referenceFile) {
  const decode = (file) => {
    const bytes = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        'f32le',
        'pipe:1'
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    return new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );
  };
  const actual = decode(videoFile),
    expected = decode(referenceFile),
    n = Math.min(actual.length, expected.length);
  let xy = 0,
    xx = 0,
    yy = 0;
  for (let i = 0; i < n; i++) {
    xy += actual[i] * expected[i];
    xx += actual[i] ** 2;
    yy += expected[i] ** 2;
  }
  const correlation = xy / Math.sqrt(xx * yy);
  if (!Number.isFinite(correlation) || correlation < 0.99)
    throw new Error('最终视频音轨与所选音乐处理后的参考不一致。');
  return { referenceCorrelation: correlation, subjectiveListening: false };
}

export async function renderVideo(browser, url, plan, directory, music, log) {
  const page = await browser.newPage({
    viewport: { width: plan.width, height: plan.height },
    deviceScaleFactor: 1
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  let encoder;
  try {
    await page.goto(url + '/film.html?render');
    await page.waitForFunction(() => window.sampleReady, null, {
      timeout: 60000
    });
    const samples = await page.evaluate(
      ({ intro, end }) => {
        const result = [];
        for (let t = intro; t <= end; t += 0.35)
          result.push(window.__video.seek(t));
        return result;
      },
      { intro: plan.intro, end: plan.journeyEnd }
    );
    const probeTimes = [
      plan.events[0].end,
      (plan.intro + plan.journeyEnd) / 2,
      plan.journeyEnd - 0.1,
      plan.events[0].end
    ];
    const hashes = [];
    for (const t of probeTimes) {
      const frame = await page.evaluate(async (t) => {
        await window.__video.seekAsync(t);
        return document.getElementById('film').toDataURL();
      }, t);
      hashes.push(createHash('sha256').update(frame).digest('hex'));
    }
    await page.evaluate(
      async (t) => window.__video.seekAsync(t),
      plan.duration - 0.01
    );
    const overview = await page.evaluate(() =>
      window.followDiagnostics.projectAllStops()
    );
    const check = {
      samples: samples.length,
      actorInSafeFrame: samples.every(
        (s) =>
          s.actor.visible &&
          s.actor.x > 100 &&
          s.actor.x < 980 &&
          s.actor.y > 350 &&
          s.actor.y < 1560
      ),
      deterministicSeek: hashes[0] === hashes[3],
      allStopsInOverview: overview.every(
        (p) => p.visible && p.x > 35 && p.x < 1045 && p.y > 330 && p.y < 1600
      ),
      overview,
      browserErrors: errors
    };
    fs.writeFileSync(
      path.join(directory, 'animation-check.json'),
      JSON.stringify(check, null, 2)
    );
    if (
      !check.actorInSafeFrame ||
      !check.deterministicSeek ||
      !check.allStopsInOverview ||
      errors.length
    ) {
      throw new Error(
        '镜头检查未通过，已保留 animation-check.json；未开始编码。'
      );
    }
    const partial = path.join(directory, 'preview.partial.mp4');
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-n',
      '-f',
      'image2pipe',
      '-framerate',
      String(plan.fps),
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0'
    ];
    if (music) args.push('-i', music);
    args.push('-map', '0:v:0');
    if (music)
      args.push(
        '-map',
        '1:a:0',
        '-af',
        `volume=-2dB,afade=t=in:st=0:d=0.03,afade=t=out:st=${Math.max(0, plan.duration - 1)}:d=1`,
        '-c:a',
        'aac',
        '-b:a',
        '192k'
      );
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-vf',
      'scale=in_range=full:out_range=tv,format=yuv420p',
      '-color_range',
      'tv',
      '-frames:v',
      String(plan.frames),
      '-t',
      String(plan.duration),
      '-movflags',
      '+faststart',
      partial
    );
    encoder = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    encoder.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-6000);
    });
    encoder.stdin.on('error', () => {});
    const done = new Promise((resolve, reject) => {
      encoder.once('error', reject);
      encoder.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr))
      );
    });
    done.catch(() => {});
    for (let frame = 0; frame < plan.frames; frame++) {
      const jpeg = await page.evaluate(async (t) => {
        await window.__video.seekAsync(t);
        return document
          .getElementById('film')
          .toDataURL('image/jpeg', 0.96)
          .split(',')[1];
      }, frame / plan.fps);
      if (errors.length) throw new Error(errors.join('\n'));
      if (encoder.exitCode !== null) await done;
      if (!encoder.stdin.write(Buffer.from(jpeg, 'base64')))
        await Promise.race([
          once(encoder.stdin, 'drain'),
          done.then(() => {
            throw new Error('视频编码器提前退出。');
          })
        ]);
      if (frame % 300 === 0) log(`编码 ${frame}/${plan.frames} 帧`);
    }
    encoder.stdin.end();
    await done;
    fs.renameSync(partial, path.join(directory, 'preview.mp4'));
    return check;
  } finally {
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) {
      encoder.kill('SIGTERM');
      await once(encoder, 'exit').catch(() => {});
    }
    await page.close();
  }
}

export async function verifyVideo(browser, url, plan, directory, hasMusic) {
  const file = path.join(directory, 'preview.mp4');
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8' }
    )
  );
  const video = metadata.streams.find((s) => s.codec_type === 'video'),
    audio = metadata.streams.some((s) => s.codec_type === 'audio');
  if (
    video.width !== plan.width ||
    video.height !== plan.height ||
    Number(video.nb_frames) !== plan.frames ||
    audio !== hasMusic ||
    Math.abs(Number(metadata.format.duration) - plan.duration) > 0.1
  )
    throw new Error('最终视频的画幅、帧数、时长或音轨不符合计划。');
  await runFile('ffmpeg', [
    '-v',
    'error',
    '-xerror',
    '-i',
    file,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-f',
    'null',
    '-'
  ]);
  const moments = [
    ['cover', 0],
    ['overview', plan.duration - 0.1],
    ['arrival', plan.events[0].end]
  ];
  const walking = plan.segments.findIndex((s) => s.mode === 'walking');
  if (walking >= 0)
    moments.push([
      'walking',
      (plan.events[walking].start + plan.events[walking].end) / 2
    ]);
  for (const [name, t] of moments)
    await runFile('ffmpeg', [
      '-v',
      'error',
      '-n',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      path.join(directory, name + '.png')
    ]);
  await runFile('ffmpeg', [
    '-v',
    'error',
    '-n',
    '-i',
    file,
    '-vf',
    `fps=${20 / plan.duration},scale=270:480,tile=5x4`,
    '-frames:v',
    '1',
    path.join(directory, 'contact-sheet.png')
  ]);
  const page = await browser.newPage();
  let playback;
  try {
    await page.goto(url + '/player');
    await page.waitForFunction(
      () => document.querySelector('video').readyState >= 2,
      null,
      { timeout: 30000 }
    );
    await page.evaluate(() => document.querySelector('video').play());
    await page.waitForTimeout(400);
    playback = await page.evaluate(() => {
      const v = document.querySelector('video');
      v.pause();
      return {
        time: v.currentTime,
        duration: v.duration,
        error: v.error?.message || null
      };
    });
    if (playback.time <= 0 || playback.error)
      throw new Error('最终 MP4 浏览器播放失败。');
  } finally {
    await page.close();
  }
  const result = {
    file,
    duration: Number(metadata.format.duration),
    frames: Number(video.nb_frames),
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate,
    audio,
    musicCheck: hasMusic
      ? verifyPreparedMusic(file, path.join(directory, 'music.wav'))
      : null,
    fullDecodePassed: true,
    playback,
    visualInspectionPending: true,
    subjectiveListening: false,
    animation: JSON.parse(
      fs.readFileSync(path.join(directory, 'animation-check.json'))
    ),
    scope: {
      databaseWritten: false,
      formalExportQueueConnected: false,
      deployed: false
    }
  };
  fs.writeFileSync(
    path.join(directory, 'verification.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
