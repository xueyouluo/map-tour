import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireMapCacheLease, mapCachePolicy, mapCacheReport, recordMapCacheCleanup, pruneMapCache, withMapCacheLease } from './cache.mjs';
import { prepareTerrain } from './assets.mjs';

const roots = [], children = [];
const DAY = 86400000, now = Date.now();
function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-cache-test-'));
  roots.push(directory); return directory;
}
function tile(cache, id, age = 0, size = 40) {
  const dir = path.join(cache, 'satellite'); fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.alloc(size, id);
  const file = path.join(dir, createHash('sha256').update(String(id)).digest('hex') + '.jpg');
  fs.writeFileSync(file, data);
  fs.writeFileSync(file + '.json', JSON.stringify({ sha256: createHash('sha256').update(data).digest('hex'), source: 'AMap JS SDK Satellite layer' }));
  const at = new Date(now - age); fs.utimesSync(file, at, at);
  return { file, bytes: data.length + fs.statSync(file + '.json').size };
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('expires only recognized public cache pairs and preserves jobs, music, databases and unknown files', () => {
  const dir = root(), cache = path.join(dir, 'cache');
  const old = tile(cache, 'old', 8 * DAY), fresh = tile(cache, 'fresh', DAY);
  const originals = ['jobs/preview.mp4', 'uploads/music.wav', 'map-tour.sqlite', 'itinerary.json', 'satellite/private.jpg', 'dem/user.png'];
  for (const name of originals) {
    const file = path.join(cache, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'protected');
  }
  const result = pruneMapCache(cache, { ttlMs: 7 * DAY, maxBytes: 100000 }, now);
  expect(result).toMatchObject({ status: 'completed', deletedEntries: 1, freedBytes: old.bytes, remainingBytes: fresh.bytes });
  expect(fs.existsSync(old.file)).toBe(false); expect(fs.existsSync(old.file + '.json')).toBe(false);
  expect(fs.existsSync(fresh.file)).toBe(true);
  for (const name of originals) expect(fs.readFileSync(path.join(cache, name), 'utf8')).toBe('protected');
});
it('evicts least recently used entries until both image and sidecar bytes fit the capacity limit', () => {
  const cache = root();
  const oldest = tile(cache, 'oldest', 3 * DAY), middle = tile(cache, 'middle', 2 * DAY), newest = tile(cache, 'newest', DAY);
  const result = pruneMapCache(cache, { ttlMs: 7 * DAY, maxBytes: middle.bytes + newest.bytes }, now);
  expect(result).toMatchObject({ deletedEntries: 1, remainingBytes: middle.bytes + newest.bytes });
  expect(fs.existsSync(oldest.file)).toBe(false);
  expect(fs.existsSync(newest.file)).toBe(true);
});
it('protects every read phase until all overlapping leases have been released', () => {
  const cache = root(), old = tile(cache, 'old', 8 * DAY);
  const releaseOne = acquireMapCacheLease(cache), releaseTwo = acquireMapCacheLease(cache);
  expect(pruneMapCache(cache)).toMatchObject({ status: 'skipped', reason: 'active_reader' });
  releaseOne(); releaseOne();
  expect(pruneMapCache(cache)).toMatchObject({ status: 'skipped', reason: 'active_reader' });
  expect(fs.existsSync(old.file)).toBe(true);
  releaseTwo();
  expect(pruneMapCache(cache).deletedEntries).toBe(1);
});
it('coordinates leases across real processes and recovers a crashed reader without trusting lease timeouts', async () => {
  const cache = root(), old = tile(cache, 'old', 8 * DAY);
  const module = fileURLToPath(new URL('./cache.mjs', import.meta.url));
  const script = `import {acquireMapCacheLease} from ${JSON.stringify(pathToFileURL(module).href)};acquireMapCacheLease(process.env.CACHE_FIXTURE);process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, CACHE_FIXTURE: cache } });
  children.push(child);
  let output = ''; child.stdout.on('data', data => { output += data; });
  await vi.waitFor(() => expect(output).toContain('ready'), { timeout: 5000 });
  expect(pruneMapCache(cache)).toMatchObject({ status: 'skipped', reason: 'active_reader' });
  expect(fs.existsSync(old.file)).toBe(true);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  expect(pruneMapCache(cache)).toMatchObject({ status: 'completed', deletedEntries: 1 });
});
it('leaves legacy and unknown writer locks intact and retries cleanup once their owner removes them', () => {
  const cache = root(), old = tile(cache, 'old', 8 * DAY), lock = old.file + '.lock';
  fs.writeFileSync(lock, 'another transaction');
  expect(pruneMapCache(cache)).toMatchObject({ status: 'skipped', reason: 'entry_lock' });
  expect(fs.readFileSync(lock, 'utf8')).toBe('another transaction');
  expect(fs.existsSync(old.file)).toBe(true);
  fs.unlinkSync(lock);
  expect(pruneMapCache(cache).deletedEntries).toBe(1);
});
it('does not follow symlinked namespaces, tiles or sidecars outside the cache', () => {
  const dir = root(), cache = path.join(dir, 'cache'), outside = path.join(dir, 'user-data');
  const external = tile(outside, 'external', 8 * DAY);
  fs.mkdirSync(cache); fs.symlinkSync(path.join(outside, 'satellite'), path.join(cache, 'satellite'), 'dir');
  expect(pruneMapCache(cache).deletedEntries).toBe(0);
  expect(fs.existsSync(external.file)).toBe(true);
  fs.unlinkSync(path.join(cache, 'satellite')); fs.mkdirSync(path.join(cache, 'satellite'));
  const target = path.join(cache, 'satellite', path.basename(external.file));
  fs.symlinkSync(external.file, target); fs.symlinkSync(external.file + '.json', target + '.json');
  expect(pruneMapCache(cache).deletedEntries).toBe(0);
  expect(fs.existsSync(external.file)).toBe(true);
});
it('rejects a foreign or dangling coordinator instead of writing through it', () => {
  const cache = root(), coordinator = path.join(cache, '.map-tour-cache.sqlite');
  const db = new DatabaseSync(coordinator); db.exec('CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES (\'keep\')'); db.close();
  expect(() => pruneMapCache(cache)).toThrow('不属于当前应用');
  const check = new DatabaseSync(coordinator); expect(check.prepare('SELECT value FROM private_data').get().value).toBe('keep'); check.close();
  fs.unlinkSync(coordinator);
  const outside = path.join(root(), 'must-not-create.sqlite'); fs.symlinkSync(outside, coordinator);
  expect(() => pruneMapCache(cache)).toThrow('类型不正确'); expect(fs.existsSync(outside)).toBe(false);
});
it('leaves malformed, incomplete and unrecognized cached files alone', () => {
  const cache = root(), one = tile(cache, 'bad', 8 * DAY), two = tile(cache, 'partial', 8 * DAY);
  const privateFile = tile(cache, 'private', 8 * DAY);
  fs.writeFileSync(privateFile.file + '.json', JSON.stringify({ sha256: 'a'.repeat(64), source: 'user-upload' }));
  fs.writeFileSync(one.file + '.json', 'broken'); fs.unlinkSync(two.file + '.json');
  expect(pruneMapCache(cache)).toMatchObject({ deletedEntries: 0 });
  expect(fs.existsSync(one.file)).toBe(true); expect(fs.existsSync(two.file)).toBe(true); expect(fs.existsSync(privateFile.file)).toBe(true);
});
it('releases failed work without masking its error, then enforces the normal policy', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const cache = root(), old = tile(cache, 'old', 8 * DAY);
  await expect(withMapCacheLease(cache, async () => {
    expect(pruneMapCache(cache).reason).toBe('active_reader'); throw new Error('download failed');
  })).rejects.toThrow('download failed');
  expect(fs.existsSync(old.file)).toBe(false);
  expect(pruneMapCache(cache).status).toBe('completed');
});
it('protects DEM reads during actual terrain preparation and refreshes last-use timestamps on cache hits', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const cache = root(), output = root(), dem = path.join(cache, 'dem'); fs.mkdirSync(dem);
  const image = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < image.data.length; i += 4) { image.data[i] = 128; image.data[i + 3] = 255; }
  const data = PNG.sync.write(image), checksum = createHash('sha256').update(data).digest('hex');
  for (let x = 104; x <= 109; x++) for (let y = 50; y <= 55; y++) {
    const file = path.join(dem, `7-${x}-${y}.png`);
    fs.writeFileSync(file, data); fs.writeFileSync(file + '.json', JSON.stringify({ sha256: checksum, source: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/7/${x}/${y}.png` }));
    const old = new Date(now - 8 * DAY); fs.utimesSync(file, old, old);
  }
  const originalRead = fs.readFileSync;
  let protectedReads = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (typeof file === 'string' && file.startsWith(dem) && file.endsWith('.png')) {
      expect(pruneMapCache(cache).reason).toBe('active_reader'); protectedReads++;
    }
    return originalRead(file, ...args);
  });
  const result = await prepareTerrain({ layers: [{ id: 'test', center: [120.1, 30.2], zoom: 8, width: 256 }] }, output, cache, () => {});
  expect(result.tiles).toBeGreaterThan(0); expect(protectedReads).toBeGreaterThan(0);
  const remaining = fs.readdirSync(dem).filter(file => file.endsWith('.png'));
  expect(remaining.length).toBe(result.tiles);
  for (const file of remaining) expect(fs.statSync(path.join(dem, file)).mtimeMs).toBeGreaterThan(now - 60000);
  expect(JSON.parse(fs.readFileSync(path.join(output, 'terrain-data.json'), 'utf8')).layers).toHaveLength(1);
});
it('can evict a shared tile after copying it without changing a task-owned scene file', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const cache = root(), job = root(), old = tile(cache, 'old', 8 * DAY), output = path.join(job, 'atlas.jpg');
  const expected = fs.readFileSync(old.file);
  await withMapCacheLease(cache, async () => {
    fs.copyFileSync(old.file, output);
    expect(pruneMapCache(cache).reason).toBe('active_reader');
  });
  expect(fs.existsSync(old.file)).toBe(false);
  expect(fs.readFileSync(output)).toEqual(expected);
});
it('uses bounded configuration defaults and skips a missing cache without creating directories', () => {
  expect(mapCachePolicy({})).toEqual({ maxBytes: 512 * 1024 ** 2, ttlMs: 7 * DAY });
  expect(mapCachePolicy({ VIDEO_CACHE_MAX_MB: '256', VIDEO_CACHE_TTL_DAYS: '3' })).toEqual({ maxBytes: 256 * 1024 ** 2, ttlMs: 3 * DAY });
  expect(mapCachePolicy({ VIDEO_CACHE_MAX_MB: '-1', VIDEO_CACHE_TTL_DAYS: 'nonsense' })).toEqual(mapCachePolicy({}));
  const missing = path.join(root(), 'missing'); expect(pruneMapCache(missing).status).toBe('empty'); expect(fs.existsSync(missing)).toBe(false);
});

