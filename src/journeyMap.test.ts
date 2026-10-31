import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@amap/amap-jsapi-loader', () => ({ default: { load: vi.fn() } }));
import { drawJourneyMap } from './amap';
import { normalizeParsedItinerary } from './shared/itinerary';

afterEach(() => vi.unstubAllGlobals());
it('fits the selected day to its main stops while keeping local optional markers visible', () => {
  const element = () => ({
    style: { setProperty: vi.fn() }, classList: { toggle: vi.fn() }, dataset: {},
    setAttribute: vi.fn(), append: vi.fn(), addEventListener: vi.fn()
  });
  vi.stubGlobal('document', { createElement: element, fonts: { ready: Promise.resolve() } });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const AMap = {
    InfoWindow: class { close() {} }, Pixel: class {},
    Marker: class { constructor(public options: { position: number[] }) {} setzIndex() {} }
  };
  const trip = normalizeParsedItinerary({ days: [
    { dayIndex: 1, stops: [{ name: '黄鹤楼', city: '武汉' }, { name: '中华路码头', city: '武汉' }], activityOptions: [
      { name: '武汉餐馆', city: '武汉', activity: { kind: 'meal', source: 'explicit', placeKind: 'venue', meal: 'lunch', quote: '', searchName: '武汉餐馆' } },
      { name: '长沙酒店', city: '长沙', activity: { kind: 'stay', source: 'default', placeKind: 'venue', meal: 'none', quote: '', searchName: '长沙酒店' } }
    ] },
    { dayIndex: 2, stops: [{ name: '橘子洲', city: '长沙' }] }
  ] }, 'map-day-test');
  for (const day of trip.days) for (const [i, stop] of [...day.stops, ...(day.activityOptions || [])].entries())
    stop.poiMatch = { name: stop.name, status: 'matched', location: stop.city === '武汉' ? [114.3 + i * 0.01, 30.5] : [112.97, 28.19] };
  const map = { add: vi.fn(), on: vi.fn(), off: vi.fn(), remove: vi.fn() };
  const drawing = drawJourneyMap(AMap, map, {} as HTMLElement, trip, 1, vi.fn(), false, true, null);
  expect([...drawing.stopLookup.values()].map(hit => hit.stop.name)).toEqual(['黄鹤楼', '中华路码头', '武汉餐馆']);
  expect(drawing.overlays).toHaveLength(3);
  expect(drawing.fitOverlays).toHaveLength(2);
  expect(drawing.fitOverlays).not.toContain(drawing.stopLookup.get(trip.days[0].activityOptions![0].id)?.marker);
  drawing.dispose();
  expect(map.remove).toHaveBeenCalledWith(drawing.overlays);
});
