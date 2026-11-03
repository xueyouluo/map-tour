import { diagnosticError, diagnosticText, type ClientDiagnostic, type DiagnosticContext } from './shared/diagnostics';

declare const __APP_BUILD_ID__: string;
const endpoint = '/api/diagnostics/events';
const pending: ClientDiagnostic[] = [];
const recent = new Map<string, number>();
let sending = false;
let installed = false;

// Reporting must never interrupt the user's action or report its own failures.
export function reportClientError(reason: unknown, context: DiagnosticContext): void {
  try {
    const error = diagnosticError(reason);
    if (error.name === 'AbortError') return;
    const fingerprint = JSON.stringify([context.operation, context.sceneId, context.attemptId, context.stage, error.message]);
    const now = Date.now();
    for (const [key, at] of recent) if (now - at >= 30000) recent.delete(key);
    if (recent.has(fingerprint) || recent.size >= 100) return;
    recent.set(fingerprint, now);
    pending.push({
      ...context,
      eventId: crypto.randomUUID(),
      clientAt: new Date(now).toISOString(),
      buildId: typeof __APP_BUILD_ID__ === 'undefined' ? 'development' : __APP_BUILD_ID__,
      error,
      page: diagnosticText(location.pathname, 200),
      visibility: document.visibilityState,
      online: navigator.onLine,
      viewport: { width: innerWidth, height: innerHeight }
    });
    if (pending.length > 20) pending.shift();
    void flushClientDiagnostics();
  } catch { /* Unsupported browser APIs must not break the error UI. */ }
}

export async function flushClientDiagnostics(): Promise<void> {
  if (sending || !navigator.onLine) return;
  sending = true;
  try {
    while (pending.length) {
      const event = pending[0];
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event), signal: AbortSignal.timeout(8000)
      });
      if (response.status === 401 || response.status === 403) {
        // Never retain one account's errors for a subsequent account's session.
        pending.length = 0;
        break;
      }
      if (response.status >= 500) break;
      const index = pending.indexOf(event);
      if (index >= 0) pending.splice(index, 1);
      if (response.status === 429) { pending.length = 0; break; }
    }
  } catch { /* Retry on the next report, online event or page exit. */ }
  finally { sending = false; }
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
