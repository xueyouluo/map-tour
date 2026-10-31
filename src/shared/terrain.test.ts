import { expect, it } from 'vitest';
import { sampleTerrarium, terrainWgs84 } from './terrain';
it('preserves coordinates outside GCJ02 and aligns China coordinates without a large drift', () => {
  expect(terrainWgs84(-122, 37)).toEqual([-122, 37]);
  const p = terrainWgs84(120.2, 30.3);
  expect(Math.abs(p[0] - 120.2)).toBeLessThan(0.02);
  expect(Math.abs(p[1] - 30.3)).toBeLessThan(0.02);
  expect(p[0]).not.toBe(120.2);
});
it('interpolates elevation across four neighboring Terrarium tiles without seams', () => {
  const tiles = new Map<string, Uint8ClampedArray>();
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 128; data[i + 1] = x * 100 + y * 20; data[i + 3] = 255; }
    tiles.set(`10-${x}-${y}`, data);
  }
  expect(sampleTerrarium(tiles, 10, [255.5, 255.5])).toBe(60);
  expect(() => sampleTerrarium(new Map(), 10, [0, 0])).toThrow('不完整');
});
