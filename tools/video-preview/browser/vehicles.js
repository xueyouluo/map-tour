import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Concrete transport takes priority over a generic route description.
export function selectVehicle(segment) {
  const direct = {
    walking: 'walker',
    driving: 'car',
    bus: 'bus',
    subway: 'subway',
    rail: 'train',
    ferry: 'boat',
    flight: 'plane'
  };
  if (direct[segment.mode]) return direct[segment.mode];
  const transport = segment.transport || {};
  const steps = (transport.steps || []).filter(
    (step) => direct[step.mode] && step.mode !== 'walking'
  );
  if (steps.length) {
    const ranked = steps.map((step, index) => ({
      step,
      index,
      weight: step.durationMinutes || step.distanceKm || 0
    }));
    ranked.sort((a, b) => b.weight - a.weight || a.index - b.index);
    return direct[ranked[0].step.mode];
  }
  const label = transport.label || '';
  if (/地铁|轻轨|metro|subway/i.test(label)) return 'subway';
  if (/火车|高铁|动车|rail|train/i.test(label)) return 'train';
  if (/轮渡|乘船|渡船|水上巴士|ferry/i.test(label)) return 'boat';
  return segment.mode === 'transit' ? 'bus' : 'car';
}

// All actors face -Z and stand on Y=0. Geometry is generated once; animation
// only changes transforms, so playback and frame-by-frame export share a rig.
export function createTravelActors(THREE, RoundedBoxGeometry, shadow = () => new THREE.Group()) {
  // Four soft bands and a narrow silhouette give travel miniatures a clear
  // game-model finish at map scale. Glass and wheel hardware stay understated.
  const tones = new THREE.DataTexture(new Uint8Array([96, 166, 222, 255]), 4, 1, THREE.RedFormat);
  tones.minFilter = tones.magFilter = THREE.NearestFilter;
  tones.needsUpdate = true;
  const materials = new Map();
  const mat = (color, kind = 'paint') => {
    const key = color + kind;
    if (!materials.has(key)) {
      const material = ['glass', 'metal', 'rubber'].includes(kind)
        ? new THREE.MeshStandardMaterial({ color,
          roughness: kind === 'rubber' ? 0.9 : kind === 'glass' ? 0.33 : 0.5,
          metalness: kind === 'metal' ? 0.25 : 0.05 })
        : new THREE.MeshToonMaterial({ color, gradientMap: tones,
          ...(kind === 'lamp' ? { emissive: color, emissiveIntensity: 0.12 } : {}) });
      material.userData.ink = ['paint', 'cloth', 'skin'].includes(kind);
      materials.set(key, material);
    }
    return materials.get(key);
  };
  const mesh = (parent, geometry, color, position = [0, 0, 0], kind) => {
    const part = new THREE.Mesh(geometry, mat(color, kind));
    part.position.set(...position);
    parent.add(part);
    return part;
  };
  const box = (parent, size, color, position, radius = 0.06, kind) =>
    mesh(parent, new RoundedBoxGeometry(...size, 3, Math.min(radius, ...size.map(n => n / 2))), color, position, kind);
  const sphere = (parent, size, color, position, kind) => {
    const part = mesh(parent, new THREE.SphereGeometry(1, 24, 16), color, position, kind);
    part.scale.set(...size);
    return part;
  };
  const rod = (parent, a, b, radius, color, kind, endRadius = radius) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const part = mesh(parent, new THREE.CylinderGeometry(endRadius, radius, start.distanceTo(end), 12), color, start.clone().add(end).multiplyScalar(0.5).toArray(), kind);
    part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    return part;
  };
  // Smooth, closed longitudinal shells. Their changing cross sections produce
  // sloped windscreens, tapered bows and noses instead of stacked boxes.
  const shell = (parent, sections, color, kind = 'paint', exponent = 0.5) => {
    const count = 32, positions = [], indices = [];
    for (const [z, width, height, y] of sections) {
      for (let j = 0; j < count; j++) {
        const angle = j / count * Math.PI * 2;
        const cx = Math.cos(angle), sy = Math.sin(angle);
        positions.push(Math.sign(cx) * Math.abs(cx) ** exponent * width / 2,
          y + Math.sign(sy) * Math.abs(sy) ** exponent * height / 2, z);
      }
    }
    for (let i = 0; i < sections.length - 1; i++) {
      for (let j = 0; j < count; j++) {
        const a = i * count + j, b = i * count + (j + 1) % count;
        indices.push(a, b, b + count, a, b + count, a + count);
      }
    }
    for (const [ring, reverse] of [[0, true], [sections.length - 1, false]]) {
      const center = positions.length / 3;
      positions.push(0, sections[ring][3], sections[ring][0]);
      for (let j = 0; j < count; j++) {
        const a = ring * count + j, b = ring * count + (j + 1) % count;
        indices.push(center, reverse ? b : a, reverse ? a : b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return mesh(parent, geometry, color, [0, 0, 0], kind);
  };
  const plate = (parent, points, thickness, color, position, kind = 'paint') => {
    const shape = new THREE.Shape();
    points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.025, bevelThickness: 0.025 });
    return mesh(parent, geometry, color, position, kind);
  };
  const wheel = (parent, x, y, z, radius, width, steer = false) => {
    const pivot = new THREE.Group(), spin = new THREE.Group();
    parent.add(pivot); pivot.position.set(x, y, z); pivot.add(spin);
    const tire = mesh(spin, new THREE.CylinderGeometry(radius, radius, width, 24), '#25343b', [0, 0, 0], 'rubber');
    tire.rotation.z = Math.PI / 2;
    const side = Math.sign(x);
    const rim = mesh(spin, new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width + 0.015, 24), '#e8e9df', [0, 0, 0], 'metal');
    rim.rotation.z = Math.PI / 2;
    const inset = mesh(spin, new THREE.CylinderGeometry(radius * 0.43, radius * 0.43, 0.018, 20), '#384851', [side * (width / 2 + 0.015), 0, 0], 'metal');
    inset.rotation.z = Math.PI / 2;
    for (let j = 0; j < 5; j++) {
      const angle = j * Math.PI * 2 / 5;
      rod(spin, [side * (width / 2 + 0.028), Math.cos(angle) * radius * 0.16, Math.sin(angle) * radius * 0.16],
        [side * (width / 2 + 0.028), Math.cos(angle) * radius * 0.5, Math.sin(angle) * radius * 0.5], radius * 0.045, '#e8e9df', 'metal');
    }
    sphere(spin, [0.035, radius * 0.19, radius * 0.19], '#a9b1b7', [side * (width / 2 + 0.04), 0, 0], 'metal');
    return { pivot, spin, radius, steer };
  };
  const makeActor = (name, width, depth) => {
    const actor = new THREE.Group(), body = new THREE.Group();
    actor.name = 'GEO-' + name;
    actor.add(shadow(width, depth), body);
    actor.userData.rig = { body, wheels: [] };
    return actor;
  };
  const car = makeActor('trail-4x4', 3.1, 5.1), c = car.userData.rig;
  const paint = '#e2b743', glass = '#314653', trim = '#344049';
  box(c.body, [1.77, 0.55, 3.65], paint, [0, 0.72, 0], 0.11);
  box(c.body, [1.65, 0.16, 3.6], trim, [0, 0.43, 0], 0.045, 'rubber');
  shell(c.body, [[-0.79, 1.6, 0.06, 1.04], [-0.59, 1.47, 0.67, 1.4], [1.08, 1.47, 0.67, 1.4], [1.4, 1.59, 0.08, 1.07]], glass, 'glass', 0.45);
  box(c.body, [1.62, 0.13, 1.9], '#37444b', [0, 1.77, 0.28], 0.065, 'rubber');
  box(c.body, [1.58, 0.105, 0.99], paint, [0, 1.035, -1.32], 0.045);
  for (const side of [-1, 1]) {
    rod(c.body, [side * 0.79, 1.08, -0.79], [side * 0.72, 1.72, -0.59], 0.035, paint);
    rod(c.body, [side * 0.79, 1.08, 1.38], [side * 0.72, 1.72, 1.08], 0.035, paint);
    box(c.body, [0.05, 0.61, 0.09], paint, [side * 0.765, 1.39, 0.15], 0.018);
    box(c.body, [0.035, 0.045, 2.12], paint, [side * 0.836, 1.06, 0.24], 0.015);
    for (const z of [-1.08, 1.05]) {
      box(c.body, [0.21, 0.13, 0.98], trim, [side * 0.9, 0.86, z], 0.045, 'rubber');
      c.wheels.push(wheel(c.body, side * 0.91, 0.425, z, 0.425, 0.25, z < 0));
    }
    box(c.body, [0.24, 0.12, 0.25], paint, [side * 0.96, 1.23, -0.58], 0.035);
    box(c.body, [0.025, 0.075, 0.18], glass, [side * 1.09, 1.23, -0.58], 0.018, 'glass');
    for (const z of [-0.14, 0.82]) box(c.body, [0.04, 0.04, 0.17], '#e5e5d8', [side * 0.9, 0.94, z], 0.012, 'metal');
    const lamp = mesh(c.body, new THREE.CylinderGeometry(0.155, 0.155, 0.065, 24), '#f8edc3', [side * 0.56, 0.8, -1.845], 'lamp');
    lamp.rotation.x = Math.PI / 2;
    box(c.body, [0.17, 0.21, 0.06], '#b94d39', [side * 0.67, 0.76, 1.84], 0.035, 'lamp');
    rod(c.body, [side * 0.53, 1.84, -0.42], [side * 0.53, 1.84, 0.96], 0.025, '#9aa6a8', 'metal');
  }
  box(c.body, [1.84, 0.14, 0.17], trim, [0, 0.49, -1.87], 0.045, 'rubber');
  box(c.body, [1.84, 0.14, 0.17], trim, [0, 0.49, 1.87], 0.045, 'rubber');
  box(c.body, [0.58, 0.33, 0.04], '#28383f', [0, 0.78, -1.85], 0.025, 'rubber');
  for (let j = 0; j < 5; j++) box(c.body, [0.035, 0.25, 0.025], '#b1b8ad', [-0.22 + j * 0.11, 0.78, -1.88], 0.009, 'metal');
  const spare = mesh(c.body, new THREE.CylinderGeometry(0.33, 0.33, 0.23, 24), '#29373d', [0, 1, 1.92], 'rubber');
  spare.rotation.x = Math.PI / 2;
  const spareHub = mesh(c.body, new THREE.CylinderGeometry(0.17, 0.17, 0.245, 20), '#afb6ae', [0, 1, 1.92], 'metal');
  spareHub.rotation.x = Math.PI / 2;
  box(c.body, [0.99, 0.25, 0.67], '#779184', [0, 1.99, 0.27], 0.055, 'cloth');
  for (const x of [-0.32, 0.32]) box(c.body, [0.045, 0.26, 0.68], '#c9b993', [x, 1.99, 0.27], 0.012, 'cloth');

  const walker = makeActor('traveller', 1.1, 1.1), p = walker.userData.rig;
  // A stylized outdoor hiker with measured joint lengths and planted feet.
  // These dimensions also drive the two-bone foot contact calculation below.
  p.leg = { upper: 0.43, lower: 0.435, hipHeight: 0.94, ankleHeight: 0.075 };
  const upright = (parent, sections, color, kind = 'cloth') => {
    const part = shell(parent, [...sections].sort((a, b) => a[0] - b[0]).map(([y, w, d, z = 0]) => [y, w, d, -z]), color, kind, 0.8);
    part.rotation.x = -Math.PI / 2;
    return part;
  };
  p.torso = new THREE.Group(); p.body.add(p.torso);
  upright(p.torso, [[1, 0.27, 0.17], [1.09, 0.3, 0.19], [1.29, 0.38, 0.225], [1.42, 0.415, 0.21], [1.49, 0.245, 0.145]], '#d87948');
  box(p.torso, [0.27, 0.052, 0.18], '#a95c3c', [0, 1.025, 0], 0.014, 'cloth');
  box(p.torso, [0.009, 0.36, 0.008], '#a2a9ac', [0, 1.26, -0.116], 0.003, 'metal');
  for (const side of [-1, 1]) {
    rod(p.torso, [side * 0.075, 1.47, -0.065], [side * 0.025, 1.405, -0.114], 0.022, '#e2a26b', 'cloth');
    rod(p.torso, [side * 0.14, 1.12, -0.097], [side * 0.08, 1.18, -0.112], 0.006, '#8c513c', 'cloth');
  }
  rod(p.torso, [0, 1.48, 0], [0, 1.57, -0.005], 0.047, '#ba8d72', 'skin');
  p.head = new THREE.Group(); p.head.position.set(0, 1.641, -0.007); p.head.scale.setScalar(1.08); p.torso.add(p.head);
  sphere(p.head, [0.081, 0.116, 0.091], '#c99e82', [0, 0, 0], 'skin');
  sphere(p.head, [0.063, 0.058, 0.074], '#c2957b', [0, -0.052, -0.008], 'skin');
  for (const side of [-1, 1]) {
    sphere(p.head, [0.016, 0.027, 0.014], '#bf9178', [side * 0.081, -0.004, 0], 'skin');
    sphere(p.head, [0.008, 0.005, 0.004], '#3d3c38', [side * 0.031, 0.014, -0.087], 'skin');
    rod(p.head, [side * 0.018, 0.035, -0.081], [side * 0.044, 0.035, -0.076], 0.004, '#493e37', 'cloth');
  }
  sphere(p.head, [0.014, 0.024, 0.024], '#c19479', [0, -0.012, -0.091], 'skin');
  rod(p.head, [-0.018, -0.049, -0.075], [0.018, -0.049, -0.075], 0.003, '#946f60', 'skin');
  // Short hair, a cap and rolled sleeping mat read clearly from a map view.
  const hair = mesh(p.head, new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), '#302d2a', [0, 0.026, 0.007], 'cloth');
  hair.scale.set(0.083, 0.101, 0.09);
  for (const side of [-1, 1]) box(p.head, [0.012, 0.048, 0.038], '#302d2a', [side * 0.076, 0.009, 0.018], 0.005, 'cloth');
  const cap = sphere(p.head, [0.088, 0.065, 0.095], '#52737b', [0, 0.087, 0.004], 'cloth');
  box(p.head, [0.14, 0.013, 0.09], '#45666e', [0, 0.069, -0.09], 0.012, 'cloth');
  box(p.torso, [0.29, 0.42, 0.17], '#557c74', [0, 1.284, 0.19], 0.044, 'cloth');
  box(p.torso, [0.215, 0.14, 0.035], '#71958a', [0, 1.19, 0.29], 0.022, 'cloth');
  box(p.torso, [0.2, 0.06, 0.15], '#668b7e', [0, 1.473, 0.164], 0.022, 'cloth');
  const bedroll = mesh(p.torso, new THREE.CylinderGeometry(0.068, 0.068, 0.3, 16), '#b78661', [0, 1.54, 0.21], 'cloth');
  bedroll.rotation.z = Math.PI / 2;
  for (const side of [-1, 1]) {
    rod(p.torso, [side * 0.135, 1.44, 0.13], [side * 0.155, 1.14, -0.09], 0.016, '#334e4d', 'cloth');
    box(p.torso, [0.022, 0.035, 0.013], '#7a8586', [side * 0.148, 1.2, -0.067], 0.004, 'metal');
  }
  box(p.body, [0.28, 0.19, 0.175], '#445d68', [0, 0.974, 0], 0.04, 'cloth');
  p.limbs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(side * 0.09, p.leg.hipHeight, 0); p.body.add(hip);
    upright(hip, [[0.045, 0.14, 0.16], [-0.09, 0.145, 0.15], [-0.29, 0.112, 0.12], [-0.43, 0.105, 0.11]], '#445d68');
    const knee = new THREE.Group(); knee.position.y = -p.leg.upper; hip.add(knee);
    upright(knee, [[0.035, 0.11, 0.12], [-0.13, 0.115, 0.125], [-0.32, 0.085, 0.09], [-0.435, 0.079, 0.088]], '#405763');
    const ankle = new THREE.Group(); ankle.position.y = -p.leg.lower; knee.add(ankle);
    box(ankle, [0.098, 0.09, 0.25], '#795c45', [0, -0.0225, -0.047], 0.021, 'cloth');
    box(ankle, [0.102, 0.015, 0.255], '#313b3c', [0, -0.0675, -0.047], 0.006, 'rubber');
    for (const z of [-0.035, -0.006, 0.022]) box(ankle, [0.055, 0.006, 0.008], '#858c8e', [0, 0.025, z], 0.002, 'cloth');
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.219, 1.422, 0); p.torso.add(shoulder);
    upright(shoulder, [[0.053, 0.025, 0.03], [0.025, 0.11, 0.115], [-0.09, 0.12, 0.13], [-0.245, 0.095, 0.105], [-0.29, 0.088, 0.095]], '#d87948');
    const elbow = new THREE.Group(); elbow.position.set(side * 0.014, -0.29, 0); shoulder.add(elbow);
    upright(elbow, [[0.025, 0.09, 0.096], [-0.1, 0.08, 0.087], [-0.23, 0.067, 0.075]], '#d87948');
    sphere(elbow, [0.034, 0.068, 0.025], '#c99e82', [0, -0.279, -0.003], 'skin');
    sphere(elbow, [0.017, 0.034, 0.018], '#bc9077', [-side * 0.024, -0.258, -0.019], 'skin');
    shoulder.rotation.z = side * 0.055;
    p.limbs.push({ side, hip, knee, ankle, shoulder, elbow });
  }
  // Upper-body sway pivots at the waist, without displacing the planted legs.
  p.torso.position.y = 1.02;
  for (const part of p.torso.children) part.position.y -= 1.02;

  const bus = makeActor('city-bus', 3, 8), b = bus.userData.rig;
  box(b.body, [2.02, 1.71, 5.7], '#e0e3e5', [0, 1.35, 0], 0.25);
  box(b.body, [2.055, 0.48, 5.57], '#3e82a0', [0, 0.84, 0], 0.1);
  box(b.body, [1.84, 0.15, 4.9], '#c3c9cd', [0, 2.24, 0.04], 0.07);
  box(b.body, [1.33, 0.15, 1.37], '#969fa6', [0, 2.37, 0.65], 0.06);
  box(b.body, [1.73, 0.85, 0.045], '#172831', [0, 1.66, -2.862], 0.075, 'glass');
  box(b.body, [1.26, 0.16, 0.05], '#253c40', [0, 2.03, -2.895], 0.025);
  // A geometric destination sign stays legible without texture/font requests.
  for (let j = 0; j < 6; j++) box(b.body, [j === 0 ? 0.13 : 0.08, 0.045, 0.016], '#f5cc7c', [-0.42 + j * 0.16, 2.03, -2.927], 0.008, 'lamp');
  box(b.body, [1.68, 0.72, 0.04], '#1b2b35', [0, 1.65, 2.862], 0.06, 'glass');
  box(b.body, [1.7, 0.13, 0.14], '#8d979f', [0, 0.51, -2.87], 0.03, 'metal');
  for (const side of [-1, 1]) {
    for (const z of [-1.84, -0.85, 0.14, 1.13, 2.08]) {
      box(b.body, [0.045, 0.72, 0.78], '#172a35', [side * 1.023, 1.7, z], 0.03, 'glass');
      box(b.body, [0.055, 0.024, 0.65], '#8d9aa3', [side * 1.05, 1.49, z], 0.01, 'metal');
    }
    for (const z of [-1.8, 1.82]) b.wheels.push(wheel(b.body, side * 1.01, 0.46, z, 0.46, 0.22, z < 0));
    rod(b.body, [side * 1, 1.9, -2.53], [side * 1.19, 1.82, -2.62], 0.025, '#303b43', 'metal');
    box(b.body, [0.14, 0.24, 0.17], '#34526b', [side * 1.2, 1.73, -2.62], 0.045);
    box(b.body, [0.34, 0.14, 0.06], '#fff1c8', [side * 0.65, 0.79, -2.895], 0.04, 'lamp');
    box(b.body, [0.18, 0.28, 0.06], '#d2664e', [side * 0.77, 0.82, 2.892], 0.04, 'lamp');
  }
  for (const z of [-1.56, 0.94]) {
    box(b.body, [0.045, 1.25, 0.76], '#28484e', [1.055, 1.16, z], 0.035, 'glass');
    box(b.body, [0.045, 1.16, 0.028], '#929fa7', [1.085, 1.16, z], 0.009, 'metal');
    box(b.body, [0.07, 0.08, 0.74], '#979fa5', [1.075, 0.55, z], 0.02);
  }
  for (let j = 0; j < 6; j++) box(b.body, [0.65, 0.026, 0.02], '#5a6771', [0, 0.81 + j * 0.07, 2.872], 0.008);

  const makeTrain = (metro) => {
    const actor = makeActor(metro ? 'metro' : 'express', 2.9, metro ? 11 : 12), rig = actor.userData.rig;
    rig.coaches = [];
    const accent = metro ? '#4e9e94' : '#427eaa';
    // Two coaches are centered on the actor origin so long vehicles fit frames.
    for (let i = 0; i < 2; i++) {
      const coach = new THREE.Group(); coach.position.z = -1.86 + i * 3.9; rig.body.add(coach);
      rig.coaches.push(coach);
      const sections = i > 0
        ? [[-1.8, 1.64, 1.26, 1.12], [-1.59, 1.84, 1.45, 1.13], [1.59, 1.84, 1.45, 1.13], [1.8, 1.65, 1.26, 1.12]]
        : metro
          ? [[-1.83, 1.52, 0.9, 1.01], [-1.57, 1.87, 1.48, 1.16], [1.59, 1.87, 1.48, 1.16], [1.8, 1.66, 1.24, 1.12]]
          : [[-1.95, 0.43, 0.48, 0.63], [-1.58, 1.33, 0.85, 0.83], [-0.96, 1.79, 1.34, 1.08], [1.55, 1.8, 1.39, 1.1], [1.8, 1.6, 1.15, 1.08]];
      shell(coach, sections, '#e0e3e6');
      box(coach, [1.65, 0.13, 2.8], accent, [0, 0.78, 0.12], 0.05);
      box(coach, [1.55, 0.13, 2.6], '#a7afb7', [0, 1.81, 0.17], 0.05);
      for (const side of [-1, 1]) {
        for (const z of [-0.67, 0.03, 0.73, 1.34]) box(coach, [0.04, 0.4, 0.47], '#1a2c39', [side * 0.896, 1.35, z], 0.07, 'glass');
        box(coach, [0.044, 0.12, 2.7], accent, [side * 0.9, 1.02, 0.22], 0.035);
        if (metro) {
          for (const z of [-0.95, 0.95]) {
            box(coach, [0.045, 0.92, 0.48], '#b9c1c8', [side * 0.94, 1.12, z], 0.04);
            box(coach, [0.05, 0.36, 0.37], '#1a2c39', [side * 0.97, 1.35, z], 0.035, 'glass');
            box(coach, [0.06, 0.8, 0.018], '#566873', [side * 0.98, 1.09, z], 0.006);
          }
        }
        for (const z of [-0.9, 1.03]) rig.wheels.push(wheel(coach, side * 0.68, 0.28, z, 0.25, 0.18));
      }
      if (i === 0) {
        const windshield = box(coach, [metro ? 1.32 : 1.14, metro ? 0.59 : 0.48, 0.075], '#182a35', [0, metro ? 1.27 : 1.27, metro ? -1.813 : -1.313], 0.13, 'glass');
        windshield.rotation.x = metro ? -0.24 : -0.69;
        for (const side of [-1, 1]) box(coach, [0.28, 0.085, 0.065], '#fff4d7', [side * 0.49, metro ? 0.92 : 0.82, metro ? -1.845 : -1.69], 0.035, 'lamp');
      }
    }
    rig.coupler = new THREE.Group();
    rig.coupler.position.z = 0.09;
    rig.body.add(rig.coupler);
    box(rig.coupler, [1.3, 1.03, 0.2], '#323c43', [0, 1.11, 0], 0.08, 'rubber');
    for (const z of [-0.11, -0.04, 0.03, 0.1]) box(rig.coupler, [1.34, 1.04, 0.026], '#56616a', [0, 1.11, z], 0.01, 'rubber');
    return actor;
  };
  const subway = makeTrain(true), train = makeTrain(false);

  const boat = makeActor('coastal-ferry', 3.3, 6.3), f = boat.userData.rig;
  shell(f.body, [[-2.35, 0.08, 0.18, 0.53], [-1.73, 1.65, 0.7, 0.5], [-0.6, 2.05, 0.77, 0.48], [1.65, 1.96, 0.68, 0.46], [2, 1.55, 0.52, 0.46]], '#2d414e', 'paint', 0.78);
  shell(f.body, [[-2.23, 0.11, 0.1, 0.83], [-1.65, 1.7, 0.13, 0.88], [-0.6, 2.08, 0.13, 0.9], [1.65, 2, 0.13, 0.85], [1.96, 1.55, 0.1, 0.76]], '#c9d0d5');
  box(f.body, [1.49, 0.76, 2.3], '#d9dee1', [0, 1.28, 0.17], 0.15);
  box(f.body, [1.3, 0.32, 0.045], '#213744', [0, 1.4, -1.001], 0.065, 'glass');
  for (const side of [-1, 1]) {
    for (const z of [-0.45, 0.15, 0.75]) box(f.body, [0.045, 0.32, 0.46], '#213744', [side * 0.751, 1.4, z], 0.065, 'glass');
    for (const z of [-1.38, -0.6, 0.2, 1, 1.65]) rod(f.body, [side * 0.84, 0.92, z], [side * 0.84, 1.11, z], 0.018, '#aab5bd', 'metal');
    rod(f.body, [side * 0.84, 1.11, -1.38], [side * 0.84, 1.11, 1.65], 0.019, '#aab5bd', 'metal');
    const lifering = mesh(f.body, new THREE.TorusGeometry(0.16, 0.047, 10, 24), '#de8153', [side * 0.81, 1.1, 0.62]);
    lifering.rotation.y = Math.PI / 2;
  }
  box(f.body, [1.68, 0.12, 2.59], '#d4b568', [0, 1.72, 0.19], 0.06);
  rod(f.body, [0, 1.75, 0.45], [0, 2.36, 0.45], 0.027, '#d8ded2', 'metal');
  rod(f.body, [-0.31, 2.04, 0.45], [0.31, 2.04, 0.45], 0.022, '#d8ded2', 'metal');
  box(f.body, [0.19, 0.27, 0.28], '#657782', [0, 1.91, 0.89], 0.055);
  // Short, translucent wake ribbons belong to the boat, never the route geometry.
  f.wake = new THREE.Group(); boat.add(f.wake);
  const wakeMaterial = new THREE.MeshBasicMaterial({ color: '#e2f2e9', transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([side * 0.7, 0.04, 1.5, side * 1.3, 0.04, 3.2, side * 0.95, 0.04, 1.6, side * 1.62, 0.04, 3.7], 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    f.wake.add(new THREE.Mesh(geometry, wakeMaterial));
  }

  const plane = makeActor('airliner', 6.6, 7.7), a = plane.userData.rig;
  shell(a.body, [[-3.15, 0.08, 0.12, 1.24], [-2.74, 0.64, 0.64, 1.3], [-1.9, 0.99, 0.99, 1.34], [1.7, 0.94, 0.94, 1.34], [2.78, 0.28, 0.37, 1.43], [3.04, 0.04, 0.08, 1.48]], '#e0e3e5', 'paint', 1);
  for (const side of [-1, 1]) {
    const wing = plate(a.body, [[side * 0.34, -0.8], [side * 1.06, -0.61], [side * 3.35, 1.15], [side * 3.43, 1.55], [side * 0.4, 0.75]], 0.07, '#b6c0c8', [0, 1.17, 0]);
    wing.rotation.x = Math.PI / 2;
    const tail = plate(a.body, [[0, 0], [side * 1.42, 0.71], [side * 1.46, 1.03], [0, 0.66]], 0.06, '#d06b48', [0, 1.55, 1.87]);
    tail.rotation.x = Math.PI / 2;
    const engine = mesh(a.body, new THREE.CylinderGeometry(0.23, 0.27, 0.94, 24), '#c5cdd3', [side * 1.22, 0.87, -0.15]);
    engine.rotation.x = Math.PI / 2;
    const intake = mesh(a.body, new THREE.CylinderGeometry(0.18, 0.18, 0.035, 24), '#1e2c37', [side * 1.22, 0.87, -0.63], 'metal');
    intake.rotation.x = Math.PI / 2;
    for (let j = 0; j < 9; j++) sphere(a.body, [0.012, 0.055, 0.072], '#233846', [side * 0.491, 1.5, -1.43 + j * 0.32], 'glass');
    sphere(a.body, [0.055, 0.035, 0.055], side < 0 ? '#df785b' : '#9cbd90', [side * 3.36, 1.16, 1.38], 'lamp');
  }
  plate(a.body, [[0, 0], [0, 1.23], [0.42, 1.08], [1.2, 0]], 0.07, '#d06b48', [-0.035, 1.54, 1.78]).rotation.y = -Math.PI / 2;
  // Cockpit glazing follows the fuselage surface instead of a bubble canopy.
  for (const side of [-1, 1]) {
    const glazing = new THREE.BufferGeometry();
    glazing.setAttribute('position', new THREE.Float32BufferAttribute([
      side * 0.02, 1.646, -2.68, side * 0.22, 1.567, -2.68,
      side * 0.27, 1.596, -2.42, side * 0.02, 1.708, -2.42
    ], 3));
    glazing.setIndex([0, 1, 2, 0, 2, 3]);
    glazing.computeVertexNormals();
    const window = mesh(a.body, glazing, '#172a35', [0, 0, 0], 'glass');
    window.material.side = THREE.DoubleSide;
    for (let j = 0; j < 8; j++) {
      const angle = j * Math.PI / 4;
      rod(a.body, [side * 1.22 + Math.cos(angle) * 0.04, 0.87 + Math.sin(angle) * 0.04, -0.654],
        [side * 1.22 + Math.cos(angle + 0.32) * 0.16, 0.87 + Math.sin(angle + 0.32) * 0.16, -0.654], 0.009, '#788995', 'metal');
    }
  }

  // Stretch the body and joint locations, preserving circular tires and rims.
  // Scaling an entire actor would turn the wheels into ellipses.
  function lengthen(actor, factor) {
    const wheelPivots = new Set(actor.userData.rig.wheels.map(wheel => wheel.pivot));
    function stretch(group) {
      for (const child of group.children) {
        if (child.isMesh) {
          child.updateMatrix();
          child.geometry.applyMatrix4(child.matrix).scale(1, 1, factor);
          child.position.set(0, 0, 0);
          child.rotation.set(0, 0, 0);
          child.scale.set(1, 1, 1);
        } else {
          child.position.z *= factor;
          if (!wheelPivots.has(child)) stretch(child);
        }
      }
    }
    stretch(actor.userData.rig.body);
    const rig = actor.userData.rig;
    if (rig.coaches) {
      rig.coachOffsets = rig.coaches.map(coach => coach.position.z);
      rig.coachHalfLength = 1.8 * factor;
      rig.couplerDepth = 0.3 * factor;
    }
  }
  lengthen(bus, 1.18);
  lengthen(subway, 1.25);
  lengthen(train, 1.4);
  lengthen(boat, 1.15);
  lengthen(plane, 1.05);

  const actors = { car, walker, bus, subway, train, boat, plane };
  // Batch fixed pieces per material within each joint. Wheel, head and limb
  // groups remain separate, while trim details don't each cost a draw call.
  function batchFixedParts(group) {
    const batches = new Map();
    for (const child of [...group.children]) {
      if (child.isGroup) batchFixedParts(child);
      if (!child.isMesh || child.material.transparent || child.material.map) continue;
      if (!batches.has(child.material)) batches.set(child.material, []);
      batches.get(child.material).push(child);
    }
    for (const [material, parts] of batches) {
      if (parts.length < 2) continue;
      const geometries = parts.map(part => {
        part.updateMatrix();
        const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
        geometry.deleteAttribute('uv');
        return geometry.applyMatrix4(part.matrix);
      });
      const combined = new THREE.Mesh(mergeGeometries(geometries), material);
      combined.name = 'GEO-batched-detail';
      group.add(combined);
      for (const part of parts) { group.remove(part); part.geometry.dispose(); }
      for (const geometry of geometries) geometry.dispose();
    }
  }
  const ink = new THREE.MeshBasicMaterial({ color: '#28383f', side: THREE.BackSide });
  ink.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed += normal * 0.012;');
  };
  ink.customProgramCacheKey = () => 'travel-model-ink-v1';
  for (const actor of Object.values(actors)) {
    batchFixedParts(actor);
    actor.traverse(object => {
      if (!object.isMesh) return;
      object.renderOrder = 10;
      object.castShadow = !object.material.transparent;
      object.receiveShadow = !object.material.transparent;
    });
    const surfaces = [];
    actor.traverse(object => { if (object.isMesh && object.material.userData.ink) surfaces.push(object); });
    for (const surface of surfaces) {
      const outline = new THREE.Mesh(surface.geometry, ink);
      outline.name = 'GEO-silhouette';
      outline.renderOrder = 9;
      surface.add(outline);
    }
  }
  return actors;
}

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };

