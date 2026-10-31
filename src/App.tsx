import { StopLocationEditor } from './StopLocationEditor';
import { updateStopLocation } from './shared/stopLocations';
import {
  AuthProvider,
  AuthPage,
  AccountPage,
  AuthControls,
  RequireAuth,
  useAuth
} from './Auth';
import { AdminPage } from './AdminPage';
import { canCreateItinerary } from './shared/auth';
import { ActivityReviewBar } from './ActivityReviewBar';
import {
  applyActivityEdits,
  stageActivityEdit,
  type ActivityEdits
} from './shared/activityEdits';
import { getMapOnlyActivities } from './shared/optionalPlaces';
import { placeRegionLabel } from './shared/placeContext';
import { journeySignature } from './shared/journeySignature';
import { ActivityOptions } from './ActivityOptions';
import { transportNames } from './shared/transport';
import { activityDescription, activitySymbol } from './shared/activities';
import {
  ArrowLeft,
  BusFront,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Compass,
  ExternalLink,
  Film,
  Footprints,
  History as HistoryIcon,
  Loader2,
  MapPinned,
  LocateFixed,
  Minus,
  Mountain,
  Plus,
  Satellite,
  Route as RouteIcon,
  Share2,
  SlidersHorizontal,
  Settings2,
  Pencil,
  RotateCcw,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createJourneyMap,
  drawJourneyMap,
  enrichItineraryWithAmap,
  loadAMap,
  openJourneyStop,
  type JourneyMapAppearance,
  type JourneyMapDrawing
} from './amap';
import { atlasDayColor } from './shared/mapPresentation';
import { VideoExport } from './VideoExport';
import { HomePage } from './HomePage';
import { ImportPanel, type ImportExample } from './ImportPanel';
import { AppDialog } from './AppDialog';
import { SettingsPanel, SettingsPage } from './SettingsPanel';
import {
  getConfig,
  deleteItinerary,
  restoreItinerary,
  inferTransport,
  listItineraries,
  loadItinerary,
  parseItineraryStream,
  saveItinerary,
  type RuntimeConfig
} from './api';
import {
  colorForDay,
  getVisibleDays,
  getAllStops,
  hasPendingPoiMatches,
  removeStopFromItinerary,
  type Itinerary,
  type ItineraryDay,
  type ItinerarySummary,
  type RoutePreference,
  type ShareStatus,
  type Stop,
  type PoiCandidate,
  type TripScope
} from './shared/itinerary';

type ActiveDay = number | 'all';
type AMapNamespace = any;
type CopyStatus = 'idle' | 'copied' | 'failed';
type MobileSheetMode = 'collapsed' | 'expanded';

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
function AppRoutes() {
  const pathname = useMemo(() => window.location.pathname, []);
  if (pathname === '/login') return <AuthPage />;
  if (pathname === '/admin/setup') return <AuthPage setup />;
  if (pathname === '/account')
    return (
      <RequireAuth>
        <AccountPage />
      </RequireAuth>
    );
  if (pathname === '/admin')
    return (
      <RequireAuth admin>
        <AdminPage />
      </RequireAuth>
    );
  if (pathname === '/history')
    return (
      <RequireAuth>
        <HistoryPage />
      </RequireAuth>
    );
  if (pathname === '/settings') return <SettingsPage />;
  return <MainApp pathname={pathname} />;
}

