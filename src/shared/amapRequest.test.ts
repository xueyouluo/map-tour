import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestAmapResult } from './amapRequest';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('bounds a missing callback and ignores late responses', async () => {
  let callback!: (status: string, data: unknown) => void;
  const settled = vi.fn();
  const request = requestAmapResult(finish => { callback = finish; }).then(settled);
  await vi.advanceTimersByTimeAsync(12000);
  expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout', data: expect.objectContaining({ infocode: 'REQUEST_TIMEOUT' }) }));
  callback('complete', { poiList: { pois: [] } });
  await request;
  expect(settled).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('clears deadlines for synchronous callbacks and SDK exceptions', async () => {
  expect(await requestAmapResult(finish => finish('no_data', {}))).toEqual({ status: 'no_data', data: {} });
  expect(await requestAmapResult(() => { throw new Error('INVALID_CITY'); })).toMatchObject({ status: 'error', data: { info: 'INVALID_CITY', infocode: 'SDK_ERROR' } });
  expect(vi.getTimerCount()).toBe(0);
});
