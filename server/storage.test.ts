import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeParsedItinerary } from '../src/shared/itinerary';
import { ItineraryStore } from './storage';

describe('ItineraryStore', () => {
  it('saves and reads itineraries from a SQLite database', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'map-tour-test-'));
    const dbPath = path.join(dir, 'itineraries.sqlite');
    const store = new ItineraryStore(dbPath);

    const itinerary = normalizeParsedItinerary({
      title: 'Test Trip',
      days: [{ title: 'Day 1', stops: [{ name: 'A' }], alternatives: [] }],
      alternatives: []
    });

    const saved = await store.save(itinerary);
    const loaded = await store.get(saved.id);

    expect(saved.id).not.toBe('draft');
    expect(loaded?.title).toBe('Test Trip');
    expect(loaded?.createdAt).toBeTruthy();

    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});
