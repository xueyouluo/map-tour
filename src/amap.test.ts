import { expect, it, vi } from 'vitest';
vi.mock('@amap/amap-jsapi-loader', () => ({ default: { load: vi.fn() } }));
import { enrichItineraryWithAmap } from './amap';
import { normalizeParsedItinerary } from './shared/itinerary';
it('plans the next morning from the previous overnight stop through a real route planner', async () => {
  const i = normalizeParsedItinerary(
    {
      days: [
        { stops: [{ name: '住宿' }] },
        {
          stops: [
            {
              name: '灵隐寺',
              arrival: {
                mode: 'walking',
                fromName: '住宿',
                quote: '步行',
                label: '步行'
              }
            }
          ]
        }
      ]
    },
    'test'
  );
  const points: [number, number][] = [
    [120.15, 30.25],
    [120.14, 30.26],
    [120.1, 30.24]
  ];
  i.days[0].stops[0].poiMatch = {
    status: 'matched',
    matchVersion: 2,
    name: '住宿',
    location: points[0]
  };
  i.days[1].stops[0].poiMatch = {
    status: 'matched',
    matchVersion: 2,
    name: '灵隐寺',
    location: points[2]
  };
  const search = vi.fn((_a, _b, callback) =>
    callback('complete', {
      routes: [{ steps: [{ path: points }], distance: 6500, time: 5000 }]
    })
  );
  const AMap = {
    Walking: class {
      search = search;
    }
  };
  const result = await enrichItineraryWithAmap(AMap, i);
  expect(search).toHaveBeenCalledOnce();
  expect(result.routeSegments[0]).toMatchObject({
    isInterDay: true,
    dayIndex: 1,
    toDayIndex: 2,
    mode: 'walking',
    status: 'complete',
    path: points
  });
  expect(i.routeSegments).toEqual([]);
});

it('rematches old coordinates within the resolved county, rejects distant namesakes and clears stale routes', async () => {
  const itinerary = normalizeParsedItinerary(
    {
      tripScope: { mode: 'multi_city', cities: ['平潭'] },
      days: [{ stops: [{ name: '北港村' }, { name: '未找到景点' }] }]
    },
    'test'
  );
  const [from, to] = itinerary.days[0].stops;
  from.poiMatch = {
    status: 'matched',
    name: '北港村服务站',
    location: [116.1, 39.56]
  };
  to.poiMatch = {
    status: 'matched',
    name: '未找到景点',
    location: [116.2, 39.5]
  };
  itinerary.routeSegments = [
    {
      dayIndex: 1,
      fromStopId: from.id,
      toStopId: to.id,
      mode: 'driving',
      status: 'complete',
      path: [
        [116.1, 39.56],
        [116.2, 39.5]
      ]
    }
  ];
  const options: any[] = [];
  const queries: string[] = [];
  const geocode = vi.fn((_query, callback) =>
    callback('complete', {
      geocodes: [
        {
          addressComponent: {
            province: '福建省',
            city: '福州市',
            district: '平潭县'
          },
          adcode: '350128',
          location: [119.79, 25.5]
        }
      ]
    })
  );
  const AMap = {
    Geocoder: class {
      getLocation = geocode;
    },
    PlaceSearch: class {
      constructor(option: any) {
        options.push(option);
      }
      search(query: string, callback: any) {
        queries.push(query);
        callback('complete', {
          poiList: {
            pois: query.includes('北港村')
              ? [
                  { id: 'wrong', name: '北港村', location: [116.1, 39.56] },
                  {
                    id: 'right',
                    name: '北港村',
                    pname: '福建省',
                    cityname: '福州市',
                    adname: '平潭县',
                    adcode: '350128',
                    location: [119.83, 25.58]
                  }
                ]
              : [
                  {
                    id: 'wrong',
                    name: '未找到景点',
                    pname: '河北省',
                    location: [116.1, 39.56]
                  }
                ]
          }
        });
      }
    }
  };
  const result = await enrichItineraryWithAmap(AMap, itinerary);
  expect(geocode).toHaveBeenCalledOnce();
  expect(
    options.every((option) => option.city === '350128' && option.citylimit)
  ).toBe(true);
  expect(queries).toContain('福建省 福州市 平潭县 北港村');
  expect(result.days[0].stops[0]).toMatchObject({
    province: '福建省',
    city: '福州市',
    district: '平潭县',
    poiMatch: { matchVersion: 2, poiId: 'right', location: [119.83, 25.58] }
  });
  expect(result.days[0].stops[1].poiMatch).toMatchObject({
    status: 'unmatched',
    matchVersion: 2
  });
  expect(result.routeSegments[0]).toMatchObject({ status: 'failed', path: [] });
  expect(itinerary.routeSegments[0].path[0]).toEqual([116.1, 39.56]);
});

