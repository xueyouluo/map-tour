import { expect, it } from 'vitest';
import { normalizeParsedItinerary, hasPendingPoiMatches } from './itinerary';
import { getDayActivityOptions, getMapOnlyActivities } from './optionalPlaces';
import { toggleOptionalActivity } from './activities';
import { journeySignature } from './journeySignature';

function fixture() {
  return normalizeParsedItinerary(
    {
      tripScope: { mode: 'single_city', primaryCity: '杭州' },
      days: [1, 2].map((dayIndex) => ({
        dayIndex,
        stops: [{ name: '公园', province: '浙江省', city: '杭州' }],
        activityOptions:
          dayIndex === 1
            ? [
                {
                  name: '杭州酒家',
                  city: '杭州',
                  activity: {
                    kind: 'meal',
                    source: 'explicit',
                    placeKind: 'venue',
                    meal: 'lunch',
                    quote: '午餐',
                    searchName: '杭州酒家'
                  }
                }
              ]
            : []
      })),
      recommendations: {
        dining: [{ name: '杭州酒家', city: '杭州' }],
        lodging: [{ name: '湖滨片区', city: '杭州' }]
      }
    },
    'optional-test'
  );
}
it('shows dining and lodging on the map without adding stops, geometry or video chapters', () => {
  const source = fixture(),
    before = structuredClone(source);
  const options = getDayActivityOptions(source.days[0], source.recommendations);
  expect(options).toHaveLength(2);
  expect(options.map((stop) => stop.activity?.kind)).toEqual(['meal', 'stay']);
  expect(options.every((stop) => stop.city === '杭州')).toBe(true);
  const places = getMapOnlyActivities(source, 'all');
  expect(places).toHaveLength(2);
  expect(places.every((place) => place.choices.length === 2)).toBe(true);
  expect(
    getMapOnlyActivities(source, 2).every(
      (place) => place.choices[0].dayIndex === 2
    )
  ).toBe(true);
  expect(source).toEqual(before);
  expect(source.days.map((day) => day.stops.length)).toEqual([1, 1]);
  expect(hasPendingPoiMatches(source)).toBe(true);
});
it('adds only the selected day and preserves a map candidate after removal', () => {
  const source = fixture();
  const option = getDayActivityOptions(
    source.days[1],
    source.recommendations
  ).find((stop) => stop.activity?.kind === 'stay')!;
  const selected = toggleOptionalActivity(source, 2, option, true);
  expect(selected.days[0].stops).toHaveLength(1);
  expect(selected.days[1].stops.at(-1)?.id).toBe(option.id);
  expect(
    getMapOnlyActivities(selected, 'all').filter(
      (place) => place.stop.activity?.kind === 'stay'
    )
  ).toHaveLength(0);
  expect(journeySignature(selected)).not.toBe(journeySignature(source));
  const removed = toggleOptionalActivity(selected, 2, option, false);
  expect(removed.days[1].stops).toHaveLength(1);
  expect(
    getMapOnlyActivities(removed, 'all').some(
      (place) => place.stop.activity?.kind === 'stay'
    )
  ).toBe(true);
});
