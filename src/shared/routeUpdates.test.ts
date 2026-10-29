import { expect, it } from 'vitest';
import {
  normalizeParsedItinerary,
  type Itinerary,
  type Stop
} from './itinerary';
import { journeyLegs } from './transport';
import { toggleOptionalActivity } from './activities';
import {
  stageActivityEdit,
  applyActivityEdits,
  type ActivityEdits
} from './activityEdits';

import { fixture, meal } from './routeUpdateFixtures';
it('retains three unaffected legs and marks only the two new legs when inserting a restaurant', () => {
  const source = fixture(),
    before = structuredClone(source),
    option = meal();
  const next = toggleOptionalActivity(source, 1, option, true);
  expect(next.routeSegments).toEqual(source.routeSegments.slice(1));
  expect(next.transportReviewLegs).toEqual([
    { fromStopId: source.days[0].stops[0].id, toStopId: 'meal' },
    { fromStopId: 'meal', toStopId: source.days[0].stops[1].id }
  ]);
  expect(source).toEqual(before);
});
it('stages multiple selections without changing the committed itinerary and plans the final combined edit', () => {
  const source = fixture(),
    before = structuredClone(source);
  const hotel = {
    ...meal(),
    id: 'stay',
    name: '住宿',
    activity: {
      ...meal().activity!,
      kind: 'stay' as const,
      meal: 'none' as const
    }
  };
  let edits: ActivityEdits = {};
  edits = stageActivityEdit(source, edits, {
    dayIndex: 1,
    option: meal(),
    include: true
  });
  edits = stageActivityEdit(source, edits, {
    dayIndex: 1,
    option: hotel,
    include: true
  });
  expect(Object.keys(edits)).toHaveLength(2);
  expect(source).toEqual(before);
  const draft = applyActivityEdits(source, edits);
  expect(draft.transportReviewLegs).toHaveLength(4);
  expect(draft.routeSegments).toEqual([
    source.routeSegments[1],
    source.routeSegments[3]
  ]);
  expect(draft.days[0].stops.map((stop) => stop.name)).toEqual([
    'A',
    '午餐',
    'B',
    'C',
    '住宿'
  ]);
  expect(source).toEqual(before);
});
it('cancels a selection back to its original value without any route update', () => {
  const source = fixture();
  let edits = stageActivityEdit(
    source,
    {},
    { dayIndex: 1, option: meal(), include: true }
  );
  edits = stageActivityEdit(source, edits, {
    dayIndex: 1,
    option: meal(),
    include: false
  });
  expect(edits).toEqual({});
  expect(applyActivityEdits(source, edits)).toBe(source);
});
it('updates the overnight link but retains other days when accommodation is removed', () => {
  const source = fixture();
  const hotel = {
    ...meal(),
    id: 'stay',
    name: '住宿',
    activity: {
      ...meal().activity!,
      kind: 'stay' as const,
      meal: 'none' as const
    }
  };
  const selected = toggleOptionalActivity(source, 1, hotel, true);
  selected.transportNeedsReview = false;
  selected.transportReviewLegs = [];
  selected.routeSegments = journeyLegs(selected).map(
    ({ from, to, isInterDay }) => ({
      dayIndex: from.dayIndex,
      toDayIndex: isInterDay ? to.dayIndex : undefined,
      isInterDay,
      fromStopId: from.id,
      toStopId: to.id,
      mode: 'walking',
      status: 'complete',
      path: [from.poiMatch!.location!, to.poiMatch!.location!]
    })
  );
  const removed = toggleOptionalActivity(selected, 1, hotel, false);
  expect(removed.transportReviewLegs).toEqual([
    {
      fromStopId: source.days[0].stops[2].id,
      toStopId: source.days[1].stops[0].id
    }
  ]);
  expect(removed.routeSegments).toHaveLength(3);
});
