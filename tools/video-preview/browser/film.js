import { selectVehicle, createPublicTransportModels } from './vehicles.js';
import * as THREE from 'three';
import { createAssetQueue, previewSize } from './playback.js';

import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const DATA = await fetch('plan.json').then((r) => r.json()),
  W = DATA.width,
  H = DATA.height,
  DURATION = DATA.duration;
const PARAMS = new URLSearchParams(location.search);
const PLANNING = PARAMS.has('planning');
let exporting = PLANNING || PARAMS.has('render');
let seekEpoch = 0;
const playbackStats = { frames: 0, lastFrameMs: 0 };
const INTRO = DATA.intro,
  JOURNEY_END = DATA.journeyEnd,
  OUTRO = DURATION - JOURNEY_END,
  CAMERA_STEPS = Math.ceil(DURATION * 60);
const TERRAIN = true;
let assetProgress;
const clientRuntime = window.browserSceneRuntime ? await window.browserSceneRuntime : null;
const directAssets = clientRuntime ? await clientRuntime.createBrowserSceneAssets(DATA, (text) => { window.sceneProgress = text; assetProgress?.(text); }) : null;
window.addEventListener('pagehide', () => directAssets?.dispose(), { once: true });
const DEM = directAssets ? await directAssets.terrain() : await fetch('terrain-data.json').then((r) => r.json());
const title = DATA.title;
const colorForDay = (day) =>
  DATA.days.find((d) => d.dayIndex === day)?.color || '#0052ff';
const MAPS = DATA.layers.map((m) => ({
  ...m,
  dem: DEM.layers.find((x) => x.id === m.id),
  cx: (m.point[0] - 0.5) * DATA.worldSize,
  cz: (m.point[1] - 0.5) * DATA.worldSize
}));
function sampleHeight(m, x, z) {
  const n = m.dem.size,
    u = Math.max(
      0,
      Math.min(n - 1, ((x - m.cx) / m.worldSize + 0.5) * (n - 1))
    ),
    v = Math.max(
      0,
      Math.min(n - 1, ((z - m.cz) / m.worldSize + 0.5) * (n - 1))
    ),
    ix = Math.min(n - 2, Math.floor(u)),
    iz = Math.min(n - 2, Math.floor(v)),
    fx = u - ix,
    fz = v - iz,
    h = m.dem.heightMeters;
  return (
    (h[iz * n + ix] * (1 - fx) * (1 - fz) +
      h[iz * n + ix + 1] * fx * (1 - fz) +
      h[(iz + 1) * n + ix] * (1 - fx) * fz +
      h[(iz + 1) * n + ix + 1] * fx * fz) /
    DATA.metersPerWorldUnit
  );
}
function heightAt(x, z) {
  const m =
    MAPS.slice(1).find(
      (m) =>
        Math.abs(x - m.cx) < m.worldSize / 2 &&
        Math.abs(z - m.cz) < m.worldSize / 2
    ) || MAPS[0];
  return sampleHeight(m, x, z);
}
const PAPER = '#f5f5ef',
  INK = '#173e3c';
const canvas = document.getElementById('film'),
  ctx = canvas.getContext('2d', { alpha: false });
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const ease = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const fullAtlases = MAPS.map(() => exporting);
function atlasImage(m, index, full) {
  if (directAssets && !PLANNING) return directAssets.atlas(m, full).then(image => { image.fullAtlas = full; return image; });
  return new Promise((resolve, reject) => {
    if (PLANNING) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      resolve(c);
      return;
    }
    const image = new Image();
    const timer = setTimeout(() => {
      image.onload = image.onerror = null;
      image.src = '';
      reject(new Error('基础地图加载超时'));
    }, 45000);
    image.onload = () => {
      clearTimeout(timer);
      image.fullAtlas = full;
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      if (!full) atlasImage(m, index, true).then(resolve, reject);
      else reject(new Error('基础地图加载失败'));
    };
    image.src = (full ? '' : 'preview-') + 'atlas-' + m.id + '.jpg';
  });
}
const mapImages = await Promise.all(MAPS.map(async (m, i) => {
  const image = await atlasImage(m, i, exporting);
  fullAtlases[i] = image.fullAtlas || exporting;
  return image;
}));
const atlasTextures = [];
const attribution = await new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = 'attribution.png';
});
await document.fonts.ready;
const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance'
});

