import { expect, it } from 'vitest';
import { fixture, meal } from './routeUpdateFixtures';
import { applyActivityEdits, stageActivityEdit } from './activityEdits';
import { applyStopOrderEdits, changedStopOrderCount, stageStopMove } from './stopOrderEdits';

it('stages several same-day moves without altering saved stops and reuses unaffected route geometry', () => {
  const source = fixture(), original = structuredClone(source);
  const [a, b, c] = source.days[0].stops;
  let edits = stageStopMove(source, {}, 1, c.id, -1);
  edits = stageStopMove(source, edits, 1, c.id, -1);
  const next = applyStopOrderEdits(source, source, edits);
  expect(next.days[0].stops.map((stop) => stop.id)).toEqual([c.id, a.id, b.id]);
  expect(next.days[0].stops.map((stop) => [stop.order, stop.label])).toEqual([[1, 'D1-1'], [2, 'D1-2'], [3, 'D1-3']]);
  expect(next.days[0].stops[0]).toMatchObject({ id: c.id, time: c.time, poiMatch: c.poiMatch });
  expect(next.days[1]).toEqual(source.days[1]);
  expect(next.routeSegments).toEqual([source.routeSegments[0], source.routeSegments[3]]);
  expect(next.transportReviewLegs).toHaveLength(2);
  expect(next.transportNeedsReview).toBe(true);
  expect(changedStopOrderCount(source, edits)).toBe(3);
  expect(source).toEqual(original);
});

it('moving back restores the committed route without leaving a phantom draft', () => {
  const source = fixture(), stop = source.days[0].stops[1];
  const edits = stageStopMove(source, {}, 1, stop.id, -1);
  expect(changedStopOrderCount(source, edits)).toBe(2);
  const reverted = stageStopMove(source, edits, 1, stop.id, 1);
  expect(reverted).toEqual({});
  expect(applyStopOrderEdits(source, source, reverted)).toBe(source);
});

it('does not cross day boundaries or invent stops for stale actions', () => {
  const source = fixture(), edits = {};
  expect(stageStopMove(source, edits, 1, source.days[0].stops[0].id, -1)).toBe(edits);
  expect(stageStopMove(source, edits, 1, source.days[0].stops.at(-1)!.id, 1)).toBe(edits);
  expect(stageStopMove(source, edits, 1, 'missing', -1)).toBe(edits);
  expect(stageStopMove(source, edits, 8, source.days[0].stops[0].id, 1)).toBe(edits);
});

it('merges staged meal selections with reordering and compares the final route to saved geometry', () => {
  const source = fixture(), [a, b, c] = source.days[0].stops, lunch = meal();
  const edits = stageStopMove(source, {}, 1, c.id, -1);
  const activities = stageActivityEdit(source, {}, { dayIndex: 1, option: lunch, include: true });
  const withMeal = applyActivityEdits(source, activities);
  const next = applyStopOrderEdits(source, withMeal, edits);
  expect(next.days[0].stops.map((stop) => stop.id)).toEqual([a.id, c.id, lunch.id, b.id]);
  expect(new Set(next.days[0].stops.map((stop) => stop.id)).size).toBe(4);
  expect(next.routeSegments).toEqual([source.routeSegments[3]]);
  expect(next.transportReviewLegs).toHaveLength(4);
});

it('filters removed IDs out of an order draft while preserving remaining stop metadata', () => {
  const source = fixture(), [a, b, c] = source.days[0].stops;
  const base = structuredClone(source);
  base.days[0].stops = [a, c];
  const next = applyStopOrderEdits(source, base, { 1: [c.id, b.id, a.id, c.id] });
  expect(next.days[0].stops.map((stop) => stop.id)).toEqual([c.id, a.id]);
  expect(next.days[0].stops[0].poiMatch).toEqual(c.poiMatch);
});
