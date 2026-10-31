import { unmatchedRouteStops } from './stopLocations';
import { arrivalForLeg } from './transport';
import { distanceMeters } from './geo';
import {
  colorForDay,
  type Coordinate,
  type Itinerary,
  type RouteSegment,
  type Stop
} from './itinerary';

export type VideoMode =
  | 'driving'
  | 'walking'
  | 'transit'
  | 'rail'
  | 'ferry'
  | 'bus'
  | 'subway'
  | 'flight';
export type VideoItinerary = Omit<Itinerary, 'routeSegments'> & {
  routeSegments: (Omit<RouteSegment, 'mode' | 'status'> & {
    mode: RouteSegment['mode'] | 'rail' | 'ferry';
    status: RouteSegment['status'] | 'illustrative';
  })[];
};

export interface VideoSegment {
  dayIndex: number;
  toDayIndex: number;
  fromStopId: string;
  toStopId: string;
  isInterDay: boolean;
  mode: VideoMode;
  sourceMode: string;
  transport?: import('./activities').ArrivalMeta;
  illustrative: boolean;
  distanceMeters: number;
  path: Coordinate[];
  points: Coordinate[];
  color: string;
  cameraHeight: number;
  wideCameraHeight: number;
}

export interface VideoLayer {
  id: string;
  label: string;
  center: Coordinate;
  zoom: number;
  width: number;
  height: number;
  worldSize: number;
  point: Coordinate;
}

export interface VideoPlan {
  version: 1;
  itineraryId: string;
  title: string;
  itinerary: VideoItinerary;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  intro: number;
  journeyEnd: number;
  center: Coordinate;
  zoom: number;
  worldSize: number;
  metersPerWorldUnit: number;
  overviewHeight: number;
  stops: (Stop & { point: Coordinate })[];
  days: { dayIndex: number; title: string; color: string }[];
  layers: VideoLayer[];
  segments: VideoSegment[];
  events: { index: number; start: number; end: number; holdEnd: number }[];
  warnings: string[];
}

const METERS_PER_UNIT = 250;
const ATLAS_PIXELS = 4096;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function mercator(point: Coordinate): Coordinate {
  return [
    (point[0] + 180) / 360,
    (1 - Math.asinh(Math.tan((point[1] * Math.PI) / 180)) / Math.PI) / 2
  ];
}

export function inverseMercator(point: Coordinate): Coordinate {
  return [
    point[0] * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * point[1]))) * 180) / Math.PI
  ];
}

function validCoordinate(point: unknown): point is Coordinate {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    point.every(Number.isFinite) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) < 85
  );
}