it('locates optional restaurants once for multiple days without changing an existing sightseeing route', async () => {
  const itinerary = normalizeParsedItinerary(
    {
      tripScope: { mode: 'single_city', primaryCity: '杭州' },
      recommendations: {
        dining: [{ name: '杭州酒家', city: '杭州' }],
        lodging: []
      },
      days: [1, 2].map((dayIndex) => ({
        dayIndex,
        stops: [{ name: '公园', city: '杭州' }]
      }))
    },
    'test'
  );
  itinerary.days.forEach((day, index) => {
    day.stops[0].poiMatch = {
      status: 'matched',
      matchVersion: 2,
      name: '公园',
      location: [120 + index * 0.001, 30]
    };
  });
  const segment = {
    dayIndex: 1,
    toDayIndex: 2,
    isInterDay: true,
    fromStopId: itinerary.days[0].stops[0].id,
    toStopId: itinerary.days[1].stops[0].id,
    mode: 'walking' as const,
    status: 'complete' as const,
    path: [
      [120, 30],
      [120.001, 30]
    ] as [number, number][]
  };
  itinerary.routeSegments = [segment];
  const search = vi.fn((_query, callback) =>
    callback('complete', {
      poiList: {
        pois: [
          {
            id: 'restaurant',
            name: '杭州酒家',
            pname: '浙江省',
            cityname: '杭州市',
            location: [120.01, 30],
            type: '餐饮服务'
          }
        ]
      }
    })
  );
  const result = await enrichItineraryWithAmap(
    {
      PlaceSearch: class {
        search = search;
      }
    },
    itinerary
  );
  expect(search).toHaveBeenCalledTimes(2);
  expect(result.days.flatMap((day) => day.stops)).toHaveLength(2);
  expect(result.routeSegments).toEqual([segment]);
  expect(
    result.days.every(
      (day) => day.activityOptions?.[0].poiMatch?.status === 'matched'
    )
  ).toBe(true);
});

it('only requests two new walking routes after a restaurant is inserted and preserves the other three', async () => {
  const { fixture, meal } = await import('./shared/routeUpdateFixtures');
  const { toggleOptionalActivity } = await import('./shared/activities');
  const original = fixture(),
    selected = toggleOptionalActivity(original, 1, meal(), true);
  const search = vi.fn((from, to, callback) =>
    callback('complete', {
      routes: [{ steps: [{ path: [from, to] }], distance: 500, time: 300 }]
    })
  );
  let reviewedLegCount = 0;
  const refine = vi.fn(async (value) => {
    reviewedLegCount = value.transportReviewLegs.length;
    return { ...value, transportNeedsReview: false, transportReviewLegs: [] };
  });
  const result = await enrichItineraryWithAmap(
    {
      Walking: class {
        search = search;
      }
    },
    selected,
    'auto',
    true,
    undefined,
    refine
  );
  expect(reviewedLegCount).toBe(2);
  expect(search).toHaveBeenCalledTimes(2);
  expect(result.routeSegments).toHaveLength(5);
  for (const segment of original.routeSegments.slice(1))
    expect(result.routeSegments).toContainEqual(segment);
});

it('searches manual replacements in the requested city and only returns valid local coordinates', async () => {
  const { searchPoiCandidates } = await import('./amap');
  const search = vi.fn((_query, callback) =>
    callback('complete', {
      poiList: {
        pois: [
          {
            id: 'local',
            name: '东湖',
            pname: '湖北省',
            cityname: '武汉市',
            location: { lng: 114.4, lat: 30.5 }
          },
          {
            id: 'far',
            name: '东湖',
            pname: '吉林省',
            cityname: '长春市',
            location: { lng: 125.3, lat: 43.8 }
          },
          { id: 'bad', name: '缺失坐标', pname: '湖北省', cityname: '武汉市' }
        ]
      }
    })
  );
  const construct = vi.fn();
  const AMap = {
    PlaceSearch: class {
      constructor(options: unknown) {
        construct(options);
      }
      search = search;
    }
  };
  const results = await searchPoiCandidates(AMap, '东湖', {
    province: '湖北省',
    city: '武汉市'
  });
  expect(construct).toHaveBeenCalledWith(
    expect.objectContaining({ city: '武汉市', citylimit: true })
  );
  expect(results.map((p) => p.poiId)).toEqual(['local']);
  expect(search).toHaveBeenCalledOnce();
});
