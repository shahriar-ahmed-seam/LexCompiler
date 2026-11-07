/**
 * Schema migrations for the product database, applied in order, once each. Never edit a
 * migration that has shipped; add a new one instead.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

const ROLE_CHECK = "CHECK (role IN ('owner','legal','engineer','viewer'))";

/**
 * Data fixes of migration 17, also run when a database built by the other lineage is reconciled:
 * every exception gets its rule's key, and requests made by a coding assistant are stored as
 * 'assistant' (one name for one origin).
 */
const EXCEPTION_DATA_FIXES = `
UPDATE exceptions SET rule_key = (SELECT r.key FROM rules r WHERE r.id = exceptions.rule_id)
  WHERE rule_key IS NULL;
UPDATE exceptions SET requested_from = 'assistant' WHERE requested_from = 'mcp';
`;

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'workspaces, rules, scans, evidence',
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  oidc_sub TEXT UNIQUE NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX users_email ON users(lower(email));

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL ${ROLE_CHECK},
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- A person invited by email before their first sign-in.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL ${ROLE_CHECK},
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  UNIQUE (workspace_id, email)
);

-- Only a SHA-256 of each session id is stored, so a database leak does not leak sessions.
CREATE TABLE sessions (
  id_sha256 TEXT PRIMARY KEY,
  principal_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT
);

-- workspace_id is NULL while a GitHub installation is not linked to a workspace yet.
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('github','local')),
  installation_id INTEGER REFERENCES github_installations(installation_id),
  github_repo_id INTEGER UNIQUE,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_path TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX repos_workspace ON repos(workspace_id);

CREATE TABLE counterparties (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE counterparty_scope (
  counterparty_id TEXT NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path_glob TEXT NOT NULL DEFAULT '**',
  PRIMARY KEY (counterparty_id, repo_id, path_glob)
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counterparty_id TEXT REFERENCES counterparties(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'contract' CHECK (kind IN ('contract','regulation','policy')),
  title TEXT NOT NULL,
  language TEXT,
  file_sha256 TEXT NOT NULL,
  text TEXT NOT NULL,
  supersedes_id TEXT REFERENCES documents(id),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_by TEXT,
  UNIQUE (workspace_id, key)
);

-- clause_json is the compiled LegalClause, frozen when the version is created. Scans use it
-- as stored, so a compiler upgrade never changes what an approved rule means.
CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','approved','rejected','retired')),
  document_id TEXT REFERENCES documents(id),
  source_text TEXT NOT NULL,
  clause_json TEXT NOT NULL,
  clause_sha256 TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{"all":true}',
  answers_json TEXT,
  effective_from TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  decision_note TEXT,
  UNIQUE (rule_id, version)
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  base_sha TEXT,
  trigger TEXT NOT NULL,
  pr_number INTEGER,
  rules_sha256 TEXT NOT NULL,
  rule_versions_json TEXT NOT NULL,
  lexcompiler_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','in_progress','completed','failed')),
  conclusion TEXT,
  check_run_id INTEGER,
  files_scanned INTEGER,
  facts_json TEXT,
  summary_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX scans_repo_commit ON scans(repo_id, commit_sha, rules_sha256);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
  rule_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  construct_type TEXT,
  message TEXT NOT NULL,
  snippet TEXT,
  state TEXT NOT NULL CHECK (state IN ('new','existing','waived')),
  exception_id TEXT
);
CREATE INDEX findings_scan ON findings(scan_id);

CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
  fingerprint TEXT,
  path_glob TEXT,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_from TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','expired','revoked')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  expires_at TEXT
);

-- Append-only, hash-chained, signed log per workspace.
CREATE TABLE evidence (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  seq INTEGER NOT NULL,
  header TEXT NOT NULL,
  header_sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);
CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
  BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
  BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_sha256 TEXT UNIQUE NOT NULL,
  label TEXT,
  counterparty_id TEXT REFERENCES counterparties(id),
  rule_ids_json TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE share_views (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_ready ON jobs(status, run_after);
-- At most one queued or running job per dedupe key (e.g. one scan per commit and rule set).
CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE status IN ('queued','running');

CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'scans remember the job that ran them',
    sql: `
ALTER TABLE scans ADD COLUMN job_id TEXT;
CREATE INDEX scans_job ON scans(job_id);
`,
  },
  {
    id: 3,
    name: 'AI settings per workspace and a log of model calls',
    sql: `
-- AI is off until a workspace owner turns it on: contracts and code are confidential.
CREATE TABLE workspace_ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','local','cloud')),
  daily_token_budget INTEGER NOT NULL DEFAULT 200000,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- One row per model call. Prompts are not stored, only their SHA-256.
-- workspace_id is NULL for the demo screens, which use the bundled fixture.
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','invalid_output','error')),
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_calls_workspace_time ON ai_calls(workspace_id, created_at);
`,
  },
  {
    id: 4,
    name: 'original files of uploaded documents, rule card values',
    sql: `
-- The uploaded file as it was, so evidence can point at the exact bytes Legal approved from.
ALTER TABLE documents ADD COLUMN file_name TEXT;
ALTER TABLE documents ADD COLUMN file_format TEXT;
ALTER TABLE documents ADD COLUMN file_blob BLOB;

-- What the rule card showed and what Legal changed: suggested values, the model that suggested
-- them (with the prompt hash, never the prompt), and the values Legal set by hand.
ALTER TABLE rule_versions ADD COLUMN card_json TEXT;
`,
  },
  {
    id: 5,
    name: 'where an exception was requested from',
    sql: `
-- The pull request and check run an exception was requested on, so approval can re-run that check.
ALTER TABLE exceptions ADD COLUMN scan_id TEXT REFERENCES scans(id) ON DELETE SET NULL;
ALTER TABLE exceptions ADD COLUMN pr_number INTEGER;
ALTER TABLE exceptions ADD COLUMN head_sha TEXT;
ALTER TABLE exceptions ADD COLUMN base_sha TEXT;
-- The finding as it was when the exception was requested, for the inbox.
ALTER TABLE exceptions ADD COLUMN file_path TEXT;
ALTER TABLE exceptions ADD COLUMN start_line INTEGER;
ALTER TABLE exceptions ADD COLUMN message TEXT;
CREATE INDEX exceptions_workspace_status ON exceptions(workspace_id, status);
CREATE INDEX scans_check_run ON scans(check_run_id);
`,
  },
  {
    id: 6,
    name: 'personal access tokens and the MCP call log',
    sql: `
-- Personal access tokens for the MCP endpoint. One user, one workspace, the user's role.
-- Only the token's SHA-256 is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_owner ON api_tokens(workspace_id, user_id);

-- One row per MCP request. File paths and fingerprints only; sent code is never stored.
CREATE TABLE mcp_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  tool TEXT,
  repo TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','tool_error','error','denied','rate_limited')),
  duration_ms INTEGER NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX mcp_calls_workspace_time ON mcp_calls(workspace_id, created_at);

-- The end date an assistant (or engineer) asked for; Legal sets expires_at when approving.
ALTER TABLE exceptions ADD COLUMN requested_until TEXT;
`,
  },
  {
    id: 7,
    name: 'evidence record of each scan, share links in time order',
    sql: `
-- The signed evidence record written when a scan completed; its header hash is also in the check run.
ALTER TABLE scans ADD COLUMN evidence_seq INTEGER;
ALTER TABLE scans ADD COLUMN evidence_header_sha256 TEXT;
CREATE INDEX shares_workspace ON shares(workspace_id, created_at);
CREATE INDEX share_views_share ON share_views(share_id, at);
`,
  },
  {
    id: 8,
    name: 'regulation feed, coming-up findings, scheduled jobs',
    sql: `
-- Items from the Federal Register and EUR-Lex, stored once per item by the daily feed job.
CREATE TABLE feed_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  document_number TEXT NOT NULL,
  title TEXT NOT NULL,
  publication_date TEXT,
  agency TEXT,
  excerpt TEXT NOT NULL,
  url TEXT,
  kind TEXT NOT NULL DEFAULT 'TEXT' CHECK (kind IN ('TEXT','CHANGE_NOTICE')),
  illustrative INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX feed_items_seen ON feed_items(first_seen_at);
-- A document made from a feed item ("Draft rule change"), so the draft links to its source.
ALTER TABLE documents ADD COLUMN feed_item_id TEXT REFERENCES feed_items(id);
ALTER TABLE documents ADD COLUMN source_url TEXT;

-- What a rule version that is approved but not yet in effect would find on each repository's
-- default branch ("Coming up"), computed nightly and after such a version is approved.
CREATE TABLE coming_up (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES rule_versions(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  PRIMARY KEY (repo_id, version_id)
);

-- When each scheduled job last ran, so a restart doesn't skip or repeat a day.
CREATE TABLE scheduler_runs (
  name TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);
`,
  },
  {
    id: 9,
    name: 'fix pull requests and suggested changes',
    sql: `
-- Fix pull requests LexCompiler opened for a default branch, one per base commit.
CREATE TABLE fix_prs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  files_json TEXT NOT NULL,
  addressed_json TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, base_sha)
);

-- Findings LexCompiler already posted a suggestion for, per pull request, so pushes don't repeat them.
CREATE TABLE pr_suggestions (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, pr_number, fingerprint)
);
`,
  },
  {
    id: 10,
    name: 'RFC 3161 timestamps of evidence headers',
    sql: `
-- A Time-Stamp Authority's token over the exact text of an evidence header (the newest one of
-- the day), so an outside party vouches for when the chain reached it.
CREATE TABLE evidence_timestamps (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  header_sha256 TEXT NOT NULL,
  tsa_url TEXT NOT NULL,
  gen_time TEXT NOT NULL,
  serial TEXT NOT NULL,
  token_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);
`,
  },
  {
    id: 11,
    name: 'OAuth for the MCP endpoint',
    sql: `
-- Clients registered dynamically (RFC 7591). Public clients: no secret, PKCE required.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Authorization codes (10 minutes, one use). Only the code's SHA-256 is stored.
CREATE TABLE oauth_codes (
  code_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
-- Refresh tokens (rotated on use). The access token is an api_tokens row that lasts an hour.
CREATE TABLE oauth_refresh_tokens (
  token_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_sha256 TEXT NOT NULL,
  access_token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX oauth_refresh_code ON oauth_refresh_tokens(code_sha256);
`,
  },
  {
    id: 12,
    name: 'Agent crew runs',
    sql: `
-- One row per chained run of the six agents (server/agents/crew.ts), from the server or the Python crew.
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
    id: 13,
    name: 'Agent crew runs on workspace repositories',
    sql: `
-- Set for runs on a workspace's repository; those are listed only in that workspace.
ALTER TABLE agent_crew_runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE agent_crew_runs ADD COLUMN repo_id TEXT;
CREATE INDEX agent_crew_runs_workspace ON agent_crew_runs(workspace_id, started_at);
`,
  },
  {
    id: 14,
    name: 'Regulation watch notes on feed items',
    sql: `
-- Per workspace: the rules a feed item may affect (no model) and its summary (the workspace's model).
CREATE TABLE feed_item_notes (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feed_item_id TEXT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  category TEXT,
  affected_rule_keys_json TEXT NOT NULL,
  summary TEXT,
  model TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, feed_item_id)
);
`,
  },
  {
    id: 15,
    name: 'password sign-in, people profiles, workspace plan and archive',
    sql: `
-- Password sign-in (scrypt hashes) for workspaces that don't use an identity provider.
ALTER TABLE users ADD COLUMN password_hash TEXT;
-- Who someone is on GitHub (to match pull request authors) and their job title.
ALTER TABLE users ADD COLUMN github_login TEXT;
ALTER TABLE users ADD COLUMN title TEXT;
CREATE UNIQUE INDEX users_github_login ON users(lower(github_login)) WHERE github_login IS NOT NULL;

-- The workspace's plan, and when it was archived (archived workspaces are hidden and their tokens stop working).
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'pilot';
ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
`,
  },
  {
    id: 16,
    name: 'assistant token hints and clients, people on MCP calls',
    sql: `
-- The last characters of a token, so people can tell their tokens apart. Older tokens have none:
-- only their SHA-256 was stored.
ALTER TABLE api_tokens ADD COLUMN token_hint TEXT;
-- The coding assistant that last used the token (from the MCP client info).
ALTER TABLE api_tokens ADD COLUMN last_client TEXT;

-- Who made each MCP call, from which assistant, and a one-line summary (never the code sent).
ALTER TABLE mcp_calls ADD COLUMN user_id TEXT;
ALTER TABLE mcp_calls ADD COLUMN client TEXT;
ALTER TABLE mcp_calls ADD COLUMN summary TEXT;
UPDATE mcp_calls SET user_id = (SELECT t.user_id FROM api_tokens t WHERE t.id = mcp_calls.token_id)
  WHERE user_id IS NULL AND token_id IS NOT NULL;
`,
  },
  {
    id: 17,
    name: 'exception rule key and requester label',
    sql: `
-- The rule's key as it was when the exception was requested, and who asked (for example the
-- assistant and person behind an MCP request).
ALTER TABLE exceptions ADD COLUMN rule_key TEXT;
ALTER TABLE exceptions ADD COLUMN requester_label TEXT;
${EXCEPTION_DATA_FIXES}
`,
  },
  {
    id: 18,
    name: 'workspace event webhooks and their deliveries',
    sql: `
