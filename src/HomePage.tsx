import { useAuth, AuthControls } from './Auth';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Car,
  Clapperboard,
  Clock3,
  FileText,
  History,
  MapPin,
  Mountain,
  Plus,
  Route,
  Settings2
} from 'lucide-react';
import { listItineraries } from './api';
import type { ItinerarySummary } from './shared/itinerary';
import './home.css';

const examples = [
  {
    city: '武汉',
    english: 'Wuhan',
    title: '沿着东湖，慢慢走',
    meta: '湖畔漫游 · 1 天 4 站',
    text: '武汉东湖一日游\nDay 1：湖北省博物馆 → 湖北美术馆 → 东湖绿道 → 东湖之眼'
  },
  {
    city: '杭州',
    english: 'Hangzhou',
    title: '把西湖，装进口袋',
    meta: '湖光山色 · 1 天 4 站',
    text: '杭州西湖一日游\nDay 1：断桥残雪 → 白堤 → 曲院风荷 → 雷峰塔'
  },
  {
    city: '长沙',
    english: 'Changsha',
    title: '在烟火里，逛一座城',
    meta: '城市漫步 · 1 天 4 站',
    text: '长沙一日游\nDay 1：湖南博物院 → 五一广场 → 太平老街 → 杜甫江阁'
  }
];

export function HomePage({
  children,
  busy,
  canManageSettings,
  onSettings,
  onExample
}: {
  children: ReactNode;
  busy: boolean;
  canManageSettings: boolean;
  onSettings: () => void;
  onExample: (text: string) => void;
}) {
  const { session } = useAuth();
  const composer = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<ItinerarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    let active = true;
    if (!session.user) {
      setLoading(false);
      setRecent([]);
      return;
    }
    setHistoryError(false);
    setLoading(true);
    listItineraries(3)
      .then(({ items }) => {
        if (active) setRecent(items);
      })
      .catch(() => {
        if (active) setHistoryError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.user?.id]);
  function focusImport() {
    composer.current?.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'center'
    });
    composer.current?.querySelector('textarea')?.focus({ preventScroll: true });
  }
  return (
    <div className="home-page">
      <header className="home-header">
        <a href="/" className="home-brand" aria-label="Map Tour 首页">
          <Mountain size={31} strokeWidth={1.6} />
          <span>MAP TOUR</span>
        </a>
        <nav aria-label="首页导航">
          <AuthControls />
          <button
            type="button"
            className="home-new"
            disabled={busy}
            onClick={focusImport}
          >
            <Plus size={15} />
            <span>新建行程</span>
          </button>
          <a href="/history">
            <History size={16} />
            <span>历史行程</span>
          </a>
          {canManageSettings && (
            <button
              type="button"
              onClick={onSettings}
              disabled={busy}
              aria-label="服务设置"
            >
              <Settings2 size={17} />
              <span>设置</span>
            </button>
          )}
        </nav>
      </header>
      <main className="home-main">
        <section className="home-hero" aria-labelledby="home-title">
          <p className="home-kicker">
            TRAVEL JOURNAL <span>/</span> 旅程手记
          </p>
          <h1 id="home-title">
            把行程，变成一部
            <span>
              旅行电影
              <svg viewBox="0 0 300 16" aria-hidden="true">
                <path d="M3 11Q142-1 296 8M38 15Q177 3 277 12" />
              </svg>
            </span>
          </h1>
          <p className="home-subtitle">
            文字或截图，都可以开始。
            <br className="home-mobile-break" />
            让每一站风景，都有自己的故事。
          </p>
          <div
            className="home-composer-wrap"
            ref={composer}
            id="journey-import"
          >
            <div className="home-trip-stamp" aria-hidden="true">
              <span>LET’S GO</span>
              <Car size={21} strokeWidth={1.5} />
              <small>下一站，出发</small>
            </div>
            <div
              className="home-hero-postcard home-hero-postcard-left"
              aria-hidden="true"
            >
              <div>
                <img src="/images/travel-postcards.webp" alt="" />
              </div>
              <span>
                武汉 · 东湖<small>Wuhan</small>
              </span>
            </div>
            <div
              className="home-hero-postcard home-hero-postcard-right"
              aria-hidden="true"
            >
              <div>
                <img src="/images/travel-postcards.webp" alt="" />
              </div>
              <span>
                杭州 · 西湖<small>Hangzhou</small>
              </span>
            </div>
            {children}
          </div>
          <div className="home-workflow" aria-label="制作步骤">
            <span>
              <FileText size={15} />
              导入行程
            </span>
            <ArrowRight size={13} />
            <span>
              <Route size={15} />
              确认路线
            </span>
            <ArrowRight size={13} />
            <span>
              <Clapperboard size={15} />
              生成影片
            </span>
          </div>
        </section>
        <section
          className="home-examples"
          aria-labelledby="home-examples-title"
        >
          <div className="home-section-heading">
            <div>
              <p className="home-kicker">A LITTLE INSPIRATION</p>
              <h2 id="home-examples-title">从一段小旅行开始</h2>
            </div>
            <p>
              选一张明信片，试试这条路线
              <ArrowRight size={15} />
            </p>
          </div>
          <div className="home-postcards">
            {examples.map((item, index) => (
              <button
                className={`home-postcard postcard-${index}`}
                disabled={busy}
                key={item.city}
                onClick={() => {
                  onExample(item.text);
                  focusImport();
                }}
                aria-label={`填入${item.city}一日游示例`}
              >
                <div className="home-postcard-photo" aria-hidden="true">
                  <img
                    src="/images/travel-postcards.webp"
                    alt=""
                    loading="lazy"
                    style={{ left: `${index * -100}%` }}
                  />
                  <span>
                    <MapPin size={12} />
                    {item.city}
                  </span>
                </div>
                <div className="home-postcard-caption">
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.meta}</p>
                  </div>
                  <span>
                    {item.english}
                    <ArrowRight size={16} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
        <section className="home-recent" aria-labelledby="home-recent-title">
          <div className="home-section-heading">
            <div>
              <p className="home-kicker">YOUR TRAVEL STORIES</p>
              <h2 id="home-recent-title">继续你的旅行故事</h2>
            </div>
            <a href="/history">
              全部行程
              <ArrowRight size={15} />
            </a>
          </div>
          {!session.user ? (
            <p className="home-empty">登录后，你的旅行手记会保存在这里。</p>
          ) : loading ? (
            <p className="home-empty" role="status">
              正在翻开你的旅行手记…
            </p>
          ) : historyError ? (
            <p className="home-empty">
              暂时无法读取最近行程，<a href="/history">前往历史行程重试</a>。
            </p>
          ) : recent.length ? (
            <div className="home-recent-grid">
              {recent.map((item, index) => (
                <a
                  href={`/s/${encodeURIComponent(item.id)}`}
                  className="home-recent-card"
                  key={item.id}
                >
                  <span className="home-recent-number">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>
                      {item.daysCount} 天 · {item.stopCount} 个地点
                    </p>
                    <small>
                      <Clock3 size={11} />
                      {new Date(item.updatedAt).toLocaleDateString(
                        'zh-CN'
                      )}{' '}
                      更新
                    </small>
                  </div>
                  <ArrowRight size={17} />
                </a>
              ))}
            </div>
          ) : (
            <p className="home-empty">
              第一段旅行故事，从上面的行程开始。生成后会自动保存在这里。
            </p>
          )}
        </section>
      </main>
      <footer className="home-footer">
        <span>
          MAP TOUR <i>·</i> 把沿途，留成故事。
        </span>
        <span>下一站，总有新的风景。</span>
      </footer>
    </div>
  );
}
