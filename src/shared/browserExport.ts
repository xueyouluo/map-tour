export class BrowserExportError extends Error {
  constructor(public readonly stage: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : '未知错误';
    const reason = /fetch|network|load failed|加载失败/i.test(detail)
      ? '网络下载中断，请检查网络后重试。'
      : /超时|timeout/i.test(detail)
        ? /下载|地图|渲染/.test(stage)
          ? '素材等待超时，请检查网络后重试。'
          : '本机处理超时，请返回此页后重试。'
        : /encode|encoding|codec/i.test(detail)
          ? '浏览器编码失败，可以重试或更换浏览器。'
          : detail;
    super(`${stage}未完成：${reason}`, { cause });
    this.name = 'BrowserExportError';
  }
}

export function createExportWatchdog(
  timeout: () => void,
  hidden: () => boolean,
  visibleMs = 90000,
  hiddenMs = 300000
) {
  let timer: ReturnType<typeof setTimeout>;
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(timeout, hidden() ? hiddenMs : visibleMs);
    },
    stop() { clearTimeout(timer); }
  };
}

// Timer-based yields are heavily throttled in background tabs. Encoding does
// not depend on animation frames and can continue using the task scheduler.
export function yieldBrowserWork(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
