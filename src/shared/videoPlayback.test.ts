import { expect, it } from 'vitest';
import { playbackClock, playbackMoment } from './videoPlayback';
import type { VideoPlan } from './videoPlan';

const plan = {
  intro: 3, journeyEnd: 18,
  stops: [{ id: 'a', name: '西湖' }, { id: 'b', name: '灵隐寺' }, { id: 'c', name: '运河' }],
  segments: [
    { fromStopId: 'a', toStopId: 'b', dayIndex: 1, toDayIndex: 1 },
    { fromStopId: 'b', toStopId: 'c', dayIndex: 1, toDayIndex: 2, isInterDay: true }
  ],
  events: [{ start: 3, end: 7, holdEnd: 9 }, { start: 9, end: 15, holdEnd: 18 }]
} as VideoPlan;

it('describes the same leg after jumping between intro, arrival, a new leg and the ending', () => {
  expect(playbackMoment(plan, 0).phase).toBe('intro');
  expect(playbackMoment(plan, 5)).toMatchObject({ phase: 'travel', day: 1, label: '西湖 → 灵隐寺' });
  expect(playbackMoment(plan, 7)).toMatchObject({ phase: 'arrival', label: '已抵达 灵隐寺' });
  expect(playbackMoment(plan, 9).label).toBe('灵隐寺 → 运河');
  expect(playbackMoment(plan, 9).dayLabel).toBe('跨天衔接');
  expect(playbackMoment(plan, 15)).toMatchObject({ phase: 'arrival', day: 2, label: '已抵达 运河' });
  expect(playbackMoment(plan, 18).phase).toBe('outro');
  expect(playbackMoment(plan, 5).label).toBe('西湖 → 灵隐寺');
});

it('keeps the displayed timeline readable past one minute', () => {
  expect(playbackClock(65.8)).toBe('1:05');
  expect(playbackClock(180)).toBe('3:00');
});
