import {
  getDayActivityOptions,
  getMapOnlyActivities,
  optionalPlaceKey
} from './shared/optionalPlaces';
import {
  candidateFitsRegion,
  placeQueries,
  placeSearchContext
} from './shared/placeContext';
import { arrivalForLeg, journeyLegs } from './shared/transport';
import {
  pickBestPoiCandidate,
  estimatePoiConfidence
} from './shared/poiMatching';
import { activitySymbol } from './shared/activities';
import AMapLoader from '@amap/amap-jsapi-loader';
import { chooseRouteMode, distanceMeters } from './shared/geo';
import { getVisibleDays } from './shared/itinerary';
import { atlasDayColor, placeMapLabels } from './shared/mapPresentation';
import { journeyMapPalette, resolveJourneyMapStyle } from './shared/mapTheme';
import type {
  Coordinate,
  Itinerary,
  PoiCandidate,
  PoiMatch,
  PoiSearchContext,
  RoutePreference,
  RouteSegment,
  Stop
} from './shared/itinerary';

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

export async function loadAMap(
  key: string,
  useProxy: boolean
): Promise<AMapNamespace> {
  if (useProxy) {
    window._AMapSecurityConfig = {
      serviceHost: `${window.location.origin}/_AMapService`
    };
  }

  return AMapLoader.load({
    key,
    version: '2.0',
    plugins: [
      'AMap.Scale',
      'AMap.ToolBar',
      'AMap.PlaceSearch',
      'AMap.Geocoder',
      'AMap.Driving',
      'AMap.Walking',
      'AMap.Transfer'
    ]
  });
}

export async function enrichItineraryWithAmap(
  AMap: AMapNamespace,
  itinerary: Itinerary,
  routePreference: RoutePreference = 'auto',
  connectDays = true,
  onProgress?: (message: string) => void,
  refineTransport?: (itinerary: Itinerary) => Promise<Itinerary>
): Promise<Itinerary> {
  const next: Itinerary = structuredClone(itinerary);
  const regionCache = new Map<string, Promise<PoiSearchContext>>();
  const changedStopIds = new Set<string>();
  const mainStops = next.days.flatMap((day) => day.stops);
  const alternativeStops = [
    ...next.days.flatMap((day) => day.alternatives),
    ...next.alternatives
  ];
  for (const day of next.days)
    day.activityOptions = getDayActivityOptions(day, next.recommendations).map(
      (option) => day.stops.find((stop) => stop.id === option.id) || option
    );
  const optionalStops = next.days
    .flatMap((day) => day.activityOptions || [])
    .filter((stop) => !mainStops.some((main) => main.id === stop.id));
  const allStops = [...mainStops, ...alternativeStops, ...optionalStops];
  const matchCache = new Map<string, PoiMatch>();
  const routeStopIds = new Set(mainStops.map((stop) => stop.id));

  for (let index = 0; index < allStops.length; index += 1) {
    const stop = allStops[index];
    if (
      stop.poiMatch?.matchVersion === 2 &&
      (stop.poiMatch.status === 'matched' ||
        stop.poiMatch.status === 'unmatched')
    )
      continue;
    onProgress?.(`匹配地点 ${index + 1}/${allStops.length}: ${stop.name}`);
    const previousLocation = stop.poiMatch?.location;
    const context = await resolvePlaceContext(
      AMap,
      placeSearchContext(stop, next.tripScope),
      regionCache
    );
    stop.province ||= context.province;
    stop.city = context.city || stop.city;
    stop.district ||= context.district;
    const key = JSON.stringify([
      context,
      stop.activity?.searchName || stop.name,
      stop.activity?.kind,
      stop.activity?.placeKind
    ]);
    stop.poiMatch = structuredClone(
      matchCache.get(key) ||
        (await matchStop(AMap, stop, next.tripScope, context))
    );
    matchCache.set(key, stop.poiMatch);
    if (
      routeStopIds.has(stop.id) &&
      JSON.stringify(previousLocation) !==
        JSON.stringify(stop.poiMatch.location)
    )
      changedStopIds.add(stop.id);
  }

  next.routeSegments = next.routeSegments.filter(
    (segment) =>
      !changedStopIds.has(segment.fromStopId) &&
      !changedStopIds.has(segment.toStopId)
  );

  if (refineTransport) {
    onProgress?.(
      next.transportReviewLegs
        ? `仅识别 ${next.transportReviewLegs.length} 段变动交通，复用 ${next.routeSegments.length} 段原路线…`
        : '模型正在识别相邻地点和跨天交通…'
    );
    Object.assign(next, await refineTransport(next));
  }
  const existingSegments = new Map(
    next.routeSegments.map((segment) => [routeSegmentKey(segment), segment])
  );
  const routeSegments: RouteSegment[] = [];
  for (const plan of buildRoutePlans(next.days, connectDays)) {
    const existing = existingSegments.get(routeSegmentKey(plan));
    const requested = arrivalForLeg(plan.from, plan.to).mode;
    if (existing && (requested === 'auto' || existing.mode === requested)) {
      routeSegments.push(existing);
      continue;
    }
    onProgress?.(
      plan.isInterDay
        ? `规划跨天路线 D${plan.dayIndex} → D${plan.toDayIndex}: ${plan.from.label} → ${plan.to.label}`
        : `规划路线 ${plan.from.label} → ${plan.to.label}`
    );
    routeSegments.push(await planRoute(AMap, plan, routePreference));
  }
  next.routeSegments = routeSegments;
  next.updatedAt = new Date().toISOString();
  return next;
}

