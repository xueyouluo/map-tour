import { BusFront, CalendarDays, Car, Check, Copy, ExternalLink, FileImage, Footprints, Loader2, MapPinned, Route as RouteIcon, Share2, SlidersHorizontal, Trash2, Upload, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type MutableRefObject } from 'react';
import { enrichItineraryWithAmap, loadAMap } from './amap';
import { getConfig, loadItinerary, parseItineraryStream, saveItinerary, type ParseStreamEvent, type RuntimeConfig } from './api';
import {
  colorForDay,
  getVisibleDays,
  hasPendingPoiMatches,
  removeStopFromItinerary,
  type Itinerary,
  type ItineraryDay,
  type RoutePreference,
  type Stop,
  type TripScope
} from './shared/itinerary';

type ActiveDay = number | 'all';
type AMapNamespace = any;
type CopyStatus = 'idle' | 'copied' | 'failed';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function formatParseProgress(hasImage: boolean, elapsedMs: number): string {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const phases = hasImage
    ? [
        '正在上传图片并读取行程内容',
        '视觉理解模型正在识别截图文字',
        '正在按日期拆分路线和地点',
        '正在整理为地图可用的结构',
        '图片解析时间可能较长，仍在等待模型返回'
      ]
    : [
        '正在读取文本行程',
        '文本模型正在抽取日期、地点和顺序',
        '正在整理备注、备选点和推荐店铺',
        '正在生成地图可用的行程结构',
        '解析仍在进行，请稍候'
      ];
  const phase = phases[Math.min(phases.length - 1, Math.floor(elapsedMs / 5000))];
  const dots = '.'.repeat((Math.floor(elapsedMs / 1200) % 3) + 1);
  return `${phase}${dots}${elapsedSeconds >= 6 ? `（${elapsedSeconds}s）` : ''}`;
}

function handleParseStreamEvent(
  event: ParseStreamEvent,
  setParseStatus: (message: string) => void,
  lastEventRef: MutableRefObject<number>
) {
  if (event.type !== 'status' && event.type !== 'progress') return;
  lastEventRef.current = Date.now();
  setParseStatus(event.message);
}

function formatFileSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function App() {
  const shareId = useMemo(() => window.location.pathname.match(/^\/s\/([^/]+)/)?.[1], []);
  const readOnly = Boolean(shareId);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [activeDay, setActiveDay] = useState<ActiveDay>('all');
  const [routePreference, setRoutePreference] = useState<RoutePreference>('auto');
  const [connectDays, setConnectDays] = useState(false);
  const [showMapLabels, setShowMapLabels] = useState(true);
  const [parseStatus, setParseStatus] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [parseHasImage, setParseHasImage] = useState(false);
  const [parseStartedAt, setParseStartedAt] = useState<number | null>(null);
  const [shareUrl, setShareUrl] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState('');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const lastParseEventAtRef = useRef(0);

  useEffect(() => {
    if (!shareId) return;
    setParseStatus('正在读取分享行程...');
    loadItinerary(shareId)
      .then(({ itinerary: loaded }) => {
        setItinerary(loaded);
        setParseStatus('');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setParseStatus('');
      });
  }, [shareId]);

  useEffect(() => {
    if (!isParsing || !parseStartedAt) return;

    const updateProgress = () => {
      if (Date.now() - lastParseEventAtRef.current < 2600) return;
      setParseStatus(formatParseProgress(parseHasImage, Date.now() - parseStartedAt));
    };

    updateProgress();
    const timer = window.setInterval(updateProgress, 1600);
    return () => window.clearInterval(timer);
  }, [isParsing, parseHasImage, parseStartedAt]);

  async function handleParse(text: string, image?: File | null) {
    const hasImage = Boolean(image);
    setError('');
    setShareUrl('');
    setShareDialogOpen(false);
    setCopyStatus('idle');
    setIsParsing(true);
    setParseHasImage(hasImage);
    setParseStartedAt(Date.now());
    lastParseEventAtRef.current = Date.now();
    setParseStatus(formatParseProgress(hasImage, 0));
    try {
      const result = await parseItineraryStream(text, image, (event) => {
        handleParseStreamEvent(event, setParseStatus, lastParseEventAtRef);
      });
      setItinerary(result.itinerary);
      setActiveDay('all');
      setRoutePreference('auto');
      setConnectDays(false);
      setSelectedStopId(null);
      setParseStatus(result.warning || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setParseStatus('');
    } finally {
      setIsParsing(false);
      setParseStartedAt(null);
    }
  }

  async function handleShare() {
    if (!itinerary) return;
    setError('');
    setCopyStatus('idle');
    setIsSharing(true);
    try {
      const result = await saveItinerary(itinerary);
      const absoluteUrl = new URL(result.shareUrl, window.location.origin).toString();
      setItinerary(result.itinerary);
      setShareUrl(absoluteUrl);
      setShareDialogOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSharing(false);
    }
  }

  async function handleCopyShareUrl() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  function handleRoutePreferenceChange(nextPreference: RoutePreference) {
    setRoutePreference(nextPreference);
    setSelectedStopId(null);
    setItinerary((current) => current
      ? {
          ...current,
          routeSegments: [],
          updatedAt: new Date().toISOString()
        }
      : current);
  }

  function handleConnectDaysChange(nextConnectDays: boolean) {
    setConnectDays(nextConnectDays);
    setSelectedStopId(null);
    setActiveDay('all');
    setItinerary((current) => current
      ? {
          ...current,
          routeSegments: [],
          updatedAt: new Date().toISOString()
        }
      : current);
  }

  function handleStopDelete(stopId: string) {
    setSelectedStopId(null);
    setItinerary((current) => (current ? removeStopFromItinerary(current, stopId) : current));
  }

  const visibleDays = itinerary ? getVisibleDays(itinerary, activeDay) : [];

  return (
    <div className="app-shell">
      <aside className="side-panel" aria-label="行程">
        <PanelHeader readOnly={readOnly} />
        {!readOnly && <ImportPanel onParse={handleParse} busy={isParsing} progressMessage={isParsing ? parseStatus : ''} />}
        {itinerary && (
          <ItineraryPanel
            itinerary={itinerary}
            visibleDays={visibleDays}
            activeDay={activeDay}
            onDayChange={setActiveDay}
            routePreference={routePreference}
            onRoutePreferenceChange={handleRoutePreferenceChange}
            connectDays={connectDays}
            onConnectDaysChange={handleConnectDaysChange}
            showMapLabels={showMapLabels}
            onShowMapLabelsChange={setShowMapLabels}
            onShare={handleShare}
            isSharing={isSharing}
            selectedStopId={selectedStopId}
            onStopSelect={setSelectedStopId}
            onStopDelete={handleStopDelete}
            readOnly={readOnly}
          />
        )}
        {!itinerary && readOnly && <EmptyState title="没有找到行程" body="这个分享链接可能已失效，或本地存储文件中没有对应数据。" />}
        <StatusBlock message={isParsing ? '' : parseStatus} error={error} />
      </aside>

      <main className="map-stage">
        <MapView
          itinerary={itinerary}
          activeDay={activeDay}
          onDayChange={setActiveDay}
          onItineraryChange={setItinerary}
          routePreference={routePreference}
          connectDays={connectDays}
          showMapLabels={showMapLabels}
          selectedStopId={selectedStopId}
          onStopSelect={setSelectedStopId}
          readOnly={readOnly}
        />
      </main>

      {shareDialogOpen && shareUrl && (
        <ShareDialog
          shareUrl={shareUrl}
          copyStatus={copyStatus}
          onCopy={handleCopyShareUrl}
          onClose={() => setShareDialogOpen(false)}
        />
      )}
    </div>
  );
}

function PanelHeader({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="panel-header">
      <div className="brand-row">
        <div className="brand-mark">
          <MapPinned size={18} />
        </div>
        <span>RouteBrief</span>
      </div>
      <h1>{readOnly ? '分享行程地图' : '行程转地图'}</h1>
      <p>{readOnly ? '按天查看路线、地点和备注。' : '粘贴文字、Markdown、表格，或上传行程截图。'}</p>
    </div>
  );
}

function ImportPanel({
  onParse,
  busy,
  progressMessage
}: {
  onParse: (text: string, image?: File | null) => void;
  busy: boolean;
  progressMessage: string;
}) {
  const [text, setText] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [fileError, setFileError] = useState('');

  useEffect(() => {
    if (!image) {
      setImagePreviewUrl('');
      return;
    }

    const objectUrl = URL.createObjectURL(image);
    setImagePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);

  function handleImageFile(file?: File | null) {
    setFileError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFileError('只支持上传图片文件。');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError(`图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB。`);
      return;
    }
    setImage(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImage = getClipboardImageFile(event.clipboardData);
    if (pastedImage) {
      handleImageFile(pastedImage);
    }
  }

  function handleDrop(event: DragEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    handleImageFile(Array.from(event.dataTransfer.files)[0] || null);
  }

  return (
    <section className="import-box">
      <label className="field-label" htmlFor="itinerary-input">行程内容</label>
      <textarea
        id="itinerary-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
        placeholder="粘贴文字、Markdown、CSV/TSV 表格，也可以直接粘贴截图..."
      />
      <div className="import-actions">
        <label className="file-button">
          <FileImage size={16} />
          <span>{image ? image.name : '上传截图'}</span>
          <input
            type="file"
            accept="image/*"
            onChange={(event) => handleImageFile(event.target.files?.[0] || null)}
          />
        </label>
      </div>
      {fileError && <div className="import-error" role="alert">{fileError}</div>}
      {image && imagePreviewUrl && (
        <div className="image-preview">
          <img src={imagePreviewUrl} alt="已选择的行程截图预览" />
          <div className="image-preview-meta">
            <strong>{image.name}</strong>
            <span>{formatFileSize(image.size)}</span>
          </div>
          <button
            type="button"
            aria-label="移除图片"
            onClick={() => {
              setImage(null);
              setFileError('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <button
        className="primary-button"
        type="button"
        disabled={busy || Boolean(fileError) || (!text.trim() && !image)}
        onClick={() => onParse(text, image)}
      >
        {busy ? <Loader2 className="spin" size={17} /> : <Upload size={17} />}
        {busy ? '正在解析' : '生成地图'}
      </button>
      {progressMessage && (
        <div className="parse-progress" role="status" aria-live="polite">
          <Loader2 className="spin" size={15} />
          <span>{progressMessage}</span>
        </div>
      )}
    </section>
  );
}

function getClipboardImageFile(data: DataTransfer): File | null {
  const directFile = Array.from(data.files).find((file) => file.type.startsWith('image/'));
  if (directFile) return directFile;

  const imageItem = Array.from(data.items).find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  const file = imageItem?.getAsFile();
  if (!file) return null;
  if (file.name) return file;
  return new File([file], `pasted-itinerary-${Date.now()}.png`, { type: file.type || 'image/png' });
}

function ItineraryPanel({
  itinerary,
  visibleDays,
  activeDay,
  onDayChange,
  routePreference,
  onRoutePreferenceChange,
  connectDays,
  onConnectDaysChange,
  showMapLabels,
  onShowMapLabelsChange,
  onShare,
  isSharing,
  selectedStopId,
  onStopSelect,
  onStopDelete,
  readOnly
}: {
  itinerary: Itinerary;
  visibleDays: ItineraryDay[];
  activeDay: ActiveDay;
  onDayChange: (day: ActiveDay) => void;
  routePreference: RoutePreference;
  onRoutePreferenceChange: (preference: RoutePreference) => void;
  connectDays: boolean;
  onConnectDaysChange: (connectDays: boolean) => void;
  showMapLabels: boolean;
  onShowMapLabelsChange: (show: boolean) => void;
  onShare: () => void;
  isSharing: boolean;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete: (stopId: string) => void;
  readOnly: boolean;
}) {
  const pendingPoi = hasPendingPoiMatches(itinerary);

  return (
    <section className="itinerary-content">
      <div className="trip-summary">
        <h2>{itinerary.title}</h2>
        <div className="date-line">
          <CalendarDays size={16} />
          <span>{itinerary.dateRange.label || [itinerary.dateRange.start, itinerary.dateRange.end].filter(Boolean).join(' - ') || '日期未识别'}</span>
        </div>
        <TripScopeLine scope={itinerary.tripScope} />
      </div>

      <DaySelector itinerary={itinerary} activeDay={activeDay} onDayChange={onDayChange} />
      <MapDisplayControls
        routePreference={routePreference}
        onRoutePreferenceChange={onRoutePreferenceChange}
        connectDays={connectDays}
        onConnectDaysChange={onConnectDaysChange}
        showMapLabels={showMapLabels}
        onShowMapLabelsChange={onShowMapLabelsChange}
        allowRouteChange={!readOnly}
      />

      <div className="day-list">
        {visibleDays.map((day) => (
          <DaySection
            key={day.dayIndex}
            day={day}
            selectedStopId={selectedStopId}
            onStopSelect={onStopSelect}
            onStopDelete={!readOnly ? onStopDelete : undefined}
          />
        ))}
        {activeDay === 'all' && itinerary.alternatives.length > 0 && (
          <AlternativeSection
            stops={itinerary.alternatives}
            title="推荐/备选地点"
            selectedStopId={selectedStopId}
            onStopSelect={onStopSelect}
            onStopDelete={!readOnly ? onStopDelete : undefined}
          />
        )}
      </div>

      {!readOnly && (
        <div className="share-area">
          <button className="share-button" type="button" onClick={onShare} disabled={pendingPoi || isSharing}>
            {isSharing ? <Loader2 className="spin" size={17} /> : <Share2 size={17} />}
            {isSharing ? '正在生成链接' : pendingPoi ? '等待地点匹配' : '分享行程'}
          </button>
        </div>
      )}
    </section>
  );
}

function TripScopeLine({ scope }: { scope?: TripScope }) {
  const label = formatTripScope(scope);
  if (!label) return null;
  return <div className="trip-scope-line">{label}</div>;
}

function formatTripScope(scope?: TripScope): string {
  if (!scope || scope.mode === 'unknown') return '';
  const cities = (scope.cities || []).filter(Boolean);
  const cityText = cities.length
    ? cities.slice(0, 4).join(' / ') + (cities.length > 4 ? ` 等 ${cities.length} 地` : '')
    : scope.primaryCity || '';
  if (scope.mode === 'single_city') return cityText ? `单城市 · ${cityText}` : '单城市';
  return cityText ? `多城市 · ${cityText}` : '多城市路线';
}

function ShareDialog({
  shareUrl,
  copyStatus,
  onCopy,
  onClose
}: {
  shareUrl: string;
  copyStatus: CopyStatus;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="share-dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="icon-button share-dialog-close" type="button" aria-label="关闭分享弹窗" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="share-dialog-icon">
          <Share2 size={22} />
        </div>
        <h2 id="share-dialog-title">分享行程</h2>
        <p>朋友打开这个链接即可查看路线、地点和备注。</p>
        <div className="share-link-box">
          <input value={shareUrl} readOnly aria-label="分享链接" onFocus={(event) => event.currentTarget.select()} />
          <button className="copy-button" type="button" onClick={onCopy}>
            {copyStatus === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {copyStatus === 'copied' ? '已复制' : '复制链接'}
          </button>
        </div>
        {copyStatus === 'failed' && <small className="copy-hint">浏览器未允许自动复制，可以选中链接后手动复制。</small>}
        <div className="share-dialog-actions">
          <a href={shareUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            打开分享页
          </a>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}

const routeModeOptions: Array<{
  value: RoutePreference;
  label: string;
  icon: LucideIcon;
}> = [
  { value: 'auto', label: '自动', icon: SlidersHorizontal },
  { value: 'driving', label: '驾车', icon: Car },
  { value: 'transit', label: '公交', icon: BusFront },
  { value: 'walking', label: '步行', icon: Footprints }
];

function MapDisplayControls({
  routePreference,
  onRoutePreferenceChange,
  connectDays,
  onConnectDaysChange,
  showMapLabels,
  onShowMapLabelsChange,
  allowRouteChange
}: {
  routePreference: RoutePreference;
  onRoutePreferenceChange: (preference: RoutePreference) => void;
  connectDays: boolean;
  onConnectDaysChange: (connectDays: boolean) => void;
  showMapLabels: boolean;
  onShowMapLabelsChange: (show: boolean) => void;
  allowRouteChange: boolean;
}) {
  return (
    <div className="map-controls-panel">
      {allowRouteChange && (
        <div className="route-mode-selector" aria-label="路线方式">
          <div className="route-mode-title">路线方式</div>
          <div className="route-mode-options">
            {routeModeOptions.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  className={routePreference === option.value ? 'active' : ''}
                  type="button"
                  onClick={() => onRoutePreferenceChange(option.value)}
                >
                  <Icon size={15} />
                  {option.label}
                </button>
              );
            })}
          </div>
          <button
            className={`inter-day-toggle ${connectDays ? 'active' : ''}`}
            type="button"
            aria-pressed={connectDays}
            onClick={() => onConnectDaysChange(!connectDays)}
          >
            <RouteIcon size={15} />
            跨天连接
          </button>
        </div>
      )}
      <label className="map-label-toggle">
        <span>显示地点名称</span>
        <input
          type="checkbox"
          checked={showMapLabels}
          onChange={(event) => onShowMapLabelsChange(event.target.checked)}
        />
      </label>
    </div>
  );
}

function DaySection({
  day,
  selectedStopId,
  onStopSelect,
  onStopDelete
}: {
  day: ItineraryDay;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete?: (stopId: string) => void;
}) {
  const color = colorForDay(day.dayIndex);
  return (
    <div className="day-section" style={{ '--day-color': color } as React.CSSProperties}>
      <div className="day-heading">
        <span>D{day.dayIndex}</span>
        <div>
          <h3>{day.title}</h3>
          <p>{day.date || '未识别日期'}</p>
        </div>
      </div>
      <div className="stop-list">
        {day.stops.map((stop) => (
          <StopCard
            key={stop.id}
            stop={stop}
            selected={selectedStopId === stop.id}
            onSelect={onStopSelect}
            onDelete={onStopDelete}
          />
        ))}
      </div>
      {day.alternatives.length > 0 && (
        <AlternativeSection
          stops={day.alternatives}
          title="推荐/备选地点"
          selectedStopId={selectedStopId}
          onStopSelect={onStopSelect}
          onStopDelete={onStopDelete}
        />
      )}
    </div>
  );
}

function AlternativeSection({
  stops,
  title,
  selectedStopId,
  onStopSelect,
  onStopDelete
}: {
  stops: Stop[];
  title: string;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete?: (stopId: string) => void;
}) {
  return (
    <div className="alt-section">
      <h3>{title}</h3>
      {stops.map((stop) => (
        <StopCard
          key={stop.id}
          stop={stop}
          compact
          selected={selectedStopId === stop.id}
          onSelect={onStopSelect}
          onDelete={onStopDelete}
        />
      ))}
    </div>
  );
}

function StopCard({
  stop,
  compact = false,
  selected,
  onSelect,
  onDelete
}: {
  stop: Stop;
  compact?: boolean;
  selected: boolean;
  onSelect: (stopId: string) => void;
  onDelete?: (stopId: string) => void;
}) {
  const status = stop.poiMatch?.status;
  const isMatched = status === 'matched';
  const canFocusMap = Boolean(stop.poiMatch?.location);
  const handleSelect = () => {
    if (canFocusMap) onSelect(stop.id);
  };

  return (
    <article
      className={`stop-card ${compact ? 'compact' : ''} ${status === 'unmatched' ? 'unmatched' : ''} ${!canFocusMap ? 'not-focusable' : ''} ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={canFocusMap ? 0 : -1}
      aria-disabled={!canFocusMap}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="stop-card-title">
        <span>{stop.label}</span>
        <h4>{stop.name}</h4>
        {isMatched && stop.poiMatch?.amapUrl && (
          <a
            href={stop.poiMatch.amapUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="在高德地图打开"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink size={15} />
          </a>
        )}
        {onDelete && (
          <button
            className="stop-delete-button"
            type="button"
            aria-label={`删除 ${stop.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onDelete(stop.id);
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      {stop.note && <p>{stop.note}</p>}
      {stop.poiMatch?.address && <small>{stop.poiMatch.address}</small>}
      {status === 'unmatched' && (
        <small>{stop.poiMatch?.errorInfo || '未匹配到高德 POI'}，将仅保留在列表中。</small>
      )}
    </article>
  );
}

function DaySelector({
  itinerary,
  activeDay,
  onDayChange
}: {
  itinerary: Itinerary;
  activeDay: ActiveDay;
  onDayChange: (day: ActiveDay) => void;
}) {
  return (
    <div className="day-selector" role="tablist" aria-label="按天筛选">
      <button className={activeDay === 'all' ? 'active' : ''} onClick={() => onDayChange('all')} type="button">
        全部
      </button>
      {itinerary.days.map((day) => (
        <button
          key={day.dayIndex}
          className={activeDay === day.dayIndex ? 'active' : ''}
          onClick={() => onDayChange(day.dayIndex)}
          type="button"
        >
          <i style={{ background: colorForDay(day.dayIndex) }} />
          D{day.dayIndex}
        </button>
      ))}
    </div>
  );
}

function MapView({
  itinerary,
  activeDay,
  onDayChange,
  onItineraryChange,
  routePreference,
  connectDays,
  showMapLabels,
  selectedStopId,
  onStopSelect,
  readOnly
}: {
  itinerary: Itinerary | null;
  activeDay: ActiveDay;
  onDayChange: (day: ActiveDay) => void;
  onItineraryChange: (itinerary: Itinerary) => void;
  routePreference: RoutePreference;
  connectDays: boolean;
  showMapLabels: boolean;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  readOnly: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<AMapNamespace | null>(null);
  const overlaysRef = useRef<any[]>([]);
  const stopLookupRef = useRef<Map<string, { marker: any; stop: Stop; location: [number, number]; infoWindow: any }>>(new Map());
  const enrichingRef = useRef(false);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapStatus, setMapStatus] = useState('');
  const [mapError, setMapError] = useState('');

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) => setMapError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!config || !containerRef.current || mapRef.current) return;
    if (!config.amapKey) {
      setMapError('缺少 AMAP_JSAPI_KEY，地图无法加载。');
      return;
    }

    let disposed = false;
    setMapStatus('正在加载高德地图...');
    loadAMap(config.amapKey, config.hasAmapProxy)
      .then((AMap) => {
        if (disposed || !containerRef.current) return;
        amapRef.current = AMap;
        mapRef.current = new AMap.Map(containerRef.current, {
          viewMode: '3D',
          zoom: 5,
          center: [104.195, 35.861],
          pitch: 0,
          mapStyle: 'amap://styles/normal'
        });
        mapRef.current.addControl(new AMap.Scale());
        mapRef.current.addControl(new AMap.ToolBar({ position: 'RT' }));
        setMapReady(true);
        setMapStatus('');
      })
      .catch((err) => {
        setMapError(err instanceof Error ? err.message : String(err));
        setMapStatus('');
      });

    return () => {
      disposed = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [config]);

  useEffect(() => {
    const AMap = amapRef.current;
    if (!mapReady || !AMap || !itinerary || readOnly || enrichingRef.current) return;
    const expectedRouteCount = countExpectedRouteSegments(itinerary, connectDays);
    if (!hasPendingPoiMatches(itinerary) && itinerary.routeSegments.length >= expectedRouteCount) return;

    enrichingRef.current = true;
    enrichItineraryWithAmap(AMap, itinerary, routePreference, connectDays, setMapStatus)
      .then((next) => {
        onItineraryChange(next);
        setMapStatus('地点匹配和路线规划完成。');
      })
      .catch((err) => setMapError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        enrichingRef.current = false;
      });
  }, [itinerary, onItineraryChange, readOnly, mapReady, routePreference, connectDays]);

  useEffect(() => {
    if (!mapStatus || mapError || !/完成/.test(mapStatus)) return;
    const timer = window.setTimeout(() => setMapStatus(''), 2400);
    return () => window.clearTimeout(timer);
  }, [mapStatus, mapError]);

  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!mapReady || !AMap || !map) return;

    if (overlaysRef.current.length) {
      map.remove(overlaysRef.current);
      overlaysRef.current = [];
    }

    if (!itinerary) return;
    const drawResult = drawItinerary(AMap, map, itinerary, activeDay, onStopSelect, showMapLabels);
    const overlays = drawResult.overlays;
    overlaysRef.current = overlays;
    stopLookupRef.current = drawResult.stopLookup;
    if (overlays.length) map.setFitView(overlays, false, getMapFitPadding());
  }, [itinerary, activeDay, onStopSelect, mapReady, showMapLabels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !selectedStopId) return;
    const hit = stopLookupRef.current.get(selectedStopId);
    if (!hit) return;
    map.setZoomAndCenter(Math.max(map.getZoom?.() || 14, 15), hit.location);
    hit.infoWindow.setContent(createInfoWindowHtml(hit.stop));
    hit.infoWindow.open(map, hit.location);
  }, [selectedStopId, itinerary, activeDay, mapReady]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {!itinerary && (
        <div className="map-empty">
          <MapPinned size={32} />
          <h2>导入行程后生成路线地图</h2>
          <p>地点会按天分色，路线会按顺序连接，短距离自动使用步行。</p>
        </div>
      )}
      {(mapStatus || mapError) && (
        <div className={`map-toast ${mapError ? 'error' : ''}`}>
          {mapStatus && !mapError && <Loader2 className="spin" size={16} />}
          <span>{mapError || mapStatus}</span>
        </div>
      )}
      {itinerary && <div className="map-day-filter"><DaySelector itinerary={itinerary} activeDay={activeDay} onDayChange={onDayChange} /></div>}
    </div>
  );
}

function countExpectedRouteSegments(itinerary: Itinerary, connectDays: boolean): number {
  const inDaySegments = itinerary.days.reduce((total, day) => total + Math.max(day.stops.length - 1, 0), 0);
  if (!connectDays) return inDaySegments;
  const routeDays = itinerary.days.filter((day) => day.stops.length > 0);
  return inDaySegments + Math.max(routeDays.length - 1, 0);
}

function getMapFitPadding(): [number, number, number, number] {
  if (!window.matchMedia('(max-width: 760px)').matches) {
    return [90, 90, 120, 90];
  }

  const panelRect = document.querySelector('.side-panel')?.getBoundingClientRect();
  const filterRect = document.querySelector('.map-day-filter')?.getBoundingClientRect();
  const coveredTop = Math.min(
    panelRect?.top ?? Number.POSITIVE_INFINITY,
    filterRect?.top ?? Number.POSITIVE_INFINITY
  );
  const bottom = Number.isFinite(coveredTop)
    ? Math.max(220, Math.round(window.innerHeight - coveredTop + 28))
    : Math.round(Math.min(window.innerHeight * 0.64, 620) + 86);

  return [72, 34, bottom, 34];
}

function drawItinerary(
  AMap: AMapNamespace,
  map: any,
  itinerary: Itinerary,
  activeDay: ActiveDay,
  onStopSelect: (stopId: string) => void,
  showMapLabels: boolean
) {
  const overlays: any[] = [];
  const stopLookup = new Map<string, { marker: any; stop: Stop; location: [number, number]; infoWindow: any }>();
  const days = getVisibleDays(itinerary, activeDay);
  const dayIndexes = new Set(days.map((day) => day.dayIndex));

  for (const segment of itinerary.routeSegments) {
    if (segment.isInterDay) {
      if (activeDay !== 'all') continue;
    } else if (activeDay !== 'all' && segment.dayIndex !== activeDay) {
      continue;
    }
    if (segment.path.length < 2) continue;
    const color = colorForDay(segment.dayIndex);
    const line = new AMap.Polyline({
      path: segment.path,
      strokeColor: color,
      strokeWeight: segment.mode === 'walking' ? 5 : segment.mode === 'transit' ? 6 : 7,
      strokeOpacity: segment.status === 'fallback' || segment.isInterDay ? 0.68 : 0.88,
      strokeStyle: segment.status === 'fallback' || segment.mode === 'walking' || segment.isInterDay ? 'dashed' : 'solid',
      strokeDasharray: segment.isInterDay ? [14, 9] : [10, 7],
      lineJoin: 'round',
      lineCap: 'round',
      zIndex: segment.isInterDay ? 18 : 20
    });
    map.add(line);
    overlays.push(line);
  }

  const infoWindow = new AMap.InfoWindow({
    isCustom: true,
    autoMove: true,
    closeWhenClickMap: true,
    offset: new AMap.Pixel(0, -32)
  });

  const stops = [
    ...days.flatMap((day) => day.stops),
    ...days.flatMap((day) => day.alternatives),
    ...(activeDay === 'all' ? itinerary.alternatives : [])
  ];

  for (const stop of stops) {
    const location = stop.poiMatch?.location;
    if (!location) continue;
    const color = stop.isAlternative ? '#737688' : colorForDay(stop.dayIndex || [...dayIndexes][0] || 1);
    const marker = new AMap.Marker({
      position: location,
      content: createMarkerHtml(stop, color, Boolean(stop.isAlternative), showMapLabels),
      offset: new AMap.Pixel(-18, -44),
      zIndex: stop.isAlternative ? 80 : 100
    });
    marker.on('click', () => {
      onStopSelect(stop.id);
      infoWindow.setContent(createInfoWindowHtml(stop));
      infoWindow.open(map, location);
    });
    map.add(marker);
    overlays.push(marker);
    stopLookup.set(stop.id, { marker, stop, location, infoWindow });
  }

  return { overlays, stopLookup };
}

function createMarkerHtml(stop: Stop, color: string, muted: boolean, showName: boolean): string {
  return `<div class="route-marker-wrap ${muted ? 'muted' : ''}" style="--marker-color:${escapeHtml(color)}">
    <div class="route-marker"><span>${escapeHtml(stop.label)}</span></div>
    ${showName ? `<div class="route-marker-name">${escapeHtml(shortMarkerName(stop.name))}</div>` : ''}
  </div>`;
}

function shortMarkerName(name: string): string {
  const normalized = name.replace(/\s+/g, '').trim();
  return normalized.length > 12 ? `${normalized.slice(0, 11)}…` : normalized;
}

function createInfoWindowHtml(stop: Stop): string {
  const amapLink = stop.poiMatch?.amapUrl
    ? `<a href="${escapeHtml(stop.poiMatch.amapUrl)}" target="_blank" rel="noreferrer">在高德地图打开</a>`
    : '';
  return `<div class="poi-window">
    <strong>${escapeHtml(stop.label)} ${escapeHtml(stop.name)}</strong>
    ${stop.note ? `<p>${escapeHtml(stop.note)}</p>` : ''}
    ${stop.poiMatch?.address ? `<small>${escapeHtml(stop.poiMatch.address)}</small>` : ''}
    ${amapLink}
  </div>`;
}

function StatusBlock({ message, error }: { message: string; error: string }) {
  if (!message && !error) return null;
  return <div className={`status-block ${error ? 'error' : ''}`}>{error || message}</div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-panel">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
