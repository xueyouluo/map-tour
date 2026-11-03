import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clientDiagnosticsRouter, logServerError } from './diagnostics';

let server: Server, origin: string;
const write = vi.fn();
beforeEach(async () => {
  write.mockClear();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    if (req.get('x-test-user')) req.currentUser = { id: req.get('x-test-user')! } as Express.Request['currentUser'];
    next();
  });
  app.use('/api/diagnostics', clientDiagnosticsRouter(write));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
});

function event(eventId = 'error-1') {
  return { eventId, operation: 'video.export', clientAt: new Date().toISOString(), buildId: 'build-123',
    stage: '渲染第 395/1185 帧', sceneId: 'scene-123', itineraryId: 'trip-123', attemptId: 'attempt-123',
    elapsedMs: 42100, progress: 33, error: { name: 'BrowserExportError', message: '帧未完成',
      cause: { name: 'TimeoutError', message: '地图素材加载超时', stack: 'Error at https://example.test/app.js:4:2?token=hidden-secret' } },
    page: '/trip/123?private=hidden', visibility: 'hidden', online: true, viewport: { width: 390, height: 844 },
    scene: { width: 1080, queued: 16, wanted: 16, private: 'private itinerary' },
    userId: 'spoofed-user', itinerary: 'private itinerary' };
}
function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin + '/api/diagnostics/events', { method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-test-user': 'real-user', 'user-agent': 'Regression Chrome', ...headers },
    body: JSON.stringify(body) });
}

it('writes bounded JSON with authenticated identity, export context, raw cause and browser metadata', async () => {
  expect((await post(event())).status).toBe(204);
  expect(write).toHaveBeenCalledTimes(1);
  const log = JSON.parse(write.mock.calls[0][0]);
  expect(log).toMatchObject({ event: 'client.error', userId: 'real-user', userAgent: 'Regression Chrome',
    operation: 'video.export', stage: '渲染第 395/1185 帧', sceneId: 'scene-123', attemptId: 'attempt-123',
    buildId: 'build-123', page: '/trip/123', scene: { width: 1080, queued: 16 },
    error: { cause: { name: 'TimeoutError', message: '地图素材加载超时' } } });
  expect(log.receivedAt).toBeTruthy();
  for (const value of ['hidden-secret', 'spoofed-user', 'private itinerary'])
    expect(write.mock.calls[0][0]).not.toContain(value);
});

it('rejects unauthenticated, cross-site, invalid, non-JSON and oversized reports without logging', async () => {
  expect((await post(event(), { 'x-test-user': '' })).status).toBe(401);
  expect((await post(event(), { origin: 'https://other.test' })).status).toBe(403);
  expect((await post(event(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await post({ ...event(), operation: 'arbitrary' })).status).toBe(400);
  expect((await post(null)).status).toBe(400);
  expect((await post(event(), { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await post({ ...event(), padding: 'x'.repeat(17000) })).status).toBe(413);
  expect(write).not.toHaveBeenCalled();
});

it('deduplicates delivery retries and limits bursts per account, then admits later errors', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  expect((await post(event())).status).toBe(204);
  expect((await post(event())).status).toBe(204);
  expect(write).toHaveBeenCalledTimes(1);
  for (let i = 1; i < 30; i++) expect((await post(event('error-' + (i + 1)))).status).toBe(204);
  expect((await post(event('overflow'))).status).toBe(429);
  expect((await post(event('other'), { 'x-test-user': 'other-user' })).status).toBe(204);
  vi.spyOn(Date, 'now').mockReturnValue(now + 60001);
  expect((await post(event('later'))).status).toBe(204);
  expect(write).toHaveBeenCalledTimes(32);
});

it('logs server stacks and causes without URL credentials or query secrets', () => {
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  logServerError(new Error('Failed https://upstream.test/map?key=hidden-secret', { cause: new Error('timeout') }),
    { operation: 'video.background', sceneId: 'scene-1', stage: '渲染' });
  const line = logger.mock.calls[0][0];
  expect(JSON.parse(line)).toMatchObject({ event: 'server.error', sceneId: 'scene-1', error: { cause: { message: 'timeout' } } });
  expect(line).not.toContain('hidden-secret');
});