-- One outbound webhook per workspace (for example an n8n workflow). The secret signs each request.
CREATE TABLE workspace_webhooks (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Each event sent to it: pending until the job delivers it or runs out of attempts.
CREATE TABLE webhook_deliveries_out (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_deliveries_out_workspace ON webhook_deliveries_out(workspace_id, created_at);
`,
  },
];

/**
 * The name migration 4 had in the other development line, whose ids 4 to 6 mean different
 * things: its 4 added password sign-in, the token and MCP call tables and exception details
 * (here in 6, 15, 16 and 17), and its 5 and 6 were the agent crew runs (here 12 and 13).
 */
export const SEAM_LINEAGE_MIGRATION_4 = 'password sign-in, assistant tokens, MCP call log, exception details';

/** The schema surface reconcileSeamLineage needs from the database (node:sqlite's DatabaseSync). */
interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
}

function columnsOf(db: SqlDb, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => String(c.name)));
}

function tableExists(db: SqlDb, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/**
 * Brings a database created by the other development line (migrations 1-3 as here, then its own
 * 4-6) onto this numbering, so migrate() can apply the rest. Run by migrate() before the loop, in
 * a transaction. Returns whether anything was done. It is a no-op on every other database,
 * including this line's own (whose migration 4 has a different name), so it runs once.
 *
 * What it does:
 * - adds the columns of this line's 4, 5 and 6 that the other line never had (document files,
 *   rule card values, exception head/base SHAs and requested end date, MCP call details) and the
 *   api_tokens_owner index;
 * - runs migration 17's data fixes (its columns, like 15's and 16's, already exist);
 * - rewrites schema_migrations: 4-6 under this line's names, 12 and 13 when the crew-run table
 *   and its workspace column exist, and 15-17.
 *
 * Differences that remain on a reconciled database, all harmless: api_tokens.token_hint is NOT
 * NULL (so every insert must write it), exceptions.scan_id has no foreign key, mcp_calls.outcome
 * has no CHECK, and the extra index api_tokens_workspace stays.
 */
export function reconcileSeamLineage(db: SqlDb): boolean {
  if (!tableExists(db, 'schema_migrations')) return false;
  const row4 = db.prepare('SELECT name FROM schema_migrations WHERE id = 4').get() as { name: string } | undefined;
  if (!row4) return false;
  const applied = new Set((db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map((r) => Number(r.id)));
  const ownName4 = MIGRATIONS.find((m) => m.id === 4)?.name;
  const seamByName = row4.name === SEAM_LINEAGE_MIGRATION_4;
  // Fallback for a renamed row: the other line's 4 added users.password_hash, this line's 4 never does.
  const seamByShape = row4.name !== ownName4 && !applied.has(15) && columnsOf(db, 'users').has('password_hash');
  if (!seamByName && !seamByShape) return false;

  const addColumns = (table: string, columns: Array<[string, string]>) => {
    const have = columnsOf(db, table);
    for (const [name, type] of columns) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  };
  // This line's 4.
  addColumns('documents', [['file_name', 'TEXT'], ['file_format', 'TEXT'], ['file_blob', 'BLOB']]);
  addColumns('rule_versions', [['card_json', 'TEXT']]);
  // This line's 5 (scan_id, pr_number, file_path, start_line, message and both indexes came with the other 4).
  addColumns('exceptions', [['scan_id', 'TEXT'], ['pr_number', 'INTEGER'], ['head_sha', 'TEXT'], ['base_sha', 'TEXT'],
    ['file_path', 'TEXT'], ['start_line', 'INTEGER'], ['message', 'TEXT']]);
  db.exec('CREATE INDEX IF NOT EXISTS exceptions_workspace_status ON exceptions(workspace_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS scans_check_run ON scans(check_run_id)');
  // This line's 6 (the tables came with the other 4).
  addColumns('exceptions', [['requested_until', 'TEXT']]);
  addColumns('mcp_calls', [['detail_json', 'TEXT']]);
  db.exec('CREATE INDEX IF NOT EXISTS api_tokens_owner ON api_tokens(workspace_id, user_id)');
  // 15, 16 and 17: the columns came with the other 4; add any that are missing all the same.
  addColumns('users', [['password_hash', 'TEXT'], ['github_login', 'TEXT'], ['title', 'TEXT']]);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_github_login ON users(lower(github_login)) WHERE github_login IS NOT NULL');
  addColumns('workspaces', [['plan', "TEXT NOT NULL DEFAULT 'pilot'"], ['archived_at', 'TEXT']]);
  addColumns('api_tokens', [['token_hint', 'TEXT'], ['last_client', 'TEXT']]);
  addColumns('mcp_calls', [['user_id', 'TEXT'], ['client', 'TEXT'], ['summary', 'TEXT']]);
  db.exec(`UPDATE mcp_calls SET user_id = (SELECT t.user_id FROM api_tokens t WHERE t.id = mcp_calls.token_id)
    WHERE user_id IS NULL AND token_id IS NOT NULL`);
  addColumns('exceptions', [['rule_key', 'TEXT'], ['requester_label', 'TEXT']]);
  db.exec(EXCEPTION_DATA_FIXES);

  // Renumber: the other line's 5 and 6 are this line's 12 and 13.
  const now = new Date().toISOString();
  const nameOf = (id: number) => {
    const m = MIGRATIONS.find((x) => x.id === id);
    if (!m) throw new Error(`reconcileSeamLineage: no migration ${id}`);
    return m.name;
  };
  const markApplied = (id: number) => {
    db.prepare(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name'
    ).run(id, nameOf(id), now);
  };
  const crewRuns = tableExists(db, 'agent_crew_runs');
  for (const id of [4, 5, 6]) markApplied(id);
  if (crewRuns) markApplied(12);
  if (crewRuns && columnsOf(db, 'agent_crew_runs').has('workspace_id')) markApplied(13);
  for (const id of [15, 16, 17]) markApplied(id);
  return true;
}