// Local-space samples keep each coach aligned to the same route while the
// flexible bellows connects the two facing ends. No previous frame is needed.
export function articulateRail(actor, samples) {
  const rig = actor.userData.rig;
  if (!rig.coaches || samples.length !== rig.coaches.length) return;
  rig.coaches.forEach((coach, index) => {
    const sample = samples[index];
    coach.position.set(sample.x, sample.y, sample.z);
    coach.rotation.y = sample.heading;
  });
  const [front, rear] = samples, half = rig.coachHalfLength;
  const a = { x: front.x + Math.sin(front.heading) * half, z: front.z + Math.cos(front.heading) * half };
  const b = { x: rear.x - Math.sin(rear.heading) * half, z: rear.z - Math.cos(rear.heading) * half };
  rig.coupler.position.set((a.x + b.x) / 2, (front.y + rear.y) / 2, (a.z + b.z) / 2);
  rig.coupler.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  rig.coupler.scale.z = clamp(Math.hypot(b.x - a.x, b.z - a.z) / rig.couplerDepth, 0.25, 5);
}

// Integrate a smooth speed ramp at each end; endpoints and event timings stay
// exact, while both the actor and its painted trail accelerate and settle.
export function travelProgress(elapsed, duration) {
  if (duration <= 0) return elapsed >= 0 ? 1 : 0;
  const t = clamp(elapsed, 0, duration), ramp = Math.min(0.3, duration * 0.15);
  const integral = u => u ** 3 - u ** 4 / 2;
  const distance = t < ramp ? ramp * integral(t / ramp)
    : t > duration - ramp ? duration - ramp - ramp * integral((duration - t) / ramp)
      : t - ramp / 2;
  return distance / (duration - ramp);
}

