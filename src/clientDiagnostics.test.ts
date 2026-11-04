import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fetcher = vi.fn();
let target: EventTarget;
beforeEach(() => {
  vi.resetModules();
  fetcher.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
  target = new EventTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  vi.stubGlobal('location', { pathname: '/trip/test' });
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());

it('reports raw error chains and export context, merges duplicates and preserves distinct retry attempts', async () => {
  const { reportClientError, flushClientDiagnostics } = await import('./clientDiagnostics');
  const context = { operation: 'video.export' as const, sceneId: 'scene-1', stage: '渲染第 395/1185 帧', attemptId: 'attempt-1' };
  const error = new Error('帧未完成', { cause: new Error('地图素材加载超时') });
  reportClientError(error, context);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  reportClientError(error, context);
  reportClientError(error, { ...context, attemptId: 'attempt-2' });
  await flushClientDiagnostics();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('/api/diagnostics/events');
  expect(init).toMatchObject({ credentials: 'same-origin', keepalive: true });
  expect(JSON.parse(init.body)).toMatchObject({ ...context, visibility: 'hidden', viewport: { width: 390, height: 844 },
    error: { message: '帧未完成', cause: { message: '地图素材加载超时' } } });
});

it('buffers offline errors and retries a failed delivery with the same event ID', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const { reportClientError, flushClientDiagnostics } = await import('./clientDiagnostics');
  reportClientError(new Error('offline failure'), { operation: 'video.preview' });
  expect(fetcher).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true });
  fetcher.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(flushClientDiagnostics()).resolves.toBeUndefined();
  await flushClientDiagnostics();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).eventId).toBe(JSON.parse(fetcher.mock.calls[1][1].body).eventId);
});

it('does not report user cancellation or recursively report telemetry failures, and discards expired sessions', async () => {
  const { reportClientError, flushClientDiagnostics } = await import('./clientDiagnostics');
  reportClientError(new DOMException('已取消', 'AbortError'), { operation: 'video.export' });
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  reportClientError(new Error('failure'), { operation: 'video.export' });
  await new Promise(resolve => setImmediate(resolve));
  await flushClientDiagnostics();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('installs runtime handlers once and captures global errors, rejections and online retries', async () => {
  const { installClientDiagnostics, flushClientDiagnostics } = await import('./clientDiagnostics');
  installClientDiagnostics(); installClientDiagnostics();
  target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('runtime failure') }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  vi.stubGlobal('navigator', { onLine: false });
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejected work' }));
  vi.stubGlobal('navigator', { onLine: true });
  target.dispatchEvent(new Event('online'));
  await flushClientDiagnostics();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[1][1].body).operation).toBe('runtime.rejection');
});

it('reports start, progress heartbeat and one terminal success for the same attempt', async () => {
  vi.useFakeTimers();
  try {
    const { createClientAttempt, flushClientDiagnostics } = await import('./clientDiagnostics');
    const attempt = createClientAttempt({ operation: 'video.export', sceneId: 'scene-1' });
    await flushClientDiagnostics();
    attempt.touch({ stage: '渲染第 100/1185 帧', progress: 8 });
    await vi.advanceTimersByTimeAsync(30000);
    attempt.finish('succeeded', undefined, { details: { bytes: 2048 } });
    attempt.finish('failed', new Error('late failure'));
    await vi.advanceTimersByTimeAsync(60000);
    const events = fetcher.mock.calls.map(call => JSON.parse(call[1].body));
    expect(events.map(event => event.status)).toEqual(['started', 'heartbeat', 'succeeded']);
    expect(new Set(events.map(event => event.attemptId)).size).toBe(1);
    expect(events[1]).toMatchObject({ stage: '渲染第 100/1185 帧', progress: 8 });
    expect(events[2]).toMatchObject({ elapsedMs: 30000, details: { bytes: 2048 } });
  } finally { vi.useRealTimers(); }
});

it('reports cancellation separately and closes unfinished work on pagehide', async () => {
  const { createClientAttempt, flushClientDiagnostics } = await import('./clientDiagnostics');
  const cancelled = createClientAttempt({ operation: 'video.export' });
  cancelled.finish('cancelled');
  const interrupted = createClientAttempt({ operation: 'video.preview' });
  target.dispatchEvent(new Event('pagehide'));
  interrupted.finish('succeeded');
  await new Promise(resolve => setImmediate(resolve)); await flushClientDiagnostics();
  const events = fetcher.mock.calls.map(call => JSON.parse(call[1].body));
  expect(events.map(event => event.status)).toEqual(['started', 'cancelled', 'started', 'interrupted']);
});

it('persists offline events for the same account and automatically retries transient delivery failures', async () => {
  vi.useFakeTimers();
  const saved = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) });
  vi.stubGlobal('navigator', { onLine: false });
  try {
    const first = await import('./clientDiagnostics');
    first.setDiagnosticsUser('alice');
    first.reportClientEvent({ operation: 'video.download' }, 'clicked');
    const eventId = JSON.parse(saved.get('map-tour:events:alice')!)[0].eventId;
    vi.resetModules();
    const restored = await import('./clientDiagnostics');
    restored.installClientDiagnostics(); restored.setDiagnosticsUser('bob');
    vi.stubGlobal('navigator', { onLine: true });
    await restored.flushClientDiagnostics();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    restored.setDiagnosticsUser('alice');
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).eventId).toBe(eventId);
    expect(JSON.parse(saved.get('map-tour:events:alice')!)).toEqual([]);
  } finally { vi.useRealTimers(); }
});
