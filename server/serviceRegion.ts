import fs from 'node:fs';
import type { Coordinate, Itinerary, Stop } from '../src/shared/itinerary';
import { MAINLAND_ONLY_MESSAGE } from '../src/shared/serviceRegion';
import { normalizeRegion } from '../src/shared/placeContext';
import { stopLocationDefaults } from '../src/shared/stopLocationDefaults';
import { hasValidLocation } from '../src/shared/stopLocations';
import { HttpError } from './httpSecurity';

type Ring = Coordinate[];
type Polygon = Ring[];
interface Region {
  name: string;
  adcode: string;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: Polygon | Polygon[] };
}
type Box = [number, number, number, number];
const regions: Region[] = JSON.parse(
  fs.readFileSync(new URL('./geo/china-provinces.json', import.meta.url), 'utf8')
);
const excludedCodes = new Set(['710000', '810000', '820000']);
const mainlandProvinces = new Set(regions
  .filter((r) => !excludedCodes.has(r.adcode)).map((r) => normalizeRegion(r.name)));
const mainlandPrefixes = new Set(regions
  .filter((r) => !excludedCodes.has(r.adcode)).map((r) => r.adcode.slice(0, 2)));
const polygons = regions.flatMap((r) => {
  const shapes = r.geometry.type === 'Polygon'
    ? [r.geometry.coordinates as Polygon] : r.geometry.coordinates as Polygon[];
  return shapes.map((rings) => {
    const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of rings[0]) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    return { rings, box, excluded: excludedCodes.has(r.adcode) };
  });
});
function inBox([x, y]: Coordinate, [a, b, c, d]: Box): boolean {
  return x >= a && y >= b && x <= c && y <= d;
}
function inRing([x, y]: Coordinate, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j];
    const cross = (x - a) * (d - b) - (y - b) * (c - a);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(a, c) && x <= Math.max(a, c) &&
      y >= Math.min(b, d) && y <= Math.max(b, d)) return true;
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a)
      inside = !inside;
  }
  return inside;
}
function pointRegion(point: Coordinate): 'mainland' | 'excluded' | 'outside' {
  let mainland = false;
  for (const polygon of polygons) {
    if (!inBox(point, polygon.box) || !inRing(point, polygon.rings[0]) ||
      polygon.rings.slice(1).some((hole) => inRing(point, hole))) continue;
    if (polygon.excluded) return 'excluded';
    mainland = true;
  }
  return mainland ? 'mainland' : 'outside';
}
export function isMainlandCoordinate(point: unknown): point is Coordinate {
  return hasValidLocation(point) && pointRegion(point) === 'mainland';
}
function unsupported(name = ''): never {
  throw new HttpError(422, MAINLAND_ONLY_MESSAGE + (name ? `请核对：${name.slice(0, 80)}。` : ''));
}
function metadata(place: Record<string, unknown>, name: string) {
  for (const key of ['province', 'city', 'district', 'country', 'countryCode'])
    if (place[key] !== undefined && typeof place[key] !== 'string')
      throw new HttpError(400, '地点地区数据不正确。');
  if (place.countryCode !== undefined && place.countryCode !== '' &&
    (typeof place.countryCode !== 'string' || place.countryCode.toUpperCase() !== 'CN'))
    unsupported(name);
  if (place.country && !['中国', '中国大陆', '中华人民共和国', 'china', 'cn']
    .includes(String(place.country).toLowerCase())) unsupported(name);
  if (place.province && !mainlandProvinces.has(normalizeRegion(String(place.province))))
    unsupported(name);
  if (place.adcode && (!/^\d{6}$/.test(String(place.adcode)) ||
    !mainlandPrefixes.has(String(place.adcode).slice(0, 2)))) unsupported(name);
  for (const field of ['city', 'district']) {
    if (/^(香港|澳门|澳門|台湾|臺灣|台北|臺北|新北|桃园|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|嘉义|嘉義|花莲|花蓮|台东|臺東|台東|澎湖)(市|县|縣|区|區|省|特别行政区|特別行政區)?$/.test(String(place[field] || '')))
      unsupported(name);
  }
}

