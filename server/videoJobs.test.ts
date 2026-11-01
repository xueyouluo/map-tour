import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import { VideoJobs, parseExportOptions } from './videoJobs';
import { MusicLibrary } from './musicLibrary';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [],
  managers: VideoJobs[] = [];

it('selects exact library audio for render jobs and rejects missing or short tracks', async () => {
  const directory = root(),
    musicRoot = root();
  const bytes = Buffer.from('library fixture'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const track = {
    id: 'sunny-a',
    title: '晴天出发',
    version: 'A',
    mood: '轻快',
    duration: 200,
    file: `${sha256}.mp3`,
    previewFile: `${sha256}-preview.mp3`,
    sha256
  };
  fs.writeFileSync(path.join(musicRoot, track.file), bytes);
  fs.writeFileSync(path.join(musicRoot, track.previewFile), bytes);
  const saveCatalog = (duration: number) =>
    fs.writeFileSync(
      path.join(musicRoot, 'catalog.json'),
      JSON.stringify({ version: 1, tracks: [{ ...track, duration }] })
    );
  saveCatalog(200);
  let usedPath = '';
  const manager = new VideoJobs(
    directory,
    async (job) => {
      usedPath = job.audioPath!;
      complete(directory, job.id, job.duration);
    },
    new MusicLibrary(musicRoot)
  );
  managers.push(manager);
  const job = manager.create('alice', source(), {
    music: 'library',
    trackId: 'sunny-a'
  });
  await vi.waitFor(() =>
    expect(manager.get('alice', job.id).state).toBe('completed')
  );
  expect(usedPath).toBe(path.join(musicRoot, track.file));
  expect(job.musicName).toBe('晴天出发 A');
  expect(job.options.trackId).toBe('sunny-a');
  expect(job).not.toHaveProperty('audioPath');
  expect(() =>
    manager.create('alice', source(), { music: 'library', trackId: 'missing' })
  ).toThrow('暂不可用');
  expect(() =>
    parseExportOptions({ music: 'library', trackId: '../secret' })
  ).toThrow('内置音乐');
  expect(() => parseExportOptions({ music: 'library' })).toThrow('内置音乐');
  saveCatalog(5);
  expect(() =>
    manager.create('alice', source(), { music: 'library', trackId: 'sunny-a' })
  ).toThrow('缩短视频');
});
function root() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-video-jobs-')
  );
  roots.push(directory);
  return directory;
}
function source() {
  const itinerary = normalizeParsedItinerary(
    {
      title: '测试行程',
      days: [{ stops: [{ name: '起点' }, { name: '终点' }] }]
    },
    'test-trip'
  );
  for (const [index, stop] of itinerary.days[0].stops.entries())
    stop.poiMatch = {
      name: stop.name,
      status: 'matched',
      location: [120.1 + index * 0.01, 30.2]
    };
  return itinerary;
}
function complete(directory: string, id: string, duration: number) {
  const render = path.join(directory, 'jobs', id, 'render');
  fs.mkdirSync(render);
  fs.writeFileSync(path.join(render, 'preview.mp4'), 'unit-test-video');
  fs.writeFileSync(path.join(render, 'cover.png'), 'unit-test-cover');
  fs.writeFileSync(
    path.join(render, 'verification.json'),
    JSON.stringify({
      fullDecodePassed: true,
      frames: duration * 30,
      playback: { time: 0.2 }
    })
  );
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const directory of roots.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it('blocks legacy overseas queue jobs, retries, fallback and prepared scene access', async () => {
  const directory = root();
  const initial = new VideoJobs(directory, async () => {});
  await initial.close();
  const trip = source();
  trip.days[0].stops[0].poiMatch!.location = [139.69, 35.68];
  const db = new DatabaseSync(path.join(directory, 'jobs.sqlite'));
  const base = {
    owner: 'alice', snapshot: trip, fingerprint: 'legacy-foreign',
    itineraryId: trip.id, title: trip.title, state: 'queued', options: { music: 'none' },
    createdAt: new Date().toISOString(), progress: 0, duration: 60, days: 1, stops: 2
  };
  const queuedId = '11111111-1111-4111-8111-111111111111';
  const sceneId = '22222222-2222-4222-8222-222222222222';
  for (const payload of [
    { ...base, id: queuedId },
    { ...base, id: sceneId, kind: 'scene', state: 'completed', browserAssets: true,
      expiresAt: new Date(Date.now() + 86400000).toISOString() }
  ]) db.prepare('insert into jobs values(?,?,?,?,?,?)').run(
    payload.id, payload.owner, payload.state, payload.fingerprint, payload.createdAt, JSON.stringify(payload)
  );
  db.close();
  const runner = vi.fn(async () => {});
  const manager = new VideoJobs(directory, runner);
  managers.push(manager);
  await vi.waitFor(() => expect(manager.get('alice', queuedId).state).toBe('failed'));
  expect(runner).not.toHaveBeenCalled();
  expect(manager.get('alice', queuedId).error).toContain('仅支持中国大陆');
  expect(() => manager.retry('alice', queuedId)).toThrow('仅支持中国大陆');
  expect(() => manager.fallback('alice', sceneId)).toThrow('仅支持中国大陆');
  expect(() => manager.sceneFile('alice', sceneId, 'plan.json')).toThrow('仅支持中国大陆');
  expect(manager.list('alice')).toHaveLength(2);
});

describe('persistent video jobs', () => {
  it('never publishes unverified files, sanitizes failure messages and retries a failed snapshot', async () => {
    const directory = root();
    let attempts = 0;
    const manager = new VideoJobs(directory, async (job) => {
      attempts++;
      if (attempts === 1)
        throw new Error('private diagnostic /private/server/config');
      complete(directory, job.id, job.duration);
    });
    managers.push(manager);
    const failed = manager.create('alice', source(), { music: 'none' });
    await vi.waitFor(() =>
      expect(manager.get('alice', failed.id).state).toBe('failed')
    );
    expect(manager.get('alice', failed.id).error).not.toContain('/private');
    expect(() => manager.media('alice', failed.id, 'video')).toThrow(
      '没有制作完成'
    );
    const retry = manager.retry('alice', failed.id);
    await vi.waitFor(() =>
      expect(manager.get('alice', retry.id).state).toBe('completed')
    );
    expect(retry.id).not.toBe(failed.id);
  });
  it('serializes jobs, deduplicates pending submissions, and keeps ownership private', async () => {
    const directory = root(),
      release: (() => void)[] = [],
      started: string[] = [];
    const manager = new VideoJobs(directory, async (job, context) => {
      started.push(job.id);
      context.progress(70, '生成旅程动画');
      context.progress(30, '地图');
      await new Promise<void>((resolve) => release.push(resolve));
      complete(directory, job.id, job.duration);
    });
    managers.push(manager);
    const first = manager.create('alice', source(), { music: 'none' });
    expect(manager.create('alice', source(), { music: 'none' }).id).toBe(
      first.id
    );
    const second = manager.create('bob', source(), { music: 'none' });
    await vi.waitFor(() => expect(started).toEqual([first.id]));
    expect(manager.get('alice', first.id).progress).toBe(70);
    expect(manager.list('alice')).toHaveLength(1);
    expect(() => manager.get('bob', first.id)).toThrow('没有找到');
    expect(() => manager.media('bob', first.id, 'video')).toThrow('没有找到');
    expect(() => manager.remove('alice', first.id)).toThrow('先取消');
    expect(manager.get('bob', second.id).queuePosition).toBe(1);
    release.shift()!();
    await vi.waitFor(() => expect(started).toEqual([first.id, second.id]));
    release.shift()!();
    await vi.waitFor(() =>
      expect(manager.get('bob', second.id).state).toBe('completed')
    );
    const publicJob = manager.get('alice', first.id);
    expect(publicJob).toMatchObject({
      state: 'completed',
      progress: 100,
      downloadUrl: `/api/video/jobs/${first.id}/download`
    });
    expect(publicJob).not.toHaveProperty('owner');
    expect(publicJob).not.toHaveProperty('snapshot');
    expect(publicJob).not.toHaveProperty('audioPath');
    expect(fs.existsSync(manager.media('alice', first.id, 'video').file)).toBe(
      true
    );
    manager.remove('alice', first.id);
    expect(fs.existsSync(path.join(directory, 'jobs', first.id))).toBe(false);
  });

  it('cancels active work and retries into a new immutable job', async () => {
    const directory = root();
    let calls = 0;
    const manager = new VideoJobs(directory, async (job, context) => {
      calls++;
      if (calls === 1)
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          )
        );
      else complete(directory, job.id, job.duration);
    });
    managers.push(manager);
    const first = manager.create('alice', source(), { music: 'none' });
    await vi.waitFor(() =>
      expect(manager.get('alice', first.id).state).toBe('running')
    );
    manager.cancel('alice', first.id);
    await vi.waitFor(() =>
      expect(manager.get('alice', first.id).state).toBe('cancelled')
    );
    const retry = manager.retry('alice', first.id);
    expect(retry.id).not.toBe(first.id);
    await vi.waitFor(() =>
      expect(manager.get('alice', retry.id).state).toBe('completed')
    );
    expect(manager.get('alice', first.id).state).toBe('cancelled');
  });

  it('persists queued jobs across a graceful worker restart without taking over a live worker', async () => {
    const directory = root();
    const first = new VideoJobs(
      directory,
      async (_job, context) =>
        new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => reject(new Error('stop')),
            { once: true }
          )
        )
    );
    managers.push(first);
    const running = first.create('alice', source(), { music: 'none' });
    const queued = first.create('bob', source(), { music: 'none' });
    await vi.waitFor(() =>
      expect(first.get('alice', running.id).state).toBe('running')
    );
    expect(() => new VideoJobs(directory)).toThrow('另一个进程');
    await first.close();
    managers.splice(managers.indexOf(first), 1);
    const restarted = new VideoJobs(directory, async (job) =>
      complete(directory, job.id, job.duration)
    );
    managers.push(restarted);
    await vi.waitFor(() =>
      expect(restarted.get('bob', queued.id).state).toBe('completed')
    );
    expect(restarted.get('alice', running.id)).toMatchObject({
      state: 'failed'
    });
    expect(restarted.get('alice', running.id).error).toContain('重启');
    restarted.cleanup(Date.now() + 8 * 86400000);
    expect(restarted.list('alice')).toEqual([]);
    expect(restarted.list('bob')).toEqual([]);
  });

  it('limits pending jobs and validates options before starting expensive work', async () => {
    const manager = new VideoJobs(root(), async () => {});
    managers.push(manager);
    expect(() =>
      parseExportOptions({ music: 'file', path: '/private/file' })
    ).toThrow('配乐');
    expect(() =>
      parseExportOptions({ music: 'upbeat', durationSeconds: -2 })
    ).toThrow('时长');
    expect(() =>
      parseExportOptions({ music: 'upload', uploadId: '../music' })
    ).toThrow('上传');
    const trip = source();
    trip.days[0].stops[0].poiMatch!.status = 'pending';
    expect(() => manager.create('alice', trip, { music: 'none' })).toThrow(
      '尚未匹配'
    );
    manager.create('alice', source(), { music: 'none' });
    manager.create(
      'alice',
      { ...source(), title: '第二版' },
      { music: 'none' }
    );
    expect(() =>
      manager.create(
        'alice',
        { ...source(), title: '第三版' },
        { music: 'none' }
      )
    ).toThrow('较多');
  });
});

