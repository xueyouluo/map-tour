import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnosticText, diagnosticError, type AnalyticsReport, type AttemptStatus, type ClientDiagnostic,
  type DiagnosticContext, type DiagnosticStatus, type ReportMetric } from '../src/shared/diagnostics';

const DAY = 86400000;
const serverBuildId = process.env.MAP_TOUR_BUILD_ID || (() => {
  try {
    const release = fs.readFileSync(path.resolve('RELEASE'), 'utf8').trim();
    return /^[a-f0-9]{7,40}$/.test(release) ? release : 'server';
  } catch { return 'server'; }
})();
export interface StoredEvent extends ClientDiagnostic { userId: string; source: 'client' | 'server'; userAgent?: string }
export interface ReportFilter { days?: number; operation?: string; browser?: string; userId?: string; status?: string; page?: number }
const rank = "case status when 'succeeded' then 6 when 'failed' then 5 when 'cancelled' then 4 when 'interrupted' then 3 when 'blocked' then 3 when 'clicked' then 2 else 1 end";

export function browserFamily(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox';
  if (/MicroMessenger/.test(ua)) return '微信';
  if (/Chrome|CriOS/.test(ua)) return 'Chrome';
  if (/Safari/.test(ua)) return 'Safari';
  return ua ? '其他' : '未知';
}
function metric(operation: string): ReportMetric {
  return { operation, attempts: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, blocked: 0,
    inProgress: 0, unconfirmed: 0, missingStarts: 0, successRate: null, medianMs: null, p95Ms: null };
}
function percentile(values: number[], p: number) {
  return values.length ? values.sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
}

