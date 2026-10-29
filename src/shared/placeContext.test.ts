import { expect, it } from 'vitest';
import { normalizeParsedItinerary } from './itinerary';
import {
  candidateFitsRegion,
  placeQueries,
  placeSearchContext
} from './placeContext';

it('keeps per-stop geography on multi-city trips and qualifies queries', () => {
  const itinerary = normalizeParsedItinerary(
    {
      tripScope: { mode: 'multi_city', cities: ['福州', '杭州'] },
      days: [
        {
          stops: [
            {
              name: '北港村',
              province: '福建省',
              city: '福州市',
              district: '平潭县',
              locationHint: '君山镇'
            },
            { name: '灵隐寺', province: '浙江省', city: '杭州' }
          ]
        }
      ]
    },
    'test'
  );
  const context = placeSearchContext(
    itinerary.days[0].stops[0],
    itinerary.tripScope
  );
  expect(placeQueries(itinerary.days[0].stops[0], context)[0]).toBe(
    '福建省 福州市 平潭县 君山镇 北港村'
  );
  expect(
    placeSearchContext(itinerary.days[0].stops[1], itinerary.tripScope).city
  ).toBe('杭州');
});
it('rejects wrong province, wrong district, and distant namesakes without provider admin fields', () => {
  const context = {
    province: '福建省',
    city: '福州市',
    district: '平潭县',
    center: [119.79, 25.5] as [number, number]
  };
  expect(
    candidateFitsRegion({ name: '北港村', province: '河北省' }, context)
  ).toBe(false);
  expect(
    candidateFitsRegion(
      {
        name: '北港村',
        province: '福建省',
        city: '福州市',
        district: '鼓楼区'
      },
      context
    )
  ).toBe(false);
  expect(
    candidateFitsRegion({ name: '北港村', location: [116.1, 39.56] }, context)
  ).toBe(false);
  expect(
    candidateFitsRegion(
      {
        name: '北港村',
        province: '福建省',
        city: '福州市',
        district: '平潭县',
        location: [119.83, 25.58]
      },
      context
    )
  ).toBe(true);
});
