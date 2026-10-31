// Only public map/elevation imagery is cached here; no itinerary or credentials.
const CACHE = 'map-tour-public-imagery-v1';
const MAX_BYTES = 160 * 1024 * 1024;
let writes: Promise<unknown> = Promise.resolve();
function cacheUrl(key: string) {
  return new URL('/__local_map_cache__/' + encodeURIComponent(key), location.origin).href;
}
export async function readCachedImage(key: string): Promise<Blob | undefined> {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(cacheUrl(key));
    if (hit && Date.now() - Number(hit.headers.get('x-created')) < 7 * 86400000)
      return await hit.blob();
  } catch { /* Disabled storage must not prevent preview or export. */ }
}
export async function cachedImage(key: string, produce: () => Promise<Blob>): Promise<Blob> {
  const hit = await readCachedImage(key);
  if (hit) return hit;
  const url = cacheUrl(key);
  let cache: Cache | undefined;
  try { cache = await caches.open(CACHE); } catch { /* Continue without persistence. */ }
  const blob = await produce();
  if (cache) {
    const target = cache;
    writes = writes.catch(() => {}).then(async () => {
      // Serialize writes/pruning so concurrent downloads cannot exceed the budget.
      const keys = await target.keys();
      let total = blob.size;
      const entries = [];
      for (const request of keys) {
        const response = await target.match(request);
        const bytes = Number(response?.headers.get('x-bytes')) || 0;
        total += bytes;
        entries.push({ request, bytes });
      }
      for (const entry of entries) {
        if (total <= MAX_BYTES) break;
        await target.delete(entry.request);
        total -= entry.bytes;
      }
      await target.put(url, new Response(blob, { headers: {
        'content-type': blob.type, 'x-bytes': String(blob.size), 'x-created': String(Date.now())
      } }));
    }).catch(() => {});
  }
  return blob;
}
