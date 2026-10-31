import { afterEach, expect, it, vi } from 'vitest';
import { BrowserExportError, createExportWatchdog } from './browserExport';

afterEach(() => vi.useRealTimers());

it('allows a background download to continue and resets the deadline on progress or visibility changes', async () => {
  vi.useFakeTimers();
  const timeout = vi.fn();
  let hidden = false;
  const watchdog = createExportWatchdog(timeout, () => hidden, 90, 300);
  watchdog.touch();
  await vi.advanceTimersByTimeAsync(50);
  hidden = true;
  watchdog.touch();
  await vi.advanceTimersByTimeAsync(200);
  expect(timeout).not.toHaveBeenCalled();
  watchdog.touch();
  await vi.advanceTimersByTimeAsync(299);
  expect(timeout).not.toHaveBeenCalled();
  hidden = false;
  watchdog.touch();
  await vi.advanceTimersByTimeAsync(91);
  expect(timeout).toHaveBeenCalledTimes(1);
  watchdog.stop();
});

it('does not time out a completed or cancelled export', async () => {
  vi.useFakeTimers();
  const timeout = vi.fn();
  const watchdog = createExportWatchdog(timeout, () => false, 90, 300);
  watchdog.touch();
  watchdog.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(timeout).not.toHaveBeenCalled();
});

it('retains the failed stage and cause while explaining actionable network and codec errors', () => {
  const cause = new TypeError('Failed to fetch');
  const download = new BrowserExportError('下载配乐', cause);
  expect(download.message).toContain('下载配乐未完成：网络下载中断');
  expect(download.cause).toBe(cause);
  expect(new BrowserExportError('编码第 5/2355 帧', new Error('EncodingError')).message)
    .toContain('编码第 5/2355 帧未完成：浏览器编码失败');
  expect(new BrowserExportError('检查成片文件', new Error('超时')).message)
    .toContain('本机处理超时');
});