export class AnalyticsStore {
  readonly db: DatabaseSync;
  private lastPrune = 0;
  constructor(file = path.resolve(process.env.SQLITE_DB_PATH || 'data/map-tour.sqlite')) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS analytics_events (
        event_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, user_id TEXT NOT NULL,
        source TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, attempt_id TEXT NOT NULL,
        browser TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(received_at);
      CREATE INDEX IF NOT EXISTS analytics_events_attempt ON analytics_events(user_id,source,operation,attempt_id);
      CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_semantic ON analytics_events(user_id,source,operation,attempt_id,status)
        WHERE attempt_id<>'' AND status<>'heartbeat';
      CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO analytics_meta VALUES ('tracking_since',?)").run(new Date().toISOString());
  }
  add(event: StoredEvent, now = Date.now()): boolean {
    this.prune(now);
    const result = this.db.prepare('INSERT OR IGNORE INTO analytics_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(event.eventId, now, event.userId, event.source, event.operation, event.status || 'failed',
        event.attemptId || '', event.source === 'server' && !event.userAgent ? '服务端' : browserFamily(event.userAgent || ''), JSON.stringify(event));
    return result.changes > 0;
  }
  prune(now = Date.now()) {
    if (now - this.lastPrune < 3600000) return;
    this.db.prepare('DELETE FROM analytics_events WHERE received_at<?').run(now - 90 * DAY);
    this.lastPrune = now;
  }
  report(filter: ReportFilter = {}, now = Date.now()): AnalyticsReport {
    this.prune(now);
    const days = [1,7,30,90].includes(filter.days || 7) ? filter.days || 7 : 7;
    const today = Math.floor((now + 8 * 3600000) / DAY) * DAY - 8 * 3600000;
    const since = today - (days - 1) * DAY;
    // Group the retained history before applying the period: an old start and a
    // new terminal event must not turn into a second attempt at a date boundary.
    const rows = this.db.prepare(`WITH ranked AS (
      SELECT *, MIN(received_at) OVER w AS first_at, MAX(received_at) OVER w AS last_at,
        MAX(status='started') OVER w AS has_start, COUNT(*) OVER w AS event_count,
        ROW_NUMBER() OVER (PARTITION BY CASE WHEN source='server' THEN '' ELSE user_id END,source,operation,CASE WHEN attempt_id='' THEN event_id ELSE attempt_id END
          ORDER BY ${rank} DESC,received_at DESC) AS position
      FROM analytics_events
      WINDOW w AS (PARTITION BY CASE WHEN source='server' THEN '' ELSE user_id END,source,operation,CASE WHEN attempt_id='' THEN event_id ELSE attempt_id END)
    ) SELECT event_id,first_at,last_at,has_start,event_count,user_id,source,operation,status,attempt_id,browser,
      json_extract(payload,'$.elapsedMs') AS elapsed_ms, json_extract(payload,'$.stage') AS stage,
      json_extract(payload,'$.error.cause.message') AS cause_message, json_extract(payload,'$.error.message') AS error_message
      FROM ranked WHERE position=1 AND first_at>=? AND first_at<=?
      AND (?='' OR operation=?) AND (?='' OR browser=?) AND (?='' OR user_id=?) ORDER BY first_at DESC,event_id DESC`)
      .all(since, now, filter.operation || '', filter.operation || '', filter.browser || '', filter.browser || '', filter.userId || '', filter.userId || '') as unknown as {
        event_id: string; first_at: number; last_at: number; has_start: number; event_count: number; user_id: string; source: string;
        operation: string; status: string; attempt_id: string; browser: string; elapsed_ms: number | null;
        stage: string | null; cause_message: string | null; error_message: string | null;
      }[];
    const attempts = rows.map(row => ({ ...row, result: (['started','heartbeat'].includes(row.status)
      ? now - row.last_at < 120000 ? 'in_progress' : 'unconfirmed' : row.status) as AttemptStatus }));
    const visible = attempts.filter(row => !filter.status || row.result === filter.status);
    const operations = new Map<string, ReportMetric>();
    const times = new Map<string, number[]>();
    const dates = new Map(Array.from({ length: days }, (_, i) => {
      const date = new Date(since + i * DAY + 8 * 3600000).toISOString().slice(0,10);
      return [date, { date, exports: 0, succeeded: 0, failed: 0 }];
    }));
    const browsers = new Map<string, { browser: string; exports: number; succeeded: number; failed: number; successRate: number | null }>();
    const failures = new Map<string, { operation: string; stage: string; message: string; count: number }>();
    for (const row of visible) {
      const m = operations.get(row.operation) || metric(row.operation);
      operations.set(row.operation, m); m.attempts++;
      const key = row.result === 'in_progress' ? 'inProgress' : row.result;
      if (key !== 'clicked') m[key]++;
      if (!row.has_start && row.result !== 'clicked' && row.result !== 'blocked') m.missingStarts++;
      if (row.result === 'succeeded' && row.elapsed_ms !== null) {
        const values = times.get(row.operation) || []; values.push(row.elapsed_ms); times.set(row.operation, values);
      }
      if (row.operation === 'video.export') {
        const date = new Date(row.first_at + 8 * 3600000).toISOString().slice(0,10);
        const day = dates.get(date)!; day.exports++; if (row.result === 'succeeded' || row.result === 'failed') day[row.result]++;
        const device = browsers.get(row.browser) || { browser: row.browser, exports: 0, succeeded: 0, failed: 0, successRate: null };
        device.exports++; if (row.result === 'succeeded' || row.result === 'failed') device[row.result]++;
        browsers.set(row.browser, device);
      }
      if (row.result === 'failed') {
        const message = row.cause_message || row.error_message || '未知错误';
        const stage = (row.stage || '').replace(/第 \d+\/\d+ 帧/g, '帧');
        const signature = JSON.stringify([row.operation, stage, message]);
        const failure = failures.get(signature) || { operation: row.operation, stage, message, count: 0 };
        failure.count++; failures.set(signature, failure);
      }
    }
    for (const m of operations.values()) {
      m.successRate = m.succeeded + m.failed ? m.succeeded / (m.succeeded + m.failed) : null;
      m.medianMs = percentile(times.get(m.operation) || [], .5); m.p95Ms = percentile(times.get(m.operation) || [], .95);
    }
    for (const b of browsers.values()) b.successRate = b.succeeded + b.failed ? b.succeeded / (b.succeeded + b.failed) : null;
    const page = Math.min(100000, Math.max(1, Math.trunc(filter.page || 1)));
    const recent = visible.slice((page - 1) * 30, page * 30).map(row => {
      const event = JSON.parse((this.db.prepare('SELECT payload FROM analytics_events WHERE event_id=?').get(row.event_id) as { payload: string }).payload) as StoredEvent;
      return { eventId: event.eventId, at: new Date(row.first_at).toISOString(), userId: row.user_id, source: row.source,
        browser: row.browser, status: row.result, operation: row.operation, attemptId: row.attempt_id,
        sceneId: event.sceneId || '', itineraryId: event.itineraryId || '', elapsedMs: row.elapsed_ms,
        buildId: event.buildId, stage: event.stage || '', error: event.error, details: event.details, context: { clientAt: event.clientAt,
          viewport: event.viewport, visibility: event.visibility, online: event.online,
          progress: event.progress, scene: event.scene, userAgent: event.userAgent } };
    });
    const totalEvents = visible.reduce((sum, row) => sum + row.event_count, 0);
    return { since: new Date(since).toISOString(), until: new Date(now).toISOString(),
      trackingSince: (this.db.prepare("SELECT value FROM analytics_meta WHERE key='tracking_since'").get() as { value: string }).value,
      timeZone: 'Asia/Shanghai', days, activeUsers: new Set(visible.map(row => row.user_id).filter(Boolean)).size, totalEvents,
      downloads: visible.filter(row => row.operation === 'video.download' && row.result === 'clicked').length,
      operations: [...operations.values()], daily: [...dates.values()], browsers: [...browsers.values()],
      failures: [...failures.values()].sort((a,b) => b.count - a.count).slice(0,10), recent, page, totalAttempts: visible.length };
  }
  close() { this.db.close(); }
}

let recorder: AnalyticsStore | undefined;
export function useAnalyticsStore(store?: AnalyticsStore) { recorder = store; }
type ServerContext = DiagnosticContext & { userId?: string; userAgent?: string };
export function recordServerEvent(context: ServerContext & { status: DiagnosticStatus }, reason?: unknown): void {
  try {
    recorder?.add({ ...context, userId: context.userId || '', source: 'server', eventId: randomUUID(),
      clientAt: new Date().toISOString(), buildId: serverBuildId, error: reason === undefined ? undefined : diagnosticError(reason),
      userAgent: context.userAgent ? diagnosticText(context.userAgent, 300) : undefined,
      page: '', visibility: 'visible', online: true, viewport: { width: 0, height: 0 } });
  } catch (error) { console.error(JSON.stringify({ event: 'analytics.persistence_error', error: diagnosticError(error) })); }
}
export function serverAttempt(context: ServerContext) {
  const attemptId = context.attemptId || randomUUID(), startedAt = Date.now();
  let finished = false;
  const heartbeat = setInterval(() => recordServerEvent({ ...context, attemptId, status: 'heartbeat', elapsedMs: Date.now() - startedAt }), 30000);
  heartbeat.unref();
  recordServerEvent({ ...context, attemptId, status: 'started' });
  return { finish(status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked', reason?: unknown, extra: Partial<ServerContext> = {}) {
    if (finished) return;
    finished = true; clearInterval(heartbeat);
    recordServerEvent({ ...context, ...extra, attemptId, status, elapsedMs: Date.now() - startedAt }, reason);
  } };
}
