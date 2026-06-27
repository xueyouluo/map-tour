import { describe, expect, it } from 'vitest';
import { chooseRouteMode, distanceMeters } from './geo';

describe('geo helpers', () => {
  it('calculates distance and route mode threshold', () => {
    const shortDistance = distanceMeters([120.1302, 30.2595], [120.132, 30.2608]);
    const longDistance = distanceMeters([120.1302, 30.2595], [120.208, 30.246]);

    expect(shortDistance).toBeGreaterThan(100);
    expect(chooseRouteMode(shortDistance)).toBe('walking');
    expect(chooseRouteMode(longDistance)).toBe('driving');
  });
});
