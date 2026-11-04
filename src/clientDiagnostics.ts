import { diagnosticError, diagnosticText, type ClientDiagnostic, type DiagnosticContext, type DiagnosticStatus } from './shared/diagnostics';

declare const __APP_BUILD_ID__: string;
const endpoint = '/api/diagnostics/events';
const pending: ClientDiagnostic[] = [];
const recent = new Map<string, number>();
let sending = false;
let installed = false;
let currentUser: string | null | undefined;
let generation = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 5000;

function persist() {
  if (!currentUser) return;
  try { sessionStorage.setItem('map-tour:events:' + currentUser, JSON.stringify(pending)); } catch { /* Best effort. */ }
}
export function setDiagnosticsUser(userId: string | null) {
  if (userId === currentUser) return;
  persist(); generation++; pending.length = 0; recent.clear(); currentUser = userId;
  if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
  if (userId) try {
    const saved = JSON.parse(sessionStorage.getItem('map-tour:events:' + userId) || '[]');
    if (Array.isArray(saved)) pending.push(...saved.filter(event => event && typeof event.eventId === 'string'
      && Date.now() - Date.parse(event.clientAt) < 86400000).slice(-60));
  } catch { /* Storage may be disabled. */ }
  void flushClientDiagnostics();
}

function enqueue(event: ClientDiagnostic) {
  pending.push(event);
  if (pending.length > 60) {
    const expendable = pending.findIndex(item => item.status === 'heartbeat');
    pending.splice(Math.max(0, expendable), 1);
  }
  persist(); void flushClientDiagnostics();
}

// Reporting must never interrupt the user's action or report its own failures.
export function reportClientError(reason: unknown, context: DiagnosticContext): void {
  try {
    if (currentUser === null) return;
    const error = diagnosticError(reason);
    if (error.name === 'AbortError') return;
    const fingerprint = JSON.stringify([context.operation, context.sceneId, context.attemptId, context.stage, error.message]);
    const now = Date.now();
    for (const [key, at] of recent) if (now - at >= 30000) recent.delete(key);
    if (recent.has(fingerprint) || recent.size >= 100) return;
    recent.set(fingerprint, now);
    enqueue({
      ...context,
      eventId: crypto.randomUUID(),
      clientAt: new Date(now).toISOString(),
      buildId: typeof __APP_BUILD_ID__ === 'undefined' ? 'development' : __APP_BUILD_ID__,
      error, status: 'failed',
      page: diagnosticText(location.pathname, 200),
      visibility: document.visibilityState,
      online: navigator.onLine,
      viewport: { width: innerWidth, height: innerHeight }
    });
  } catch { /* Unsupported browser APIs must not break the error UI. */ }
}

export function reportClientEvent(context: DiagnosticContext, status: Exclude<DiagnosticStatus, 'failed'>): void {
  try {
    if (currentUser === null) return;
    enqueue({ ...context, status, eventId: crypto.randomUUID(), clientAt: new Date().toISOString(),
      buildId: typeof __APP_BUILD_ID__ === 'undefined' ? 'development' : __APP_BUILD_ID__,
      page: diagnosticText(location.pathname, 200), visibility: document.visibilityState,
      online: navigator.onLine, viewport: { width: innerWidth, height: innerHeight } });
  } catch { /* Telemetry must not interrupt the action. */ }
}

export function createClientAttempt(context: DiagnosticContext) {
  const startedAt = performance.now();
  let latest = { ...context, attemptId: context.attemptId || crypto.randomUUID() }, finished = false;
  reportClientEvent(latest, 'started');
  const heartbeat = setInterval(() => {
    reportClientEvent({ ...latest, elapsedMs: Math.round(performance.now() - startedAt) }, 'heartbeat');
  }, 30000);
  const interrupted = () => finish('interrupted', undefined, { stage: '页面离开或关闭' });
  window.addEventListener('pagehide', interrupted);
  function finish(status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked', error?: unknown, extra: Partial<DiagnosticContext> = {}) {
    if (finished) return;
    finished = true; clearInterval(heartbeat); window.removeEventListener('pagehide', interrupted);
    const value = { ...latest, ...extra, elapsedMs: Math.round(performance.now() - startedAt) };
    if (status === 'failed') reportClientError(error || new Error('操作失败'), value);
    else reportClientEvent(value, status);
  }
  return { attemptId: latest.attemptId, touch(extra: Partial<DiagnosticContext>) { latest = { ...latest, ...extra }; }, finish };
}

export async function flushClientDiagnostics(): Promise<void> {
  if (sending || retryTimer || !navigator.onLine || currentUser === null) return;
  sending = true;
  const epoch = generation;
  const retry = (delay = retryDelay) => {
    if (!installed) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void flushClientDiagnostics(); }, delay);
    retryDelay = Math.min(60000, retryDelay * 2);
  };
  try {
    while (pending.length) {
      const event = pending[0];
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event), signal: AbortSignal.timeout(8000)
      });
      if (epoch !== generation) break;
      if (response.status === 401 || response.status === 403) {
        // Never retain one account's errors for a subsequent account's session.
        pending.length = 0;
        break;
      }
      if (response.status >= 500 || response.status === 429) {
        retry(response.status === 429 ? Math.max(1000, Number(response.headers.get('retry-after') || 60) * 1000) : retryDelay);
        break;
      }
      const index = pending.indexOf(event);
      if (index >= 0) pending.splice(index, 1);
      retryDelay = 5000; persist();
    }
  } catch { if (epoch === generation) retry(); }
  finally {
    sending = false; persist();
    if (epoch !== generation) void flushClientDiagnostics();
  }
}

export function installClientDiagnostics(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    reportClientError(event.error || event.message, { operation: 'runtime.error', stage: 'window.error' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(event.reason, { operation: 'runtime.rejection', stage: 'unhandledrejection' });
  });
  window.addEventListener('online', () => { void flushClientDiagnostics(); });
  window.addEventListener('pagehide', () => { void flushClientDiagnostics(); });
}

export function sceneDiagnosticSnapshot(scene: Window | null): Record<string, number | boolean> {
  try {
    const diagnostics = (scene as Window & { followDiagnostics?: {
      playback(): Record<string, number | boolean>;
      hd(): Record<string, number>;
    } } | null)?.followDiagnostics;
    if (!diagnostics) return {};
    const playback = diagnostics.playback(), hd = diagnostics.hd();
    return Object.fromEntries([
      ...['width', 'height', 'frames', 'lastFrameMs', 'exporting', 'active', 'queued', 'failed']
        .map(key => [key, playback[key]]),
      ...['wanted', 'loaded', 'fullQuality'].map(key => [key, hd[key]])
    ].filter((entry) => typeof entry[1] === 'boolean' || typeof entry[1] === 'number'));
  } catch { return {}; }
}