function MainApp({ pathname }: { pathname: string }) {
  const { session, openAuth, refresh: refreshAccount } = useAuth();
  const user = session.user;
  const canManageSettings = user?.role === 'admin';
  const shareId = useMemo(
    () => pathname.match(/^\/s\/([^/]+)/)?.[1],
    [pathname]
  );
  const [readOnly, setReadOnly] = useState(Boolean(shareId));
  const [newTripOpen, setNewTripOpen] = useState(false);
  const [homeExample, setHomeExample] = useState<ImportExample>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const editingStop =
    itinerary && editingStopId
      ? [
          ...itinerary.days.flatMap((day) => [
            ...day.stops,
            ...day.alternatives,
            ...(day.activityOptions || [])
          ]),
          ...itinerary.alternatives
        ].find((stop) => stop.id === editingStopId)
      : undefined;
  const [activeDay, setActiveDay] = useState<ActiveDay>('all');
  const [routePreference, setRoutePreference] =
    useState<RoutePreference>('auto');
  const [connectDays, setConnectDays] = useState(true);
  const [mobileSheetMode, setMobileSheetMode] =
    useState<MobileSheetMode>('collapsed');
  const [showRoutes, setShowRoutes] = useState(true);
  const [showMapLabels, setShowMapLabels] = useState(true);
  const [parseStatus, setParseStatus] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const [isSharing, setIsSharing] = useState(false);
  const [isPlanningRoute, setIsPlanningRoute] = useState(false);
  const [error, setError] = useState('');
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [studioView, setStudioView] = useState<'film' | 'map'>('film');
  const [exportRequest, setExportRequest] = useState(0);
  const [encodingVideo, setEncodingVideo] = useState(false);
  const [activityEdits, setActivityEdits] = useState<ActivityEdits>({});
  const [applyingActivities, setApplyingActivities] = useState(false);
  const activityChangeCount = Object.keys(activityEdits).length;
  const activityDraft = useMemo(
    () => (itinerary ? applyActivityEdits(itinerary, activityEdits) : null),
    [itinerary, activityEdits]
  );
  const mapDraft = useMemo(
    () =>
      activityDraft && itinerary
        ? { ...activityDraft, routeSegments: itinerary.routeSegments }
        : null,
    [activityDraft, itinerary]
  );
  useEffect(() => {
    if (!canManageSettings) setSettingsOpen(false);
  }, [canManageSettings]);

  useEffect(() => {
    setActivityEdits({});
  }, [itinerary?.id]);

  useEffect(() => {
    if (!shareId) return;
    setParseStatus('正在读取分享行程...');
    loadItinerary(shareId)
      .then(({ itinerary: loaded, editable }) => {
        setItinerary(loaded);
        setReadOnly(!editable);
        setParseStatus('');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setParseStatus('');
      });
  }, [shareId, user?.id]);

  async function handleParse(text: string, image?: File | null) {
    if (!user) {
      openAuth();
      return;
    }
    if (!canCreateItinerary(user)) {
      setError('行程额度已用完，可以继续编辑和导出已有行程。');
      return;
    }
    const hasImage = Boolean(image);
    setError('');
    setShareUrl('');
    setShareDialogOpen(false);
    setCopyStatus('idle');
    setIsParsing(true);
    setParseStatus(hasImage ? '正在读取行程截图' : '正在读取行程文字');
    try {
      const result = await parseItineraryStream(text, image, (event) => {
        if (event.type === 'status' || event.type === 'progress')
          setParseStatus(event.message);
      });
      let nextItinerary: Itinerary = {
        ...result.itinerary,
        shareStatus: 'draft'
      };
      try {
        const saved = await saveItinerary(nextItinerary);
        nextItinerary = saved.itinerary;
      } catch (saveError) {
        setError(
          `草稿保存失败：${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
      }
      setItinerary(nextItinerary);
      setReadOnly(false);
      void refreshAccount();
      setNewTripOpen(false);
      if (nextItinerary.id && nextItinerary.id !== 'draft') {
        window.history.replaceState(
          null,
          '',
          '/s/' + encodeURIComponent(nextItinerary.id)
        );
      }
      setActiveDay('all');
      setRoutePreference('auto');
      setConnectDays(true);
      setMobileSheetMode('collapsed');
      setSelectedStopId(null);
      setParseStatus(result.warning || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setParseStatus('');
    } finally {
      setIsParsing(false);
    }
  }

  async function handleShare() {
    if (!user) {
      openAuth();
      return;
    }
    if (!itinerary) return;
    setError('');
    setCopyStatus('idle');
    setIsSharing(true);
    try {
      const result = await saveItinerary({
        ...itinerary,
        shareStatus: 'shared'
      });
      const absoluteUrl = new URL(
        result.shareUrl,
        window.location.origin
      ).toString();
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
    setItinerary((current) =>
      current
        ? {
            ...current,
            routeSegments: [],
            updatedAt: new Date().toISOString()
          }
        : current
    );
  }

  function handleConnectDaysChange(nextConnectDays: boolean) {
    setConnectDays(nextConnectDays);
    setSelectedStopId(null);
    setActiveDay('all');
    setItinerary((current) =>
      current
        ? {
            ...current,
            routeSegments: [],
            updatedAt: new Date().toISOString()
          }
        : current
    );
  }

  const saveHistoryRecord = useCallback(
    (next: Itinerary, shareStatus: ShareStatus) => {
      if (readOnly || next.id === 'draft') return;
      saveItinerary({
        ...next,
        shareStatus
      }).catch((saveError) => {
        setError(
          `历史保存失败：${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
      });
    },
    [readOnly]
  );

  const handleItineraryChange = useCallback(
    (next: Itinerary) => {
      setItinerary(next);
      saveHistoryRecord(next, next.shareStatus || 'draft');
    },
    [saveHistoryRecord]
  );

  function handleEditStop(stopId: string) {
    if (encodingVideo || isPlanningRoute || applyingActivities) return;
    if (!user) {
      openAuth();
      return;
    }
    setError('');
    setEditingStopId(stopId);
  }

  async function handleSaveStopLocation(candidate: PoiCandidate) {
    if (!itinerary || !editingStopId || !user)
      throw new Error('请先登录并选择需要修改的地点。');
    if (readOnly && !canCreateItinerary(user))
      throw new Error('新建额度已用完，无法另存分享行程。');
    let next = updateStopLocation(itinerary, editingStopId, candidate);
    if (readOnly) next = { ...next, id: 'draft', shareStatus: 'draft' };
    const saved = await saveItinerary(next);
    setItinerary(saved.itinerary);
    setReadOnly(false);
    setSelectedStopId(editingStopId);
    setEditingStopId(null);
    if (readOnly) {
      window.history.replaceState(
        null,
        '',
        '/s/' + encodeURIComponent(saved.itinerary.id)
      );
      void refreshAccount();
    }
  }

  function handleStopDelete(stopId: string) {
    setSelectedStopId(null);
    if (!itinerary) return;
    const next = removeStopFromItinerary(itinerary, stopId);
    next.routeSegments = [];
    next.transportNeedsReview = true;
    setItinerary(next);
    saveHistoryRecord(next, next.shareStatus || 'draft');
  }

  const handleActivityToggle = useCallback(
    (dayIndex: number, option: Stop, include: boolean) => {
      if (!itinerary || isPlanningRoute || encodingVideo || applyingActivities)
        return;
      setActivityEdits((edits) =>
        stageActivityEdit(itinerary, edits, { dayIndex, option, include })
      );
      setSelectedStopId(null);
    },
    [itinerary, isPlanningRoute, encodingVideo, applyingActivities]
  );

  async function handleApplyActivityChanges() {
    if (!user) {
      openAuth();
      return;
    }
    if (readOnly && !canCreateItinerary(user)) {
      setError('行程额度已用完，不能另存新行程；仍可编辑自己的已有行程。');
      return;
    }
    if (
      !activityDraft ||
      !activityChangeCount ||
      isPlanningRoute ||
      applyingActivities ||
      encodingVideo
    )
      return;
    setApplyingActivities(true);
    setError('');
    setSelectedStopId(null);
    setConnectDays(true);
    try {
      if (readOnly) {
        const saved = await saveItinerary({
          ...activityDraft,
          id: 'draft',
          shareStatus: 'draft'
        });
        setReadOnly(false);
        void refreshAccount();
        setItinerary(saved.itinerary);
        window.history.replaceState(
          null,
          '',
          '/s/' + encodeURIComponent(saved.itinerary.id)
        );
      } else handleItineraryChange(activityDraft);
      setActivityEdits({});
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setApplyingActivities(false);
    }
  }
  function cancelActivityChanges() {
    setActivityEdits({});
    setSelectedStopId(null);
  }
  const activityReview = {
    count: activityChangeCount,
    busy: applyingActivities,
    onApply: handleApplyActivityChanges,
    onCancel: cancelActivityChanges
  };
  const visibleDays = activityDraft
    ? getVisibleDays(activityDraft, activeDay)
    : [];
  const handleDayChange = useCallback((day: ActiveDay) => {
    setSelectedStopId(null);
    setActiveDay(day);
  }, []);
  const hasItinerary = Boolean(itinerary);
  const effectiveMobileSheetMode: MobileSheetMode = hasItinerary
    ? mobileSheetMode
    : 'expanded';

  if (!hasItinerary && !shareId) {
    return (
      <>
        <HomePage
          busy={isParsing}
          canManageSettings={canManageSettings}
          onSettings={() => setSettingsOpen(true)}
          onExample={(text) =>
            setHomeExample((previous) => ({
              text,
              revision: (previous?.revision || 0) + 1
            }))
          }
        >
          <ImportPanel
            variant="home"
            example={homeExample}
            onParse={handleParse}
            busy={isParsing}
            progressMessage={isParsing ? parseStatus : ''}
          />
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </HomePage>
        {settingsOpen && canManageSettings && (
          <AppDialog
            title="服务设置"
            wide
            onClose={() => setSettingsOpen(false)}
          >
            <SettingsPanel />
          </AppDialog>
        )}
      </>
    );
  }

  return (
    <div
      className={`app-shell cinema-shell studio-mode-${studioView} ${readOnly ? 'read-only' : ''} ${hasItinerary ? 'has-itinerary' : 'no-itinerary'} mobile-sheet-${effectiveMobileSheetMode}`}
    >
      <header className="studio-header">
        <a className="studio-brand" href="/" aria-label="Map Tour 首页">
          <Mountain size={24} />
          <span>MAP TOUR</span>
        </a>
        <div className="studio-project">
          <strong>{itinerary?.title || '把行程，变成一部旅行电影'}</strong>
          <span>
            {itinerary
              ? `${itinerary.days.length} 天 · ${itinerary.days.reduce((n, day) => n + day.stops.length, 0)} 个地点`
              : '从一个旅行计划开始'}
          </span>
        </div>
        <div className="studio-header-actions">
          <button
            className="studio-header-link studio-new-trip"
            disabled={encodingVideo || isParsing}
            onClick={() => {
              setError('');
              setNewTripOpen(true);
            }}
          >
            <Plus size={15} />
            <span>新建行程</span>
          </button>
          <AuthControls />
          {canManageSettings && (
            <button
              className="studio-header-link"
              aria-label="服务设置"
              title="服务设置"
              disabled={encodingVideo}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={15} />
              <span>设置</span>
            </button>
          )}
          <a
            href="/history"
            className="studio-header-link"
            aria-label="历史行程"
          >
            <HistoryIcon size={16} />
            <span>历史</span>
          </a>
          {itinerary && (
            <>
              <button
                className="studio-header-link"
                onClick={() => {
                  if (readOnly) {
                    setShareUrl(location.href);
                    setShareDialogOpen(true);
                  } else void handleShare();
                }}
                disabled={isSharing}
              >
                <Share2 size={15} />
                <span>分享</span>
              </button>
              <button
                className="studio-export-button"
                disabled={
                  encodingVideo ||
                  isPlanningRoute ||
                  applyingActivities ||
                  activityChangeCount > 0
                }
                onClick={() => {
                  setStudioView('film');
                  setExportRequest((n) => n + 1);
                }}
              >
                <Film size={15} />
                {encodingVideo ? '导出中' : '导出视频'}
              </button>
            </>
          )}
        </div>
      </header>
      {itinerary && (
        <nav className="studio-view-tabs" aria-label="工作区">
          <button
            className={studioView === 'film' ? 'active' : ''}
            aria-pressed={studioView === 'film'}
            disabled={encodingVideo}
            onClick={() => setStudioView('film')}
          >
            <Film size={14} />
            旅程电影
          </button>
          <button
            className={studioView === 'map' ? 'active' : ''}
            aria-pressed={studioView === 'map'}
            disabled={encodingVideo}
            onClick={() => setStudioView('map')}
          >
            <MapPinned size={14} />
            行程地图
          </button>
          <span>每一天，都是一个章节</span>
        </nav>
      )}
      <aside
        className={`side-panel ${hasItinerary ? 'has-itinerary' : 'no-itinerary'} ${effectiveMobileSheetMode}`}
        aria-label="行程"
      >
        {hasItinerary && (
          <button
            className="mobile-sheet-toggle"
            type="button"
            aria-label={
              mobileSheetMode === 'expanded' ? '进入地图模式' : '展开行程详情'
            }
            onClick={() =>
              setMobileSheetMode((mode) =>
                mode === 'expanded' ? 'collapsed' : 'expanded'
              )
            }
          >
            {mobileSheetMode === 'expanded' ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronUp size={16} />
            )}
            {mobileSheetMode === 'expanded' ? '进入地图模式' : '展开行程详情'}
          </button>
        )}
        <PanelHeader readOnly={readOnly} hasItinerary={hasItinerary} />
        {!readOnly &&
          (hasItinerary ? (
            <details className="import-another">
              <summary>
                <PlusIcon /> 导入另一段旅程
              </summary>
              <ImportPanel
                onParse={handleParse}
                busy={isParsing}
                progressMessage={isParsing ? parseStatus : ''}
              />
            </details>
          ) : (
            <ImportPanel
              onParse={handleParse}
              busy={isParsing}
              progressMessage={isParsing ? parseStatus : ''}
            />
          ))}
        {itinerary && (
          <ItineraryPanel
            itinerary={activityDraft || itinerary}
            activityReview={activityReview}
            visibleDays={visibleDays}
            onActivityLocate={(stopId) => {
              setStudioView('map');
              setSelectedStopId(stopId);
              setMobileSheetMode('collapsed');
            }}
            onActivityToggle={handleActivityToggle}
            activityBusy={
              isPlanningRoute || encodingVideo || applyingActivities
            }
            activeDay={activeDay}
            onDayChange={handleDayChange}
            routePreference={routePreference}
            onRoutePreferenceChange={handleRoutePreferenceChange}
            connectDays={connectDays}
            onConnectDaysChange={handleConnectDaysChange}
            showRoutes={showRoutes}
            onShowRoutesChange={setShowRoutes}
            showMapLabels={showMapLabels}
            onShowMapLabelsChange={setShowMapLabels}
            onShare={handleShare}
            isSharing={isSharing}
            selectedStopId={selectedStopId}
            onStopSelect={setSelectedStopId}
            onStopDelete={handleStopDelete}
            onStopEdit={handleEditStop}
            stopEditingBusy={
              isPlanningRoute || encodingVideo || applyingActivities
            }
            readOnly={readOnly}
          />
        )}
        {!itinerary && readOnly && (
          <EmptyState
            title="没有找到行程"
            body="这个分享链接可能已失效，或本地存储文件中没有对应数据。"
          />
        )}
        <StatusBlock message={isParsing ? '' : parseStatus} error={error} />
      </aside>

      <main className="studio-main">
        <ActivityReviewBar {...activityReview} onMap />
        {itinerary && (
          <div
            className="studio-video-view"
            style={{ display: studioView === 'film' ? 'block' : 'none' }}
          >
            <VideoExport
              key={
                (user?.id || 'guest') +
                itinerary.id +
                journeySignature(itinerary)
              }
              itinerary={itinerary}
              planningRoute={isPlanningRoute || applyingActivities}
              pendingRouteEdits={activityChangeCount > 0}
              embedded
              visible={
                studioView === 'film' &&
                !newTripOpen &&
                !settingsOpen &&
                !editingStop
              }
              chapterDay={activeDay}
              focusStopId={selectedStopId}
              exportRequest={exportRequest}
              onEncodingChange={setEncodingVideo}
              onEditStop={handleEditStop}
            />
          </div>
        )}
        <div
          className={`map-stage studio-map-view ${!itinerary ? 'is-empty' : ''}`}
        >
          <MapView
            itinerary={itinerary}
            displayItinerary={mapDraft}
            activeDay={activeDay}
            onDayChange={handleDayChange}
            onItineraryChange={handleItineraryChange}
            onPlanningChange={setIsPlanningRoute}
            routePreference={routePreference}
            connectDays={connectDays}
            showRoutes={showRoutes}
            showMapLabels={showMapLabels}
            selectedStopId={selectedStopId}
            onStopSelect={setSelectedStopId}
            readOnly={readOnly}
            onActivityToggle={handleActivityToggle}
            activityBusy={
              isPlanningRoute || encodingVideo || applyingActivities
            }
            pendingActivityChanges={activityChangeCount > 0}
            visible={!itinerary || studioView === 'map'}
          />
        </div>
      </main>
      {itinerary && (
        <div className="studio-chapters" aria-label="旅程章节">
          <button
            className={`studio-chapter-all ${activeDay === 'all' ? 'active' : ''}`}
            aria-pressed={activeDay === 'all'}
            disabled={encodingVideo}
            onClick={() => handleDayChange('all')}
          >
            <Film size={18} />
            <span>
              全程
              <br />
              <small>{itinerary.days.length} 个章节</small>
            </span>
          </button>
          {itinerary.days.map((day) => (
            <button
              key={day.dayIndex}
              className={`studio-chapter ${activeDay === day.dayIndex ? 'active' : ''}`}
              aria-pressed={activeDay === day.dayIndex}
              disabled={encodingVideo}
              onClick={() => handleDayChange(day.dayIndex)}
              style={
                {
                  '--chapter-color': colorForDay(day.dayIndex)
                } as React.CSSProperties
              }
            >
              <ChapterCover day={day} />
              <span>
                <small>CHAPTER {String(day.dayIndex).padStart(2, '0')}</small>
                <strong>{day.stops[0]?.name || day.title}</strong>
                <em>{day.stops.length} 个地点</em>
              </span>
            </button>
          ))}
        </div>
      )}

      {editingStop && (
        <StopLocationEditor
          key={editingStop.id}
          stop={editingStop}
          scope={itinerary?.tripScope}
          fork={readOnly}
          onClose={() => setEditingStopId(null)}
          onSave={handleSaveStopLocation}
        />
      )}
      {newTripOpen && (
        <AppDialog
          title="新建行程"
          busy={isParsing}
          onClose={() => {
            setNewTripOpen(false);
            setError('');
          }}
        >
          <div className="new-trip-body">
            <p>
              粘贴每日路线，或上传一张行程截图。生成后进入新的行程，当前行程会保留在历史中。
            </p>
            <ImportPanel
              onParse={handleParse}
              busy={isParsing}
              progressMessage={isParsing ? parseStatus : ''}
            />
            {error && (
              <p className="settings-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </AppDialog>
      )}
      {settingsOpen && canManageSettings && (
        <AppDialog title="服务设置" wide onClose={() => setSettingsOpen(false)}>
          <SettingsPanel />
        </AppDialog>
      )}
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

function ChapterCover({ day }: { day: ItineraryDay }) {
  const points = day.stops.flatMap((stop) =>
    stop.poiMatch?.location ? [stop.poiMatch.location] : []
  );
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const minX = Math.min(...xs),
    minY = Math.min(...ys);
  const dx = Math.max(0.001, Math.max(...xs) - minX),
    dy = Math.max(0.001, Math.max(...ys) - minY);
  const path = points
    .map(
      (p) =>
        `${12 + ((p[0] - minX) / dx) * 76},${55 - ((p[1] - minY) / dy) * 40}`
    )
    .join(' ');
  return (
    <span className="chapter-cover" aria-hidden="true">
      <svg viewBox="0 0 100 70">
        <path
          className="chapter-contour"
          d="M-10 55Q5-10 40 14T110 4M-10 68Q5 3 40 27T110 17M-10 81Q5 16 40 40T110 30"
        />
        {points.length > 1 && <polyline points={path} />}
        <circle cx="12" cy="55" r="3" />
      </svg>
      <b>{String(day.dayIndex).padStart(2, '0')}</b>
    </span>
  );
}

function HistoryPage() {
  const [items, setItems] = useState<ItinerarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [trashed, setTrashed] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ItinerarySummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    setActionError('');
    setNotice('');
    listItineraries(200, trashed)
      .then((result) => {
        if (!disposed) setItems(result.items);
      })
      .catch((err) => {
        if (!disposed)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [trashed]);

  async function changeRecord(item: ItinerarySummary, restore: boolean) {
    if (busyId) return;
    setBusyId(item.id);
    setActionError('');
    setNotice('');
    try {
      await (restore ? restoreItinerary(item.id) : deleteItinerary(item.id));
      setItems((rows) => rows.filter((row) => row.id !== item.id));
      setPendingDelete(null);
      setNotice(restore ? `已恢复「${item.title}」，可在历史行程中打开。` : `「${item.title}」已移入回收站，可随时恢复。`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败，请稍后重试。');
    } finally { setBusyId(null); }
  }

  return (
    <div className="history-page">
      <header className="history-header">
        <AuthControls />
        <div className="brand-row">
          <div className="brand-mark">
            <MapPinned size={18} />
          </div>
          <span>MAP TOUR</span>
        </div>
        <a className="header-link" href="/">
          <ArrowLeft size={15} />
          返回工具
        </a>
      </header>
      <main className="history-main">
        <section className="history-title">
          <div className="history-title-icon">
            <HistoryIcon size={22} />
          </div>
          <div>
            <h1>{trashed ? '回收站' : '历史行程'}</h1>
            <p>{trashed ? '删除的行程保留在这里。恢复后，原有路线和分享状态一并恢复。' : '自动保存的草稿和已分享的旅程，都在这里。可以删除不需要的记录。'}</p>
          </div>
        </section>
        <div className="history-toolbar" aria-label="历史记录范围">
          <button type="button" className="history-scope" aria-pressed={!trashed} disabled={Boolean(busyId)} onClick={() => setTrashed(false)}>
            <HistoryIcon size={16} />历史行程
          </button>
          <button type="button" className="history-scope" aria-pressed={trashed} disabled={Boolean(busyId)} onClick={() => setTrashed(true)}>
            <Trash2 size={16} />回收站
          </button>
          {!loading && !error && <span>{items.length} 条记录</span>}
        </div>
        {notice && <p className="history-notice" role="status">{notice}</p>}
        {actionError && !pendingDelete && <p className="history-action-error" role="alert">{actionError}</p>}

        {loading && (
          <div className="history-state">
            <Loader2 className="spin" size={18} />
            正在读取历史数据...
          </div>
        )}
        {!loading && error && (
          <div className="history-state error">{error}</div>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="history-state">
            {trashed ? '回收站是空的。' : '还没有历史行程，导入行程后会自动保存在这里。'}
          </div>
        )}
        {!loading && !error && items.length > 0 && (
          <div className="history-grid">
            {items.map((item) => (
              <article
                className="history-card"
                key={item.id}
              >
                {trashed ? <div className="history-card-link"><HistoryRecord item={item} /></div> : <a className="history-card-link" href={`/s/${encodeURIComponent(item.id)}`}>
                  <HistoryRecord item={item} />
                  <span className="history-open-icon" aria-hidden="true"><ExternalLink size={17} /></span>
                </a>}
                <div className="history-card-actions">
                  <span>{trashed ? '恢复后可继续编辑' : '自动保存到账号'}</span>
                  <button type="button" className={`history-record-action ${trashed ? '' : 'danger'}`} disabled={Boolean(busyId)}
                    aria-label={`${trashed ? '恢复' : '删除'}行程 ${item.title}`}
                    onClick={() => {
                      setActionError('');
                      if (trashed) void changeRecord(item, true);
                      else setPendingDelete(item);
                    }}>
                    {busyId === item.id ? <Loader2 size={16} className="spin" /> : trashed ? <RotateCcw size={16} /> : <Trash2 size={16} />}
                    {busyId === item.id ? '处理中…' : trashed ? '恢复行程' : '删除'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {pendingDelete && <AppDialog title="删除这个行程？" busy={Boolean(busyId)} onClose={() => { setPendingDelete(null); setActionError(''); }}>
          <div className="history-delete-dialog">
            <p>「{pendingDelete.title}」将移入回收站，可以随时恢复。</p>
            <p>{pendingDelete.shareStatus === 'shared' ? '分享链接会暂时失效，恢复后可继续访问。' : '草稿会从历史列表中移除。'} 已消耗的生成额度不会返还。</p>
            {actionError && <p className="history-action-error" role="alert">{actionError}</p>}
            <div className="history-dialog-actions">
              <button type="button" className="history-record-action" disabled={Boolean(busyId)} onClick={() => { setPendingDelete(null); setActionError(''); }}>取消</button>
              <button type="button" className="history-record-action danger" disabled={Boolean(busyId)} onClick={() => void changeRecord(pendingDelete, false)}>
                {busyId ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}{busyId ? '正在删除…' : '移入回收站'}
              </button>
            </div>
          </div>
        </AppDialog>}
      </main>
    </div>
  );
}

function HistoryRecord({ item }: { item: ItinerarySummary }) {
  return (
    <div className="history-card-main">
      <span className={`history-status-badge ${item.shareStatus}`}>
        {item.shareStatus === 'shared' ? '已分享' : '草稿'}
      </span>
      <h2>{item.title}</h2>
      <div className="date-line">
        <CalendarDays size={15} />
        <span>{formatHistoryDateRange(item)}</span>
      </div>
      <TripScopeLine scope={item.tripScope} />
      <div className="history-card-meta">
        <span>{item.daysCount} 天</span>
        <span>{item.stopCount} 个地点</span>
        <span>更新于 {formatHistoryTime(item.updatedAt)}</span>
      </div>
    </div>
  );
}

function PlusIcon() {
  return <span aria-hidden="true">＋</span>;
}
function PanelHeader({
  readOnly,
  hasItinerary
}: {
  readOnly: boolean;
  hasItinerary: boolean;
}) {
  return (
    <div className="panel-header">
      <div className="brand-row">
        <div className="brand-mark">
          <MapPinned size={18} />
        </div>
        <span>MAP TOUR</span>
        <a className="header-link" href={readOnly ? '/' : '/history'}>
          {readOnly ? '新建' : '历史'}
        </a>
      </div>
      {!hasItinerary && (
        <>
          <h1>下一站，去哪里？</h1>
          <p>把旅行计划放进来，让每一站在地图上相遇。</p>
        </>
      )}
    </div>
  );
}

function ItineraryPanel({
  itinerary,
  activityReview,
  visibleDays,
  activeDay,
  onDayChange,
  routePreference,
  onRoutePreferenceChange,
  connectDays,
  onConnectDaysChange,
  showRoutes,
  onShowRoutesChange,
  showMapLabels,
  onShowMapLabelsChange,
  onShare,
  isSharing,
  selectedStopId,
  onStopSelect,
  onStopDelete,
  onStopEdit,
  stopEditingBusy,
  readOnly,
  onActivityToggle,
  onActivityLocate,
  activityBusy
}: {
  itinerary: Itinerary;
  activityReview: React.ComponentProps<typeof ActivityReviewBar>;
  onActivityLocate: (stopId: string) => void;
  onActivityToggle: (dayIndex: number, option: Stop, include: boolean) => void;
  activityBusy: boolean;
  visibleDays: ItineraryDay[];
  activeDay: ActiveDay;
  onDayChange: (day: ActiveDay) => void;
  routePreference: RoutePreference;
  onRoutePreferenceChange: (preference: RoutePreference) => void;
  connectDays: boolean;
  onConnectDaysChange: (connectDays: boolean) => void;
  showRoutes: boolean;
  onShowRoutesChange: (show: boolean) => void;
  showMapLabels: boolean;
  onShowMapLabelsChange: (show: boolean) => void;
  onShare: () => void;
  isSharing: boolean;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete: (stopId: string) => void;
  onStopEdit: (stopId: string) => void;
  stopEditingBusy: boolean;
  readOnly: boolean;
}) {
  const pendingPoi = hasPendingPoiMatches(itinerary);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const dayRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const visibleDayKey = visibleDays.map((day) => day.dayIndex).join(',');

  useEffect(() => {
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    const target =
      activeDay === 'all' ? summaryRef.current : dayRefs.current.get(activeDay);
    if (!target) return;

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [activeDay, visibleDayKey]);

  return (
    <section className="itinerary-content">
      <div className="trip-summary" ref={summaryRef}>
        <span className="trip-eyebrow">TRAVEL JOURNAL · 行程手记</span>
        <h2>{itinerary.title}</h2>
        <div className="trip-facts">
          <span>
            <CalendarDays size={14} />
            <b>{itinerary.days.length}</b> 天旅程
          </span>
          <span>
            <MapPinned size={14} />
            <b>
              {itinerary.days.reduce((n, day) => n + day.stops.length, 0)}
            </b>{' '}
            个地点
          </span>
        </div>
        <div className="date-line">
          <CalendarDays size={16} />
          <span>
            {itinerary.dateRange.label ||
              [itinerary.dateRange.start, itinerary.dateRange.end]
                .filter(Boolean)
                .join(' - ') ||
              '日期未识别'}
          </span>
        </div>
        <TripScopeLine scope={itinerary.tripScope} />
      </div>

      <DaySelector
        itinerary={itinerary}
        activeDay={activeDay}
        onDayChange={onDayChange}
      />
      <details className="map-settings-disclosure">
        <summary>
          <SlidersHorizontal size={14} />
          地图与路线设置
          <ChevronDown size={14} />
        </summary>
        <MapDisplayControls
          routePreference={routePreference}
          onRoutePreferenceChange={onRoutePreferenceChange}
          connectDays={connectDays}
          onConnectDaysChange={onConnectDaysChange}
          showRoutes={showRoutes}
          onShowRoutesChange={onShowRoutesChange}
          showMapLabels={showMapLabels}
          onShowMapLabelsChange={onShowMapLabelsChange}
          allowRouteChange={!readOnly}
        />
      </details>

      <ActivityReviewBar {...activityReview} />
      <div className="day-list">
        {visibleDays.map((day) => (
          <div key={day.dayIndex}>
            <DaySection
              key={day.dayIndex}
              sectionRef={(node) => {
                if (node) dayRefs.current.set(day.dayIndex, node);
                else dayRefs.current.delete(day.dayIndex);
              }}
              day={day}
              selectedStopId={selectedStopId}
              onStopSelect={onStopSelect}
              onStopDelete={!readOnly ? onStopDelete : undefined}
              onStopEdit={onStopEdit}
              stopEditingBusy={stopEditingBusy}
            />
            <ActivityOptions
              day={day}
              dining={itinerary.recommendations?.dining || []}
              lodging={itinerary.recommendations?.lodging || []}
              busy={activityBusy}
              onLocate={onActivityLocate}
              onToggle={onActivityToggle}
            />
          </div>
        ))}
        {activeDay === 'all' && itinerary.alternatives.length > 0 && (
          <AlternativeSection
            stops={itinerary.alternatives}
            title="推荐/备选地点"
            selectedStopId={selectedStopId}
            onStopSelect={onStopSelect}
            onStopDelete={!readOnly ? onStopDelete : undefined}
            onStopEdit={onStopEdit}
            stopEditingBusy={stopEditingBusy}
          />
        )}
      </div>

      {!readOnly && (
        <div className="share-area">
          <button
            className="share-button"
            type="button"
            onClick={onShare}
            disabled={pendingPoi || isSharing}
          >
            {isSharing ? (
              <Loader2 className="spin" size={17} />
            ) : (
              <Share2 size={17} />
            )}
            {isSharing
              ? '正在生成链接'
              : pendingPoi
                ? '等待地点匹配'
                : '分享行程'}
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
    ? cities.slice(0, 4).join(' / ') +
      (cities.length > 4 ? ` 等 ${cities.length} 地` : '')
    : scope.primaryCity || '';
  if (scope.mode === 'single_city')
    return cityText ? `单城市 · ${cityText}` : '单城市';
  return cityText ? `多城市 · ${cityText}` : '多城市路线';
}

function formatHistoryDateRange(item: ItinerarySummary): string {
  return (
    item.dateRange.label ||
    [item.dateRange.start, item.dateRange.end].filter(Boolean).join(' - ') ||
    '日期未识别'
  );
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
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
    <div
      className="share-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="icon-button share-dialog-close"
          type="button"
          aria-label="关闭分享弹窗"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="share-dialog-icon">
          <Share2 size={22} />
        </div>
        <h2 id="share-dialog-title">分享行程</h2>
        <p>朋友打开这个链接即可查看路线、地点和备注。</p>
        <div className="share-link-box">
          <input
            value={shareUrl}
            readOnly
            aria-label="分享链接"
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="copy-button" type="button" onClick={onCopy}>
            {copyStatus === 'copied' ? <Check size={16} /> : <Copy size={16} />}
            {copyStatus === 'copied' ? '已复制' : '复制链接'}
          </button>
        </div>
        {copyStatus === 'failed' && (
          <small className="copy-hint">
            浏览器未允许自动复制，可以选中链接后手动复制。
          </small>
        )}
        <div className="share-dialog-actions">
          <a href={shareUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            打开分享页
          </a>
          <button type="button" onClick={onClose}>
            关闭
          </button>
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
  showRoutes,
  onShowRoutesChange,
  showMapLabels,
  onShowMapLabelsChange,
  allowRouteChange
}: {
  routePreference: RoutePreference;
  onRoutePreferenceChange: (preference: RoutePreference) => void;
  connectDays: boolean;
  onConnectDaysChange: (connectDays: boolean) => void;
  showRoutes: boolean;
  onShowRoutesChange: (show: boolean) => void;
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
        <span>显示路线</span>
        <input
          type="checkbox"
          checked={showRoutes}
          onChange={(event) => onShowRoutesChange(event.target.checked)}
        />
      </label>
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
  sectionRef,
  selectedStopId,
  onStopSelect,
  onStopDelete,
  onStopEdit,
  stopEditingBusy
}: {
  day: ItineraryDay;
  sectionRef?: (node: HTMLDivElement | null) => void;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete?: (stopId: string) => void;
  onStopEdit: (stopId: string) => void;
  stopEditingBusy: boolean;
}) {
  const color = colorForDay(day.dayIndex);
  return (
    <div
      ref={sectionRef}
      className="day-section"
      style={{ '--day-color': color } as React.CSSProperties}
    >
      <div className="day-heading">
        <span>D{day.dayIndex}</span>
        <div>
          <h3>
            {day.title.replace(
              /^(day\s*\d+|第\s*\d+\s*天)\s*[:：·]?\s*/i,
              ''
            ) || `第 ${day.dayIndex} 天`}
          </h3>
          <p>
            {day.date ? `${day.date} · ` : ''}
            {day.stops.length} 个沿途停留
          </p>
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
            onEdit={onStopEdit}
            editingBusy={stopEditingBusy}
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
          onStopEdit={onStopEdit}
          stopEditingBusy={stopEditingBusy}
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
  onStopDelete,
  onStopEdit,
  stopEditingBusy
}: {
  stops: Stop[];
  title: string;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onStopDelete?: (stopId: string) => void;
  onStopEdit: (stopId: string) => void;
  stopEditingBusy: boolean;
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
          onEdit={onStopEdit}
          editingBusy={stopEditingBusy}
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
  onDelete,
  onEdit,
  editingBusy
}: {
  stop: Stop;
  compact?: boolean;
  selected: boolean;
  onSelect: (stopId: string) => void;
  onDelete?: (stopId: string) => void;
  onEdit: (stopId: string) => void;
  editingBusy: boolean;
}) {
  const status = stop.poiMatch?.status;
  const isMatched = status === 'matched';
  const canFocusMap = Boolean(stop.poiMatch?.location);
  const handleSelect = () => {
    if (canFocusMap) onSelect(stop.id);
    else if (!editingBusy) onEdit(stop.id);
  };

  return (
    <article
      className={`stop-card ${compact ? 'compact' : ''} ${status === 'unmatched' ? 'unmatched' : ''} ${!canFocusMap ? 'not-focusable' : ''} ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={canFocusMap ? stop.name : `修改地点 ${stop.name}`}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleSelect();
        }
      }}
    >
      <div className="stop-card-title">
        <span>{activitySymbol(stop) || stop.label}</span>
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
      {(stop.activity || (stop.arrival && stop.arrival.mode !== 'auto')) && (
        <div className="activity-badges">
          {stop.activity && <span>{activityDescription(stop)}</span>}
          {stop.time && <span>{stop.time}</span>}
          {stop.arrival?.mode === 'ferry' && (
            <span>乘船 · {stop.arrival.label || '水路'}</span>
          )}
          {stop.arrival && !['auto', 'ferry'].includes(stop.arrival.mode) && (
            <span>
              {transportNames[stop.arrival.mode]}
              {stop.arrival.source === 'inferred' ? ' · 模型推断' : ''}
              {stop.arrival.label ? ' · ' + stop.arrival.label : ''}
            </span>
          )}
        </div>
      )}
      {stop.arrival?.reason && (
        <details className="transport-evidence">
          <summary>
            交通依据{stop.arrival.source === 'inferred' ? ' · 推断' : ''}
          </summary>
          <p>
            {stop.arrival.fromName ? `从 ${stop.arrival.fromName} 出发。` : ''}
            {stop.arrival.reason}
            {typeof stop.arrival.confidence === 'number'
              ? ` · 置信度 ${Math.round(stop.arrival.confidence * 100)}%`
              : ''}
          </p>
          {stop.arrival.quote && <p>原文：{stop.arrival.quote}</p>}
          {stop.arrival.steps?.map((step, i) => (
            <p key={i}>
              {transportNames[step.mode]} {step.line} {step.fromName} →{' '}
              {step.toName} {step.note}
            </p>
          ))}
        </details>
      )}
      {stop.note && <p>{stop.note}</p>}
      {stop.activity?.quote && (
        <details className="activity-source">
          <summary>原文依据</summary>
          <p>{stop.activity.quote}</p>
        </details>
      )}
      {placeRegionLabel(stop) && <small>{placeRegionLabel(stop)}</small>}
      {stop.poiMatch?.address && <small>{stop.poiMatch.address}</small>}
      {status === 'unmatched' && (
        <small>
          {stop.poiMatch?.errorInfo || '未匹配到高德 POI'}，请选择准确位置。
        </small>
      )}
      <button
        type="button"
        className="stop-edit-button"
        disabled={editingBusy}
        aria-label={`修改地点 ${stop.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onEdit(stop.id);
        }}
      >
        <Pencil size={12} />
        {canFocusMap ? '修改地点' : '确认位置'}
      </button>
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
      <button
        className={activeDay === 'all' ? 'active' : ''}
        onClick={() => onDayChange('all')}
        type="button"
      >
        全部
      </button>
      {itinerary.days.map((day) => (
        <button
          key={day.dayIndex}
          className={activeDay === day.dayIndex ? 'active' : ''}
          onClick={() => onDayChange(day.dayIndex)}
          type="button"
        >
          <i style={{ background: colorForDay(day.dayIndex) }} />D{day.dayIndex}
        </button>
      ))}
    </div>
  );
}

function MapView({
  itinerary,
  displayItinerary,
  activeDay,
  onDayChange,
  onItineraryChange,
  onPlanningChange,
  routePreference,
  connectDays,
  showRoutes,
  showMapLabels,
  selectedStopId,
  onStopSelect,
  onActivityToggle,
  activityBusy,
  pendingActivityChanges,
  readOnly,
  visible
}: {
  itinerary: Itinerary | null;
  displayItinerary: Itinerary | null;
  activeDay: ActiveDay;
  onDayChange: (day: ActiveDay) => void;
  onItineraryChange: (itinerary: Itinerary) => void;
  onPlanningChange: (busy: boolean) => void;
  routePreference: RoutePreference;
  connectDays: boolean;
  showRoutes: boolean;
  showMapLabels: boolean;
  selectedStopId: string | null;
  onStopSelect: (stopId: string) => void;
  onActivityToggle: (dayIndex: number, option: Stop, include: boolean) => void;
  activityBusy: boolean;
  pendingActivityChanges: boolean;
  readOnly: boolean;
  visible: boolean;
}) {
  const mapItinerary = displayItinerary || itinerary;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<AMapNamespace | null>(null);
  const overlaysRef = useRef<any[]>([]);
  const mapPresentationRef = useRef<ReturnType<typeof createJourneyMap> | null>(
    null
  );
  const drawingRef = useRef<JourneyMapDrawing | null>(null);
  const stopLookupRef = useRef<
    Map<
      string,
      JourneyMapDrawing['stopLookup'] extends Map<string, infer T> ? T : never
    >
  >(new Map());
  const enrichingRef = useRef(false);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapStatus, setMapStatus] = useState('');
  const [mapError, setMapError] = useState('');
  const [appearance, setAppearance] = useState<JourneyMapAppearance>(() => {
    try {
      return localStorage.getItem('map-tour:map-appearance') === 'satellite'
        ? 'satellite'
        : 'atlas';
    } catch {
      return 'atlas';
    }
  });
  const [tilted, setTilted] = useState(false);
  const [mapZoom, setMapZoom] = useState(5);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) =>
        setMapError(err instanceof Error ? err.message : String(err))
      );
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
        mapPresentationRef.current = createJourneyMap(
          AMap,
          containerRef.current,
          config.amapMapStyle
        );
        mapRef.current = mapPresentationRef.current.map;
        mapRef.current.on('zoomend', () => {
          if (!disposed) setMapZoom(mapRef.current.getZoom());
        });
        mapRef.current.on('pitchchange', () => {
          if (!disposed) setTilted(mapRef.current.getPitch() > 1);
        });
        mapRef.current.on('rotatechange', () => {
          if (!disposed) setRotation(mapRef.current.getRotation());
        });
        setMapReady(true);
        setMapStatus('');
      })
      .catch((err) => {
        setMapError(err instanceof Error ? err.message : String(err));
        setMapStatus('');
      });

    return () => {
      disposed = true;
      drawingRef.current?.dispose();
      drawingRef.current = null;
      mapRef.current?.destroy?.();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [config]);

  useEffect(() => {
    if (!mapReady) return;
    mapPresentationRef.current?.setAppearance(appearance);
    drawingRef.current?.setAppearance(appearance);
    drawingRef.current?.layout();
    try {
      localStorage.setItem('map-tour:map-appearance', appearance);
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
  }, [appearance, mapReady]);

  useEffect(() => {
    if (!visible || !mapReady) return;
    let timer = 0;
    const refit = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        mapRef.current?.resize?.();
        mapRef.current?.clearInfoWindow();
        if (overlaysRef.current.length)
          mapRef.current?.setFitView(
            overlaysRef.current,
            true,
            getMapFitPadding(containerRef.current)
          );
      }, 120);
    };
    const observer = new ResizeObserver(refit);
    if (containerRef.current) observer.observe(containerRef.current);
    refit();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, mapReady]);

  useEffect(() => {
    const AMap = amapRef.current;
    if (!mapReady || !AMap || !itinerary || enrichingRef.current) return;
    const expectedRouteCount = countExpectedRouteSegments(
      itinerary,
      connectDays
    );
    if (
      !itinerary.transportNeedsReview &&
      !hasPendingPoiMatches(itinerary) &&
      itinerary.routeSegments.length >= expectedRouteCount
    )
      return;

    enrichingRef.current = true;
    setMapError('');
    onPlanningChange(true);
    enrichItineraryWithAmap(
      AMap,
      itinerary,
      routePreference,
      connectDays,
      setMapStatus,
      itinerary.transportNeedsReview
        ? async (value) => (await inferTransport(value)).itinerary
        : undefined
    )
      .then((next) => {
        onItineraryChange(next);
        const unresolved = new Set(getAllStops(next).filter(stop => stop.poiMatch?.status !== 'matched').map(stop => stop.id)).size;
        setMapStatus(unresolved
          ? `匹配完成，${unresolved} 处地点未找到，可在行程中点击“确认位置”。`
          : '地点匹配和路线规划完成。');
      })
      .catch((err) => {
        setMapStatus('');
        setMapError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        enrichingRef.current = false;
        onPlanningChange(false);
      });
  }, [
    itinerary,
    onItineraryChange,
    onPlanningChange,
    readOnly,
    mapReady,
    routePreference,
    connectDays
  ]);

  useEffect(() => {
    if (!mapStatus || mapError || !/完成/.test(mapStatus)) return;
    const timer = window.setTimeout(() => setMapStatus(''), 2400);
    return () => window.clearTimeout(timer);
  }, [mapStatus, mapError]);

  useEffect(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!mapReady || !AMap || !map) return;

    drawingRef.current?.dispose();
    drawingRef.current = null;
    overlaysRef.current = [];

    if (!mapItinerary) return;
    const drawResult = drawJourneyMap(
      AMap,
      map,
      containerRef.current!,
      mapItinerary,
      activeDay,
      onStopSelect,
      showRoutes,
      showMapLabels,
      selectedStopId,
      onActivityToggle,
      activityBusy,
      pendingActivityChanges
    );
    drawingRef.current = drawResult;
    drawResult.setAppearance(appearance);
    const overlays = drawResult.fitOverlays;
    overlaysRef.current = overlays;
    stopLookupRef.current = drawResult.stopLookup;
    if (overlays.length) {
      map.setFitView(overlays, true, getMapFitPadding(containerRef.current));
    }
  }, [
    mapItinerary,
    activeDay,
    onStopSelect,
    mapReady,
    showRoutes,
    showMapLabels,
    onActivityToggle,
    activityBusy,
    pendingActivityChanges
  ]);

  useEffect(() => {
    const map = mapRef.current;
    drawingRef.current?.select(selectedStopId);
    if (!mapReady || !map || !selectedStopId) return;
    const hit = stopLookupRef.current.get(selectedStopId);
    if (!hit) return;
    openJourneyStop(map, hit);
  }, [selectedStopId, mapItinerary, activeDay, mapReady]);

  return (
    <div className={`map-wrap journey-atlas appearance-${appearance}`}>
      <div ref={containerRef} className="map-container" />
      <div className="map-atlas-shade" />
      {itinerary && (
        <>
          <div className="map-atlas-heading">
            <span>THE JOURNEY ATLAS</span>
            <h2>
              {activeDay === 'all'
                ? `${itinerary.days.length} 天的足迹`
                : `第 ${activeDay} 天的路线`}
            </h2>
            <p>{itinerary.title}</p>
            <small>
              {getVisibleDays(itinerary, activeDay).reduce(
                (n, day) => n + day.stops.length,
                0
              )}{' '}
              个行程地点 · 拖动地图探索
            </small>
          </div>
          <div
            className="map-appearance-switch"
            role="group"
            aria-label="地图底图"
          >
            <button
              type="button"
              aria-pressed={appearance === 'atlas'}
              className={appearance === 'atlas' ? 'active' : ''}
              onClick={() => setAppearance('atlas')}
            >
              <MapPinned size={14} />
              路线图
            </button>
            <button
              type="button"
              aria-pressed={appearance === 'satellite'}
              className={appearance === 'satellite' ? 'active' : ''}
              onClick={() => setAppearance('satellite')}
            >
              <Satellite size={14} />
              卫星图
            </button>
          </div>
          <div className="map-atlas-tools">
            <button
              type="button"
              aria-label="查看全程"
              title="查看全程"
              disabled={!mapReady}
              onClick={() => {
                onDayChange('all');
                mapRef.current?.clearInfoWindow();
                mapRef.current?.setPitch(0, true);
                mapRef.current?.setRotation(0, true);
                mapRef.current?.setFitView(
                  overlaysRef.current,
                  true,
                  getMapFitPadding(containerRef.current)
                );
              }}
            >
              <LocateFixed size={18} />
            </button>
            <button
              type="button"
              aria-label="放大地图"
              title="放大"
              disabled={!mapReady}
              onClick={() => mapRef.current?.zoomIn()}
            >
              <Plus size={18} />
            </button>
            <button
              type="button"
              aria-label="缩小地图"
              title="缩小"
              disabled={!mapReady}
              onClick={() => mapRef.current?.zoomOut()}
            >
              <Minus size={18} />
            </button>
            <button
              type="button"
              aria-label="切换倾斜视角"
              title={
                mapZoom < 10
                  ? '放大地图后可倾斜查看'
                  : tilted
                    ? '切换俯视'
                    : '倾斜查看'
              }
              disabled={!mapReady || mapZoom < 10}
              aria-pressed={tilted}
              onClick={() => mapRef.current?.setPitch(tilted ? 0 : 42, true)}
            >
              <Mountain size={17} />
            </button>
            <button
              type="button"
              aria-label="重置地图朝向"
              title="朝向正北"
              disabled={!mapReady}
              onClick={() => {
                mapRef.current?.setRotation(0, true);
                mapRef.current?.setPitch(0, true);
              }}
            >
              <Compass
                size={18}
                style={{ transform: `rotate(${-rotation}deg)` }}
              />
              <span>N</span>
            </button>
          </div>
        </>
      )}
      {!itinerary && (
        <div className="map-empty">
          <MapPinned size={32} />
          <h2>导入行程后生成路线地图</h2>
          <p>地点会按天分色，路线会按顺序连接，短距离自动使用步行。</p>
        </div>
      )}
      {(mapStatus || mapError) && (
        <div className={`map-toast ${mapError ? 'error' : ''}`}>
          {mapStatus && !mapError && (/完成/.test(mapStatus) ? <Check size={16} /> : <Loader2 className="spin" size={16} />)}
          <span>{mapError || mapStatus}</span>
        </div>
      )}
      {itinerary && (
        <div className="map-atlas-legend">
          <div>
            {itinerary.days.map((day) => (
              <button
                key={day.dayIndex}
                type="button"
                aria-pressed={activeDay === day.dayIndex}
                onClick={() =>
                  onDayChange(activeDay === day.dayIndex ? 'all' : day.dayIndex)
                }
                className={activeDay === day.dayIndex ? 'active' : ''}
              >
                <i
                  style={{
                    background: atlasDayColor(
                      day.dayIndex,
                      appearance === 'atlas'
                    )
                  }}
                />
                D{day.dayIndex}
              </button>
            ))}
          </div>
          <span>
            {getMapOnlyActivities(itinerary, activeDay).length > 0 && (
              <>
                <em className="map-activity-key">
                  <b>餐</b>用餐
                </em>
                <em className="map-activity-key stay">
                  <b>宿</b>住宿
                </em>
              </>
            )}
            <i />
            虚线为示意或跨天衔接
          </span>
        </div>
      )}
    </div>
  );
}

function countExpectedRouteSegments(
  itinerary: Itinerary,
  connectDays: boolean
): number {
  const inDaySegments = itinerary.days.reduce(
    (total, day) => total + Math.max(day.stops.length - 1, 0),
    0
  );
  if (!connectDays) return inDaySegments;
  const routeDays = itinerary.days.filter((day) => day.stops.length > 0);
  return inDaySegments + Math.max(routeDays.length - 1, 0);
}

function getMapFitPadding(
  container?: HTMLElement | null
): [number, number, number, number] {
  const width = container?.clientWidth || window.innerWidth;
  const height = container?.clientHeight || window.innerHeight;
  return [
    Math.min(60, height * 0.14),
    Math.min(65, width * 0.1),
    Math.min(85, height * 0.2),
    Math.min(65, width * 0.1)
  ];
}

function StatusBlock({ message, error }: { message: string; error: string }) {
  if (!message && !error) return null;
  return (
    <div className={`status-block ${error ? 'error' : ''}`}>
      {error || message}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-panel">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
