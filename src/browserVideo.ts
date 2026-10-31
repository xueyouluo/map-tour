import { musicGainAt } from './shared/musicEnvelope';
import { browserMusicSource } from './browserMusic';
import type { VideoJob } from './shared/videoExport';
import { BrowserExportError, yieldBrowserWork } from './shared/browserExport';

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
    prepareExport?(progress?: (text: string) => void): Promise<void>;
    getAudioBlob?(): Blob | undefined;
    finishExport?(): void;
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
  let stage = '准备高清地图';
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => (cancellation ||= output.cancel().catch(() => {}));
  signal.addEventListener('abort', cancel, { once: true });
  try {
    progress(0, stage);
    if (api.prepareExport) await abortable(api.prepareExport((text) => progress(0, text)), signal);
    if (job.options.music !== 'none') {
      stage = '下载配乐';
      progress(1, stage);
      const localAudio = api.getAudioBlob?.() || await browserMusicSource(
        job.options, job.duration, `/api/video/jobs/${job.id}/audio-source`,
        (text) => progress(1, text), signal
      );
      const response = localAudio ? new Response(localAudio) : await fetch(
        new URL(`/api/video/jobs/${job.id}/audio`, location.origin), { signal }
      );
      if (!response.ok) throw new Error('配乐加载失败');
      const total = Number(response.headers.get('content-length'));
      let audioBytes: ArrayBuffer;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        let reported = 0;
        try {
          while (true) {
            const { done, value } = await abortable(reader.read(), signal);
            if (done) break;
            abortCheck(signal);
            chunks.push(value);
            received += value.byteLength;
            if (performance.now() - reported > 200 || received === total) {
              reported = performance.now();
              progress(1, total > 0
                ? `下载配乐 ${Math.min(100, Math.round(received * 100 / total))}%`
                : `下载配乐 ${(received / 1048576).toFixed(1)} MB`);
            }
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        audioBytes = bytes.buffer;
      } else audioBytes = await response.arrayBuffer();
      stage = '解码配乐';
      progress(2, stage);
      const decoder = new AudioContext({ sampleRate: 48000 });
      try {
        const decoded = await abortable(decoder.decodeAudioData(audioBytes), signal);
        if (decoded.duration + 0.05 < job.duration) throw new Error('配乐短于视频，请选择其他音乐。');
        buffer = decoder.createBuffer(decoded.numberOfChannels, Math.round(job.duration * decoded.sampleRate), decoded.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const input = decoded.getChannelData(channel), result = buffer.getChannelData(channel);
          for (let i = 0; i < result.length; i++) result[i] = (input[i] || 0) * musicGainAt(i / buffer.sampleRate, job.duration);
        }
      } finally {
        await decoder.close();
      }
      audio = new AudioBufferSource({ codec: 'aac', bitrate: 192000 });
      output.addAudioTrack(audio);
    }
    abortCheck(signal);
    await output.start();
    if (audio && buffer) {
      stage = '编码配乐';
      progress(2, stage);
      await abortable(audio.add(buffer), signal);
      audio.close();
      buffer = undefined;
    }
    const frames = Math.round(job.duration * 30);
    for (let frame = 0; frame < frames; frame++) {
      abortCheck(signal);
      if (scene.sceneError) throw new Error(scene.sceneError);
      stage = `渲染第 ${frame + 1}/${frames} 帧`;
      await abortable(api.seekAsync(frame / 30), signal);
      context.drawImage(original, 0, 0, canvas.width, canvas.height);
      if (frame === Math.min(90, frames - 1))
        cover = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.85)
        );
      stage = `编码第 ${frame + 1}/${frames} 帧`;
      await abortable(video.add(frame / 30, 1 / 30), signal);
      if (frame % 5 === 0) {
        progress(3 + (92 * frame) / frames, '正在本机生成视频');
        await yieldBrowserWork();
      }
    }
    abortCheck(signal);
    video.close();
    stage = '整理 MP4 文件';
    progress(97, '整理 MP4 文件');
    await abortable(output.finalize(), signal);
    const bytes = output.target.buffer;
    if (!bytes?.byteLength || !cover) throw new Error('视频编码未完成');
    const blob = new Blob([bytes], { type: 'video/mp4' });
    stage = '检查成片文件';
    progress(99, stage);
    await verifyBrowserVideo(blob, job.duration, job.options.music !== 'none', signal);
    return { blob, cover };
  } catch (error) {
    await cancel();
    if (signal.aborted) throw signal.reason;
    throw new BrowserExportError(stage, error);
  } finally {
    signal.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 1;
    api.finishExport?.();
  }
}

async function verifyBrowserVideo(
  blob: Blob,
  duration: number,
  withMusic: boolean,
  signal: AbortSignal
) {
  const { Input, BlobSource, MP4, VideoSampleSink, AudioSampleSink } =
    await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  let timer: ReturnType<typeof setTimeout>;
  const check = async () => {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('成片缺少视频轨道');
    const [actualDuration, width, height, codec] = await Promise.all([
      input.computeDuration(), track.getDisplayWidth(),
      track.getDisplayHeight(), track.getCodec()
    ]);
    if (Math.abs(actualDuration - duration) >= 0.2 ||
      width !== 1080 || height !== 1920 || codec !== 'avc')
      throw new Error('成片的时长、分辨率或格式不正确');
    // WebCodecs sampling works in background tabs; an HTMLVideoElement may
    // suspend its seek/decode events there and falsely reject a valid MP4.
    const sink = new VideoSampleSink(track);
    for (const time of [Math.min(1, duration / 2), Math.max(0, duration - 0.1)]) {
      const sample = await sink.getSample(time);
      if (!sample) throw new Error('成片画面无法解码');
      sample.close();
    }
    if (withMusic) {
      const audio = await input.getPrimaryAudioTrack();
      if (!audio || await audio.getCodec() !== 'aac')
        throw new Error('成片缺少 AAC 配乐轨道');
      const sample = await new AudioSampleSink(audio).getSample(Math.min(1, duration / 2));
      if (!sample) throw new Error('成片配乐无法解码');
      sample.close();
    }
  };
  try {
    await abortable(Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('成片解码检查超时')), 20000);
      })
    ]), signal);
  } finally {
    clearTimeout(timer!);
    input.dispose();
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
