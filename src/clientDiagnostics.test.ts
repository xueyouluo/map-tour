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
