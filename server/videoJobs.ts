import { journeySignature } from '../src/shared/journeySignature';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createVideoPlan, type VideoItinerary } from '../src/shared/videoPlan';
import type {
  VideoJob,
  VideoExportOptions,
  VideoCapabilities,
  VideoMusicUpload
} from '../src/shared/videoExport';
import { chromePath, projectRoot } from '../tools/video-preview/runtime.mjs';
import { writeBrowserScene } from './browserScenes';
import { MusicLibrary } from './musicLibrary';

export const VIDEO_UPLOAD_LIMIT = 25 * 1024 * 1024;
export const VIDEO_RETENTION_DAYS = 7;
const DAY = 86400000;
const activeStates = ['queued', 'running', 'cancelling'];

export class VideoRequestError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

interface JobRecord extends VideoJob {
  owner: string;
  fingerprint: string;
  snapshot: VideoItinerary;
  audioPath?: string;
}
interface UploadRecord extends VideoMusicUpload {
  owner: string;
  file: string;
  sha256: string;
  createdAt: string;
}
interface RunContext {
  signal: AbortSignal;
  progress: (value: number, stage: string) => void;
}
type Runner = (job: JobRecord, context: RunContext) => Promise<void>;

export function getVideoCapabilities(): VideoCapabilities {
  const base = {
    maxUploadBytes: VIDEO_UPLOAD_LIMIT,
    retentionDays: VIDEO_RETENTION_DAYS
  };
  if (process.env.VIDEO_EXPORT_ENABLED === 'false')
    return { ...base, available: false, reason: '视频生成功能暂未开放。' };
  if (!process.env.AMAP_JSAPI_KEY || !process.env.AMAP_SECURITY_JS_CODE)
    return {
      ...base,
      available: false,
      reason: '视频服务尚未准备好地图资源，请稍后再试。'
    };
  try {
    chromePath(process.env.VIDEO_CHROME_PATH);
    for (const binary of ['ffmpeg', 'ffprobe', 'curl'])
      execFileSync(binary, [binary === 'curl' ? '--version' : '-version'], {
        stdio: 'ignore',
        timeout: 5000
      });
    return { ...base, available: true, backgroundAvailable: true };
  } catch {
    return {
      ...base,
      available: true, backgroundAvailable: false
    };
  }
}

export class VideoJobs {
  private db: DatabaseSync;
  private token = randomUUID();
  private processing?: Promise<void>;
  private active?: { id: string; controller: AbortController };
  private stopping = false;
  private cleanupTimer: ReturnType<typeof setInterval>;
  private runner: Runner;

