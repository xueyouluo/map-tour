import { expect, it } from 'vitest';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { selectVehicle, createTravelActors, animateTravelActor, articulateRail, travelProgress } from './browser/vehicles.js';
it('uses vehicles for all declared modes and defaults generic public transit to a bus', () => {
  for (const [mode, expected] of Object.entries({
    walking: 'walker',
    driving: 'car',
    bus: 'bus',
    subway: 'subway',
    rail: 'train',
    ferry: 'boat',
    flight: 'plane',
    transit: 'bus'
  }))
    expect(selectVehicle({ mode })).toBe(expected);
});
it('uses structured transfer evidence before label guesses without treating access walking as the whole trip', () => {
  expect(
    selectVehicle({
      mode: 'transit',
      transport: {
        label: '公交',
        steps: [
          { mode: 'walking', durationMinutes: 20 },
          { mode: 'subway', durationMinutes: 12 }
        ]
      }
    })
  ).toBe('subway');
  expect(
    selectVehicle({
      mode: 'transit',
      transport: {
        steps: [
          { mode: 'bus', durationMinutes: 8 },
          { mode: 'subway', durationMinutes: 25 }
        ]
      }
    })
  ).toBe('subway');
  expect(
    selectVehicle({
      mode: 'transit',
      transport: { label: '地铁+步行（推断）' }
    })
  ).toBe('subway');
  expect(
    selectVehicle({ mode: 'bus', transport: { label: '地铁+公交' } })
  ).toBe('bus');
});

// Validate the real geometry/rig contract; no DOM, WebGL or remote assets needed.
const actors = createTravelActors(THREE, RoundedBoxGeometry);

it('eases departure and arrival without changing route endpoints or reversing progress', () => {
  for (const duration of [0.2, 2, 6.5, 90]) {
    expect(travelProgress(-1, duration)).toBe(0);
    expect(travelProgress(duration + 1, duration)).toBe(1);
    expect(travelProgress(duration / 2, duration)).toBeCloseTo(0.5);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const next = travelProgress(duration * i / 100, duration);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
    expect(travelProgress(0.001, duration)).toBeLessThan(0.001 / duration);
  }
});

it('keeps every model grounded, centered and within a bounded render budget', () => {
  for (const [kind, actor] of Object.entries(actors)) {
    const bounds = new THREE.Box3().setFromObject(actor);
    expect(bounds.min.y, kind).toBeGreaterThanOrEqual(-0.01);
    expect(Math.abs(bounds.getCenter(new THREE.Vector3()).x), kind).toBeLessThan(0.1);
    expect(Math.abs(bounds.getCenter(new THREE.Vector3()).z), kind).toBeLessThan(1);
    let meshes = 0, triangles = 0;
    actor.traverse(part => {
      if (!part.isMesh) return;
      meshes++;
      triangles += (part.geometry.index?.count || part.geometry.attributes.position.count) / 3;
      expect([...part.geometry.attributes.position.array].every(Number.isFinite), kind).toBe(true);
    });
    expect(meshes, kind).toBeLessThan(85);
    expect(triangles, kind).toBeLessThan(90000);
  }
});

it('plants the support shoe and clears the swinging foot over a full stride', () => {
  const actor = actors.walker;
  for (let step = 0; step < 24; step++) {
    const time = 1 + step / 24 * Math.PI * 2 / 6.6;
    animateTravelActor(actor, { time, moving: true });
    actor.updateMatrixWorld(true);
    const soles = actor.userData.rig.limbs.map(limb => new THREE.Box3().setFromObject(limb.ankle).min.y);
    expect(Math.min(...soles)).toBeGreaterThan(-0.005);
    expect(Math.min(...soles)).toBeLessThan(0.005);
    expect(Math.max(...soles)).toBeLessThan(0.06);
  }
});

it('preserves circular tires when bus and railway bodies are lengthened', () => {
  for (const actor of [actors.bus, actors.subway, actors.train]) {
    animateTravelActor(actor, { time: 0, travelTime: 0, moving: false });
    for (const wheel of actor.userData.rig.wheels) {
      const tire = wheel.spin.children.find(part => part.isMesh && part.material.roughness === 0.9);
      const size = new THREE.Box3().setFromObject(tire).getSize(new THREE.Vector3());
      expect(size.y).toBeCloseTo(wheel.radius * 2, 5);
      expect(size.z).toBeCloseTo(wheel.radius * 2, 5);
    }
  }
});

it('reproduces poses after seeking and stops wheels at the arrival phase', () => {
  for (const actor of Object.values(actors)) {
    const pose = () => {
      actor.updateMatrixWorld(true);
      const matrices = [];
      actor.traverse(part => matrices.push(...part.matrixWorld.elements));
      return matrices;
    };
    const frame = { time: 2.7, travelTime: 2.1, moving: true, turn: 0.6 };
    animateTravelActor(actor, frame);
    const first = pose();
    animateTravelActor(actor, { time: 8, travelTime: 6, moving: false });
    animateTravelActor(actor, frame);
    expect(pose()).toEqual(first);
    animateTravelActor(actor, { time: 8, travelTime: 6, moving: false });
    const wheelAngles = actor.userData.rig.wheels.map(w => w.spin.rotation.x);
    animateTravelActor(actor, { time: 10, travelTime: 6, moving: false });
    expect(actor.userData.rig.wheels.map(w => w.spin.rotation.x)).toEqual(wheelAngles);
  }
});

it('aligns each railway coach separately and joins the facing carriage ends', () => {
  const train = createTravelActors(THREE, RoundedBoxGeometry).train, rig = train.userData.rig;
  const straight = rig.coachOffsets.map(z => ({ x: 0, y: 0, z, heading: 0 }));
  articulateRail(train, straight);
  expect(rig.coupler.scale.z).toBeCloseTo(1);
  const curved = straight.map((sample, index) => ({ ...sample, x: index ? -0.35 : 0.3, y: index * 0.04, heading: index ? -0.15 : 0.2 }));
  articulateRail(train, curved);
  expect(rig.coaches.map(coach => coach.rotation.y)).toEqual([0.2, -0.15]);
  const a = rig.coaches[0].localToWorld(new THREE.Vector3(0, 0, rig.coachHalfLength));
  const b = rig.coaches[1].localToWorld(new THREE.Vector3(0, 0, -rig.coachHalfLength));
  expect(rig.coupler.position.x).toBeCloseTo((a.x + b.x) / 2);
  expect(rig.coupler.position.z).toBeCloseTo((a.z + b.z) / 2);
  expect(rig.coupler.rotation.y).toBeCloseTo(Math.atan2(b.x - a.x, b.z - a.z));
  const pose = rig.coupler.position.toArray();
  articulateRail(train, straight);
  articulateRail(train, curved);
  expect(rig.coupler.position.toArray()).toEqual(pose);
  expect(rig.coupler.scale.z).toBeGreaterThan(0);
});
