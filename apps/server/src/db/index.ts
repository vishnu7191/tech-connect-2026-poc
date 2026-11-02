import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/env.js';
import { logger } from '../core/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;
  fs.mkdirSync(paths.data, { recursive: true });
  fs.mkdirSync(paths.evidence, { recursive: true });
  db = openDatabase(paths.db);
  return db;
}

/** Separate entry point so tests can use an in-memory database. */
export function openDatabase(file: string): Db {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  migrate(conn);
  return conn;
}

function migrate(conn: Db): void {
  // schema.sql lives beside this file in src, and beside the compiled JS in dist.
  const candidates = [
    path.join(here, 'schema.sql'),
    path.join(here, '..', '..', 'src', 'db', 'schema.sql'),
  ];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) {
    throw new Error(`Could not locate schema.sql (looked in: ${candidates.join(', ')})`);
  }
  conn.exec(fs.readFileSync(schemaPath, 'utf8'));
  addMissingColumns(conn);
  logger.debug({ schemaPath }, 'Database schema applied');
}

/**
 * Columns added to tables that already exist in a user's database.
 *
 * `CREATE TABLE IF NOT EXISTS` in schema.sql creates new tables but silently
 * does nothing to an existing one, so a new column on an old table needs an
 * explicit ALTER. Keeping that here rather than in schema.sql means an existing
 * project's data, executions and recordings survive the upgrade untouched:
 * every column below is nullable or defaulted, so old rows remain valid and
 * read back as "not recorded" instead of as a wrong value.
 *
 * Forward-only and idempotent - the current columns are read first, and only
 * what is genuinely absent is added.
 */
const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  // The emulation profile a run used, as JSON. Null on pre-device executions.
  { table: 'executions', column: 'device', ddl: 'TEXT' },
  // Offset between the execution clock origin and the first video frame.
  { table: 'videos', column: 'start_offset_ms', ddl: 'INTEGER' },
  { table: 'videos', column: 'device_id', ddl: 'TEXT' },
  // Geometry context, so an overlay can tell whether an image and a set of
  // coordinates describe the same viewport.
  { table: 'screenshots', column: 'device_id', ddl: 'TEXT' },
  { table: 'screenshots', column: 'device_scale_factor', ddl: 'REAL' },
];

function addMissingColumns(conn: Db): void {
  for (const m of COLUMN_MIGRATIONS) {
    try {
      const existing = conn.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (existing.length === 0) continue; // table not present in this database
      if (existing.some((c) => c.name === m.column)) continue;
      conn.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
      logger.info({ table: m.table, column: m.column }, 'Added missing column');
    } catch (err) {
      // Never swallow: a failed migration changes what the rest of the code can
      // assume, and a silent failure here would surface much later as a
      // confusing "no such column" at query time.
      logger.error(
        { table: m.table, column: m.column, err: (err as Error).message },
        'Column migration failed',
      );
      throw err;
    }
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/* ------------------------------------------------------------------ *
 * Small helpers keeping SQLite's integer-boolean and JSON-text
 * conventions in one place rather than scattered through repositories.
 * ------------------------------------------------------------------ */

export const toBool = (v: unknown): boolean => v === 1 || v === true;
export const fromBool = (v: boolean | undefined): number => (v ? 1 : 0);

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export const nowIso = (): string => new Date().toISOString();
