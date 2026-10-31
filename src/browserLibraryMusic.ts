// Only shared built-in tracks belong here. User uploads remain in IndexedDB.
const CACHE = 'map-tour-library-music-v1';
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_AGE = 7 * 86400000;
let writes: Promise<unknown> = Promise.resolve();

export async function loadLibraryMusic(
  sourceUrl: string,
  status: (text: string) => void = () => {},
  signal?: AbortSignal
): Promise<Blob> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  // This lightweight request checks owner/expiry before reading local audio.
  const source = await fetch(sourceUrl, { signal, cache: 'no-store' });
  if (!source.ok) throw new Error('配乐权限已过期，请重新打开预览。');
  const { url, sha256 } = await source.json();
  const target = new URL(url, location.origin);
  if (!/^[a-f0-9]{64}$/.test(sha256) ||
    (target.origin !== location.origin && target.protocol !== 'https:') || target.username || target.password)
    throw new Error('配乐下载信息不正确。');
  const key = new URL('/__local_music_cache__/' + sha256, location.origin).href;
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit && Date.now() - Number(hit.headers.get('x-created')) < MAX_AGE) {
      status('复用本机已下载的配乐');
      return await hit.blob();
    }
  } catch { /* Storage is optional. */ }
  status('浏览器下载配乐');
  const response = await fetch(target.href, { signal });
  if (!response.ok) throw new Error('配乐下载失败，请检查网络后重试。');
  const total = Number(response.headers.get('content-length'));
  if (total > MAX_FILE_BYTES) throw new Error('配乐文件超过 25 MB。');
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_FILE_BYTES) throw new Error('配乐文件超过 25 MB。');
        chunks.push(value);
        status(total > 0 ? `浏览器下载配乐 ${Math.min(100, Math.round(received * 100 / total))}%` : `浏览器下载配乐 ${(received / 1048576).toFixed(1)} MB`);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) throw new Error('配乐文件超过 25 MB。');
    chunks.push(bytes);
  }
  const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
  // Hash on the client so the persistent cache identifies the exact audio bytes.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== sha256)
    throw new Error('配乐校验失败，请重新下载。');
  if (cache) {
    const destination = cache;
    writes = writes.catch(() => {}).then(async () => {
      let total = blob.size;
      const entries = [];
      for (const request of await destination.keys()) {
        const entry = await destination.match(request);
        if (request.url === key || Date.now() - Number(entry?.headers.get('x-created')) >= MAX_AGE) {
          await destination.delete(request);
          continue;
        }
        const bytes = Number(entry?.headers.get('x-bytes')) || 0;
        total += bytes;
        entries.push({ request, bytes });
      }
      for (const entry of entries) {
        if (total <= MAX_BYTES) break;
        await destination.delete(entry.request);
        total -= entry.bytes;
      }
      await destination.put(key, new Response(blob, { headers: {
        'content-type': 'audio/mpeg', 'x-created': String(Date.now()), 'x-bytes': String(blob.size)
      } }));
    }).catch(() => {});
    await writes;
  }
  return blob;
}
