import type { Coordinate, Itinerary, PoiCandidate, Stop } from './itinerary';
import { routeUpdateForEdit } from './routeUpdates';

export function hasValidLocation(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) < 85
  );
}

export function unmatchedRouteStops(
  itinerary: Pick<Itinerary, 'days'>
): Stop[] {
  return itinerary.days
    .flatMap((day) => day.stops)
    .filter(
      (stop) =>
        stop.poiMatch?.status !== 'matched' ||
        !hasValidLocation(stop.poiMatch.location)
    );
}

export function updateStopLocation(
  itinerary: Itinerary,
  stopId: string,
  candidate: PoiCandidate
): Itinerary {
  if (!candidate.name.trim() || !hasValidLocation(candidate.location))
    throw new Error('请选择有有效坐标的地点。');
  const next = structuredClone(itinerary);
  const stops = [
    ...next.days.flatMap((day) => [
      ...day.stops,
      ...day.alternatives,
      ...(day.activityOptions || [])
    ]),
    ...next.alternatives
  ].filter((stop) => stop.id === stopId);
  if (!stops.length) throw new Error('这个地点已不在当前行程中。');
  for (const stop of stops) {
    stop.name = candidate.name;
    stop.province = candidate.province || stop.province;
    stop.city = candidate.city || stop.city;
    stop.district = candidate.district || stop.district;
    if (stop.activity) stop.activity.searchName = candidate.name;
    stop.poiMatch = {
      ...candidate,
      status: 'matched',
      matchVersion: 2,
      source: 'manual',
      confidence: 1,
      amapUrl: `https://uri.amap.com/marker?position=${candidate.location.join(',')}&name=${encodeURIComponent(candidate.name)}`
    };
  }
  Object.assign(next, routeUpdateForEdit(itinerary, next));
  next.updatedAt = new Date().toISOString();
  return next;
}
