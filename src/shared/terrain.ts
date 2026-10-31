import { mercator, inverseMercator, type VideoPlan } from './videoPlan';
import type { Coordinate } from './itinerary';

export function terrainWgs84(lng: number, lat: number): Coordinate {
  if (lng < 72 || lng > 138 || lat < 0.8 || lat > 56) return [lng, lat];
  const forward = (a: number, b: number) => {
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


export function terrainRequests(plan: VideoPlan, size = 257, zoomOffset = 1) {
  const tiles = new Map<string, { id: string; zoom: number; x: number; y: number }>();
  const layers = plan.layers.map((layer) => {
    const zoom = Math.min(12, Math.max(5, Math.floor(layer.zoom) - zoomOffset));
    const center = mercator(layer.center), span = layer.width / (256 * 2 ** layer.zoom);
    const grid: Coordinate[] = [], scale = 256 * 2 ** zoom;
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const gcj = inverseMercator([
        center[0] + (col / (size - 1) - 0.5) * span,
        center[1] + (row / (size - 1) - 0.5) * span
      ]);
      const p = mercator(terrainWgs84(...gcj));
      const pixel: Coordinate = [p[0] * scale - 0.5, p[1] * scale - 0.5];
      grid.push(pixel);
      for (const dx of [0, 1]) for (const dy of [0, 1]) {
        const x = Math.floor((Math.floor(pixel[0]) + dx) / 256);
        const y = Math.floor((Math.floor(pixel[1]) + dy) / 256);
        const id = `${zoom}-${x}-${y}`;
        tiles.set(id, { id, zoom, x, y });
      }
    }
    return { id: layer.id, zoom, size, grid };
  });
  if (tiles.size > 600) throw new Error('高程覆盖范围过大，请拆分行程。');
  return { layers, tiles: [...tiles.values()] };
}

export function sampleTerrarium(tiles: Map<string, Uint8ClampedArray>, zoom: number, point: Coordinate) {
  const read = (x: number, y: number) => {
    const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
    const data = tiles.get(`${zoom}-${tx}-${ty}`);
    if (!data) throw new Error('高程瓦片不完整，请重试。');
    const i = ((y - ty * 256) * 256 + x - tx * 256) * 4;
    return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
  };
  const x = Math.floor(point[0]), y = Math.floor(point[1]);
  const fx = point[0] - x, fy = point[1] - y;
  return Math.round((read(x, y) * (1 - fx) * (1 - fy) +
    read(x + 1, y) * fx * (1 - fy) + read(x, y + 1) * (1 - fx) * fy +
    read(x + 1, y + 1) * fx * fy) * 1000) / 1000;
}
