import { itineraryRouter } from './itineraryRoutes';
import { AuthStore } from './authStore';
import {
  authRouter,
  adminUsersRouter,
  loadSession,
  requireUser
} from './authRoutes';
import { HttpError, QuotaExceededError, sameOriginMutation } from './httpSecurity';
import { inferJourneyTransport } from './transportParser';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyAmapRequest } from './amapProxy';
import { hasConfiguredAiRuntime, parseItinerary } from './openaiParser';
import { ItineraryStore } from './storage';
import {
  VideoJobs,
  VideoRequestError,
  getVideoCapabilities
} from './videoJobs';
import { SettingsStore, settingsRouter } from './settings';
import { videoRouter } from './videoRoutes';
import { analyticsReportRouter, clientDiagnosticsRouter, logServerError } from './diagnostics';
import { AnalyticsStore, recordServerEvent, serverAttempt, useAnalyticsStore } from './analytics';
import { resolveJourneyMapStyle } from '../src/shared/mapTheme';
import { SUPPORTED_SERVICE_REGION } from '../src/shared/serviceRegion';

dotenv.config();
const serviceSettings = new SettingsStore();
serviceSettings.load();

const auth = new AuthStore();
const analytics = new AnalyticsStore();
useAnalyticsStore(analytics);
const app = express();
app.set('trust proxy', 'loopback');
const maxImageBytes = 8 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxImageBytes },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype.startsWith('image/')) {
      callback(null, true);
      return;
    }
    callback(new Error('只支持上传图片文件。'));
  }
});
const store = new ItineraryStore();
const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

app.use('/api/diagnostics', express.json({ limit: '16kb' }));
app.use(express.json({ limit: '2mb' }));
app.use(
  '/api',
  (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    next();
  },
  loadSession(auth)
);
app.use('/api/auth', authRouter(auth));
app.use('/api/admin/users', adminUsersRouter(auth));
app.use('/api/diagnostics', clientDiagnosticsRouter(undefined, analytics));
app.use('/api/admin/reports', analyticsReportRouter(analytics));
const access = (req: express.Request) => ({
  userId: req.currentUser!.id,
  admin: req.currentUser!.role === 'admin'
});
const checkQuota: express.RequestHandler = (req, res, next) => {
  const user = req.currentUser!;
  if (user.role !== 'admin' && user.itineraryCount >= user.itineraryLimit)
    return next(new QuotaExceededError());
  next();
};
const videoJobs = new VideoJobs();
app.use('/api/video', videoRouter(videoJobs, true));
app.use(
  '/api/settings',
  settingsRouter(serviceSettings, () => {
    const video = getVideoCapabilities();
    return {
      textReady: hasConfiguredAiRuntime(),
      imageReady: hasConfiguredAiRuntime(),
      mapReady: Boolean(
        process.env.AMAP_JSAPI_KEY && process.env.AMAP_SECURITY_JS_CODE
      ),
      videoReady: video.available,
      videoReason: video.reason,
      musicCount: videoJobs.musicLibrary.list().length
    };
  })
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const hasAiRuntime = hasConfiguredAiRuntime();
  res.json({
    amapKey: process.env.AMAP_JSAPI_KEY || '',
    supportedServiceRegion: SUPPORTED_SERVICE_REGION,
    amapMapStyle: resolveJourneyMapStyle(process.env.AMAP_MAP_STYLE_ID),
    hasAmapProxy: Boolean(process.env.AMAP_SECURITY_JS_CODE),
    hasAiRuntime,
    canManageSettings: req.currentUser?.role === 'admin',
    hasOpenAI: hasAiRuntime
  });
});

