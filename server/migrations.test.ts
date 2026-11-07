import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db/index.js';
import { MIGRATIONS, SEAM_LINEAGE_MIGRATION_4, reconcileSeamLineage } from './db/migrations.js';
import { ProductStore } from './product/store.js';

// Migrations 4-6 exactly as the other development line shipped them (its 1-3 are this line's 1-3).
// Databases built by that code have these rows in schema_migrations and must still open.
const SEAM_MIGRATIONS = [
  {
    id: 4,
    name: SEAM_LINEAGE_MIGRATION_4,
    sql: `
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN github_login TEXT;
ALTER TABLE users ADD COLUMN title TEXT;
CREATE UNIQUE INDEX users_github_login ON users(lower(github_login)) WHERE github_login IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'pilot';
ALTER TABLE workspaces ADD COLUMN archived_at TEXT;

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_sha256 TEXT UNIQUE NOT NULL,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  last_client TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_workspace ON api_tokens(workspace_id);

CREATE TABLE mcp_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  user_id TEXT,
  client TEXT,
  method TEXT NOT NULL,
  tool TEXT,
  repo TEXT,
  outcome TEXT NOT NULL,
  summary TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_calls_workspace_time ON mcp_calls(workspace_id, created_at);

ALTER TABLE exceptions ADD COLUMN rule_key TEXT;
ALTER TABLE exceptions ADD COLUMN scan_id TEXT;
ALTER TABLE exceptions ADD COLUMN pr_number INTEGER;
ALTER TABLE exceptions ADD COLUMN file_path TEXT;
ALTER TABLE exceptions ADD COLUMN start_line INTEGER;
ALTER TABLE exceptions ADD COLUMN message TEXT;
ALTER TABLE exceptions ADD COLUMN requester_label TEXT;
CREATE INDEX exceptions_workspace_status ON exceptions(workspace_id, status);
CREATE INDEX scans_check_run ON scans(check_run_id);
`,
  },
  {
    id: 5,
    name: 'Agent crew runs',
    sql: `
CREATE TABLE agent_crew_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  use_models INTEGER NOT NULL,
  status TEXT NOT NULL,
  gate TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  triggered_by TEXT,
  run_json TEXT NOT NULL
);
CREATE INDEX agent_crew_runs_started ON agent_crew_runs(started_at);
`,
  },
  {
    id: 6,
    name: 'Agent crew runs on workspace repositories',
    sql: `
ALTER TABLE agent_crew_runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE agent_crew_runs ADD COLUMN repo_id TEXT;
CREATE INDEX agent_crew_runs_workspace ON agent_crew_runs(workspace_id, started_at);
`,
  },
];

const T = '2026-01-01T00:00:00.000Z';
const LAST = Math.max(...MIGRATIONS.map((m) => m.id));

const columns = (db: Db | DatabaseSync, table: string) =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
const migrationRows = (db: Db) =>
  db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as Array<{ id: number; name: string }>;

const dirs: string[] = [];
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A database file built the way the other line's code built it: this line's 1-3, then its 4..upTo. */
function seamDatabase(upTo: 4 | 5 | 6, seed: (db: DatabaseSync) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-migrations-'));
  dirs.push(dir);
  const file = path.join(dir, 'seam.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const steps = [...MIGRATIONS.filter((m) => m.id <= 3), ...SEAM_MIGRATIONS.filter((m) => m.id <= upTo)];
  for (const m of steps) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, T);
  }
  seed(db);
  db.close();
  return file;
}