// No accumulated deltas or random values: arbitrary seeks produce identical poses.
export function animateTravelActor(actor, { time, travelTime = time, travelDuration, moving = true, turn = 0, arrival = 0 }) {
  const rig = actor.userData.rig;
  const motion = moving ? smooth(travelTime / 0.28) * (1 - smooth(arrival)) : 0;
  const distanceTime = travelDuration ? travelProgress(travelTime, travelDuration) * travelDuration : travelTime;
  const phase = distanceTime * 6.6;
  const steering = clamp(turn, -1, 1);
  rig.body.position.y = 0;
  rig.body.rotation.set(0, 0, 0);
  for (const wheel of rig.wheels) {
    wheel.spin.rotation.x = -distanceTime * 2.7 / wheel.radius;
    wheel.pivot.rotation.y = wheel.steer ? steering * 0.32 * motion : 0;
  }
  if (rig.limbs) {
    rig.body.position.y = (-0.028 + Math.cos(phase * 2) * 0.006) * motion;
    const idle = 1 - motion;
    rig.torso.rotation.set(0.025 * motion + Math.sin(time * 1.7) * 0.006 * idle, Math.sin(phase) * 0.025 * motion, Math.sin(phase) * 0.012 * motion);
    rig.head.rotation.set(-0.035 * motion, -Math.sin(phase) * 0.04 * motion + Math.sin(time * 0.8) * 0.045 * idle, 0);
    for (const limb of rig.limbs) {
      const step = phase + (limb.side < 0 ? Math.PI : 0);
      const swing = Math.sin(step), lift = Math.max(0, -Math.cos(step));
      // Two-bone IK: the support shoe stays on the ground while the other
      // foot clears it, rather than both rigid legs skating above the map.
      const footZ = swing * 0.2 * motion;
      const { upper, lower, hipHeight, ankleHeight } = rig.leg;
      const footY = ankleHeight - hipHeight - rig.body.position.y + lift * 0.055 * motion;
      const reach = clamp(Math.hypot(footZ, footY), 0.02, upper + lower - 0.00001);
      const bend = Math.PI - Math.acos(clamp((upper ** 2 + lower ** 2 - reach ** 2) / (2 * upper * lower), -1, 1));
      const hip = Math.atan2(-footZ, -footY) - Math.acos(clamp((upper ** 2 + reach ** 2 - lower ** 2) / (2 * upper * reach), -1, 1));
      limb.hip.rotation.x = motion ? hip : 0;
      limb.knee.rotation.x = motion ? bend : 0;
      limb.ankle.rotation.x = motion ? -hip - bend : 0;
      limb.shoulder.rotation.x = -swing * 0.22 * motion;
      limb.elbow.rotation.x = -0.1 - Math.max(0, swing) * 0.13 * motion;
    }
  } else if (rig.wake) {
    rig.body.rotation.x = Math.sin(time * 1.8) * 0.008;
    rig.body.rotation.z = Math.sin(time * 2.1 + 0.7) * 0.01 - steering * 0.025 * motion;
    rig.body.position.y = Math.sin(time * 2.1) * 0.012;
    rig.wake.visible = moving;
    rig.wake.scale.z = 0.9 + Math.sin(time * 3) * 0.08;
  } else if (actor.name === 'GEO-airliner') {
    rig.body.rotation.z = -steering * 0.1 * motion;
    rig.body.position.y = 0.22 + Math.sin(time * 1.4) * 0.012;
  } else {
    rig.body.rotation.z = rig.coaches ? 0 : -steering * 0.025 * motion;
    rig.body.position.y = Math.sin(travelTime * 10) * 0.003 * motion;
  }
}
