import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mock.create } };
  }
}));
import { inferJourneyTransport } from './transportParser';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function fixture() {
  vi.stubEnv('OPENAI_API_KEY', 'test');
  vi.stubEnv('OPENAI_MODEL', 'deepseek-flash');
  const itinerary = normalizeParsedItinerary({
    days: [
      {
        stops: [
          { name: '码头' },
          {
            name: '岛',
            arrival: {
              mode: 'ferry',
              fromName: '码头',
              source: 'explicit',
              quote: '坐船',
              label: '轮渡'
            }
          }
        ]
      },
      { stops: [{ name: '市区' }] }
    ]
  });
  for (const [index, stop] of itinerary.days.flatMap((day) => day.stops).entries())
    stop.poiMatch = { name: stop.name, status: 'matched', location: [120 + index * 0.01, 30] };
  return itinerary;
}
it('requires an answer for every adjacent leg and preserves explicit boat evidence across AI reassessment', async () => {
  const i = fixture(),
    [a, b] = i.days[0].stops,
    c = i.days[1].stops[0];
  mock.create.mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            legs: [
              {
                fromStopId: a.id,
                toStopId: b.id,
                arrival: { mode: 'driving' }
              },
              {
                fromStopId: b.id,
                toStopId: c.id,
                arrival: {
                  mode: 'bus',
                  source: 'inferred',
                  reason: '区域公交',
                  confidence: 0.8
                }
              }
            ]
          })
        }
      }
    ]
  });
  const result = await inferJourneyTransport(i);
  expect(result.days[0].stops[1].arrival).toMatchObject({
    mode: 'ferry',
    source: 'explicit',
    quote: '坐船'
  });
  expect(result.days[1].stops[0].arrival).toMatchObject({
    mode: 'bus',
    source: 'inferred',
    fromName: '岛',
    confidence: 0.8
  });
  expect(mock.create.mock.calls[0][0].model).toBe('deepseek-flash');
  expect(i.days[1].stops[0].arrival).toBeUndefined();
});
it('does not silently route a leg that the model omitted', async () => {
  const i = fixture();
  mock.create.mockResolvedValue({
    choices: [{ message: { content: '{"legs":[]}' } }]
  });
  await expect(inferJourneyTransport(i)).rejects.toThrow('遗漏交通段');
});

it('sends only changed legs to the model and keeps unaffected ferry metadata and geometry', async () => {
  const source = fixture();
  const [a, b] = source.days[0].stops,
    c = source.days[1].stops[0];
  source.transportNeedsReview = true;
  source.transportReviewLegs = [{ fromStopId: b.id, toStopId: c.id }];
  source.routeSegments = [
    {
      dayIndex: 1,
      fromStopId: a.id,
      toStopId: b.id,
      mode: 'ferry',
      status: 'complete',
      path: [
        [120, 30],
        [120.01, 30]
      ]
    }
  ];
  mock.create.mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            legs: [
              {
                fromStopId: b.id,
                toStopId: c.id,
                arrival: {
                  mode: 'bus',
                  source: 'inferred',
                  label: '公交',
                  quote: ''
                }
              }
            ]
          })
        }
      }
    ]
  });
  const result = await inferJourneyTransport(source);
  const input = JSON.parse(mock.create.mock.calls[0][0].messages[1].content);
  expect(input.legs).toHaveLength(1);
  expect(input.legs[0]).toMatchObject({ fromStopId: b.id, toStopId: c.id });
  expect(result.days[0].stops[1].arrival).toEqual(b.arrival);
  expect(result.routeSegments).toEqual(source.routeSegments);
  expect(result.transportNeedsReview).toBe(false);
  expect(result.transportReviewLegs).toEqual([]);
});
it('does not call a model when an edit has no changed legs', async () => {
  const source = fixture();
  source.transportNeedsReview = true;
  source.transportReviewLegs = [];
  const next = await inferJourneyTransport(source);
  expect(mock.create).not.toHaveBeenCalled();
  expect(next.transportNeedsReview).toBe(false);
});

it('rejects overseas coordinates before spending a model request', async () => {
  const source = fixture();
  source.days[0].stops[0].poiMatch!.location = [139.69, 35.68];
  await expect(inferJourneyTransport(source)).rejects.toMatchObject({ status: 422 });
  expect(mock.create).not.toHaveBeenCalled();
});
