import { expect, it } from 'vitest';
import { pickBestPoiCandidate } from './poiMatching';
import type { Stop, PoiCandidate } from './itinerary';
const stop = (name: string, area = false): Stop => ({
  id: 'x',
  dayIndex: 1,
  order: 1,
  label: 'D1-1',
  name,
  activity: {
    kind: 'visit',
    source: 'explicit',
    placeKind: area ? 'area' : 'venue',
    meal: 'none',
    quote: '',
    searchName: name
  }
});
it('matches streets themselves instead of similarly named hotels', () => {
  for (const name of ['湖滨步行街', '南宋御街']) {
    const candidates: PoiCandidate[] = [
      { name: `杭州西湖${name}酒店`, type: '住宿服务;宾馆酒店' },
      { name, type: '地名地址信息;交通地名;道路名' }
    ];
    expect(
      pickBestPoiCandidate(candidates, stop(name, true), '杭州', undefined)
        ?.name
    ).toBe(name);
  }
});
it('matches a temple alias instead of a tree or an ancillary shop', () => {
  const candidates = [
    { name: '法喜寺白玉兰', type: '风景名胜;风景名胜;风景名胜' },
    { name: '法喜寺法物流通处', type: '生活服务' },
    { name: '上天竺法喜讲寺', type: '风景名胜;风景名胜;寺庙道观' }
  ];
  expect(
    pickBestPoiCandidate(candidates, stop('法喜寺'), '杭州', undefined)?.name
  ).toBe('上天竺法喜讲寺');
});

it('rejects a namesake service office even when it is the only candidate', () => {
  expect(
    pickBestPoiCandidate(
      [
        {
          name: '码头镇北港村退役军人服务站',
          type: '政府机构及社会团体',
          location: [116.104402, 39.558493]
        }
      ],
      stop('北港村', true),
      '平潭',
      undefined
    )
  ).toBeUndefined();
});
it('prefers the actual beach over a restaurant branch named after it', () => {
  expect(
    pickBestPoiCandidate(
      [
        { name: '龙王头沙滩店', type: '餐饮服务;餐饮相关场所' },
        { name: '龙王头海滩', type: '风景名胜;风景名胜;海滩' }
      ],
      stop('龙王头沙滩', true),
      '平潭',
      undefined
    )?.name
  ).toBe('龙王头海滩');
});
it('does not accept an unrelated scenic place just because its city matches', () => {
  expect(
    pickBestPoiCandidate(
      [
        {
          name: '另一个公园',
          address: '福州市平潭县',
          type: '风景名胜;风景名胜;风景名胜'
        }
      ],
      stop('北港村'),
      '平潭',
      undefined
    )
  ).toBeUndefined();
});
it('recognizes the core name in a qualified scenic POI', () => {
  expect(
    pickBestPoiCandidate(
      [
        { name: '仙人井', type: '地名地址信息' },
        { name: '平潭国际旅游岛·仙人井', type: '风景名胜;风景名胜;风景名胜' }
      ],
      stop('仙人井'),
      '平潭',
      undefined
    )?.name
  ).toBe('平潭国际旅游岛·仙人井');
});
