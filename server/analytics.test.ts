import { afterEach, beforeEach, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AnalyticsStore, browserFamily, serverAttempt, useAnalyticsStore, type StoredEvent } from './analytics';
import { analyticsReportRouter, clientDiagnosticsRouter } from './diagnostics';

let store: AnalyticsStore, counter = 0;
const now = Date.parse('2026-11-04T14:30:00Z');
beforeEach(() => { store = new AnalyticsStore(':memory:'); });
afterEach(() => { useAnalyticsStore(undefined); store.close(); });
function event(attemptId: string, status: StoredEvent['status'], extra: Partial<StoredEvent> = {}): StoredEvent {
  return { eventId: 'event-' + (++counter), operation: 'video.export', status, attemptId, source: 'client',
    userId: 'alice', userAgent: 'Mozilla Chrome/130 Safari/537', clientAt: new Date(now).toISOString(),
    buildId: 'fixture', page: '/', visibility: 'visible', online: true, viewport: { width: 390, height: 844 }, ...extra };
}
it('aggregates real attempts, excludes cancellations and unknown outcomes from the success rate, and keeps storage failures separate', () => {
  store.add(event('ok', 'started'), now - 50000);
  store.add(event('ok', 'succeeded', { elapsedMs: 42000, details: { bytes: 1234 } }), now - 8000);
  store.add(event('failed', 'started'), now - 50000);
  store.add(event('failed', 'failed', { error: { name: 'Error', message: 'frame', cause: { name: 'TimeoutError', message: 'map timeout' } }, stage: '渲染第 395/1185 帧' }), now - 5000);
  store.add(event('cancelled', 'cancelled'), now - 4000);
  store.add(event('closed', 'interrupted'), now - 4000);
  store.add(event('lost', 'started'), now - 180000);
  store.add(event('working', 'started'), now - 180000);
  store.add(event('working', 'heartbeat'), now - 10000);
  store.add(event('ok', 'failed', { operation: 'video.storage', error: { name: 'QuotaExceededError', message: 'storage full' } }), now - 7000);
  store.add(event('', 'clicked', { operation: 'video.download' }), now - 1000);
  const report = store.report({ days: 1 }, now);
  expect(report.operations.find(row => row.operation === 'video.export')).toMatchObject({
    attempts: 6, succeeded: 1, failed: 1, cancelled: 1, interrupted: 1, inProgress: 1, unconfirmed: 1,
    successRate: .5, medianMs: 42000, p95Ms: 42000
  });
  expect(report.daily[0]).toEqual({ date: '2026-11-04', exports: 6, succeeded: 1, failed: 1 });
  expect(report.browsers[0]).toMatchObject({ browser: 'Chrome', exports: 6, successRate: .5 });
  expect(report.failures).toContainEqual({ operation: 'video.export', stage: '渲染帧', message: 'map timeout', count: 1 });
  expect(report.downloads).toBe(1);
  expect(report.activeUsers).toBe(1);
});
it('keeps a final result when starts and heartbeats arrive late, and permits eventual success after an interruption', () => {
  store.add(event('retry', 'interrupted'), now - 6000);
  store.add(event('retry', 'succeeded', { elapsedMs: 10000 }), now - 5000);
  store.add(event('retry', 'started'), now - 4000);
  store.add(event('retry', 'heartbeat'), now - 1000);
  const report = store.report({}, now);
  expect(report.totalAttempts).toBe(1);
  expect(report.recent[0].status).toBe('succeeded');
  expect(report.operations[0].missingStarts).toBe(0);
  expect(report.totalEvents).toBe(4);
});
it('uses Shanghai day boundaries and groups before applying dates and filters', () => {
  const midnight = Date.parse('2026-11-03T16:00:00Z');
  store.add(event('yesterday', 'started'), midnight - 1000);
  store.add(event('yesterday', 'succeeded'), midnight + 1000);
  store.add(event('today', 'succeeded', { userId: 'bob', userAgent: 'Safari/605' }), midnight + 5000);
  store.add(event('today-failure', 'failed', { error: { name: 'Error', message: 'failed' } }), midnight + 6000);
  const report = store.report({ days: 1, browser: 'Safari', userId: 'bob', status: 'succeeded' }, now);
  expect(report.since).toBe('2026-11-03T16:00:00.000Z');
  expect(report.totalAttempts).toBe(1);
  expect(report.totalEvents).toBe(1);
  expect(report.operations[0]).toMatchObject({ succeeded: 1, missingStarts: 1 });
  expect(store.report({ days: 1 }, now).totalAttempts).toBe(2);
  expect(store.report({ days: 7 }, now).totalAttempts).toBe(3);
});
it('deduplicates transport and semantic retries across database reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-analytics-'));
  const file = path.join(root, 'events.sqlite');
  const one = new AnalyticsStore(file), record = event('ok', 'succeeded');
  try {
    expect(one.add(record, now)).toBe(true);
    expect(one.add(record, now)).toBe(false);
    one.close();
    const two = new AnalyticsStore(file);
    try {
      expect(two.add({ ...record, eventId: 'new-transport-id' }, now + 1000)).toBe(false);
      expect(two.report({}, now + 1000).totalAttempts).toBe(1);
    } finally { two.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
it('prunes events after 90 days, paginates attempts, and leaves empty success rates undefined', () => {
  store.add(event('expired', 'succeeded'), now - 91 * 86400000);
  for (let i = 0; i < 35; i++) store.add(event('row-' + i, 'started'), now - i * 1000);
  const report = store.report({ days: 90, page: 2 }, now);
  expect(report.totalAttempts).toBe(35);
  expect(report.recent).toHaveLength(5);
  expect(report.operations[0].successRate).toBeNull();
  expect(store.db.prepare('select count(*) n from analytics_events').get()).toMatchObject({ n: 35 });
  expect(store.report({ userId: 'unknown' }, now)).toMatchObject({ totalAttempts: 0, activeUsers: 0, totalEvents: 0, operations: [] });
});
it('persists server success and error lifecycles exactly once', () => {
  useAnalyticsStore(store);
  const attempt = serverAttempt({ operation: 'itinerary.parse', userId: 'alice' });
  attempt.finish('succeeded', undefined, { itineraryId: 'trip-123' });
  attempt.finish('failed', new Error('late failure'));
  const report = store.report();
  expect(report.operations[0]).toMatchObject({ attempts: 1, succeeded: 1, failed: 0 });
  expect(report.recent[0]).toMatchObject({ itineraryId: 'trip-123', source: 'server', browser: '服务端' });
});
it('recognizes desktop, iOS, WeChat and Edge user agents', () => {
  for (const [ua, name] of [['Mozilla Safari/605', 'Safari'], ['Mozilla CriOS/1 Safari/1','Chrome'],
    ['Mozilla Chrome/1 Safari/1 Edg/2','Edge'], ['Mozilla Safari/1 MicroMessenger/1','微信'], ['', '未知']])
    expect(browserFamily(ua)).toBe(name);
});
it('protects reports by role, validates filters, and persists authenticated successes without accepting spoofed server events', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.get('x-user')) req.currentUser = { id: req.get('x-user'), role: req.get('x-role') || 'user' } as Express.Request['currentUser']; next(); });
  app.use('/api/diagnostics', clientDiagnosticsRouter(() => {}, store));
  app.use('/api/admin/reports', analyticsReportRouter(store));
  const server: Server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(origin + '/api/admin/reports')).status).toBe(401);
    expect((await fetch(origin + '/api/admin/reports', { headers: { 'x-user': 'alice' } })).status).toBe(403);
    const headers = { 'x-user': 'admin', 'x-role': 'admin' };
    expect((await fetch(origin + '/api/admin/reports?days=100', { headers })).status).toBe(400);
    const send = (body: unknown) => fetch(origin + '/api/diagnostics/events', { method: 'POST', headers: { 'x-user': 'alice', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const success = event('ok', 'succeeded', { userId: 'spoofed', source: 'server', details: { bytes: 1234 }, error: { name: 'Error', message: 'ignored' } });
    expect((await send(success)).status).toBe(204);
    expect((await send({ ...success, eventId: 'repeat' })).status).toBe(204);
    expect((await send({ ...success, operation: 'video.background' })).status).toBe(400);
    const response = await fetch(origin + '/api/admin/reports', { headers });
    expect(response.headers.get('cache-control')).toContain('no-store');
    const report = await response.json();
    expect(report.totalAttempts).toBe(1);
    expect(report.recent[0]).toMatchObject({ userId: 'alice', source: 'client', status: 'succeeded', details: { bytes: 1234 } });
    expect(report.recent[0]).not.toHaveProperty('error');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('merges a server authentication attempt when identity becomes known, while isolating client attempts by account', () => {
  useAnalyticsStore(store);
  const login = serverAttempt({ operation: 'auth.login', userAgent: 'Safari/605' });
  login.finish('succeeded', undefined, { userId: 'alice' });
  store.add(event('same-client-id', 'started', { userId: 'alice' }));
  store.add(event('same-client-id', 'failed', { userId: 'bob', error: { name: 'Error', message: 'failed' } }));
  const report = store.report();
  expect(report.totalAttempts).toBe(3);
  expect(report.operations.find(row => row.operation === 'auth.login')).toMatchObject({ attempts: 1, succeeded: 1, missingStarts: 0 });
  expect(report.recent.find(row => row.operation === 'auth.login')).toMatchObject({ userId: 'alice', browser: 'Safari' });
  expect(store.report({ userId: 'alice', operation: 'auth.login' }).totalEvents).toBe(2);
});
