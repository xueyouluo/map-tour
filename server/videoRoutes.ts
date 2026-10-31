import { sameOriginMutation } from './httpSecurity';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { projectRoot } from '../tools/video-preview/runtime.mjs';
import { browserSceneRuntimeUrl } from './browserScenes';
import { createPreviewImageCache } from './videoPreviewImages';
import {
  VideoJobs,
  VideoRequestError,
  getVideoCapabilities,
  VIDEO_UPLOAD_LIMIT
} from './videoJobs';

export function videoRouter(jobs: VideoJobs, authenticated = false) {
  const router = express.Router();
  const previewImage = createPreviewImageCache();
  if (authenticated) router.use(sameOriginMutation);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: VIDEO_UPLOAD_LIMIT, files: 1 }
  });
  let capabilities: ReturnType<typeof getVideoCapabilities> | undefined,
    checkedAt = 0;
  const available = () => {
    if (!capabilities || Date.now() - checkedAt > 60000) {
      capabilities = getVideoCapabilities();
      checkedAt = Date.now();
    }
    return capabilities;
  };
  const owner = (req: express.Request) =>
    (req as express.Request & { videoOwner: string }).videoOwner;
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (
      authenticated &&
      !['GET', 'HEAD'].includes(req.method) &&
      !req.currentUser
    )
      return res.status(401).json({ error: '请先登录，再生成或管理视频。' });
    if (req.method !== 'GET' && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          return res.status(403).json({ error: '请从当前页面操作。' });
      } catch {
        return res.sendStatus(403);
      }
    }
    const existing = req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('map_tour_video='))
      ?.split('=')[1];
    const token =
      existing && /^[a-f0-9]{48}$/.test(existing)
        ? existing
        : randomBytes(24).toString('hex');
    if (token !== existing)
      res.cookie('map_tour_video', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: 30 * 86400000,
        path: '/api/video'
      });
    (req as express.Request & { videoOwner: string }).videoOwner = createHash(
      'sha256'
    )
      .update(req.currentUser ? 'user:' + req.currentUser.id : token)
      .digest('hex');
    next();
  });
  router.get('/capabilities', (_req, res) => res.json(available()));
  router.get('/music', (_req, res) =>
    res.json({ tracks: jobs.musicLibrary.list() })
  );
  router.get('/music/:id/preview', (req, res) => {
    const track = jobs.musicLibrary.get(req.params.id);
    if (!track) throw new VideoRequestError('没有找到这首音乐。', 404);
    res.type('audio/mpeg').sendFile(track.previewFile);
  });
  router.use(
    '/runtime/three/0.186.1',
    express.static(path.join(projectRoot, 'node_modules/three'), {
      dotfiles: 'deny',
      index: false,
      setHeaders: (res) => { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); }
    })
  );
  router.post('/scenes', (req, res) => {
    const capability = available();
    if (!capability.available)
      throw new VideoRequestError(
        capability.reason || '地图素材服务暂不可用。',
        503
      );
    res.status(202).json({
      job: jobs.create(
        owner(req),
        req.body.itinerary,
        req.body.options,
        'scene'
      )
    });
  });
  router.get<{ id: string; '0': string }>('/jobs/:id/scene/*', async (req, res, next) => {
    try {
      const requested = req.params[0];
      const preview = /^preview-(atlas-[\w-]+\.jpg|detail-tiles\/[\w-]+\.jpg)$/.test(requested);
      // Resolve the original through owner and whitelist checks before converting.
      const source = jobs.sceneFile(owner(req), req.params.id,
        preview ? requested.slice('preview-'.length) : requested);
      const file = preview ? await previewImage(source) : source;
      if (file.endsWith('film.html')) {
        const job = jobs.get(owner(req), req.params.id);
        const runtime = job.browserAssets ? `<script type="module">window.browserSceneRuntime = import(${JSON.stringify(browserSceneRuntimeUrl())});window.browserSceneMusic = ${JSON.stringify({ options: job.options, url: job.options.music === 'none' || job.options.music === 'upbeat' || job.options.localMusic ? null : `/api/video/jobs/${job.id}/audio` }).replaceAll('<', String.fromCharCode(92) + 'u003c')};</script>` : '';
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        return res
          .type('html')
          .send(
            fs
              .readFileSync(file, 'utf8')
              .replaceAll('/_runtime/three/', '/api/video/runtime/three/0.186.1/').replace('<script type="module">', runtime + '<script type="module">').replace('src="music.wav"', job.browserAssets ? '' : 'src="music.wav"')
          );
      }
      // Revalidate against the authenticated route before reusing cached imagery.
      // Unlike max-age caching, switching accounts cannot bypass owner checks.
      if (/\.(jpg|png)$/.test(file))
        res.setHeader('Cache-Control', 'private, no-cache');
      res.sendFile(file);
    } catch (error) { next(error); }
  });
  router.get('/jobs/:id/audio-source', (req, res) => {
    // Authorize even on a browser cache hit; never publish a local file path.
    const audio = jobs.sceneAudio(owner(req), req.params.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ url: audio.url || `/api/video/jobs/${req.params.id}/audio`, sha256: audio.sha256 });
  });
  router.get('/jobs/:id/audio', (req, res) => {
    const audio = jobs.sceneAudio(owner(req), req.params.id);
    if (audio.url) return res.redirect(audio.url);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(audio.file!);
  });
  router.post('/jobs/:id/fallback', (req, res) => {
    if (!available().available || available().backgroundAvailable === false)
      throw new VideoRequestError('后台制作暂不可用，请稍后重试。', 503);
    res.status(202).json({ job: jobs.fallback(owner(req), req.params.id, req.body?.uploadId) });
  });
  router.get('/jobs', (req, res) =>
    res.json({
      jobs: jobs.list(
        owner(req),
        typeof req.query.itineraryId === 'string'
          ? req.query.itineraryId
          : undefined
      )
    })
  );
  router.get('/jobs/:id', (req, res) =>
    res.json({ job: jobs.get(owner(req), req.params.id) })
  );
  router.post('/jobs', (req, res) => {
    const capability = available();
    if (!capability.available || capability.backgroundAvailable === false)
      throw new VideoRequestError(
        capability.reason || '后台制作暂不可用，请使用本机导出。',
        503
      );
    const job = jobs.create(owner(req), req.body.itinerary, req.body.options);
    res.status(202).json({ job });
  });
  router.post('/jobs/:id/cancel', (req, res) =>
    res.json({ job: jobs.cancel(owner(req), req.params.id) })
  );
  router.post('/jobs/:id/retry', (req, res) => {
    const capability = available();
    if (!capability.available || capability.backgroundAvailable === false)
      throw new VideoRequestError(
        capability.reason || '后台制作暂不可用，请使用本机导出。',
        503
      );
    res.status(202).json({ job: jobs.retry(owner(req), req.params.id) });
  });
  router.delete('/jobs/:id', (req, res) => {
    jobs.remove(owner(req), req.params.id);
    res.sendStatus(204);
  });
  router.get('/jobs/:id/video', (req, res) =>
    res.sendFile(jobs.media(owner(req), req.params.id, 'video').file)
  );
  router.get('/jobs/:id/cover', (req, res) =>
    res.sendFile(jobs.media(owner(req), req.params.id, 'cover').file)
  );
  router.get('/jobs/:id/download', (req, res) => {
    const media = jobs.media(owner(req), req.params.id, 'video');
    res.download(
      media.file,
      `${media.title.replace(/[\\/\x00-\x1f]/g, '').slice(0, 80) || '旅程视频'}.mp4`
    );
  });
  router.post('/uploads', upload.single('music'), (req, res) => {
    if (!req.file) throw new VideoRequestError('请选择音乐文件。');
    res.status(201).json({
      upload: jobs.addUpload(owner(req), req.file.buffer, req.file.originalname)
    });
  });
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (error instanceof VideoRequestError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof multer.MulterError)
        return res
          .status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
          .json({ error: '音乐文件不能超过 25 MB，请重新选择。' });
      console.error(
        'Video service request failed:',
        error instanceof Error ? error.name : 'Unknown error'
      );
      res.status(500).json({ error: '视频服务暂时出了点问题，请稍后重试。' });
    }
  );
  return router;
}