interface RoutePlan {
  dayIndex: number;
  toDayIndex?: number;
  fromStopId: string;
  toStopId: string;
  from: Stop;
  to: Stop;
  isInterDay?: boolean;
}

function buildRoutePlans(
  days: Itinerary['days'],
  connectDays: boolean
): RoutePlan[] {
  return journeyLegs({ days }, connectDays).map(({ from, to, isInterDay }) => ({
    dayIndex: from.dayIndex,
    toDayIndex: isInterDay ? to.dayIndex : undefined,
    fromStopId: from.id,
    toStopId: to.id,
    from,
    to,
    isInterDay
  }));
}

function routeSegmentKey(
  segment: Pick<
    RouteSegment,
    'dayIndex' | 'toDayIndex' | 'fromStopId' | 'toStopId' | 'isInterDay'
  >
): string {
  return `${segment.isInterDay ? 'inter' : 'day'}:${segment.dayIndex}-${segment.toDayIndex || segment.dayIndex}:${segment.fromStopId}->${segment.toStopId}`;
}

function adminText(value: unknown): string {
  return Array.isArray(value)
    ? value.join('')
    : typeof value === 'string'
      ? value
      : '';
}

async function resolvePlaceContext(
  AMap: AMapNamespace,
  context: PoiSearchContext,
  cache: Map<string, Promise<PoiSearchContext>>
): Promise<PoiSearchContext> {
  const address = [
    ...new Set(
      [context.province, context.city, context.district].filter(Boolean)
    )
  ].join('');
  if (!address || !AMap.Geocoder) return context;
  if (!cache.has(address)) {
    cache.set(
      address,
      (async () => {
        for (let attempt = 0; attempt <= MAX_AMAP_RETRIES; attempt++) {
          await waitForAmapSlot();
          const result: any = await new Promise((resolve) =>
            new AMap.Geocoder().getLocation(
              address,
              (status: string, data: any) => resolve({ status, data })
            )
          );
          const place = result.data?.geocodes?.[0];
          const admin = place?.addressComponent || place;
          if (
            result.status === 'complete' &&
            place &&
            candidateFitsRegion(
              {
                name: '',
                province: adminText(admin.province),
                city: adminText(admin.city),
                district: adminText(admin.district)
              },
              context
            )
          )
            return {
              ...context,
              province: context.province || adminText(admin.province),
              city: adminText(admin.city) || context.city,
              district: context.district || adminText(admin.district),
              adcode: adminText(place.adcode),
              center: normalizeLngLat(place.location)
            };
          if (
            !isQpsLimitError(result.data?.info, result.data?.infocode) ||
            attempt === MAX_AMAP_RETRIES
          )
            break;
          await sleep(QPS_RETRY_DELAY_MS * (attempt + 1));
        }
        return context;
      })()
    );
  }
  const resolved = await cache.get(address)!;
  return { ...resolved, locationHint: context.locationHint };
}

