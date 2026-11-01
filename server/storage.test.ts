import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import { ItineraryStore } from './storage';
import { DatabaseSync } from 'node:sqlite';

describe('ItineraryStore', () => {
  it('migrates an existing history database and persists trash across reopen without losing payloads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'map-tour-trash-'));
    const dbPath = path.join(dir, 'itineraries.sqlite');
    const old = new DatabaseSync(dbPath);
    const trip = { ...normalizeParsedItinerary({ title: '旧草稿', days: [{ stops: [{ name: '西湖' }] }] }), id: 'legacy-trip' };
    old.exec('create table itineraries (id text primary key, payload text not null, created_at text not null, updated_at text not null)');
    old.prepare('insert into itineraries values (?,?,?,?)').run(trip.id, JSON.stringify(trip), '2026-01-01', '2026-01-01');
    old.close();
    let store = new ItineraryStore(dbPath);
    try {
      expect((await store.get(trip.id))?.title).toBe('旧草稿');
      await store.setTrashed(trip.id, true, { userId: 'admin', admin: true });
      store.close();
      store = new ItineraryStore(dbPath);
      expect(await store.get(trip.id)).toBeNull();
      expect(await store.listSummaries()).toEqual([]);
      expect(await store.listSummaries(100, undefined, true)).toHaveLength(1);
      await store.setTrashed(trip.id, false, { userId: 'admin', admin: true });
      expect((await store.get(trip.id))?.days).toEqual(trip.days);
      await expect(store.setTrashed('missing', true, { userId: 'admin', admin: true })).rejects.toThrow('没有找到');
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('saves and reads itineraries from a SQLite database', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'map-tour-test-'));
    const dbPath = path.join(dir, 'itineraries.sqlite');
    const store = new ItineraryStore(dbPath);

    const itinerary = normalizeParsedItinerary({
      title: 'Test Trip',
      tripScope: { mode: 'single_city', province: '浙江省', primaryCity: '杭州市' },
      days: [{ title: 'Day 1', stops: [{ name: 'A' }], alternatives: [] }],
      alternatives: []
    });

    const saved = await store.save(itinerary);
    const loaded = await store.get(saved.id);

    expect(saved.id).not.toBe('draft');
    expect(loaded?.title).toBe('Test Trip');
    expect(loaded?.shareStatus).toBe('draft');
    expect(loaded?.createdAt).toBeTruthy();

    const second = normalizeParsedItinerary({
      title: 'Second Trip',
      tripScope: { mode: 'single_city', province: '浙江省', primaryCity: '杭州市' },
      days: [
        {
          title: 'Day 1',
          stops: [{ name: 'A' }, { name: 'B' }],
          alternatives: [{ name: 'C' }]
        }
      ],
      alternatives: [{ name: 'D' }]
    });
    await store.save(second);
    const summaries = await store.listSummaries();

    expect(summaries).toHaveLength(2);
    expect(summaries.map((item) => item.title)).toEqual(expect.arrayContaining(['Test Trip', 'Second Trip']));
    expect(summaries.find((item) => item.title === 'Second Trip')?.stopCount).toBe(4);
    expect(summaries.every((item) => item.shareStatus === 'draft')).toBe(true);

    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});
