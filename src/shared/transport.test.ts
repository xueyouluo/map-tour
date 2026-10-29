import { expect, it } from 'vitest';
import { arrivalForLeg, journeyLegs, normalizeArrival } from './transport';
import { normalizeParsedItinerary } from './itinerary';
import { createVideoPlan } from './videoPlan';
it('connects nonempty days from the actual final stop, including selected accommodation', () => {
  const i = normalizeParsedItinerary({
    days: [
      { stops: [{ name: '公园' }, { name: '酒店' }] },
      { stops: [] },
      { stops: [{ name: '寺庙' }] }
    ]
  });
  expect(journeyLegs(i).at(-1)).toMatchObject({
    from: { name: '酒店' },
    to: { name: '寺庙' },
    isInterDay: true
  });
  expect(journeyLegs(i, false)).toHaveLength(1);
});
it('invalidates traffic hints when optional activities change the origin and normalizes malformed enums', () => {
  const i = normalizeParsedItinerary({
    days: [
      {
        stops: [
          { name: '酒店' },
          {
            name: '寺庙',
            arrival: { mode: 'walking', fromName: '公园', label: '', quote: '' }
          }
        ]
      }
    ]
  });
  expect(arrivalForLeg(i.days[0].stops[0], i.days[0].stops[1]).mode).toBe(
    'auto'
  );
  expect(normalizeArrival({ mode: '' as never, confidence: 4 })).toMatchObject({
    mode: 'auto',
    confidence: 1,
    source: 'unknown'
  });
});
it('reuses planned cross-day road geometry and preserves model transport evidence in the film', () => {
  const i = normalizeParsedItinerary(
    {
      days: [
        { stops: [{ name: '湖滨步行街' }] },
        {
          stops: [
            {
              name: '灵隐寺',
              arrival: {
                mode: 'bus',
                fromName: '湖滨步行街',
                source: 'inferred',
                label: '公交接驳',
                quote: '',
                reason: '同城山区交通',
                confidence: 0.7,
                steps: [{ mode: 'bus', note: '推断' }]
              }
            }
          ]
        }
      ]
    },
    'test'
  );
  const a = i.days[0].stops[0],
    b = i.days[1].stops[0];
  a.poiMatch = { status: 'matched', name: a.name, location: [120.15, 30.25] };
  b.poiMatch = { status: 'matched', name: b.name, location: [120.1, 30.24] };
  const path: [number, number][] = [
    [120.15, 30.25],
    [120.14, 30.26],
    [120.1, 30.24]
  ];
  i.routeSegments = [
    {
      dayIndex: 1,
      toDayIndex: 2,
      fromStopId: a.id,
      toStopId: b.id,
      isInterDay: true,
      mode: 'bus',
      status: 'complete',
      path,
      transport: b.arrival
    }
  ];
  const segment = createVideoPlan(i).segments[0];
  expect(segment).toMatchObject({
    mode: 'bus',
    isInterDay: true,
    illustrative: false,
    transport: { source: 'inferred', confidence: 0.7 }
  });
  expect(segment.path).toEqual(path);
});
it('does not mistake a video from before optional accommodation was added for the current route', async () => {
  const { journeySignature } = await import('./journeySignature');
  const i = normalizeParsedItinerary({ days: [{ stops: [{ name: '湖边' }] }] });
  const before = journeySignature(i);
  i.days[0].stops.push({ ...i.days[0].stops[0], id: 'hotel', name: '住宿' });
  expect(journeySignature(i)).not.toBe(before);
});
