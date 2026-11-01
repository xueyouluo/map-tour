import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';

it('guards actual parse, save, transport, scene, queue and map APIs without consuming rejected quota', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-region-api-'));
  const parsed = {
    serviceRegion: 'UNSUPPORTED', title: '武汉行程', language: 'zh-CN',
    tripScope: { mode: 'single_city', primaryCity: '武汉市', cities: ['武汉市'] },
    days: [{ stops: [
      { name: '湖北省博物馆', province: '湖北省', city: '武汉市', countryCode: 'CN' },
      { name: '东湖', province: '湖北省', city: '武汉市', countryCode: 'CN' }
    ] }]
  };
  let modelCalls = 0;
  const modelApp = express();
  modelApp.use(express.json({ limit: '2mb' }));
  modelApp.post('/chat/completions', (req, res) => {
    modelCalls++;
    const content = JSON.stringify(parsed);
    if (req.body.stream) {
      res.type('text/event-stream').send(
        'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'
      );
    } else res.json({ choices: [{ message: { content } }] });
  });
  const model = modelApp.listen(0, '127.0.0.1');
  await once(model, 'listening');
  // Reserve an unused loopback port before starting the real application.
  const reservation = express().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const settings = path.join(root, 'settings.json');
  fs.writeFileSync(settings, '{}');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), SETTINGS_FILE: settings,
      SQLITE_DB_PATH: path.join(root, 'fixture.sqlite'), VIDEO_EXPORT_DIR: path.join(root, 'videos'),
      OPENAI_API_KEY: 'fixture-not-a-real-key', OPENAI_MODEL: 'region-test-model',
      OPENAI_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}`,
      USER_REGISTRATION_ENABLED: 'true', VIDEO_EXPORT_ENABLED: 'false',
      AMAP_JSAPI_KEY: 'fixture-not-a-real-key', AMAP_SECURITY_JS_CODE: 'fixture-not-a-real-code'
    },
    stdio: 'ignore'
  });
  const origin = `http://127.0.0.1:${port}`;
  try {
    await vi.waitFor(async () => expect((await fetch(origin + '/api/health')).ok).toBe(true), { timeout: 10000 });
    const registration = await fetch(origin + '/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: 'region-check', password: 'region-test-password' })
    });
    expect(registration.status).toBe(201);
    const cookie = registration.headers.get('set-cookie')!.split(';')[0];
    const headers = { cookie, origin };
    for (const stream of [false, true]) for (const image of [false, true]) {
      const body = new FormData();
      body.set('text', '武汉和东京行程');
      if (image) body.set('image', new Blob(['fixture'], { type: 'image/png' }), 'trip.png');
      const response = await fetch(origin + '/api/parse' + (stream ? '/stream' : ''), {
        method: 'POST', headers, body
      });
      if (stream) {
        expect(response.status).toBe(200);
        const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
        expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('仅支持中国大陆') });
        expect(events.some((e) => e.type === 'result')).toBe(false);
      } else {
        expect(response.status).toBe(422);
        expect((await response.json()).error).toContain('仅支持中国大陆');
      }
    }
    const session = async () => (await (await fetch(origin + '/api/auth/session', { headers })).json()).user;
    expect((await session()).itineraryCount).toBe(0);
    expect((await (await fetch(origin + '/api/itineraries', { headers })).json()).items).toEqual([]);

    parsed.serviceRegion = 'CN_MAINLAND';
    const body = new FormData(); body.set('text', '武汉一日游');
    const response = await fetch(origin + '/api/parse', { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    const saved = (await response.json()).itinerary;
    expect(saved.serviceRegion).toBe('CN_MAINLAND');
    expect(saved.days[0].stops[0].countryCode).toBe('CN');
    expect((await session()).itineraryCount).toBe(1);

    // Direct JSON submissions do not rely on the model's scope classification.
    const foreign = normalizeParsedItinerary({ serviceRegion: 'CN_MAINLAND', days: [{ stops: [
      { name: '伪装的国内地点', countryCode: 'CN', province: '湖北省', city: '武汉市' }
    ] }] });
    foreign.days[0].stops[0].poiMatch = { name: '伪装地点', status: 'matched', location: [139.69, 35.68] };
    const beforeCalls = modelCalls;
    for (const endpoint of ['/api/itineraries', '/api/transport', '/api/video/scenes', '/api/video/jobs']) {
      const data = endpoint === '/api/itineraries' ? foreign : { itinerary: foreign, options: { music: 'none' } };
      const blocked = await fetch(origin + endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data) });
      expect(blocked.status, endpoint).toBe(422);
      expect((await blocked.json()).error).toContain('仅支持中国大陆');
    }
    // Existing history cannot be changed to an overseas point through save.
    const edit = structuredClone(saved);
    edit.days[0].stops[0].poiMatch = foreign.days[0].stops[0].poiMatch;
    expect((await fetch(origin + '/api/itineraries', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(edit) })).status).toBe(422);
    expect((await (await fetch(origin + '/api/itineraries/' + saved.id, { headers })).json()).itinerary.days[0].stops[0].poiMatch.status).toBe('pending');
    expect(modelCalls).toBe(beforeCalls);
    expect((await session()).itineraryCount).toBe(1);
    expect((await (await fetch(origin + '/api/video/jobs', { headers })).json()).jobs).toEqual([]);
    const map = await fetch(origin + '/_AMapService/v3/direction/driving?origin=120.1,30.2&destination=139.69,35.68');
    expect(map.status).toBe(422);
    expect((await map.json()).error).toContain('仅支持中国大陆');
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);
