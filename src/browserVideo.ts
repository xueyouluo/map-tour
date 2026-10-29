import type { VideoJob } from './shared/videoExport';

export interface JourneySceneWindow extends Window {
  sampleReady?: boolean;
  sceneError?: string;
  __video?: {
    seekAsync(t: number): Promise<unknown>;
    setTime(t: number): Promise<void>;
    pause(): void;
    play(): void;
    getTime(): number;
    isPlaying(): boolean;
    prepareExport?(): Promise<void>;
    duration: number;
  };
}

export async function browserVideoSupport(
  withMusic: boolean
): Promise<boolean> {
  if (!window.isSecureContext || !('VideoEncoder' in window)) return false;
  try {
    const { canEncodeVideo, canEncodeAudio } = await import('mediabunny');
    return (
      (await canEncodeVideo('avc', {
        width: 1080,
        height: 1920,
        bitrate: 10_000_000
      })) &&
      (!withMusic ||
        (await canEncodeAudio('aac', {
          numberOfChannels: 2,
          sampleRate: 48000,
          bitrate: 192000
        })))
    );
  } catch {
    return false;
  }
}

function abortCheck(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason || new DOMException('已取消', 'AbortError');
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason || new DOMException('已取消', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) aborted();
  });
}
export async function renderBrowserVideo(
  scene: JourneySceneWindow,
  job: VideoJob,
  signal: AbortSignal,
  progress: (value: number, text: string) => void
): Promise<{ blob: Blob; cover: Blob }> {
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    CanvasSource,
    AudioBufferSource
  } = await import('mediabunny');
  const api = scene.__video;
  const original = scene.document.getElementById(
    'film'
  ) as HTMLCanvasElement | null;
  if (!api || !original) throw new Error('场景尚未准备好');
  api.pause();
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  const context = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget()
  });
  const video = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: 10_000_000,
    keyFrameInterval: 2
  });
  output.addVideoTrack(video, { frameRate: 30 });
  let audio: InstanceType<typeof AudioBufferSource> | undefined;
  let buffer: AudioBuffer | undefined;
  let cover: Blob | null = null;
  const cancel = () => {
    void output.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (api.prepareExport) await abortable(api.prepareExport(), signal);
    if (job.options.music !== 'none') {
      progress(1, '准备配乐');
      const response = await fetch(
        new URL('music.wav', new URL(job.sceneUrl!, location.origin)),
        { signal }
      );
      if (!response.ok) throw new Error('配乐加载失败');
      const decoder = new AudioContext({ sampleRate: 48000 });
      try {
        buffer = await abortable(
          decoder.decodeAudioData(await response.arrayBuffer()),
          signal
        );
      } finally {
        await decoder.close();
      }
      audio = new AudioBufferSource({ codec: 'aac', bitrate: 192000 });
      output.addAudioTrack(audio);
    }
    abortCheck(signal);
    await output.start();
    if (audio && buffer) {
      await abortable(audio.add(buffer), signal);
      audio.close();
      buffer = undefined;
    }
    const frames = Math.round(job.duration * 30);
    for (let frame = 0; frame < frames; frame++) {
      abortCheck(signal);
      if (scene.sceneError) throw new Error(scene.sceneError);
      await abortable(api.seekAsync(frame / 30), signal);
      context.drawImage(original, 0, 0);
      if (frame === Math.min(90, frames - 1))
        cover = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85)
        );
      await abortable(video.add(frame / 30, 1 / 30), signal);
      if (frame % 5 === 0) {
        progress(3 + (92 * frame) / frames, '正在本机生成视频');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    abortCheck(signal);
    video.close();
    progress(97, '整理 MP4 文件');
    await abortable(output.finalize(), signal);
    const bytes = output.target.buffer;
    if (!bytes?.byteLength || !cover) throw new Error('视频编码未完成');
    const blob = new Blob([bytes], { type: 'video/mp4' });
    progress(99, '检查视频播放');
    await verifyBrowserVideo(blob, job.duration, signal);
    return { blob, cover };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 1;
  }
}

async function verifyBrowserVideo(
  blob: Blob,
  duration: number,
  signal: AbortSignal
) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => done(new Error('视频播放检查超时')),
        15000
      );
      const aborted = () =>
        done(signal.reason || new DOMException('已取消', 'AbortError'));
      const done = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        video.onloadedmetadata = video.onseeked = video.onerror = null;
        error ? reject(error) : resolve();
      };
      video.onloadedmetadata = () => {
        if (
          Math.abs(video.duration - duration) >= 0.2 ||
          video.videoWidth !== 1080 ||
          video.videoHeight !== 1920
        )
          done(new Error('视频格式检查失败'));
        else video.currentTime = Math.min(1, duration / 2);
      };
      video.onseeked = () =>
        video.readyState >= 2 ? done() : done(new Error('视频解码检查失败'));
      video.onerror = () => done(new Error('浏览器无法播放生成的视频'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      video.load();
    });
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export interface LocalJourneyVideo {
  journeySignature?: string;
  id: string;
  itineraryId: string;
  sourceSceneId?: string;
  title: string;
  createdAt: string;
  duration: number;
  musicName: string;
  blob: Blob;
  cover: Blob;
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('map-tour-local-videos', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('videos', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storedVideos(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
) {
  const db = await database();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('videos', mode);
      const request = operation(transaction.objectStore('videos'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
export async function listLocalVideos(itineraryId: string) {
  const rows = (await storedVideos('readonly', (s) =>
    s.getAll()
  )) as LocalJourneyVideo[];
  return rows
    .filter((r) => r.itineraryId === itineraryId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function saveLocalVideo(video: LocalJourneyVideo) {
  await storedVideos('readwrite', (s) => s.put(video));
  const rows = (await storedVideos('readonly', (s) =>
    s.getAll()
  )) as LocalJourneyVideo[];
  const oldest = rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(3);
  for (const row of oldest) await deleteLocalVideo(row.id);
}
export const deleteLocalVideo = (id: string) =>
  storedVideos('readwrite', (s) => s.delete(id));
