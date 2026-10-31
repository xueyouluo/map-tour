import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { expect, it } from 'vitest';
import { VideoJobs } from './videoJobs';
import { videoRouter } from './videoRoutes';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import { MusicLibrary } from './musicLibrary';
import { createHash } from 'node:crypto';

it('serves library previews with range support without exposing full files or catalog internals', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-library-api-')
  );
  const musicRoot = path.join(directory, 'music');
  fs.mkdirSync(musicRoot);
  const bytes = Buffer.from('library preview fixture'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const track = {
    id: 'test-a',
    title: '测试音乐',
    version: 'A',
    mood: '轻快',
    duration: 200,
    file: `${sha256}.mp3`,
    previewFile: `${sha256}-preview.mp3`,
    sha256,
    sourceName: 'private.mp3'
  };
  fs.writeFileSync(path.join(musicRoot, track.file), bytes);
  fs.writeFileSync(path.join(musicRoot, track.previewFile), bytes);
  fs.writeFileSync(
    path.join(musicRoot, 'catalog.json'),
    JSON.stringify({ version: 1, tracks: [track] })
  );
  const jobs = new VideoJobs(
    path.join(directory, 'jobs'),
    async () => {},
    new MusicLibrary(musicRoot)
  );
  const app = express();
  app.use('/api/video', videoRouter(jobs));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/video`;
  try {
    const listed = await fetch(url + '/music'),
      text = await listed.text();
    expect(text).toContain('测试音乐');
    for (const privateValue of [
      musicRoot,
      'sourceName',
      'sha256',
      'private.mp3'
    ])
      expect(text).not.toContain(privateValue);
    const preview = await fetch(url + '/music/test-a/preview', {
      headers: { range: 'bytes=0-3' }
    });
    expect(preview.status).toBe(206);
    expect(preview.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await preview.arrayBuffer()).toString()).toBe('libr');
    expect((await fetch(url + '/music/unknown/preview')).status).toBe(404);
    expect((await fetch(url + '/music/test-a/full')).status).toBe(404);
    const cookie = listed.headers.get('set-cookie')!.split(';')[0];
    const owner = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const trip = normalizeParsedItinerary({ days: [{ stops: [{ name: 'A' }] }] }, 'audio-trip');
    trip.days[0].stops[0].poiMatch = { name: 'A', status: 'matched', location: [120, 30] };
    const scene = jobs.create(owner, trip, { music: 'library', trackId: 'test-a' }, 'scene');
    const audioPath = `/jobs/${scene.id}/audio`;
    expect((await fetch(url + audioPath)).status).toBe(404);
    expect((await fetch(url + audioPath + '-source')).status).toBe(404);
    const source = await fetch(url + audioPath + '-source', { headers: { cookie } });
    expect(source.headers.get('cache-control')).toBe('private, no-store');
    expect(await source.json()).toEqual({ url: '/api/video' + audioPath, sha256 });
    const audio = await fetch(url + audioPath, { headers: { cookie, range: 'bytes=0-3' } });
    expect(audio.status).toBe(206);
    expect(audio.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe('libr');

  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps job and media endpoints private to the browser cookie and rejects cross-site mutations', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-video-api-')
  );
  const jobs = new VideoJobs(directory, async () => {});
  const app = express();
  app.use(express.json());
  app.use('/api/video', videoRouter(jobs));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/video`;
  try {
    const response = await fetch(url + '/jobs');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect(response.headers.get('cache-control')).toContain('private');
    const trip = normalizeParsedItinerary(
      { days: [{ stops: [{ name: 'A' }] }] },
      'private-trip'
    );
    trip.days[0].stops[0].poiMatch = {
      name: 'A',
      status: 'matched',
      location: [120, 30]
    };
    const token = cookie.split('=')[1];
    const { createHash } = await import('node:crypto');
    const owner = createHash('sha256').update(token).digest('hex');
    const job = jobs.create(owner, trip, { music: 'none' });
    expect((await fetch(url + '/jobs/' + job.id)).status).toBe(404);
    expect((await fetch(url + '/jobs/' + job.id + '/video')).status).toBe(404);
    const own = await fetch(url + '/jobs/' + job.id, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect((await own.json()).job.id).toBe(job.id);
    expect(
      (
        await fetch(url + '/jobs/' + job.id + '/cancel', {
          method: 'POST',
          headers: { cookie, origin: 'https://unrelated.example' }
        })
      ).status
    ).toBe(403);
    const listed = await fetch(url + '/jobs', { headers: { cookie } });
    expect((await listed.json()).jobs).toHaveLength(1);
    const form = new FormData();
    form.set(
      'music',
      new Blob(['not music'], { type: 'audio/mpeg' }),
      'fake.mp3'
    );
    const invalid = await fetch(url + '/uploads', {
      method: 'POST',
      headers: { cookie },
      body: form
    });
    expect(invalid.status).toBe(400);
    expect(fs.readdirSync(path.join(directory, 'uploads'))).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('serves only owner-scoped prepared scene files and uses the same-origin runtime path', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-scene-api-')
  );
  const jobs = new VideoJobs(directory, async (job) => {
    const render = path.join(directory, 'jobs', job.id, 'render');
    fs.mkdirSync(render);
    fs.writeFileSync(
      path.join(render, 'film.html'),
      '<script type="importmap">{"imports":{"three":"/_runtime/three/build/three.module.js"}}</script>'
    );
    for (const name of [
      'film.js',
      'vehicles.js',
      'plan.json',
      'terrain-data.json',
      'detail-plan.json'
    ])
      fs.writeFileSync(path.join(render, name), '{}');
    fs.writeFileSync(path.join(render, 'attribution.png'), 'fixture-image');
    fs.writeFileSync(
      path.join(render, 'manifest.json'),
      JSON.stringify({ status: 'prepared' })
    );
    fs.writeFileSync(
      path.join(render, 'assets-check.json'),
      JSON.stringify({ patches: 1, checks: [{}] })
    );
  });
  const app = express();
  app.use(express.json());
  app.use('/api/video', videoRouter(jobs));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/video`;
  try {
    const session = await fetch(url + '/jobs');
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const { createHash } = await import('node:crypto');
    const owner = createHash('sha256')
      .update(cookie.split('=')[1])
      .digest('hex');
    const trip = normalizeParsedItinerary(
      { days: [{ stops: [{ name: 'A' }] }] },
      'scene-trip'
    );
    trip.days[0].stops[0].poiMatch = {
      name: 'A',
      status: 'matched',
      location: [120, 30]
    };
    const job = jobs.create(owner, trip, { music: 'none' }, 'scene');
    const { vi } = await import('vitest');
    await vi.waitFor(() =>
      expect(jobs.get(owner, job.id).state).toBe('completed')
    );
    const response = await fetch(url + `/jobs/${job.id}/scene/film.html`, {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('cache-control')).toContain('private');
    const html = await response.text();
    expect(html).toContain('/api/video/runtime/three/0.186.1/build/three.module.js');
    expect(html).toContain('window.browserSceneRuntime');
    expect(html).not.toContain('src="music.wav"');
    expect((await fetch(url + `/jobs/${job.id}/scene/plan.json`)).status).toBe(
      404
    );
    expect(
      (
        await fetch(url + `/jobs/${job.id}/scene/vehicles.js`, {
          headers: { cookie }
        })
      ).status
    ).toBe(200);
    const runtime = await fetch(url + `/jobs/${job.id}/scene/playback.js`, {
      headers: { cookie }
    });
    expect(runtime.status).toBe(200);
    expect(await runtime.text()).toContain('createAssetQueue');
    expect((await fetch(url + `/jobs/${job.id}/scene/playback.js`)).status)
      .toBe(404);
    const imageUrl = url + `/jobs/${job.id}/scene/attribution.png`;
    const image = await fetch(imageUrl, { headers: { cookie } });
    expect(image.headers.get('cache-control')).toBe('private, no-cache');
    const etag = image.headers.get('etag')!;
    expect((await fetch(imageUrl, {
      headers: { cookie, 'if-none-match': etag, 'cache-control': 'max-age=0' }
    })).status).toBe(304);
    expect((await fetch(imageUrl, {
      headers: { 'if-none-match': etag }
    })).status).toBe(404);
    expect((await fetch(url + `/jobs/${job.id}/scene/preview-atlas-region.jpg`)).status)
      .toBe(404);
    expect((await fetch(url + `/jobs/${job.id}/scene/preview-input.json`, {
      headers: { cookie }
    })).status).toBe(404);
    expect(
      (await fetch(url + `/jobs/${job.id}/scene/vehicles.js`)).status
    ).toBe(404);
    for (const file of ['manifest.json', 'input.json', 'render.log'])
      expect(
        (
          await fetch(url + `/jobs/${job.id}/scene/${file}`, {
            headers: { cookie }
          })
        ).status
      ).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
