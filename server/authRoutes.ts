import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AuthStore } from './authStore';
import { serverAttempt } from './analytics';
import {
  HttpError,
  isDirectLocalRequest,
  sameOriginMutation
} from './httpSecurity';
import type { UserAccount } from '../src/shared/auth';

declare global {
  namespace Express {
    interface Request {
      currentUser?: UserAccount;
    }
  }
}
const COOKIE = 'map_tour_session';
export function sessionToken(req: express.Request): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1);
}
export const requireUser: express.RequestHandler = (req, res, next) => {
  if (!req.currentUser)
    return res.status(401).json({ error: '请先登录账号。' });
  next();
};
export const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (!req.currentUser)
    return res.status(401).json({ error: '请先登录管理员账号。' });
  if (req.currentUser.role !== 'admin')
    return res.status(403).json({ error: '只有管理员可以访问。' });
  next();
};
const asyncRoute =
  (
    handler: (req: express.Request, res: express.Response) => Promise<unknown>
  ): express.RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };
export function loadSession(store: AuthStore): express.RequestHandler {
  return (req, _res, next) => {
    const user = store.session(sessionToken(req));
    if (user) req.currentUser = user;
    next();
  };
}
function setSession(
  store: AuthStore,
  user: UserAccount,
  req: express.Request,
  res: express.Response
) {
  res.cookie(COOKIE, store.newSession(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: user.role === 'admin' ? 12 * 3600000 : 7 * 86400000
  });
}
function jsonOnly(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json'))
    return res.status(415).json({ error: '请使用 JSON 提交。' });
  next();
}
function checkSetupToken(value: unknown): boolean {
  const expected = process.env.ADMIN_SETUP_TOKEN;
  return Boolean(
    expected &&
    expected.length >= 24 &&
    typeof value === 'string' &&
    Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}
export function authRouter(store: AuthStore) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/session', (req, res) =>
    res.json({
      user: req.currentUser || null,
      registrationEnabled: process.env.USER_REGISTRATION_ENABLED !== 'false',
      setupAvailable: !store.hasAdmin() && isDirectLocalRequest(req)
    })
  );
  router.use(sameOriginMutation, jsonOnly);
  router.use((req, res, next) => {
    if (!req.secure && !isDirectLocalRequest(req))
      return res.status(403).json({ error: '请通过 HTTPS 访问账号服务。' });
    next();
  });
  const trackedAuth = (operation: 'auth.register' | 'auth.login',
    handler: (req: express.Request, res: express.Response) => Promise<UserAccount>) =>
    asyncRoute(async (req, res) => {
      const attempt = serverAttempt({ operation, userAgent: req.get('user-agent') });
      try {
        const user = await handler(req, res);
        attempt.finish('succeeded', undefined, { userId: user.id });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const reason = status === 429 ? 'rate_limited' : status === 403 ? 'registration_closed'
          : status === 401 ? 'invalid_credentials' : status === 409 ? 'already_exists' : status === 400 ? 'invalid_input' : 'service_error';
        attempt.finish(status === 403 || status === 429 ? 'blocked' : 'failed',
          status === 403 || status === 429 ? undefined : new Error(reason), { details: { reason } });
        throw error;
      }
    });
  router.post(
    '/register',
    trackedAuth('auth.register', async (req, res) => {
      if (process.env.USER_REGISTRATION_ENABLED === 'false')
        throw new HttpError(403, '暂未开放新用户注册。');
      store.rateLimit('register:' + req.ip, 10, 3600000);
      const user = await store.create(req.body);
      setSession(store, user, req, res);
      res.status(201).json({ user });
      return user;
    })
  );
  router.post(
    '/setup',
    asyncRoute(async (req, res) => {
      if (!isDirectLocalRequest(req) && !checkSetupToken(req.body?.setupToken))
        throw new HttpError(
          403,
          '管理员初始化仅支持本机访问，或使用服务器配置的初始化令牌。'
        );
      store.rateLimit('setup:' + req.ip, 5, 3600000);
      const user = await store.create(req.body, 'admin', true);
      setSession(store, user, req, res);
      res.status(201).json({ user });
    })
  );
  router.post(
    '/login',
    trackedAuth('auth.login', async (req, res) => {
      const bucket =
        'login:' +
        req.ip +
        ':' +
        String(req.body?.username || '')
          .slice(0, 64)
          .toLowerCase();
      store.rateLimit('login-ip:' + req.ip, 60, 900000);
      store.rateLimit(bucket, 6, 900000);
      const user = await store.login(req.body?.username, req.body?.password);
      store.clearAttempts(bucket);
      store.logout(sessionToken(req));
      setSession(store, user, req, res);
      res.json({ user });
      return user;
    })
  );
  router.post('/logout', (req, res) => {
    store.logout(sessionToken(req));
    res.clearCookie(COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure
    });
    res.json({ ok: true });
  });
  router.post(
    '/password',
    requireUser,
    asyncRoute(async (req, res) => {
      store.rateLimit('password:' + req.currentUser!.id, 6, 900000);
      await store.login(req.currentUser!.username, req.body?.currentPassword);
      await store.resetPassword(req.currentUser!.id, req.body?.password);
      setSession(store, store.user(req.currentUser!.id)!, req, res);
      res.json({ ok: true });
    })
  );
  return router;
}
export function adminUsersRouter(store: AuthStore) {
  const router = express.Router();
  router.use(requireAdmin, sameOriginMutation, jsonOnly);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/', (req, res) =>
    res.json(
      store.list(
        typeof req.query.search === 'string' ? req.query.search : '',
        Number(req.query.page) || 1
      )
    )
  );
  router.patch('/:id', (req, res) =>
    res.json({ user: store.update(req.params.id, req.body) })
  );
  router.post(
    '/:id/password',
    asyncRoute(async (req, res) => {
      await store.resetPassword(String(req.params.id), req.body?.password);
      res.json({ ok: true });
    })
  );
  return router;
}