it('reports bytes and live protections without deleting files, refreshing hit times or creating state', () => {
  const dir = root(), missing = path.join(dir, 'missing');
  expect(mapCacheReport(missing)).toMatchObject({ usedBytes: 0, history: [], entries: 0 });
  expect(fs.existsSync(missing)).toBe(false);
  const old = tile(dir, 'old-report', 8 * DAY);
  const other = path.join(dir, 'satellite', 'unknown.tmp'); fs.writeFileSync(other, 'retain');
  const before = fs.statSync(old.file).mtimeMs;
  expect(mapCacheReport(dir)).toMatchObject({ managedBytes: old.bytes, otherBytes: 6, usedBytes: old.bytes + 6, history: [] });
  expect(fs.existsSync(path.join(dir, '.map-tour-cache.sqlite'))).toBe(false);
  const release = acquireMapCacheLease(dir);
  try {
    fs.writeFileSync(path.join(dir, 'satellite', 'writer.lock'), 'locked');
    const report = mapCacheReport(dir);
    expect(report).toMatchObject({ activeReaders: 1, writeLocks: 1, entries: 1 });
    expect(report.usedBytes).toBe(old.bytes + 12 + report.coordinationBytes);
    expect(report.namespaces).toEqual([{ name: 'satellite', entries: 1, bytes: old.bytes + 12 }]);
    expect(fs.statSync(old.file).mtimeMs).toBe(before);
    expect(mapCacheReport(dir)).toEqual({ ...report, checkedAt: expect.any(String) });
    expect(fs.existsSync(old.file)).toBe(true);
  } finally { release(); }
});
it('persists bounded cleanup history across instances and records skipped and failed cleanup attempts', () => {
  const dir = root(), old = tile(dir, 'old-history', 8 * DAY);
  pruneMapCache(dir, mapCachePolicy(), now);
  expect(mapCacheReport(dir).history[0]).toMatchObject({ at: new Date(now).toISOString(), deletedEntries: 1, freedBytes: old.bytes, status: 'completed' });
  const release = acquireMapCacheLease(dir);
  try {
    pruneMapCache(dir, mapCachePolicy(), now + 1);
    expect(mapCacheReport(dir).history[0]).toMatchObject({ status: 'skipped', reason: 'active_reader' });
  } finally { release(); }
  tile(dir, 'failure', 8 * DAY);
  const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('simulated disk failure'); });
  expect(() => pruneMapCache(dir)).toThrow('simulated disk failure'); unlink.mockRestore();
  expect(mapCacheReport(dir).history[0]).toMatchObject({ status: 'failed', reason: 'maintenance_error' });
  for (let i = 0; i < 60; i++) recordMapCacheCleanup(dir, { ...mapCachePolicy(), status: 'skipped', reason: 'active_task', freedBytes: 0, deletedEntries: 0 }, now + i + 2);
  const report = mapCacheReport(dir);
  expect(report.history).toHaveLength(50);
  expect(report.history[0]).toMatchObject({ at: new Date(now + 61).toISOString(), reason: 'active_task' });
  expect(report.history.at(-1).at).toBe(new Date(now + 12).toISOString());
});
it('reads old coordinator schemas without migrating them and never follows report symlinks', () => {
  const dir = root(), release = acquireMapCacheLease(dir); release();
  const state = path.join(dir, '.map-tour-cache.sqlite');
  const db = new DatabaseSync(state); db.exec('DROP TABLE cleanup_history'); db.close();
  const before = fs.readFileSync(state);
  const target = root(), user = path.join(target, 'user.mp4'); fs.writeFileSync(user, 'user video');
  fs.symlinkSync(target, path.join(dir, 'satellite'));
  expect(mapCacheReport(dir)).toMatchObject({ entries: 0, otherBytes: 0, history: [] });
  expect(fs.readFileSync(state)).toEqual(before);
  expect(fs.readFileSync(user, 'utf8')).toBe('user video');
  fs.unlinkSync(state); fs.symlinkSync(user, state);
  expect(() => mapCacheReport(dir)).toThrow();
  expect(fs.readFileSync(user, 'utf8')).toBe('user video');
});
