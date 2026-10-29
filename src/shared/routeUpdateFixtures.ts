import {
  normalizeParsedItinerary,
  type Itinerary,
  type Stop
} from './itinerary';
import { journeyLegs } from './transport';
export function fixture(): Itinerary {
  const itinerary = normalizeParsedItinerary(
    {
      days: [
        {
          dayIndex: 1,
          stops: [
            { name: 'A', time: '上午' },
            { name: 'B', time: '下午' },
            { name: 'C', time: '晚上' }
          ]
        },
        {
          dayIndex: 2,
          stops: [
            { name: 'D', time: '上午' },
            { name: 'E', time: '下午' }
          ]
        }
      ]
    },
    'test'
  );
  itinerary.days
    .flatMap((day) => day.stops)
    .forEach((stop, index) => {
      stop.poiMatch = {
        status: 'matched',
        matchVersion: 2,
        name: stop.name,
        location: [120 + index * 0.001, 30]
      };
      stop.arrival = { mode: 'walking', label: '步行', quote: '' };
    });
  itinerary.routeSegments = journeyLegs(itinerary).map(
    ({ from, to, isInterDay }) => ({
      dayIndex: from.dayIndex,
      toDayIndex: isInterDay ? to.dayIndex : undefined,
      isInterDay,
      fromStopId: from.id,
      toStopId: to.id,
      mode: 'walking',
      status: 'complete',
      path: [from.poiMatch!.location!, to.poiMatch!.location!]
    })
  );
  return itinerary;
}
export function meal(): Stop {
  return {
    id: 'meal',
    dayIndex: 1,
    order: 2,
    label: '餐',
    name: '午餐',
    time: '午餐',
    activity: {
      kind: 'meal',
      meal: 'lunch',
      source: 'explicit',
      placeKind: 'venue',
      quote: '午餐',
      searchName: '午餐'
    },
    poiMatch: {
      status: 'matched',
      matchVersion: 2,
      name: '午餐',
      location: [120.0005, 30]
    }
  };
}
