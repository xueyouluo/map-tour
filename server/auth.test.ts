import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthStore } from './authStore';
import { authRouter, adminUsersRouter, loadSession } from './authRoutes';
import { HttpError } from './httpSecurity';
import { SettingsStore, settingsRouter } from './settings';
import { ItineraryStore } from './storage';
import { itineraryRouter } from './itineraryRoutes';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});
const password = 'test-password-strong!';
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-auth-'));
  const file = path.join(root, 'db.sqlite'),
    auth = new AuthStore(file),
    store = new ItineraryStore(file);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(loadSession(auth));
  app.use('/api/auth', authRouter(auth));
  app.use('/api/admin/users', adminUsersRouter(auth));
  app.use('/api/itineraries', itineraryRouter(store));
  app.use(
    '/api/settings',
    settingsRouter(
      new SettingsStore(path.join(root, 'settings.json'), {
        OPENAI_API_KEY: 'private-service-secret'
      }),
      () => ({
        textReady: true,
        imageReady: true,
        mapReady: false,
        videoReady: false,
        musicCount: 0
      })
    )
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) =>
      res
        .status(error instanceof HttpError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'error' })
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin =
    'http://127.0.0.1:' + (server.address() as { port: number }).port;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function call(
    url: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    extra: Record<string, string> = {}
  ) {
    if (extra.Host) {
      return new Promise<Response>((resolve, reject) => {
        const request = http.request(
          origin + url,
          {
            method,
            headers: {
              ...(body !== undefined
                ? { 'Content-Type': 'application/json', Origin: origin }
                : {}),
              ...(cookie ? { Cookie: cookie } : {}),
              ...extra
            }
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers: Object.fromEntries(
                    Object.entries(response.headers).map(([key, value]) => [
                      key,
                      Array.isArray(value) ? value.join(', ') : value || ''
                    ])
                  )
                })
              )
            );
          }
        );
        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    return fetch(origin + url, {
      method,
      headers: {
        ...(body !== undefined
          ? { 'Content-Type': 'application/json', Origin: origin }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  return { auth, store, file, call, origin };
}
const cookie = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0];
it('registers regular users, ignores role escalation, authenticates with private cookies and guards admin settings', async () => {
  const { call } = await fixture();
  expect((await call('/api/settings')).status).toBe(401);
  expect((await call('/api/admin/users')).status).toBe(401);
  expect((await call('/api/itineraries')).status).toBe(401);
  const registered = await call('/api/auth/register', 'POST', {
    username: 'alice',
    password,
    role: 'admin',
    itineraryLimit: 999
  });
  expect(registered.status).toBe(201);
  expect(registered.headers.get('set-cookie')).toContain('HttpOnly');
  expect(registered.headers.get('set-cookie')).toContain('SameSite=Lax');
  const body = await registered.json();
  expect(body.user).toMatchObject({
    username: 'alice',
    role: 'user',
    itineraryLimit: 3,
    itineraryCount: 0
  });
  expect(JSON.stringify(body)).not.toContain(password);
  expect(JSON.stringify(body)).not.toContain('password_hash');
  const token = cookie(registered);
  expect((await call('/api/settings', 'GET', undefined, token)).status).toBe(
    403
  );
  expect((await call('/api/admin/users', 'GET', undefined, token)).status).toBe(
    403
  );
  expect(
    (
      await call(
        '/api/admin/users/' + body.user.id,
        'PATCH',
        { role: 'admin' },
        token
      )
    ).status
  ).toBe(403);
  expect((await call('/api/auth/logout', 'POST', {}, token)).status).toBe(200);
  expect(
    (await (await call('/api/auth/session', 'GET', undefined, token)).json())
      .user
  ).toBeNull();
  expect(
    (
      await call('/api/auth/login', 'POST', {
        username: 'alice',
        password: 'incorrect'
      })
    ).status
  ).toBe(401);
});
it('requires same-origin requests and restricts initial admin creation, then supports authenticated admin behind HTTPS proxy', async () => {
  const { call, origin } = await fixture();
  expect(
    (
      await call(
        '/api/auth/register',
        'POST',
        { username: 'alice', password },
        '',
        { Origin: 'https://evil.test' }
      )
    ).status
  ).toBe(403);
  expect(
    (
      await call(
        '/api/auth/register',
        'POST',
        { username: 'alice', password },
        '',
        { 'sec-fetch-site': 'cross-site' }
      )
    ).status
  ).toBe(403);
  const proxy = {
    Host: 'maps.example.test',
    Origin: 'https://maps.example.test',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.4'
  };
  expect(
    (
      await call(
        '/api/auth/setup',
        'POST',
        { username: 'admin', password },
        '',
        proxy
      )
    ).status
  ).toBe(403);
  const setup = await call('/api/auth/setup', 'POST', {
    username: 'admin',
    password
  });
  expect(setup.status).toBe(201);
  expect(
    (
      await call('/api/auth/setup', 'POST', {
        username: 'second-admin',
        password
      })
    ).status
  ).toBe(409);
  const login = await call(
    '/api/auth/login',
    'POST',
    { username: 'admin', password },
    '',
    proxy
  );
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('Secure');
  const adminCookie = cookie(login);
  const settings = await call(
    '/api/settings',
    'GET',
    undefined,
    adminCookie,
    proxy
  );
  expect(settings.status).toBe(200);
  expect(await settings.text()).not.toContain('private-service-secret');
  expect(
    (
      await call(
        '/api/settings',
        'PUT',
        { OPENAI_MODEL: 'updated-model' },
        adminCookie,
        proxy
      )
    ).status
  ).toBe(200);
  expect(
    (
      await call(
        '/api/settings',
        'PUT',
        { OPENAI_MODEL: 'evil' },
        adminCookie,
        { ...proxy, Origin: 'https://evil.test' }
      )
    ).status
  ).toBe(403);
});
it('enforces the three-itinerary limit atomically while preserving edits, private history, sharing and ownership', async () => {
  const { auth, store } = await fixture();
  const alice = await auth.create({ username: 'alice', password }),
    bob = await auth.create({ username: 'bob', password });
  const access = { userId: alice.id, admin: false },
    other = { userId: bob.id, admin: false };
  const input = () =>
    normalizeParsedItinerary({
      title: 'private',
      days: [{ stops: [{ name: 'A' }] }]
    });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => store.save(input(), access))
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(auth.user(alice.id)?.itineraryCount).toBe(3);
  expect(await store.listSummaries(100, other)).toEqual([]);
  const saved = await store.listSummaries(100, access),
    first = (await store.get(saved[0].id))!;
  expect(await store.getAccessible(first.id, other)).toBeNull();
  expect(await store.getAccessible(first.id)).toBeNull();
  await expect(
    store.save({ ...first, title: 'stolen' }, other)
  ).rejects.toThrow('自己的行程');
  await store.save({ ...first, title: 'edited' }, access);
  expect(auth.user(alice.id)?.itineraryCount).toBe(3);
  await store.save({ ...first, shareStatus: 'shared' }, access);
  expect((await store.getAccessible(first.id))?.editable).toBe(false);
  expect(auth.user(bob.id)?.itineraryCount).toBe(0);
  const legacy = await store.save(input());
  expect(await store.getAccessible(legacy.id)).not.toBeNull();
  await expect(store.save(legacy, other)).rejects.toThrow('自己的行程');
});
it('supports quota adjustments, account disabling, password resets, revocation and last-admin protection', async () => {
  const { auth, call } = await fixture();
  const admin = await auth.create({ username: 'admin', password }, 'admin');
  const user = await auth.create({ username: 'alice', password });
  const adminLogin = await call('/api/auth/login', 'POST', {
      username: 'admin',
      password
    }),
    adminCookie = cookie(adminLogin);
  const userLogin = await call('/api/auth/login', 'POST', {
      username: 'alice',
      password
    }),
    userCookie = cookie(userLogin);
  expect(
    (
      await call(
        '/api/admin/users/' + user.id,
        'PATCH',
        { itineraryLimit: 5 },
        adminCookie
      )
    ).status
  ).toBe(200);
  expect(auth.user(user.id)?.itineraryLimit).toBe(5);
  expect(
    (
      await call(
        '/api/admin/users/' + admin.id,
        'PATCH',
        { role: 'user' },
        adminCookie
      )
    ).status
  ).toBe(409);
  expect(
    (
      await call(
        '/api/admin/users/' + admin.id,
        'PATCH',
        { status: 'disabled' },
        adminCookie
      )
    ).status
  ).toBe(409);
  expect(
    (
      await call(
        '/api/admin/users/' + user.id,
        'PATCH',
        { status: 'disabled' },
        adminCookie
      )
    ).status
  ).toBe(200);
  expect(
    (
      await (
        await call('/api/auth/session', 'GET', undefined, userCookie)
      ).json()
    ).user
  ).toBeNull();
  expect(
    (
      await call(
        '/api/admin/users/' + user.id,
        'PATCH',
        { status: 'active' },
        adminCookie
      )
    ).status
  ).toBe(200);
  expect(
    (
      await call(
        '/api/admin/users/' + user.id + '/password',
        'POST',
        { password: 'replacement-password' },
        adminCookie
      )
    ).status
  ).toBe(200);
  expect(
    (await call('/api/auth/login', 'POST', { username: 'alice', password }))
      .status
  ).toBe(401);
  expect(
    (
      await call('/api/auth/login', 'POST', {
        username: 'alice',
        password: 'replacement-password'
      })
    ).status
  ).toBe(200);
  const list = await (
    await call('/api/admin/users?search=alice', 'GET', undefined, adminCookie)
  ).json();
  expect(list, JSON.stringify(list)).toMatchObject({ total: 1 });
  expect(JSON.stringify(list)).not.toContain('password_hash');
});
it('persists hashed sessions across restart, expires them and rate-limits repeated login failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-auth-persist-')),
    file = path.join(root, 'db.sqlite');
  let auth = new AuthStore(file);
  const user = await auth.create({ username: 'alice', password });
  const token = auth.newSession(user);
  auth.close();
  auth = new AuthStore(file);
  try {
    expect(auth.session(token)?.id).toBe(user.id);
    const raw = auth.db.prepare('select password_hash from users').get() as {
      password_hash: string;
    };
    expect(raw.password_hash.startsWith('scrypt$')).toBe(true);
    expect(raw.password_hash).not.toContain(password);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      (
        auth.db.prepare('select token_hash from auth_sessions').get() as {
          token_hash: string;
        }
      ).token_hash
    ).not.toBe(token);
    auth.db.prepare('update auth_sessions set expires_at=0').run();
    expect(auth.session(token)).toBeNull();
  } finally {
    auth.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const { call } = await fixture();
  for (let i = 0; i < 6; i++)
    expect(
      (await call('/api/auth/login', 'POST', { username: 'missing', password }))
        .status
    ).toBe(401);
  expect(
    (await call('/api/auth/login', 'POST', { username: 'missing', password }))
      .status
  ).toBe(429);
});
it('allows users to change their password and invalidates all previous sessions', async () => {
  const { call } = await fixture();
  const reg = await call('/api/auth/register', 'POST', {
      username: 'alice',
      password
    }),
    old = cookie(reg);
  const other = await call('/api/auth/login', 'POST', {
      username: 'alice',
      password
    }),
    otherCookie = cookie(other);
  const changed = await call(
    '/api/auth/password',
    'POST',
    { currentPassword: password, password: 'new-test-password' },
    old
  );
  expect(changed.status).toBe(200);
  expect(
    (await (await call('/api/auth/session', 'GET', undefined, old)).json()).user
  ).toBeNull();
  expect(
    (
      await (
        await call('/api/auth/session', 'GET', undefined, otherCookie)
      ).json()
    ).user
  ).toBeNull();
  expect(
    (
      await (
        await call('/api/auth/session', 'GET', undefined, cookie(changed))
      ).json()
    ).user.username
  ).toBe('alice');
});

it('allows token-protected HTTPS admin bootstrap and disabling public registration', async () => {
  const { call } = await fixture();
  vi.stubEnv('USER_REGISTRATION_ENABLED', 'false');
  expect(
    (
      await call('/api/auth/register', 'POST', {
        username: 'blocked',
        password
      })
    ).status
  ).toBe(403);
  const token = 'isolated-test-setup-token-with-32-characters';
  vi.stubEnv('ADMIN_SETUP_TOKEN', token);
  const response = await call(
    '/api/auth/setup',
    'POST',
    { username: 'remote_admin', password, setupToken: token },
    '',
    {
      Host: 'maps.example.test',
      Origin: 'https://maps.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '203.0.113.4'
    }
  );
  expect(response.status).toBe(201);
  expect((await response.json()).user.role).toBe('admin');
});
