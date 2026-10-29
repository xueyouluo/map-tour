import type { Itinerary, RouteSegment } from './itinerary';
import { journeyLegs } from './transport';

type LegPair = Pick<RouteSegment, 'fromStopId' | 'toStopId'>;
export function legPairKey(pair: LegPair): string {
  return JSON.stringify([pair.fromStopId, pair.toStopId]);
}

// Compare the final edit against the committed route, even after several draft selections.
export function routeUpdateForEdit(
  before: Itinerary,
  after: Itinerary
): Pick<
  Itinerary,
  'routeSegments' | 'transportReviewLegs' | 'transportNeedsReview'
> {
  const prior = new Map(
    journeyLegs(before).map((leg) => [
      legPairKey({ fromStopId: leg.from.id, toStopId: leg.to.id }),
      leg
    ])
  );
  const legs = journeyLegs(after);
  const pending = new Set(
    before.transportReviewLegs?.map(legPairKey) ||
      (before.transportNeedsReview ? prior.keys() : [])
  );
  const unchanged = new Set<string>();
  const transportReviewLegs: LegPair[] = [];
  for (const leg of legs) {
    const pair = { fromStopId: leg.from.id, toStopId: leg.to.id };
    const key = legPairKey(pair);
    const previous = prior.get(key);
    if (
      previous &&
      !pending.has(key) &&
      previous.from.dayIndex === leg.from.dayIndex &&
      previous.to.dayIndex === leg.to.dayIndex &&
      JSON.stringify(previous.from.poiMatch?.location) ===
        JSON.stringify(leg.from.poiMatch?.location) &&
      JSON.stringify(previous.to.poiMatch?.location) ===
        JSON.stringify(leg.to.poiMatch?.location)
    )
      unchanged.add(key);
    else transportReviewLegs.push(pair);
  }
  return {
    routeSegments: before.routeSegments.filter((segment) =>
      unchanged.has(legPairKey(segment))
    ),
    transportReviewLegs,
    transportNeedsReview: transportReviewLegs.length > 0
  };
}
