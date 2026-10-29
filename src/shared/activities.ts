import { routeUpdateForEdit } from './routeUpdates';
import { normalizeArrival } from './transport';
import type { ParsedItinerary, ParsedStop, Stop, Itinerary } from './itinerary';

export type ActivityKind = 'visit' | 'meal' | 'stay';
export type TravelMode =
  | 'auto'
  | 'walking'
  | 'driving'
  | 'transit'
  | 'rail'
  | 'ferry'
  | 'bus'
  | 'subway'
  | 'flight';
export interface ActivityMeta {
  kind: ActivityKind;
  source: 'explicit' | 'default';
  placeKind: 'venue' | 'area';
  meal: 'breakfast' | 'lunch' | 'dinner' | 'none';
  quote: string;
  searchName: string;
  alsoVisit?: boolean;
}
export interface TransportStep {
  mode: TravelMode;
  fromName?: string;
  toName?: string;
  line?: string;
  durationMinutes?: number;
  distanceKm?: number;
  note?: string;
}
export interface ArrivalMeta {
  source?: 'explicit' | 'inferred' | 'unknown';
  confidence?: number;
  reason?: string;
  fromName?: string;
  durationMinutes?: number;
  distanceKm?: number;
  departureTime?: string;
  arrivalTime?: string;
  steps?: TransportStep[];
  mode: TravelMode;
  label: string;
  quote: string;
}
export interface Recommendations {
  lodging: ParsedStop[];
  dining: ParsedStop[];
}

export function activitySymbol(stop: Pick<Stop, 'activity'>): string {
  return stop.activity?.kind === 'meal'
    ? '餐'
    : stop.activity?.kind === 'stay'
      ? '宿'
      : '';
}
export function activityDescription(stop: Pick<Stop, 'activity'>): string {
  const a = stop.activity;
  if (!a) return '';
  const name =
    a.kind === 'stay'
      ? a.placeKind === 'area'
        ? '住宿片区'
        : '住宿'
      : a.kind === 'meal'
        ? { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', none: '用餐' }[
            a.meal
          ] || '用餐'
        : '游览';
  return (
    name +
    (a.source === 'default' ? ' · 推荐选择' : '') +
    (a.kind !== 'stay' && a.placeKind === 'area' ? ' · 区域参考' : '')
  );
}

// Meals and accommodation are candidates until the user explicitly includes them.
export function completeDailyActivities(
  parsed: ParsedItinerary
): ParsedItinerary {
  const next = structuredClone(parsed);
  for (const day of next.days || [])
    for (const stop of [...(day.stops || []), ...(day.activityOptions || [])]) {
      if (stop.arrival) stop.arrival = normalizeArrival(stop.arrival);
    }
  // JSON-mode models sometimes flatten recommendation metadata despite the prompt.
  if (next.recommendations) {
    for (const [group, kind] of [
      ['lodging', 'stay'],
      ['dining', 'meal']
    ] as const) {
      next.recommendations[group] = (next.recommendations[group] || []).map(
        (item) => {
          const flat = item as ParsedStop & {
            placeKind?: ActivityMeta['placeKind'];
            searchName?: string;
          };
          const area = flat.placeKind === 'area' || /片区|区域/.test(item.name);
          return {
            ...item,
            activity: {
              kind,
              source: 'explicit',
              meal: 'none',
              quote: '',
              ...item.activity,
              placeKind: item.activity?.placeKind || (area ? 'area' : 'venue'),
              searchName:
                item.activity?.searchName || flat.searchName || item.name
            }
          };
        }
      );
    }
  }
  const days = next.days || [];
  for (const day of days) {
    const stops = day.stops || [];
    const extractedOptions = stops.filter(
      (stop) => stop.activity?.kind === 'meal' || stop.activity?.kind === 'stay'
    );
    day.activityOptions = [...(day.activityOptions || []), ...extractedOptions];
    day.stops = stops.filter(
      (stop) => stop.activity?.kind !== 'meal' && stop.activity?.kind !== 'stay'
    );
    // A meal district can also be a sightseeing destination; keep an explicit visit copy when the model says so.
    for (const option of extractedOptions)
      if (option.activity?.alsoVisit) {
        day.stops.push({
          ...option,
          activity: { ...option.activity, kind: 'visit', meal: 'none' }
        });
      }
    day.stops.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  return next;
}

export function toggleOptionalActivity(
  itinerary: Itinerary,
  dayIndex: number,
  option: Stop,
  include: boolean
): Itinerary {
  const next = structuredClone(itinerary);
  const day = next.days.find((day) => day.dayIndex === dayIndex);
  if (!day) return next;
  day.activityOptions ||= [];
  if (!day.activityOptions.some((stop) => stop.id === option.id))
    day.activityOptions.push(structuredClone(option));
  day.stops = day.stops.filter((stop) => stop.id !== option.id);
  if (include) {
    const samePlace = day.stops.findIndex((stop) => stop.name === option.name);
    const origin = day.stops.findIndex(
      (stop) => stop.name === option.arrival?.fromName
    );
    const boundary = day.stops.findIndex((stop) =>
      option.activity?.meal === 'lunch'
        ? /下午|傍晚|晚上/.test(stop.time || '')
        : /傍晚|晚上|夜/.test(stop.time || '')
    );
    const insertion =
      option.activity?.kind === 'stay'
        ? day.stops.length
        : samePlace >= 0
          ? samePlace + 1
          : origin >= 0
            ? origin + 1
            : boundary >= 0
              ? boundary
              : day.stops.length;
    day.stops.splice(insertion, 0, structuredClone(option));
  }
  day.stops = day.stops.map((stop, i) => ({
    ...stop,
    label: 'D' + dayIndex + '-' + (i + 1)
  }));
  Object.assign(next, routeUpdateForEdit(itinerary, next));
  next.updatedAt = new Date().toISOString();
  return next;
}
