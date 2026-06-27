import { describe, expect, it } from 'vitest';
import { hasPendingPoiMatches, normalizeParsedItinerary, removeStopFromItinerary, type RouteSegment } from './itinerary';

describe('normalizeParsedItinerary', () => {
  it('normalizes days, labels, stop ids, and language', () => {
    const itinerary = normalizeParsedItinerary({
      title: '杭州两日游',
      language: 'zh-CN',
      dateRange: { start: '2026-06-28', end: '2026-06-29', label: '6月28日 - 6月29日' },
      days: [
        {
          title: '西湖',
          stops: [
            { name: '曲院风荷', note: '上午赏荷' },
            { name: '灵隐寺', note: '下午参观' }
          ],
          alternatives: [{ name: '法喜寺' }]
        }
      ],
      alternatives: [{ name: '茅家埠' }]
    });

    expect(itinerary.title).toBe('杭州两日游');
    expect(itinerary.language).toBe('zh-CN');
    expect(itinerary.days[0].stops[0].label).toBe('D1-1');
    expect(itinerary.days[0].stops[0].poiMatch?.status).toBe('pending');
    expect(itinerary.days[0].alternatives[0].isAlternative).toBe(true);
    expect(hasPendingPoiMatches(itinerary)).toBe(true);
  });
});

describe('removeStopFromItinerary', () => {
  it('removes inter-day route segments that touch the edited day', () => {
    const itinerary = normalizeParsedItinerary({
      title: '川西小环线',
      days: [
        { stops: [{ name: '都江堰' }, { name: '双桥沟' }] },
        { stops: [{ name: '丹巴' }, { name: '新都桥' }] },
        { stops: [{ name: '康定' }, { name: '雅安' }] }
      ]
    });
    const [day1, day2, day3] = itinerary.days;
    const segments: RouteSegment[] = [
      makeSegment(day1.dayIndex, day1.stops[0].id, day1.stops[1].id),
      makeSegment(day2.dayIndex, day2.stops[0].id, day2.stops[1].id),
      makeSegment(day3.dayIndex, day3.stops[0].id, day3.stops[1].id),
      makeSegment(day1.dayIndex, day1.stops[1].id, day2.stops[0].id, day2.dayIndex),
      makeSegment(day2.dayIndex, day2.stops[1].id, day3.stops[0].id, day3.dayIndex)
    ];
    itinerary.routeSegments = segments;

    const next = removeStopFromItinerary(itinerary, day2.stops[0].id);

    expect(next.routeSegments).toEqual([
      segments[0],
      segments[2]
    ]);
  });
});

function makeSegment(dayIndex: number, fromStopId: string, toStopId: string, toDayIndex?: number): RouteSegment {
  return {
    dayIndex,
    toDayIndex,
    fromStopId,
    toStopId,
    isInterDay: Boolean(toDayIndex),
    mode: 'driving',
    status: 'complete',
    path: [[120, 30], [121, 31]]
  };
}
