import { describe, expect, it } from 'vitest';
import {
  createDetailPlan,
  createVideoPlan,
  mercator,
  type VideoItinerary
} from './videoPlan';
import type { Coordinate, Stop } from './itinerary';

function stop(
  id: string,
  dayIndex: number,
  location: Coordinate,
  city = '杭州'
): Stop {
  return {
    id,
    dayIndex,
    order: 1,
    label: id,
    name: id,
    city,
    poiMatch: { status: 'matched', name: id, location }
  };
}

function fixture(): VideoItinerary {
  const a = stop('湖边', 1, [120.15, 30.25]),
    b = stop('山上', 1, [120.14, 30.24]);
  const c = stop('博物馆', 3, [114.3, 30.6], '武汉');
  return {
    id: 'test',
    title: '双城旅行',
    language: 'zh',
    dateRange: {},
    alternatives: [],
    days: [
      {
        dayIndex: 1,
        title: '第一天',
        stops: [a, b],
        alternatives: [stop('备选', 1, [100, 40])]
      },
      { dayIndex: 2, title: '休息', stops: [], alternatives: [] },
      { dayIndex: 3, title: '第三天', stops: [c], alternatives: [] }
    ],
    routeSegments: [
      {
        dayIndex: 1,
        fromStopId: a.id,
        toStopId: b.id,
        mode: 'walking',
        status: 'complete',
        path: [
          [120.15, 30.25],
          [120.148, 30.242],
          [120.14, 30.24]
        ]
      }
    ]
  };
}

describe('local video planner', () => {
  it('preserves explicitly illustrated transport geometry while keeping its indication', () => {
    const source = fixture();
    source.days = [source.days[0]];
    source.routeSegments[0].mode = 'ferry';
    source.routeSegments[0].status = 'illustrative';
    const plan = createVideoPlan(source);
    expect(plan.segments[0].path).toEqual(source.routeSegments[0].path);
    expect(plan.segments[0]).toMatchObject({
      mode: 'ferry',
      illustrative: true
    });
    expect(plan.warnings[0]).toContain('原数据中的示意路线');
  });
  it('uses saved geometry, excludes alternatives, and explicitly illustrates missing cross-day routes', () => {
    const source = fixture(),
      before = structuredClone(source),
      plan = createVideoPlan(source, { durationSeconds: 24 });
    expect(source).toEqual(before);
    expect(plan.stops.map((s) => s.id)).toEqual(['湖边', '山上', '博物馆']);
    expect(plan.segments[0]).toMatchObject({
      mode: 'walking',
      illustrative: false,
      path: source.routeSegments[0].path
    });
    expect(plan.segments[1]).toMatchObject({
      isInterDay: true,
      dayIndex: 1,
      toDayIndex: 3,
      illustrative: true,
      sourceMode: 'straight'
    });
    expect(plan.segments[1].path).toEqual([
      [120.14, 30.24],
      [114.3, 30.6]
    ]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.segments[1].wideCameraHeight).toBeGreaterThan(
      plan.segments[1].cameraHeight
    );
  });

  it('allocates an exact frame budget including short moves and destination holds', () => {
    const plan = createVideoPlan(fixture(), { durationSeconds: 23.43 });
    expect(plan.frames).toBe(703);
    expect(plan.events[0].start).toBe(plan.intro);
    expect(plan.events[0].holdEnd).toBe(plan.events[1].start);
    expect(plan.events.at(-1)!.holdEnd).toBe(plan.journeyEnd);
    expect(plan.journeyEnd + 4).toBe(plan.duration);
    for (const event of plan.events) {
      expect(event.end - event.start).toBeGreaterThanOrEqual(0.8);
      expect(event.holdEnd - event.end).toBeCloseTo(1.5);
    }
    expect(() => createVideoPlan(fixture(), { durationSeconds: 8 })).toThrow(
      '时长过短'
    );
  });

  it('derives overview height from geographic extent rather than a fixed city or day count', () => {
    const source = fixture(),
      multi = createVideoPlan(source);
    source.days = [source.days[0]];
    const single = createVideoPlan(source);
    expect(single.layers).toHaveLength(1);
    expect(multi.layers).toHaveLength(3);
    expect(multi.overviewHeight).toBeGreaterThan(single.overviewHeight * 20);
    expect(multi.layers.slice(1).map((m) => m.label)).toEqual(['杭州', '武汉']);
    expect(multi.stops.every((s) => s.point.every(Number.isFinite))).toBe(true);
  });

  it('rejects unresolved primary stops instead of silently dropping or inventing destinations', () => {
    const source = fixture();
    source.days[0].stops[1].poiMatch = { status: 'pending', name: '山上' };
    expect(() => createVideoPlan(source)).toThrow('山上');
  });

  it('renders a one-stop itinerary without zero-length division or fictional movement', () => {
    const source = fixture();
    source.days = [{ ...source.days[0], stops: [source.days[0].stops[0]] }];
    source.routeSegments = [];
    const plan = createVideoPlan(source);
    expect(plan.segments[0].distanceMeters).toBe(0);
    expect(plan.segments[0].path).toHaveLength(2);
    expect(plan.overviewHeight).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);
  });

  it('plans sparse high-detail levels and stops before excessive capture work', () => {
    const source = fixture();
    source.days = [source.days[0]];
    const plan = createVideoPlan(source);
    const detail = createDetailPlan(plan, [
      {
        height: 10,
        mode: 'walking',
        points: [
          [-4, -4],
          [4, 4]
        ]
      }
    ]);
    expect(new Set(detail.tiles.map((t) => t.zoom))).toEqual(new Set([16, 17]));
    expect(
      detail.tiles.every(
        (t) => t.width === 2048 && t.center.every(Number.isFinite)
      )
    ).toBe(true);
    expect(() =>
      createDetailPlan(
        plan,
        [
          {
            height: 10,
            mode: 'walking',
            points: [
              [-1000, -1000],
              [1000, 1000]
            ]
          }
        ],
        10
      )
    ).toThrow('过多');
  });
});

it('gives a ten-leg trip enough time for calm travel and readable arrival holds', () => {
  const source = fixture();
  source.days = [
    {
      dayIndex: 1,
      title: '环岛游',
      alternatives: [],
      stops: Array.from({ length: 11 }, (_, index) =>
        stop('景点' + index, 1, [119.8 + index * 0.002, 25.5])
      )
    }
  ];
  source.routeSegments = [];
  const plan = createVideoPlan(source);
  expect(plan.duration).toBe(72);
  expect(plan.events.every((event) => event.holdEnd - event.end >= 1.49)).toBe(
    true
  );
  expect(plan.events.every((event) => event.end - event.start >= 4)).toBe(true);
  expect(createVideoPlan(source, { durationSeconds: 90 }).duration).toBe(90);
});

it('uses native satellite zoom levels while keeping route locations inside each atlas', () => {
  const plan = createVideoPlan(fixture());
  for (const layer of plan.layers) {
    expect(Number.isInteger(layer.zoom)).toBe(true);
    const center = mercator(layer.center),
      scale = 256 * 2 ** layer.zoom;
    const stops = plan.stops.filter(
      (stop) => !layer.label || stop.city === layer.label
    );
    for (const stop of stops) {
      const point = mercator(stop.poiMatch!.location!);
      expect(Math.abs(point[0] - center[0]) * scale).toBeLessThan(
        layer.width / 2
      );
      expect(Math.abs(point[1] - center[1]) * scale).toBeLessThan(
        layer.height / 2
      );
    }
  }
});
