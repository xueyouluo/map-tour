import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Itinerary } from '../src/shared/itinerary';

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
  private db?: Database.Database;

  constructor(
    private readonly dbPath = path.resolve(process.cwd(), process.env.SQLITE_DB_PATH || 'data/map-tour.sqlite'),
    private readonly legacyJsonPath = path.resolve(path.dirname(dbPath), 'itineraries.json')
  ) {}

  async list(): Promise<Store> {
    const rows = this.database().prepare('select * from itineraries order by created_at asc').all() as ItineraryRow[];
    return rows.reduce<Store>((store, row) => {
      const record = rowToRecord(row);
      store[record.id] = record;
      return store;
    }, {});
  }

  async get(id: string): Promise<StoredItinerary | null> {
    const row = this.database().prepare('select * from itineraries where id = ?').get(id) as ItineraryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async save(itinerary: Itinerary): Promise<StoredItinerary> {
    const db = this.database();
    const id = itinerary.id && itinerary.id !== 'draft' ? itinerary.id : createShareId();
    const now = new Date().toISOString();
    const previous = db.prepare('select created_at from itineraries where id = ?').get(id) as
      | { created_at: string }
      | undefined;
    const record: StoredItinerary = {
      ...itinerary,
      id,
      createdAt: previous?.created_at || now,
      updatedAt: now
    };

    db.prepare(
      `insert into itineraries (id, payload, created_at, updated_at)
       values (@id, @payload, @createdAt, @updatedAt)
       on conflict(id) do update set
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    ).run({
      id,
      payload: JSON.stringify(record),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    });

    return record;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private database(): Database.Database {
    if (!this.db) {
      mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db
        .prepare(
          `create table if not exists itineraries (
            id text primary key,
            payload text not null,
            created_at text not null,
            updated_at text not null
          )`
        )
        .run();
      this.migrateLegacyJsonIfNeeded(this.db);
    }
    return this.db;
  }

  private migrateLegacyJsonIfNeeded(db: Database.Database): void {
    const row = db.prepare('select count(*) as count from itineraries').get() as { count: number };
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
         values (@id, @payload, @createdAt, @updatedAt)`
      );
      const migrate = db.transaction((items: StoredItinerary[]) => {
        for (const item of items) {
          const createdAt = item.createdAt || new Date().toISOString();
          const updatedAt = item.updatedAt || createdAt;
          const record = { ...item, createdAt, updatedAt };
          insert.run({
            id: record.id,
            payload: JSON.stringify(record),
            createdAt,
            updatedAt
          });
        }
      });

      migrate(records);
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
    createdAt: payload.createdAt || row.created_at,
    updatedAt: payload.updatedAt || row.updated_at
  };
}