renderer.setPixelRatio(1);
renderer.setClearColor(PAPER, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, W / H, 0.03, 100000);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb0c0b3, 2.0));
const light = new THREE.DirectionalLight(0xfff4d6, 2.8);
light.position.set(-25, 65, 25);
light.castShadow = true;
light.shadow.mapSize.set(exporting ? 2048 : 1024, exporting ? 2048 : 1024);
Object.assign(light.shadow.camera, {
  left: -13,
  right: 13,
  top: 13,
  bottom: -13,
  near: 1,
  far: 90
});
light.shadow.camera.updateProjectionMatrix();
light.shadow.bias = -0.0002;
light.shadow.normalBias = 0.04;
scene.add(light, light.target);
function setRenderQuality(full) {
  exporting = full;
  const [width, height] = full ? [W, H] : previewSize(W, H);
  renderer.setSize(width, height);
  canvas.width = width;
  canvas.height = height;
  ctx.setTransform(width / W, 0, 0, height / H, 0, 0);
  const shadowSize = full ? 2048 : 1024;
  if (light.shadow.mapSize.x !== shadowSize) {
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.mapSize.set(shadowSize, shadowSize);
  }
}
setRenderQuality(exporting);
for (let i = 0; i < MAPS.length; i++) {
  const m = MAPS[i],
    texture = new THREE.Texture(mapImages[i]);
  atlasTextures.push(texture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(
      m.worldSize,
      m.worldSize,
      PLANNING ? 32 : 256,
      PLANNING ? 32 : 256
    ),
    positions = geo.attributes.position;
  for (let j = 0; j < positions.count; j++)
    positions.setZ(
      j,
      heightAt(m.cx + positions.getX(j), m.cz - positions.getY(j))
    );
  const ground = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: texture,
      toneMapped: false,
      depthWrite: false,
      depthTest: false
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(m.cx, 0, m.cz);
  ground.renderOrder = i - 4;
  scene.add(ground);
}
// Native zoom 16 / 17 image patches. Geometry stays in the same terrain coordinates.
let HD_PLAN = PLANNING
  ? { tiles: [] }
  : directAssets ? { tiles: [] } : await fetch('detail-plan.json').then((r) => r.json());
const hdClock = { tick: 0 },
  hdTarget = new THREE.Vector2(),
  hdDetailRadius = { value: 6 },
  hdGlobalFade = { value: 0 };
const hdFrustum = new THREE.Frustum(),
  hdMatrix = new THREE.Matrix4();
const hdPatches = [];
function buildHdPatches() { return HD_PLAN.tiles.map((m) => {
  const geo = new THREE.PlaneGeometry(m.worldSize, m.worldSize, 64, 64),
    positions = geo.attributes.position;
  for (let j = 0; j < positions.count; j++)
    positions.setZ(
      j,
      heightAt(m.cx + positions.getX(j), m.cz - positions.getY(j))
    );
  const [prefix, tx, ty] = m.id.split('-'),
    has = (dx, dy) =>
      HD_PLAN.tiles.some(
        (t) =>
          t.id === prefix + '-' + (Number(tx) + dx) + '-' + (Number(ty) + dy)
      );
  const uniforms = {
    hdEdges: {
      value: new THREE.Vector4(
        has(-1, 0) ? 0 : 1,
        has(1, 0) ? 0 : 1,
        has(0, 1) ? 0 : 1,
        has(0, -1) ? 0 : 1
      )
    },
    hdTarget: { value: hdTarget },
    hdRadius: hdDetailRadius,
    hdGlobalFade,
    hdLevel: { value: m.zoom },
    hdTex: { value: null }
  };
  const mat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: false,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms,
    vertexShader:
      'varying vec2 vUv;varying vec2 vWorld;void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);vWorld=world.xz;gl_Position=projectionMatrix*viewMatrix*world;}',
    fragmentShader:
      'uniform vec4 hdEdges;uniform sampler2D hdTex;uniform vec2 hdTarget;uniform float hdRadius;uniform float hdGlobalFade;uniform float hdLevel;varying vec2 vUv;varying vec2 vWorld;void main(){vec4 color=texture2D(hdTex,vUv);float edge=min(min(mix(1.,vUv.x,hdEdges.x),mix(1.,1.-vUv.x,hdEdges.y)),min(mix(1.,vUv.y,hdEdges.z),mix(1.,1.-vUv.y,hdEdges.w)));float a=hdGlobalFade*(hdLevel>16.5?smoothstep(0.,.012,edge):1.);if(hdLevel>16.5)a*=1.-smoothstep(hdRadius*.72,hdRadius,distance(vWorld,hdTarget));gl_FragColor=vec4(color.rgb,a);#include <colorspace_fragment>\n}'
  });
  // The chunk directive must start on a new line for the shader preprocessor.
  mat.fragmentShader = mat.fragmentShader.replace(';#include', ';\n#include');
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(m.cx, 0, m.cz);
  mesh.renderOrder = m.zoom === 16 ? -1 : 0;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  return {
    ...m,
    mesh,
    uniforms,
    texture: null,
    pending: null,
    lastUsed: 0,
    wanted: false,
    box: new THREE.Box3(
      new THREE.Vector3(m.cx - m.worldSize / 2, -2, m.cz - m.worldSize / 2),
      new THREE.Vector3(m.cx + m.worldSize / 2, 8, m.cz + m.worldSize / 2)
    )
  };
}); }
function selectHd(cam) {
  hdClock.tick++;
  hdTarget.set(cam.target.x, cam.target.z);
  hdDetailRadius.value = cam.height < 14 ? 24 : 6;
  hdGlobalFade.value = 1 - ease((cam.height - 40) / 25);
  hdFrustum.setFromProjectionMatrix(
    hdMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    )
  );
  for (const p of hdPatches) {
    const r = hdDetailRadius.value,
      dx = Math.max(0, Math.abs(p.cx - cam.target.x) - p.worldSize / 2),
      dz = Math.max(0, Math.abs(p.cz - cam.target.z) - p.worldSize / 2);
    p.wanted =
      hdGlobalFade.value > 0 &&
      hdFrustum.intersectsBox(p.box) &&
      (p.zoom === 16 || dx * dx + dz * dz < r * r);
    p.mesh.visible = p.wanted && Boolean(p.texture);
    if (p.wanted) p.lastUsed = hdClock.tick;
  }
}
const hdById = new Map();
const textureStream = createAssetQueue({
  load: async (id, signal) => {
    const full = id.startsWith('full:');
    const tileId = id.slice(id.indexOf(':') + 1);
    const blob = directAssets ? await directAssets.detail(hdById.get(tileId), full) : await (async () => {
      const response = await fetch((full ? '' : 'preview-') + 'detail-tiles/' + tileId + '.jpg', { signal });
      if (!response.ok) throw new Error('Missing HD tile: ' + id);
      return response.blob();
    })();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
    if (signal.aborted) {
      bitmap.close();
      throw new Error('地图素材加载已取消');
    }
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    const patch = hdById.get(tileId);
    if (patch.fullQuality && !full) {
      bitmap.close();
      texture.dispose();
      return;
    }
    if (patch.texture) {
      patch.texture.image.close?.();
      patch.texture.dispose();
    }
    patch.fullQuality = full;
    patch.texture = texture;
    patch.uniforms.hdTex.value = texture;
  }
});
function evictHd() {
  const resident = hdPatches.filter((p) => p.texture)
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const p of resident.slice(exporting ? 36 : 24))
    if (!p.wanted) {
      p.texture.image.close?.();
      p.texture.dispose();
      p.texture = null;
      p.fullQuality = false;
      p.uniforms.hdTex.value = null;
      p.mesh.visible = false;
    }
}
async function ensureHd(strict = false) {
  const desired = hdPatches.filter((p) => p.wanted);
  const prefix = strict ? 'full:' : 'preview:';
  textureStream.retain(desired.map((p) => prefix + p.id));
  const requests = desired.filter((p) => !p.texture || (strict && !p.fullQuality)).map((p) =>
    textureStream.request(prefix + p.id,
      Math.hypot(p.cx - hdTarget.x, p.cz - hdTarget.y), strict)
  );
  if (strict) await Promise.all(requests);
  else await Promise.allSettled(requests);
  evictHd();
}
function renderPreview(t) {
  const result = renderAt(t);
  // Background work never gates the animation clock or the next frame.
  void ensureHd().catch(() => {});
  return result;
}

