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
  logger.debug({ schemaPath }, 'Database schema applied');
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
