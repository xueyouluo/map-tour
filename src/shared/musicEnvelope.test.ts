import { expect, it } from 'vitest';
import { musicGainAt } from './musicEnvelope';
it('fades the trimmed soundtrack in and out while preserving the original tempo', () => {
  expect(musicGainAt(0, 30)).toBe(0);
  expect(musicGainAt(1, 30)).toBeCloseTo(10 ** (-2 / 20));
  expect(musicGainAt(29.5, 30)).toBeCloseTo(10 ** (-2 / 20) / 2);
  expect(musicGainAt(30, 30)).toBe(0);
});