it('prepares private reusable browser scenes and falls back using the immutable snapshot', async () => {
  const directory = root();
  let runs = 0;
  const manager = new VideoJobs(directory, async (job) => {
    runs++;
    complete(directory, job.id, job.duration);
  });
  managers.push(manager);
  const trip = source();
  const scene = manager.create('alice', trip, { music: 'none' }, 'scene');
  await vi.waitFor(() =>
    expect(manager.get('alice', scene.id).state).toBe('completed')
  );
  const ready = manager.get('alice', scene.id);
  expect(ready.sceneUrl).toContain('/scene/film.html?embedded');
  expect(ready.videoUrl).toBeUndefined();
  expect(manager.create('alice', trip, { music: 'none' }, 'scene').id).toBe(
    scene.id
  );
  expect(runs).toBe(0);
  expect(ready.browserAssets).toBe(true);
  const files = fs.readdirSync(path.join(directory, 'jobs', scene.id, 'render'));
  expect(files).not.toContain('terrain-data.json');
  expect(files).not.toContain('detail-tiles');
  expect(manager.sceneFile('alice', scene.id, 'plan.json')).toContain(
    'plan.json'
  );
  for (const file of [
    '../input.json',
    'input.json',
    'manifest.json',
    'render.log',
    'detail-tiles/../../input.json'
  ])
    expect(() => manager.sceneFile('alice', scene.id, file)).toThrow(
      '没有找到'
    );
  expect(() => manager.sceneFile('bob', scene.id, 'plan.json')).toThrow(
    '没有找到'
  );
  expect(() => manager.fallback('bob', scene.id)).toThrow('没有找到');
  trip.title = 'Changed after preparation';
  const fallback = manager.fallback('alice', scene.id);
  expect(fallback.kind).toBeUndefined();
  expect(fallback.title).toBe('测试行程');
  expect(fallback.options.music).toBe('none');
  await vi.waitFor(() =>
    expect(manager.get('alice', fallback.id).state).toBe('completed')
  );
  expect(manager.get('alice', fallback.id).videoUrl).toBeTruthy();
});

