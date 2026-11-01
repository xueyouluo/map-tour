import { expect, it } from 'vitest';
import { normalizeParsedItinerary } from './itinerary';
import { stopLocationDefaults } from './stopLocationDefaults';

it('prefills from other stops on the same day, without inheriting their district', () => {
  const trip = normalizeParsedItinerary({ days: [{ stops: [
    { name: '东湖' },
    { name: '湖北省博物馆', province: '湖北省', city: '武汉市', district: '武昌区' }
  ] }] }, 'test');
  expect(stopLocationDefaults(trip.days[0].stops[0], trip)).toMatchObject({
    province: '湖北省', city: '武汉市', district: ''
  });
});

it('uses the edited day on a multi-city trip rather than the first destination', () => {
  const trip = normalizeParsedItinerary({
    tripScope: { mode: 'multi_city', province: '湖北省', cities: ['武汉市', '长沙市'] },
    days: [
      { stops: [{ name: '黄鹤楼', province: '湖北省', city: '武汉市' }] },
      { stops: [{ name: '橘子洲' }, { name: '坡子街', province: '湖南省', city: '长沙市' }] }
    ]
  }, 'test');
  expect(stopLocationDefaults(trip.days[1].stops[0], trip)).toMatchObject({
    province: '湖南省', city: '长沙市'
  });
});

it('preserves the stop city and finds its province on another day', () => {
  const trip = normalizeParsedItinerary({ days: [
    { stops: [{ name: '灵隐寺', city: '杭州' }, { name: '武汉站', province: '湖北省', city: '武汉市' }] },
    { stops: [{ name: '西湖', province: '浙江省', city: '杭州市' }] }
  ] }, 'test');
  expect(stopLocationDefaults(trip.days[0].stops[0], trip)).toMatchObject({
    province: '浙江省', city: '杭州'
  });
});

it('does not guess a city for an ambiguous cross-city transfer day', () => {
  const trip = normalizeParsedItinerary({
    tripScope: { mode: 'multi_city', cities: ['武汉市', '长沙市'] },
    days: [{ stops: [
      { name: '武汉站', province: '湖北省', city: '武汉市' },
      { name: '待确认酒店' },
      { name: '长沙南站', province: '湖南省', city: '长沙市' }
    ] }]
  }, 'test');
  expect(stopLocationDefaults(trip.days[0].stops[1], trip)).toMatchObject({
    province: '', city: ''
  });
});

it('uses a matched place administration when the original stop omitted it', () => {
  const trip = normalizeParsedItinerary({ days: [{ stops: [{ name: '东湖' }] }] }, 'test');
  const stop = trip.days[0].stops[0];
  stop.poiMatch = { status: 'matched', name: '东湖绿道', province: '湖北省', city: '武汉市', district: '武昌区' };
  expect(stopLocationDefaults(stop, trip)).toMatchObject({
    province: '湖北省', city: '武汉市', district: '武昌区'
  });
});

it('does not assign the arrival city to an unidentified departure station', () => {
  const trip = normalizeParsedItinerary({
    tripScope: { mode: 'multi_city', cities: ['武汉市', '长沙市'] },
    days: [{ stops: [
      { name: '待确认出发站' },
      { name: '长沙南站', province: '湖南省', city: '长沙市', arrival: { mode: 'rail', label: '高铁', quote: '乘高铁到长沙南站' } },
      { name: '橘子洲', province: '湖南省', city: '长沙市' }
    ] }]
  }, 'test');
  expect(stopLocationDefaults(trip.days[0].stops[0], trip)).toMatchObject({
    province: '', city: ''
  });
});

it('does not replace explicit geography with a namesake match from another city', () => {
  const trip = normalizeParsedItinerary({ days: [{ stops: [
    { name: '北港村', province: '福建省', city: '福州市', district: '平潭县' }
  ] }] }, 'test');
  const stop = trip.days[0].stops[0];
  stop.poiMatch = { status: 'matched', name: '北港村', province: '河北省', city: '保定市', district: '莲池区' };
  expect(stopLocationDefaults(stop, trip)).toMatchObject({
    province: '福建省', city: '福州市', district: '平潭县'
  });
});

it('supports a sole scope city even when primaryCity is absent', () => {
  const trip = normalizeParsedItinerary({
    tripScope: { mode: 'unknown', province: '浙江省', cities: ['杭州市'] },
    days: [{ stops: [{ name: '西湖' }] }]
  }, 'test');
  expect(stopLocationDefaults(trip.days[0].stops[0], trip)).toMatchObject({
    province: '浙江省', city: '杭州市'
  });
});

it('can find the day of an optional place without using other recommended cities', () => {
  const trip = normalizeParsedItinerary({
    tripScope: { mode: 'multi_city', cities: ['武汉市', '长沙市'] },
    days: [{ stops: [{ name: '黄鹤楼', province: '湖北省', city: '武汉市' }] }]
  }, 'test');
  const option = { ...trip.days[0].stops[0], id: 'meal', name: '待确认餐馆', province: '', city: '', district: '' };
  trip.days[0].activityOptions = [option];
  expect(stopLocationDefaults(option, trip)).toMatchObject({ province: '湖北省', city: '武汉市' });
});
