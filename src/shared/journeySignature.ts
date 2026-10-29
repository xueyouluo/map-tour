import type { Itinerary, RouteSegment } from './itinerary';
// Stable across metadata-only updates; changes when the rendered route changes.
export function journeySignature(
  itinerary: Pick<Itinerary, 'days'> & {
    routeSegments: Pick<
      RouteSegment,
      'fromStopId' | 'toStopId' | 'mode' | 'path'
    >[];
  }
): string {
  const text = JSON.stringify({
    playbackTimingVersion: 2,
    days: itinerary.days.map((day) =>
      day.stops.map((stop) => [
        stop.id,
        stop.name,
        stop.poiMatch?.location,
        stop.activity?.kind,
        stop.arrival?.mode,
        stop.arrival?.label
      ])
    ),
    routes: itinerary.routeSegments.map((route) => [
      route.fromStopId,
      route.toStopId,
      route.mode,
      route.path
    ])
  });
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