/** Local-only business coverage check; never makes geocoding/model requests. */
export function assertMainlandItinerary(input: unknown): asserts input is Itinerary {
  const trip = input as Itinerary;
  if (!trip || !Array.isArray(trip.days) || !trip.days.length || trip.days.length > 60)
    throw new HttpError(400, '行程数据不正确。');
  const scope = trip.tripScope;
  if (scope && (typeof scope !== 'object' ||
    (scope.primaryCity !== undefined && typeof scope.primaryCity !== 'string') ||
    (scope.cities !== undefined && (!Array.isArray(scope.cities) ||
      !scope.cities.every((city) => typeof city === 'string')))))
    throw new HttpError(400, '行程地区数据不正确。');
  if (trip.serviceRegion && trip.serviceRegion !== 'CN_MAINLAND') unsupported();
  if (trip.tripScope?.province) metadata(trip.tripScope as unknown as Record<string, unknown>, '行程所在地区');
  const places: { stop: Stop; main: boolean }[] = [];
  for (const day of trip.days) {
    if (!day || !Array.isArray(day.stops) || !day.stops.length)
      throw new HttpError(400, '行程地点数据不正确。');
    for (const [key, main] of [['stops', true], ['alternatives', false], ['activityOptions', false]] as const) {
      if (day[key] !== undefined && !Array.isArray(day[key])) throw new HttpError(400, '行程地点数据不正确。');
      for (const stop of day[key] || []) places.push({ stop, main });
    }
  }
  for (const group of [trip.alternatives || [], trip.recommendations?.dining || [], trip.recommendations?.lodging || []]) {
    if (!Array.isArray(group)) throw new HttpError(400, '推荐地点数据不正确。');
    for (const stop of group) places.push({ stop: stop as Stop, main: false });
  }
  if (places.length > 1200) throw new HttpError(400, '地点过多，请精简行程。');
  const cityProvinces = new Map<string, Set<string>>();
  for (const { stop } of places) {
    if (!stop || typeof stop.name !== 'string' || !stop.name.trim())
      throw new HttpError(400, '行程地点数据不正确。');
    metadata(stop as unknown as Record<string, unknown>, stop.name);
    if (stop.poiMatch) metadata(stop.poiMatch as unknown as Record<string, unknown>, stop.name);
    if (stop.poiMatch?.searchContext)
      metadata(stop.poiMatch.searchContext as unknown as Record<string, unknown>, stop.name);
    for (const source of [stop, stop.poiMatch]) {
      if (source?.city && source.province) {
        const key = normalizeRegion(source.city);
        if (!cityProvinces.has(key)) cityProvinces.set(key, new Set());
        cityProvinces.get(key)!.add(normalizeRegion(source.province));
      }
    }
  }
  const mainStops = new Map<string, Stop>();
  for (const { stop, main } of places) {
    const location = stop.poiMatch?.location;
    if (location !== undefined && !isMainlandCoordinate(location)) unsupported(stop.name);
    const context = stopLocationDefaults(stop, trip);
    const knownProvince = context.province && mainlandProvinces.has(normalizeRegion(context.province));
    const city = normalizeRegion(stop.city || context.city);
    const cityProvince = cityProvinces.get(city);
    if (!location && !knownProvince && !(cityProvince?.size === 1)) {
      throw new HttpError(422, `${MAINLAND_ONLY_MESSAGE}无法确认“${stop.name.slice(0, 80)}”所在地区，请补充省份、城市后重新导入或修改。`);
    }
    if (main) mainStops.set(stop.id, stop);
  }
  if (trip.routeSegments !== undefined && !Array.isArray(trip.routeSegments))
    throw new HttpError(400, '路线数据不正确。');
  let pointCount = 0;
  for (const segment of trip.routeSegments || []) {
    if (!segment || !Array.isArray(segment.path) || (pointCount += segment.path.length) > 150000)
      throw new HttpError(400, '路线数据不正确或过大。');
    const from = mainStops.get(segment.fromStopId)?.poiMatch?.location;
    const to = mainStops.get(segment.toStopId)?.poiMatch?.location;
    if (!from || !to) throw new HttpError(422, '请先确认路线起点和终点的位置。');
    for (const point of segment.path) {
      if (!hasValidLocation(point)) unsupported('路线坐标');
      const region = pointRegion(point);
      if (region === 'mainland') continue;
      // Domestic flights/ferries may cross water; only allow their direct
      // endpoint-to-endpoint schematic corridor, never arbitrary overseas paths.
      if (region !== 'excluded' && ['flight', 'ferry'].includes(segment.mode) &&
        inSchematicCorridor(point, from, to)) continue;
      unsupported('路线经过的地区');
    }
  }
}

function inSchematicCorridor(p: Coordinate, a: Coordinate, b: Coordinate): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= 0.025;
}

export function assertMainlandMapRequest(url: URL): void {
  for (const key of ['city', 'cityd']) {
    const city = url.searchParams.get(key);
    if (city) metadata(/^\d{6}$/.test(city) ? { adcode: city } : { city }, '地图查询地区');
  }
  for (const key of ['origin', 'destination', 'location', 'locations', 'waypoints']) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    for (const item of value.split(/[;|]/)) {
      const point = item.split(',').map(Number);
      if (point.length !== 2 || !isMainlandCoordinate(point)) unsupported('地图查询坐标');
    }
  }
}
