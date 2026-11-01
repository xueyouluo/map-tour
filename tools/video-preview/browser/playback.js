// Keep the active leg legible while retaining the earlier days as context.
// Values depend only on the film time, so scrubbing and export match playback.
export function routeEmphasis(events, time, journeyEnd) {
  let active = 0;
  for (let i = 0; i < events.length; i++) if (time >= events[i].start) active = i;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  const smooth = (n) => { const p = clamp(n); return p * p * (3 - 2 * p); };
  const transition = smooth((time - events[active].start) / 0.65);
  const overview = smooth((time - journeyEnd) / 1.2);
  const strength = (index, focus) => index === focus ? 1
    : events[index].segment.dayIndex === events[focus].segment.dayIndex ? 0.68 : 0.28;
  return events.map((event, index) => {
    const from = strength(index, Math.max(0, active - 1));
    const to = strength(index, active);
    const opacity = (from + (to - from) * transition) * (1 - overview) + 0.92 * overview;
    const width = 3 + 5 * opacity;
    return { opacity, width, outlineOpacity: opacity * opacity,
      outlineWidth: width + 5 + 2 * opacity, active: index === active && overview < 0.5,
      guideOpacity: event.segment.dayIndex === events[active].segment.dayIndex ? 0.2 : 0.08 };
  });
}

// Bounded background loading: a slow or missing tile must not stop playback.
export function createAssetQueue({
  load,
  concurrency = 2,
  timeoutMs = 20000,
  retryDelayMs = 15000
}) {
  const pending = new Map();
  const failures = new Map();
  let active = 0;
  function pump() {
    while (active < concurrency) {
      const entry = [...pending.values()]
        .filter((item) => !item.started)
        .sort((a, b) => a.priority - b.priority)[0];
      if (!entry) return;
      entry.started = true;
      active++;
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('地图素材加载超时，请重试或使用后台制作。'));
        }, timeoutMs);
      });
      Promise.race([
        Promise.resolve().then(() => load(entry.key, controller.signal)),
        timeout
      ]).then(
        (value) => {
          failures.delete(entry.key);
          entry.resolve(value);
        },
        (error) => {
          failures.set(entry.key, { at: Date.now(), error });
          entry.reject(error);
        }
      ).finally(() => {
        clearTimeout(timer);
        pending.delete(entry.key);
        active--;
        pump();
      });
    }
  }
  return {
    request(key, priority = 0, retry = false) {
      const existing = pending.get(key);
      if (existing) {
        existing.priority = priority;
        return existing.promise;
      }
      const failure = failures.get(key);
      if (!retry && failure && Date.now() - failure.at < retryDelayMs)
        return Promise.reject(failure.error);
      const entry = { key, priority, started: false };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      pending.set(key, entry);
      pump();
      return entry.promise;
    },
    retain(keys) {
      const wanted = new Set(keys);
      for (const [key, entry] of pending)
        if (!entry.started && !wanted.has(key)) {
          pending.delete(key);
          entry.reject(new Error('镜头已移动，跳过离屏素材。'));
        }
    },
    stats: () => ({ active, queued: pending.size - active, failed: failures.size })
  };
}

export function previewSize(width, height) {
  const scale = Math.min(1, 540 / width, 960 / height);
  return [Math.round(width * scale), Math.round(height * scale)];
}

// Deterministic placement keeps labels clear of models without seek history.
export function placeSceneLabel(anchor, size, { bounds, avoid = [], preferred, gap = 18 }) {
  const { width, height } = size;
  const candidates = [preferred || { x: anchor.x + 27, y: anchor.y - height - 27 }];
  for (const obstacle of avoid) {
    const cx = obstacle.x + obstacle.width / 2, cy = obstacle.y + obstacle.height / 2;
    candidates.push(
      { x: obstacle.x + obstacle.width + gap, y: cy - height / 2 },
      { x: obstacle.x - width - gap, y: cy - height / 2 },
      { x: cx - width / 2, y: obstacle.y - height - gap },
      { x: cx - width / 2, y: obstacle.y + obstacle.height + gap }
    );
  }
  let best, bestScore = Infinity;
  for (const candidate of candidates) {
    const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, candidate.x));
    const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, candidate.y));
    const overlap = avoid.reduce((total, obstacle) => total +
      Math.max(0, Math.min(x + width, obstacle.x + obstacle.width + gap) - Math.max(x, obstacle.x - gap)) *
      Math.max(0, Math.min(y + height, obstacle.y + obstacle.height + gap) - Math.max(y, obstacle.y - gap)), 0);
    const score = overlap * 1e6 + Math.hypot(x + width / 2 - anchor.x, y + height / 2 - anchor.y);
    if (score < bestScore) { best = { x, y, width, height }; bestScore = score; }
  }
  return best;
}