function bounds(points: Coordinate[]) {
  return points.reduce(
    (box, point) => ({
      minX: Math.min(box.minX, point[0]),
      maxX: Math.max(box.maxX, point[0]),
      minY: Math.min(box.minY, point[1]),
      maxY: Math.max(box.maxY, point[1])
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
}

function mapConfiguration(id: string, label: string, points: Coordinate[]) {
  const box = bounds(points.map(mercator));
  const center = inverseMercator([
    (box.minX + box.maxX) / 2,
    (box.minY + box.maxY) / 2
  ]);
  const minSpan =
    16000 / (2 * Math.PI * 6378137 * Math.cos((center[1] * Math.PI) / 180));
  const span = Math.max(
    minSpan,
    Math.max(box.maxX - box.minX, box.maxY - box.minY) * 3.2
  );
  // The satellite SDK can round fractional zoom upward. Plan native integer
  // levels so captured bounds match the atlas and retain the full route extent.
  const zoom = Math.floor(clamp(Math.log2(ATLAS_PIXELS / (256 * span)), 3, 18));
  return { id, label, center, zoom, width: ATLAS_PIXELS, height: ATLAS_PIXELS };
}

// Same projection as the overview camera, fitted inside the visible area between the overlays.
function overviewHeight(points: Coordinate[], aspect: number): number {
  const box = bounds(points),
    cx = (box.minX + box.maxX) / 2,
    cy = (box.minY + box.maxY) / 2;
  const tilt = 0.35,
    slant = Math.sqrt(1 + tilt * tilt),
    cot = 1 / Math.tan((23 * Math.PI) / 180);
  let height = 24;
  for (let attempt = 0; attempt < 160; attempt++) {
    const fits = points.every((p) => {
      const x = p[0] - cx,
        z = p[1] - cy,
        depth = height * slant - (z * tilt) / slant;
      const px = (x * cot) / (depth * aspect),
        py = (-z * cot) / (slant * depth);
      return depth > 0 && Math.abs(px) < 0.79 && py < 0.55 && py > -0.58;
    });
    if (fits) return height * 1.12;
    height *= 1.1;
  }
  throw new Error('路线范围无法适配竖屏镜头。');
}

export function createVideoPlan(
  source: VideoItinerary,
  options: { durationSeconds?: number } = {}
): VideoPlan {
  if (!Array.isArray(source?.days) || !Array.isArray(source.routeSegments)) {
    throw new Error('需要 map-tour 行程 JSON（days 和 routeSegments）。');
  }
  if (typeof source.id !== 'string' || !source.id.trim())
    throw new Error('行程需要有效 ID。');
  if (
    source.days.some(
      (day) =>
        !Array.isArray(day.stops) ||
        !Number.isSafeInteger(day.dayIndex) ||
        day.dayIndex < 1
    )
  ) {
    throw new Error('每天需要 stops 数组和正整数 dayIndex。');
  }
  const itinerary = structuredClone(source);
  const routeDays = itinerary.days.filter((day) => day.stops.length > 0);
  const mainStops = routeDays.flatMap((day) => day.stops);
  if (!mainStops.length) throw new Error('行程没有主路线地点。');
  if (
    mainStops.some(
      (stop) =>
        typeof stop.id !== 'string' ||
        !stop.id ||
        typeof stop.name !== 'string' ||
        !stop.name.trim()
    ) ||
    routeDays.some((day) =>
      day.stops.some((stop) => stop.dayIndex !== day.dayIndex)
    )
  ) {
    throw new Error('地点需要有效 ID、名称和所属天数。');
  }
  if (new Set(mainStops.map((stop) => stop.id)).size !== mainStops.length)
    throw new Error('主路线地点 ID 重复。');
  if (new Set(routeDays.map((day) => day.dayIndex)).size !== routeDays.length)
    throw new Error('行程天数编号重复。');
  const unmatched = unmatchedRouteStops(itinerary);
  if (unmatched.length)
    throw new Error(
      `以下地点尚未匹配坐标，请先在地图中完成匹配：${unmatched.map((s) => s.name).join('、')}`
    );
  const location = (stop: Stop) => stop.poiMatch!.location!;
  const warnings: string[] = [];
  const pairs: { from: Stop; to: Stop; interDay: boolean }[] = [];
  for (let index = 0; index < routeDays.length; index++) {
    const day = routeDays[index];
    for (let i = 1; i < day.stops.length; i++)
      pairs.push({ from: day.stops[i - 1], to: day.stops[i], interDay: false });
    if (index + 1 < routeDays.length)
      pairs.push({
        from: day.stops.at(-1)!,
        to: routeDays[index + 1].stops[0],
        interDay: true
      });
  }
  if (!pairs.length)
    pairs.push({ from: mainStops[0], to: mainStops[0], interDay: false });
  const normalized = pairs.map(({ from, to, interDay }) => {
    const saved = itinerary.routeSegments.find(
      (segment) =>
        segment.fromStopId === from.id &&
        segment.toStopId === to.id &&
        Boolean(segment.isInterDay) === interDay
    );
    const transport = arrivalForLeg(from, to);
    const declaredMode = transport.mode !== 'auto' ? transport.mode : undefined;
    const usable =
      saved &&
      (!declaredMode || declaredMode === saved.mode) &&
      ['complete', 'fallback', 'illustrative'].includes(saved.status) &&
      saved.path?.length >= 2 &&
      saved.path.every(validCoordinate);
    const illustrative =
      !usable || saved.status !== 'complete' || saved.mode === 'straight';
    const path: Coordinate[] = usable
      ? [location(from), ...saved.path, location(to)]
      : [location(from), location(to)];
    const clean = path.filter(
      (point, i) => !i || distanceMeters(point, path[i - 1]) > 0.01
    );
    if (clean.length === 1) clean.push([...clean[0]]);
    const length = clean
      .slice(1)
      .reduce((sum, point, i) => sum + distanceMeters(clean[i], point), 0);
    const sourceMode = declaredMode || saved?.mode || 'straight';
    const mode: VideoMode =
      sourceMode === 'straight'
        ? length < 1200
          ? 'walking'
          : 'driving'
        : (sourceMode as VideoMode);
    if (
      ![
        'driving',
        'walking',
        'transit',
        'rail',
        'ferry',
        'bus',
        'subway',
        'flight'
      ].includes(mode)
    )
      throw new Error(`不支持的交通方式：${sourceMode}`);
    if (illustrative && from.id !== to.id)
      warnings.push(
        usable
          ? `${from.name} → ${to.name}：复用原数据中的示意路线。`
          : `${from.name} → ${to.name}：缺少完整规划路线，使用直线示意。`
      );
    const height =
      mode === 'walking'
        ? clamp(6 + Math.sqrt(length / METERS_PER_UNIT) * 1.3, 7, 11)
        : mode === 'ferry'
          ? 10
          : clamp(12 + Math.sqrt(length / METERS_PER_UNIT) * 1.4, 16, 24);
    return {
      dayIndex: from.dayIndex,
      toDayIndex: to.dayIndex,
      fromStopId: from.id,
      toStopId: to.id,
      isInterDay: interDay,
      mode,
      sourceMode,
      transport: saved?.transport || transport,
      illustrative,
      distanceMeters: length,
      path: clean,
      cameraHeight: interDay && length < 50000 ? Math.max(height, 26) : height,
      wideCameraHeight:
        length > 50000
          ? Math.max(height, (length / METERS_PER_UNIT) * 0.85)
          : height,
      color: interDay ? '#8b9d99' : colorForDay(from.dayIndex)
    };
  });
  const allCoordinates = [
    ...mainStops.map(location),
    ...normalized.flatMap((s) => s.path)
  ];
  const region = mapConfiguration('region', '', allCoordinates),
    origin = mercator(region.center);
  const span = ATLAS_PIXELS / (256 * 2 ** region.zoom);
  const worldSize =
    (2 *
      Math.PI *
      6378137 *
      Math.cos((region.center[1] * Math.PI) / 180) *
      span) /
    METERS_PER_UNIT;
  const project = (point: Coordinate): Coordinate => {
    const p = mercator(point);
    return [0.5 + (p[0] - origin[0]) / span, 0.5 + (p[1] - origin[1]) / span];
  };
  const groups: { label: string; stops: Stop[] }[] = [];
  for (const stop of mainStops) {
    const label =
      stop.city?.trim() || itinerary.tripScope?.primaryCity?.trim() || '';
    let group = groups.find(
      (g) =>
        g.label === label &&
        distanceMeters(location(g.stops[0]), location(stop)) < 80000
    );
    if (!group) {
      group = { label, stops: [] };
      groups.push(group);
    }
    group.stops.push(stop);
  }
  const mapConfigs = [region];
  if (groups.length > 1)
    for (const [index, group] of groups.entries()) {
      const ids = new Set(group.stops.map((stop) => stop.id));
      const coordinates = [
        ...group.stops.map(location),
        ...normalized
          .filter((s) => ids.has(s.fromStopId) && ids.has(s.toStopId))
          .flatMap((s) => s.path)
      ];
      mapConfigs.push(
        mapConfiguration(
          `area-${index + 1}`,
          group.label || `区域 ${index + 1}`,
          coordinates
        )
      );
    }
  const layers = mapConfigs.map((m) => ({
    ...m,
    point: project(m.center),
    worldSize: worldSize * 2 ** (region.zoom - m.zoom)
  }));
  const fps = 30,
    introFrames = 90,
    outroFrames = 120,
    holdFrames = 45,
    minMovementFrames = 24;
  const holds = normalized.map((s) => {
    const activity = mainStops.find((stop) => stop.id === s.toStopId)?.activity
      ?.kind;
    return activity === 'stay' ? 105 : activity === 'meal' ? 75 : holdFrames;
  });
  const holdTotal = holds.reduce((a, b) => a + b, 0);
  const requestedDuration =
    options.durationSeconds ?? clamp(7 + normalized.length * 6.5, 26, 180);
  if (!Number.isFinite(requestedDuration) || requestedDuration > 180)
    throw new Error('本地预览时长需要为有限正数，最长 180 秒。');
  const frames = Math.round(requestedDuration * fps),
    movementFrames = frames - introFrames - outroFrames - holdTotal;
  if (movementFrames < minMovementFrames * normalized.length) {
    throw new Error(
      `时长过短：${normalized.length} 段路线至少需要 ${Math.ceil((introFrames + outroFrames + holdTotal + minMovementFrames * normalized.length) / fps)} 秒。`
    );
  }
  const weights = normalized.map(
    (s) =>
      1 +
      Math.log1p(s.distanceMeters / 500) * 0.45 +
      (s.wideCameraHeight > s.cameraHeight ? 2 : 0)
  );
  const weightTotal = weights.reduce((a, b) => a + b, 0),
    spare = movementFrames - minMovementFrames * weights.length;
  const allocated = weights.map(
    (w) => minMovementFrames + Math.floor((spare * w) / weightTotal)
  );
  for (
    let i = 0,
      remainder = movementFrames - allocated.reduce((a, b) => a + b, 0);
    i < remainder;
    i++
  )
    allocated[i % allocated.length]++;
  let cursor = introFrames;
  const events = normalized.map((_, index) => {
    const start = cursor / fps;
    cursor += allocated[index];
    const end = cursor / fps;
    cursor += holds[index];
    return { index, start, end, holdEnd: cursor / fps };
  });
  const points = allCoordinates
    .map(project)
    .map(
      (p) => [(p[0] - 0.5) * worldSize, (p[1] - 0.5) * worldSize] as Coordinate
    );
  return {
    version: 1,
    itineraryId: itinerary.id,
    title: itinerary.title || `${routeDays.length}天旅行`,
    itinerary,
    width: 1080,
    height: 1920,
    fps,
    frames,
    duration: frames / fps,
    intro: introFrames / fps,
    journeyEnd: cursor / fps,
    center: region.center,
    zoom: region.zoom,
    worldSize,
    metersPerWorldUnit: METERS_PER_UNIT,
    overviewHeight: overviewHeight(points, 1080 / 1920),
    layers,
    stops: mainStops.map((stop) => ({
      ...stop,
      point: project(location(stop))
    })),
    days: routeDays.map((day) => ({
      dayIndex: day.dayIndex,
      title: day.title,
      color: colorForDay(day.dayIndex)
    })),
    segments: normalized.map((s) => ({ ...s, points: s.path.map(project) })),
    events,
    warnings
  };
}

export interface VideoViewSample {
  height: number;
  mode: string;
  points: Coordinate[];
}

export function createDetailPlan(
  plan: VideoPlan,
  samples: VideoViewSample[],
  maxTiles = 300
) {
  const origin = mercator(plan.center),
    span = ATLAS_PIXELS / (256 * 2 ** plan.zoom);
  const tiles = new Map<
    string,
    {
      id: string;
      zoom: number;
      center: Coordinate;
      width: number;
      height: number;
      cx: number;
      cz: number;
      worldSize: number;
    }
  >();
  const add = (zoom: number, points: Coordinate[]) => {
    if (!points.length || !points.every(validCoordinatePair)) return;
    const size = 2048 / (256 * 2 ** zoom);
    const coordinates = points.map(
      (p) =>
        [
          origin[0] + (p[0] / plan.worldSize) * span,
          origin[1] + (p[1] / plan.worldSize) * span
        ] as Coordinate
    );
    const box = bounds(coordinates),
      x0 = Math.floor(box.minX / size),
      x1 = Math.floor(box.maxX / size),
      y0 = Math.floor(box.minY / size),
      y1 = Math.floor(box.maxY / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles)
      throw new Error('单个镜头需要的高清底图过多，请检查路线坐标。');
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = `z${zoom}-${x}-${y}`,
          mx = (x + 0.5) * size,
          my = (y + 0.5) * size;
        tiles.set(id, {
          id,
          zoom,
          center: inverseMercator([mx, my]),
          width: 2048,
          height: 2048,
          cx: ((mx - origin[0]) / span) * plan.worldSize,
          cz: ((my - origin[1]) / span) * plan.worldSize,
          worldSize: (size / span) * plan.worldSize
        });
        if (tiles.size > maxTiles)
          throw new Error(
            `高清底图超过 ${maxTiles} 张；可用 --max-detail-tiles 增加本次本地上限。`
          );
      }
  };
  for (const sample of samples) {
    if (sample.height > 45) continue;
    add(16, sample.points);
    if (sample.height < 14) add(17, sample.points);
  }
  for (const stop of plan.stops) {
    const x = (stop.point[0] - 0.5) * plan.worldSize,
      z = (stop.point[1] - 0.5) * plan.worldSize;
    add(17, [
      [x - 5, z - 5],
      [x + 5, z + 5]
    ]);
  }
  return {
    patchPixels: 2048,
    levels: [16, 17],
    samples: samples.length,
    tiles: [...tiles.values()]
  };
}

function validCoordinatePair(point: Coordinate) {
  return (
    Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
  );
}
