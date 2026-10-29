import type { ArrivalMeta, TravelMode } from './activities';
import type { Itinerary, Stop } from './itinerary';

export const travelModes: TravelMode[] = [
  'auto',
  'walking',
  'driving',
  'bus',
  'subway',
  'transit',
  'rail',
  'flight',
  'ferry'
];
export const transportNames: Record<TravelMode, string> = {
  auto: '待判断',
  walking: '步行',
  driving: '驾车',
  bus: '公交',
  subway: '地铁',
  transit: '公共交通',
  rail: '火车',
  flight: '飞机',
  ferry: '乘船'
};
export function normalizeArrival(value?: Partial<ArrivalMeta>): ArrivalMeta {
  const mode = travelModes.includes(value?.mode as TravelMode)
    ? value!.mode!
    : 'auto';
  return {
    ...value,
    mode,
    label: value?.label || '',
    quote: value?.quote || '',
    source:
      value?.source === 'explicit' || value?.source === 'inferred'
        ? value.source
        : value?.quote
          ? 'explicit'
          : 'unknown',
    confidence: Number.isFinite(value?.confidence)
      ? Math.max(0, Math.min(1, Number(value?.confidence)))
      : 0,
    reason: value?.reason || '',
    fromName: value?.fromName || '',
    steps: (Array.isArray(value?.steps) ? value.steps : []).filter((step) =>
      travelModes.includes(step.mode)
    )
  };
}
export function journeyLegs(
  itinerary: Pick<Itinerary, 'days'>,
  connectDays = true
) {
  const days = itinerary.days.filter((day) => day.stops.length);
  const legs: { from: Stop; to: Stop; isInterDay: boolean }[] = [];
  let previous: Stop | undefined;
  for (const day of days) {
    for (let i = 0; i < day.stops.length; i++) {
      const to = day.stops[i];
      if (previous && (i > 0 || connectDays))
        legs.push({ from: previous, to, isInterDay: i === 0 });
      previous = to;
    }
  }
  return legs;
}
export function arrivalForLeg(from: Stop, to: Stop): ArrivalMeta {
  const arrival = normalizeArrival(to.arrival);
  if (arrival.fromName && arrival.fromName !== from.name) {
    return {
      mode: 'auto',
      label: '',
      quote: '',
      source: 'unknown',
      fromName: from.name,
      reason: '起点改变，需要重新识别交通',
      confidence: 0,
      steps: []
    };
  }
  return arrival;
}
