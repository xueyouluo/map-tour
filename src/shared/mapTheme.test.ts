import { describe, expect, it } from 'vitest';
import { resolveJourneyMapStyle } from './mapTheme';

describe('journey map style configuration', () => {
  it('accepts a published ID or its AMap URI', () => {
    const id = 'd6bf8c1d69cea9f5c696185ad4ac4c86';
    expect(resolveJourneyMapStyle(` ${id} `)).toBe(`amap://styles/${id}`);
    expect(resolveJourneyMapStyle(`amap://styles/${id}`)).toBe(
      `amap://styles/${id}`
    );
  });
  it('keeps the existing map usable for missing or invalid configuration', () => {
    for (const value of [
      undefined,
      '',
      'unpublished',
      'https://example.com/style'
    ]) {
      expect(resolveJourneyMapStyle(value)).toBe('amap://styles/whitesmoke');
    }
  });
});
