import { expect, it } from 'vitest';
import { fixture } from './routeUpdateFixtures';
import {
  hasValidLocation,
  unmatchedRouteStops,
  updateStopLocation
} from './stopLocations';

it('lists only unresolved route stops, including missing and invalid coordinates', () => {
  const source = fixture();
  source.days[0].stops[0].poiMatch!.status = 'unmatched';
  source.days[0].stops[1].poiMatch!.location = [NaN, 30];
  source.days[0].alternatives = [
    { ...source.days[0].stops[0], id: 'optional' }
  ];
  expect(unmatchedRouteStops(source).map((s) => s.id)).toEqual(
    source.days[0].stops.slice(0, 2).map((s) => s.id)
  );
  for (const point of [
    undefined,
    [181, 30],
    [120, 90],
    [Infinity, 30],
    ['120', 30]
  ])
    expect(hasValidLocation(point)).toBe(false);
});

it('preserves IDs and itinerary metadata and only invalidates neighboring legs across days', () => {
  const source = fixture(),
    before = structuredClone(source);
  const stop = source.days[0].stops[2];
  source.days[0].activityOptions = [structuredClone(stop)];
  const candidate = {
    name: '精确码头',
    location: [120.003, 30.001] as [number, number],
    city: '杭州',
    province: '浙江省',
    poiId: 'chosen-poi'
  };
  const next = updateStopLocation(source, stop.id, candidate);
  expect(source.days).toEqual([
    { ...before.days[0], activityOptions: [stop] },
    before.days[1]
  ]);
  expect(next.id).toBe(source.id);
  expect(next.days[0].stops[2]).toMatchObject({
    id: stop.id,
    dayIndex: 1,
    time: stop.time,
    name: candidate.name,
    poiMatch: {
      status: 'matched',
      matchVersion: 2,
      source: 'manual',
      location: candidate.location,
      poiId: 'chosen-poi'
    }
  });
  expect(next.days[0].activityOptions![0].poiMatch?.location).toEqual(
    candidate.location
  );
  expect(next.routeSegments).toHaveLength(2);
  expect(next.routeSegments).toEqual([
    source.routeSegments[0],
    source.routeSegments[3]
  ]);
  expect(next.transportReviewLegs).toEqual([
    { fromStopId: source.days[0].stops[1].id, toStopId: stop.id },
    { fromStopId: stop.id, toStopId: source.days[1].stops[0].id }
  ]);
  expect(next.transportNeedsReview).toBe(true);
  expect(candidate).not.toHaveProperty('status');
});

it('keeps geometry for an unchanged location and rejects missing stops or invented coordinates', () => {
  const source = fixture(),
    stop = source.days[0].stops[0];
  const next = updateStopLocation(source, stop.id, {
    name: '正式名称',
    location: stop.poiMatch!.location
  });
  expect(next.routeSegments).toEqual(source.routeSegments);
  expect(next.transportNeedsReview).toBe(false);
  expect(() => updateStopLocation(source, stop.id, { name: '错误' })).toThrow(
    '有效坐标'
  );
  expect(() =>
    updateStopLocation(source, 'missing', { name: '地点', location: [120, 30] })
  ).toThrow('已不在');
});
