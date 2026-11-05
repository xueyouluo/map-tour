import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { mercator, inverseMercator } from '../../src/shared/videoPlan.ts';
import { runFile } from './runtime.mjs';
import { withMapCacheLease } from './cache.mjs';

async function cachedFile(target, producer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = target + '.lock',
    token = randomUUID(),
    owner = JSON.stringify({
      scope: 'map-tour-video-assets-v2',
      pid: process.pid,
      token
    });
  if (fs.existsSync(lock)) {
    const previous = fs.readFileSync(lock, 'utf8');
    try {
      const record = JSON.parse(previous);
      if (
        record.scope === 'map-tour-video-assets-v2' &&
        Number.isSafeInteger(record.pid) &&
        typeof record.token === 'string'
      ) {
        let alive = true;
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
        }
        if (!alive && fs.readFileSync(lock, 'utf8') === previous) {
          fs.unlinkSync(lock);
          const abandoned = target + '.' + record.token + '.tmp';
          if (/^[a-f0-9-]{36}$/.test(record.token) && fs.existsSync(abandoned))
            fs.unlinkSync(abandoned);
        }
      }
    } catch {
      /* Unknown locks belong to another task and are left untouched. */
    }
  }
  if (fs.existsSync(lock))
    throw new Error(
      `地图缓存正被其他任务占用，未覆盖：${path.basename(target)}`
    );
  if (fs.existsSync(target)) {
    if (!fs.existsSync(target + '.json'))
      throw new Error(`缓存缺少完成记录，未覆盖：${path.basename(target)}`);
    const metadata = JSON.parse(fs.readFileSync(target + '.json', 'utf8'));
    if (
      metadata.sha256 !==
      createHash('sha256').update(fs.readFileSync(target)).digest('hex')
    )
      throw new Error(`地图缓存校验失败，未覆盖：${path.basename(target)}`);
    try { const now = new Date(); fs.utimesSync(target, now, now); } catch { /* Access accounting must not break a readable cache hit. */ }
    return { cached: true };
  }
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch {
    throw new Error(
      `地图缓存正被其他任务占用，未覆盖：${path.basename(target)}`
    );
  }
  fs.writeFileSync(fd, owner);
  fs.closeSync(fd);
  const temporary = target + '.' + token + '.tmp';
  try {
    const metadata = await producer(temporary);
    fs.renameSync(temporary, target);
    fs.writeFileSync(
      target + '.json',
      JSON.stringify(
        {
          ...metadata,
          sha256: createHash('sha256')
            .update(fs.readFileSync(target))
            .digest('hex')
        },
        null,
        2
      )
    );
    return { cached: false, ...metadata };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === owner)
      fs.unlinkSync(lock);
  }
}

// Approximate inverse GCJ02 alignment for public WGS84 elevation data, matching the prototype.
function toWgs84(lng, lat) {
  if (lng < 72 || lng > 138 || lat < 0.8 || lat > 56) return [lng, lat];
  const forward = (a, b) => {
    const x = a - 105,
      y = b - 35;
    let dl =
      -100 +
      2 * x +
      3 * y +
      0.2 * y * y +
      0.1 * x * y +
      0.2 * Math.sqrt(Math.abs(x));
    dl +=
      ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) /
      3;
    dl +=
      ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
    dl +=
      ((160 * Math.sin((y / 12) * Math.PI) +
        320 * Math.sin((y * Math.PI) / 30)) *
        2) /
      3;
    let dn =
      300 +
      x +
      2 * y +
      0.1 * x * x +
      0.1 * x * y +
      0.1 * Math.sqrt(Math.abs(x));
    dn +=
      ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) /
      3;
    dn +=
      ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
    dn +=
      ((150 * Math.sin((x / 12) * Math.PI) +
        300 * Math.sin((x / 30) * Math.PI)) *
        2) /
      3;
    const rad = (b * Math.PI) / 180,
      magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
    dl =
      (dl * 180) /
      (((6378245 * (1 - 0.00669342162296594323)) / (magic * Math.sqrt(magic))) *
        Math.PI);
    dn = (dn * 180) / ((6378245 / Math.sqrt(magic)) * Math.cos(rad) * Math.PI);
    return [a + dn, b + dl];
  };
  let a = lng,
    b = lat;
  for (let i = 0; i < 4; i++) {
    const p = forward(a, b);
    a -= p[0] - lng;
    b -= p[1] - lat;
  }
  return [a, b];
}

