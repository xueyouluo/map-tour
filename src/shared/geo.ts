import type { Coordinate, RouteMode } from './itinerary';

const EARTH_RADIUS_METERS = 6371008.8;
const WALKING_THRESHOLD_METERS = 1200;

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const [lng1, lat1] = a.map(toRadians);
  const [lng2, lat2] = b.map(toRadians);
  const deltaLat = lat2 - lat1;
  const deltaLng = lng2 - lng1;
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function chooseRouteMode(distance: number): RouteMode {
  return distance < WALKING_THRESHOLD_METERS ? 'walking' : 'driving';
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
