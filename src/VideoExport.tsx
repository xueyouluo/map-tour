import { localMusicDuration, saveBrowserMusic, readBrowserMusic } from './browserMusic';
import { unmatchedRouteStops } from './shared/stopLocations';
import './stopLocationEditor.css';
import { useAuth } from './Auth';
import { journeySignature } from './shared/journeySignature';
import { createExportWatchdog } from './shared/browserExport';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronRight,
  Clock3,
  Download,
  Film,
  Footprints,
  Loader2,
  MapPinned,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  VolumeX,
  X
} from 'lucide-react';
import type { Itinerary } from './shared/itinerary';
import { createVideoPlan, type VideoPlan } from './shared/videoPlan';
import {
  isVideoJobActive,
  type VideoCapabilities,
  type VideoJob,
  type VideoMusicKind,
  type VideoMusicUpload,
  type VideoMusicTrack
} from './shared/videoExport';
import {
  cancelVideoJob,
  createVideoJob,
  createVideoScene,
  deleteVideoJob,
  fallbackVideoJob,
  listVideoJobs,
  retryVideoJob,
  uploadVideoMusic,
  videoCapabilities,
  listVideoMusic
} from './videoApi';
import {
  browserVideoSupport,
  deleteLocalVideo,
  listLocalVideos,
  renderBrowserVideo,
  saveLocalVideo,
  type JourneySceneWindow,
  type LocalJourneyVideo
} from './browserVideo';
import './videoExport.css';
import { MusicLibraryPicker } from './MusicLibraryPicker';

const stateText = {
  queued: '排队中',
  running: '制作中',
  cancelling: '取消中',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消'
};

