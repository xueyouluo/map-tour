import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { chromium } from 'playwright-core';
import {
  createVideoPlan,
  createDetailPlan
} from '../../src/shared/videoPlan.ts';
import { listLocalItineraries, readLocalItinerary } from './input.mjs';
import {
  browserFiles,
  projectRoot,
  chromePath,
  startPreviewServer
} from './runtime.mjs';
import { prepareTerrain, captureMaps } from './assets.mjs';
import { inspectAudio, renderVideo, verifyVideo } from './render.mjs';
import { writeUpbeatMusic } from './music.mjs';

const { values } = parseArgs({
  options: {
    list: { type: 'boolean' },
    itinerary: { type: 'string' },
    input: { type: 'string' },
    out: { type: 'string' },
    db: { type: 'string' },
    duration: { type: 'string' },
    music: { type: 'string' },
    'plan-only': { type: 'boolean' },
    serve: { type: 'boolean' },
    chrome: { type: 'string' },
    'cache-dir': { type: 'string' },
    'max-detail-tiles': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    events: { type: 'boolean' },
    'builtin-music': { type: 'boolean' },
    managed: { type: 'boolean' },
    'assets-only': { type: 'boolean' }
  }
});
const environment = {
  ...(fs.existsSync(path.join(projectRoot, '.env'))
    ? dotenv.parse(fs.readFileSync(path.join(projectRoot, '.env')))
    : {}),
  ...process.env
};
const databasePath = path.resolve(
  projectRoot,
  values.db || environment.SQLITE_DB_PATH || 'data/map-tour.sqlite'
);
const log = (message) => {
  if (!values.events) return console.log(`[video-preview] ${message}`);
  const event = progressEvent(message);
  console.log(JSON.stringify(event || { type: 'log', message }));
};
const json = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));

