import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Itinerary, ItinerarySummary, ShareStatus } from '../src/shared/itinerary';

export interface StoredItinerary extends Itinerary {
  id: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, StoredItinerary>;

interface ItineraryRow {
  id: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

export class ItineraryStore {
  private db?: DatabaseSync;

  constructor(
    private readonly dbPath = path.resolve(process.cwd(), process.env.SQLITE_DB_PATH || 'data/map-tour.sqlite'),
    private readonly legacyJsonPath = path.resolve(path.dirname(dbPath), 'itineraries.json')
  ) {}

  async list(): Promise<Store> {
    const rows = this.database().prepare('select * from itineraries order by created_at asc').all() as unknown as ItineraryRow[];
    return rows.reduce<Store>((store, row) => {
      const record = rowToRecord(row);
      store[record.id] = record;
      return store;
    }, {});
  }

  async listSummaries(limit = 100): Promise<ItinerarySummary[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const rows = this.database()
      .prepare('select * from itineraries order by updated_at desc limit ?')
      .all(safeLimit) as unknown as ItineraryRow[];
    return rows.map(rowToSummary);
  }

  async get(id: string): Promise<StoredItinerary | null> {
    const row = this.database().prepare('select * from itineraries where id = ?').get(id) as unknown as
      | ItineraryRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  async save(itinerary: Itinerary): Promise<StoredItinerary> {
    const db = this.database();
    const id = itinerary.id && itinerary.id !== 'draft' ? itinerary.id : createShareId();
    const now = new Date().toISOString();
    const previous = db.prepare('select created_at from itineraries where id = ?').get(id) as unknown as
      | { created_at: string }
      | undefined;
    const record: StoredItinerary = {
      ...itinerary,
      id,
      shareStatus: normalizeShareStatus(itinerary.shareStatus) || 'draft',
      createdAt: previous?.created_at || now,
      updatedAt: now
    };

    db.prepare(
      `insert into itineraries (id, payload, created_at, updated_at)
       values (?, ?, ?, ?)
       on conflict(id) do update set
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    ).run(id, JSON.stringify(record), record.createdAt, record.updatedAt);

    return record;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private database(): DatabaseSync {
    if (!this.db) {
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        pragma journal_mode = WAL;
        create table if not exists itineraries (
            id text primary key,
            payload text not null,
            created_at text not null,
            updated_at text not null
          );
      `);
      this.migrateLegacyJsonIfNeeded(this.db);
    }
    return this.db;
  }

  private migrateLegacyJsonIfNeeded(db: DatabaseSync): void {
    const row = db.prepare('select count(*) as count from itineraries').get() as unknown as { count: number };
    if (row.count > 0 || !existsSync(this.legacyJsonPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.legacyJsonPath, 'utf8').trim();
      if (!raw) {
        return;
      }
      const legacyStore = JSON.parse(raw) as Store;
      const records = Object.values(legacyStore).filter((record) => record?.id && Array.isArray(record.days));
      if (!records.length) {
        return;
      }

      const insert = db.prepare(
        `insert or ignore into itineraries (id, payload, created_at, updated_at)
         values (?, ?, ?, ?)`
      );
      db.exec('begin');
      try {
        for (const item of records) {
          const createdAt = item.createdAt || new Date().toISOString();
          const updatedAt = item.updatedAt || createdAt;
          const record = { ...item, createdAt, updatedAt };
          insert.run(record.id, JSON.stringify(record), createdAt, updatedAt);
        }
        db.exec('commit');
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
      console.info(`Imported ${records.length} legacy itineraries into ${this.dbPath}`);
    } catch (error) {
      console.warn('Failed to import legacy itinerary JSON data:', error);
    }
  }
}

export function createShareId(): string {
  return randomBytes(6).toString('base64url');
}

function rowToRecord(row: ItineraryRow): StoredItinerary {
  const payload = JSON.parse(row.payload) as StoredItinerary;
  return {
    ...payload,
    id: row.id,
    shareStatus: normalizeShareStatus(payload.shareStatus) || 'shared',
    createdAt: payload.createdAt || row.created_at,
    updatedAt: payload.updatedAt || row.updated_at
  };
}

function rowToSummary(row: ItineraryRow): ItinerarySummary {
  const record = rowToRecord(row);
  return {
    id: record.id,
    title: record.title || 'Untitled itinerary',
    language: record.language || 'auto',
    dateRange: record.dateRange || {},
    tripScope: record.tripScope,
    daysCount: record.days.length,
    stopCount: record.days.reduce((total, day) => total + day.stops.length + day.alternatives.length, 0) + record.alternatives.length,
    shareStatus: record.shareStatus || 'shared',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function normalizeShareStatus(status?: string): ShareStatus | undefined {
  return status === 'draft' || status === 'shared' ? status : undefined;
}
