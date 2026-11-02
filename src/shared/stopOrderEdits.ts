import type { Itinerary, Stop } from './itinerary';
import { routeUpdateForEdit } from './routeUpdates';

export type StopOrderEdits = Record<number, string[]>;

function orderedStops(stops: Stop[], requested: string[]): Stop[] {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  const ids = [...new Set(requested)].filter((id) => byId.has(id));
  const ordered = new Set(ids);
  // A newly selected meal retains its original following stop as an anchor.
  // Removed stops in an older draft order never reappear.
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index];
    if (ordered.has(stop.id)) continue;
    const following = stops.slice(index + 1).find((item) => ordered.has(item.id));
    const insertion = following ? ids.indexOf(following.id) : ids.length;
    ids.splice(insertion, 0, stop.id);
  }
  return ids.map((id) => byId.get(id)!);
}

export function stageStopMove(
  base: Itinerary,
  edits: StopOrderEdits,
  dayIndex: number,
  stopId: string,
  direction: -1 | 1
): StopOrderEdits {
  const day = base.days.find((item) => item.dayIndex === dayIndex);
  if (!day) return edits;
  const ids = orderedStops(day.stops, edits[dayIndex] || []).map((stop) => stop.id);
  const index = ids.indexOf(stopId), target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return edits;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  const next = { ...edits };
  if (ids.every((id, position) => id === day.stops[position].id)) delete next[dayIndex];
  else next[dayIndex] = ids;
  return next;
}

export function applyStopOrderEdits(
  committed: Itinerary,
  base: Itinerary,
  edits: StopOrderEdits
): Itinerary {
  if (!Object.keys(edits).length) return base;
  const next = structuredClone(base);
  for (const day of next.days) {
    if (!edits[day.dayIndex]) continue;
    day.stops = orderedStops(day.stops, edits[day.dayIndex]).map((stop, index) => ({
      ...stop, order: index + 1, label: `D${day.dayIndex}-${index + 1}`
    }));
  }
  return { ...next, ...routeUpdateForEdit(committed, next) };
}

export function changedStopOrderCount(base: Itinerary, edits: StopOrderEdits): number {
  return base.days.reduce((count, day) => count + (edits[day.dayIndex]
    ? orderedStops(day.stops, edits[day.dayIndex]).filter((stop, index) => stop.id !== day.stops[index].id).length
    : 0), 0);
}