it('rebuilds missing browser plans without invoking the heavy renderer and validates local music only for scenes', async () => {
  const directory = root();
  let runs = 0;
  const manager = new VideoJobs(directory, async () => { runs++; });
  managers.push(manager);
  const options = { music: 'none' };
  const scene = manager.create('alice', source(), options, 'scene');
  fs.unlinkSync(manager.sceneFile('alice', scene.id, 'plan.json'));
  const replacement = manager.create('alice', source(), options, 'scene');
  expect(replacement.id).not.toBe(scene.id);
  expect(replacement.state).toBe('completed');
  expect(runs).toBe(0);
  const local = { music: 'upload', uploadId: '00000000-0000-4000-8000-000000000000', localMusic: { name: 'My music.mp3', duration: 200 } };
  const musicScene = manager.create('alice', source(), local, 'scene');
  expect(musicScene.options.localMusic?.name).toBe('My music.mp3');
  expect(() => manager.create('alice', source(), local)).toThrow('本地音乐信息无效');
  expect(() => manager.fallback('alice', musicScene.id)).toThrow('先上传');
  expect(() => manager.sceneAudio('bob', musicScene.id)).toThrow('没有找到');
  expect(() => parseExportOptions({ ...local, localMusic: { name: 'bad', duration: Infinity } }, true)).toThrow('本地音乐信息无效');
});
