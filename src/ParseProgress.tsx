import { useEffect, useId, useRef, useState } from 'react';
import { Check, MapPin, Route, Sparkles } from 'lucide-react';
import './parseProgress.css';

const stages = [
  { label: '读取行程', title: '先把每一站，认出来', icon: MapPin },
  { label: '整理地点', title: '把沿途的风景，串起来', icon: Route },
  { label: '准备旅程', title: '你的旅程，就快准备好了', icon: Sparkles }
];

// Phase changes follow parser events; the animation is indeterminate, never a percentage.
export function ParseProgress({
  message,
  hasImage
}: {
  message: string;
  hasImage: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      panel.current?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth'
      })
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const gradientId = 'journey-loading-line-' + useId().replace(/:/g, '');
  const [elapsed, setElapsed] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  const phase = /校验|检查|验证|返回完成/.test(message)
    ? 2
    : /接收|返回结构化/.test(message)
      ? 1
      : 0;
  const stage = stages[phase];
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const explanation =
    phase === 2
      ? '正在检查每天的路线，马上为你展开旅程。'
      : phase === 1
        ? '正在整理地点顺序、交通方式与旅行细节。'
        : hasImage
          ? '正在阅读截图中的地点、日期和路线安排。'
          : '正在阅读你的计划，整理日期和目的地。';
  return (
    <div ref={panel} className="journey-loading" data-phase={phase}>
      <div className="journey-loading-topline">
        <span>
          <i /> 旅程正在成形
        </span>
        <time aria-hidden="true">
          已等待 {Math.floor(elapsed / 60)}:
          {String(elapsed % 60).padStart(2, '0')}
        </time>
      </div>
      <div className="journey-loading-scene" aria-hidden="true">
        <svg viewBox="0 0 480 112" fill="none">
          <defs>
            <linearGradient
              id={gradientId}
              x1="38"
              y1="80"
              x2="446"
              y2="38"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#bed3f2" />
              <stop offset="0.5" stopColor="#5d89cf" />
              <stop offset="1" stopColor="#8db3e5" />
            </linearGradient>
          </defs>
          <g
            className="loading-landscape"
            stroke="#bccde2"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m72 50 18-21 18 21m-26-10 8 3 7-7M365 80h30m-26 0V64l11-8 11 8v16m-15-2v-9h8v9M289 25h22m-17 0v-6a6 6 0 0 1 12 0v6" />
            <path
              className="loading-cloud"
              d="M168 21h24a5 5 0 0 0 0-10 8 8 0 0 0-15-2 6 6 0 0 0-9 12Z"
            />
            <path
              className="loading-cloud loading-cloud-second"
              d="M410 29h20a4 4 0 0 0 0-8 7 7 0 0 0-13-2 5 5 0 0 0-7 10Z"
            />
          </g>
          <path
            className="loading-route-track"
            d="M38 80C98 80 107 36 176 36S257 90 328 75 381 37 442 38"
            stroke="#dce6f3"
            strokeWidth="3"
            strokeDasharray="4 7"
          />
          <path
            className="loading-route-draw"
            pathLength="1"
            d="M38 80C98 80 107 36 176 36S257 90 328 75 381 37 442 38"
            stroke={`url(#${gradientId})`}
            strokeWidth="3"
            strokeLinecap="round"
          />
          {[
            [38, 80],
            [176, 36],
            [328, 75],
            [442, 38]
          ].map(([x, y], index) => (
            <g key={x} className={`loading-waypoint loading-waypoint-${index}`}>
              <circle
                className="loading-waypoint-halo"
                cx={x}
                cy={y}
                r="11"
                fill="#8cafe3"
              />
              <circle
                cx={x}
                cy={y}
                r="5"
                fill="#fff"
                stroke="#7099d2"
                strokeWidth="2"
              />
            </g>
          ))}
          <g transform={reducedMotion ? 'translate(176 36)' : undefined}>
            {!reducedMotion && (
              <animateMotion
                dur="6s"
                repeatCount="indefinite"
                rotate="auto"
                path="M38 80C98 80 107 36 176 36S257 90 328 75 381 37 442 38"
              />
            )}
            <ellipse cy="5" rx="12" ry="4" fill="#234d8720" />
            <rect
              x="-9"
              y="-5"
              width="18"
              height="10"
              rx="3"
              fill="#4479c5"
              stroke="#fff"
              strokeWidth="2"
            />
            <rect x="-3" y="-3" width="7" height="6" rx="1.5" fill="#c1dcf4" />
            <path
              d="M-6-6h3m-3 12h3m8-12h2M5 6h2"
              stroke="#34557d"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
          <g
            fill="#8aa1c0"
            fontSize="8"
            fontFamily="inherit"
            letterSpacing="1.5"
          >
            <text x="26" y="106">
              出发
            </text>
            <text x="424" y="68">
              下一站
            </text>
          </g>
        </svg>
      </div>
      <div
        className="journey-loading-copy"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong key={phase}>
          {stage.title}
          <span className="loading-ellipsis" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </strong>
        <p>{explanation}</p>
      </div>
      <ol className="journey-loading-stages" aria-label="行程整理进度">
        {stages.map((item, index) => {
          const Icon = index < phase ? Check : item.icon;
          return (
            <li
              key={item.label}
              data-state={
                index < phase
                  ? 'complete'
                  : index === phase
                    ? 'active'
                    : 'upcoming'
              }
              aria-current={index === phase ? 'step' : undefined}
            >
              <span>
                <Icon size={12} strokeWidth={1.8} />
              </span>
              {item.label}
            </li>
          );
        })}
      </ol>
      {elapsed >= 35 && (
        <p className="journey-loading-reassurance">
          {elapsed >= 75
            ? '还在认真整理中，完成后会自动展开你的旅程。'
            : '丰富的行程值得多一点耐心，页面会自动更新。'}
        </p>
      )}
    </div>
  );
}
