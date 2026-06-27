import AMapLoader from '@amap/amap-jsapi-loader';
import { chooseRouteMode, distanceMeters } from './shared/geo';
import type { Coordinate, Itinerary, PoiCandidate, PoiMatch, RoutePreference, RouteSegment, Stop } from './shared/itinerary';

type AMapNamespace = any;
const AMAP_REQUEST_INTERVAL_MS = 380;
const QPS_RETRY_DELAY_MS = 1800;
const MAX_AMAP_RETRIES = 2;

declare global {
  interface Window {
    _AMapSecurityConfig?: {
      serviceHost?: string;
      securityJsCode?: string;
    };
  }
}

export async function loadAMap(key: string, useProxy: boolean): Promise<AMapNamespace> {
  if (useProxy) {
    window._AMapSecurityConfig = {
      serviceHost: `${window.location.origin}/_AMapService`
    };
  }

  return AMapLoader.load({
    key,
    version: '2.0',
    plugins: ['AMap.Scale', 'AMap.ToolBar', 'AMap.PlaceSearch', 'AMap.Driving', 'AMap.Walking', 'AMap.Transfer']
  });
}

export async function enrichItineraryWithAmap(
  AMap: AMapNamespace,
  itinerary: Itinerary,
  routePreference: RoutePreference = 'auto',
  onProgress?: (message: string) => void
): Promise<Itinerary> {
  const next: Itinerary = structuredClone(itinerary);
  const cityLimitedSearch = shouldUseCityLimitedSearch(next);
  const itineraryCity = inferItineraryCity(next);
  const distinctStopCities = getDistinctStopCities(next);
  const mainStops = next.days.flatMap((day) => day.stops);
  const alternativeStops = [
    ...next.days.flatMap((day) => day.alternatives),
    ...next.alternatives
  ];
  const allStops = [...mainStops, ...alternativeStops];

  for (let index = 0; index < allStops.length; index += 1) {
    const stop = allStops[index];
    if (stop.poiMatch?.status === 'matched' || stop.poiMatch?.status === 'unmatched') continue;
    onProgress?.(`匹配地点 ${index + 1}/${allStops.length}: ${stop.name}`);
    stop.poiMatch = await matchStop(AMap, stop, itineraryCity, next.tripScope, distinctStopCities, cityLimitedSearch);
  }

  const existingSegments = new Map(
    next.routeSegments.map((segment) => [routeSegmentKey(segment.dayIndex, segment.fromStopId, segment.toStopId), segment])
  );
  const routeSegments: RouteSegment[] = [];
  for (const day of next.days) {
    for (let index = 0; index < day.stops.length - 1; index += 1) {
      const from = day.stops[index];
      const to = day.stops[index + 1];
      const existing = existingSegments.get(routeSegmentKey(day.dayIndex, from.id, to.id));
      if (existing) {
        routeSegments.push(existing);
        continue;
      }
      onProgress?.(`规划路线 ${from.label} → ${to.label}`);
      routeSegments.push(await planRoute(AMap, day.dayIndex, from, to, routePreference));
    }
  }
  next.routeSegments = routeSegments;
  next.updatedAt = new Date().toISOString();
  return next;
}

function routeSegmentKey(dayIndex: number, fromStopId: string, toStopId: string): string {
  return `${dayIndex}:${fromStopId}->${toStopId}`;
}

function matchStop(
  AMap: AMapNamespace,
  stop: Stop,
  itineraryCity: string,
  tripScope: Itinerary['tripScope'],
  distinctStopCities: Set<string>,
  cityLimitedSearch: boolean
): Promise<PoiMatch> {
  return matchStopWithRetry(AMap, stop, itineraryCity, tripScope, distinctStopCities, cityLimitedSearch, 0);
}

async function matchStopWithRetry(
  AMap: AMapNamespace,
  stop: Stop,
  itineraryCity: string,
  tripScope: Itinerary['tripScope'],
  distinctStopCities: Set<string>,
  cityLimitedSearch: boolean,
  attempt: number
): Promise<PoiMatch> {
  const searchCity = resolveSearchCity(stop, itineraryCity, tripScope, distinctStopCities, cityLimitedSearch);
  const placeSearch = new AMap.PlaceSearch({
    city: searchCity || undefined,
    citylimit: Boolean(searchCity),
    pageSize: 3,
    pageIndex: 1,
    extensions: 'all'
  });
  const query = stop.name;

  await waitForAmapSlot();
  const result = await new Promise<PoiMatch>((resolve) => {
    placeSearch.search(query, (status: string, result: any) => {
      const pois = result?.poiList?.pois || [];
      const candidates = pois.map(normalizePoi).filter((poi: PoiCandidate) => poi.location);
      const best = candidates[0];
      if (status === 'complete' && best?.location) {
        resolve({
          ...best,
          status: 'matched',
          confidence: 0.86,
          amapUrl: createAmapMarkerUrl(best),
          candidates
        });
        return;
      }

      const errorInfo = getAmapErrorInfo(status, result);
      if (errorInfo) {
        console.warn('[AMap POI match failed]', {
          stop: stop.name,
          city: searchCity,
          status,
          info: result?.info,
          infocode: result?.infocode
        });
      }

      resolve({
        status: 'unmatched',
        name: stop.name,
        confidence: 0,
        candidates: [],
        errorInfo: errorInfo || '未匹配到高德 POI',
        errorCode: result?.infocode || status
      });
    });
  });

  if (isQpsLimitError(result.errorInfo, result.errorCode) && attempt < MAX_AMAP_RETRIES) {
    await sleep(QPS_RETRY_DELAY_MS * (attempt + 1));
    return matchStopWithRetry(AMap, stop, itineraryCity, tripScope, distinctStopCities, cityLimitedSearch, attempt + 1);
  }

  return result;
}