async function main() {
  if (values.help) {
    console.log(
      '本地路线视频原型\n  npm run video:list\n  npm run video:plan -- --itinerary ID [--duration 秒] [--out 新目录]\n  npm run video:preview -- --itinerary ID [--music 音频路径] [--duration 秒]\n  npm run video:preview -- --input 行程.json [--out 新目录]\n  npm run video:serve -- --out 已生成目录\n可选：--db SQLite路径 --chrome 已安装Chrome路径 --cache-dir 缓存目录 --max-detail-tiles 数量\n不会写入原行程数据库，不会接入正式队列或启动应用服务。'
    );
    return;
  }
  if (values.list) {
    for (const row of listLocalItineraries(databasePath))
      console.log(
        `${row.id}\t${row.title}\t${row.days}天 / ${row.matched}/${row.stops}个地点已匹配 / ${row.routes}段路线`
      );
    return;
  }
  if (values.serve) {
    if (!values.out) throw new Error('--serve 需要 --out 已生成目录。');
    const directory = path.resolve(values.out);
    if (!fs.existsSync(path.join(directory, 'preview.mp4')))
      throw new Error('该目录没有已完成的预览视频。');
    const server = await startPreviewServer(directory);
    log(`场景预览：${server.url}/film.html`);
    log(`成片播放：${server.url}/player`);
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await server.close();
    return;
  }
  const itinerary = readLocalItinerary({
    databasePath,
    id: values.itinerary,
    input: values.input
  });
  const plan = createVideoPlan(itinerary, {
    durationSeconds:
      values.duration === undefined ? undefined : Number(values.duration)
  });
  const maxTiles =
    values['max-detail-tiles'] === undefined
      ? 300
      : Number(values['max-detail-tiles']);
  if (!Number.isSafeInteger(maxTiles) || maxTiles < 1 || maxTiles > 2000)
    throw new Error('--max-detail-tiles 需要是 1 到 2000 的整数。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(
    values.out ||
      path.join(
        projectRoot,
        'outputs',
        `video-preview-${itinerary.id.replace(/[^\w-]/g, '_')}-${stamp}`
      )
  );
  if (fs.existsSync(directory))
    throw new Error(`输出目录已存在，为保护历史版本未写入：${directory}`);
  const cache = path.resolve(
    values['cache-dir'] ||
      path.join(projectRoot, 'outputs/.video-preview-cache')
  );
  if (directory === cache || directory.startsWith(cache + path.sep))
    throw new Error('输出目录不能放在共享缓存内。');
  const music = values['builtin-music']
    ? path.join(directory, 'builtin-music.wav')
    : values.music
      ? path.resolve(values.music)
      : undefined;
  let chrome;
  if (!values['plan-only']) {
    if (!environment.AMAP_JSAPI_KEY || !environment.AMAP_SECURITY_JS_CODE)
      throw new Error(
        '本地 .env 需要 AMAP_JSAPI_KEY 和 AMAP_SECURITY_JS_CODE 才能采集卫星底图。'
      );
    chrome = chromePath(values.chrome);
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    if (music && !values['builtin-music']) inspectAudio(music, plan.duration);
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const owner = randomUUID(),
    lock = path.join(directory, '.preview.lock');
  fs.writeFileSync(lock, owner, { flag: 'wx' });
  const manifest = {
    version: 1,
    owner,
    startedAt: new Date().toISOString(),
    status: 'planning',
    source: values.input
      ? path.resolve(values.input)
      : { databasePath, id: itinerary.id, readOnly: true },
    sourceSha256: createHash('sha256')
      .update(JSON.stringify(itinerary))
      .digest('hex'),
    output: directory,
    music: music || null,
    applicationIntegration: Boolean(values.managed),
    formalExportQueue: Boolean(values.managed),
    phases: []
  };
  const phase = (name) => {
    manifest.phases.push({ name, at: new Date().toISOString() });
    json(path.join(directory, 'manifest.json'), manifest);
    log(name);
  };
  let server, browser;
  const cancellation = new AbortController();
  const interrupt = () => {
    cancellation.abort(new Error('本次生成已取消。'));
    browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    json(path.join(directory, 'itinerary.json'), itinerary);
    json(path.join(directory, 'plan.json'), plan);
    fs.writeFileSync(
      path.join(directory, 'storyboard.md'),
      `# ${plan.title}\n\n自动读取现有行程，保持单张连续地图和每日路线。片头 ${plan.intro} 秒展示全程；按路线长度分配跟随镜头和 0.5 秒抵达停留；片尾 4 秒拉远保留足迹。\n\n${plan.segments.map((s, i) => `- ${plan.events[i].start.toFixed(2)}–${plan.events[i].holdEnd.toFixed(2)} 秒：${plan.stops.find((p) => p.id === s.fromStopId).name} → ${plan.stops.find((p) => p.id === s.toStopId).name}；${s.mode}；${s.illustrative ? '路线示意' : '复用已规划几何'}`).join('\n')}\n`
    );
    phase(
      `已读取 ${plan.days.length} 天、${plan.stops.length} 个地点、${plan.segments.length} 段路线；目标 ${plan.duration.toFixed(2)} 秒`
    );
    for (const warning of plan.warnings) log(warning);
    if (values['plan-only']) {
      manifest.status = 'planned';
      phase('计划完成，未请求地图或渲染视频');
      return;
    }
    for (const file of [
      'film.js',
      'film.html',
      'vehicles.js',
      'attribution.png'
    ])
      fs.copyFileSync(
        path.join(browserFiles, file),
        path.join(directory, file)
      );
    if (!music) {
      const html = path.join(directory, 'film.html');
      fs.writeFileSync(
        html,
        fs.readFileSync(html, 'utf8').replace('src="music.wav"', '')
      );
    }
    fs.mkdirSync(cache, { recursive: true });
    phase('准备真实高程和显示坐标对齐');
    manifest.terrain = await prepareTerrain(
      plan,
      directory,
      cache,
      log,
      cancellation.signal
    );
    server = await startPreviewServer(directory, environment);
    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: [
        '--force-color-profile=srgb',
        '--disable-background-timer-throttling'
      ]
    });
    phase('根据实际相机视野计算高清影像范围');
    const page = await browser.newPage({
      viewport: { width: plan.width, height: plan.height }
    });
    let samples;
    try {
      await page.goto(server.url + '/film.html?planning');
      await page.waitForFunction(() => window.sampleReady, null, {
        timeout: 60000
      });
      samples = await page.evaluate(() => window.detailPlanningSamples());
    } finally {
      await page.close();
    }
    const details = createDetailPlan(plan, samples, maxTiles);
    json(path.join(directory, 'detail-plan.json'), details);
    phase(`采集分级卫星影像：${details.tiles.length} 张高清补片`);
    const assets = await captureMaps(
      browser,
      server.url,
      plan,
      details,
      directory,
      cache,
      log,
      cancellation.signal
    );
    manifest.assets = {
      detailPatches: assets.detailPatches,
      reused: assets.reused,
      patches: assets.patches
    };
    phase('检查连续镜头、重复跳转和全程构图，开始编码');
    if (values['builtin-music'])
      writeUpbeatMusic(music, Math.ceil(plan.duration) + 1);
    if (music) await runMusicPreview(music, directory, plan.duration);
    if (values['assets-only']) {
      manifest.status = 'prepared';
      phase('场景素材已准备好');
      return;
    }
    await renderVideo(browser, server.url, plan, directory, music, log);
    phase('验证最终 MP4、抽取关键帧和浏览器播放');
    manifest.verification = await verifyVideo(
      browser,
      server.url,
      plan,
      directory,
      Boolean(music)
    );
    manifest.status = 'complete';
    phase('自动生成完成');
  } catch (error) {
    manifest.status = cancellation.signal.aborted ? 'cancelled' : 'failed';
    manifest.error = safeError(error);
    phase('本次生成未完成，保留诊断和已完成的素材');
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (browser) await browser.close();
    if (server) await server.close();
    manifest.finishedAt = new Date().toISOString();
    json(path.join(directory, 'manifest.json'), manifest);
    fs.writeFileSync(
      path.join(directory, 'README.md'),
      `# ${plan.title}\n\n本地通用流程生成；状态：${manifest.status}。主文件：preview.mp4（仅完整生成时存在）。\n\n- 计划：plan.json；输入快照：itinerary.json；分镜：storyboard.md。\n- 高清底图：detail-plan.json、detail-tiles/；地形：terrain-data.json。\n- 可编辑场景：film.js、film.html；复现和参数说明见仓库 docs/LOCAL_VIDEO_PREVIEW.md。\n- 自动检查：verification.json；目视检查状态以该文件为准。\n- ${values.managed ? '由应用的视频任务队列管理。' : '独立命令生成，未接任务队列。'}原行程不会被修改。\n- ${music ? '配乐使用指定音频的连续片段，淡入淡出，不改变速度；本阶段尚未自动按节拍安排镜头。' : '本次未指定配乐，视频无音轨。'}\n\n## 路线说明\n${plan.warnings.length ? plan.warnings.map((w) => '- ' + w).join('\n') : '全部复用已规划路线。'}\n\n卫星原始影像清晰度随区域而异；高程与 GCJ02/WGS84 对齐用于展示，不是测绘结果。\n`
    );
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === owner)
      fs.unlinkSync(lock);
    log(`输出：${directory}`);
  }
}

