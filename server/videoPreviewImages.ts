import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runFile } from '../tools/video-preview/runtime.mjs';

export function createPreviewImageCache(
  render: (source: string, target: string) => Promise<void> = (source, target) =>
    runFile('ffmpeg', [
      '-v', 'error', '-lowres', '2', '-threads', '1', '-i', source,
      '-vf', 'scale=min(1024\\,iw):-2', '-frames:v', '1', '-q:v', '6',
      '-threads', '1', '-y', target
    ], { signal: AbortSignal.timeout(20000) })
) {
  const pending = new Map<string, Promise<string>>();
  let tail = Promise.resolve();
  return (source: string): Promise<string> => {
    // Originals are immutable job snapshots; derivatives expire with their job.
    const target = path.join(path.dirname(source), 'preview-v1-' + path.basename(source));
    if (fs.existsSync(target) && fs.statSync(target).size > 0)
      return Promise.resolve(target);
    const existing = pending.get(target);
    if (existing) return existing;
    const work = tail.then(async () => {
      const temporary = target + '.' + randomUUID() + '.jpg';
      try {
        await render(source, temporary);
        if (!fs.statSync(temporary).size) throw new Error('预览地图未生成');
        fs.renameSync(temporary, target);
        return target;
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    });
    pending.set(target, work);
    // One small conversion at a time; a failed image does not poison the queue.
    tail = work.then(() => {}, () => {});
    void work.finally(() => pending.delete(target)).catch(() => {});
    return work;
  };
}
