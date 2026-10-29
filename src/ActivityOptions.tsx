import './activityOptions.css';
import { useState } from 'react';
import {
  BedDouble,
  Check,
  ChevronDown,
  MapPin,
  Plus,
  Utensils
} from 'lucide-react';
import type { ItineraryDay, ParsedStop, Stop } from './shared/itinerary';
import { activityDescription } from './shared/activities';
import { getDayActivityOptions } from './shared/optionalPlaces';

export function ActivityOptions({
  day,
  lodging,
  dining,
  busy,
  onToggle,
  onLocate
}: {
  day: ItineraryDay;
  lodging: ParsedStop[];
  dining: ParsedStop[];
  busy: boolean;
  onToggle: (dayIndex: number, option: Stop, include: boolean) => void;
  onLocate: (stopId: string) => void;
}) {
  const options = getDayActivityOptions(day, { lodging, dining });
  const [group, setGroup] = useState<'meal' | 'stay'>('meal');
  const [expanded, setExpanded] = useState(false);
  const meals = options.filter((option) => option.activity?.kind === 'meal');
  const stays = options.filter((option) => option.activity?.kind === 'stay');
  const currentGroup =
    meals.length && stays.length ? group : meals.length ? 'meal' : 'stay';
  const items = currentGroup === 'meal' ? meals : stays;
  const shown = expanded ? items : items.slice(0, 3);
  if (!options.length) return null;
  return (
    <details className="activity-options">
      <summary>
        <span className="activity-summary-icon">
          <Utensils size={14} />
        </span>
        <strong>用餐与住宿</strong>
        <span className="activity-summary-count">{options.length} 处备选</span>
        <ChevronDown size={14} className="activity-chevron" />
      </summary>
      <div className="activity-options-body">
        <p className="activity-options-hint">
          已标在地图上，加入后才会经过这里。
        </p>
        <div
          className="activity-tabs"
          role="group"
          aria-label={`第 ${day.dayIndex} 天吃住类型`}
        >
          {(
            [
              ['meal', '用餐', meals.length],
              ['stay', '住宿', stays.length]
            ] as const
          ).map(([kind, label, count]) => (
            <button
              type="button"
              key={kind}
              aria-pressed={currentGroup === kind}
              onClick={() => {
                setGroup(kind);
                setExpanded(false);
              }}
              disabled={!count}
            >
              {kind === 'meal' ? (
                <Utensils size={13} />
              ) : (
                <BedDouble size={13} />
              )}{' '}
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <div className="activity-cards">
          {shown.map((option) => {
            const included = day.stops.some((stop) => stop.id === option.id);
            const located = Boolean(option.poiMatch?.location);
            return (
              <article
                className={`activity-place-card ${included ? 'is-included' : ''}`}
                key={option.id}
              >
                <div className={`activity-place-icon is-${currentGroup}`}>
                  {currentGroup === 'meal' ? (
                    <Utensils size={15} />
                  ) : (
                    <BedDouble size={15} />
                  )}
                </div>
                <div className="activity-place-content">
                  <b>{option.name}</b>
                  <small>
                    {activityDescription(option)}
                    {option.time ? ' · ' + option.time : ''}
                  </small>
                  <div className="activity-card-actions">
                    <button
                      className="activity-locate"
                      type="button"
                      disabled={!located}
                      onClick={() => onLocate(option.id)}
                    >
                      <MapPin size={12} />
                      {located
                        ? '地图查看'
                        : option.poiMatch?.status === 'unmatched'
                          ? '位置待确认'
                          : '定位中'}
                    </button>
                    <button
                      className="activity-route-toggle"
                      type="button"
                      aria-pressed={included}
                      disabled={busy}
                      aria-label={`${included ? '移除' : '加入'}第 ${day.dayIndex} 天${option.name}`}
                      onClick={() => onToggle(day.dayIndex, option, !included)}
                    >
                      {included ? <Check size={12} /> : <Plus size={12} />}{' '}
                      {included ? '已选入' : `选择 D${day.dayIndex}`}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {items.length > 3 && (
          <button
            className="activity-show-more"
            type="button"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : `查看其余 ${items.length - 3} 处`}
          </button>
        )}
      </div>
    </details>
  );
}
