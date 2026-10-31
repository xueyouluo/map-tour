import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAmapProxyUrl, proxyAmapRequest } from './amapProxy';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('buildAmapProxyUrl', () => {
  it('rewrites local proxy path and appends security js code', () => {
    const url = buildAmapProxyUrl('/_AMapService/v3/place/text?keywords=test&key=abc', 'secret-code');

    expect(url).toBe('https://restapi.amap.com/v3/place/text?keywords=test&key=abc&jscode=secret-code');
  });
  it('does not forward keys to an off-origin URL', () => {
    expect(() => buildAmapProxyUrl('/_AMapService//example.com/collect', 'secret-code')).toThrow('origin');
  });
  it('bounds upstream requests and returns explicit timeout or connection failures', async () => {
    vi.stubEnv('AMAP_SECURITY_JS_CODE', 'fixture-code');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [error, status] of [[new DOMException('timeout', 'TimeoutError'), 504], [new Error('offline'), 502]] as const) {
      fetcher.mockRejectedValueOnce(error);
      const res = { destroyed: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
      await proxyAmapRequest({ originalUrl: '/_AMapService/v3/place/text', method: 'GET', header: () => '' } as any, res as any);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: '0' }));
      expect(fetcher.mock.calls.at(-1)?.[1].signal).toBeInstanceOf(AbortSignal);
    }
  });
});
