import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, reconcileSeamLineage } from './migrations.js';

/**
 * The product database. All SQL lives behind this module and the stores built on it, so the
 * storage engine can change later (node:sqlite is still a release candidate in Node 24).
 */
export type Db = DatabaseSync;

export function dataDir(): string {
  return path.resolve(process.env.LEXCOMPILER_DATA_DIR || path.join(process.cwd(), 'data'));
}

/** Opens (and migrates) a database file, or `:memory:` for tests. */
export function openDatabase(file: string = path.join(dataDir(), 'lexcompiler.db')): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

let shared: Db | null = null;

/** The server's database, opened on first use. */
export function getDb(): Db {
  if (!shared) shared = openDatabase();
  return shared;
}

/** Closes the shared database (tests and graceful shutdown). */
export function closeDb(): void {
  shared?.close();
  shared = null;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  // A database built by the other development line numbers 4-6 differently; bring it onto this
  // numbering first (a no-op everywhere else).
  transaction(db, () => reconcileSeamLineage(db));
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => Number(r.id))
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    });
  }
}

/** Runs `fn` in one transaction (BEGIN IMMEDIATE), rolling back if it throws. Not re-entrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
