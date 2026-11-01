import type { Itinerary, PoiSearchContext, Stop } from './itinerary';
import { normalizeRegion } from './placeContext';

type Region = Pick<PoiSearchContext, 'province' | 'city'>;

function compatible(a: Region, b: Region): boolean {
  return (['province', 'city'] as const).every(
    (key) => !a[key] || !b[key] || normalizeRegion(a[key]) === normalizeRegion(b[key])
  );
}

function merge(a: Region, b: Region): Region {
  return compatible(a, b)
    ? { province: a.province || b.province || '', city: a.city || b.city || '' }
    : a;
}

function ownRegion(stop: Stop): Region {
  let region: Region = {
    province: stop.province?.trim() || '',
    city: stop.city?.trim() || ''
  };
  if (stop.poiMatch?.status === 'matched') region = merge(region, stop.poiMatch);
  return merge(region, stop.poiMatch?.searchContext || {});
}

// Missing information is only inherited when the available regions agree.
// A transfer day can span multiple cities, so choosing its first stop is unsafe.
function agreedRegion(regions: Region[]): Region {
  const unique = (key: keyof Region) => {
    const values = new Map<string, string>();
    for (const region of regions) {
      const value = region[key]?.trim();
      if (value) values.set(normalizeRegion(value), value);
    }
    return values.size === 1 ? [...values.values()][0] : '';
  };
  return { province: unique('province'), city: unique('city') };
}

export function stopLocationDefaults(
  stop: Stop,
  itinerary: Itinerary
): PoiSearchContext {
  let region = ownRegion(stop);
  const day = itinerary.days.find((item) =>
    [...item.stops, ...(item.alternatives || []), ...(item.activityOptions || [])]
      .some((item) => item.id === stop.id)
  );
  const index = day?.stops.findIndex((item) => item.id === stop.id) ?? -1;
  const crossCityMode = (mode?: string) => mode === 'rail' || mode === 'flight';
  const transferEndpoint = crossCityMode(stop.arrival?.mode) ||
    (index >= 0 && crossCityMode(day?.stops[index + 1]?.arrival?.mode));
  const dayRegions = (transferEndpoint && !region.city ? [] : day?.stops || [])
    .filter((item) => item.id !== stop.id)
    .map(ownRegion)
    .filter((item) => compatible(region, item));
  region = merge(region, agreedRegion(dayRegions));

  const scope = itinerary.tripScope;
  const singleCity = scope?.mode === 'single_city' || scope?.cities?.length === 1;
  if (singleCity) {
    region = merge(region, {
      province: scope?.province,
      city: scope?.primaryCity || scope?.cities?.[0]
    });
  } else if (scope?.mode !== 'multi_city' && !scope?.cities?.length) {
    region = merge(region, { province: scope?.province });
  }

  const allRegions = [
    ...itinerary.days.flatMap((item) => [
      ...item.stops, ...(item.alternatives || []), ...(item.activityOptions || [])
    ]),
    ...(itinerary.alternatives || [])
  ].filter((item) => item.id !== stop.id).map(ownRegion);
  // A known city can borrow its province from another day, without borrowing
  // the previous day's destination on a multi-city trip.
  const relevant = allRegions.filter((item) =>
    compatible(region, item) &&
    (region.city
      ? normalizeRegion(item.city) === normalizeRegion(region.city)
      : scope?.mode !== 'multi_city')
  );
  region = merge(region, agreedRegion(relevant));

  const match = stop.poiMatch?.status === 'matched' && compatible(region, stop.poiMatch)
    ? stop.poiMatch : undefined;
  return {
    ...region,
    district: stop.district || match?.district || '',
    locationHint: stop.locationHint || ''
  };
}