function open(file: string): Db {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

/** Rows the other line's code would have written: a person with a password, a token, an MCP call, an exception. */
function seedSeamRows(db: DatabaseSync, withCrewRun: boolean) {
  db.exec(`
INSERT INTO workspaces (id, name, created_by, created_at, plan) VALUES ('ws1', 'Acme', 'u1', '${T}', 'team');
INSERT INTO workspaces (id, name, created_by, created_at, archived_at) VALUES ('ws2', 'Old', 'u1', '${T}', '${T}');
INSERT INTO users (id, oidc_sub, email, email_verified, name, created_at, password_hash, github_login, title)
  VALUES ('u1', 'password:ada@example.com', 'ada@example.com', 1, 'Ada', '${T}', 'scrypt$16384$8$1$salt$hash', 'ada-gh', 'Counsel');
INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('ws1', 'u1', 'owner', '${T}');
INSERT INTO rules (id, workspace_id, key, title, created_at) VALUES ('r1', 'ws1', 'NO_PII_IN_LOGS', 'No PII in logs', '${T}');
INSERT INTO api_tokens (id, workspace_id, user_id, name, token_sha256, token_hint, created_at, expires_at, last_client)
  VALUES ('t1', 'ws1', 'u1', 'Laptop', 'sha-t1', 'Ab12', '${T}', '2027-01-01T00:00:00.000Z', 'claude-code');
INSERT INTO mcp_calls (id, workspace_id, token_id, user_id, client, method, tool, outcome, summary, duration_ms, created_at)
  VALUES ('c1', 'ws1', 't1', NULL, 'claude-code', 'tools/call', 'check_code', 'ok', '2 findings', 12, '${T}');
INSERT INTO exceptions (id, workspace_id, rule_id, fingerprint, reason, requested_by, requested_from, requested_at, status,
  scan_id, pr_number, file_path, start_line, message, requester_label)
  VALUES ('e1', 'ws1', 'r1', 'fp1', 'Test fixture', 'u1', 'mcp', '${T}', 'requested',
  'scan-gone', 7, 'src/log.ts', 3, 'email logged', 'Claude Code for Ada');
`);
  if (withCrewRun) {
    // Migration 6 (this line's 13) added the workspace column.
    const ws = columns(db, 'agent_crew_runs').has('workspace_id');
    db.exec(`INSERT INTO agent_crew_runs (id, source, started_at, finished_at, use_models, status, gate, total_tokens, latency_ms, run_json${ws ? ', workspace_id' : ''})
      VALUES ('run1', 'server', '${T}', '${T}', 0, 'ok', 'SAT_COMPLIANT', 0, 5, '{}'${ws ? ", 'ws1'" : ''})`);
  }
}

describe('schema migrations', () => {
  it('migrates a fresh database to the last migration with the columns both lines need', () => {
    const db = openDatabase(':memory:');
    opened.push(db);
    const rows = migrationRows(db);
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(LAST).toBe(18);
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
    for (const c of ['password_hash', 'github_login', 'title']) expect(columns(db, 'users').has(c)).toBe(true);
    for (const c of ['plan', 'archived_at']) expect(columns(db, 'workspaces').has(c)).toBe(true);
    for (const c of ['token_hint', 'last_client']) expect(columns(db, 'api_tokens').has(c)).toBe(true);
    for (const c of ['user_id', 'client', 'summary', 'detail_json']) expect(columns(db, 'mcp_calls').has(c)).toBe(true);
    for (const c of ['rule_key', 'requester_label', 'requested_until', 'head_sha', 'scan_id']) expect(columns(db, 'exceptions').has(c)).toBe(true);
    // Tokens made before migration 16 have no hint, so the column is nullable here.
    const hint = (db.prepare('PRAGMA table_info(api_tokens)').all() as Array<{ name: string; notnull: number }>).find((c) => c.name === 'token_hint');
    expect(hint?.notnull).toBe(0);

    // The archive filter in ProductStore works, and new workspaces are on the pilot plan.
    const store = new ProductStore(db);
    const user = store.upsertUser({ sub: 'oidc|1', email: 'a@example.com', name: 'A' });
    const ws = store.createWorkspace('Fresh', user.id);
    expect(store.listWorkspaces().map((w) => w.id)).toEqual([ws.id]);
    expect((db.prepare('SELECT plan FROM workspaces WHERE id = ?').get(ws.id) as { plan: string }).plan).toBe('pilot');
    db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(T, ws.id);
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.listWorkspacesForUser(user.id)).toEqual([]);

    // Opening again applies nothing and reconciles nothing.
    expect(reconcileSeamLineage(db)).toBe(false);
  });

  it('runs migrations 15-17 on a database at 14, backfilling MCP call people and exception rule keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-migrations-'));
    dirs.push(dir);
    const file = path.join(dir, 'main14.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 14)) {
      raw.exec(m.sql);
      raw.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, T);
    }
    raw.exec(`
INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Acme', '${T}');
INSERT INTO users (id, oidc_sub, created_at) VALUES ('u1', 'oidc|1', '${T}');
INSERT INTO rules (id, workspace_id, key, title, created_at) VALUES ('r1', 'ws1', 'K1', 'Rule', '${T}');
INSERT INTO api_tokens (id, workspace_id, user_id, name, token_sha256, created_at, expires_at)
  VALUES ('t1', 'ws1', 'u1', 'Old', 'sha', '${T}', '2027-01-01T00:00:00.000Z');
INSERT INTO mcp_calls (id, workspace_id, token_id, method, outcome, duration_ms, detail_json, created_at)
  VALUES ('c1', 'ws1', 't1', 'tools/call', 'ok', 3, '{}', '${T}');
INSERT INTO exceptions (id, workspace_id, rule_id, reason, requested_by, requested_from, requested_at, status)
  VALUES ('e1', 'ws1', 'r1', 'why', 'u1', 'assistant', '${T}', 'requested');
`);
    raw.close();

    const db = open(file);
    expect(migrationRows(db).map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(db.prepare('SELECT token_hint FROM api_tokens').get()).toEqual({ token_hint: null });
    expect(db.prepare('SELECT user_id FROM mcp_calls').get()).toEqual({ user_id: 'u1' });
    expect(db.prepare('SELECT rule_key, requested_from FROM exceptions').get()).toEqual({ rule_key: 'K1', requested_from: 'assistant' });
    expect(new ProductStore(db).listWorkspaces().map((w) => w.id)).toEqual(['ws1']);
  });

  it("reconciles a database built by the other line's migrations 1-6 and keeps its rows", () => {
    const file = seamDatabase(6, (db) => seedSeamRows(db, true));
    const db = open(file);

    // Every migration is recorded once, under this line's names.
    const rows = migrationRows(db);
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));

    // This line's 4-6 columns were added, and the later migrations ran (8, 11, 14 here).
    expect(columns(db, 'documents').has('file_blob')).toBe(true);
    expect(columns(db, 'documents').has('feed_item_id')).toBe(true);
    expect(columns(db, 'rule_versions').has('card_json')).toBe(true);
    for (const c of ['head_sha', 'base_sha', 'requested_until']) expect(columns(db, 'exceptions').has(c)).toBe(true);
    expect(columns(db, 'mcp_calls').has('detail_json')).toBe(true);
    expect(columns(db, 'agent_crew_runs').has('workspace_id')).toBe(true);
    expect(columns(db, 'scans').has('evidence_seq')).toBe(true);
    for (const t of ['feed_items', 'fix_prs', 'evidence_timestamps', 'oauth_clients', 'feed_item_notes']) {
      expect(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toEqual({ ok: 1 });
    }
    expect(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'api_tokens_owner'").get()).toEqual({ ok: 1 });

    // No row was lost, and the data fixes ran.
    expect(db.prepare('SELECT password_hash, github_login, title FROM users WHERE id = ?').get('u1')).toEqual({
      password_hash: 'scrypt$16384$8$1$salt$hash', github_login: 'ada-gh', title: 'Counsel',
    });
    expect(db.prepare('SELECT id, plan, archived_at FROM workspaces ORDER BY id').all()).toEqual([
      { id: 'ws1', plan: 'team', archived_at: null },
      { id: 'ws2', plan: 'pilot', archived_at: T },
    ]);
    expect(db.prepare('SELECT token_hint, last_client FROM api_tokens WHERE id = ?').get('t1')).toEqual({ token_hint: 'Ab12', last_client: 'claude-code' });
    expect(db.prepare('SELECT user_id, client, summary FROM mcp_calls WHERE id = ?').get('c1')).toEqual({
      user_id: 'u1', client: 'claude-code', summary: '2 findings',
    });
    expect(db.prepare('SELECT rule_key, requested_from, requester_label, pr_number, file_path FROM exceptions WHERE id = ?').get('e1')).toEqual({
      rule_key: 'NO_PII_IN_LOGS', requested_from: 'assistant', requester_label: 'Claude Code for Ada', pr_number: 7, file_path: 'src/log.ts',
    });
    expect(db.prepare('SELECT workspace_id FROM agent_crew_runs WHERE id = ?').get('run1')).toEqual({ workspace_id: 'ws1' });

    // The store works on it: the archived workspace is hidden.
    expect(new ProductStore(db).listWorkspaces().map((w) => w.id)).toEqual(['ws1']);
    expect(reconcileSeamLineage(db)).toBe(false);
  });

  it("reconciles a database at the other line's migration 4, then creates the crew-run tables", () => {
    const file = seamDatabase(4, (db) => seedSeamRows(db, false));
    const db = open(file);
    expect(migrationRows(db).map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(columns(db, 'agent_crew_runs').has('workspace_id')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM exceptions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT requested_from FROM exceptions').get()).toEqual({ requested_from: 'assistant' });
  });

  it('opens a reconciled database again without changes', () => {
    const file = seamDatabase(5, (db) => seedSeamRows(db, true));
    const first = openDatabase(file);
    const before = migrationRows(first);
    first.close();
    const db = open(file);
    expect(migrationRows(db)).toEqual(before);
    expect(columns(db, 'agent_crew_runs').has('workspace_id')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_crew_runs').get()).toEqual({ n: 1 });
  });
});
