import { afterEach, expect, it, vi } from 'vitest';
import { prepareImportImage } from './browserImportImage';

afterEach(() => vi.unstubAllGlobals());

it('compresses a screenshot at its original dimensions, fills transparency and releases pixel buffers', async () => {
  const file = new File([new Uint8Array(1024 * 1024)], '行程.png', { type: 'image/png' });
  const bitmap = { width: 1440, height: 5600, close: vi.fn() };
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: vi.fn((callback, type) => {
    expect([canvas.width, canvas.height]).toEqual([1440, 5600]);
    callback(new Blob([new Uint8Array(10000)], { type }));
  }) };
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
  vi.stubGlobal('document', { createElement: () => canvas });
  const result = await prepareImportImage(file);
  expect(result.name).toBe('行程.jpg');
  expect(result.size).toBe(10000);
  expect(context.fillStyle).toBe('#fff');
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
  expect(bitmap.close).toHaveBeenCalledOnce();
  expect(canvas.width).toBe(1);
});

it('keeps small, very large or unsupported screenshots without lossy resizing', async () => {
  const decode = vi.fn().mockResolvedValue({ width: 4000, height: 8000, close: vi.fn() });
  vi.stubGlobal('createImageBitmap', decode);
  for (const file of [
    new File(['small'], 'small.png', { type: 'image/png' }),
    new File([new Uint8Array(1024 * 1024)], 'large.png', { type: 'image/png' }),
    new File([new Uint8Array(1024 * 1024)], 'moving.gif', { type: 'image/gif' })
  ]) expect(await prepareImportImage(file)).toBe(file);
  expect(decode).toHaveBeenCalledOnce();
});

it('falls back to the original if decoding fails or encoding does not reduce traffic', async () => {
  const file = new File([new Uint8Array(1024 * 1024)], 'shot.png', { type: 'image/png' });
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')));
  expect(await prepareImportImage(file)).toBe(file);
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 1000, close: vi.fn() }));
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (callback: (blob: Blob) => void) => callback(file) }) });
  expect(await prepareImportImage(file)).toBe(file);
});
