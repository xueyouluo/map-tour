import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86400000;
const APPLICATION_ID = 0x4d544343;
const STATE_FILE = '.map-tour-cache.sqlite';
const TOKEN = /^[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;

export function mapCachePolicy(env = process.env) {
  const setting = (value, fallback, min, max) => {
    const n = Number(value);
    return value !== undefined && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    maxBytes: Math.floor(setting(env.VIDEO_CACHE_MAX_MB, 512, 16, 4096) * 1024 ** 2),
    ttlMs: setting(env.VIDEO_CACHE_TTL_DAYS, 7, 1, 90) * DAY
  };
}

function regular(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() ? stat : undefined; }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}
function directory(root, create = false) {
  if (create) fs.mkdirSync(root, { recursive: true });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('地图缓存目录不能是符号链接');
  return fs.realpathSync(root);
}
function processStart(pid) {
  if (process.platform !== 'linux') return '';
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return ''; }
}
function alive(lease) {
  // Unknown ownership is protected, including malformed coordination records.
  if (!TOKEN.test(lease.token) || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) return true;
  try { process.kill(lease.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  const start = processStart(lease.pid);
  return !start || !lease.process_start || start === lease.process_start;
}
function transaction(root, work) {
  const file = path.join(root, STATE_FILE);
  try { if (!fs.lstatSync(file).isFile()) throw new Error('地图缓存协调文件类型不正确'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const id = db.prepare('PRAGMA application_id').get().application_id;
    if (id !== APPLICATION_ID) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (id !== 0 || tables.length) throw new Error('地图缓存协调文件不属于当前应用');
      db.exec(`PRAGMA application_id=${APPLICATION_ID};
        CREATE TABLE leases(token TEXT PRIMARY KEY,pid INTEGER NOT NULL,process_start TEXT NOT NULL);`);
    }
    const result = work(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* No transaction may have started. */ }
    throw error;
  } finally { db.close(); }
}

// A lease covers all cache reads, hashing and copies, not just cache writes.
// SQLite serializes lease registration with eviction and releases its mutex on crash.
export function acquireMapCacheLease(root) {
  root = directory(root, true);
  const token = randomUUID();
  transaction(root, db => db.prepare('INSERT INTO leases VALUES (?,?,?)').run(token, process.pid, processStart(process.pid)));
  let released = false;
  return () => {
    if (released) return;
    transaction(root, db => db.prepare('DELETE FROM leases WHERE token=? AND pid=?').run(token, process.pid));
    released = true;
  };
}
function reportFailure(error) {
  console.warn(JSON.stringify({ event: 'video.cache.cleanup_error', message: String(error?.message || error).slice(0, 400) }));
}
export async function withMapCacheLease(root, work, policy = mapCachePolicy()) {
  const release = acquireMapCacheLease(root);
  try { return await work(); }
  finally {
    try { release(); } catch (error) { reportFailure(error); }
    try {
      const result = pruneMapCache(root, policy);
      if (result.deletedEntries) console.info(JSON.stringify({ event: 'video.cache.cleanup', ...result }));
    } catch (error) { reportFailure(error); }
  }
}

function entries(root) {
  const files = [];
  let ignoredFiles = 0;
  for (const [name, pattern] of [['dem', /^\d+-\d+-\d+\.png$/], ['satellite', /^[a-f0-9]{64}\.jpg$/]]) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { ignoredFiles++; continue; }
    const names = fs.readdirSync(dir);
    // Even legacy writers and unknown locks are protected. Never reclaim their transaction.
    if (names.some(file => file.endsWith('.lock'))) return { locked: true };
    for (const file of names) {
      if (!pattern.test(file)) { if (!file.endsWith('.json')) ignoredFiles++; continue; }
      const target = path.join(dir, file), metadata = target + '.json';
      const dataStat = regular(target), metadataStat = regular(metadata);
      if (!dataStat || !metadataStat || metadataStat.size > 65536) { ignoredFiles++; continue; }
      try {
        const info = JSON.parse(fs.readFileSync(metadata, 'utf8'));
        const source = name === 'satellite' ? 'AMap JS SDK Satellite layer'
          : `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${file.slice(0, -4).split('-').join('/')}.png`;
        if (!SHA.test(info.sha256) || info.source !== source) { ignoredFiles++; continue; }
      } catch { ignoredFiles++; continue; }
      files.push({ target, metadata, dataStat, metadataStat, bytes: dataStat.size + metadataStat.size, usedAt: dataStat.mtimeMs });
    }
  }
  return { files, ignoredFiles };
}
function unchanged(file, stat) {
  const current = regular(file);
  return current && current.ino === stat.ino && current.size === stat.size && current.mtimeMs === stat.mtimeMs;
}

export function pruneMapCache(root, policy = mapCachePolicy(), now = Date.now()) {
  if (!Number.isFinite(policy.maxBytes) || policy.maxBytes < 0 || !Number.isFinite(policy.ttlMs) || policy.ttlMs <= 0)
    throw new Error('地图缓存清理参数不正确');
  const base = { deletedEntries: 0, freedBytes: 0, maxBytes: policy.maxBytes, ttlMs: policy.ttlMs };
  if (!fs.existsSync(root)) return { ...base, status: 'empty', remainingBytes: 0 };
  root = directory(root);
  return transaction(root, db => {
    const leases = db.prepare('SELECT * FROM leases').all();
    if (leases.some(alive)) return { ...base, status: 'skipped', reason: 'active_reader' };
    for (const lease of leases) db.prepare('DELETE FROM leases WHERE token=?').run(lease.token);
    const found = entries(root);
    if (found.locked) return { ...base, status: 'skipped', reason: 'entry_lock' };
    const files = found.files.sort((a, b) => a.usedAt - b.usedAt || a.target.localeCompare(b.target));
    let remainingBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    let deletedEntries = 0, freedBytes = 0, protectedEntries = 0;
    for (const file of files) {
      if (now - file.usedAt < policy.ttlMs && remainingBytes <= policy.maxBytes) continue;
      if (fs.existsSync(file.target + '.lock') || !unchanged(file.target, file.dataStat) || !unchanged(file.metadata, file.metadataStat)) {
        protectedEntries++; continue;
      }
      fs.unlinkSync(file.target);
      fs.unlinkSync(file.metadata);
      remainingBytes -= file.bytes; freedBytes += file.bytes; deletedEntries++;
    }
    return { ...base, status: remainingBytes > policy.maxBytes ? 'deferred' : 'completed',
      remainingBytes, deletedEntries, freedBytes, protectedEntries, ignoredFiles: found.ignoredFiles };
  });
}
