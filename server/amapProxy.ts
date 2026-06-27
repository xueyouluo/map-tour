import type { Request, Response } from 'express';

const AMAP_REST_ORIGIN = 'https://restapi.amap.com';

export function buildAmapProxyUrl(originalUrl: string, securityJsCode: string): string {
  const pathAndQuery = originalUrl.replace(/^\/_AMapService/, '') || '/';
  const url = new URL(pathAndQuery, AMAP_REST_ORIGIN);
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
  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers: {
      accept: req.header('accept') || '*/*',
      'user-agent': req.header('user-agent') || 'map-tour-proxy'
    }
  });

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(Buffer.from(await upstream.arrayBuffer()));
}
