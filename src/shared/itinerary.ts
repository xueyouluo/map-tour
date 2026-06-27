export type Coordinate = [number, number];

export type MatchStatus = 'pending' | 'matched' | 'unmatched';
export type RouteMode = 'driving' | 'walking' | 'transit' | 'straight';
export type RoutePreference = 'auto' | 'driving' | 'walking' | 'transit';
export type RouteStatus = 'complete' | 'fallback' | 'failed';

export interface DateRange {
  start?: string;
  end?: string;
  label?: string;
}

export type TripScopeMode = 'single_city' | 'multi_city' | 'unknown';

export interface TripScope {
  mode: TripScopeMode;
  primaryCity?: string;
  cities?: string[];
  confidence?: number;
  reason?: string;
}

export interface PoiCandidate {
  poiId?: string;
  name: string;
  address?: string;
  type?: string;
  location?: Coordinate;
}

export interface PoiMatch extends PoiCandidate {
  status: MatchStatus;
  confidence?: number;
  amapUrl?: string;
  candidates?: PoiCandidate[];
  errorInfo?: string;
  errorCode?: string;
}

export interface Stop {
  id: string;
  dayIndex: number;
  order: number;
  label: string;
  name: string;
  note?: string;
  city?: string;
  time?: string;
  category?: string;
  isAlternative?: boolean;
  poiMatch?: PoiMatch;
}

export interface ItineraryDay {
  dayIndex: number;
  date?: string;
  title: string;
  stops: Stop[];
  alternatives: Stop[];
}

export interface RouteSegment {
  dayIndex: number;
  fromStopId: string;
  toStopId: string;
  mode: RouteMode;
  status: RouteStatus;
  distanceMeters?: number;
  durationSeconds?: number;
  path: Coordinate[];
}

