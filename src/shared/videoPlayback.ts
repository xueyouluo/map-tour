import type { VideoPlan } from './videoPlan';

export function playbackClock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function playbackMoment(plan: VideoPlan, time: number) {
  if (time < plan.intro) return { phase: 'intro', day: null, dayLabel: '', label: '全程预览 · 跟着路线，开启旅程' };
  if (time >= plan.journeyEnd) return { phase: 'outro', day: null, dayLabel: '', label: '旅程回顾 · 每一天的足迹' };
  let index = 0;
  for (let i = 0; i < plan.events.length; i++) if (time >= plan.events[i].start) index = i;
  const segment = plan.segments[index];
  const arrived = time >= plan.events[index].end;
  const from = plan.stops.find((stop) => stop.id === segment.fromStopId)?.name || '出发地';
  const to = plan.stops.find((stop) => stop.id === segment.toStopId)?.name || '目的地';
  return { phase: arrived ? 'arrival' : 'travel', day: arrived ? segment.toDayIndex : segment.dayIndex,
    dayLabel: segment.isInterDay && !arrived ? '跨天衔接' : `第 ${arrived ? segment.toDayIndex : segment.dayIndex} 天`,
    label: arrived ? `已抵达 ${to}` : `${from} → ${to}` };
}
