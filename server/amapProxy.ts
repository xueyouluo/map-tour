import type { Request, Response } from 'express';
import { assertMainlandMapRequest } from './serviceRegion';

const AMAP_REST_ORIGIN = 'https://restapi.amap.com';

export function buildAmapProxyUrl(originalUrl: string, securityJsCode: string): string {
  const pathAndQuery = originalUrl.replace(/^\/_AMapService/, '') || '/';
  const url = new URL(pathAndQuery, AMAP_REST_ORIGIN);
  if (url.origin !== AMAP_REST_ORIGIN) throw new Error('Invalid map proxy origin');
  assertMainlandMapRequest(url);
  url.searchParams.set('jscode', securityJsCode);
  return url.toString();
}

export async function proxyAmapRequest(req: Request, res: Response): Promise<void> {
  const securityJsCode = process.env.AMAP_SECURITY_JS_CODE;
  if (!securityJsCode) {
    res.status(503).json({ error: 'AMAP_SECURITY_JS_CODE is not configured.' });
    return;
  }

  const targetUrl = buildAmapProxyUrl(req.originalUrl, securityJsCode);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: req.header('accept') || '*/*',
        'user-agent': req.header('user-agent') || 'map-tour-proxy'
      }
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    if (res.destroyed) return;
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(body);
  } catch (error) {
    if (res.destroyed) return;
    const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    res.status(timedOut ? 504 : 502).json({
      status: '0',
      info: timedOut ? 'AMAP_PROXY_TIMEOUT' : 'AMAP_PROXY_UNAVAILABLE',
      infocode: timedOut ? 'REQUEST_TIMEOUT' : 'UPSTREAM_ERROR'
    });
  }
}
