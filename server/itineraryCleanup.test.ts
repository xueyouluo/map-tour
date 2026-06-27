import { describe, expect, it } from 'vitest';
import { cleanParsedItinerary } from './itineraryCleanup';

describe('cleanParsedItinerary titles', () => {
  it('summarizes overly long trip and day titles without changing stops', () => {
    const cleaned = cleanParsedItinerary(
      {
        title: 'Day1只玩鄞州南部+晚间老城夜景，不跑东部 6.28周日 10:00+ 杭州东高铁→宁波站',
        language: 'zh-CN',
        dateRange: { start: '', end: '', label: '6.28-6.30' },
        days: [
          {
            dayIndex: 1,
            title: 'Day1只玩鄞州南部+晚间老城夜景，不跑东部 6.28周日 10:00+ 杭州东高铁→宁波站',
            stops: [
              { order: 1, name: '宁波站', city: '宁波' },
              { order: 2, name: '周尧昆虫博物馆', city: '宁波' },
              { order: 3, name: '鄞州公园', city: '宁波' },
              { order: 4, name: '老外滩', city: '宁波' }
            ],
            alternatives: []
          }
        ],
        alternatives: []
      },
      '极简顺路行程｜6.28-6.30 宁波亲子'
    );

    expect(cleaned.title).toBe('宁波 1 日亲子行程');
    expect(cleaned.days?.[0].title).toBe('周尧昆虫博物馆到老外滩');
    expect(cleaned.days?.[0].stops?.map((stop) => stop.name)).toEqual(['宁波站', '周尧昆虫博物馆', '鄞州公园', '老外滩']);
  });
});
