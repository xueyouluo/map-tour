import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadLibraryMusic } from './browserLibraryMusic';

const audio = new Blob(['complete fixture music'], { type: 'audio/mpeg' });
const sha256 = createHash('sha256').update('complete fixture music').digest('hex');
function setup() {
  const entries = new Map<string, Response>();
  const cache = {
    match: async (key: string | Request) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
    keys: async () => [...entries.keys()].map(key => new Request(key)),
    put: async (key: string, response: Response) => { entries.set(key, response); },
    delete: async (key: Request) => entries.delete(key.url)
  };
  const fetcher = vi.fn(async (url: string) => url.endsWith('-source')
    ? Response.json({ url: 'https://cdn.example.com/music.mp3', sha256 })
    : new Response(audio));
  vi.stubGlobal('location', { origin: 'https://tour.example.com' });
  vi.stubGlobal('caches', { open: async () => cache });
  vi.stubGlobal('fetch', fetcher);
  return { entries, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

it('downloads identical built-in music only once across scenes and still checks each scenes permission', async () => {
  const { fetcher } = setup();
  expect(await (await loadLibraryMusic('/job-one/audio-source')).text()).toBe(await audio.text());
  expect(await (await loadLibraryMusic('/job-two/audio-source')).text()).toBe(await audio.text());
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/job-one/audio-source', 'https://cdn.example.com/music.mp3', '/job-two/audio-source'
  ]);
  fetcher.mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(loadLibraryMusic('/other-owner/audio-source')).rejects.toThrow('权限');
});

it('does not cache corrupt downloads, retries expired entries, and works without browser storage', async () => {
  const { fetcher, entries } = setup();
  fetcher.mockResolvedValueOnce(Response.json({ url: 'https://cdn.example.com/music.mp3', sha256 }));
  fetcher.mockResolvedValueOnce(new Response('corrupted music'));
  await expect(loadLibraryMusic('/job/audio-source')).rejects.toThrow('校验失败');
  expect(entries.size).toBe(0);
  await loadLibraryMusic('/job/audio-source');
  const key = [...entries.keys()][0];
  entries.set(key, new Response(audio, { headers: { 'x-created': '0' } }));
  await loadLibraryMusic('/job/audio-source');
  expect(fetcher.mock.calls.filter(([url]) => url === 'https://cdn.example.com/music.mp3')).toHaveLength(3);
  vi.stubGlobal('caches', { open: async () => { throw new Error('disabled'); } });
  expect(await (await loadLibraryMusic('/job/audio-source')).text()).toBe(await audio.text());
});
