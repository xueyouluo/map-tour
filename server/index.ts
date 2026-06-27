import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyAmapRequest } from './amapProxy';
import { hasConfiguredAiRuntime, parseItinerary } from './openaiParser';
import { ItineraryStore } from './storage';
import type { Itinerary } from '../src/shared/itinerary';

dotenv.config();

const app = express();
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

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  const hasAiRuntime = hasConfiguredAiRuntime();
  res.json({
    amapKey: process.env.AMAP_JSAPI_KEY || '',
    hasAmapProxy: Boolean(process.env.AMAP_SECURITY_JS_CODE),
    hasAiRuntime,
    hasOpenAI: hasAiRuntime
  });
});

app.post('/api/parse', upload.single('image'), async (req, res, next) => {
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
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/parse/stream', upload.single('image'), async (req, res) => {
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
      message: file ? '图片已上传到本地服务，准备调用视觉理解模型...' : '文本已提交，准备调用文本解析模型...'
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
    send({ type: 'result', result });
  } catch (error) {
    send({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown server error'
    });
  } finally {
    res.end();
  }
});

app.post('/api/itineraries', async (req, res, next) => {
  try {
    const itinerary = req.body as Itinerary;
    if (!itinerary?.days || !Array.isArray(itinerary.days)) {
      res.status(400).json({ error: 'Invalid itinerary payload.' });
      return;
    }

    const record = await store.save(itinerary);
    res.json({
      itinerary: record,
      shareUrl: `/s/${record.id}`
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/itineraries/:id', async (req, res, next) => {
  try {
    const itinerary = await store.get(req.params.id);
    if (!itinerary) {
      res.status(404).json({ error: 'Itinerary not found.' });
      return;
    }
    res.json({ itinerary });
  } catch (error) {
    next(error);
  }
});

app.use('/_AMapService', (req, res, next) => {
  proxyAmapRequest(req, res).catch(next);
});

if (process.env.NODE_ENV === 'production') {
  const distPath = path.resolve(projectRoot, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `图片不能超过 ${Math.round(maxImageBytes / 1024 / 1024)}MB。` });
      return;
    }
    res.status(400).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : 'Unknown server error';
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Map tour API listening on http://127.0.0.1:${port}`);
});
