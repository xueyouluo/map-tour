import { describe, expect, it } from 'vitest';
import { placeMapLabels } from './mapPresentation';

describe('travel map label placement', () => {
  it('keeps labels on screen and away from nearby labels and all marker centers', () => {
    const points = [
      { id: 'a', x: 125, y: 110, width: 90, height: 26 },
      { id: 'b', x: 140, y: 115, width: 90, height: 26 },
      { id: 'c', x: 240, y: 155, width: 100, height: 26 },
      { id: 'd', x: 8, y: 8, width: 80, height: 26 }
    ];
    const result = placeMapLabels(points, {
      width: 380,
      height: 260,
      top: 55,
      bottom: 40
    });
    expect(result.length).toBeGreaterThan(0);
    for (const box of result) {
      expect(box.x).toBeGreaterThanOrEqual(18);
      expect(box.y).toBeGreaterThanOrEqual(55);
      expect(box.x + box.width).toBeLessThanOrEqual(362);
      expect(box.y + box.height).toBeLessThanOrEqual(220);
      for (const point of points)
        expect(
          point.x >= box.x &&
            point.x <= box.x + box.width &&
            point.y >= box.y &&
            point.y <= box.y + box.height
        ).toBe(false);
      for (const other of result.filter((p) => p.id !== box.id))
        expect(
          box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y
        ).toBe(false);
    }
  });
  it('gives the selected stop priority in crowded locations without moving any pin', () => {
    const a = { id: 'a', x: 75, y: 60, width: 70, height: 24 };
    const b = { ...a, id: 'b', priority: 100 };
    const input = [a, b];
    const copy = structuredClone(input);
    const result = placeMapLabels(input, { width: 195, height: 110 });
    expect(result[0].id).toBe('b');
    expect(result).toHaveLength(1);
    expect(input).toEqual(copy);
  });
  it('removes labels when no safe space remains and returns the same layout for repeated calls', () => {
    const labels = [{ id: 'x', x: 30, y: 30, width: 200, height: 30 }];
    expect(placeMapLabels(labels, { width: 60, height: 60 })).toEqual([]);
    expect(placeMapLabels(labels, { width: 400, height: 240 })).toEqual(
      placeMapLabels(labels, { width: 400, height: 240 })
    );
  });
});