app.post(
  '/api/transport',
  requireUser,
  sameOriginMutation,
  async (req, res, next) => {
    try {
      res.json({ itinerary: await inferJourneyTransport(req.body.itinerary) });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/parse',
  requireUser,
  sameOriginMutation,
  checkQuota,
  upload.single('image'),
  async (req, res, next) => {
    const attempt = serverAttempt({ operation: 'itinerary.parse', userId: req.currentUser!.id,
      details: { inputKind: req.file ? 'image' : 'text' } });
    try {
      const file = req.file;
      const result = await parseItinerary({
        text: typeof req.body.text === 'string' ? req.body.text : '',
        image: file
          ? {
              buffer: file.buffer,
              mimeType: file.mimetype
            }
          : undefined
      });
      result.itinerary = await store.save(result.itinerary, access(req));
      attempt.finish('succeeded', undefined, { itineraryId: result.itinerary.id });
      res.json(result);
    } catch (error) {
      attempt.finish(error instanceof QuotaExceededError ? 'blocked' : 'failed', error instanceof QuotaExceededError ? undefined : error);
      next(error);
    }
  }
);

app.post(
  '/api/parse/stream',
  requireUser,
  sameOriginMutation,
  checkQuota,
  upload.single('image'),
  async (req, res) => {
    const attempt = serverAttempt({ operation: 'itinerary.parse', userId: req.currentUser!.id,
      details: { inputKind: req.file ? 'image' : 'text' } });
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: unknown) => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      const file = req.file;
      send({
        type: 'status',
        message: file
          ? '截图已提交，准备调用行程解析模型...'
          : '文字已提交，准备调用行程解析模型...'
      });
      const result = await parseItinerary(
        {
          text: typeof req.body.text === 'string' ? req.body.text : '',
          image: file
            ? {
                buffer: file.buffer,
                mimeType: file.mimetype
              }
            : undefined
        },
        {
          stream: true,
          onProgress: send
        }
      );
      result.itinerary = await store.save(result.itinerary, access(req));
      attempt.finish('succeeded', undefined, { itineraryId: result.itinerary.id });
      send({ type: 'result', result });
    } catch (error) {
      attempt.finish(error instanceof QuotaExceededError ? 'blocked' : 'failed', error instanceof QuotaExceededError ? undefined : error);
      if (error instanceof QuotaExceededError)
        recordServerEvent({ operation: 'quota.blocked', status: 'blocked', userId: req.currentUser?.id,
          userAgent: req.get('user-agent'), stage: '服务端额度检查', details: { action: 'parse', reason: 'limit_reached' } });
      logServerError(error, { operation: 'parse.stream', method: req.method, path: req.path, userId: req.currentUser?.id });
      send({
        type: 'error',
        error:
          error instanceof HttpError
            ? error.message
            : '行程解析失败，请稍后重试；如持续失败请联系管理员检查服务配置。'
      });
    } finally {
      res.end();
    }
  }
);

app.use('/api/itineraries', itineraryRouter(store));

app.use('/_AMapService', (req, res, next) => {
  proxyAmapRequest(req, res).catch(next);
});

if (process.env.NODE_ENV === 'production') {
  const distPath = path.resolve(projectRoot, 'dist');
  app.use(express.static(distPath));
  // Missing module URLs must fail instead of returning the SPA as JavaScript.
  app.get('/assets/*', (_req, res) => res.sendStatus(404));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (req.path.startsWith('/api/diagnostics') && error && typeof error === 'object' && 'type' in error) {
      if (error.type === 'entity.too.large') return res.sendStatus(413);
      if (error.type === 'entity.parse.failed') return res.sendStatus(400);
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `图片不能超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB。`
        });
        return;
      }
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof QuotaExceededError)
      recordServerEvent({ operation: 'quota.blocked', status: 'blocked', userId: req.currentUser?.id,
        userAgent: req.get('user-agent'), stage: '服务端额度检查',
        details: { action: req.path.startsWith('/api/parse') ? 'parse' : 'save', reason: 'limit_reached' } });
    if (error instanceof HttpError || error instanceof VideoRequestError) {
      if (error.status >= 500) logServerError(error, { method: req.method, path: req.path, userId: req.currentUser?.id });
      return res.status(error.status).json({ error: error.message });
    }
    logServerError(error, { method: req.method, path: req.path, userId: req.currentUser?.id });
    res.status(500).json({ error: '服务暂时出了点问题，请稍后重试。' });
  }
);

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Map tour API listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await videoJobs.close();
  store.close();
  auth.close();
  useAnalyticsStore(undefined);
  analytics.close();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