async function runMusicPreview(music, directory, duration) {
  const { runFile } = await import('./runtime.mjs');
  await runFile('ffmpeg', [
    '-v',
    'error',
    '-n',
    '-i',
    music,
    '-t',
    String(duration),
    '-af',
    `volume=-2dB,afade=t=in:st=0:d=0.03,afade=t=out:st=${Math.max(0, duration - 1)}:d=1`,
    '-c:a',
    'pcm_s16le',
    path.join(directory, 'music.wav')
  ]);
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(environment))
    if (
      typeof value === 'string' &&
      value.length > 5 &&
      /key|token|secret|password/i.test(name)
    )
      message = message.replaceAll(value, '[redacted]');
  return message;
}

main().catch((error) => {
  console.error(`[video-preview] ${safeError(error)}`);
  process.exitCode = 1;
});

function progressEvent(message) {
  let progress, stage;
  if (message.startsWith('已读取 ')) {
    progress = 3;
    stage = '整理旅程';
  }
  if (message.startsWith('准备真实高程')) {
    progress = 5;
    stage = '准备立体地形';
  }
  let match = message.match(/^高程 (\d+)\/(\d+)/);
  if (match) {
    progress = 8 + (16 * Number(match[1])) / Number(match[2]);
    stage = '准备立体地形';
  }
  if (message.startsWith('根据实际相机')) {
    progress = 26;
    stage = '安排跟随镜头';
  }
  if (message.startsWith('采集分级')) {
    progress = 28;
    stage = '铺设高清卫星地图';
  }
  match = message.match(/^卫星底图 (\d+)\/(\d+)/);
  if (match) {
    progress = 30 + (34 * Number(match[1])) / Number(match[2]);
    stage = '铺设高清卫星地图';
  }
  if (message.startsWith('检查连续镜头')) {
    progress = 65;
    stage = '检查镜头与构图';
  }
  match = message.match(/^编码 (\d+)\/(\d+)/);
  if (match) {
    progress = 66 + (27 * Number(match[1])) / Number(match[2]);
    stage = '生成旅程动画';
  }
  if (message.startsWith('验证最终')) {
    progress = 95;
    stage = '检查成片';
  }
  if (message === '自动生成完成') {
    progress = 98;
    stage = '准备视频文件';
  }
  return progress === undefined
    ? null
    : { type: 'progress', progress: Math.round(progress), stage };
}
