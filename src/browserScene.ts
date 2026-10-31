import { loadAMap } from './amap';
import { cachedImage, readCachedImage } from './browserAssetCache';
import { terrainRequests, sampleTerrarium } from './shared/terrain';
import { createDetailPlan, mercator, inverseMercator, type VideoPlan, type VideoLayer } from './shared/videoPlan';
import type { Coordinate } from './shared/itinerary';

export { createDetailPlan };
export async function createBrowserSceneAssets(plan: VideoPlan, status: (text: string) => void) {
  let disposed = false;
  let map: any;
  let container: HTMLDivElement | undefined;
  let AMap: any;
  let serial: Promise<unknown> = Promise.resolve();
  let library: Promise<any> | undefined;
  const pending = new Map<string, Promise<Blob>>();
  let captures = 0;
  const sdk = () => library ||= fetch('/api/config').then(async (r) => {
    if (!r.ok) throw new Error('地图配置加载失败');
    const config = await r.json();
    return loadAMap(config.amapKey, config.hasAmapProxy);
  });
  async function capture(center: Coordinate, zoom: number, pixels: number): Promise<Blob> {
    if (disposed) throw new Error('地图预览已关闭');
    AMap ||= await sdk();
    // A fresh capture surface gives a reliable initial tile-complete event and
    // releases the previous WebGL backing store, including high-DPI mobile buffers.
    map?.destroy();
    container?.remove();
    container = undefined;
    const edge = pixels + 128;
    let fresh = false;
    if (!container) {
      fresh = true;
      container = document.createElement('div');
      container.style.cssText = `position:fixed;left:-12000px;top:0;pointer-events:none;width:${edge}px;height:${edge}px;`;
      document.body.append(container);
      map = new AMap.Map(container, {
        viewMode: '3D', zoom, center,
        layers: [new AMap.TileLayer.Satellite()], animateEnable: false,
        showLabel: false, showIndoorMap: false,
        WebGLParams: { preserveDrawingBuffer: true }
      });
    }

    status(`浏览器直连加载卫星图 · 已准备 ${captures} 张`);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); map.off('complete', complete); };
      const complete = () => { cleanup(); resolve(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('高德卫星图加载超时，请检查网络后重试。')); }, 25000);
      map.on('complete', complete);
      if (!fresh) {
        container!.style.width = container!.style.height = edge + 'px';
        map.resize();
        map.setZoomAndCenter(zoom, center, true);
      }
    });
    if (disposed) throw new Error('地图预览已关闭');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const actual = map.getCenter();
    const expected = mercator(center), point = mercator([actual.lng, actual.lat]);
    if (map.getZoom() !== zoom || Math.hypot(point[0] - expected[0], point[1] - expected[1]) * 256 * 2 ** zoom > 0.5)
      throw new Error('地图坐标对齐失败，请重新加载预览。');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = pixels;
    const context = canvas.getContext('2d')!;
    const bounds = container.getBoundingClientRect();
    const layers = [...container.querySelectorAll<HTMLCanvasElement>('canvas.amap-layer')];
    if (!layers.length) throw new Error('当前地图图层不支持浏览器导出，请重新加载预览。');
    for (const layer of layers) {
      const rect = layer.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const sx = layer.width / rect.width, sy = layer.height / rect.height;
      context.drawImage(layer, (bounds.left + 64 - rect.left) * sx, (bounds.top + 64 - rect.top) * sy,
        pixels * sx, pixels * sy, 0, 0, pixels, pixels);
    }
    // Fail explicitly if the provider cannot supply exportable pixels.
    const data = context.getImageData(pixels / 2, pixels / 2, 1, 1).data;
    if (!data[3]) throw new Error('卫星图为空，请重新加载预览。');
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('卫星图转换失败')), 'image/jpeg', 0.93));
    canvas.width = canvas.height = 1;
    captures++;
    return blob;
  }
  async function patch(center: Coordinate, zoom: number, full: boolean) {
    const key = `satellite-v3-${zoom}-${center.map(n => n.toFixed(9)).join('-')}-${full ? 2048 : 1024}`;
    if (!pending.has(key)) {
      const work = cachedImage(key, async () => {
        if (!full) {
          const original = await readCachedImage(key.replace(/1024$/, '2048'));
          if (original) {
            const image = await createImageBitmap(original, { resizeWidth: 1024, resizeHeight: 1024, resizeQuality: 'high' });
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1024;
            canvas.getContext('2d')!.drawImage(image, 0, 0);
            image.close();
            const small = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('地图缓存读取失败')), 'image/jpeg', 0.93));
            canvas.width = canvas.height = 1;
            return small;
          }
        }
        const result = serial.catch(() => {}).then(() => capture(center, full ? zoom : zoom - 1, full ? 2048 : 1024));
        serial = result;
        return result;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return pending.get(key)!;
  }
  return {
    async terrain() {
      status('浏览器直连下载真实高程');
      const requests = terrainRequests(plan, 257, 2);
      const tiles = new Map<string, Uint8ClampedArray>();
      let next = 0, done = 0;
      await Promise.all(Array.from({ length: Math.min(4, requests.tiles.length) }, async () => {
        while (next < requests.tiles.length) {
          if (disposed) throw new Error('地图预览已关闭');
          const tile = requests.tiles[next++];
          const blob = await cachedImage('terrain-' + tile.id, async () => {
            const response = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${tile.zoom}/${tile.x}/${tile.y}.png`, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('高程数据下载失败，请检查网络后重试。');
            return response.blob();
          });
          const image = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 256;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          tiles.set(tile.id, context.getImageData(0, 0, 256, 256).data);
          image.close();
          canvas.width = canvas.height = 1;
          status(`浏览器下载高程 ${++done}/${requests.tiles.length}`);
        }
      }));
      return { layers: requests.layers.map(layer => ({
        id: layer.id, size: layer.size,
        heightMeters: layer.grid.map(point => sampleTerrarium(tiles, layer.zoom, point))
      })) };
    },
    async atlas(layer: VideoLayer, full: boolean) {
      const center = mercator(layer.center), scale = 256 * 2 ** layer.zoom;
      const pixels = full ? 2048 : 1024;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = pixels * 2;
      const context = canvas.getContext('2d')!;
      for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
        const blob = await patch(inverseMercator([
          center[0] + (col - 0.5) * 2048 / scale,
          center[1] + (row - 0.5) * 2048 / scale
        ]), layer.zoom, full);
        const image = await createImageBitmap(blob);
        context.drawImage(image, col * pixels, row * pixels);
        image.close();
      }
      return canvas;
    },
    detail: (tile: { center: Coordinate; zoom: number }, full: boolean) => patch(tile.center, tile.zoom, full),
    stats: () => ({ captures, pending: pending.size, source: 'browser-direct' }),
    dispose() { disposed = true; map?.destroy(); container?.remove(); }
  };
}

export { browserMusicSource } from './browserMusic';
