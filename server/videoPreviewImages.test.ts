import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createPreviewImageCache } from './videoPreviewImages';

it('shares conversions, publishes atomically and reuses the small file without changing originals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-images-'));
  const source = path.join(root, 'atlas.jpg');
  fs.writeFileSync(source, 'immutable original');
  let count = 0;
  const preview = createPreviewImageCache(async (_source, temporary) => {
    count++;
    expect(fs.existsSync(path.join(root, 'preview-v1-atlas.jpg'))).toBe(false);
    fs.writeFileSync(temporary, 'small image');
  });
  try {
    const a = preview(source), b = preview(source);
    expect(a).toBe(b);
    const target = await a;
    expect(await preview(source)).toBe(target);
    expect(count).toBe(1);
    expect(fs.readFileSync(source, 'utf8')).toBe('immutable original');
    expect(fs.readFileSync(target, 'utf8')).toBe('small image');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('serializes image work, cleans failures and permits a failed conversion to retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-images-'));
  let active = 0, maximum = 0, count = 0;
  const preview = createPreviewImageCache(async (_source, target) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      fs.writeFileSync(target, 'partial');
      if (++count === 1) throw new Error('conversion failed');
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally { active--; }
  });
  try {
    const a = preview(path.join(root, 'a.jpg')).catch((error) => error);
    const b = preview(path.join(root, 'b.jpg'));
    expect((await a).message).toBe('conversion failed');
    await b;
    await preview(path.join(root, 'a.jpg'));
    expect(maximum).toBe(1);
    expect(fs.readdirSync(root).sort()).toEqual(['preview-v1-a.jpg', 'preview-v1-b.jpg']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
