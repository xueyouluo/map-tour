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
    expect(cleaned.tripScope).toMatchObject({ mode: 'single_city', primaryCity: '宁波', cities: ['宁波'] });
    expect(cleaned.days?.[0].title).toBe('周尧昆虫博物馆到老外滩');
    expect(cleaned.days?.[0].stops?.map((stop) => stop.name)).toEqual(['宁波站', '周尧昆虫博物馆', '鄞州公园', '老外滩']);
    expect(cleaned.days?.[0].stops?.every((stop) => stop.city === '宁波')).toBe(true);
  });

  it('does not force a return city onto every stop in cross-city road trips', () => {
    const rawText = `川西小环线规划
day1取车出发，开车到都江堰，晚上住都江堰。
day2早起开车到四姑娘山双桥沟，景区出来后开车到小金/丹巴县城住宿。
day3丹巴出发经过墨石公园、塔公草原到新都桥，晚上住新都桥
day4新都桥开车到康定、泸定、雅安，晚上住雅安。
day5雅安开车回重庆。`;

    const cleaned = cleanParsedItinerary(
      {
        title: '川西小环线规划',
        language: 'zh-CN',
        dateRange: { start: '', end: '', label: '' },
        days: [
          {
            dayIndex: 4,
            title: 'day4 新都桥开车到康定、泸定、雅安',
            stops: [
              { order: 1, name: '康定' },
              { order: 2, name: '泸定' },
              { order: 3, name: '雅安' }
            ],
            alternatives: []
          },
          {
            dayIndex: 5,
            title: 'day5 雅安开车回重庆',
            stops: [{ order: 1, name: '雅安' }],
            alternatives: []
          }
        ],
        alternatives: []
      },
      rawText
    );

    const stops = cleaned.days?.flatMap((day) => day.stops || []) || [];
    expect(cleaned.tripScope?.mode).toBe('multi_city');
    expect(stops.map((stop) => stop.name)).toEqual(['康定', '泸定', '雅安', '雅安']);
    expect(stops.every((stop) => !stop.city)).toBe(true);
  });

  it('preserves per-stop city context when the model extracts a multi-city scope', () => {
    const cleaned = cleanParsedItinerary(
      {
        title: '川西小环线规划',
        language: 'zh-CN',
        dateRange: { start: '', end: '', label: '' },
        tripScope: {
          mode: 'multi_city',
          primaryCity: '',
          cities: ['都江堰', '阿坝藏族羌族自治州', '甘孜藏族自治州', '雅安'],
          confidence: 0.9,
          reason: '自驾跨多个县市'
        },
        days: [
          {
            dayIndex: 3,
            title: 'day3 丹巴到新都桥',
            stops: [
              { order: 1, name: '墨石公园', city: '甘孜藏族自治州' },
              { order: 2, name: '塔公草原', city: '甘孜藏族自治州' },
              { order: 3, name: '新都桥', city: '甘孜藏族自治州' }
            ],
            alternatives: []
          },
          {
            dayIndex: 4,
            title: 'day4 新都桥到雅安',
            stops: [
              { order: 1, name: '康定', city: '甘孜藏族自治州' },
              { order: 2, name: '泸定', city: '甘孜藏族自治州' },
              { order: 3, name: '雅安', city: '雅安' }
            ],
            alternatives: []
          }
        ],
        alternatives: []
      },
      '川西小环线规划，开车经过墨石公园、塔公草原、新都桥、康定、泸定、雅安。'
    );

    expect(cleaned.tripScope).toMatchObject({ mode: 'multi_city', primaryCity: '' });
    expect(cleaned.tripScope?.cities).toContain('甘孜藏族自治州');
    expect(cleaned.days?.flatMap((day) => day.stops || []).map((stop) => stop.city)).toEqual([
      '甘孜藏族自治州',
      '甘孜藏族自治州',
      '甘孜藏族自治州',
      '甘孜藏族自治州',
      '甘孜藏族自治州',
      '雅安'
    ]);
  });
});
