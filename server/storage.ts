import { HttpError } from './httpSecurity';
import { assertMainlandItinerary } from './serviceRegion';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Itinerary,
  ItinerarySummary,
  ShareStatus
} from '../src/shared/itinerary';

export interface StoredItinerary extends Itinerary {
  id: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, StoredItinerary>;

interface ItineraryRow {
  id: string;
  owner_id?: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
  trashed_at?: string | null;
}

export class ItineraryStore {
  private db?: DatabaseSync;

  constructor(
    private readonly dbPath = path.resolve(
      process.cwd(),
      process.env.SQLITE_DB_PATH || 'data/map-tour.sqlite'
    ),
    private readonly legacyJsonPath = path.resolve(
      path.dirname(dbPath),
      'itineraries.json'
    )
  ) {}

  async list(): Promise<Store> {
    const rows = this.database()
      .prepare('select * from itineraries where trashed_at is null order by created_at asc')
      .all() as unknown as ItineraryRow[];
    return rows.reduce<Store>((store, row) => {
      const record = rowToRecord(row);
      store[record.id] = record;
      return store;
    }, {});
  }

  async listSummaries(
    limit = 100,
    access?: { userId: string; admin: boolean },
    trashed = false
  ): Promise<ItinerarySummary[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const state = trashed ? 'trashed_at is not null' : 'trashed_at is null';
    const rows = access
      ? (this.database()
          .prepare(
            access.admin
              ? `select * from itineraries where (owner_id=? or owner_id is null) and ${state} order by updated_at desc limit ?`
              : `select * from itineraries where owner_id=? and ${state} order by updated_at desc limit ?`
          )
          .all(access.userId, safeLimit) as unknown as ItineraryRow[])
      : (this.database()
          .prepare(`select * from itineraries where ${state} order by updated_at desc limit ?`)
          .all(safeLimit) as unknown as ItineraryRow[]);
    return rows.map(rowToSummary);
  }

  async get(id: string): Promise<StoredItinerary | null> {
    const row = this.database()
      .prepare('select * from itineraries where id = ? and trashed_at is null')
      .get(id) as unknown as ItineraryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async save(
    itinerary: Itinerary,
    access?: { userId: string; admin: boolean }
  ): Promise<StoredItinerary> {
    assertMainlandItinerary(itinerary);
    const db = this.database();
    const id =
      itinerary.id && itinerary.id !== 'draft' ? itinerary.id : createShareId();
    const now = new Date().toISOString();
    db.exec('begin immediate');
    try {
      const previous = db
        .prepare('select created_at,owner_id,trashed_at from itineraries where id = ?')
        .get(id) as unknown as
        { created_at: string; owner_id: string | null; trashed_at: string | null } | undefined;
      if (access) {
        if (previous && previous.owner_id !== access.userId && !access.admin)
          throw new HttpError(403, '只能修改自己的行程；请另存为新行程。');
        if (!previous) {
          const user = db
            .prepare(
              'select role,status,itinerary_limit,itinerary_count from users where id=?'
            )
            .get(access.userId) as
            | {
                role: string;
                status: string;
                itinerary_limit: number;
                itinerary_count: number;
              }
            | undefined;
          if (!user || user.status !== 'active')
            throw new HttpError(401, '请重新登录。');
          if (
            user.role !== 'admin' &&
            user.itinerary_count >= user.itinerary_limit
          )
            throw new HttpError(
              403,
              '行程额度已用完，可以继续编辑和导出已有行程。'
            );
          db.prepare(
            'update users set itinerary_count=itinerary_count+1 where id=?'
          ).run(access.userId);
        }
      }
      if (previous?.trashed_at)
        throw new HttpError(409, '这个行程已在回收站中，请先恢复再编辑。');
      const record: StoredItinerary = {
        ...itinerary,
        id,
        shareStatus: normalizeShareStatus(itinerary.shareStatus) || 'draft',
        createdAt: previous?.created_at || now,
        updatedAt: now
      };

      db.prepare(
        `insert into itineraries (id, payload, created_at, updated_at, owner_id)
       values (?, ?, ?, ?, ?)
       on conflict(id) do update set
         payload = excluded.payload,
         updated_at = excluded.updated_at`
      ).run(
        id,
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt,
        previous?.owner_id || access?.userId || null
      );

      db.exec('commit');
      return record;
    } catch (error) {
      db.exec('rollback');
      throw error;
    }
  }

  async getAccessible(
    id: string,
    access?: { userId: string; admin: boolean }
  ): Promise<{ itinerary: StoredItinerary; editable: boolean } | null> {
    const row = this.database()
      .prepare('select * from itineraries where id=? and trashed_at is null')
      .get(id) as unknown as ItineraryRow | undefined;
    if (!row) return null;
    const itinerary = rowToRecord(row);
    const editable = Boolean(
      access && (access.admin || row.owner_id === access.userId)
    );
    if (!editable && row.owner_id && itinerary.shareStatus !== 'shared')
      return null;
    return { itinerary, editable };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async setTrashed(id: string, trashed: boolean, access: { userId: string; admin: boolean }): Promise<void> {
    // One guarded statement keeps deletion/restoration atomic and hides other owners' IDs.
    const result = this.database().prepare(
      `update itineraries set trashed_at=? where id=?${access.admin ? '' : ' and owner_id=?'}`
    ).run(trashed ? new Date().toISOString() : null, id, ...(access.admin ? [] : [access.userId]));
    if (!result.changes) throw new HttpError(404, '没有找到这个行程，或你没有管理权限。');
    // Creation quotas are cumulative: deleting/restoring does not change the counter.
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
      this.db.exec('pragma busy_timeout=5000');
      const columns = this.db
        .prepare('pragma table_info(itineraries)')
        .all() as { name: string }[];
      if (!columns.some((column) => column.name === 'owner_id'))
        this.db.exec('alter table itineraries add column owner_id text');
      if (!columns.some((column) => column.name === 'trashed_at'))
        this.db.exec('alter table itineraries add column trashed_at text');
      this.db.exec(
        'create index if not exists itineraries_owner on itineraries(owner_id)'
      );
      this.migrateLegacyJsonIfNeeded(this.db);
    }
    return this.db;
  }

  private migrateLegacyJsonIfNeeded(db: DatabaseSync): void {
    const row = db
      .prepare('select count(*) as count from itineraries')
      .get() as unknown as { count: number };
    if (row.count > 0 || !existsSync(this.legacyJsonPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.legacyJsonPath, 'utf8').trim();
      if (!raw) {
        return;
      }
      const legacyStore = JSON.parse(raw) as Store;
      const records = Object.values(legacyStore).filter(
        (record) => record?.id && Array.isArray(record.days)
      );
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
      console.info(
        `Imported ${records.length} legacy itineraries into ${this.dbPath}`
      );
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
    stopCount:
      record.days.reduce(
        (total, day) => total + day.stops.length + day.alternatives.length,
        0
      ) + record.alternatives.length,
    shareStatus: record.shareStatus || 'shared',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function normalizeShareStatus(status?: string): ShareStatus | undefined {
  return status === 'draft' || status === 'shared' ? status : undefined;
}
