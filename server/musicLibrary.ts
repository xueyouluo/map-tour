import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { VideoMusicTrack } from '../src/shared/videoExport';
import { projectRoot } from '../tools/video-preview/runtime.mjs';

interface MusicAsset extends Omit<VideoMusicTrack, 'previewUrl'> {
  file: string;
  previewFile: string;
  sha256: string;
}

export class MusicLibrary {
  constructor(
    public readonly root = path.resolve(
      process.env.VIDEO_MUSIC_DIR || path.join(projectRoot, 'assets/music')
    )
  ) {}

  private assets(): MusicAsset[] {
    const manifest = path.join(this.root, 'catalog.json');
    if (!fs.existsSync(manifest)) return [];
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.tracks))
      throw new Error('内置音乐目录格式不正确。');
    const seen = new Set<string>();
    for (const track of data.tracks) {
      if (
        !track ||
        !/^[a-z0-9-]{1,80}$/.test(track.id) ||
        seen.has(track.id) ||
        !/^[a-f0-9]{64}\.mp3$/.test(track.file) ||
        !/^[a-f0-9]{64}-preview\.mp3$/.test(track.previewFile) ||
        !/^[a-f0-9]{64}$/.test(track.sha256) ||
        !Number.isFinite(track.duration) ||
        track.duration < 5 ||
        !['title', 'version', 'mood'].every(
          (key) => typeof track[key] === 'string' && track[key].length <= 120
        )
      ) {
        throw new Error('内置音乐目录包含无效条目。');
      }
      seen.add(track.id);
    }
    return data.tracks;
  }

  list(): VideoMusicTrack[] {
    return this.assets()
      .filter(
        (track) =>
          fs.existsSync(path.join(this.root, track.file)) &&
          fs.existsSync(path.join(this.root, track.previewFile))
      )
      .map(({ id, title, version, mood, duration }) => ({
        id,
        title,
        version,
        mood,
        duration,
        previewUrl: `/api/video/music/${id}/preview`
      }));
  }

  get(id: string) {
    const track = this.assets().find((track) => track.id === id);
    if (!track) return null;
    const file = path.join(this.root, track.file),
      previewFile = path.join(this.root, track.previewFile);
    if (!fs.existsSync(file) || !fs.existsSync(previewFile)) return null;
    // Track fingerprints must identify the exact bytes used by both renderers.
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
    if (sha256 !== track.sha256)
      throw new Error('内置音乐文件校验失败，请重新导入。');
    return { ...track, file, previewFile, sha256 };
  }
}
