import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { expect, it } from 'vitest';
import {
  SettingsStore,
  settingsRouter,
  isLocalSettingsRequest
} from './settings';

it('persists validated overrides privately, retains untouched secrets and respects another writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-settings-'));
  const file = path.join(root, 'settings.json');
  const env = { OPENAI_API_KEY: 'original-private-key', OPENAI_MODEL: 'old' };
  const store = new SettingsStore(file, env);
  try {
    store.save({ OPENAI_MODEL: 'new', AMAP_MAP_STYLE_ID: 'a'.repeat(32) });
    expect(env.OPENAI_API_KEY).toBe('original-private-key');
    expect(
      store.fields().find((f) => f.key === 'OPENAI_API_KEY')
    ).toMatchObject({ value: '', configured: true });
    expect(JSON.stringify(store.fields())).not.toContain(
      'original-private-key'
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.save({ OPENAI_API_KEY: 'replacement-private-key' });
    const reloaded: NodeJS.ProcessEnv = {};
    new SettingsStore(file, reloaded).load();
    expect(reloaded.OPENAI_API_KEY).toBe('replacement-private-key');
    expect(reloaded.OPENAI_MODEL).toBe('new');
    fs.writeFileSync(file + '.lock', 'other task');
    expect(() => store.save({ OPENAI_MODEL: 'blocked' })).toThrow('其他任务');
    expect(env.OPENAI_MODEL).toBe('new');
    expect(fs.readFileSync(file + '.lock', 'utf8')).toBe('other task');
    fs.unlinkSync(file + '.lock');
    store.save({ VIDEO_MUSIC_CDN_URL: 'https://cdn.example.com/music/' });
    expect(store.fields().find(field => field.key === 'VIDEO_MUSIC_CDN_URL')?.value).toBe('https://cdn.example.com/music/');
    store.save({ OPENAI_API_KEY: '' });
    expect(env.OPENAI_API_KEY).toBe('');
    for (const invalid of [
      { PORT: '9' },
      { OPENAI_BASE_URL: 'file:///private' },
      { OPENAI_BASE_URL: 'https://user:pass@example.com/v1' },
      { AMAP_MAP_STYLE_ID: 'oops' },
      { OPENAI_MODEL: 'x\ny' },
      { VIDEO_EXPORT_ENABLED: 'yes' },
      { VIDEO_MUSIC_CDN_URL: 'http://cdn.example.com/music/' },
      { VIDEO_MUSIC_CDN_URL: 'https://user:pass@cdn.example.com' }
    ]) {
      expect(() => store.save(invalid)).toThrow();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('only allows direct local hosts and refuses forwarded, remote and cross-origin requests', () => {
  const request = (remote: string, headers: Record<string, string>) =>
    ({ socket: { remoteAddress: remote }, headers }) as express.Request;
  expect(
    isLocalSettingsRequest(request('127.0.0.1', { host: '127.0.0.1:8789' }))
  ).toBe(true);
  expect(isLocalSettingsRequest(request('::1', { host: '[::1]:8789' }))).toBe(
    true
  );
  for (const req of [
    request('10.0.0.2', { host: 'localhost' }),
    request('127.0.0.1', { host: 'evil.test' }),
    request('127.0.0.1', { host: 'localhost', origin: 'https://evil.test' }),
    request('127.0.0.1', { host: 'localhost', 'x-forwarded-for': '10.0.0.1' }),
    request('127.0.0.1', { host: 'localhost', 'sec-fetch-site': 'cross-site' })
  ]) {
    expect(isLocalSettingsRequest(req)).toBe(false);
  }
});

it('serves safe status and requires same-origin JSON saves, without returning credentials', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-settings-route-')
  );
  const store = new SettingsStore(path.join(root, 'settings.json'), {
    OPENAI_API_KEY: 'hidden-secret'
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/settings',
    settingsRouter(
      store,
      () => ({
        textReady: true,
        imageReady: false,
        mapReady: false,
        videoReady: false,
        musicCount: 10
      }),
      (_req, _res, next) => next()
    )
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(origin + '/api/settings');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).not.toContain('hidden-secret');
    const put = (extra: Record<string, string>) =>
      fetch(origin + '/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...extra },
        body: JSON.stringify({ OPENAI_MODEL: 'test-model' })
      });
    expect((await put({})).status).toBe(403);
    expect((await put({ origin: 'https://evil.test' })).status).toBe(403);
    const saved = await put({ origin });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('hidden-secret');
    expect(
      (
        await fetch(origin + '/api/settings', {
          headers: { 'x-forwarded-for': '1.2.3.4' }
        })
      ).status
    ).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('keeps legacy image overrides readable but only exposes and accepts the unified parser settings', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'map-tour-settings-legacy-')
  );
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      OPENAI_MODEL: 'deepseek-flash',
      ARK_API_KEY: 'retired-private-key',
      ARK_IMAGE_MODEL: 'retired-model'
    })
  );
  const env: NodeJS.ProcessEnv = {};
  const store = new SettingsStore(file, env);
  try {
    store.load();
    expect(env.OPENAI_MODEL).toBe('deepseek-flash');
    const fields = store.fields();
    expect(
      fields.filter((field) => field.group === 'text').map((field) => field.key)
    ).toEqual(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL']);
    expect(JSON.stringify(fields)).not.toContain('ARK_');
    expect(JSON.stringify(fields)).not.toContain('retired-private-key');
    expect(() => store.save({ ARK_API_KEY: 'new-value' })).toThrow('不支持');
    store.save({ VIDEO_EXPORT_ENABLED: 'true' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).ARK_API_KEY).toBe(
      'retired-private-key'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
