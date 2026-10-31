import { afterEach, expect, it, vi } from 'vitest';
import { createAssetQueue, previewSize } from './playback.js';

afterEach(() => vi.useRealTimers());

it('bounds concurrent requests, shares in-flight loads and prioritizes nearby tiles', async () => {
  const starts = [];
  const releases = new Map();
  const loader = createAssetQueue({
    concurrency: 1,
    load: (key) => new Promise((resolve) => {
      starts.push(key);
      releases.set(key, resolve);
    })
  });
  const first = loader.request('current');
  expect(loader.request('current')).toBe(first);
  const far = loader.request('far', 100);
  const near = loader.request('near', 1);
  await vi.waitFor(() => expect(starts).toEqual(['current']));
  releases.get('current')();
  await vi.waitFor(() => expect(starts).toEqual(['current', 'near']));
  releases.get('near')();
  await vi.waitFor(() => expect(starts).toEqual(['current', 'near', 'far']));
  releases.get('far')();
  await Promise.all([first, far, near]);
});

it('times out a hung download, aborts it and lets following requests complete', async () => {
  vi.useFakeTimers();
  let signal;
  const loader = createAssetQueue({
    concurrency: 1,
    timeoutMs: 100,
    load: (key, cancellation) => {
      if (key === 'hung') {
        signal = cancellation;
        return new Promise(() => {});
      }
      return Promise.resolve('loaded');
    }
  });
  const stuck = loader.request('hung').catch((error) => error);
  const next = loader.request('next');
  await vi.advanceTimersByTimeAsync(101);
  expect((await stuck).message).toContain('超时');
  expect(signal.aborted).toBe(true);
  await expect(next).resolves.toBe('loaded');
});

it('backs off failed preview loads but permits an explicit export retry', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce('recovered');
  const loader = createAssetQueue({ load });
  await expect(loader.request('tile')).rejects.toThrow('offline');
  await Promise.resolve();
  await expect(loader.request('tile')).rejects.toThrow('offline');
  expect(load).toHaveBeenCalledTimes(1);
  await expect(loader.request('tile', 0, true)).resolves.toBe('recovered');
});

it('drops obsolete queued work without aborting the visible download', async () => {
  let release;
  const load = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  const loader = createAssetQueue({ concurrency: 1, load });
  const visible = loader.request('visible');
  const obsolete = loader.request('obsolete').catch((error) => error);
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  loader.retain(['visible']);
  expect((await obsolete).message).toContain('离屏');
  release();
  await visible;
  expect(load).toHaveBeenCalledTimes(1);
});

it('uses one quarter of the export pixels for portrait preview without upscaling', () => {
  expect(previewSize(1080, 1920)).toEqual([540, 960]);
  expect(previewSize(270, 480)).toEqual([270, 480]);
  expect(previewSize(1920, 1080)).toEqual([540, 304]);
});
