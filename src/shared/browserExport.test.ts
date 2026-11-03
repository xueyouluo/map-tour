import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
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

it('preserves errors from the iframe realm instead of replacing them with an unknown error', () => {
  const cause = runInNewContext('new Error("高德卫星图加载超时，请检查网络后重试。")');
  expect(cause).not.toBeInstanceOf(Error);
  const error = new BrowserExportError('渲染第 395/1185 帧', cause);
  expect(error.message).toContain('渲染第 395/1185 帧未完成：素材等待超时');
  expect(error.cause).toBe(cause);
  expect(new BrowserExportError('渲染第 395/1185 帧',
    runInNewContext('new Error("地图坐标对齐失败，请重新加载预览。")')).message)
    .toContain('地图坐标对齐失败');
});

it('recognizes named browser exceptions and string rejections', () => {
  expect(new BrowserExportError('编码第 5/1185 帧', {
    name: 'EncodingError', message: 'The operation failed'
  }).message).toContain('浏览器编码失败');
  expect(new BrowserExportError('下载配乐', 'Failed to fetch').message)
    .toContain('网络下载中断');
  expect(new BrowserExportError('渲染', null).message).toContain('未知错误');
});