  constructor(
    public readonly root = path.resolve(
      process.env.VIDEO_EXPORT_DIR || 'data/video-exports'
    ),
    runner?: Runner,
    public readonly musicLibrary = new MusicLibrary()
  ) {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'jobs.sqlite'));
    this.db.exec(`pragma journal_mode=WAL;
      create table if not exists jobs(id text primary key, owner text not null, state text not null, fingerprint text not null, created_at text not null, payload text not null);
      create index if not exists jobs_owner on jobs(owner, created_at);
      create unique index if not exists jobs_active_dedup on jobs(owner,fingerprint) where state in ('queued','running','cancelling');
      create table if not exists uploads(id text primary key, owner text not null, payload text not null);
      create table if not exists worker(id integer primary key check(id=1), pid integer not null, token text not null);`);
    this.db.exec('begin immediate');
    try {
      const worker = this.db
        .prepare('select pid from worker where id=1')
        .get() as { pid: number } | undefined;
      if (worker && processIsAlive(worker.pid))
        throw new VideoRequestError('视频服务已在另一个进程运行。', 503);
      this.db
        .prepare('insert or replace into worker values(1,?,?)')
        .run(process.pid, this.token);
      this.db.exec('commit');
    } catch (error) {
      this.db.exec('rollback');
      this.db.close();
      throw error;
    }
    for (const job of this.records().filter((j) =>
      ['running', 'cancelling'].includes(j.state)
    )) {
      this.save({
        ...job,
        state: 'failed',
        stage: '生成已中断',
        error: '生成服务重启，视频没有完成。可以重新生成。',
        finishedAt: new Date().toISOString()
      });
    }
    this.runner = runner || this.runProcess.bind(this);
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600000);
    this.cleanupTimer.unref();
    this.kick();
  }

  private records(): JobRecord[] {
    return (
      this.db
        .prepare('select payload from jobs order by created_at asc, rowid asc')
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  private save(job: JobRecord) {
    this.db
      .prepare(
        'insert into jobs values(?,?,?,?,?,?) on conflict(id) do update set state=excluded.state,payload=excluded.payload'
      )
      .run(
        job.id,
        job.owner,
        job.state,
        job.fingerprint,
        job.createdAt,
        JSON.stringify(job)
      );
  }
  private record(owner: string, id: string): JobRecord {
    const row = this.db
      .prepare('select payload from jobs where id=? and owner=?')
      .get(id, owner) as { payload: string } | undefined;
    if (!row) throw new VideoRequestError('没有找到这个视频。', 404);
    return JSON.parse(row.payload);
  }
  private publicJob(job: JobRecord): VideoJob {
    const {
      owner: _owner,
      snapshot: _snapshot,
      audioPath: _audioPath,
      fingerprint: _fingerprint,
      ...result
    } = job;
    (result as VideoJob).journeySignature = journeySignature(job.snapshot);
    result.queuePosition =
      job.state === 'queued'
        ? this.records()
            .filter((j) => activeStates.includes(j.state))
            .findIndex((j) => j.id === job.id)
        : 0;
    if (job.state === 'completed') {
      if (job.kind === 'scene') {
        result.browserAssets = true;
        result.sceneUrl = `/api/video/jobs/${job.id}/scene/film.html?embedded`;
      } else {
        result.videoUrl = `/api/video/jobs/${job.id}/video`;
        result.downloadUrl = `/api/video/jobs/${job.id}/download`;
        result.coverUrl = `/api/video/jobs/${job.id}/cover`;
      }
    }
    return result;
  }
  list(owner: string, itineraryId?: string): VideoJob[] {
    this.cleanup();
    return this.records()
      .filter(
        (j) =>
          j.owner === owner && (!itineraryId || j.itineraryId === itineraryId)
      )
      .reverse()
      .slice(0, 40)
      .map((j) => this.publicJob(j));
  }
  get(owner: string, id: string): VideoJob {
    return this.publicJob(this.record(owner, id));
  }

  create(
    owner: string,
    source: VideoItinerary,
    raw: unknown,
    kind?: 'scene'
  ): VideoJob {
    if (this.stopping)
      throw new VideoRequestError('视频服务正在重启，请稍后再试。', 503);
    const storage = fs.statfsSync(this.root);
    if (storage.bavail * storage.bsize < (kind === 'scene' ? 20 * 1024 ** 2 : 2 * 1024 ** 3))
      throw new VideoRequestError(
        '视频服务可用空间不足，暂时无法制作新视频。已有视频仍可下载。',
        507
      );
    const options = parseExportOptions(raw, kind === 'scene');
    let plan;
    try {
      plan = createVideoPlan(source, {
        durationSeconds: options.durationSeconds
      });
    } catch (error) {
      throw new VideoRequestError(
        error instanceof Error ? error.message : '行程数据无法生成视频。'
      );
    }
    if (
      plan.stops.length > 150 ||
      plan.segments.reduce((n, s) => n + s.path.length, 0) > 150000
    )
      throw new VideoRequestError('行程过大，请减少地点后再生成。');
    let audioPath: string | undefined,
      musicName = options.music === 'upbeat' ? '轻快出发' : '无配乐',
      musicHash: string = options.music;
    if (options.music === 'upload' && options.localMusic) {
      if (options.localMusic.duration < plan.duration) throw new VideoRequestError('音乐短于视频，请选择其他音乐。');
      musicName = options.localMusic.name;
      musicHash = options.uploadId!;
    } else if (options.music === 'upload') {
      const upload = this.upload(owner, options.uploadId!);
      if (!fs.existsSync(upload.file))
        throw new VideoRequestError('音乐已过期，请重新上传。');
      if (upload.duration < plan.duration)
        throw new VideoRequestError(
          `音乐只有 ${Math.floor(upload.duration)} 秒，短于视频的 ${Math.ceil(plan.duration)} 秒，请换一首或缩短视频。`
        );
      audioPath = upload.file;
      musicName = upload.name;
      musicHash = upload.sha256;
    }
    if (options.music === 'library') {
      const track = this.musicLibrary.get(options.trackId!);
      if (!track)
        throw new VideoRequestError('这首内置音乐暂不可用，请重新选择。');
      if (track.duration < plan.duration)
        throw new VideoRequestError(
          `这首音乐只有 ${Math.floor(track.duration)} 秒，请缩短视频或选择另一首音乐。`
        );
      audioPath = track.file;
      musicName = `${track.title} ${track.version}`;
      musicHash = track.sha256;
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          source,
          options,
          musicHash,
          kind === 'scene' ? 'browser-direct-v1' : 'video',
          plan.duration,
          plan.events
        ])
      )
      .update(
        kind === 'scene'
          ? fs.readFileSync(
              path.join(projectRoot, 'tools/video-preview/browser/film.js')
            )
          : ''
      )
      .update(
        kind === 'scene'
          ? fs.readFileSync(
              path.join(projectRoot, 'tools/video-preview/browser/film.html')
            )
          : ''
      )
      .update(
        kind === 'scene'
          ? fs.readFileSync(
              path.join(projectRoot, 'tools/video-preview/browser/vehicles.js')
            )
          : ''
      )
      .update(
        kind === 'scene'
          ? fs.readFileSync(
              path.join(projectRoot, 'tools/video-preview/browser/playback.js')
            )
          : ''
      )
      .digest('hex');
    const active = this.records().filter((j) => activeStates.includes(j.state));
    const duplicate = active.find(
      (j) => j.owner === owner && j.fingerprint === fingerprint
    );
    if (duplicate) return this.publicJob(duplicate);
    if (kind === 'scene') {
      const prepared = this.records().find(
        (j) =>
          j.owner === owner &&
          j.fingerprint === fingerprint &&
          j.state === 'completed' &&
          j.expiresAt &&
          Date.parse(j.expiresAt) > Date.now() &&
          [j.browserAssets ? 'manifest.json' : 'assets-check.json', 'film.html', 'plan.json', 'vehicles.js', 'attribution.png'].every(file => fs.existsSync(path.join(this.directory(j.id), 'render', file)))
      );
      if (prepared) return this.publicJob(prepared);
    }
    if (
      active.filter((j) => j.owner === owner).length >= 2 ||
      active.length >= 20
    )
      throw new VideoRequestError(
        '正在制作的视频较多，请等当前视频完成后再试。',
        429
      );
    const id = randomUUID(),
      directory = this.directory(id);
    fs.mkdirSync(directory);
    const job: JobRecord = {
      ...(kind ? { kind, browserAssets: true } : {}),
      id,
      owner,
      fingerprint,
      snapshot: structuredClone(source),
      audioPath,
      itineraryId: source.id,
      title: plan.title,
      state: 'queued',
      progress: 0,
      stage: '等待制作',
      queuePosition: 0,
      createdAt: new Date().toISOString(),
      duration: plan.duration,
      days: plan.days.length,
      stops: plan.stops.length,
      options,
      musicName,
      warnings: plan.warnings
    };
    fs.writeFileSync(
      path.join(directory, 'input.json'),
      JSON.stringify(job.snapshot)
    );
    if (kind === 'scene') {
      writeBrowserScene(path.join(directory, 'render'), plan);
      Object.assign(job, { state: 'completed', progress: 100, stage: '浏览器场景已准备好',
        finishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + VIDEO_RETENTION_DAYS * DAY).toISOString() });
    }
    this.save(job);
    if (kind !== 'scene') this.kick();
    return this.publicJob(job);
  }

  cancel(owner: string, id: string): VideoJob {
    const job = this.record(owner, id);
    if (job.state === 'queued')
      this.save({
        ...job,
        state: 'cancelled',
        stage: '已取消',
        finishedAt: new Date().toISOString()
      });
    if (job.state === 'running') {
      this.save({ ...job, state: 'cancelling', stage: '正在取消' });
      this.active?.controller.abort();
    }
    return this.get(owner, id);
  }
  retry(owner: string, id: string): VideoJob {
    const job = this.record(owner, id);
    if (!['failed', 'cancelled'].includes(job.state))
      throw new VideoRequestError('这个视频不需要重试。');
    return this.create(owner, job.snapshot, job.options, job.kind);
  }
  fallback(owner: string, id: string, uploadId?: string): VideoJob {
    const job = this.record(owner, id);
    const options = { ...job.options };
    if (options.localMusic) {
      if (!uploadId) throw new VideoRequestError('后台制作前请先上传所选音乐。');
      delete options.localMusic;
      options.uploadId = uploadId;
    }
    return this.create(owner, job.snapshot, options);
  }
  sceneFile(owner: string, id: string, name: string) {
    const job = this.record(owner, id);
    if (job.kind !== 'scene' || job.state !== 'completed')
      throw new VideoRequestError('场景尚未准备好。', 409);
    if (!job.expiresAt || Date.parse(job.expiresAt) < Date.now())
      throw new VideoRequestError('场景已过期，请重新预览。', 410);
    if (
      !/^(film\.(html|js)|playback\.js|vehicles\.js|plan\.json|terrain-data\.json|detail-plan\.json|attribution\.png|music\.wav|atlas-[\w-]+\.jpg|detail-tiles\/[\w-]+\.jpg)$/.test(
        name
      )
    )
      throw new VideoRequestError('没有找到这个素材。', 404);
    // Existing prepared previews receive playback fixes without regenerating maps.
    // Owner and expiry checks above still apply to every runtime request.
    const file = ['film.html', 'film.js', 'playback.js'].includes(name)
      ? path.join(projectRoot, 'tools/video-preview/browser', name)
      : path.join(this.directory(id), 'render', name);
    if (!fs.existsSync(file)) throw new VideoRequestError('素材不可用。', 404);
    return file;
  }
  sceneAudio(owner: string, id: string): { file?: string; url?: string; sha256?: string } {
    const job = this.record(owner, id);
    if (job.kind !== 'scene' || job.state !== 'completed') throw new VideoRequestError('场景尚未准备好。', 409);
    if (!job.expiresAt || Date.parse(job.expiresAt) < Date.now()) throw new VideoRequestError('场景已过期。', 410);
    if (job.options.music === 'library') {
      const track = this.musicLibrary.get(job.options.trackId!);
      if (!track) throw new VideoRequestError('音乐不可用。', 404);
      return { ...(track.audioUrl ? { url: track.audioUrl } : { file: track.file }), sha256: track.sha256 };
    }
    if (job.options.music === 'upload' && !job.options.localMusic && job.audioPath && fs.existsSync(job.audioPath)) return { file: job.audioPath };
    throw new VideoRequestError('这首配乐在浏览器本地读取。', 404);
  }
  remove(owner: string, id: string) {
    const job = this.record(owner, id);
    if (activeStates.includes(job.state))
      throw new VideoRequestError('请先取消正在制作的视频。');
    this.db.prepare('delete from jobs where id=? and owner=?').run(id, owner);
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }
  media(owner: string, id: string, kind: 'video' | 'cover') {
    const job = this.record(owner, id);
    if (job.state !== 'completed')
      throw new VideoRequestError('视频还没有制作完成。', 409);
    if (!job.expiresAt || Date.parse(job.expiresAt) < Date.now())
      throw new VideoRequestError('视频已过期，请重新制作。', 410);
    const file = path.join(
      this.directory(id),
      'render',
      kind === 'video' ? 'preview.mp4' : 'cover.png'
    );
    if (!fs.existsSync(file))
      throw new VideoRequestError('视频文件不可用，请重新制作。', 410);
    return { file, title: job.title };
  }
  directory(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new VideoRequestError('没有找到这个视频。', 404);
    return path.join(this.root, 'jobs', id);
  }

  addUpload(owner: string, bytes: Buffer, name: string): VideoMusicUpload {
    if (!bytes.length || bytes.length > VIDEO_UPLOAD_LIMIT)
      throw new VideoRequestError('音乐文件不能超过 25 MB。', 413);
    const id = randomUUID(),
      file = path.join(this.root, 'uploads', id + '.audio');
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    try {
      const metadata = JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            'mp3,mov,wav,ogg,flac,aac,aiff',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            file
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
      );
      const duration = Number(metadata.format?.duration);
      if (
        !metadata.streams.some(
          (s: { codec_type: string }) => s.codec_type === 'audio'
        ) ||
        metadata.streams.some(
          (s: {
            codec_type: string;
            disposition?: { attached_pic?: number };
          }) => s.codec_type === 'video' && !s.disposition?.attached_pic
        ) ||
        !Number.isFinite(duration) ||
        duration < 5 ||
        duration > 1200
      )
        throw new Error('Invalid audio');
      const upload: UploadRecord = {
        id,
        owner,
        file,
        name: name.replace(/[\x00-\x1f]/g, '').slice(0, 100) || '我的配乐',
        duration,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt: new Date().toISOString()
      };
      this.db
        .prepare('insert into uploads values(?,?,?)')
        .run(id, owner, JSON.stringify(upload));
      return { id, name: upload.name, duration, bytes: bytes.length };
    } catch {
      fs.unlinkSync(file);
      throw new VideoRequestError(
        '无法读取这首音乐。请选择 5 秒到 20 分钟的 MP3、M4A、WAV 或 OGG 音频。'
      );
    }
  }
  private upload(owner: string, id: string): UploadRecord {
    const row = this.db
      .prepare('select payload from uploads where id=? and owner=?')
      .get(id, owner) as { payload: string } | undefined;
    if (!row) throw new VideoRequestError('音乐不存在或已过期，请重新上传。');
    return JSON.parse(row.payload);
  }

  private kick() {
    if (!this.processing && !this.stopping)
      this.processing = Promise.resolve()
        .then(() => this.processQueue())
        .finally(() => {
          this.processing = undefined;
          if (!this.stopping && this.records().some(job => job.state === 'queued')) this.kick();
        });
  }
  private async processQueue() {
    while (!this.stopping) {
      const queued = this.records().find((j) => j.state === 'queued');
      if (!queued) return;
      const controller = new AbortController();
      this.active = { id: queued.id, controller };
      this.save({
        ...queued,
        state: 'running',
        stage: '准备旅程',
        progress: 2
      });
      try {
        await this.runner(queued, {
          signal: controller.signal,
          progress: (value, stage) => {
            const current = this.record(queued.owner, queued.id);
            if (current.state === 'running')
              this.save({
                ...current,
                progress: Math.max(current.progress, Math.min(98, value)),
                stage
              });
          }
        });
        const current = this.record(queued.owner, queued.id);
        if (controller.signal.aborted) throw new Error('Cancelled');
        const render = path.join(this.directory(queued.id), 'render');
        let bytes: number | undefined;
        if (queued.kind === 'scene') {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(render, 'manifest.json'), 'utf8')
          );
          const check = JSON.parse(
            fs.readFileSync(path.join(render, 'assets-check.json'), 'utf8')
          );
          if (
            manifest.status !== 'prepared' ||
            !(check.patches > 0) ||
            !Array.isArray(check.checks) ||
            check.checks.length !== check.patches ||
            ![
              'film.html',
              'film.js',
              'vehicles.js',
              'plan.json',
              'terrain-data.json',
              'detail-plan.json'
            ].every((f) => fs.existsSync(path.join(render, f)))
          )
            throw new Error('Scene preparation failed');
        } else {
          const verification = JSON.parse(
            fs.readFileSync(path.join(render, 'verification.json'), 'utf8')
          );
          if (
            !verification.fullDecodePassed ||
            verification.frames < 1 ||
            !verification.playback?.time
          )
            throw new Error('Verification failed');
          bytes = fs.statSync(path.join(render, 'preview.mp4')).size;
        }
        this.save({
          ...current,
          state: 'completed',
          stage: queued.kind === 'scene' ? '预览已准备好' : '制作完成',
          progress: 100,
          bytes,
          finishedAt: new Date().toISOString(),
          expiresAt: new Date(
            Date.now() + VIDEO_RETENTION_DAYS * DAY
          ).toISOString()
        });
      } catch (error) {
        const current = this.record(queued.owner, queued.id);
        const cancelled = controller.signal.aborted && !this.stopping;
        this.save({
          ...current,
          state: cancelled ? 'cancelled' : 'failed',
          stage: cancelled ? '已取消' : '制作未完成',
          error: cancelled
            ? undefined
            : this.stopping
              ? '生成服务重启，视频没有完成。可以重新生成。'
              : publicRenderError(error),
          finishedAt: new Date().toISOString()
        });
      } finally {
        this.active = undefined;
      }
    }
  }

  private async runProcess(job: JobRecord, context: RunContext) {
    const directory = this.directory(job.id);
    const music = job.audioPath;
    const args = [
      '--import',
      'tsx',
      '--no-warnings',
      path.join(projectRoot, 'tools/video-preview/cli.mjs'),
      '--input',
      path.join(directory, 'input.json'),
      '--out',
      path.join(directory, 'render'),
      '--cache-dir',
      path.resolve(
        process.env.VIDEO_CACHE_DIR || path.join(this.root, 'cache')
      ),
      '--events',
      '--managed'
    ];
    if (job.options.durationSeconds)
      args.push('--duration', String(job.options.durationSeconds));
    if (music) args.push('--music', music);
    if (job.options.music === 'upbeat') args.push('--builtin-music');
    if (job.kind === 'scene') args.push('--assets-only');
    if (process.env.VIDEO_CHROME_PATH)
      args.push('--chrome', process.env.VIDEO_CHROME_PATH);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let buffer = '',
        logs = '',
        forceTimer: ReturnType<typeof setTimeout> | undefined,
        settled = false;
      const terminate = () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null)
          return;
        try {
          child.kill('SIGTERM');
        } catch {
          /* Already closed. */
        }
        forceTimer = setTimeout(() => {
          if (
            !child.pid ||
            child.exitCode !== null ||
            child.signalCode !== null
          )
            return;
          try {
            if (process.platform !== 'win32')
              process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            /* Already closed. */
          }
        }, 20000);
        forceTimer.unref();
      };
      context.signal.addEventListener('abort', terminate, { once: true });
      const timeout = setTimeout(() => {
        logs += '\nRender timed out';
        terminate();
      }, 30 * 60000);
      timeout.unref();
      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          logs = (logs + line + '\n').slice(-12000);
          try {
            const event = JSON.parse(line);
            if (
              event.type === 'progress' &&
              Number.isFinite(event.progress) &&
              typeof event.stage === 'string'
            )
              context.progress(event.progress, event.stage.slice(0, 80));
          } catch {
            /* Non-event log. */
          }
        }
      });
      child.stderr.on('data', (data) => {
        logs = (logs + data.toString()).slice(-12000);
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        context.signal.removeEventListener('abort', terminate);
        fs.writeFileSync(path.join(directory, 'render.log'), redact(logs));
        error ? reject(error) : resolve();
      };
      child.once('error', (error) => finish(error));
      child.once('close', (code) =>
        finish(code === 0 ? undefined : new Error(redact(logs).slice(-6000)))
      );
      if (context.signal.aborted) terminate();
    });
  }

  cleanup(now = Date.now()) {
    const jobs = this.records();
    for (const job of jobs)
      if (
        !activeStates.includes(job.state) &&
        now - Date.parse(job.finishedAt || job.createdAt) >
          VIDEO_RETENTION_DAYS * DAY
      )
        this.remove(job.owner, job.id);
    const uploads = this.db.prepare('select payload from uploads').all() as {
      payload: string;
    }[];
    for (const row of uploads) {
      const upload: UploadRecord = JSON.parse(row.payload);
      if (
        now - Date.parse(upload.createdAt) > VIDEO_RETENTION_DAYS * DAY &&
        !jobs.some(
          (j) =>
            activeStates.includes(j.state) && j.options.uploadId === upload.id
        )
      ) {
        this.db.prepare('delete from uploads where id=?').run(upload.id);
        fs.rmSync(upload.file, { force: true });
      }
    }
  }
  async close() {
    this.stopping = true;
    clearInterval(this.cleanupTimer);
    this.active?.controller.abort();
    await this.processing;
    this.db.prepare('delete from worker where token=?').run(this.token);
    this.db.close();
  }
}

