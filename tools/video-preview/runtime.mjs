import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import express from 'express';

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
export const browserFiles = path.join(
  projectRoot,
  'tools/video-preview/browser'
);

export function chromePath(override) {
  const candidates = [
    override,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found)
    throw new Error(
      '找不到 Chrome/Chromium，请通过 --chrome 指定已安装的可执行文件。'
    );
  return found;
}

export function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...options
    });
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr = (stderr + data).slice(-6000);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed (${code}): ${stderr}`))
    );
  });
}

export async function startPreviewServer(directory, environment = {}) {
  const app = express();
  app.get('/api/config', (_req, res) =>
    res.json({ amapKey: environment.AMAP_JSAPI_KEY })
  );
  app.use('/_AMapService', async (req, res) => {
    try {
      if (!environment.AMAP_SECURITY_JS_CODE)
        return res.status(503).send('Map capture is disabled');
      const relative = req.originalUrl.replace(/^\/_AMapService/, '');
      const url = new URL(relative, 'https://restapi.amap.com');
      if (url.origin !== 'https://restapi.amap.com') return res.sendStatus(400);
      url.searchParams.set('jscode', environment.AMAP_SECURITY_JS_CODE);
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30000) });
      res
        .status(upstream.status)
        .type(
          upstream.headers.get('content-type') || 'application/octet-stream'
        )
        .send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).send('Map capture upstream unavailable');
    }
  });
  app.use(
    '/_runtime/three',
    express.static(path.join(projectRoot, 'node_modules/three'))
  );
  app.get('/capture.html', (_req, res) =>
    res.sendFile(path.join(browserFiles, 'capture.html'))
  );
  app.get('/player', (_req, res) =>
    res
      .type('html')
      .send(
        '<!doctype html><link rel="icon" href="data:,"><video playsinline muted controls src="/preview.mp4"></video>'
      )
  );
  app.use(express.static(directory, { dotfiles: 'deny' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  };
}
