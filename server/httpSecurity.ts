import type express from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function isDirectLocalRequest(req: express.Request): boolean {
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || ''
    )
  )
    return false;
  if (
    req.headers.forwarded ||
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host']
  )
    return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname))
      return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.host !== host.host
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
export const sameOriginMutation: express.RequestHandler = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  try {
    const origin = new URL(req.headers.origin || '');
    if (
      req.headers['sec-fetch-site'] === 'cross-site' ||
      origin.host !== req.headers.host ||
      origin.protocol !== `${req.protocol}:`
    )
      throw new Error();
    next();
  } catch {
    res.status(403).json({ error: '请从当前网站页面操作。' });
  }
};
