import express from 'express';
import { requireUser, requireAdmin } from './authRoutes';
import { sameOriginMutation } from './httpSecurity';
import { diagnosticError, diagnosticOperations, diagnosticStatuses, diagnosticText, type ClientDiagnostic } from '../src/shared/diagnostics';
import { recordServerEvent, type AnalyticsStore } from './analytics';

const sceneFields = ['width', 'height', 'frames', 'lastFrameMs', 'exporting', 'active', 'queued', 'failed', 'wanted', 'loaded', 'fullQuality'];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readClientDiagnostic(value: unknown): ClientDiagnostic | undefined {
  const input = record(value);
  const status = input.status === undefined ? 'failed' : input.status;
  if (typeof input.eventId !== 'string' || !/^[\w-]{1,80}$/.test(input.eventId) ||
      !diagnosticOperations.includes(input.operation as ClientDiagnostic['operation']) ||
      ['itinerary.parse', 'video.scene', 'video.background', 'server.error', 'auth.register', 'auth.login', 'share.publish', 'share.open', 'itinerary.save'].includes(String(input.operation)) ||
      !diagnosticStatuses.includes(status as typeof diagnosticStatuses[number]) ||
      (status === 'failed' && typeof record(input.error).message !== 'string') ||
      (status !== 'failed' && status !== 'clicked' && status !== 'blocked' && (typeof input.attemptId !== 'string' || !/^[\w-]{1,80}$/.test(input.attemptId)))) return;
  if ((input.operation === 'quota.blocked' && status !== 'blocked') || (status === 'blocked' && input.operation !== 'quota.blocked')) return;
  const text = (key: string, limit: number) => diagnosticText(typeof input[key] === 'string' ? input[key] : '', limit);
  const viewport = record(input.viewport), scene = record(input.scene);
  const number = (value: unknown, max = 86400000) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(max, value) : 0;
  const result: ClientDiagnostic = {
    eventId: input.eventId,
    operation: input.operation as ClientDiagnostic['operation'],
    clientAt: typeof input.clientAt === 'string' && Number.isFinite(Date.parse(input.clientAt))
      ? new Date(input.clientAt).toISOString() : '',
    buildId: text('buildId', 100), status: status as ClientDiagnostic['status'],
    ...(status === 'failed' ? { error: diagnosticError(input.error) } : {}),
    page: text('page', 200).split(/[?#]/)[0],
    visibility: input.visibility === 'hidden' ? 'hidden' : 'visible',
    online: input.online === true,
    viewport: { width: number(viewport.width, 20000), height: number(viewport.height, 20000) }
  };
  for (const key of ['stage', 'sceneId', 'itineraryId', 'attemptId'] as const)
    if (typeof input[key] === 'string') result[key] = text(key, 200);
  if (typeof input.elapsedMs === 'number') result.elapsedMs = number(input.elapsedMs);
  if (typeof input.progress === 'number') result.progress = number(input.progress, 100);
  result.scene = Object.fromEntries(sceneFields.filter(key =>
    typeof scene[key] === 'boolean' || (typeof scene[key] === 'number' && Number.isFinite(scene[key]))
  ).map(key => [key, typeof scene[key] === 'boolean' ? scene[key] : number(scene[key])]));
  const details = record(input.details);
  result.details = {};
  for (const key of ['bytes','durationSeconds','width','height'] as const)
    if (typeof details[key] === 'number') result.details[key] = number(details[key], key === 'bytes' ? 10 * 1024 ** 3 : 20000);
  for (const [key, allowed] of [['music',['none','upbeat','library','upload']], ['inputKind',['text','image']], ['storage',['saved','memory']], ['action',['parse','copy','save']], ['reason',['limit_reached']]] as const)
    if ((allowed as readonly unknown[]).includes(details[key])) result.details[key] = details[key] as string;
  return result;
}

export function clientDiagnosticsRouter(write: (line: string) => void = line => console.warn(line), store?: AnalyticsStore) {
  const router = express.Router();
  const limits = new Map<string, { until: number; count: number }>();
  const seen = new Map<string, number>();
  router.post('/events', requireUser, sameOriginMutation, (req, res) => {
    if (!req.is('application/json')) return res.sendStatus(415);
    if (Buffer.byteLength(JSON.stringify(req.body) || '') > 16384) return res.sendStatus(413);
    const event = readClientDiagnostic(req.body);
    if (!event) return res.sendStatus(400);
    const now = Date.now(), userId = req.currentUser!.id;
    for (const [key, limit] of limits) if (limit.until <= now) limits.delete(key);
    for (const [key, until] of seen) if (until <= now) seen.delete(key);
    const eventKey = `${userId}:${event.eventId}`;
    if (seen.has(eventKey)) return res.sendStatus(204);
    const limitKey = userId + (event.status === 'failed' ? ':errors' : ':lifecycle');
    let limit = limits.get(limitKey);
    if (!limit) {
      if (limits.size >= 1000) return res.sendStatus(429);
      limit = { until: now + 60000, count: 0 };
      limits.set(limitKey, limit);
    }
    if (++limit.count > (event.status === 'failed' ? 30 : 120)) { res.setHeader('Retry-After', '60'); return res.sendStatus(429); }
    const userAgent = diagnosticText(req.get('user-agent') || '', 300);
    const inserted = store?.add({ ...event, userId, userAgent, source: 'client' });
    if (inserted !== false && event.status !== 'heartbeat') write(JSON.stringify({
      event: event.status === 'failed' ? 'client.error' : 'client.event', receivedAt: new Date(now).toISOString(),
      userId, userAgent, ...event }));
    if (seen.size >= 5000) seen.delete(seen.keys().next().value!);
    seen.set(eventKey, now + 600000);
    res.sendStatus(204);
  });
  return router;
}

export function analyticsReportRouter(store: AnalyticsStore) {
  const router = express.Router();
  router.get('/', requireAdmin, (req, res) => {
    const { days = '7', operation = '', browser = '', userId = '', status = '', page = '1' } = req.query;
    if (![days,operation,browser,userId,status,page].every(value => typeof value === 'string') ||
      !['1','7','30','90'].includes(String(days)) || !/^\d{1,6}$/.test(String(page)) || Number(page) < 1 ||
      (operation && !diagnosticOperations.includes(operation as ClientDiagnostic['operation'])) ||
      String(browser).length > 30 || String(userId).length > 80 ||
      (status && !['succeeded','failed','cancelled','interrupted','in_progress','unconfirmed','clicked','blocked'].includes(String(status))))
      return res.status(400).json({ error: '报表筛选条件不正确。' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(store.report({ days: Number(days), operation: String(operation), browser: String(browser),
      userId: String(userId), status: String(status), page: Number(page) }));
  });
  return router;
}

export function logServerError(error: unknown, context: Record<string, string | undefined>): void {
  // Lifecycle failures already have their own attempt; keep other operational failures searchable too.
  if (!['parse.stream', 'video.background', 'video.request'].includes(context.operation || '') && !context.path?.startsWith('/api/parse'))
    recordServerEvent({ operation: 'server.error', status: 'failed', userId: context.userId,
      stage: diagnosticText(context.operation || context.path || 'API', 200) }, error);
  console.error(JSON.stringify({ event: 'server.error', at: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, value && diagnosticText(value, 200)])),
    error: diagnosticError(error) }));
}