const world = (p) => {
  const x = (p[0] - 0.5) * DATA.worldSize,
    z = (p[1] - 0.5) * DATA.worldSize;
  return new THREE.Vector3(x, heightAt(x, z), z);
};
const stops = DATA.stops.map((s) => ({ ...s, world: world(s.point) }));
const shadowFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.ShadowMaterial({ color: '#426453', opacity: 0.22 })
);
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.position.y = 0.015;
shadowFloor.receiveShadow = true;
if (!TERRAIN) scene.add(shadowFloor);
const lookup = new Map(stops.map((s) => [s.id, s]));
function buildSegment(segment) {
  const from = lookup.get(segment.fromStopId),
    to = lookup.get(segment.toStopId);
  const points = [from.world, ...segment.points.map(world), to.world].filter(
    (p, i, a) => !i || p.distanceTo(a[i - 1]) > 1e-5
  );
  if (points.length === 1) points.push(points[0].clone());
  const lengths = [0];
  for (let i = 1; i < points.length; i++)
    lengths.push(lengths.at(-1) + points[i].distanceTo(points[i - 1]));
  return {
    ...segment,
    from,
    to,
    points,
    lengths,
    length: lengths.at(-1),
    color: segment.color
  };
}
const segments = DATA.segments.map(buildSegment);
function along(segment, p) {
  if (segment.points.length < 2)
    return { point: segment.points[0].clone(), index: 0 };
  const distance = clamp(p) * segment.length;
  let i = 1;
  while (i < segment.lengths.length - 1 && segment.lengths[i] < distance) i++;
  const f = clamp(
    (distance - segment.lengths[i - 1]) /
      Math.max(1e-9, segment.lengths[i] - segment.lengths[i - 1])
  );
  return {
    point: segment.points[i - 1].clone().lerp(segment.points[i], f),
    index: i
  };
}
const events = DATA.events.map((event) => ({
  ...event,
  segment: segments[event.index]
}));
function stateAt(t) {
  let event = events[0];
  for (const e of events) if (t >= e.start) event = e;
  const vehicle = selectVehicle(event.segment);
  const progress =
    t < INTRO ? 0 : clamp((t - event.start) / (event.end - event.start));
  const position = along(event.segment, progress).point;
  const before = along(event.segment, clamp(progress - 0.009)).point,
    after = along(event.segment, clamp(progress + 0.009)).point;
  const tangent = after.sub(before);
  const heading = Math.atan2(-tangent.x, -tangent.z);
  const day = event.segment.isInterDay
    ? progress > 0.65
      ? event.segment.toDayIndex
      : event.segment.dayIndex
    : event.segment.dayIndex;
  return {
    event,
    progress,
    position,
    heading,
    day,
    moving:
      t >= event.start && t < event.end && event.segment.distanceMeters > 0.1,
    vehicle,
    walking: vehicle === 'walker',
    interDay: Boolean(event.segment.isInterDay),
    rail: vehicle === 'train' || vehicle === 'subway',
    flight: vehicle === 'plane',
    ferry: vehicle === 'boat',
    transit: vehicle === 'bus',
    activity:
      t >= event.end && t < JOURNEY_END ? event.segment.to.activity : undefined
  };
}
const allPoints = segments.flatMap((s) => s.points);
const box = new THREE.Box3().setFromPoints(allPoints),
  overview = box.getCenter(new THREE.Vector3());
