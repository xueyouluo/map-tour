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
    expect(loaded?.shareStatus).toBe('draft');
    expect(loaded?.createdAt).toBeTruthy();

    const second = normalizeParsedItinerary({
      title: 'Second Trip',
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
