import { describe, expect, it } from 'vitest';
import { buildAmapProxyUrl } from './amapProxy';

describe('buildAmapProxyUrl', () => {
  it('rewrites local proxy path and appends security js code', () => {
    const url = buildAmapProxyUrl('/_AMapService/v3/place/text?keywords=test&key=abc', 'secret-code');

    expect(url).toBe('https://restapi.amap.com/v3/place/text?keywords=test&key=abc&jscode=secret-code');
  });
});
