import express from 'express';
import { requireUser } from './authRoutes';
import { sameOriginMutation } from './httpSecurity';
import { diagnosticError, diagnosticOperations, diagnosticText, type ClientDiagnostic } from '../src/shared/diagnostics';

const sceneFields = ['width', 'height', 'frames', 'lastFrameMs', 'exporting', 'active', 'queued', 'failed', 'wanted', 'loaded', 'fullQuality'];
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readClientDiagnostic(value: unknown): ClientDiagnostic | undefined {
  const input = record(value);
  if (typeof input.eventId !== 'string' || !/^[\w-]{1,80}$/.test(input.eventId) ||
      !diagnosticOperations.includes(input.operation as ClientDiagnostic['operation']) ||
      typeof record(input.error).message !== 'string') return;
  const text = (key: string, limit: number) => diagnosticText(typeof input[key] === 'string' ? input[key] : '', limit);
  const viewport = record(input.viewport), scene = record(input.scene);
  const number = (value: unknown, max = 86400000) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(max, value) : 0;
  const result: ClientDiagnostic = {
    eventId: input.eventId,
    operation: input.operation as ClientDiagnostic['operation'],
    clientAt: typeof input.clientAt === 'string' && Number.isFinite(Date.parse(input.clientAt))
      ? new Date(input.clientAt).toISOString() : '',
    buildId: text('buildId', 100), error: diagnosticError(input.error),
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
  return result;
}

export function clientDiagnosticsRouter(write: (line: string) => void = line => console.warn(line)) {
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
    let limit = limits.get(userId);
    if (!limit) {
      if (limits.size >= 1000) return res.sendStatus(429);
      limit = { until: now + 60000, count: 0 };
      limits.set(userId, limit);
    }
    if (++limit.count > 30) return res.sendStatus(429);
    write(JSON.stringify({ event: 'client.error', receivedAt: new Date(now).toISOString(),
      userId, userAgent: diagnosticText(req.get('user-agent') || '', 300), ...event }));
    if (seen.size >= 5000) seen.delete(seen.keys().next().value!);
    seen.set(eventKey, now + 600000);
    res.sendStatus(204);
  });
  return router;
}

export function logServerError(error: unknown, context: Record<string, string | undefined>): void {
  console.error(JSON.stringify({ event: 'server.error', at: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(context).map(([key, value]) => [key, value && diagnosticText(value, 200)])),
    error: diagnosticError(error) }));
}