export function parseExportOptions(raw: unknown, allowLocalMusic = false): VideoExportOptions {
  const data = raw as Record<string, unknown>;
  if (
    !data ||
    !['upbeat', 'library', 'none', 'upload'].includes(String(data.music))
  )
    throw new VideoRequestError('请选择配乐方式。');
  if (
    data.durationSeconds !== undefined &&
    (typeof data.durationSeconds !== 'number' ||
      !Number.isFinite(data.durationSeconds) ||
      data.durationSeconds < 10 ||
      data.durationSeconds > 180)
  )
    throw new VideoRequestError('视频时长需要在 10 到 180 秒之间。');
  if (
    data.music === 'upload' &&
    (typeof data.uploadId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(data.uploadId))
  )
    throw new VideoRequestError('请先上传音乐。');
  if (
    data.music === 'library' &&
    (typeof data.trackId !== 'string' ||
      !/^[a-z0-9-]{1,80}$/.test(data.trackId))
  )
    throw new VideoRequestError('请选择一首内置音乐。');
  let localMusic: VideoExportOptions['localMusic'];
  if (data.localMusic !== undefined) {
    const local = data.localMusic as Record<string, unknown>;
    if (!allowLocalMusic || data.music !== 'upload' || !local || typeof local.name !== 'string' || !local.name.trim() || local.name.length > 160 ||
      typeof local.duration !== 'number' || !Number.isFinite(local.duration) || local.duration < 1 || local.duration > 86400)
      throw new VideoRequestError('本地音乐信息无效，请重新选择。');
    localMusic = { name: local.name, duration: local.duration };
  }
  return {
    ...(localMusic ? { localMusic } : {}),
    music: data.music as VideoExportOptions['music'],
    durationSeconds: data.durationSeconds as number | undefined,
    ...(data.music === 'upload' ? { uploadId: data.uploadId as string } : {}),
    ...(data.music === 'library' ? { trackId: data.trackId as string } : {})
  };
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function redact(text: string) {
  for (const [key, value] of Object.entries(process.env))
    if (/key|token|secret/i.test(key) && value && value.length > 5)
      text = text.replaceAll(value, '[redacted]');
  return text;
}
function publicRenderError(error: unknown) {
  const text = error instanceof Error ? error.message : '';
  if (/地图缓存正被|cache.*busy/i.test(text))
    return '地图资源正在准备，请稍后重试。';
  if (/底图超过|高清底图过多|覆盖范围过大/.test(text))
    return '路线覆盖范围较大，请减少地点或拆分行程后再试。';
  if (/音乐短于|音轨/.test(text)) return '配乐处理失败，请换一首音乐后再试。';
  if (/timed out|timeout|超时|Map capture|curl failed|net::/i.test(text))
    return '地图资源加载超时，请稍后重试。已生成的视频不受影响。';
  return '这次制作没有完成，请重试。若仍然失败，可以减少地点或更换音乐。';
}