function resolveSearchCity(
  stop: Stop,
  itineraryCity: string,
  tripScope: Itinerary['tripScope'],
  distinctStopCities: Set<string>,
  cityLimitedSearch: boolean
): string {
  const stopCity = stop.city?.trim() || '';
  if (tripScope?.mode === 'single_city') {
    return stopCity || tripScope.primaryCity || itineraryCity;
  }

  if (tripScope?.mode === 'multi_city') {
    return shouldUseStopCityForMultiCity(stopCity, tripScope.cities || [], distinctStopCities) ? stopCity : '';
  }

  if (distinctStopCities.size > 1 && stopCity) return stopCity;
  return cityLimitedSearch ? stopCity || itineraryCity : '';
}

function shouldUseStopCityForMultiCity(stopCity: string, scopeCities: string[], distinctStopCities: Set<string>): boolean {
  if (!stopCity || distinctStopCities.size <= 1) return false;
  if (scopeCities.length <= 1) return true;
  return scopeCities.some((city) => city === stopCity || city.includes(stopCity) || stopCity.includes(city));
}

function shouldUseCityLimitedSearch(itinerary: Itinerary): boolean {
  if (itinerary.tripScope?.mode === 'single_city') return true;
  if (itinerary.tripScope?.mode === 'multi_city') return false;

  const text = [
    itinerary.title,
    ...itinerary.days.map((day) => day.title),
    ...itinerary.days.flatMap((day) => day.stops.map((stop) => `${stop.name}${stop.note || ''}`))
  ].join('\n');
  if (/(自驾|取车|开车|租车|环线|小环线|大环线|跨城|路书|国道|高速|县城|川西|新疆|西藏|青甘|甘南|滇西|滇藏|伊犁|独库|318)/.test(text)) {
    return false;
  }

  const stopCities = new Set(
    itinerary.days
      .flatMap((day) => [...day.stops, ...day.alternatives])
      .map((stop) => stop.city?.trim())
      .filter((city): city is string => Boolean(city))
  );
  return stopCities.size <= 1;
}

function inferItineraryCity(itinerary: Itinerary): string {
  if (itinerary.tripScope?.mode === 'single_city' && itinerary.tripScope.primaryCity) {
    return itinerary.tripScope.primaryCity;
  }

  const explicit = itinerary.days
    .flatMap((day) => [...day.stops, ...day.alternatives])
    .map((stop) => stop.city)
    .find((city): city is string => Boolean(city));
  if (explicit) return explicit;

  const titleMatch = itinerary.title.match(/([\u4e00-\u9fa5]{2,4})(?:亲子|旅行|旅游|行程|攻略|游)/);
  return titleMatch?.[1] || '';
}

function getDistinctStopCities(itinerary: Itinerary): Set<string> {
  return new Set(
    itinerary.days
      .flatMap((day) => [...day.stops, ...day.alternatives])
      .map((stop) => stop.city?.trim())
      .filter((city): city is string => Boolean(city))
  );
}

async function planRoute(
  AMap: AMapNamespace,
  dayIndex: number,
  from: Stop,
  to: Stop,
  routePreference: RoutePreference
): Promise<RouteSegment> {
  const start = from.poiMatch?.location;
  const end = to.poiMatch?.location;
  if (!start || !end) {
    return {
      dayIndex,
      fromStopId: from.id,
      toStopId: to.id,
      mode: 'straight',
      status: 'failed',
      path: []
    };
  }

  const directDistance = distanceMeters(start, end);
  const mode = routePreference === 'auto' ? chooseRouteMode(directDistance) : routePreference;
  const planned = mode === 'walking'
    ? await searchWalkingRoute(AMap, start, end)
    : mode === 'transit'
      ? await searchTransitRoute(AMap, start, end, from.city || to.city || '')
      : await searchDrivingRoute(AMap, start, end);

  if (planned.path.length > 1) {
    return {
      dayIndex,
      fromStopId: from.id,
      toStopId: to.id,
      mode,
      status: 'complete',
      distanceMeters: planned.distanceMeters || directDistance,
      durationSeconds: planned.durationSeconds,
      path: planned.path
    };
  }

  return {
    dayIndex,
    fromStopId: from.id,
    toStopId: to.id,
    mode: 'straight',
    status: 'fallback',
    distanceMeters: directDistance,
    path: [start, end]
  };
}