const cameraFrames = [];
for (let i = 0; i <= CAMERA_STEPS; i++) {
  const t = i / 60,
    state = stateAt(t),
    segment = state.event.segment;
  let height = segment.cameraHeight;
  if (segment.wideCameraHeight > height) {
    const p = state.progress,
      wide = ease(clamp(p / 0.22)) * ease(clamp((1 - p) / 0.22));
    height = Math.exp(
      mix(Math.log(height), Math.log(segment.wideCameraHeight), wide)
    );
  }
  let target = state.position.clone();
  if (t < INTRO) {
    const p = ease((t - 0.15) / Math.max(0.1, INTRO - 0.15));
    target = overview.clone().lerp(segments[0].from.world, p);
    height = Math.exp(
      mix(Math.log(DATA.overviewHeight), Math.log(segment.cameraHeight), p)
    );
  }
  if (t >= JOURNEY_END) {
    const p = ease((t - JOURNEY_END) / Math.max(0.1, OUTRO - 0.3));
    target = state.position.clone().lerp(overview, p * p * p);
    height = Math.exp(mix(Math.log(height), Math.log(DATA.overviewHeight), p));
  }
  const yaw = 0.22 * Math.sin(state.heading) + 0.15 * Math.sin(t * 0.36);
  cameraFrames.push({ target, height, yaw, heading: state.heading });
}
// Symmetric smoothing makes seeks reproducible and anticipates turns without camera resets.
const smoothFrames = cameraFrames.map((_, i) => {
  const target = new THREE.Vector3();
  let height = 0,
    yaw = 0,
    weight = 0,
    sinHeading = 0,
    cosHeading = 0;
  for (let j = -18; j <= 18; j++) {
    const frame = cameraFrames[clamp(i + j, 0, CAMERA_STEPS)],
      w = Math.exp(-0.5 * (j / 8) ** 2);
    target.addScaledVector(frame.target, w);
    height += frame.height * w;
    yaw += frame.yaw * w;
    sinHeading += Math.sin(frame.heading) * w;
    cosHeading += Math.cos(frame.heading) * w;
    weight += w;
  }
  return {
    target: target.divideScalar(weight),
    height: height / weight,
    yaw: yaw / weight,
    heading: Math.atan2(sinHeading, cosHeading)
  };
});
function camAt(t) {
  const f = clamp(t * 60, 0, CAMERA_STEPS),
    i = Math.floor(f),
    a = smoothFrames[i],
    b = smoothFrames[Math.min(CAMERA_STEPS, i + 1)];
  return {
    target: a.target.clone().lerp(b.target, f - i),
    height: mix(a.height, b.height, f - i),
    yaw: mix(a.yaw, b.yaw, f - i),
    heading: Math.atan2(
      mix(Math.sin(a.heading), Math.sin(b.heading), f - i),
      mix(Math.cos(a.heading), Math.cos(b.heading), f - i)
    )
  };
}
function rounded(w, h, d, color, x, y, z, r = 0.09) {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(w, h, d, 3, r),
    new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.08 })
  );
  mesh.position.set(x, y, z);
  return mesh;
}
function shadow(width, depth) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d'),
    g = x.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, '#10272a66');
  g.addColorStop(1, '#10272a00');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c),
      transparent: true,
      depthWrite: false,
      toneMapped: false
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.025;
  return mesh;
}
const car = new THREE.Group(),
  body = new THREE.Group(),
  wheels = [];
car.add(shadow(3.0, 4.5), body);
body.add(rounded(1.68, 0.58, 3.3, '#f6bd42', 0, 0.65, 0, 0.18));
body.add(rounded(1.4, 0.75, 1.65, '#274f60', 0, 1.17, 0.22, 0.2));
body.add(rounded(1.4, 0.18, 1.1, '#ffcb50', 0, 1.56, 0.27, 0.1));
body.add(rounded(1.54, 0.14, 0.88, '#ffcf60', 0, 0.98, -1.05, 0.07));
body.add(rounded(0.95, 0.24, 0.62, '#e6d2a9', 0, 1.78, 0.35, 0.07));
body.add(rounded(1.02, 0.035, 0.08, '#fff2d9', 0, 1.92, 0.35, 0.015));
body.add(rounded(0.9, 0.15, 0.07, '#2c4147', 0, 0.48, -1.67, 0.025));
for (const side of [-1, 1]) {
  body.add(rounded(0.35, 0.18, 0.1, '#fff9d5', side * 0.5, 0.73, -1.65, 0.035));
  body.add(
    rounded(0.34, 0.16, 0.09, '#e26152', side * 0.52, 0.73, 1.65, 0.035)
  );
  body.add(
    rounded(0.18, 0.13, 0.3, '#f1b73b', side * 0.88, 1.02, -0.39, 0.035)
  );
  for (const z of [-1.03, 1.03]) {
    const wheel = new THREE.Group();
    wheel.position.set(side * 0.84, 0.37, z);
    const tire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, 0.23, 18),
      new THREE.MeshStandardMaterial({ color: '#263336', roughness: 0.85 })
    );
    tire.rotation.z = Math.PI / 2;
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.19, 0.25, 18),
      new THREE.MeshStandardMaterial({
        color: '#e8e6db',
        metalness: 0.3,
        roughness: 0.35
      })
    );
    hub.rotation.z = Math.PI / 2;
    wheel.add(tire, hub);
    body.add(wheel);
    wheels.push(wheel);
  }
}
scene.add(car);
const walker = new THREE.Group();
walker.add(shadow(1.5, 1.8));
const person = new THREE.Group();
walker.add(person);
const head = new THREE.Mesh(
  new THREE.SphereGeometry(0.25, 18, 14),
  new THREE.MeshStandardMaterial({ color: '#ebbd8e', roughness: 0.7 })
);
head.position.set(0, 1.68, 0);
person.add(head);
person.add(rounded(0.65, 0.65, 0.4, '#ff8257', 0, 1.15, 0, 0.17));
person.add(rounded(0.48, 0.48, 0.26, '#b7cc99', 0, 1.19, 0.3, 0.1));
const hat = new THREE.Mesh(
  new THREE.CylinderGeometry(0.27, 0.3, 0.13, 20),
  new THREE.MeshStandardMaterial({ color: '#f8df87' })
);
hat.position.set(0, 1.92, 0);
person.add(hat);
const limbs = [];
for (const side of [-1, 1]) {
  const leg = new THREE.Group();
  leg.position.set(side * 0.17, 0.87, 0);
  leg.add(rounded(0.23, 0.65, 0.24, '#354e65', 0, -0.34, 0, 0.07));
  leg.add(rounded(0.26, 0.16, 0.42, '#fcfaf0', 0, -0.66, -0.08, 0.05));
  person.add(leg);
  const arm = new THREE.Group();
  arm.position.set(side * 0.4, 1.4, 0);
  arm.add(rounded(0.18, 0.58, 0.2, '#ff936e', 0, -0.27, 0, 0.06));
  person.add(arm);
  limbs.push({ side, leg, arm });
}
scene.add(walker);
for (const actor of [car, walker])
  actor.traverse((object) => {
    if (object.isMesh) {
      object.renderOrder = 10;
      object.castShadow = !object.material.transparent;
    }
  });