export interface Itinerary {
  id: string;
  title: string;
  language: string;
  dateRange: DateRange;
  tripScope?: TripScope;
  days: ItineraryDay[];
  alternatives: Stop[];
  routeSegments: RouteSegment[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ParsedStop {
  order?: number;
  name: string;
  note?: string;
  city?: string;
  time?: string;
  category?: string;
}

export interface ParsedDay {
  dayIndex?: number;
  date?: string;
  title?: string;
  stops?: ParsedStop[];
  alternatives?: ParsedStop[];
}

export interface ParsedItinerary {
  title?: string;
  language?: string;
  dateRange?: DateRange;
  tripScope?: TripScope;
  days?: ParsedDay[];
  alternatives?: ParsedStop[];
}

export const DAY_COLORS = [
  '#0052ff',
  '#6a4ee8',
  '#00a36c',
  '#f97316',
  '#d6336c',
  '#0ea5e9',
  '#7c3aed',
  '#16a34a'
];

export function colorForDay(dayIndex: number): string {
  return DAY_COLORS[(Math.max(dayIndex, 1) - 1) % DAY_COLORS.length];
}

export function createStopLabel(dayIndex: number, order: number): string {
  return `D${dayIndex}-${order}`;
}

export function slugPart(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'stop';
}

export function stopId(dayIndex: number, order: number, name: string, alternative = false): string {
  return `${alternative ? 'alt' : 'stop'}-${dayIndex}-${order}-${slugPart(name)}`;
}

export function normalizeParsedItinerary(parsed: ParsedItinerary, id = 'draft'): Itinerary {
  const days = (parsed.days || [])
    .filter((day) => (day.stops?.length || 0) > 0 || (day.alternatives?.length || 0) > 0)
    .map((day, index) => {
      const dayIndex = index + 1;
      const stops = (day.stops || [])
        .filter((stop) => stop.name?.trim())
        .map((stop, stopIndex) => {
          const order = stop.order && stop.order > 0 ? stop.order : stopIndex + 1;
          return normalizeStop(stop, dayIndex, order, false);
        });

      const alternatives = (day.alternatives || [])
        .filter((stop) => stop.name?.trim())
        .map((stop, altIndex) => normalizeStop(stop, dayIndex, altIndex + 1, true));

      return {
        dayIndex,
        date: day.date || '',
        title: day.title || `Day ${dayIndex}`,
        stops,
        alternatives
      };
    });

  const alternatives = (parsed.alternatives || [])
    .filter((stop) => stop.name?.trim())
    .map((stop, altIndex) => normalizeStop(stop, 0, altIndex + 1, true));

  return {
    id,
    title: parsed.title?.trim() || 'Untitled itinerary',
    language: parsed.language?.trim() || 'auto',
    dateRange: parsed.dateRange || {},
    tripScope: normalizeTripScope(parsed.tripScope),
    days,
    alternatives,
    routeSegments: []
  };
}

function normalizeTripScope(scope?: TripScope): TripScope {
  const mode = scope?.mode === 'single_city' || scope?.mode === 'multi_city' ? scope.mode : 'unknown';
  return {
    mode,
    primaryCity: scope?.primaryCity?.trim() || '',
    cities: Array.from(new Set((scope?.cities || []).map((city) => city.trim()).filter(Boolean))),
    confidence: Number.isFinite(scope?.confidence) ? Math.max(0, Math.min(1, Number(scope?.confidence))) : 0,
    reason: scope?.reason?.trim() || ''
  };
}

function normalizeStop(stop: ParsedStop, dayIndex: number, order: number, alternative: boolean): Stop {
  return {
    id: stopId(dayIndex, order, stop.name, alternative),
    dayIndex,
    order,
    label: alternative ? (dayIndex ? `D${dayIndex}-R${order}` : `R${order}`) : createStopLabel(dayIndex, order),
    name: stop.name.trim(),
    note: stop.note?.trim() || '',
    city: stop.city?.trim() || '',
    time: stop.time?.trim() || '',
    category: stop.category?.trim() || '',
    isAlternative: alternative,
    poiMatch: { status: 'pending', name: stop.name.trim() }
  };
}

export function getVisibleDays(itinerary: Itinerary, activeDay: number | 'all'): ItineraryDay[] {
  return activeDay === 'all'
    ? itinerary.days
    : itinerary.days.filter((day) => day.dayIndex === activeDay);
}

export function getMainStops(itinerary: Itinerary): Stop[] {
  return itinerary.days.flatMap((day) => day.stops);
}

export function hasPendingPoiMatches(itinerary: Itinerary): boolean {
  return getAllStops(itinerary).some((stop) => stop.poiMatch?.status === 'pending');
}

export function getAllStops(itinerary: Itinerary): Stop[] {
  return [
    ...itinerary.days.flatMap((day) => [...day.stops, ...day.alternatives]),
    ...itinerary.alternatives
  ];
}

export function removeStopFromItinerary(itinerary: Itinerary, stopId: string): Itinerary {
  const next: Itinerary = structuredClone(itinerary);
  const affectedMainDay = itinerary.days.find((day) => day.stops.some((stop) => stop.id === stopId))?.dayIndex;

  for (const day of next.days) {
    day.stops = relabelStops(day.stops.filter((stop) => stop.id !== stopId), day.dayIndex, false);
    day.alternatives = relabelStops(day.alternatives.filter((stop) => stop.id !== stopId), day.dayIndex, true);
  }

  next.alternatives = relabelStops(next.alternatives.filter((stop) => stop.id !== stopId), 0, true);
  next.routeSegments = affectedMainDay
    ? next.routeSegments.filter((segment) => segment.dayIndex !== affectedMainDay)
    : next.routeSegments;
  next.updatedAt = new Date().toISOString();
  return next;
}

function relabelStops(stops: Stop[], dayIndex: number, alternative: boolean): Stop[] {
  return stops.map((stop, index) => {
    const order = index + 1;
    return {
      ...stop,
      dayIndex,
      order,
      label: alternative ? (dayIndex ? `D${dayIndex}-R${order}` : `R${order}`) : createStopLabel(dayIndex, order),
      id: stopId(dayIndex, order, stop.name, alternative)
    };
  });
}