async function matchStop(
  AMap: AMapNamespace,
  stop: Stop,
  tripScope: Itinerary['tripScope'],
  context: PoiSearchContext
): Promise<PoiMatch> {
  const searchCity =
    context.adcode ||
    context.district ||
    context.city ||
    context.province ||
    '';
  const candidates: PoiCandidate[] = [];
  let errorInfo = '';
  let errorCode = '';
  let lastQuery = '';
  for (const query of placeQueries(stop, context)) {
    lastQuery = query;
    for (let attempt = 0; attempt <= MAX_AMAP_RETRIES; attempt++) {
      await waitForAmapSlot();
      const result: any = await new Promise((resolve) => {
        const search = new AMap.PlaceSearch({
          city: searchCity || undefined,
          citylimit: Boolean(searchCity),
          pageSize: 20,
          pageIndex: 1,
          extensions: 'all'
        });
        search.search(query, (status: string, data: any) =>
          resolve({ status, data })
        );
      });
      errorInfo = getAmapErrorInfo(result.status, result.data);
      errorCode = result.data?.infocode || result.status;
      if (isQpsLimitError(errorInfo, errorCode) && attempt < MAX_AMAP_RETRIES) {
        await sleep(QPS_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      for (const raw of result.data?.poiList?.pois || []) {
        const candidate = normalizePoi(raw);
        if (
          candidate.location &&
          candidateFitsRegion(candidate, context) &&
          !candidates.some((p) =>
            p.poiId
              ? p.poiId === candidate.poiId
              : p.name === candidate.name &&
                JSON.stringify(p.location) ===
                  JSON.stringify(candidate.location)
          )
        )
          candidates.push(candidate);
      }
      break;
    }
  }
  const best = pickBestPoiCandidate(
    candidates,
    stop,
    context.city || '',
    tripScope,
    context
  );
  const searchContext = { ...context, query: lastQuery };
  if (best?.location)
    return {
      ...best,
      status: 'matched',
      matchVersion: 2,
      searchContext,
      confidence: estimatePoiConfidence(
        best,
        stop,
        context.city || '',
        tripScope
      ),
      amapUrl: createAmapMarkerUrl(best),
      candidates
    };
  return {
    status: 'unmatched',
    matchVersion: 2,
    searchContext,
    name: stop.name,
    confidence: 0,
    candidates,
    errorInfo:
      errorInfo ||
      (searchCity
        ? '未找到符合指定省市区的地点，请补充景区或乡镇名称'
        : '未匹配到高德 POI，请补充省市区'),
    errorCode
  };
}

async function planRoute(
  AMap: AMapNamespace,
  plan: RoutePlan,
  routePreference: RoutePreference
): Promise<RouteSegment> {
  const { dayIndex, toDayIndex, from, to, fromStopId, toStopId, isInterDay } =
    plan;
  const start = from.poiMatch?.location;
  const end = to.poiMatch?.location;
  if (!start || !end) {
    return {
      dayIndex,
      toDayIndex,
      fromStopId,
      toStopId,
      isInterDay,
      mode: 'straight',
      status: 'failed',
      path: []
    };
  }

  const directDistance = distanceMeters(start, end);
  const transport = arrivalForLeg(from, to);
  const declared = transport.mode;
  if (declared === 'ferry' || declared === 'rail' || declared === 'flight') {
    return {
      dayIndex,
      toDayIndex,
      fromStopId,
      toStopId,
      isInterDay,
      mode: declared,
      transport,
      steps: transport.steps,
      status: 'fallback',
      distanceMeters: directDistance,
      path: [start, end]
    };
  }
  const mode =
    routePreference === 'auto'
      ? declared && declared !== 'auto'
        ? declared
        : chooseRouteMode(directDistance)
      : routePreference;
  const planned =
    mode === 'walking'
      ? await searchWalkingRoute(AMap, start, end)
      : ['transit', 'bus', 'subway'].includes(mode)
        ? await searchTransitRoute(AMap, start, end, from.city || to.city || '')
        : await searchDrivingRoute(AMap, start, end);

  if (planned.path.length > 1) {
    return {
      dayIndex,
      toDayIndex,
      fromStopId,
      toStopId,
      isInterDay,
      mode,
      transport,
      steps: transport.steps,
      status: 'complete',
      distanceMeters: planned.distanceMeters || directDistance,
      durationSeconds: planned.durationSeconds,
      path: planned.path
    };
  }

  return {
    dayIndex,
    toDayIndex,
    fromStopId,
    toStopId,
    isInterDay,
    mode,
    transport,
    steps: transport.steps,
    status: 'fallback',
    distanceMeters: directDistance,
    path: [start, end]
  };
}

function searchDrivingRoute(
  AMap: AMapNamespace,
  start: Coordinate,
  end: Coordinate
) {
  const driving = new AMap.Driving({
    policy: AMap.DrivingPolicy.LEAST_TIME,
    showTraffic: false
  });
  return searchRoute(driving, start, end, 'steps');
}

function searchWalkingRoute(
  AMap: AMapNamespace,
  start: Coordinate,
  end: Coordinate
) {
  const walking = new AMap.Walking();
  return searchRoute(walking, start, end, 'steps');
}

function searchTransitRoute(
  AMap: AMapNamespace,
  start: Coordinate,
  end: Coordinate,
  city: string
) {
  const transfer = new AMap.Transfer({
    city: city || undefined,
    policy: AMap.TransferPolicy.LEAST_TIME
  });
  return searchRoute(transfer, start, end, 'segments');
}

function searchRoute(
  planner: any,
  start: Coordinate,
  end: Coordinate,
  stepsKey: string
) {
  return searchRouteWithRetry(planner, start, end, stepsKey, 0);
}

function searchRouteWithRetry(
  planner: any,
  start: Coordinate,
  end: Coordinate,
  stepsKey: string,
  attempt: number
): Promise<{
  path: Coordinate[];
  distanceMeters?: number;
  durationSeconds?: number;
}> {
  return waitForAmapSlot()
    .then(
      () =>
        new Promise<{
          path: Coordinate[];
          distanceMeters?: number;
          durationSeconds?: number;
          errorInfo?: string;
          errorCode?: string;
        }>((resolve) => {
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
        })
    )
    .then(async (result) => {
      if (
        isQpsLimitError(result.errorInfo, result.errorCode) &&
        attempt < MAX_AMAP_RETRIES
      ) {
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
        ...(step.walking?.steps || []).flatMap(
          (walkStep: any) => walkStep.path || []
        ),
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
    address: Array.isArray(poi.address)
      ? poi.address.join('')
      : poi.address || '',
    province: adminText(poi.pname || poi.province),
    city: adminText(poi.cityname || poi.city),
    district: adminText(poi.adname || poi.district),
    adcode: adminText(poi.adcode),
    type: poi.type || '',
    location
  };
}

export function normalizeLngLat(value: any): Coordinate | undefined {
  if (!value) return undefined;
  if (Array.isArray(value) && value.length >= 2)
    return [Number(value[0]), Number(value[1])];
  const lng = typeof value.getLng === 'function' ? value.getLng() : value.lng;
  const lat = typeof value.getLat === 'function' ? value.getLat() : value.lat;
  if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat)))
    return [Number(lng), Number(lat)];
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
  return /QPS|LIMIT|限流|超限|CUQPS|USER_DAILY_QUERY_OVER_LIMIT|DAILY_QUERY_OVER_LIMIT/i.test(
    text
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

let nextAmapRequestAt = 0;

async function waitForAmapSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAmapRequestAt - now);
  nextAmapRequestAt =
    Math.max(now, nextAmapRequestAt) + AMAP_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}

export type JourneyMapAppearance = 'atlas' | 'satellite';
export interface JourneyMapDrawing {
  overlays: any[];
  stopLookup: Map<
    string,
    {
      marker: any;
      stop: Stop;
      location: Coordinate;
      infoWindow: any;
      activityActions?: {
        choices: Stop[];
        included: boolean;
        busy: boolean;
        pending?: boolean;
        onToggle: (dayIndex: number, option: Stop, include: boolean) => void;
      };
    }
  >;
  select: (stopId: string | null) => void;
  layout: () => void;
  setAppearance: (appearance: JourneyMapAppearance) => void;
  dispose: () => void;
}

export function createJourneyMap(
  AMap: AMapNamespace,
  container: HTMLElement,
  mapStyle?: string
) {
  const map = new AMap.Map(container, {
    viewMode: '3D',
    zoom: 5,
    center: [104.195, 35.861],
    pitch: 0,
    mapStyle: resolveJourneyMapStyle(mapStyle),
    features: ['bg', 'road', 'building'],
    showLabel: false,
    isHotspot: false,
    showIndoorMap: false,
    showBuildingBlock: true,
    roofColor: journeyMapPalette.buildingRoof,
    wallColor: journeyMapPalette.buildingWall
  });
  map.addControl(new AMap.Scale());
  const layers = map.getLayers();
  let satellite: any;
  return {
    map,
    setAppearance: (appearance: JourneyMapAppearance) => {
      if (appearance === 'satellite') {
        satellite ||= new AMap.TileLayer.Satellite();
        map.setFeatures(['bg', 'road']);
        map.setLayers([satellite]);
      } else {
        map.setLayers(layers);
        map.setFeatures(['bg', 'road', 'building']);
      }
    }
  };
}

export function drawJourneyMap(
  AMap: AMapNamespace,
  map: any,
  container: HTMLElement,
  itinerary: Itinerary,
  activeDay: number | 'all',
  onStopSelect: (stopId: string) => void,
  showRoutes: boolean,
  showNames: boolean,
  initiallySelected: string | null,
  onActivityToggle?: (dayIndex: number, option: Stop, include: boolean) => void,
  activityBusy = false,
  pendingActivityChanges = false
): JourneyMapDrawing {
  const overlays: any[] = [];
  const routeLines: { line: any; casing: boolean; dayIndex: number }[] = [];
  const stopLookup: JourneyMapDrawing['stopLookup'] = new Map();
  const roots: {
    stop: Stop;
    marker: any;
    location: Coordinate;
    root: HTMLElement;
    label: HTMLElement;
  }[] = [];
  const days = getVisibleDays(itinerary, activeDay);
  const segments = itinerary.routeSegments.filter((segment) =>
    segment.isInterDay
      ? activeDay === 'all'
      : activeDay === 'all' || segment.dayIndex === activeDay
  );
  if (showRoutes)
    for (const segment of segments) {
      if (segment.path.length < 2) continue;
      const dashed = segment.status === 'fallback' || segment.isInterDay;
      const width = activeDay === 'all' ? 3.5 : 4.5;
      for (const casing of [true, false]) {
        const line = new AMap.Polyline({
          path: segment.path,
          strokeColor: casing ? '#0b182e' : atlasDayColor(segment.dayIndex),
          strokeWeight: casing ? width + 3 : width,
          strokeOpacity: casing ? 0.65 : dashed ? 0.68 : 0.94,
          strokeStyle: dashed ? 'dashed' : 'solid',
          strokeDasharray: [6, 7],
          lineJoin: 'round',
          lineCap: 'round',
          zIndex: casing ? 19 : 20
        });
        map.add(line);
        overlays.push(line);
        routeLines.push({ line, casing, dayIndex: segment.dayIndex });
      }
    }
  const infoWindow = new AMap.InfoWindow({
    isCustom: true,
    autoMove: true,
    closeWhenClickMap: true,
    offset: new AMap.Pixel(0, -21)
  });
  const mapOnly = getMapOnlyActivities(itinerary, activeDay);
  const optionalLookup = new Map(
    mapOnly.map((group) => [group.stop.id, group.choices])
  );
  const stops = [
    ...days.flatMap((day) => day.stops),
    ...days.flatMap((day) => day.alternatives),
    ...(activeDay === 'all' ? itinerary.alternatives : []),
    ...mapOnly.map((group) => group.stop)
  ];
  for (const stop of stops) {
    const location = stop.poiMatch?.location;
    if (!location || !location.every(Number.isFinite)) continue;
    const root = document.createElement('div');
    const mapOnlyStop = optionalLookup.has(stop.id);
    const isActivity =
      stop.activity?.kind === 'meal' || stop.activity?.kind === 'stay';
    root.className = `journey-map-stop ${isActivity ? 'is-' + stop.activity!.kind : ''} ${mapOnlyStop ? 'is-map-only' : ''} ${stop.isAlternative ? 'is-alternative' : ''}`;
    root.style.setProperty(
      '--stop-color',
      isActivity
        ? stop.activity?.kind === 'meal'
          ? '#e4a462'
          : '#9d9be8'
        : stop.isAlternative
          ? '#a0abc0'
          : atlasDayColor(stop.dayIndex || 1)
    );
    root.setAttribute('role', 'button');
    root.tabIndex = 0;
    root.setAttribute(
      'aria-label',
      `${mapOnlyStop ? '地图备选 ' : ''}${stop.label} ${stop.name}`
    );
    root.dataset.stopId = stop.id;
    const dot = document.createElement('span');
    dot.className = 'journey-map-dot';
    dot.textContent =
      activitySymbol(stop) ||
      (activeDay === 'all'
        ? stop.label.replace(/^D/i, '').replace('-', '·')
        : stop.label.split('-').at(-1) || '·');
    const label = document.createElement('span');
    label.className = 'journey-place-label';
    label.textContent =
      (stop.activity?.kind === 'stay' && stop.activity.placeKind === 'area'
        ? '住宿片区 · '
        : mapOnlyStop && stop.activity?.kind === 'meal'
          ? '用餐 · '
          : mapOnlyStop && stop.activity?.kind === 'stay'
            ? '住宿 · '
            : '') + stop.name;
    root.append(dot, label);
    const marker = new AMap.Marker({
      position: location,
      content: root,
      offset: new AMap.Pixel(
        mapOnlyStop ? (stop.activity?.kind === 'stay' ? -34 : 6) : -14,
        mapOnlyStop ? -2 : -14
      ),
      zIndex: stop.isAlternative ? 80 : 100
    });
    const activate = () => {
      onStopSelect(stop.id);
      openJourneyStop(map, stopLookup.get(stop.id)!);
    };
    root.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        activate();
      }
    });
    map.add(marker);
    overlays.push(marker);
    const hit: JourneyMapDrawing['stopLookup'] extends Map<string, infer T>
      ? T
      : never = { marker, stop, location, infoWindow };
    if (isActivity && onActivityToggle)
      hit.activityActions = {
        choices: optionalLookup.get(stop.id) || [stop],
        included: !mapOnlyStop,
        busy: activityBusy,
        pending: pendingActivityChanges,
        onToggle: onActivityToggle
      };
    stopLookup.set(stop.id, hit);
    for (const choice of optionalLookup.get(stop.id) || [])
      stopLookup.set(choice.id, { ...hit, stop: choice });
    roots.push({ stop, marker, location, root, label });
  }
  // Equivalent recommendations on another day focus the same physical map marker.
  for (const day of days)
    for (const option of getDayActivityOptions(
      day,
      itinerary.recommendations
    )) {
      if (stopLookup.has(option.id)) continue;
      const hit = [...stopLookup.values()].find(
        (hit) => optionalPlaceKey(hit.stop) === optionalPlaceKey(option)
      );
      if (hit) stopLookup.set(option.id, { ...hit, stop: option });
    }
  let selected = initiallySelected,
    disposed = false,
    queued = 0;
  function layout() {
    if (disposed) return;
    const points = roots.map((entry, index) => {
      const pixel = map.lngLatToContainer(entry.location);
      return {
        id: entry.stop.id,
        x:
          pixel.x +
          (optionalLookup.has(entry.stop.id)
            ? entry.stop.activity?.kind === 'stay'
              ? -20
              : 20
            : 0),
        y: pixel.y + (optionalLookup.has(entry.stop.id) ? 12 : 0),
        width: entry.label.offsetWidth || 100,
        height: entry.label.offsetHeight || 26,
        priority:
          stopLookup.get(selected || '')?.marker === entry.marker
            ? 1000
            : optionalLookup.has(entry.stop.id)
              ? -150
              : entry.stop.isAlternative
                ? -100
                : roots.length - index
      };
    });
    const placed = new Map(
      (showNames
        ? placeMapLabels(points, {
            width: container.clientWidth,
            height: container.clientHeight,
            top: container.clientWidth < 600 ? 88 : 110,
            bottom: 56,
            left: 16,
            right: 62
          })
        : []
      ).map((p) => [p.id, p])
    );
    for (const [index, entry] of roots.entries()) {
      const box = placed.get(entry.stop.id),
        point = points[index];
      entry.label.style.opacity = box ? '1' : '0';
      entry.label.style.pointerEvents = box ? 'auto' : 'none';
      if (box) {
        entry.label.style.left = `${14 + box.x - point.x}px`;
        entry.label.style.top = `${14 + box.y - point.y}px`;
      }
    }
  }
  function schedule() {
    if (disposed || queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      layout();
    });
  }
  function select(stopId: string | null) {
    selected = stopId;
    for (const entry of roots) {
      entry.root.classList.toggle(
        'is-selected',
        stopLookup.get(selected || '')?.marker === entry.marker
      );
      entry.marker.setzIndex(
        entry.stop.id === selected ? 500 : entry.stop.isAlternative ? 80 : 100
      );
    }
    schedule();
  }
  const events = [
    'mapmove',
    'moveend',
    'zoomend',
    'complete',
    'resize',
    'rotatechange',
    'pitchchange'
  ];
  for (const name of events) map.on(name, schedule);
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  void document.fonts.ready.then(schedule);
  select(selected);
  schedule();
  function setAppearance(appearance: JourneyMapAppearance) {
    const light = appearance === 'atlas';
    for (const { line, casing, dayIndex } of routeLines) {
      line.setOptions({
        strokeColor: casing
          ? light
            ? '#ffffff'
            : '#0b182e'
          : atlasDayColor(dayIndex, light)
      });
    }
    for (const { root, stop } of roots) {
      root.style.setProperty(
        '--stop-color',
        stop.activity?.kind === 'meal'
          ? light
            ? '#bc7836'
            : '#e4a462'
          : stop.activity?.kind === 'stay'
            ? light
              ? '#7670bf'
              : '#9d9be8'
            : stop.isAlternative
              ? light
                ? '#6c7e90'
                : '#a0abc0'
              : atlasDayColor(stop.dayIndex || 1, light)
      );
    }
  }
  return {
    overlays,
    stopLookup,
    select,
    layout: schedule,
    setAppearance,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(queued);
      observer.disconnect();
      for (const name of events) map.off(name, schedule);
      infoWindow.close();
      map.remove(overlays);
    }
  };
}

