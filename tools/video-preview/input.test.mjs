import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listLocalItineraries, readLocalItinerary } from './input.mjs';

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true });
});

describe('local video input', () => {
  it('reads only the requested SQLite payload and leaves its bytes and schema intact', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-video-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'source.sqlite'),
      db = new DatabaseSync(databasePath);
    db.exec(
      'create table itineraries(id text primary key, payload text, updated_at text)'
    );
    const itinerary = {
      id: 'trip',
      title: '测试路线',
      days: [{ stops: [] }],
      alternatives: [],
      routeSegments: []
    };
    db.prepare('insert into itineraries values(?,?,?)').run(
      'trip',
      JSON.stringify(itinerary),
      '2026-10-22'
    );
    db.close();
    const before = fs.readFileSync(databasePath);
    expect(readLocalItinerary({ databasePath, id: 'trip' })).toEqual(itinerary);
    expect(listLocalItineraries(databasePath)[0]).toMatchObject({
      id: 'trip',
      title: '测试路线',
      stops: 0
    });
    expect(() => readLocalItinerary({ databasePath, id: 'missing' })).toThrow(
      '不存在'
    );
    expect(fs.readFileSync(databasePath).equals(before)).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(['source.sqlite']);
  });

  it('accepts exported itinerary envelopes and refuses ambiguous input', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-tour-video-'));
    temporaryDirectories.push(directory);
    const input = path.join(directory, 'input.json'),
      itinerary = { id: 'json', days: [], routeSegments: [] };
    fs.writeFileSync(input, JSON.stringify({ itinerary }));
    expect(readLocalItinerary({ input })).toEqual(itinerary);
    expect(() => readLocalItinerary({ input, id: 'trip' })).toThrow('一种');
    delete itinerary.id;
    fs.writeFileSync(input, JSON.stringify(itinerary));
    const first = readLocalItinerary({ input }),
      second = readLocalItinerary({ input });
    expect(first.id).toMatch(/^local-[a-f0-9]{12}$/);
    expect(first.id).toBe(second.id);
    expect(fs.readFileSync(input, 'utf8')).toBe(JSON.stringify(itinerary));
  });
});
