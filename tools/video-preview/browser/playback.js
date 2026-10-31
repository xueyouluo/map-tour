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
