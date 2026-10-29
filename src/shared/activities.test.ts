import { expect, it } from 'vitest';
import { completeDailyActivities, toggleOptionalActivity } from './activities';
import { normalizeParsedItinerary, type ParsedItinerary } from './itinerary';
import { createVideoPlan } from './videoPlan';

function fixture(): ParsedItinerary {
  return {
    title: '杭州3天',
    recommendations: {
      lodging: [
        {
          name: '湖滨片区',
          activity: {
            kind: 'stay',
            source: 'explicit',
            placeKind: 'area',
            meal: 'none',
            quote: '住宿推荐',
            searchName: '龙翔桥'
          }
        }
      ],
      dining: [{ name: '杭州酒家' }]
    },
    days: [1, 2, 3].map((dayIndex) => ({
      dayIndex,
      stops: [
        { name: '公园', order: 1, time: '上午' },
        { name: '湖边', order: 2, time: '下午' }
      ]
    }))
  };
}
it('keeps recommendations out of the route and does not invent meals or lodging by default', () => {
  const input = fixture(),
    before = structuredClone(input),
    result = completeDailyActivities(input);
  expect(input).toEqual(before);
  expect(
    result.days!.flatMap((d) => d.stops!).map((s) => s.activity?.kind)
  ).not.toContain('meal');
  expect(
    result.days!.flatMap((d) => d.stops!).map((s) => s.activity?.kind)
  ).not.toContain('stay');
  expect(result.recommendations!.dining[0].name).toBe('杭州酒家');
});
it('keeps sightseeing at a meal district and offers the meal separately', () => {
  const input = fixture();
  input.days![0].stops!.push({
    name: '满觉陇',
    order: 3,
    activity: {
      kind: 'meal',
      source: 'explicit',
      placeKind: 'area',
      meal: 'lunch',
      quote: '赏桂花吃午饭',
      searchName: '满觉陇',
      alsoVisit: true
    }
  });
  const result = normalizeParsedItinerary(completeDailyActivities(input));
  expect(result.days[0].stops.at(-1)).toMatchObject({
    name: '满觉陇',
    activity: { kind: 'visit' }
  });
  expect(result.days[0].activityOptions).toHaveLength(1);
  expect(result.days[0].activityOptions![0].id).not.toBe(
    result.days[0].stops.at(-1)!.id
  );
});
it('adds selected lodging at the end of the day, removes it again, and flags the changed transport', () => {
  const input = fixture();
  input.days![0].activityOptions = [
    { name: '湖滨片区', activity: input.recommendations!.lodging[0].activity }
  ];
  const itinerary = normalizeParsedItinerary(completeDailyActivities(input));
  const option = itinerary.days[0].activityOptions![0];
  const selected = toggleOptionalActivity(itinerary, 1, option, true);
  expect(selected.days[0].stops.at(-1)!.id).toBe(option.id);
  expect(selected.transportNeedsReview).toBe(true);
  expect(selected.routeSegments).toEqual([]);
  const removed = toggleOptionalActivity(selected, 1, option, false);
  expect(removed.days[0].stops.at(-1)!.name).toBe('湖边');
  expect(removed.days[0].activityOptions).toHaveLength(1);
  expect(itinerary.days[0].stops).toHaveLength(2);
});
it('normalizes flattened model recommendation fields without silently adding the recommendation', () => {
  const source = fixture();
  source.recommendations!.lodging = [
    {
      name: '龙翔桥/湖滨片区',
      placeKind: 'area',
      searchName: '龙翔桥'
    } as never
  ];
  const result = completeDailyActivities(source);
  expect(result.recommendations!.lodging[0].activity).toMatchObject({
    kind: 'stay',
    placeKind: 'area',
    searchName: '龙翔桥'
  });
  expect(result.days![0].stops).toHaveLength(2);
});
it('ignores old driving geometry on an explicitly declared boat leg and holds for dining and sleep', () => {
  const itinerary = normalizeParsedItinerary(
    {
      title: '测试',
      days: [
        {
          stops: [
            { name: '码头' },
            {
              name: '餐厅',
              arrival: { mode: 'ferry', label: '水上巴士', quote: '乘船' },
              activity: {
                kind: 'meal',
                source: 'explicit',
                placeKind: 'venue',
                meal: 'lunch',
                quote: '午餐',
                searchName: '餐厅'
              }
            },
            {
              name: '湖滨片区',
              activity: {
                kind: 'stay',
                source: 'default',
                placeKind: 'area',
                meal: 'none',
                quote: '推荐',
                searchName: '湖滨'
              }
            }
          ]
        }
      ]
    },
    'test'
  );
  itinerary.days[0].stops.forEach(
    (stop, i) =>
      (stop.poiMatch = {
        status: 'matched',
        name: stop.name,
        location: [120 + i * 0.001, 30]
      })
  );
  itinerary.routeSegments = [
    {
      dayIndex: 1,
      fromStopId: itinerary.days[0].stops[0].id,
      toStopId: itinerary.days[0].stops[1].id,
      mode: 'driving',
      status: 'complete',
      path: [
        [120, 30],
        [121, 31],
        [120.001, 30]
      ]
    }
  ];
  const plan = createVideoPlan(itinerary, { durationSeconds: 24 });
  expect(plan.segments[0].mode).toBe('ferry');
  expect(plan.segments[0].illustrative).toBe(true);
  expect(plan.segments[0].path).not.toContainEqual([121, 31]);
  expect(plan.events[0].holdEnd - plan.events[0].end).toBeCloseTo(2.5);
  expect(plan.events[1].holdEnd - plan.events[1].end).toBeCloseTo(3.5);
});
