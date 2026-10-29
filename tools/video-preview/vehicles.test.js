import { expect, it } from 'vitest';
import { selectVehicle } from './browser/vehicles.js';
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