function searchDrivingRoute(AMap: AMapNamespace, start: Coordinate, end: Coordinate) {
  const driving = new AMap.Driving({
    policy: AMap.DrivingPolicy.LEAST_TIME,
    showTraffic: false
  });
  return searchRoute(driving, start, end, 'steps');
}

function searchWalkingRoute(AMap: AMapNamespace, start: Coordinate, end: Coordinate) {
  const walking = new AMap.Walking();
  return searchRoute(walking, start, end, 'steps');
}

function searchTransitRoute(AMap: AMapNamespace, start: Coordinate, end: Coordinate, city: string) {
  const transfer = new AMap.Transfer({
    city: city || undefined,
    policy: AMap.TransferPolicy.LEAST_TIME
  });
  return searchRoute(transfer, start, end, 'segments');
}

function searchRoute(planner: any, start: Coordinate, end: Coordinate, stepsKey: string) {
  return searchRouteWithRetry(planner, start, end, stepsKey, 0);
}

function searchRouteWithRetry(
  planner: any,
  start: Coordinate,
  end: Coordinate,
  stepsKey: string,
  attempt: number
): Promise<{ path: Coordinate[]; distanceMeters?: number; durationSeconds?: number }> {
  return waitForAmapSlot().then(() => new Promise<{ path: Coordinate[]; distanceMeters?: number; durationSeconds?: number; errorInfo?: string; errorCode?: string }>((resolve) => {
    planner.search(start, end, (status: string, result: any) => {
      if (status !== 'complete') {
        resolve({
          path: [],
          errorInfo: getAmapErrorInfo(status, result),
          errorCode: result?.infocode || status
        });
        return;
      }

      const route = result?.routes?.[0] || result?.plans?.[0];
      const steps = route?.[stepsKey] || [];
      const path = flattenRoutePath(steps);
      resolve({
        path,
        distanceMeters: route?.distance,
        durationSeconds: route?.time || route?.duration
      });
    });
  })).then(async (result) => {
    if (isQpsLimitError(result.errorInfo, result.errorCode) && attempt < MAX_AMAP_RETRIES) {
      await sleep(QPS_RETRY_DELAY_MS * (attempt + 1));
      return searchRouteWithRetry(planner, start, end, stepsKey, attempt + 1);
    }
    return result;
  });
}

function flattenRoutePath(steps: any[]): Coordinate[] {
  return steps
    .flatMap((step: any) => {
      if (Array.isArray(step.path)) return step.path;
      const transitSegments = [
        ...(step.transit?.path || []),
        ...(step.walking?.steps || []).flatMap((walkStep: any) => walkStep.path || []),
        ...(step.bus?.buslines || []).flatMap((line: any) => line.path || []),
        ...(step.railway?.via_stops || []).map((stop: any) => stop.location),
        step.railway?.departure_stop?.location,
        step.railway?.arrival_stop?.location
      ];
      return transitSegments.filter(Boolean);
    })
    .map(normalizeLngLat)
    .filter((point): point is Coordinate => Boolean(point));
}

function normalizePoi(poi: any): PoiCandidate {
  const location = normalizeLngLat(poi.location);
  return {
    poiId: poi.id || poi.uid || '',
    name: poi.name || '',
    address: Array.isArray(poi.address) ? poi.address.join('') : poi.address || '',
    type: poi.type || '',
    location
  };
}

export function normalizeLngLat(value: any): Coordinate | undefined {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length >= 2) return [Number(value[0]), Number(value[1])];
  const lng = typeof value.getLng === 'function' ? value.getLng() : value.lng;
  const lat = typeof value.getLat === 'function' ? value.getLat() : value.lat;
  if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) return [Number(lng), Number(lat)];
  return undefined;
}

function createAmapMarkerUrl(poi: PoiCandidate): string {
  const location = poi.location;
  if (!location) return 'https://www.amap.com/';
  return `https://uri.amap.com/marker?position=${location[0]},${location[1]}&name=${encodeURIComponent(poi.name)}`;
}

function getAmapErrorInfo(status: string, result: any): string {
  if (status === 'no_data') return '高德未返回匹配 POI';
  if (status === 'error' || result?.status === '0') {
    const info = result?.info || '高德接口错误';
    const code = result?.infocode ? ` (${result.infocode})` : '';
    return `${info}${code}`;
  }
  if (status !== 'complete') return `高德搜索状态：${status}`;
  return '';
}

function isQpsLimitError(errorInfo?: string, errorCode?: string): boolean {
  const text = `${errorInfo || ''} ${errorCode || ''}`;
  return /QPS|LIMIT|限流|超限|CUQPS|USER_DAILY_QUERY_OVER_LIMIT|DAILY_QUERY_OVER_LIMIT/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

let nextAmapRequestAt = 0;

async function waitForAmapSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAmapRequestAt - now);
  nextAmapRequestAt = Math.max(now, nextAmapRequestAt) + AMAP_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}