export function openJourneyStop(
  map: any,
  hit: JourneyMapDrawing['stopLookup'] extends Map<string, infer T> ? T : never
) {
  // Finish centering before opening: animated centering races InfoWindow's auto-pan.
  map.setZoomAndCenter(
    Math.min(16, Math.max(map.getZoom() || 13, 14)),
    hit.location,
    true
  );
  const panel = document.createElement('div');
  panel.className = 'journey-poi-card';
  const close = document.createElement('button');
  close.className = 'journey-poi-close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭地点详情');
  close.onclick = () => hit.infoWindow.close();
  const label = document.createElement('small');
  label.className = 'journey-poi-index';
  label.textContent = hit.stop.label;
  const heading = document.createElement('strong');
  heading.textContent = hit.stop.name;
  panel.append(close, label, heading);
  if (hit.stop.note) {
    const note = document.createElement('p');
    note.textContent = hit.stop.note;
    panel.append(note);
  }
  if (hit.stop.poiMatch?.address) {
    const address = document.createElement('small');
    address.textContent = hit.stop.poiMatch.address;
    panel.append(address);
  }
  const link = document.createElement('a');
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = '打开地点 ↗';
  link.href = `https://uri.amap.com/marker?position=${hit.location.join(',')}&name=${encodeURIComponent(hit.stop.name)}`;
  panel.append(link);
  const actions = hit.activityActions;
  if (actions) {
    const hint = document.createElement('small');
    hint.className = 'journey-poi-route-hint';
    hint.textContent = actions.pending
      ? '选择已暂存，点击「更新路线」后生效。'
      : actions.included
        ? '已加入路线，会出现在旅程视频中。'
        : '仅在地图展示，加入后才会连线和出现在视频中。';
    panel.append(hint);
    let choice =
      actions.choices.find((stop) => stop.id === hit.stop.id) ||
      actions.choices[0];
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'journey-poi-route-toggle';
    toggle.disabled = actions.busy;
    const updateLabel = () => {
      toggle.textContent = actions.busy
        ? '正在更新路线…'
        : actions.included
          ? '从第 ' + choice.dayIndex + ' 天路线移除'
          : '加入第 ' + choice.dayIndex + ' 天路线';
    };
    if (actions.choices.length > 1) {
      const picker = document.createElement('div');
      picker.className = 'journey-poi-day-picker';
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', '选择加入哪一天');
      for (const option of actions.choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '第 ' + option.dayIndex + ' 天';
        button.setAttribute('aria-pressed', String(choice.id === option.id));
        button.disabled = actions.busy;
        button.onclick = () => {
          choice = option;
          for (const other of picker.children)
            other.setAttribute('aria-pressed', String(other === button));
          updateLabel();
        };
        picker.append(button);
      }
      panel.append(picker);
    }
    updateLabel();
    toggle.onclick = () => {
      hit.infoWindow.close();
      actions.onToggle(choice.dayIndex, choice, !actions.included);
    };
    panel.append(toggle);
  }
  hit.infoWindow.setContent(panel);
  hit.infoWindow.open(map, hit.location);
}
