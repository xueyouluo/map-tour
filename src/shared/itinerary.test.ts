import { describe, expect, it } from 'vitest';
import { hasPendingPoiMatches, normalizeParsedItinerary } from './itinerary';

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
