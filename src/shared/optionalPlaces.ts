import type { Recommendations } from './activities';
import type { Itinerary, ItineraryDay, Stop } from './itinerary';
import { normalizeRegion } from './placeContext';

export function optionalPlaceKey(
  stop: Pick<Stop, 'name' | 'activity' | 'province' | 'city' | 'district'>
): string {
  return [
    stop.activity?.kind,
    stop.activity?.searchName || stop.name,
    stop.province,
    stop.city,
    stop.district
  ]
    .filter(Boolean)
    .join('|');
}

export function getDayActivityOptions(
  day: ItineraryDay,
  recommendations?: Recommendations
): Stop[] {
  function regionFor(item: Pick<Stop, 'province' | 'city' | 'district'>) {
    const anchor = day.stops.find(
      (stop) =>
        !item.city ||
        [stop.city, stop.district].some(
          (region) =>
            region && normalizeRegion(region) === normalizeRegion(item.city)
        )
    );
    return {
      province: item.province || anchor?.province,
      city: item.city || anchor?.city,
      district: item.district || anchor?.district
    };
  }
  const options: Stop[] = (day.activityOptions || []).map((option) => ({
    ...option,
    ...regionFor(option)
  }));
  // Included places remain available as cards so users can remove them from the route.
  for (const stop of day.stops) {
    if (
      (stop.activity?.kind === 'meal' || stop.activity?.kind === 'stay') &&
      !options.some((option) => option.id === stop.id)
    )
      options.push(stop);
  }
  for (const [group, kind] of [
    ['dining', 'meal'],
    ['lodging', 'stay']
  ] as const) {
    for (const item of recommendations?.[group] || []) {
      if (
        options.some(
          (option) =>
            option.activity?.kind === kind &&
            (option.name === item.name ||
              option.activity?.searchName ===
                (item.activity?.searchName || item.name))
        )
      )
        continue;
      options.push({
        ...item,
        id: `option-${day.dayIndex}-${kind}-${item.name}`,
        dayIndex: day.dayIndex,
        order: day.stops.length + 1,
        label: kind === 'meal' ? '餐' : '宿',
        ...regionFor(item),
        time: kind === 'stay' ? '夜间住宿' : '午餐',
        activity: {
          placeKind: 'venue',
          quote: '',
          searchName: item.name,
          ...item.activity,
          kind,
          meal: kind === 'meal' ? 'lunch' : 'none',
          source: 'default'
        },
        poiMatch: { status: 'pending', name: item.name }
      });
    }
  }
  return options;
}

export function getMapOnlyActivities(
  itinerary: Itinerary,
  activeDay: number | 'all'
): { stop: Stop; choices: Stop[] }[] {
  const days = itinerary.days.filter(
    (day) => activeDay === 'all' || day.dayIndex === activeDay
  );
  const included = new Set(
    days
      .flatMap((day) => day.stops)
      .filter(
        (stop) =>
          stop.activity?.kind === 'meal' || stop.activity?.kind === 'stay'
      )
      .map(optionalPlaceKey)
  );
  const groups = new Map<string, { stop: Stop; choices: Stop[] }>();
  for (const day of days)
    for (const stop of getDayActivityOptions(day, itinerary.recommendations)) {
      if (day.stops.some((main) => main.id === stop.id)) continue;
      const key = optionalPlaceKey(stop);
      if (included.has(key)) continue;
      const group = groups.get(key);
      if (group) group.choices.push(stop);
      else groups.set(key, { stop, choices: [stop] });
    }
  return [...groups.values()];
}
