import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeParsedItinerary } from './shared/itinerary';
vi.mock('@amap/amap-jsapi-loader', () => ({ default: { load: vi.fn() } }));
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => vi.useRealTimers());

it('continues past a stalled region and POI lookup without trying every spelling again', async () => {
  const { enrichItineraryWithAmap } = await import('./amap');
  const itinerary = normalizeParsedItinerary({ days: [{ stops: [
    { name: '河口湖站', city: '富士山' }, { name: '公园', city: '杭州' }
  ] }] });
  const search = vi.fn((query, callback) => {
    if (query.includes('河口湖站')) return;
    callback('complete', { poiList: { pois: [{ id: 'park', name: '公园', cityname: '杭州市', location: [120, 30] }] } });
  });
  const progress = vi.fn();
  const result = enrichItineraryWithAmap({
    Geocoder: class { getLocation(address: string, callback: any) { if (address !== '富士山') callback('no_data', {}); } },
    PlaceSearch: class { search = search; }
  }, itinerary, 'auto', true, progress);
  await vi.runAllTimersAsync();
  const completed = await result;
  expect(completed.days[0].stops[0].poiMatch).toMatchObject({ status: 'unmatched', errorCode: 'REQUEST_TIMEOUT' });
  expect(completed.days[0].stops[1].poiMatch).toMatchObject({ status: 'matched', poiId: 'park' });
  expect(search.mock.calls.filter(([query]) => query.includes('河口湖站'))).toHaveLength(1);
  expect(progress).toHaveBeenCalledWith('匹配地点 2/2: 公园');
  expect(itinerary.days[0].stops[0].poiMatch?.status).toBe('pending');
});

it('finishes a silent route planner as an explicit schematic route', async () => {
  const { enrichItineraryWithAmap } = await import('./amap');
  const itinerary = normalizeParsedItinerary({ days: [{ stops: [
    { name: 'A' }, { name: 'B', arrival: { mode: 'walking', label: '步行', quote: '步行' } }
  ] }] });
  for (const [index, stop] of itinerary.days[0].stops.entries()) stop.poiMatch = { name: stop.name, status: 'matched', matchVersion: 2, location: [120 + index * 0.001, 30] };
  const result = enrichItineraryWithAmap({ Walking: class { search() {} } }, itinerary);
  await vi.runAllTimersAsync();
  expect((await result).routeSegments[0]).toMatchObject({ status: 'fallback', mode: 'walking', path: [[120, 30], [120.001, 30]] });
});

it('ends a stalled manual search and rejects ambiguous locations in a multi-city trip', async () => {
  const { searchPoiCandidates, enrichItineraryWithAmap } = await import('./amap');
  const search = searchPoiCandidates({ PlaceSearch: class { search() {} } }, '河口湖站', { city: '富士山' });
  const failure = expect(search).rejects.toThrow('12 秒未响应');
  await vi.runAllTimersAsync();
  await failure;
  const itinerary = normalizeParsedItinerary({ tripScope: { mode: 'multi_city', cities: ['南京', '东京'] }, days: [{ stops: [{ name: '一兰拉面' }] }] });
  const places = vi.fn();
  const result = await enrichItineraryWithAmap({ PlaceSearch: places }, itinerary);
  expect(places).not.toHaveBeenCalled();
  expect(result.days[0].stops[0].poiMatch?.errorCode).toBe('MISSING_REGION');
});
