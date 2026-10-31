import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MusicLibrary, musicCdnUrl } from './musicLibrary';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-music-'));
  roots.push(root);
  const bytes = Buffer.from('fixture audio'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const track = {
    id: 'sunny-a',
    title: '晴天出发',
    version: 'A',
    mood: '轻快',
    duration: 200,
    file: `${sha256}.mp3`,
    previewFile: `${sha256}-preview.mp3`,
    sha256,
    sourceName: 'private-source.mp3'
  };
  fs.writeFileSync(path.join(root, track.file), bytes);
  fs.writeFileSync(path.join(root, track.previewFile), bytes);
  const save = (tracks: unknown[]) =>
    fs.writeFileSync(
      path.join(root, 'catalog.json'),
      JSON.stringify({ version: 1, tracks })
    );
  save([track]);
  return { root, track, save, library: new MusicLibrary(root) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

it('reuses verified immutable audio without rereading it on each request and detects replacements', () => {
  const { library, root, track } = fixture();
  const file = path.join(root, track.file);
  const read = vi.spyOn(fs, 'readFileSync');
  library.get(track.id);
  library.get(track.id);
  expect(read.mock.calls.filter(([name]) => name === file)).toHaveLength(1);
  const replacement = file + '.tmp';
  fs.writeFileSync(replacement, Buffer.alloc(fs.statSync(file).size));
  fs.renameSync(replacement, file);
  expect(() => library.get(track.id)).toThrow('校验失败');
});

it('publishes only playback metadata and verifies the exact audio bytes', () => {
  const { library, root, track } = fixture();
  expect(library.list()).toEqual([
    {
      id: track.id,
      title: track.title,
      version: 'A',
      mood: '轻快',
      duration: 200,
      previewUrl: '/api/video/music/sunny-a/preview'
    }
  ]);
  expect(library.get('sunny-a')?.file).toBe(path.join(root, track.file));
  expect(library.get('../../etc/passwd')).toBeNull();
  fs.writeFileSync(path.join(root, track.file), 'changed audio');
  expect(() => library.get('sunny-a')).toThrow('校验失败');
});

it('rejects file traversal, duplicate identities and invalid catalog data', () => {
  const { library, track, save } = fixture();
  for (const changed of [
    { file: '../secret.mp3' },
    { previewFile: '/private/secret.mp3' },
    { duration: -1 },
    { sha256: 'bad' }
  ]) {
    save([{ ...track, ...changed }]);
    expect(() => library.list()).toThrow('无效条目');
  }
  save([track, track]);
  expect(() => library.list()).toThrow('无效条目');
});

it('supports an empty installation and omits unavailable files', () => {
  const { library, root, track } = fixture();
  fs.unlinkSync(path.join(root, track.previewFile));
  expect(library.list()).toEqual([]);
  expect(library.get(track.id)).toBeNull();
  fs.unlinkSync(path.join(root, 'catalog.json'));
  expect(library.list()).toEqual([]);
});

it('uses a configured HTTPS CDN directory directly and rejects unsafe configuration', () => {
  const { library, track } = fixture();
  vi.stubEnv('VIDEO_MUSIC_CDN_URL', 'https://cdn.example.com/map-tour/music');
  expect(library.list()[0].previewUrl).toBe('https://cdn.example.com/map-tour/music/' + track.previewFile);
  expect(library.get(track.id)?.audioUrl).toBe('https://cdn.example.com/map-tour/music/' + track.file);
  for (const value of ['http://cdn.example.com', 'https://user:password@cdn.example.com', 'https://cdn.example.com/?token=private']) {
    vi.stubEnv('VIDEO_MUSIC_CDN_URL', value);
    expect(() => musicCdnUrl(track.file)).toThrow('HTTPS 目录');
  }
});
