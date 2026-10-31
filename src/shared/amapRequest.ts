export interface AmapResult {
  status: string;
  data: any;
}

export const AMAP_REQUEST_TIMEOUT_MS = 12000;

// The SDK can finish its JSONP request without ever invoking its callback.
// Settle exactly once; ignore callbacks from a request that already timed out.
export function requestAmapResult(
  start: (finish: (status: string, data: any) => void) => void,
  timeoutMs = AMAP_REQUEST_TIMEOUT_MS
): Promise<AmapResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: string, data: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, data });
    };
    const timer = setTimeout(() => finish('timeout', {
      info: `地图请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应，请稍后重新搜索`,
      infocode: 'REQUEST_TIMEOUT'
    }), timeoutMs);
    try { start(finish); }
    catch (error) {
      finish('error', { info: error instanceof Error ? error.message : '地图查询失败', infocode: 'SDK_ERROR' });
    }
  });
}
