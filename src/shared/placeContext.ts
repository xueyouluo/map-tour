import type {
  Itinerary,
  PoiCandidate,
  PoiSearchContext,
  Stop
} from './itinerary';
import { distanceMeters } from './geo';

export function normalizeRegion(value = ''): string {
  return value
    .replace(/\s/g, '')
    .replace(
      /(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|省|市|县|区)$/,
      ''
    );
}
export function placeSearchContext(
  stop: Stop,
  scope?: Itinerary['tripScope']
): PoiSearchContext {
  const onlyCity = scope?.cities?.length === 1 ? scope.cities[0] : '';
  return {
    province: stop.province || scope?.province || '',
    city: stop.city || scope?.primaryCity || onlyCity || '',
    district: stop.district || '',
    locationHint: stop.locationHint || ''
  };
}
export function placeQueries(stop: Stop, context: PoiSearchContext): string[] {
  const name = stop.activity?.searchName || stop.name;
  return [
    ...new Set([
      [
        context.province,
        context.city,
        context.district,
        context.locationHint,
        name
      ]
        .filter(Boolean)
        .join(' '),
      [context.district || context.city, name].filter(Boolean).join(' '),
      name
    ])
  ];
}
export function candidateFitsRegion(
  candidate: PoiCandidate,
  context?: PoiSearchContext
): boolean {
  if (!context) return true;
  const expectedProvince = normalizeRegion(context.province);
  if (
    expectedProvince &&
    candidate.province &&
    normalizeRegion(candidate.province) !== expectedProvince
  )
    return false;
  const actual = [
    candidate.province,
    candidate.city,
    candidate.district,
    candidate.address
  ]
    .filter(Boolean)
    .map((value) => normalizeRegion(value))
    .join(' ');
  if (
    context.district &&
    candidate.district &&
    !actual.includes(normalizeRegion(context.district))
  )
    return false;
  if (
    context.city &&
    candidate.city &&
    !actual.includes(normalizeRegion(context.city))
  )
    return false;
  // County and municipal bounds are deliberately generous; they still reject namesakes thousands of km away.
  if (
    context.center &&
    candidate.location &&
    (context.city || context.district)
  ) {
    const maxDistance = context.district
      ? 180000
      : /自治州|地区|盟$/.test(context.city || '')
        ? 700000
        : 400000;
    if (distanceMeters(context.center, candidate.location) > maxDistance)
      return false;
  }
  return true;
}
export function placeRegionLabel(
  stop: Pick<Stop, 'province' | 'city' | 'district'>
): string {
  return [
    ...new Set([stop.province, stop.city, stop.district].filter(Boolean))
  ].join(' · ');
}