const train = new THREE.Group();
for (let i = 0; i < 2; i++) {
  const z = i * 4.2;
  train.add(rounded(1.55, 1.1, 3.9, '#f3f5ee', 0, 0.85, z, 0.3));
  train.add(rounded(1.58, 0.2, 3.4, '#387a9e', 0, 0.77, z, 0.06));
  train.add(rounded(1.3, 0.42, 1.3, '#285268', 0, 1.23, z - 1.2, 0.13));
  for (const side of [-1, 1])
    for (const dz of [-0.35, 0.3, 0.95])
      train.add(
        rounded(0.035, 0.31, 0.48, '#2a576a', side * 0.79, 1.2, z + dz, 0.015)
      );
}
scene.add(train);
const boat = new THREE.Group();
boat.add(rounded(1.9, 0.52, 3.8, '#274f60', 0, 0.4, 0, 0.22));
boat.add(rounded(1.65, 0.3, 3.25, '#f4f1df', 0, 0.79, 0, 0.14));
boat.add(rounded(1.3, 0.75, 2.2, '#f8f6ea', 0, 1.25, 0.1, 0.12));
boat.add(rounded(1.35, 0.25, 1.7, '#3388ad', 0, 1.35, -0.18, 0.06));
boat.add(rounded(1.55, 0.15, 2.3, '#f9cd64', 0, 1.69, 0.12, 0.06));
scene.add(boat);
for (const a of [train, boat])
  a.traverse((o) => {
    if (o.isMesh) o.renderOrder = 10;
  });
const { bus, subway, plane, busWheels } = createPublicTransportModels(
  THREE,
  rounded,
  shadow
);
scene.add(bus, subway, plane);
const actors = { car, walker, train, boat, bus, subway, plane };
const city = {
  stats: {
    illustrativeBuildings: 0,
    landmarkSymbols: 0,
    terrain: TERRAIN,
    exaggeration: TERRAIN ? 1 : null
  }
};
function makeLine(color, width, opacity = 1, dashed = false) {
  const material = new LineMaterial({
    color,
    linewidth: width,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
    dashed,
    dashSize: 0.2,
    gapSize: 0.16,
    alphaToCoverage: false,
    toneMapped: false
  });
  material.resolution.set(W, H);
  const line = new Line2(new LineGeometry(), material);
  line.frustumCulled = false;
  line.renderOrder = opacity < 1 ? 1 : color === '#ffffff' ? 2 : 3;
  scene.add(line);
  return line;
}
function coords(points, y = 0.06) {
  return points.flatMap((p) => [p.x, p.y + y, p.z]);
}
for (const segment of segments) {
  segment.guide = makeLine(
    segment.isInterDay ? '#899c97' : '#a1b4ad',
    3,
    0.18,
    segment.isInterDay
  );
  segment.guide.geometry.setPositions(coords(segment.points, 0.025));
  segment.guide.computeLineDistances();
  segment.outline = makeLine('#ffffff', 15, 1, segment.illustrative);
  segment.trail = makeLine(
    segment.color,
    8,
    1,
    segment.illustrative || segment.mode === 'walking'
  );
  // Allocate full-sized instance buffers once. Growing them after the first frame
  // leaves Three's renderer capped at the initial instance count.
  for (const [line, level] of [
    [segment.outline, 0.04],
    [segment.trail, 0.065]
  ]) {
    line.geometry.setPositions(coords(segment.points, level));
    line.userData.fullPositions =
      line.geometry.attributes.instanceStart.data.array.slice();
    line.userData.level = level;
    line.computeLineDistances();
  }
}
function updateLine(segment, progress) {
  if (segment.drawProgress === progress) return;
  segment.drawProgress = progress;
  const visible = progress > 0;
  segment.trail.visible = segment.outline.visible = visible;
  if (!visible) return;
  const hit = progress < 1 ? along(segment, progress) : null;
  for (const line of [segment.outline, segment.trail]) {
    const geometry = line.geometry,
      buffer = geometry.attributes.instanceStart.data;
    buffer.array.set(line.userData.fullPositions);
    if (hit)
      geometry.attributes.instanceEnd.setXYZ(
        hit.index - 1,
        hit.point.x,
        hit.point.y + line.userData.level,
        hit.point.z
      );
    buffer.needsUpdate = true;
    geometry.instanceCount = hit ? hit.index : segment.points.length - 1;
    line.computeLineDistances();
  }
}
const font = (size, weight = 500) =>
  `${weight} ${size}px "PingFang SC",sans-serif`;
