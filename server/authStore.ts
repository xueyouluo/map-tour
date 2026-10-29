import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
  scrypt
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { UserAccount } from '../src/shared/auth';
import { HttpError } from './httpSecurity';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: UserAccount['role'];
  status: UserAccount['status'];
  itinerary_limit: number;
  itinerary_count: number;
  created_at: string;
}
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key))
    )
  );
export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128
  )
    throw new HttpError(400, '密码需要 8–128 个字符。');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  const [scheme, salt, key] = hash.split('$');
  if (
    typeof password !== 'string' ||
    password.length > 128 ||
    scheme !== 'scrypt' ||
    !/^[a-f\d]{32}$/.test(salt || '') ||
    !/^[a-f\d]{128}$/.test(key || '')
  )
    return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, 'hex'));
}
export class AuthStore {
  readonly db: DatabaseSync;
  private dummyHash: Promise<string>;
  constructor(
    readonly file = path.resolve(
      process.env.SQLITE_DB_PATH || 'data/map-tour.sqlite'
    )
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db
      .exec(`pragma journal_mode=WAL; pragma foreign_keys=ON; pragma busy_timeout=5000;
      create table if not exists users (
        id text primary key, username text not null unique collate nocase, display_name text not null,
        password_hash text not null, role text not null check(role in ('user','admin')),
        status text not null default 'active' check(status in ('active','disabled')),
        itinerary_limit integer not null default 3 check(itinerary_limit>=0),
        itinerary_count integer not null default 0 check(itinerary_count>=0), created_at text not null
      );
      create table if not exists auth_sessions (
        token_hash text primary key, user_id text not null references users(id), expires_at integer not null
      );
      create index if not exists auth_sessions_user on auth_sessions(user_id);
      create table if not exists auth_attempts (bucket text primary key, count integer not null, resets_at integer not null);
    `);
    for (const f of [file, file + '-wal', file + '-shm'])
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    this.dummyHash = hashPassword(randomBytes(32).toString('hex'));
  }
  close() {
    this.db.close();
  }
  user(id: string): UserAccount | null {
    const row = this.db
      .prepare('select * from users where id=?')
      .get(id) as unknown as UserRow | undefined;
    return row ? publicUser(row) : null;
  }
  hasAdmin(): boolean {
    return (
      Number(
        (
          this.db
            .prepare(
              "select count(*) n from users where role='admin' and status='active'"
            )
            .get() as { n: number }
        ).n
      ) > 0
    );
  }
  async create(
    input: unknown,
    role: 'user' | 'admin' = 'user',
    bootstrap = false
  ): Promise<UserAccount> {
    const data = input as Record<string, unknown>;
    const username =
      typeof data?.username === 'string'
        ? data.username.trim().toLowerCase()
        : '';
    if (!/^[a-z\d_][a-z\d_.-]{2,31}$/.test(username))
      throw new HttpError(400, '用户名需要 3–32 位字母、数字或 _ . -。');
    const displayName =
      typeof data.displayName === 'string'
        ? data.displayName.trim().slice(0, 60)
        : username;
    const hash = await hashPassword(data.password as string);
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db.exec('begin immediate');
    try {
      if (bootstrap && this.hasAdmin())
        throw new HttpError(409, '管理员已经初始化，请直接登录。');
      if (
        this.db.prepare('select id from users where username=?').get(username)
      )
        throw new HttpError(409, '这个用户名已被使用。');
      this.db
        .prepare(
          'insert into users(id,username,display_name,password_hash,role,created_at) values(?,?,?,?,?,?)'
        )
        .run(id, username, displayName || username, hash, role, now);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
    return this.user(id)!;
  }
  async login(username: unknown, password: unknown): Promise<UserAccount> {
    const row = this.db
      .prepare('select * from users where username=?')
      .get(
        typeof username === 'string' ? username.trim().toLowerCase() : ''
      ) as unknown as UserRow | undefined;
    const valid = await verifyPassword(
      typeof password === 'string' ? password : '',
      row?.password_hash || (await this.dummyHash)
    );
    if (!row || !valid || row.status !== 'active')
      throw new HttpError(401, '用户名或密码不正确，或账号已停用。');
    return publicUser(row);
  }
  newSession(user: UserAccount): string {
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('delete from auth_sessions where expires_at<=?')
      .run(Date.now());
    this.db
      .prepare(
        'insert into auth_sessions(token_hash,user_id,expires_at) values(?,?,?)'
      )
      .run(
        tokenHash(token),
        user.id,
        Date.now() + (user.role === 'admin' ? 12 * 3600000 : 7 * 86400000)
      );
    return token;
  }
  session(token: string | undefined): UserAccount | null {
    if (!token || !/^[a-f\d]{64}$/.test(token)) return null;
    const row = this.db
      .prepare(
        "select u.* from users u join auth_sessions s on s.user_id=u.id where s.token_hash=? and s.expires_at>? and u.status='active'"
      )
      .get(tokenHash(token), Date.now()) as unknown as UserRow | undefined;
    return row ? publicUser(row) : null;
  }
  logout(token: string | undefined) {
    if (token)
      this.db
        .prepare('delete from auth_sessions where token_hash=?')
        .run(tokenHash(token));
  }
  rateLimit(bucket: string, max: number, windowMs: number) {
    const now = Date.now();
    this.db.prepare('delete from auth_attempts where resets_at<=?').run(now);
    this.db
      .prepare(
        'insert into auth_attempts(bucket,count,resets_at) values(?,1,?) on conflict(bucket) do update set count=count+1'
      )
      .run(bucket, now + windowMs);
    const row = this.db
      .prepare('select count from auth_attempts where bucket=?')
      .get(bucket) as { count: number };
    if (row.count > max) throw new HttpError(429, '操作过于频繁，请稍后再试。');
  }
  clearAttempts(bucket: string) {
    this.db.prepare('delete from auth_attempts where bucket=?').run(bucket);
  }
  list(search = '', page = 1) {
    const offset = (Math.max(1, Math.trunc(page) || 1) - 1) * 30;
    const pattern = '%' + search.slice(0, 80).replace(/[!%_]/g, '!$&') + '%';
    const rows = this.db
      .prepare(
        "select * from users where username like ? escape '!' or display_name like ? escape '!' order by created_at desc limit 30 offset ?"
      )
      .all(pattern, pattern, offset) as unknown as UserRow[];
    const total = Number(
      (
        this.db
          .prepare(
            "select count(*) n from users where username like ? escape '!' or display_name like ? escape '!'"
          )
          .get(pattern, pattern) as { n: number }
      ).n
    );
    return {
      users: rows.map(publicUser),
      total,
      page: Math.max(1, Math.trunc(page) || 1)
    };
  }
  update(id: string, input: unknown): UserAccount {
    const old = this.user(id);
    if (!old) throw new HttpError(404, '没有找到用户。');
    const body = input as Record<string, unknown>;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !['role', 'status', 'itineraryLimit'].includes(k)
      )
    )
      throw new HttpError(400, '用户修改内容不正确。');
    const role = body.role ?? old.role,
      status = body.status ?? old.status,
      limit = body.itineraryLimit ?? old.itineraryLimit;
    if (
      !['user', 'admin'].includes(role as string) ||
      !['active', 'disabled'].includes(status as string) ||
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 10000
    )
      throw new HttpError(400, '角色、状态或行程额度不正确。');
    this.db.exec('begin immediate');
    try {
      if (
        old.role === 'admin' &&
        old.status === 'active' &&
        (role !== 'admin' || status !== 'active')
      ) {
        const count = Number(
          (
            this.db
              .prepare(
                "select count(*) n from users where role='admin' and status='active'"
              )
              .get() as { n: number }
          ).n
        );
        if (count <= 1)
          throw new HttpError(409, '至少需要保留一个启用的管理员。');
      }
      this.db
        .prepare(
          'update users set role=?,status=?,itinerary_limit=? where id=?'
        )
        .run(role as string, status as string, limit, id);
      if (status === 'disabled' || role !== old.role)
        this.db.prepare('delete from auth_sessions where user_id=?').run(id);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
    return this.user(id)!;
  }
  async resetPassword(id: string, password: string) {
    const hash = await hashPassword(password);
    if (!this.user(id)) throw new HttpError(404, '没有找到用户。');
    this.db.exec('begin immediate');
    try {
      this.db
        .prepare('update users set password_hash=? where id=?')
        .run(hash, id);
      this.db.prepare('delete from auth_sessions where user_id=?').run(id);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    }
  }
}
function publicUser(row: UserRow): UserAccount {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    itineraryLimit: row.itinerary_limit,
    itineraryCount: row.itinerary_count,
    createdAt: row.created_at
  };
}
function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