export function VideoExport({
  itinerary,
  planningRoute = false,
  pendingRouteEdits = false,
  embedded = false,
  chapterDay = 'all',
  focusStopId = null,
  exportRequest = 0,
  onEncodingChange,
  onEditStop,
  visible = true
}: {
  itinerary: Itinerary;
  planningRoute?: boolean;
  pendingRouteEdits?: boolean;
  embedded?: boolean;
  chapterDay?: number | 'all';
  focusStopId?: string | null;
  exportRequest?: number;
  onEncodingChange?: (encoding: boolean) => void;
  onEditStop?: (stopId: string) => void;
  visible?: boolean;
}) {
  const { session, openAuth } = useAuth();
  const unmatchedStops = useMemo(
    () => unmatchedRouteStops(itinerary),
    [itinerary]
  );
  const signature = useMemo(() => journeySignature(itinerary), [itinerary]);
  const [open, setOpen] = useState(embedded);
  const [preparedPlan, setPreparedPlan] = useState<VideoPlan | null>(null);
  const [previewBackdrop, setPreviewBackdrop] = useState('');
  const [capability, setCapability] = useState<VideoCapabilities | null>(null);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [localVideos, setLocalVideos] = useState<LocalJourneyVideo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localId, setLocalId] = useState<string | null>(null);
  const [duration, setDuration] = useState('auto');
  const [music, setMusic] = useState<VideoMusicKind>('upbeat');
  const [musicTracks, setMusicTracks] = useState<VideoMusicTrack[]>([]);
  const [trackId, setTrackId] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const musicTouched = useRef(false);
  const [upload, setUpload] = useState<VideoMusicUpload | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pollError, setPollError] = useState('');
  const [pollKey, setPollKey] = useState(0);
  const [encoding, setEncoding] = useState(false);
  const [encodeProgress, setEncodeProgress] = useState({ value: 0, text: '' });
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneLoadError, setSceneLoadError] = useState('');
  const [sceneProgress, setSceneProgress] = useState('加载立体地图');
  const [sceneReload, setSceneReload] = useState(0);
  const [exportFailure, setExportFailure] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const controller = useRef<AbortController>();
  const exportWatchdog = useRef<ReturnType<typeof createExportWatchdog>>();
  const fallbackLock = useRef(false);
  const handedOff = useRef(false);
  const initialized = useRef(false);
  const selected = jobs.find((j) => j.id === selectedId) || null;
  const local = localVideos.find((j) => j.id === localId) || null;
  const active = jobs.find(isVideoJobActive);
  const inProgress = selected && isVideoJobActive(selected);
  const scene =
    selected?.kind === 'scene' && selected.state === 'completed'
      ? selected
      : null;
  const result = Boolean(
    local || (selected?.state === 'completed' && !selected.kind)
  );
  const options = {
    durationSeconds: duration === 'auto' ? undefined : Number(duration),
    music,
    ...(music === 'library' ? { trackId } : {}),
    ...(music === 'upload' ? { uploadId: upload?.id, localMusic: upload ? { name: upload.name, duration: upload.duration } : undefined } : {})
  };
  const summary = useMemo(() => {
    try {
      return {
        plan: createVideoPlan(itinerary, {
          durationSeconds: duration === 'auto' ? undefined : Number(duration)
        }),
        error: ''
      };
    } catch (issue) {
      return {
        plan: null,
        error:
          issue instanceof Error ? issue.message : '这条行程暂时无法生成视频。'
      };
    }
  }, [itinerary, duration]);
  const minDuration = useMemo(() => {
    try {
      const plan = createVideoPlan(itinerary);
      return Math.ceil(
        7 +
          plan.events.reduce(
            (total, event) => total + event.holdEnd - event.end + 0.8,
            0
          ) -
          1e-7
      );
    } catch {
      return 0;
    }
  }, [itinerary]);
  const localUrls = useMemo(
    () =>
      local
        ? {
            video: URL.createObjectURL(local.blob),
            cover: URL.createObjectURL(local.cover)
          }
        : null,
    [local]
  );
  useEffect(
    () => () => {
      if (localUrls) {
        URL.revokeObjectURL(localUrls.video);
        URL.revokeObjectURL(localUrls.cover);
      }
    },
    [localUrls]
  );
  useEffect(
    () => () =>
      controller.current?.abort(new DOMException('已取消', 'AbortError')),
    []
  );

  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const value = await listVideoJobs(itinerary.id);
        if (disposed) return;
        setJobs(value.jobs);
        setPollError('');
        if (!initialized.current) {
          const locals = await listLocalVideos(itinerary.id).catch(() => []);
          if (disposed) return;
          setLocalVideos(locals);
          const pending = value.jobs.find(
            (job) => isVideoJobActive(job) && job.journeySignature === signature
          );
          if (pending) setSelectedId(pending.id);
          else if (locals.find((video) => video.journeySignature === signature))
            setLocalId(
              locals.find((video) => video.journeySignature === signature)!.id
            );
          else
            setSelectedId(
              value.jobs.find(
                (j) =>
                  j.kind === 'scene' &&
                  j.state === 'completed' &&
                  j.journeySignature === signature
              )?.id || null
            );
          initialized.current = true;
        }
        if (open || value.jobs.some(isVideoJobActive))
          timer = setTimeout(refresh, 2000);
      } catch {
        if (!disposed) {
          setPollError('暂时无法更新进度，正在重新连接。');
          timer = setTimeout(refresh, 5000);
        }
      }
    }
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [itinerary.id, open, pollKey]);
  useEffect(() => {
    if (open)
      videoCapabilities()
        .then(setCapability)
        .catch(() => setError('暂时无法连接素材服务，请稍后再试。'));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    listVideoMusic()
      .then(({ tracks }) => {
        if (disposed) return;
        setMusicTracks(tracks);
        setLibraryError('');
        if (!musicTouched.current && tracks[0]) {
          let saved = '';
          try {
            saved = localStorage.getItem('map-tour:music-track') || '';
          } catch {
            /* Private browsing may disable storage. */
          }
          setTrackId(
            tracks.find((track) => track.id === saved)?.id || tracks[0].id
          );
          setMusic('library');
        }
      })
      .catch(() => {
        if (!disposed)
          setLibraryError('内置曲库暂时无法加载，可以使用原版轻快或上传音乐。');
      });
    return () => {
      disposed = true;
    };
  }, [open]);
  useEffect(() => {
    if (!open || embedded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focus = requestAnimationFrame(() =>
      dialog.current
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus()
    );
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && !encoding) setOpen(false);
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), video[controls]'
        ) || []
      ).filter((e) => e.offsetParent !== null);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(focus);
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', key);
      trigger.current?.focus();
    };
  }, [open, encoding, embedded]);
  useEffect(() => {
    onEncodingChange?.(encoding);
  }, [encoding, onEncodingChange]);
  useEffect(() => {
    setPreparedPlan(null);
    setPreviewBackdrop('');
    if (!scene?.sceneUrl) return;
    const task = new AbortController();
    fetch(new URL('plan.json', new URL(scene.sceneUrl, location.origin)), {
      signal: task.signal
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (!task.signal.aborted) setPreparedPlan(value);
      })
      .catch(() => {});
    return () => task.abort();
  }, [scene?.id]);
  useEffect(() => {
    if (!embedded || !sceneReady || !preparedPlan || encoding) return;
    const index = focusStopId
      ? preparedPlan.segments.findIndex(
          (segment) =>
            segment.toStopId === focusStopId ||
            segment.fromStopId === focusStopId
        )
      : chapterDay === 'all'
        ? -1
        : preparedPlan.segments.findIndex(
            (segment) => segment.dayIndex === chapterDay
          );
    const target =
      index < 0
        ? 0
        : focusStopId && preparedPlan.segments[index].toStopId === focusStopId
          ? preparedPlan.events[index].end
          : preparedPlan.events[index].start + 0.3;
    let disposed = false;
    const child = frame.current?.contentWindow as JourneySceneWindow;
    void child?.__video
      ?.setTime(target)
      .then(() => {
        if (disposed) return;
        const original = child.document.getElementById(
          'film'
        ) as HTMLCanvasElement;
        const thumbnail = document.createElement('canvas');
        thumbnail.width = 320;
        thumbnail.height = 220;
        thumbnail
          .getContext('2d')
          ?.drawImage(original, 0, original.height * (400 / 1920),
            original.width, original.height * (1100 / 1920), 0, 0, 320, 220);
        setPreviewBackdrop(thumbnail.toDataURL('image/jpeg', 0.65));
      })
      .catch(() => {});
    setTime(target);
    setPlaying(false);
    return () => {
      disposed = true;
    };
  }, [embedded, chapterDay, focusStopId, sceneReady, preparedPlan]);
  useEffect(() => {
    if (!encoding) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const hidden = () => {
      exportWatchdog.current?.touch();
      if (document.hidden) setNotice('正在后台继续本机导出，返回此标签页可加快速度。');
      else setNotice((current) => current === '正在后台继续本机导出，返回此标签页可加快速度。' ? '' : current);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [encoding]);
  useEffect(() => {
    setSceneReady(false);
    setSceneLoadError('');
    setSceneProgress('加载立体地图');
    setExportFailure('');
    setPlaying(false);
    setTime(0);
    if (!scene || !open) return;
    let lastProgressAt = Date.now();
    let lastProgress = '';
    let hasLoaded = false;
    const timer = setInterval(() => {
      const child = frame.current?.contentWindow as (JourneySceneWindow & { sceneProgress?: string }) | null;
      if (child?.sceneProgress) {
        setSceneProgress(child.sceneProgress);
        if (child.sceneProgress !== lastProgress) {
          lastProgress = child.sceneProgress;
          lastProgressAt = Date.now();
        }
      }
      if (child?.sceneError || (!hasLoaded && Date.now() - lastProgressAt > 120000)) {
        clearInterval(timer);
        setSceneReady(false);
        setSceneLoadError(child?.sceneError || '预览加载超时，请重新加载预览；也可以手动使用后台制作。');
      } else if (child?.sampleReady && child.__video) {
        hasLoaded = true;
        setSceneReady(true);
        setTime(child.__video.getTime());
        setPlaying(child.__video.isPlaying());
      }
    }, 300);
    return () => clearInterval(timer);
  }, [scene?.id, open, sceneReload]);

  function remember(job: VideoJob) {
    setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
    setSelectedId(job.id);
    setLocalId(null);
    setPollKey((n) => n + 1);
  }
  async function fallback(job: VideoJob, message: string) {
    if (fallbackLock.current) return;
    fallbackLock.current = true;
    handedOff.current = true;
    controller.current?.abort(new DOMException('已转入后台', 'AbortError'));
    setBusy(true);
    setError('');
    setNotice(message);
    try {
      let uploadId: string | undefined;
      if (job.options.localMusic) {
        setNotice('正在上传音乐，上传完成后开始后台制作。');
        const file = await readBrowserMusic(job.options.uploadId!);
        uploadId = (await uploadVideoMusic(file)).upload.id;
      }
      remember((await fallbackVideoJob(job.id, uploadId)).job);
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : '后台制作暂不可用，请重试。'
      );
    } finally {
      setBusy(false);
      fallbackLock.current = false;
    }
  }
  async function create(background = false) {
    if (!session.user) {
      openAuth();
      return;
    }
    if (!summary.plan || planningRoute || pendingRouteEdits) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      remember(
        (
          await (async () => {
            if (!background) return createVideoScene(itinerary, options);
            if (options.localMusic) {
              const file = await readBrowserMusic(options.uploadId!);
              const uploaded = await uploadVideoMusic(file);
              const { localMusic: _local, ...remote } = options;
              return createVideoJob(itinerary, { ...remote, uploadId: uploaded.upload.id });
            }
            return createVideoJob(itinerary, options);
          })()
        ).job
      );
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : '没有开始制作，请重试。'
      );
    } finally {
      setBusy(false);
    }
  }
  async function encode() {
    const child = frame.current?.contentWindow as JourneySceneWindow | null;
    if (!scene || !child?.__video || !sceneReady || encoding) return;
    const task = new AbortController();
    controller.current = task;
    handedOff.current = false;
    setEncoding(true);
    setError('');
    setNotice('');
    setExportFailure('');
    setPlaying(false);
    setEncodeProgress({ value: 0, text: '准备本机导出' });
    const watchdog = createExportWatchdog(
      () => task.abort(new Error('本机导出长时间没有进展，请检查网络后重试。')),
      () => document.hidden
    );
    exportWatchdog.current = watchdog;
    watchdog.touch();
    try {
      if (!(await browserVideoSupport(scene.options.music !== 'none')))
        throw new Error('当前浏览器不支持此次高清编码，可以换用 Chrome，或手动使用后台制作。');
      const media = await renderBrowserVideo(
        child,
        scene,
        task.signal,
        (value, text) => {
          watchdog.touch();
          setEncodeProgress({ value, text });
        }
      );
      const video: LocalJourneyVideo = {
        ...media,
        journeySignature: signature,
        id: crypto.randomUUID(),
        itineraryId: scene.itineraryId,
        sourceSceneId: scene.id,
        title: scene.title,
        duration: scene.duration,
        musicName: scene.musicName,
        createdAt: new Date().toISOString()
      };
      try {
        await saveLocalVideo(video);
        setLocalVideos(await listLocalVideos(itinerary.id));
      } catch {
        setLocalVideos((rows) => [video, ...rows]);
        setNotice('浏览器存储空间不足，请立即下载；关闭页面后可能无法找回。');
      }
      setLocalId(video.id);
      setSelectedId(null);
      setEncodeProgress({ value: 100, text: '制作完成' });
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) {
        const message = issue instanceof Error ? issue.message : '本机导出失败，请重试。';
        setExportFailure(message);
        try {
          sessionStorage.setItem('map-tour:last-export-failure', JSON.stringify({
            sceneId: scene.id, message, at: new Date().toISOString()
          }));
        } catch { /* The error remains visible if session storage is unavailable. */ }
      }
      else if (!handedOff.current)
        setNotice('已取消本机导出，可以继续预览或重新导出。');
    } finally {
      watchdog.stop();
      exportWatchdog.current = undefined;
      setNotice((current) => current === '正在后台继续本机导出，返回此标签页可加快速度。' ? '' : current);
      setEncoding(false);
      controller.current = undefined;
    }
  }
  async function action(kind: 'cancel' | 'retry' | 'delete', job: VideoJob) {
    setBusy(true);
    setError('');
    try {
      if (kind === 'delete') {
        await deleteVideoJob(job.id);
        setJobs((rows) => rows.filter((j) => j.id !== job.id));
        if (selectedId === job.id) setSelectedId(null);
      } else
        remember(
          (
            await (kind === 'cancel'
              ? cancelVideoJob(job.id)
              : retryVideoJob(job.id))
          ).job
        );
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : '操作没有完成，请重试。'
      );
    } finally {
      setBusy(false);
    }
  }
  async function chooseMusic(file?: File) {
    if (!session.user) {
      openAuth();
      return;
    }
    if (!file) return;
    setError('');
    setUpload(null);
    if (file.size > 25 * 1024 * 1024) {
      setError('音乐不能超过 25 MB。');
      return;
    }
    setUploading(true);
    try {
      const duration = await localMusicDuration(file);
      const id = crypto.randomUUID();
      await saveBrowserMusic(id, file);
      setUpload({ id, name: file.name, duration, bytes: file.size });
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : '音乐读取失败，请重新选择。'
      );
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }
  function reset() {
    setSelectedId(null);
    setLocalId(null);
    setError('');
    setNotice('');
  }
  const selectedTrack = musicTracks.find((track) => track.id === trackId);
  function chooseLibraryTrack(id: string) {
    musicTouched.current = true;
    setTrackId(id);
    try {
      localStorage.setItem('map-tour:music-track', id);
    } catch {
      /* Selection still works without storage. */
    }
  }
  const shortLibraryMusic =
    music === 'library' &&
    selectedTrack &&
    selectedTrack.duration < (summary.plan?.duration || 0);
  const unavailable =
    busy ||
    uploading ||
    !capability?.available ||
    !summary.plan ||
    planningRoute ||
    pendingRouteEdits ||
    (music === 'library' && (!selectedTrack || shortLibraryMusic)) ||
    (music === 'upload' &&
      (!upload || upload.duration < (summary.plan?.duration || 0)));
  const progress = encoding
    ? encodeProgress.value
    : selected?.kind === 'scene'
      ? Math.min(96, (selected?.progress || 0) / 0.66)
      : selected?.progress || 0;
  const history = jobs.filter(
    (j) =>
      j.kind !== 'scene' ||
      !localVideos.some((video) => video.sourceSceneId === j.id)
  );
  useEffect(() => {
    if (!exportRequest || encoding) return;
    setOpen(true);
    if (result)
      dialog.current
        ?.querySelector<HTMLAnchorElement>('a.video-primary')
        ?.click();
    else if (scene && sceneReady) void encode();
    else if (!inProgress) void create();
  }, [exportRequest]);
  const panel = (content: ReactNode) =>
    embedded ? content : createPortal(content, document.body);

  return (
    <>
      {!embedded && (
        <button
          ref={trigger}
          className={`video-entry ${active || encoding ? 'is-active' : ''}`}
          type="button"
          onClick={() => {
            setError('');
            setOpen(true);
          }}
        >
          {active || encoding ? (
            <Loader2 size={18} className="spin" />
          ) : (
            <Video size={19} />
          )}
          <span>{active || encoding ? '视频制作中' : '生成旅程视频'}</span>
          <ChevronRight size={14} />
        </button>
      )}
      {open &&
        panel(
          <div
            className={`video-backdrop ${embedded ? 'video-studio-embedded' : ''}`}
            onClick={(event) => {
              if (
                !embedded &&
                event.target === event.currentTarget &&
                !encoding
              )
                setOpen(false);
            }}
          >
            <div
              ref={dialog}
              className="video-dialog"
              role={embedded ? 'region' : 'dialog'}
              aria-modal={embedded ? undefined : true}
              aria-labelledby="video-title"
            >
              <header className="video-dialog-header">
                <span>
                  <Film size={18} /> MAP TOUR · 旅程视频
                </span>
                <button
                  className="video-icon-button"
                  type="button"
                  disabled={encoding}
                  aria-label="关闭视频弹窗"
                  onClick={() => setOpen(false)}
                >
                  <X size={21} />
                </button>
              </header>
              <div className="video-dialog-body">
                <div
                  className={`video-screen-column ${result || scene ? 'has-video' : ''}`}
                  style={
                    {
                      '--film-backdrop': `url("${previewBackdrop || localUrls?.cover || selected?.coverUrl || '/video-satellite-preview.webp'}")`
                    } as React.CSSProperties
                  }
                >
                  <div className="video-screen">
                    {result ? (
                      <video
                        key={local?.id || selected?.id}
                        src={localUrls?.video || selected?.videoUrl}
                        poster={localUrls?.cover || selected?.coverUrl}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label="旅程视频预览"
                      />
                    ) : scene ? (
                      <iframe
                        key={`${scene.id}-${sceneReload}`}
                        ref={frame}
                        src={scene.sceneUrl}
                        title="实时旅程预览"
                        allow="autoplay"
                      />
                    ) : (
                      <>
                        <img
                          className="video-example"
                          src="/video-satellite-preview.webp"
                          alt="小车沿着卫星地图上的路线前进"
                        />
                        <span className="video-example-label">效果示例</span>
                        <div className="video-screen-gradient" />
                        <div className="video-screen-copy">
                          <span>每一步，都值得回放</span>
                          <strong>
                            让旅程
                            <br />
                            动起来。
                          </strong>
                          <span className="video-screen-pill">
                            <MapPinned size={13} /> 卫星地图 · 3D 跟随
                          </span>
                        </div>
                      </>
                    )}
                    {(inProgress || encoding || (scene && !sceneReady && !sceneLoadError)) && (
                      <div
                        className="video-progress-overlay"
                        role="status"
                        aria-live="polite"
                      >
                        <Loader2 className="spin" size={30} />
                        <strong>
                          {encoding
                            ? encodeProgress.text
                            : scene
                              ? sceneProgress
                              : selected?.stage}
                        </strong>
                        <span>
                          {selected?.state === 'queued'
                            ? `前面还有 ${selected.queuePosition} 个任务`
                            : `${Math.round(progress)}%`}
                        </span>
                        <div
                          className="video-progress-track"
                          role="progressbar"
                          aria-label="视频制作进度"
                          aria-valuenow={progress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <i style={{ width: `${Math.max(2, progress)}%` }} />
                        </div>
                        <small>
                          {encoding
                            ? '请保持页面打开，可以切换标签页；失败后可在本机重试'
                            : '地图素材准备好后，即可在这里播放'}
                        </small>
                      </div>
                    )}
                  </div>
                  <div className="video-format">
                    <span>9:16 竖屏</span>
                    <span>1080P 高清</span>
                    <span>MP4</span>
                  </div>
                  {embedded && !result && !scene && !inProgress && (
                    <button
                      className="studio-preview-start"
                      disabled={unavailable}
                      onClick={() => create()}
                    >
                      <Play size={15} />
                      生成本行程预览
                    </button>
                  )}
                  {embedded && scene && (
                    <div className="studio-screen-controls">
                      <button
                        className="video-icon-button"
                        disabled={!sceneReady || encoding}
                        aria-label={playing ? '暂停影片' : '播放影片'}
                        onClick={() => {
                          const api = (
                            frame.current?.contentWindow as JourneySceneWindow
                          )?.__video;
                          playing ? api?.pause() : api?.play();
                          setPlaying(!playing);
                        }}
                      >
                        {playing ? <Pause size={18} /> : <Play size={18} />}
                      </button>
                      <input
                        type="range"
                        aria-label="影片时间轴"
                        min={0}
                        max={scene.duration - 0.01}
                        step={0.1}
                        value={time}
                        disabled={!sceneReady || encoding}
                        onChange={(event) => {
                          const target = Number(event.target.value);
                          setTime(target);
                          setPlaying(false);
                          void (
                            frame.current?.contentWindow as JourneySceneWindow
                          )?.__video?.setTime(target);
                        }}
                      />
                      <span>
                        {Math.floor(time).toString().padStart(2, '0')} /{' '}
                        {Math.round(scene.duration)}s
                      </span>
                      <button
                        className="studio-mobile-export"
                        disabled={!sceneReady || encoding || busy}
                        onClick={encode}
                      >
                        {encoding ? `${Math.round(progress)}%` : exportFailure ? '重试本机导出' : '导出视频'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="video-settings">
                  <div className="video-settings-heading">
                    <span className="video-eyebrow">YOUR TRIP, IN MOTION</span>
                    <h2 id="video-title">
                      {result
                        ? '旅程，已成片。'
                        : scene
                          ? '先看看，再出发。'
                          : inProgress
                            ? '旅程正在出发。'
                            : '把足迹，变成故事。'}
                    </h2>
                    <p>{local?.title || selected?.title || itinerary.title}</p>
                  </div>
                  <div className="video-trip-facts">
                    <span>
                      <MapPinned size={15} />
                      {selected?.days ?? itinerary.days.length} 天旅程
                    </span>
                    <span>
                      <Footprints size={15} />
                      {selected?.stops ?? itinerary.days.reduce((count, day) => count + day.stops.length, 0)}{' '}
                      个地点
                    </span>
                    <span>
                      <Clock3 size={15} />
                      {local?.duration || selected?.duration || summary.plan?.duration
                        ? `约 ${Math.round(local?.duration || selected?.duration || summary.plan?.duration || 0)} 秒`
                        : '确认位置后计算时长'}
                    </span>
                  </div>
                  {result ? (
                    <div className="video-result-panel">
                      <div className="video-complete-symbol">
                        <Check size={24} />
                      </div>
                      <h3>你的旅行故事已准备好</h3>
                      <p>
                        {local
                          ? '已在本机生成，可以播放和下载。'
                          : '后台制作已完成，可以播放和下载。'}
                      </p>
                      <a
                        className="video-primary"
                        href={localUrls?.video || selected?.downloadUrl}
                        download={`${local?.title || selected?.title || '旅程视频'}.mp4`}
                      >
                        <Download size={17} />
                        下载视频
                        <span>
                          {(
                            (local?.blob.size || selected?.bytes || 0) /
                            1024 /
                            1024
                          ).toFixed(1)}{' '}
                          MB
                        </span>
                      </a>
                      <small>
                        {local
                          ? '本浏览器保留最近 3 条视频，建议下载保存'
                          : `文件保留 ${capability?.retentionDays || 7} 天`}
                      </small>
                      <button className="video-secondary" onClick={reset}>
                        <Plus size={16} />
                        制作新视频
                      </button>
                    </div>
                  ) : scene ? (
                    <div className="browser-preview-panel">
                      <span className="browser-engine-badge">
                        <Check size={13} /> 浏览器实时预览
                      </span>
                      <p>
                        同一张地图，走过每天的风景。满意后直接在本机生成视频。
                      </p>
                      {(exportFailure || sceneLoadError) && (
                        <p className="video-error" role="alert">
                          {exportFailure || sceneLoadError}
                        </p>
                      )}
                      {sceneLoadError && (
                        <button className="video-secondary" disabled={encoding || busy}
                          onClick={() => setSceneReload((value) => value + 1)}>
                          重新加载预览
                        </button>
                      )}
                      <div className="browser-playback">
                        <button
                          className="video-icon-button"
                          aria-label={playing ? '暂停预览' : '播放预览'}
                          disabled={!sceneReady || encoding}
                          onClick={() => {
                            const api = (
                              frame.current?.contentWindow as JourneySceneWindow
                            )?.__video;
                            playing ? api?.pause() : api?.play();
                            setPlaying(!playing);
                          }}
                        >
                          {playing ? <Pause size={18} /> : <Play size={18} />}
                        </button>
                        <input
                          type="range"
                          aria-label="预览进度"
                          min={0}
                          max={scene.duration - 0.01}
                          step={0.1}
                          value={time}
                          disabled={!sceneReady || encoding}
                          onChange={(event) => {
                            const t = Number(event.target.value);
                            setTime(t);
                            setPlaying(false);
                            void (
                              frame.current?.contentWindow as JourneySceneWindow
                            )?.__video?.setTime(t);
                          }}
                        />
                        <span>
                          {Math.floor(time)} / {Math.round(scene.duration)}s
                        </span>
                      </div>
                      <button
                        className="video-primary"
                        disabled={!sceneReady || encoding || busy}
                        onClick={encode}
                      >
                        {encoding ? (
                          <Loader2 className="spin" size={17} />
                        ) : (
                          <Download size={17} />
                        )}
                        {encoding
                          ? `${Math.round(progress)}% · 本机制作中`
                          : exportFailure ? '重试本机导出' : '导出 MP4 视频'}
                      </button>
                      {encoding ? (
                        <button
                          className="video-secondary"
                          onClick={() =>
                            controller.current?.abort(
                              new DOMException('已取消', 'AbortError')
                            )
                          }
                        >
                          取消本机导出
                        </button>
                      ) : (
                        <button
                          className="video-secondary"
                          disabled={busy}
                          onClick={reset}
                        >
                          调整时长和配乐
                        </button>
                      )}
                      <button
                        className="video-text-action"
                        disabled={busy}
                        onClick={() => {
                          controller.current?.abort(
                            new DOMException('已取消', 'AbortError')
                          );
                          void fallback(
                            scene,
                            '已切换到后台制作，可以关闭页面，稍后回来下载。'
                          );
                        }}
                      >
                        改用后台制作
                      </button>
                      <p className="video-smallprint">
                        本机导出请保持页面打开，可以切换标签页。失败后可重试，也可手动改用后台制作。
                      </p>
                    </div>
                  ) : inProgress ? (
                    <div className="video-running-panel">
                      <h3>
                        {selected?.kind === 'scene'
                          ? '准备高清地图与配乐'
                          : '已交给后台制作'}
                      </h3>
                      <p>
                        {selected?.kind === 'scene'
                          ? '素材就绪后，在你的浏览器里预览和导出。'
                          : '可以关闭页面，稍后回来查看和下载视频。'}
                      </p>
                      {pollError && <p role="status">{pollError}</p>}
                      <button
                        className="video-secondary"
                        disabled={busy || selected?.state === 'cancelling'}
                        onClick={() => action('cancel', selected!)}
                      >
                        取消本次制作
                      </button>
                    </div>
                  ) : selected &&
                    ['failed', 'cancelled'].includes(selected.state) ? (
                    <div className="video-retry-panel">
                      <h3>
                        {selected.state === 'cancelled'
                          ? '已取消这次制作'
                          : '这次制作没有完成'}
                      </h3>
                      <p>{selected.error || '行程还在，可以随时重新制作。'}</p>
                      <button
                        className="video-primary"
                        disabled={busy || !capability?.available}
                        onClick={() => action('retry', selected)}
                      >
                        <RotateCcw size={17} />
                        重新制作
                      </button>
                      <button className="video-secondary" onClick={reset}>
                        调整时长和配乐
                      </button>
                    </div>
                  ) : (
                    <>
                      <fieldset
                        className="video-fieldset"
                        disabled={busy || encoding}
                      >
                        <legend>视频时长</legend>
                        <div className="video-duration-options">
                          {[
                            ['auto', '舒缓自动'],
                            ['30', '30 秒'],
                            ['60', '60 秒'],
                            ['90', '90 秒'],
                            ['120', '120 秒']
                          ].map(([value, label]) => (
                            <button
                              key={value}
                              disabled={
                                value !== 'auto' && Number(value) < minDuration
                              }
                              className={duration === value ? 'selected' : ''}
                              aria-pressed={duration === value}
                              onClick={() => setDuration(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="video-field-hint">
                          默认放慢移动与镜头节奏，到站多停一会儿。也可以指定时长。
                        </p>
                      </fieldset>
                      <fieldset
                        className="video-fieldset"
                        disabled={busy || encoding}
                      >
                        <legend>背景音乐</legend>
                        <div className="video-music-options">
                          {(
                            [
                              [
                                musicTracks.length ? 'library' : 'upbeat',
                                musicTracks.length ? '内置音乐' : '原版轻快',
                                Music2
                              ],
                              ['upload', '我的音乐', Upload],
                              ['none', '无配乐', VolumeX]
                            ] as const
                          ).map(([value, label, Icon]) => (
                            <button
                              key={value}
                              className={music === value ? 'selected' : ''}
                              aria-pressed={music === value}
                              onClick={() => {
                                musicTouched.current = true;
                                setMusic(value);
                                if (
                                  value === 'library' &&
                                  !trackId &&
                                  musicTracks[0]
                                )
                                  setTrackId(musicTracks[0].id);
                              }}
                            >
                              <Icon size={17} />
                              <span>{label}</span>
                              {music === value && <Check size={13} />}
                            </button>
                          ))}
                        </div>
                        {libraryError && (
                          <p className="video-field-hint" role="status">
                            {libraryError}
                          </p>
                        )}
                        {music === 'library' && (
                          <MusicLibraryPicker
                            tracks={musicTracks}
                            selectedId={trackId}
                            onSelect={chooseLibraryTrack}
                            enabled={visible && open && !busy && !encoding}
                          />
                        )}
                        {music === 'upload' && (
                          <>
                            <input
                              hidden
                              ref={input}
                              type="file"
                              accept="audio/*,.mp3,.m4a,.wav,.ogg"
                              aria-label="选择背景音乐文件"
                              onChange={(event) =>
                                chooseMusic(event.target.files?.[0])
                              }
                            />
                            <button
                              className="video-upload"
                              disabled={uploading}
                              onClick={() => input.current?.click()}
                            >
                              <Upload size={17} />
                              <span>
                                {uploading
                                  ? '正在读取音乐…'
                                  : upload
                                    ? `${upload.name} · ${Math.floor(upload.duration)} 秒`
                                    : '选择背景音乐'}
                                <small>最长 20 分钟，最大 25 MB</small>
                              </span>
                            </button>
                          </>
                        )}
                      </fieldset>
                      <div className="video-feature-note">
                        <Check size={15} />
                        <span>浏览器优先生成，需要时手动使用后台制作</span>
                      </div>
                      {pendingRouteEdits && (
                        <p className="video-notice" role="status">
                          选择已暂存，请先更新路线，再生成视频。
                        </p>
                      )}
                      {planningRoute && (
                        <p className="video-notice" role="status">
                          正在匹配地点和规划路线，请稍等片刻。
                        </p>
                      )}
                      {!planningRoute &&
                        unmatchedStops.length > 0 &&
                        onEditStop && (
                          <section
                            className="video-unmatched-places"
                            aria-label="需要确认位置的地点"
                          >
                            <strong>
                              {unmatchedStops.length} 个地点需要确认位置
                            </strong>
                            <p>
                              点击地点直接修改，选择实际景点、码头或车站后即可继续生成。
                            </p>
                            <div>
                              {unmatchedStops.map((stop) => (
                                <button
                                  type="button"
                                  key={stop.id}
                                  disabled={encoding || busy}
                                  onClick={() => onEditStop(stop.id)}
                                  aria-label={`修改地点 ${stop.name}`}
                                >
                                  <MapPinned size={13} />
                                  <span>{stop.name}</span>
                                  <ChevronRight size={13} />
                                </button>
                              ))}
                            </div>
                          </section>
                        )}
                      {!planningRoute &&
                        summary.error &&
                        (!unmatchedStops.length || !onEditStop) && (
                          <p className="video-notice" role="status">
                            {summary.error}
                          </p>
                        )}
                      {capability && !capability.available && (
                        <p className="video-notice" role="status">
                          {capability.reason}
                        </p>
                      )}
                      {summary.plan && summary.plan.warnings.length > 0 && (
                        <details className="video-route-note">
                          <summary>
                            {summary.plan.warnings.length} 段路线会以示意线呈现
                          </summary>
                          <p>缺少规划路线的衔接会显示为虚线。</p>
                          <ul>
                            {summary.plan.warnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <button
                        className="video-primary"
                        disabled={unavailable}
                        onClick={() => create()}
                      >
                        {busy ? (
                          <Loader2 className="spin" size={17} />
                        ) : (
                          <Play size={17} />
                        )}
                        {busy ? '正在准备…' : '预览我的旅程'}
                      </button>
                      <button
                        className="video-text-action"
                        disabled={unavailable}
                        onClick={() => create(true)}
                      >
                        直接使用后台制作
                      </button>
                      {shortLibraryMusic && (
                        <p className="video-notice" role="status">
                          这首音乐短于视频，请选择其他版本或缩短视频。
                        </p>
                      )}
                      {music === 'upload' &&
                        upload &&
                        summary.plan &&
                        upload.duration < summary.plan.duration && (
                          <p className="video-notice" role="status">
                            音乐短于视频，请换一首音乐或缩短视频。
                          </p>
                        )}
                      <p className="video-smallprint">
                        先预览，再导出。小车、镜头和每天的足迹自动安排。
                      </p>
                    </>
                  )}
                  {notice && (
                    <p className="video-notice" role="status">
                      {notice}
                    </p>
                  )}
                  {error && (
                    <p className="video-error" role="alert">
                      {error}
                    </p>
                  )}
                  {(localVideos.length > 0 || history.length > 0) && (
                    <div className="video-history">
                      <h3>
                        这条行程的视频{' '}
                        <span>{localVideos.length + history.length}</span>
                      </h3>
                      {localVideos.map((item) => (
                        <div
                          className={`video-history-row ${localId === item.id ? 'selected' : ''}`}
                          key={item.id}
                        >
                          <button
                            className="video-history-select"
                            disabled={encoding}
                            onClick={() => {
                              setLocalId(item.id);
                              setSelectedId(null);
                              setError('');
                              setNotice('');
                            }}
                          >
                            <span className="video-history-status completed">
                              本机
                            </span>
                            <span>
                              <strong>
                                {Math.round(item.duration)} 秒 ·{' '}
                                {item.musicName}
                              </strong>
                              <small>
                                {new Date(item.createdAt).toLocaleString(
                                  'zh-CN',
                                  {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  }
                                )}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                          <button
                            className="video-icon-button"
                            disabled={encoding}
                            aria-label="删除本机视频"
                            onClick={async () => {
                              await deleteLocalVideo(item.id).catch(() => {});
                              setLocalVideos((rows) =>
                                rows.filter((r) => r.id !== item.id)
                              );
                              if (localId === item.id) setLocalId(null);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {history.slice(0, 6).map((job) => (
                        <div
                          className={`video-history-row ${selectedId === job.id ? 'selected' : ''}`}
                          key={job.id}
                        >
                          <button
                            className="video-history-select"
                            disabled={encoding}
                            onClick={() => {
                              setSelectedId(job.id);
                              setLocalId(null);
                              setError('');
                              setNotice('');
                            }}
                          >
                            <span
                              className={`video-history-status ${job.state}`}
                            >
                              {job.kind === 'scene' && job.state === 'completed'
                                ? '待导出'
                                : stateText[job.state]}
                            </span>
                            <span>
                              <strong>
                                {Math.round(job.duration)} 秒 · {job.musicName}
                              </strong>
                              <small>
                                {job.kind === 'scene' ? '预览' : '后台'} ·{' '}
                                {new Date(job.createdAt).toLocaleString(
                                  'zh-CN',
                                  {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  }
                                )}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                          {!isVideoJobActive(job) && (
                            <button
                              className="video-icon-button"
                              aria-label="删除后台视频记录"
                              disabled={busy || encoding}
                              onClick={() => action('delete', job)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
    </>
  );
}