function text(s, x, y, size = 30, color = INK, weight = 500, align = 'left') {
  ctx.font = font(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
}
function round(x, y, w, h, r = 20, color = 'white') {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}
function circle(x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
function screen(p, y = 0) {
  const v = p.clone();
  v.y += y;
  v.project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * W,
    y: (0.5 - v.y * 0.5) * H,
    visible: v.z > -1 && v.z < 1
  };
}
function label(stop, color, filled = false) {
  const p = screen(stop.world, 0.15);
  if (!p.visible || p.x < 45 || p.x > 1035 || p.y < 350 || p.y > 1540) return;
  const size = filled ? 32 : 27;
  ctx.font = font(size, 600);
  const name = shorten(stop.name, 650, size);
  const w = ctx.measureText(name).width + 34,
    h = 56;
  const above = p.y < 750;
  let x = clamp(p.x + 27, 32, 1048 - w),
    y = p.y + (above ? 30 : -83);
  if (x < p.x + 19 && x + w > p.x - 19) x = clamp(p.x - w - 27, 32, 1048 - w);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(clamp(p.x, x, x + w), clamp(p.y, y, y + h));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  round(x, y, w, h, 14, filled ? color : '#fffffff2');
  text(name, x + 17, y + 39, size, filled ? 'white' : INK, 600);
}
function fitText(value, maxWidth, size, min = 28) {
  ctx.font = font(size, 650);
  while (ctx.measureText(value).width > maxWidth && size > min) {
    size--;
    ctx.font = font(size, 650);
  }
  return size;
}
function shorten(value, maxWidth, size) {
  ctx.font = font(size, 600);
  let result = value;
  while (result.length > 1 && ctx.measureText(result).width > maxWidth)
    result = result.slice(0, -1);
  return result === value ? value : result.slice(0, -1) + '…';
}
function paintOverlay(t, state, height) {
  const wide = height > 45,
    headerEnd = wide ? 650 : 365;
  let g = ctx.createLinearGradient(0, 0, 0, headerEnd);
  g.addColorStop(0, PAPER);
  g.addColorStop(wide ? 0.74 : 0.62, wide ? PAPER : '#f5f5eff0');
  g.addColorStop(1, '#f5f5ef00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, headerEnd);
  g = ctx.createLinearGradient(0, 1550, 0, H);
  g.addColorStop(0, '#f5f5ef00');
  g.addColorStop(0.47, '#f5f5efea');
  g.addColorStop(1, PAPER);
  ctx.fillStyle = g;
  ctx.fillRect(0, 1550, W, 370);
  circle(66, 75, 10, INK);
  circle(66, 75, 3, PAPER);
  text('map-tour', 88, 84, 28, INK, 650);
  const areas = [...new Set(DATA.stops.map((s) => s.city).filter(Boolean))];
  text(
    shorten(DATA.days.length + ' 天 · ' + areas.join(' / '), 490, 25),
    1020,
    84,
    25,
    '#6f8380',
    500,
    'right'
  );
  text(
    shorten(title, 968, fitText(title, 968, 52)),
    56,
    174,
    fitText(title, 968, 52),
    INK,
    650
  );
  const selectedIndex = DATA.days.findIndex((d) => d.dayIndex === state.day),
    windowStart = clamp(
      selectedIndex - 3,
      0,
      Math.max(0, DATA.days.length - 7)
    ),
    visibleDays = DATA.days.slice(windowStart, windowStart + 7),
    pillWidth = Math.min(
      140,
      (968 - (visibleDays.length - 1) * 14) / visibleDays.length
    );
  for (const [i, day] of visibleDays.entries()) {
    const selected = state.day === day.dayIndex,
      x = 56 + i * (pillWidth + 14);
    round(x, 213, pillWidth, 46, 23, selected ? day.color : '#ffffffb8');
    circle(x + 19, 236, 5, selected ? 'white' : day.color);
    text(
      'DAY ' + String(day.dayIndex).padStart(2, '0'),
      x + 34,
      245,
      23,
      selected ? 'white' : day.color,
      600
    );
  }
  const segment = state.event.segment;
  if (height > Math.max(45, DATA.overviewHeight * 0.4)) {
    const areas = MAPS.length > 1 ? MAPS.slice(1) : [];
    for (const m of areas) {
      const p = screen(new THREE.Vector3(m.cx, heightAt(m.cx, m.cz), m.cz), 1);
      if (p.x > 35 && p.x < 1045 && p.y > 330 && p.y < 1510) {
        round(p.x - 90, p.y - 60, 180, 58, 16, '#fffffff0');
        text(shorten(m.label, 160, 30), p.x, p.y - 20, 30, INK, 650, 'center');
      }
    }
  } else {
    const seen = new Set();
    for (const stop of stops) {
      const key = stop.point.map((v) => v.toFixed(5)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const p = screen(stop.world, 0.025);
      if (!p.visible || p.x < 25 || p.x > 1055 || p.y < 350 || p.y > 1570)
        continue;
      circle(p.x, p.y, 12, '#fff');
      circle(p.x, p.y, 8, colorForDay(stop.dayIndex));
    }
    label(
      state.progress < 0.8 ? segment.from : segment.to,
      segment.color,
      state.progress > 0.8
    );
  }
  if (state.activity && state.activity.kind !== 'visit') {
    const p = screen(state.position, 0.12);
    p.y -= 115; // Keep the activity badge clear of the destination label.
    const meal = state.activity.kind === 'meal';
    round(p.x - 76, p.y - 98, 152, 79, 24, '#ffffffed');
    ctx.strokeStyle = '#345c87';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    if (meal) {
      ctx.beginPath();
      ctx.arc(p.x - 26, p.y - 59, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 51, p.y - 76);
      ctx.lineTo(p.x - 51, p.y - 43);
      ctx.moveTo(p.x - 58, p.y - 76);
      ctx.lineTo(p.x - 58, p.y - 64);
      ctx.lineTo(p.x - 44, p.y - 64);
      ctx.lineTo(p.x - 44, p.y - 76);
      ctx.stroke();
    } else {
      round(p.x - 57, p.y - 66, 52, 23, 4, '#a8c9ea');
      ctx.beginPath();
      ctx.moveTo(p.x - 57, p.y - 77);
      ctx.lineTo(p.x - 57, p.y - 37);
      ctx.moveTo(p.x - 5, p.y - 67);
      ctx.lineTo(p.x - 5, p.y - 37);
      ctx.stroke();
      text('z', p.x - 37, p.y - 76, 22, '#6883a0', 500);
    }
    text(meal ? '用餐' : '休息', p.x + 30, p.y - 48, 26, INK, 650, 'center');
  }
  const arrivalAge = t - state.event.end;
  if (arrivalAge >= 0 && arrivalAge < 0.42 && height < 180) {
    const p = screen(segment.to.world, 0.05),
      phase = arrivalAge / 0.42;
    ctx.save();
    ctx.globalAlpha = 0.65 * (1 - phase);
    ctx.strokeStyle = segment.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16 + 40 * phase, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  const end = t >= JOURNEY_END,
    intro = t < INTRO,
    modes = {
      walking: '步行路线',
      driving: '驾车路线',
      transit: '公共交通路线',
      bus: '公交路线',
      subway: '地铁路线',
      flight: '飞行路线',
      rail: '列车路线',
      ferry: '乘船路线'
    };
  const activity = state.activity;
  if (state.flight || state.transit || state.rail) {
    const p = screen(state.position, 0.12);
    round(p.x - 45, p.y - 130, 90, 64, 18, '#ffffffef');
    text(
      state.flight
        ? '✈'
        : state.vehicle === 'bus'
          ? '公交'
          : state.vehicle === 'subway'
            ? '地铁'
            : state.rail
              ? '火车'
              : '换乘',
      p.x,
      p.y - 86,
      28,
      INK,
      650,
      'center'
    );
  }
  const caption =
    activity && activity.kind !== 'visit'
      ? '第 ' +
        state.day +
        ' 天 · ' +
        (activity.kind === 'meal' ? '用餐' : '夜间休息') +
        (activity.source === 'default' ? ' · 默认推荐' : '') +
        (activity.placeKind === 'area' ? ' · 区域参考' : '')
      : intro
        ? '跟着路线，开启旅程。'
        : end
          ? '旅程的足迹，都在同一张地图上。'
          : state.interDay
            ? '第 ' +
              segment.dayIndex +
              ' 天 → 第 ' +
              segment.toDayIndex +
              ' 天 · 跨天衔接'
            : '第 ' +
              state.day +
              ' 天 · ' +
              (segment.transport?.label || modes[segment.mode]);
  const name = intro
    ? stops[0].name
    : end
      ? '旅行结束 · ' + DATA.days.length + ' 天的足迹'
      : state.progress >= 1
        ? segment.to.name
        : segment.from.name + ' → ' + segment.to.name;
  ctx.save();
  ctx.shadowColor = '#173e3c18';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 8;
  round(54, 1655, 972, 138, 28, '#fffffff5');
  ctx.restore();
  text(
    caption,
    80,
    1700,
    26,
    state.interDay ? '#718783' : colorForDay(state.day),
    550
  );
  text(
    shorten(name, 920, fitText(name, 920, 50)),
    80,
    1760,
    fitText(name, 920, 50),
    INK,
    650
  );
  const progress = clamp((t - INTRO) / (JOURNEY_END - INTRO));
  round(57, 1821, 966, 5, 3, '#dbe3de');
  if (progress > 0)
    round(57, 1821, Math.max(5, 966 * progress), 5, 3, colorForDay(state.day));
  ctx.drawImage(attribution, 0, 0, 44, 32, 56, 1857, 32, 24);
  text('高德地图 © AutoNavi', 94, 1878, 20, '#263e38', 500);
  text(
    segment.illustrative ? '虚线：路线为示意' : '卫星影像 · 高程 1×',
    1024,
    1880,
    22,
    '#70837e',
    450,
    'right'
  );
  text(
    'Terrain: Mapzen / USGS SRTM, GMTED2010 · NOAA ETOPO1',
    56,
    1908,
    17,
    '#70837e',
    450
  );
}
function positionCamera(cam) {
  const cameraOffset = mix(
    1.05,
    0.35,
    ease(clamp((cam.height - 24) / (Math.max(26, DATA.overviewHeight) - 24)))
  );
  camera.position.set(
    cam.target.x + Math.sin(cam.yaw) * cam.height * cameraOffset,
    cam.height + cam.target.y,
    cam.target.z + Math.cos(cam.yaw) * cam.height * cameraOffset
  );
  camera.lookAt(cam.target);
  camera.updateMatrixWorld();
}
function renderAt(t) {
  const frameStarted = performance.now();
  t = clamp(t, 0, DURATION - 0.0001);
  const state = stateAt(t),
    cam = camAt(t);
  positionCamera(cam);
  for (const event of events) {
    event.segment.guide.visible = t < event.start;
    updateLine(
      event.segment,
      t < event.start ? 0 : clamp((t - event.start) / (event.end - event.start))
    );
  }
  const endingScale =
    t >= JOURNEY_END ? mix(1, 0.55, ease((t - JOURNEY_END) / OUTRO)) : 1;
  const carScale = cam.height * 0.026 * endingScale,
    walking = state.walking;
  const resting = state.activity && state.activity.kind !== 'visit';
  for (const [name, model] of Object.entries(actors))
    model.visible = !resting && state.vehicle === name;
  const actor = actors[state.vehicle];
  actor.position.copy(state.position);
  actor.position.y += 0.05;
  actor.rotation.y = cam.heading;
  actor.scale.setScalar(
    state.rail
      ? carScale * 0.6
      : state.transit
        ? carScale * 0.76
        : state.flight
          ? carScale * 0.8
          : walking
            ? cam.height * 0.047
            : carScale
  );
  for (const wheel of [...wheels, ...busWheels])
    wheel.rotation.x = state.moving ? t * 9 : state.event.end * 9;
  const gait = state.moving ? Math.sin(t * 16) : 0;
  person.position.y = Math.abs(gait) * 0.055;
  for (const limb of limbs) {
    limb.leg.rotation.x = gait * 0.52 * limb.side;
    limb.arm.rotation.x = -gait * 0.44 * limb.side;
  }
  light.position.set(state.position.x - 12, 25, state.position.z + 10);
  light.target.position.copy(state.position);
  light.target.updateMatrixWorld();
  selectHd(cam);
  renderer.render(scene, camera);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  paintOverlay(t, state, cam.height);
  playbackStats.frames++;
  playbackStats.lastFrameMs = performance.now() - frameStarted;
  const actorScreen = screen(state.position, 0.4 * actor.scale.x);
  return {
    time: t,
    day: state.day,
    mode: state.event.segment.mode,
    interDay: state.interDay,
    cameraHeight: cam.height,
    actor: actorScreen,
    vehicle: state.vehicle,
    visibleVehicles: Object.entries(actors)
      .filter(([, model]) => model.visible)
      .map(([name]) => name),
    segment: state.event.index,
    progress: state.progress
  };
}
window.__video = {
  seek: renderAt,
  seekAsync: async (t) => {
    const epoch = seekEpoch;
    // Calculate visibility without drawing a throwaway frame before loading.
    const cam = camAt(t);
    positionCamera(cam);
    selectHd(cam);
    await ensureHd(true);
    if (epoch === seekEpoch) return renderAt(t);
  },
  duration: DURATION
};
window.renderAt = renderAt;
window.followDiagnostics = {
  projectStops: () =>
    stops.map((s) => ({ name: s.name, city: s.city, ...screen(s.world) })),
  events: events.map((e) => ({
    start: e.start,
    end: e.end,
    holdEnd: e.holdEnd,
    from: e.segment.from.name,
    to: e.segment.to.name,
    mode: e.segment.mode,
    interDay: e.segment.isInterDay || false
  })),
  city: city.stats,
  renderer: renderer.capabilities.maxTextureSize,
  overview: [overview.x, overview.z],
  assets: () => directAssets?.stats() || { source: 'server' },
  playback: () => ({ ...playbackStats, width: canvas.width, height: canvas.height,
    exporting, fullAtlases: fullAtlases.filter(Boolean).length, ...textureStream.stats() }),
  hd: () => ({
    wanted: hdPatches.filter((p) => p.wanted).length,
    loaded: hdPatches.filter((p) => p.texture).length,
    fullQuality: hdPatches.filter((p) => p.texture && p.fullQuality).length
  }),
  projectAllStops: () =>
    stops.map((s) => ({ ...screen(s.world), name: s.name }))
};
const controls = document.getElementById('controls'),
  button = document.getElementById('play'),
  scrub = document.getElementById('scrub'),
  music = document.getElementById('music');
if (
  new URLSearchParams(location.search).has('render') ||
  new URLSearchParams(location.search).has('embedded') ||
  PLANNING
)
  controls.style.display = 'none';
scrub.max = String(DURATION - 0.01);
let playing = false,
  current = 0,
  last = 0,
  lastDraw = 0;
function show() {
  scrub.value = current;
  document.getElementById('clock').textContent =
    current.toFixed(1) + ' / ' + DURATION.toFixed(1) + 's';
}
window.__video.pause = () => {
  playing = false;
  music.pause();
  button.textContent = '播放';
};
window.__video.play = () => {
  if (!playing) button.onclick();
};
window.__video.setTime = async (t) => {
  window.__video.pause();
  current = clamp(t, 0, DURATION - 0.001);
  music.currentTime = current;
  renderPreview(current);
  show();
};
window.__video.getTime = () => current;
window.__video.isPlaying = () => playing;
window.__video.prepareExport = async (progress) => {
  assetProgress = progress;
  window.__video.pause();
  seekEpoch++;
  setRenderQuality(true);
  const epoch = seekEpoch;
  try { await Promise.all(MAPS.map(async (m, i) => {
    if (fullAtlases[i]) return;
    const image = await atlasImage(m, i, true);
    if (epoch !== seekEpoch) return;
    fullAtlases[i] = true;
    atlasTextures[i].image = image;
    atlasTextures[i].needsUpdate = true;
  })); } finally { assetProgress = null; }
};
window.__video.finishExport = () => {
  seekEpoch++;
  setRenderQuality(false);
  renderPreview(current);
};
window.addEventListener(
  'webglcontextlost',
  (event) => {
    if (event.target !== renderer.domElement) return;
    event.preventDefault();
    window.sceneError = '设备图形资源不足';
  },
  true
);
button.onclick = () => {
  playing = !playing;
  button.textContent = playing ? '暂停' : '播放';
  last = performance.now();
  music.currentTime = current;
  if (playing) music.play().catch(() => {});
  else music.pause();
};
scrub.oninput = async () => {
  current = +scrub.value;
  music.currentTime = current;
  renderPreview(current);
  show();
};
function tick(now) {
  if (playing) {
    current += (now - last) / 1000;
    if (current >= DURATION) {
      current = 0;
      playing = false;
      music.pause();
      button.textContent = '播放';
    }
    if (now - lastDraw >= 1000 / 30 - 1) {
      renderPreview(current);
      lastDraw = now;
      show();
    }
  }
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
window.detailPlanningSamples = () => {
  const samples = [];
  for (let t = 1; t < DURATION; t += 0.3) {
    const c = camAt(t);
    if (c.height > 45) continue;
    renderAt(t);
    const points = [];
    for (const x of [-1, 0, 1])
      for (const y of [-0.72, -0.2, 0.5, 0.7]) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(x, y), camera);
        const point = ray.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), -c.target.y),
          new THREE.Vector3()
        );
        if (point) points.push([point.x, point.z]);
      }
    samples.push({
      t,
      height: c.height,
      target: [c.target.x, c.target.z],
      mode: stateAt(t).event.segment.mode,
      points
    });
  }
  return samples;
};
if (directAssets && !PLANNING) HD_PLAN = clientRuntime.createDetailPlan(DATA, window.detailPlanningSamples());
hdPatches.push(...buildHdPatches());
for (const patch of hdPatches) hdById.set(patch.id, patch);
if (window.browserSceneMusic) {
  const settings = window.browserSceneMusic;
  const musicController = new AbortController();
  window.addEventListener('pagehide', () => musicController.abort(), { once: true });
  const sourceUrl = settings.options.music === 'library' ? settings.url + '-source' : undefined;
  const blob = await clientRuntime.browserMusicSource(settings.options, DURATION, sourceUrl,
    (text) => { window.sceneProgress = text; }, musicController.signal);
  const url = blob ? URL.createObjectURL(blob) : settings.url;
  if (url) music.src = url;
  else music.removeAttribute('src');
  if (blob) window.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
  window.__video.getAudioBlob = () => blob;
}
if (exporting) await window.__video.seekAsync(0);
else renderPreview(0);
window.sampleReady = true;
