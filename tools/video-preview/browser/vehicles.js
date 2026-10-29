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

export function createPublicTransportModels(THREE, rounded, shadow) {
  const bus = new THREE.Group(),
    busWheels = [];
  bus.name = 'GEO-city-bus';
  bus.add(shadow(3.1, 7.1));
  bus.add(rounded(2.05, 1.65, 5.75, '#e8f2f5', 0, 1.35, 0, 0.21));
  bus.add(rounded(2.09, 0.48, 5.62, '#3d89c4', 0, 0.85, 0, 0.1));
  bus.add(rounded(1.86, 0.21, 5.05, '#83bde0', 0, 2.22, 0.02, 0.1));
  bus.add(rounded(1.5, 0.18, 1.28, '#cad9df', 0, 2.39, 0.8, 0.07));
  // Front glass, route display, bumpers and lamps face the same -Z axis as the car.
  bus.add(rounded(1.78, 0.84, 0.05, '#204553', 0, 1.67, -2.89, 0.045));
  bus.add(rounded(1.28, 0.2, 0.055, '#f9d671', 0, 2.05, -2.93, 0.025));
  bus.add(rounded(1.78, 0.15, 0.12, '#345268', 0, 0.51, -2.88, 0.04));
  bus.add(rounded(1.7, 0.74, 0.05, '#2b5464', 0, 1.63, 2.89, 0.04));
  for (const side of [-1, 1]) {
    for (const z of [-1.83, -0.86, 0.11, 1.08, 2.02])
      bus.add(
        rounded(0.045, 0.72, 0.77, '#285564', side * 1.04, 1.68, z, 0.025)
      );
    bus.add(
      rounded(0.18, 0.18, 0.34, '#3d89c4', side * 1.12, 1.69, -2.43, 0.035)
    );
    bus.add(
      rounded(0.35, 0.16, 0.08, '#fff4bf', side * 0.66, 0.76, -2.91, 0.035)
    );
    bus.add(
      rounded(0.22, 0.25, 0.08, '#e46857', side * 0.76, 0.81, 2.91, 0.03)
    );
    for (const z of [-1.78, 1.86]) {
      const wheel = new THREE.Group();
      wheel.position.set(side * 1.03, 0.48, z);
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.46, 0.46, 0.24, 20),
        new THREE.MeshStandardMaterial({ color: '#23343e', roughness: 0.8 })
      );
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.23, 0.23, 0.26, 16),
        new THREE.MeshStandardMaterial({
          color: '#d7e1e7',
          metalness: 0.35,
          roughness: 0.4
        })
      );
      tire.rotation.z = hub.rotation.z = Math.PI / 2;
      wheel.add(tire, hub);
      bus.add(wheel);
      busWheels.push(wheel);
    }
  }
  // Double passenger doors on the right side.
  for (const z of [-1.56, 0.84]) {
    bus.add(rounded(0.055, 1.24, 0.73, '#31576c', 1.075, 1.16, z, 0.025));
    bus.add(rounded(0.06, 1.16, 0.035, '#b7d8e9', 1.11, 1.16, z, 0.01));
  }
  const subway = new THREE.Group();
  subway.name = 'GEO-metro';
  subway.add(shadow(2.8, 8.6));
  for (let i = 0; i < 2; i++) {
    const z = i * 3.55;
    subway.add(rounded(1.86, 1.45, 3.4, '#e4edf2', 0, 1.05, z, 0.25));
    subway.add(rounded(1.9, 0.22, 3.2, '#62bcb2', 0, 0.94, z, 0.06));
    subway.add(rounded(1.72, 0.2, 2.75, '#bbcbd4', 0, 1.84, z + 0.05, 0.09));
    for (const side of [-1, 1])
      for (const offset of [-0.95, -0.18, 0.68])
        subway.add(
          rounded(
            0.045,
            0.53,
            0.54,
            '#294e64',
            side * 0.95,
            1.36,
            z + offset,
            0.025
          )
        );
    if (i === 0) {
      subway.add(rounded(1.38, 0.7, 0.06, '#23475e', 0, 1.3, -1.72, 0.07));
      for (const side of [-1, 1])
        subway.add(
          rounded(0.28, 0.12, 0.065, '#fff0bd', side * 0.57, 0.82, -1.75, 0.02)
        );
    }
  }
  const plane = new THREE.Group();
  plane.name = 'GEO-airliner';
  const fuselage = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshStandardMaterial({ color: '#f4f6f1', roughness: 0.5 })
  );
  fuselage.scale.set(0.52, 0.5, 3.2);
  fuselage.position.y = 1.3;
  plane.add(fuselage);
  plane.add(rounded(5.1, 0.1, 1.35, '#d6e5ec', 0, 1.19, 0.1, 0.08));
  plane.add(rounded(2.5, 0.09, 0.77, '#4f8dbe', 0, 1.48, 2.18, 0.05));
  plane.add(rounded(0.1, 1.2, 0.9, '#4f8dbe', 0, 1.96, 2.28, 0.06));
  plane.add(rounded(0.66, 0.16, 0.52, '#315a77', 0, 1.64, -2.25, 0.06));
  for (const side of [-1, 1])
    plane.add(
      rounded(0.5, 0.48, 1.1, '#8daebe', side * 1.25, 0.94, -0.2, 0.17)
    );
  for (const actor of [bus, subway, plane])
    actor.traverse((object) => {
      if (object.isMesh) {
        object.renderOrder = 10;
        object.castShadow = !object.material.transparent;
      }
    });
  return { bus, subway, plane, busWheels };
}