export function prepareTerrain(plan, directory, cache, log, signal, policy) {
  return withMapCacheLease(cache, () => prepareTerrainAssets(plan, directory, cache, log, signal), policy);
}
async function prepareTerrainAssets(plan, directory, cache, log, signal) {
  const requests = [],
    jobs = new Map(),
    size = 257;
  for (const layer of plan.layers) {
    const zoom = Math.min(12, Math.max(5, Math.floor(layer.zoom) - 1));
    const center = mercator(layer.center),
      span = layer.width / (256 * 2 ** layer.zoom);
    const grid = [],
      scale = 256 * 2 ** zoom;
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++) {
        const gcj = inverseMercator([
          center[0] + (col / (size - 1) - 0.5) * span,
          center[1] + (row / (size - 1) - 0.5) * span
        ]);
        const p = mercator(toWgs84(...gcj)),
          pixel = [p[0] * scale - 0.5, p[1] * scale - 0.5];
        grid.push(pixel);
        for (const dx of [0, 1])
          for (const dy of [0, 1]) {
            const x = Math.floor((Math.floor(pixel[0]) + dx) / 256),
              y = Math.floor((Math.floor(pixel[1]) + dy) / 256);
            const id = `${zoom}-${x}-${y}`;
            jobs.set(id, { id, zoom, x, y });
          }
      }
    requests.push({ layer, zoom, grid });
  }
  if (jobs.size > 600)
    throw new Error('高程覆盖范围过大，本地预览上限为 600 张高程瓦片。');
  const tiles = new Map(),
    queue = [...jobs.values()];
  let next = 0,
    done = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: 4 }, async () => {
      while (next < queue.length) {
        signal?.throwIfAborted();
        const job = queue[next++],
          file = path.join(cache, 'dem', job.id + '.png');
        await cachedFile(file, async (temporary) => {
          const source = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${job.zoom}/${job.x}/${job.y}.png`;
          await runFile(
            'curl',
            [
              '-fL',
              '--retry',
              '2',
              '--max-time',
              '30',
              '-sS',
              source,
              '-o',
              temporary
            ],
            { signal }
          );
          const image = PNG.sync.read(fs.readFileSync(temporary));
          if (image.width !== 256 || image.height !== 256)
            throw new Error('高程瓦片尺寸不正确。');
          return { source };
        });
        tiles.set(job.id, PNG.sync.read(fs.readFileSync(file)));
        done++;
        if (done % 20 === 0 || done === queue.length)
          log(`高程 ${done}/${queue.length}`);
      }
    })
  );
  const failed = workers.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const read = (zoom, x, y) => {
    const tx = Math.floor(x / 256),
      ty = Math.floor(y / 256),
      image = tiles.get(`${zoom}-${tx}-${ty}`);
    const pixel = ((y - ty * 256) * 256 + x - tx * 256) * 4;
    return (
      image.data[pixel] * 256 +
      image.data[pixel + 1] +
      image.data[pixel + 2] / 256 -
      32768
    );
  };
  const layers = requests.map(({ layer, zoom, grid }) => {
    const heights = grid.map((p) => {
      const x = Math.floor(p[0]),
        y = Math.floor(p[1]),
        fx = p[0] - x,
        fy = p[1] - y;
      const height =
        read(zoom, x, y) * (1 - fx) * (1 - fy) +
        read(zoom, x + 1, y) * fx * (1 - fy) +
        read(zoom, x, y + 1) * (1 - fx) * fy +
        read(zoom, x + 1, y + 1) * fx * fy;
      return Math.round(height * 1000) / 1000;
    });
    return {
      id: layer.id,
      size,
      heightMeters: heights,
      minMeters: Math.min(...heights),
      maxMeters: Math.max(...heights),
      zoom
    };
  });
  fs.writeFileSync(
    path.join(directory, 'terrain-data.json'),
    JSON.stringify({
      layers,
      verticalExaggeration: 1,
      attribution: 'Mapzen / USGS SRTM, GMTED2010; NOAA ETOPO1',
      coordinateAlignment: 'Approximate GCJ02 to WGS84 display alignment'
    })
  );
  return { tiles: jobs.size, layers: layers.length };
}

function mapCaptureJobs(plan, details) {
  const jobs = [];
  for (const layer of plan.layers) {
    const center = mercator(layer.center),
      scale = 256 * 2 ** layer.zoom;
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 2; col++) {
        jobs.push({
          zoom: layer.zoom,
          center: inverseMercator([
            center[0] + ((col - 0.5) * 2048) / scale,
            center[1] + ((row - 0.5) * 2048) / scale
          ]),
          destination: `capture-tiles/${layer.id}-${row * 2 + col}.jpg`
        });
      }
  }
  for (const tile of details.tiles)
    jobs.push({ ...tile, destination: `detail-tiles/${tile.id}.jpg` });
  return jobs;
}

export function captureMaps(browser, url, plan, details, directory, cache, log, signal, policy) {
  return withMapCacheLease(cache, () => captureMapAssets(browser, url, plan, details, directory, cache, log, signal), policy);
}
async function captureMapAssets(
  browser,
  url,
  plan,
  details,
  directory,
  cache,
  log,
  signal
) {
  const jobs = mapCaptureJobs(plan, details),
    checks = [];
  let next = 0,
    done = 0,
    reused = 0;
  fs.mkdirSync(path.join(directory, 'capture-tiles'));
  fs.mkdirSync(path.join(directory, 'detail-tiles'));
  const results = await Promise.allSettled(
    [0, 1].map(async () => {
      const page = await browser.newPage({
        viewport: { width: 2176, height: 2176 },
        deviceScaleFactor: 1
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(url + '/capture.html');
        await page.waitForFunction(() => window.snapshotReady, null, {
          timeout: 60000
        });
        while (next < jobs.length) {
          signal?.throwIfAborted();
          const job = jobs[next++],
            key = createHash('sha256')
              .update(
                JSON.stringify([
                  'sdk-satellite-v1',
                  job.zoom,
                  job.center.map((n) => +n.toFixed(9)),
                  2048
                ])
              )
              .digest('hex');
          const file = path.join(cache, 'satellite', key + '.jpg');
          const result = await cachedFile(file, async (temporary) => {
            const actual = await page.evaluate(
              (p) => window.captureDetail(p),
              job
            );
            await page.waitForLoadState('networkidle', { timeout: 12000 });
            if (Math.abs(actual.zoom - job.zoom) > 0.001)
              throw new Error('卫星影像缩放层级不正确。');
            const expectedCenter = mercator(job.center),
              scale = 256 * 2 ** job.zoom;
            let cornerError = 0;
            for (const [index, corner] of actual.corners.entries()) {
              const p = mercator(corner),
                delta = index ? 1024 : -1024;
              cornerError = Math.max(
                cornerError,
                Math.abs((p[0] - expectedCenter[0]) * scale - delta),
                Math.abs((p[1] - expectedCenter[1]) * scale - delta)
              );
            }
            if (cornerError > 0.5)
              throw new Error(
                `卫星补片坐标偏差超过半个像素：${cornerError.toFixed(2)}`
              );
            await page.screenshot({
              path: temporary,
              type: 'jpeg',
              quality: 97,
              clip: { x: 64, y: 64, width: 2048, height: 2048 }
            });
            return {
              zoom: job.zoom,
              center: job.center,
              maxCornerErrorPixels: cornerError,
              source: 'AMap JS SDK Satellite layer'
            };
          });
          if (result.cached) reused++;
          fs.copyFileSync(file, path.join(directory, job.destination));
          checks.push({
            destination: job.destination,
            cached: result.cached,
            ...JSON.parse(fs.readFileSync(file + '.json', 'utf8'))
          });
          done++;
          if (done % 10 === 0 || done === jobs.length)
            log(`卫星底图 ${done}/${jobs.length}（缓存 ${reused}）`);
        }
        if (errors.length) throw new Error(errors.join('\n'));
      } finally {
        await page.close();
      }
    })
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  const page = await browser.newPage();
  try {
    await page.goto(url + '/film.html?planning');
    for (const layer of plan.layers) {
      const jpeg = await page.evaluate(async (id) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 4096;
        const ctx = canvas.getContext('2d');
        for (let i = 0; i < 4; i++) {
          const image = new Image();
          image.src = 'capture-tiles/' + id + '-' + i + '.jpg';
          await image.decode();
          ctx.drawImage(image, (i % 2) * 2048, Math.floor(i / 2) * 2048);
        }
        return canvas.toDataURL('image/jpeg', 0.97).split(',')[1];
      }, layer.id);
      fs.writeFileSync(
        path.join(directory, 'atlas-' + layer.id + '.jpg'),
        Buffer.from(jpeg, 'base64')
      );
    }
  } finally {
    await page.close();
  }
  const report = {
    patches: jobs.length,
    detailPatches: details.tiles.length,
    reused,
    checks,
    browserErrors: []
  };
  fs.writeFileSync(
    path.join(directory, 'assets-check.json'),
    JSON.stringify(report, null, 2)
  );
  return report;
}
