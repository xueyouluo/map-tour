import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { MusicLibrary } from './musicLibrary';

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
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
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
