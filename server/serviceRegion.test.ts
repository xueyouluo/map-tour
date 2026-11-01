import { describe, expect, it } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import { assertMainlandItinerary, assertMainlandMapRequest, isMainlandCoordinate } from './serviceRegion';

function mainland() {
  return normalizeParsedItinerary({
    serviceRegion: 'CN_MAINLAND',
    days: [{ stops: [
      { name: '西湖', province: '浙江省', city: '杭州市', countryCode: 'CN' },
      { name: '灵隐寺', province: '浙江省', city: '杭州市', countryCode: 'CN' }
    ] }]
  });
}
function located() {
  const trip = mainland();
  for (const [i, stop] of trip.days[0].stops.entries())
    stop.poiMatch = { name: stop.name, status: 'matched', location: [120.1 + i * .01, 30.2] };
  return trip;
}
describe('mainland service coverage', () => {
  it('includes mainland cities, Hainan and Pingtan', () => {
    for (const p of [[114.302, 30.544], [120.1, 30.2], [116.4, 39.9], [87.62, 43.82],
      [91.13, 29.65], [109.51, 18.25], [119.79, 25.5]])
      expect(isMainlandCoordinate(p), String(p)).toBe(true);
  });
  it('excludes overseas and HK/MO/TW, including foreign points inside the broad China bounding box', () => {
    for (const p of [[114.17, 22.28], [113.54, 22.2], [121.5654, 25.033], [139.69, 35.68],
      [105.83, 21.03], [131.88, 43.12], [126.98, 37.56], [NaN, 30], ['120', '30']])
      expect(isMainlandCoordinate(p), String(p)).toBe(false);
  });
  it('accepts a mainland parse before browser geocoding and legacy verified mainland coordinates', () => {
    expect(() => assertMainlandItinerary(mainland())).not.toThrow();
    const legacy = located();
    delete legacy.serviceRegion;
    for (const stop of legacy.days[0].stops) {
      delete stop.province; delete stop.city; delete stop.countryCode;
    }
    expect(() => assertMainlandItinerary(legacy)).not.toThrow();
  });
  it('rejects unknown geography and declared unsupported regions instead of assuming CN', () => {
    const trip = normalizeParsedItinerary({ days: [{ stops: [{ name: '不明确的地点' }] }] });
    expect(() => assertMainlandItinerary(trip)).toThrow('无法确认');
    for (const serviceRegion of ['UNKNOWN', 'UNSUPPORTED'] as const)
      expect(() => assertMainlandItinerary({ ...mainland(), serviceRegion })).toThrow('仅支持中国大陆');
  });
  it('does not let CN/province/adcode labels override a foreign coordinate', () => {
    const trip = located();
    trip.days[0].stops[0].poiMatch = {
      name: '浅草寺', status: 'matched', province: '浙江省', city: '杭州市', adcode: '330100', location: [139.69, 35.68]
    };
    expect(() => assertMainlandItinerary(trip)).toThrow('仅支持中国大陆');
  });
  it('rejects excluded or foreign metadata even if the coordinate is mainland', () => {
    for (const extra of [{ countryCode: 'JP' }, { province: '香港特别行政区' }, { city: '台北市' }]) {
      const trip = located();
      Object.assign(trip.days[0].stops[0], extra);
      expect(() => assertMainlandItinerary(trip)).toThrow('仅支持中国大陆');
    }
    const trip = located();
    trip.days[0].stops[0].poiMatch!.adcode = '810001';
    expect(() => assertMainlandItinerary(trip)).toThrow('仅支持中国大陆');
  });
  it('validates alternatives, unselected meals/stays and recommendations, rather than dropping them', () => {
    const foreign = { ...mainland().days[0].stops[0], id: 'foreign', name: '东京酒店', countryCode: 'JP' };
    for (const section of ['alternatives', 'activityOptions', 'recommendations'] as const) {
      const trip = mainland();
      if (section === 'recommendations') trip.recommendations = { lodging: [foreign], dining: [] };
      else trip.days[0][section] = [foreign];
      expect(() => assertMainlandItinerary(trip)).toThrow('东京酒店');
    }
  });
  it('permits foreign words in a mainland restaurant name without treating them as a destination', () => {
    const trip = mainland();
    trip.days[0].stops[0].name = '东京风味日料';
    expect(() => assertMainlandItinerary(trip)).not.toThrow();
  });
  it('checks every supplied route vertex, including a hidden foreign detour', () => {
    const trip = located(), [a, b] = trip.days[0].stops;
    trip.routeSegments = [{ dayIndex: 1, fromStopId: a.id, toStopId: b.id, mode: 'driving', status: 'complete',
      path: [a.poiMatch!.location!, [139.69, 35.68], b.poiMatch!.location!] }];
    expect(() => assertMainlandItinerary(trip)).toThrow('路线经过');
    trip.routeSegments[0].mode = 'flight';
    expect(() => assertMainlandItinerary(trip)).toThrow('路线经过');
  });
  it('allows only direct domestic ferry/flight schematic corridors across water', () => {
    const trip = located(), [a, b] = trip.days[0].stops;
    a.poiMatch!.location = [110.17, 20.32]; b.poiMatch!.location = [110.33, 20.02];
    const mid: [number, number] = [110.25, 20.17];
    expect(isMainlandCoordinate(mid)).toBe(false);
    trip.routeSegments = [{ dayIndex: 1, fromStopId: a.id, toStopId: b.id, mode: 'ferry', status: 'fallback',
      path: [a.poiMatch!.location, mid, b.poiMatch!.location] }];
    expect(() => assertMainlandItinerary(trip)).not.toThrow();
  });
  it('rejects invalid types without producing a server error', () => {
    for (const bad of [null, {}, { days: [{}] }, { ...mainland(), tripScope: { cities: 5 } },
      { ...mainland(), days: [{ stops: [{ name: '西湖', city: 4 }] }] }])
      expect(() => assertMainlandItinerary(bad)).toThrow('数据不正确');
    expect(() => assertMainlandItinerary({ days: [{ stops: [{ id: 'west-lake', name: '西湖', province: '浙江省' }] }] })).not.toThrow();
  });
  it('blocks overseas coordinate queries before calling the AMap upstream', () => {
    expect(() => assertMainlandMapRequest(new URL('https://restapi.amap.com/v3/direction/driving?origin=120.1,30.2&destination=139.69,35.68'))).toThrow('仅支持中国大陆');
    expect(() => assertMainlandMapRequest(new URL('https://restapi.amap.com/v3/geocode/regeo?location=120.1,30.2'))).not.toThrow();
  });
});
