import { afterEach, expect, it, vi } from 'vitest';
import { createAssetQueue, previewSize, placeSceneLabel, routeEmphasis } from './playback.js';

afterEach(() => vi.useRealTimers());

it('keeps the current leg above daily context and older days, then reunites the route for the ending', () => {
  const events = [
    { start: 3, segment: { dayIndex: 1 } },
    { start: 7, segment: { dayIndex: 2 } },
    { start: 11, segment: { dayIndex: 2 } }
  ];
  const style = routeEmphasis(events, 12, 16);
  expect(style[2].opacity).toBeGreaterThan(style[1].opacity);
  expect(style[1].opacity).toBeGreaterThan(style[0].opacity);
  expect(style[2].width).toBeGreaterThan(style[0].width);
  expect(style.map((item) => item.active)).toEqual([false, false, true]);
  const ending = routeEmphasis(events, 18, 16);
  expect(new Set(ending.map((item) => item.opacity)).size).toBe(1);
  expect(ending.every((item) => !item.active)).toBe(true);
  // A day boundary fades continuously and an arbitrary seek reproduces its frame.
  const before = routeEmphasis(events, 7, 16);
  const after = routeEmphasis(events, 7.001, 16);
  expect(Math.abs(before[0].opacity - after[0].opacity)).toBeLessThan(0.001);
  expect(routeEmphasis(events, 12, 16)).toEqual(style);
});

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

it('allows slow browser map captures and starts their deadlines after queued tiles get a slot', async () => {
  vi.useFakeTimers();
  const starts = [];
  const loader = createAssetQueue({
    browserCapture: true,
    load: (key) => new Promise((resolve) => {
      starts.push(key);
      setTimeout(() => resolve(key), 24000);
    })
  });
  const result = Promise.all([loader.request('first'), loader.request('second'), loader.request('third')]);
  await vi.advanceTimersByTimeAsync(21000);
  expect(starts).toEqual(['first']);
  await vi.advanceTimersByTimeAsync(51000);
  await expect(result).resolves.toEqual(['first', 'second', 'third']);
});

it('still bounds a stuck browser capture and permits a later export retry', async () => {
  vi.useFakeTimers();
  let signal;
  const load = vi.fn((_key, cancellation) => {
    signal = cancellation;
    return new Promise(() => {});
  });
  const loader = createAssetQueue({ browserCapture: true, load });
  const failure = loader.request('tile').catch((error) => error);
  await vi.advanceTimersByTimeAsync(60001);
  expect((await failure).message).toContain('地图素材加载超时');
  expect(signal.aborted).toBe(true);
  load.mockResolvedValueOnce('recovered');
  await expect(loader.request('tile', 0, true)).resolves.toBe('recovered');
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

it('keeps destination and transport labels outside the model and within the film safe area', () => {
  const bounds = { x: 32, y: 350, width: 1016, height: 1190 };
  const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  for (const model of [
    { x: 390, y: 790, width: 300, height: 260 },
    { x: 40, y: 360, width: 260, height: 270 },
    { x: 770, y: 1200, width: 260, height: 290 }
  ]) {
    const anchor = { x: model.x + model.width / 2, y: model.y + model.height };
    const label = placeSceneLabel(anchor, { width: 360, height: 56 }, { bounds, avoid: [model] });
    const badge = placeSceneLabel(anchor, { width: 90, height: 64 }, { bounds, avoid: [model, label] });
    expect(intersects(model, label)).toBe(false);
    expect(intersects(model, badge)).toBe(false);
    expect(intersects(label, badge)).toBe(false);
    for (const item of [label, badge]) {
      expect(item.x).toBeGreaterThanOrEqual(bounds.x);
      expect(item.y).toBeGreaterThanOrEqual(bounds.y);
      expect(item.x + item.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(item.y + item.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
    expect(placeSceneLabel(anchor, { width: 360, height: 56 }, { bounds, avoid: [model] })).toEqual(label);
  }
});
