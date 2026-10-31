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

it('filters global and previously saved recommendations to the selected day cities', () => {
  const source = normalizeParsedItinerary({
    days: [
      { dayIndex: 1, stops: [{ name: '黄鹤楼', province: '湖北省', city: '武汉市' }] },
      { dayIndex: 2, stops: [{ name: '橘子洲', province: '湖南省', city: '长沙' }] },
      { dayIndex: 3, stops: [{ name: '武汉站', city: '武汉' }, { name: '长沙南站', city: '长沙市' }] }
    ],
    recommendations: {
      dining: [{ name: '武汉小馆', city: '武汉' }, { name: '长沙湘菜馆', city: '长沙市' }],
      lodging: [{ name: '武汉酒店', city: '武汉' }, { name: '长沙酒店', city: '长沙' }]
    }
  }, 'multi-city-options');
  // Simulate an older saved itinerary containing every city's matched options on day 1.
  const changsha = getDayActivityOptions(source.days[1], source.recommendations);
  source.days[0].activityOptions = changsha.map(option => ({
    ...option, dayIndex: 1, poiMatch: { status: 'matched', name: option.name, city: '长沙市', location: [112.97, 28.19] }
  }));
  const before = structuredClone(source);
  expect(getMapOnlyActivities(source, 1).map(p => p.stop.name)).toEqual(['武汉小馆', '武汉酒店']);
  expect(getMapOnlyActivities(source, 2).map(p => p.stop.name)).toEqual(['长沙湘菜馆', '长沙酒店']);
  expect(getMapOnlyActivities(source, 3)).toHaveLength(4);
  expect(new Set(getMapOnlyActivities(source, 'all').map(p => p.stop.name)).size).toBe(4);
  expect(source).toEqual(before);
});

it('uses resolved POI cities for legacy candidates and keeps explicitly included stops', () => {
  const source = fixture();
  source.days[0].stops[0].poiMatch = { status: 'matched', name: '公园', city: '杭州市', location: [120.15, 30.25] };
  source.days[0].stops[0].city = undefined;
  const option = getDayActivityOptions(source.days[1], source.recommendations)[0];
  source.days[0].activityOptions = [{ ...option, city: undefined,
    poiMatch: { status: 'matched', name: option.name, city: '长沙市', location: [112.97, 28.19] }
  }];
  expect(getDayActivityOptions(source.days[0], source.recommendations).every(p => p.city === '杭州' || p.city === '杭州市')).toBe(true);
  const included = { ...option, id: 'included-meal', city: '杭州', dayIndex: 1 };
  source.days[0].stops.push(included);
  expect(getDayActivityOptions(source.days[0], source.recommendations).some(p => p.id === included.id)).toBe(true);
});

it('accepts county-level recommendation city names belonging to the day', () => {
  const trip = normalizeParsedItinerary({ days: [{ stops: [{ name: '海边', city: '福州市', district: '平潭县' }] }],
    recommendations: { dining: [{ name: '海鲜店', city: '平潭' }], lodging: [] }
  }, 'county-options');
  expect(getMapOnlyActivities(trip, 1).map(p => p.stop.name)).toEqual(['海鲜店']);
});
