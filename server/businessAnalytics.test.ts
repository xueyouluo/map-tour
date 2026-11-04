import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import type { AnalyticsReport } from '../src/shared/diagnostics';

it('records actual auth, sharing and quota outcomes without credentials, protects reports, and persists across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-business-analytics-'));
  const reservation = express().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, file = path.join(root, 'fixture.sqlite');
  const settings = path.join(root, 'settings.json'); fs.writeFileSync(settings, '{}');
  const start = () => spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), SETTINGS_FILE: settings,
      SQLITE_DB_PATH: file, VIDEO_EXPORT_DIR: path.join(root, 'videos'), USER_REGISTRATION_ENABLED: 'true', VIDEO_EXPORT_ENABLED: 'false' }, stdio: 'ignore'
  });
  let child = start();
  const ready = () => vi.waitFor(async () => expect((await fetch(origin + '/api/health')).ok).toBe(true), { timeout: 10000 });
  const stop = async () => { if (child.exitCode !== null) return; const done = once(child, 'exit'); child.kill('SIGTERM'); await done; };
  const request = (url: string, method = 'GET', data?: unknown, cookie = '') => fetch(origin + url, {
    method, headers: { origin, cookie, 'content-type': 'application/json', 'user-agent': 'Analytics Safari/605' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
  const password = 'private-password-not-telemetry';
  try {
    await ready();
    const admin = await request('/api/auth/setup', 'POST', { username: 'adminfixture', password });
    expect(admin.status).toBe(201); const adminCookie = cookieOf(admin);
    const registered = await request('/api/auth/register', 'POST', { username: 'private_username_fixture', displayName: 'private-display-fixture', password });
    expect(registered.status).toBe(201);
    const userId = (await registered.json()).user.id;
    let userCookie = cookieOf(registered);
    expect((await request('/api/admin/reports')).status).toBe(401);
    expect((await request('/api/admin/reports', 'GET', undefined, userCookie)).status).toBe(403);
    expect((await request('/api/auth/login', 'POST', { username: 'private_username_fixture', password: 'wrong-private-password' })).status).toBe(401);
    const login = await request('/api/auth/login', 'POST', { username: 'private_username_fixture', password });
    expect(login.status).toBe(200); userCookie = cookieOf(login);
    const trip = normalizeParsedItinerary({ title: 'private-trip-title', days: [{ stops: [{ name: 'private-place-name' }] }] }, 'draft');
    trip.days[0].stops[0].poiMatch = { name: 'private-place-name', status: 'matched', location: [120.1, 30.2] };
    const saved = await request('/api/itineraries', 'POST', trip, userCookie);
    expect(saved.status).toBe(200); const ownTrip = (await saved.json()).itinerary;
    // Owner reads do not count as a share-page view; private links fail for visitors.
    expect((await request('/api/itineraries/' + ownTrip.id, 'GET', undefined, userCookie)).status).toBe(200);
    expect((await request('/api/itineraries/' + ownTrip.id + '?view=share')).status).toBe(404);
    expect((await request('/api/itineraries?action=share', 'POST', { ...ownTrip, shareStatus: 'shared' }, userCookie)).status).toBe(200);
    expect((await request('/api/itineraries/' + ownTrip.id + '?view=share')).status).toBe(200);
    const event = { eventId: 'clipboard-finished', operation: 'share.copy', status: 'succeeded', attemptId: 'clipboard-attempt', itineraryId: ownTrip.id };
    expect((await request('/api/diagnostics/events', 'POST', event, userCookie)).status).toBe(204);
    // Enforce the same exhausted account at the parse guard and at atomic storage creation.
    expect((await request('/api/admin/users/' + userId, 'PATCH', { role: 'user', status: 'active', itineraryLimit: 1 }, adminCookie)).status).toBe(200);
    expect((await request('/api/parse', 'POST', { text: 'private-input-text' }, userCookie)).status).toBe(403);
    expect((await request('/api/itineraries', 'POST', trip, userCookie)).status).toBe(403);
    expect((await request('/api/diagnostics/events', 'POST', { eventId: 'client-quota', operation: 'quota.blocked', status: 'blocked', details: { action: 'parse', reason: 'limit_reached' } }, userCookie)).status).toBe(204);
    // Saving an existing itinerary still works after quota exhaustion.
    expect((await request('/api/itineraries', 'POST', ownTrip, userCookie)).status).toBe(200);
    for (let i = 0; i < 6; i++) expect((await request('/api/auth/login', 'POST', { username: 'rate_fixture', password: 'wrong-private-password' })).status).toBe(401);
    expect((await request('/api/auth/login', 'POST', { username: 'rate_fixture', password })).status).toBe(429);
    const report = await (await request('/api/admin/reports', 'GET', undefined, adminCookie)).json() as AnalyticsReport;
    const metric = (op: string) => report.operations.find(row => row.operation === op)!;
    expect(metric('auth.register')).toMatchObject({ attempts: 1, succeeded: 1, inProgress: 0, missingStarts: 0 });
    expect(metric('auth.login')).toMatchObject({ attempts: 9, succeeded: 1, failed: 7, blocked: 1, inProgress: 0, missingStarts: 0 });
    expect(metric('share.open')).toMatchObject({ attempts: 2, succeeded: 1, failed: 1 });
    expect(metric('share.publish')).toMatchObject({ attempts: 1, succeeded: 1 });
    expect(metric('share.copy')).toMatchObject({ succeeded: 1 });
    expect(metric('quota.blocked')).toMatchObject({ attempts: 3, blocked: 3, failed: 0 });
    expect(metric('itinerary.save')).toMatchObject({ succeeded: 2, blocked: 1 });
    expect(report.recent.find(row => row.operation === 'auth.register')).toMatchObject({ userId, browser: 'Safari' });
    const db = new DatabaseSync(file, { readOnly: true });
    const payloads = JSON.stringify(db.prepare('select payload from analytics_events').all()); db.close();
    for (const secret of [password, 'wrong-private-password', 'private_username_fixture', 'private-display-fixture', 'private-trip-title', 'private-place-name', 'private-input-text']) expect(payloads).not.toContain(secret);
    await stop(); child = start(); await ready();
    const after = await (await request('/api/admin/reports', 'GET', undefined, adminCookie)).json() as AnalyticsReport;
    expect(after.totalAttempts).toBe(report.totalAttempts);
    expect(after.trackingSince).toBe(report.trackingSince);
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);
