import { readRepositoryFilesAt, sourceLanguageForPath } from '../analyzer/repoBaseline.js';
import { checkConclusion } from '../github/checkRun.js';
import { splitClauses } from '../product/documents.js';
import { requestExceptions, type FlowDeps, type FindingRef } from '../product/flows.js';
import { CATEGORY_LABELS, plainReading } from '../product/ruleCard.js';
import { classifyFindings, scanFilesScoped, type ClassifiedFinding, type RawFinding } from '../product/scanner.js';
import { can, rulesetSha256, type ProductStore, type Repo, type RuleInEffect, type TokenPrincipal } from '../product/store.js';
import { summarizeFindings } from '../product/summary.js';
import { bm25Tokens } from '../rag/hybridRagEngine.js';
import { computeRealNeuralEmbedding } from '../services/realAiServiceMesh.js';
import { synthesizeRemediationPullRequest } from '../remediation/prSynthesizer.js';
import type { TargetRepoFile } from '../../shared/types.js';

/**
 * The six tools of the workspace MCP server (product guide, Phase 4a). They act as the token's
 * user in the token's workspace. Results carry data only (rules, findings, diffs, citations);
 * no tool approves rules or exceptions, edits rules, or reads another workspace.
 */

/** A failure the assistant should see (isError: true), as opposed to a protocol error. */
export class ToolError extends Error {}

export const MAX_CHECK_FILES = 200;
export const MAX_CHECK_BYTES = 2 * 1024 * 1024;

type Schema = Record<string, unknown>;
export interface WorkspaceToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
}

const repoArg = { type: 'string', description: 'Repository, as owner/name or the name shown in LexCompiler (for example "acme/core-platform"). Optional when the workspace has exactly one repository.' };
const filesArg = {
  type: 'array',
  description: `Changed files with their full new content (at most ${MAX_CHECK_FILES} files and 2 MB in all).`,
  items: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path from the repository root.' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
};
const readOnly = (title: string) => ({ title, readOnlyHint: true, openWorldHint: false });

/** In a fixed order, so clients that cache the list see no change between calls. */
export const WORKSPACE_TOOLS: WorkspaceToolSpec[] = [
  {
    name: 'list_rules',
    title: 'List rules in effect',
    description: 'The approved compliance rules that apply to a repository: key, title, plain reading, version, scope, approver and effective date. Without repo (and with several repositories) it lists every rule in effect in the workspace.',
    inputSchema: { type: 'object', properties: { repo: repoArg } },
    annotations: readOnly('List rules in effect'),
  },
  {
    name: 'check_changes',
    title: 'Check changes before commit',
    description:
      'Checks changed files against the rules in effect, over the latest scanned default-branch commit. Returns the findings the pull request check would report, each new, existing or waived, and the conclusion. Sent code is not stored.',
    inputSchema: {
      type: 'object',
      properties: { repo: repoArg, files: filesArg, deleted: { type: 'array', items: { type: 'string' }, description: 'Paths the change deletes.' } },
      required: ['files'],
    },
    annotations: readOnly('Check changes before commit'),
  },
  {
    name: 'explain_finding',
    title: 'Explain a finding',
    description: 'The rule behind a finding: its text, approved version and approver, why the code fails, how code usually satisfies it, and citations. Give a fingerprint, or rule, path and line, or just the rule key.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string' },
        rule: { type: 'string', description: 'Rule key, for example R-1.' },
        path: { type: 'string' },
        line: { type: 'integer' },
      },
    },
    annotations: readOnly('Explain a finding'),
  },
  {
    name: 'suggest_fix',
    title: 'Suggest a verified fix',
    description: 'A unified diff for one finding that passed the Z3 gate (the rule holds after the patch), or "no verified fix".',
    inputSchema: { type: 'object', properties: { repo: repoArg, fingerprint: { type: 'string' }, files: filesArg }, required: ['fingerprint', 'files'] },
    annotations: readOnly('Suggest a verified fix'),
  },
  {
    name: 'request_exception',
    title: 'Request an exception',
    description:
      "Asks Legal to waive one finding. The request waits in Legal's inbox (and as a comment on the pull request, when there is one); Legal decides it in LexCompiler and this tool cannot approve anything. Only use it after telling the user, with an honest reason. Needs the engineer role or higher.",
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'From check_changes or the pull request check.' },
        reason: { type: 'string', description: 'Why the finding should be waived, and when it will be fixed.' },
        until: { type: 'string', description: 'Requested end date (ISO 8601), at most a year away. Optional; Legal sets the final date.' },
        rule: { type: 'string', description: 'Rule key, for a finding that is not on GitHub or in a recent check_changes call.' },
        repo: repoArg,
        path: { type: 'string' },
        line: { type: 'integer' },
        message: { type: 'string' },
      },
      required: ['fingerprint', 'reason'],
    },
    annotations: { title: 'Request an exception', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'search_obligations',
    title: 'Search obligations',
    description: "Searches the workspace's approved rules and uploaded documents, e.g. 'can we log phone numbers?'. Returns the closest passages with citations (semantic when local embeddings are available, otherwise keyword).",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'At most 10; default 5.' } }, required: ['query'] },
    annotations: readOnly('Search obligations'),
  },
];

export const CHECK_BEFORE_COMMIT_PROMPT = {
  name: 'check-before-commit',
  title: 'Check before commit',
  description: 'Checks every changed file with LexCompiler before you commit.',
  text: 'Call check_changes with every file I changed. Fix new findings, using suggest_fix when it returns a verified diff. Ask me before requesting an exception.',
};

/** How code usually satisfies each kind of rule (shown by explain_finding). */
export const FIX_GUIDANCE: Record<string, string> = {
  RETENTION_AND_TENANT_KMS: "Encrypt the personal data with the tenant's own KMS key (an envelope per tenant), and delete it within the allowed time with a TTL or a scheduled purge.",
  ENCRYPTION_AT_REST: 'Store personal data in encrypted columns or volumes.',
  PII_LOGGING_BAN: 'Redact personal values before logging them (a hashing or masking helper), or log an identifier that is not personal data.',
  RIGHT_TO_ERASURE_CASCADE: "Make deletes cascade to every table and cache that holds the person's data.",
  AI_HUMAN_IN_THE_LOOP: 'Route decisions below the confidence threshold to a human review queue, and log every automated decision.',
  CROSS_BORDER_TRANSFER: 'Configure storage and replication only in the allowed regions.',
  CONSENT_LAWFUL_BASIS: 'Check for recorded consent (or another lawful basis) before processing.',
  BREACH_NOTIFICATION: 'Make sure the incident path notifies within the deadline.',
  DPIA_REQUIRED: 'Reference an approved impact assessment for this processing.',
  DATA_MINIMISATION: 'Remove personal fields the code never uses.',
  PURPOSE_LIMITATION: 'Declare the processing purpose and use the data only for it.',
};

/** Reads a repository's files at a commit (GitHub archive or local folder). */
export type ReadRepoFiles = (repo: Repo, commitSha: string) => Promise<TargetRepoFile[]>;

/** A finding from a recent check_changes call, so later calls can refer to it by fingerprint. */
interface RecentFinding {
  finding: ClassifiedFinding;
  repoId: string;
  at: number;
}

/** State the tools keep between calls, in memory only. Repository files are cached per commit. */
export class WorkspaceToolState {
  private recent = new Map<string, RecentFinding>();
  private files = new Map<string, Promise<TargetRepoFile[]>>();
  private baselines = new Map<string, RawFinding[]>();

  constructor(private readonly ttlMs = 24 * 3600 * 1000) {}

  remember(workspaceId: string, repoId: string, findings: ClassifiedFinding[]): void {
    const at = Date.now();
    for (const f of findings) {
      this.recent.delete(`${workspaceId}:${f.fingerprint}`);
      this.recent.set(`${workspaceId}:${f.fingerprint}`, { finding: f, repoId, at });
    }
    while (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value!);
  }

  recall(workspaceId: string, query: FindingQuery): RecentFinding | undefined {
    const fresh = (r: RecentFinding | undefined) => (r && Date.now() - r.at < this.ttlMs ? r : undefined);
    if ('fingerprint' in query) return fresh(this.recent.get(`${workspaceId}:${query.fingerprint}`));
    const hits = [...this.recent.entries()]
      .filter(([k]) => k.startsWith(`${workspaceId}:`))
      .map(([, r]) => r)
      .filter((r) => r.finding.ruleKey === query.ruleKey && r.finding.filePath === query.filePath && r.finding.startLine <= query.line && r.finding.endLine >= query.line);
    return fresh(hits.at(-1));
  }

  /** Files of one commit, downloaded once; the four most recent commits are kept. */
  repoFiles(repo: Repo, sha: string, read: ReadRepoFiles): Promise<TargetRepoFile[]> {
    const key = `${repo.id}:${sha}`;
    let p = this.files.get(key);
    if (!p) {
      p = read(repo, sha);
      p.catch(() => this.files.delete(key));
      this.files.set(key, p);
      while (this.files.size > 4) this.files.delete(this.files.keys().next().value!);
    }
    return p;
  }

  baseline(key: string): RawFinding[] | undefined {
    return this.baselines.get(key);
  }

  setBaseline(key: string, findings: RawFinding[]): void {
    this.baselines.set(key, findings);
    while (this.baselines.size > 16) this.baselines.delete(this.baselines.keys().next().value!);
  }
}

type FindingQuery = { fingerprint: string } | { ruleKey: string; filePath: string; line: number };

export interface ToolContext {
  store: ProductStore;
  principal: TokenPrincipal;
  state: WorkspaceToolState;
  readRepoFiles: ReadRepoFiles;
  /** The exception lifecycle (evidence, pull request comment). Without it a request only reaches the store. */
  flows?: FlowDeps;
  /** The assistant (client name) the token was last used from, for the requester label. */
  client?: string | null;
}

export interface ToolOutcome {
  data: Record<string, unknown>;
  /** What the assistant reads: a plain-language answer. The server falls back to the JSON of `data`. */
  text?: string;
  /** One line for the call log. */
  summary?: string;
  /** For the call log: the repository, and paths and fingerprints (never code). */
  repo?: string | null;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------- arguments

/** Checks required arguments and top-level types; throws ToolError so the assistant can correct the call. */
export function validateToolArguments(spec: WorkspaceToolSpec, args: Record<string, unknown>): void {
  const properties = (spec.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  for (const key of (spec.inputSchema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined || args[key] === null) throw new ToolError(`Missing required argument "${key}".`);
  }
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (!type || value === undefined || value === null) continue;
    const ok =
      type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'object' ? typeof value === 'object' && !Array.isArray(value) : typeof value === type;
    if (!ok) throw new ToolError(`Argument "${key}" must be ${type === 'integer' ? 'an integer' : `a ${type}`}.`);
  }
}

/** A repository-relative path with forward slashes; refuses absolute paths and "..". */
export function cleanRepoPath(raw: unknown): string {
  const p = String(raw ?? '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..' || s === '')) {
    throw new ToolError(`"${String(raw)}" is not a path from the repository root.`);
  }
  return p;
}

function sentFiles(raw: unknown): Array<{ path: string; content: string }> {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_CHECK_FILES) throw new ToolError(`At most ${MAX_CHECK_FILES} files per call (got ${list.length}).`);
  let bytes = 0;
  const seen = new Set<string>();
  return list.map((f, i) => {
    const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    if (typeof o.content !== 'string') throw new ToolError(`files[${i}].content must be a string.`);
    const path = cleanRepoPath(o.path);
    if (seen.has(path)) throw new ToolError(`${path} is sent twice.`);
    seen.add(path);
    bytes += Buffer.byteLength(o.content, 'utf8');
    if (bytes > MAX_CHECK_BYTES) throw new ToolError('The files are larger than 2 MB in all; send fewer at a time.');
    return { path, content: o.content };
  });
}

// ---------------------------------------------------------------- shared steps

/** A repository of the token's workspace, by owner/name, name or id. */
function resolveRepo(ctx: ToolContext, name: unknown): Repo {
  const wanted = String(name ?? '').trim().toLowerCase();
  const repos = ctx.store.listRepos(ctx.principal.workspaceId);
  if (!wanted) {
    if (repos.length === 1) return repos[0];
    throw new ToolError(`Name the repository (repo). This workspace has: ${repos.map((r) => r.fullName).join(', ') || 'none'}.`);
  }
  const exact = repos.filter((r) => r.fullName.toLowerCase() === wanted || r.id === wanted);
  const matches = exact.length > 0 ? exact : repos.filter((r) => r.fullName.toLowerCase().split('/').pop() === wanted.split('/').pop());
  if (matches.length === 1) return matches[0];
  const known = repos.map((r) => r.fullName).join(', ') || 'none';
  throw new ToolError(matches.length > 1 ? `"${String(name)}" matches several repositories: ${matches.map((r) => r.fullName).join(', ')}.` : `Unknown repository "${String(name)}". This workspace has: ${known}.`);
}

/** Rules in effect for a repository, with the path globs each applies to there. */
function rulesFor(ctx: ToolContext, repo: Repo): { rules: RuleInEffect[]; globs: Map<string, string[]> } {
  const globs = new Map<string, string[]>();
  const rules = ctx.store.rulesInEffect(ctx.principal.workspaceId).filter((r) => {
    const g = ctx.store.ruleScopeGlobs(r.scope, repo.id);
    globs.set(r.ruleKey, g);
    return g.length > 0;
  });
  return { rules, globs };
}


/** The default branch the change is compared with: the latest scanned commit, or a local folder. */
async function baseCommit(ctx: ToolContext, repo: Repo): Promise<{ sha: string; files: TargetRepoFile[]; scanId: string | null; rulesSha256: string | null }> {
  if (repo.source === 'local' && repo.localPath) return { sha: 'working-tree', files: readRepositoryFilesAt(repo.localPath), scanId: null, rulesSha256: null };
  const latest = ctx.store.latestBranchScan(repo.id);
  if (!latest) throw new ToolError(`${repo.fullName} has no scan of ${repo.defaultBranch} yet. It is scanned on the next push to ${repo.defaultBranch} or when Legal approves a rule.`);
  const scan = ctx.store.getScanById(latest.id);
  return { sha: latest.commitSha, files: await ctx.state.repoFiles(repo, latest.commitSha, ctx.readRepoFiles), scanId: latest.id, rulesSha256: scan?.rulesSha256 ?? null };
}

/** The base files with the sent files laid over them and deleted paths removed. Nothing is written to disk. */
function overlay(base: TargetRepoFile[], sent: Array<{ path: string; content: string }>, deleted: string[]): { files: TargetRepoFile[]; ignored: string[] } {
  const byPath = new Map(base.map((f) => [f.path, f]));
  for (const p of deleted) byPath.delete(p);
  const ignored: string[] = [];
  const now = new Date().toISOString();
  for (const f of sent) {
    const language = sourceLanguageForPath(f.path);
    if (!language) {
      ignored.push(f.path);
      continue;
    }
    byPath.set(f.path, { path: f.path, language, description: `${language} source file`, content: f.content, lastModified: now });
  }
  return { files: [...byPath.values()], ignored };
}

/** Findings on the base commit: the stored scan's when it used the same rules, otherwise scanned now (and cached). */
async function baseFindings(ctx: ToolContext, repo: Repo, base: Awaited<ReturnType<typeof baseCommit>>, rules: RuleInEffect[], globs: Map<string, string[]>): Promise<RawFinding[]> {
  const sha = rulesetSha256(rules);
  if (base.scanId && base.rulesSha256 === sha) return ctx.store.listFindings(base.scanId);
  const key = `${repo.id}:${base.sha}:${sha}`;
  const cached = base.sha === 'working-tree' ? undefined : ctx.state.baseline(key);
  if (cached) return cached;
  const findings = (await scanFilesScoped(base.files, rules, globs)).findings;
  if (base.sha !== 'working-tree') ctx.state.setBaseline(key, findings);
  return findings;
}

const findingView = (f: ClassifiedFinding) => ({
  fingerprint: f.fingerprint,
  rule: f.ruleKey,
  state: f.state,
  path: f.filePath,
  line: f.startLine,
  startLine: f.startLine,
  endLine: f.endLine,
  message: f.message,
  snippet: f.snippet.slice(0, 400),
});

/** A finding from a recent check_changes call, or else the latest stored scan that has it. */
function lookupFinding(ctx: ToolContext, query: FindingQuery): { finding: ClassifiedFinding; repoId: string; scan: { id: string; prNumber: number | null; headSha: string; baseSha: string | null } | null } {
  const recent = ctx.state.recall(ctx.principal.workspaceId, query);
  if (recent) return { finding: recent.finding, repoId: recent.repoId, scan: null };
  const stored = ctx.store.findStoredFinding(ctx.principal.workspaceId, query);
  if (stored) return { finding: stored, repoId: stored.repoId, scan: { id: stored.scan.id, prNumber: stored.scan.prNumber, headSha: stored.scan.commitSha, baseSha: stored.scan.baseSha } };
  throw new ToolError('No such finding in this workspace. Call check_changes first, then use a fingerprint it returned.');
}

/** Who approved a rule version, by name (or email), for the plain-language answers. */
function approverName(ctx: ToolContext, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = ctx.store.listMembers(ctx.principal.workspaceId).find((x) => x.userId === userId);
  return m ? m.name ?? m.email : null;
}

/** "Tanvir Rahman via Kiro": the label on an exception request and its pull request comment. */
function requesterLabel(ctx: ToolContext): string {
  const m = ctx.store.listMembers(ctx.principal.workspaceId).find((x) => x.userId === ctx.principal.userId);
  return `${m?.name ?? m?.email ?? 'A member'}${ctx.client ? ` via ${ctx.client}` : ''}`;
}

function findingQuery(args: Record<string, unknown>): FindingQuery {
  if (typeof args.fingerprint === 'string' && args.fingerprint) return { fingerprint: args.fingerprint };
  if (typeof args.rule === 'string' && typeof args.path === 'string' && Number.isInteger(args.line)) return { ruleKey: args.rule, filePath: cleanRepoPath(args.path), line: Number(args.line) };
  throw new ToolError('Give a fingerprint, or rule, path and line.');
}

// ---------------------------------------------------------------- search

interface Passage {
  kind: 'rule' | 'document';
  citation: string;
  /** The rule key (rules only); `key` is the same value under the name list_rules uses. */
  ruleKey?: string;
  key?: string;
  documentId?: string;
  text: string;
}
export type ScoredPassage = Passage & { score: number };

/** The workspace's rules in effect and its documents' clauses. */
function collectPassages(store: ProductStore, workspaceId: string): Passage[] {
  const passages: Passage[] = store.rulesInEffect(workspaceId).map((r) => {
    const version = store.getRuleVersion(workspaceId, r.versionId);
    return { kind: 'rule', ruleKey: r.ruleKey, key: r.ruleKey, citation: `${r.ruleKey} v${r.version} · ${r.clause.citation}`, text: `${r.clause.title}. ${version?.sourceText ?? r.clause.rawLegalText}` };
  });
  for (const doc of store.listDocuments(workspaceId)) {
    const full = store.getDocument(workspaceId, doc.id);
    for (const c of full ? splitClauses(full.text) : []) {
      if (c.text.trim()) passages.push({ kind: 'document', documentId: doc.id, citation: c.number ? `${doc.title} §${c.number}` : doc.title, text: c.text.trim() });
    }
  }
  return passages;
}

/** BM25 score of each passage for the query (zeros when nothing matches). */
function bm25Scores(passages: Passage[], query: string): number[] {
  const terms = [...new Set(bm25Tokens(query))];
  if (terms.length === 0 || passages.length === 0) return passages.map(() => 0);
  const docs = passages.map((p) => bm25Tokens(`${p.citation} ${p.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return passages.map((_, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = docs[i].filter((x) => x === t).length;
      if (!tf) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docs[i].length) / avg));
    }
    return score;
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const finish = (passages: Passage[], scores: number[], limit: number): ScoredPassage[] =>
  passages
    .map((p, i) => ({ ...p, text: p.text.slice(0, 800), score: round3(scores[i]) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 1), 10));

/** BM25 over the workspace's rules in effect and its documents' clauses. */
export function searchObligations(store: ProductStore, workspaceId: string, query: string, limit = 5): ScoredPassage[] {
  const passages = collectPassages(store, workspaceId);
  return finish(passages, bm25Scores(passages, query), limit);
}

/** Embeds at most this many passages per search; vectors are cached, so only the first search pays. */
const MAX_EMBEDDED_PASSAGES = 80;
const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na * nb) || 1);
};

/**
 * Local-embedding search blended with BM25 (0.7 cosine, 0.3 keyword). Without an embedding model
 * (LEXCOMPILER_EMBEDDING_MODEL=none, Ollama not running) it is plain BM25.
 */
export async function searchObligationsSemantic(store: ProductStore, workspaceId: string, query: string, limit = 5): Promise<{ results: ScoredPassage[]; mode: 'semantic' | 'keyword' }> {
  const passages = collectPassages(store, workspaceId);
  const keyword = bm25Scores(passages, query);
  const fallback = { results: finish(passages, keyword, limit), mode: 'keyword' as const };
  if (passages.length === 0 || !query.trim()) return fallback;
  const q = (await computeRealNeuralEmbedding(query)).embedding;
  if (q.length === 0) return fallback;
  // Rules first, then documents by keyword score, up to the cap.
  const order = passages.map((_, i) => i).sort((a, b) => Number(passages[b].kind === 'rule') - Number(passages[a].kind === 'rule') || keyword[b] - keyword[a]).slice(0, MAX_EMBEDDED_PASSAGES);
  const best = Math.max(...keyword, 0);
  const scores = keyword.map((k) => (best > 0 ? 0.3 * (k / best) : 0));
  const similar = new Map<number, number>();
  for (const i of order) {
    const v = (await computeRealNeuralEmbedding(`${passages[i].citation}. ${passages[i].text}`)).embedding;
    // The model stopped answering: keep what was found and rank the rest by keyword.
    if (v.length !== q.length) break;
    similar.set(i, cosine(q, v));
  }
  if (similar.size === 0) return fallback;
  for (const [i, c] of similar) scores[i] += 0.7 * Math.max(0, c);
  // Unrelated passages sit near cosine 0.1-0.3 for small models: show only plausible ones.
  const kept = scores.map((s, i) => (keyword[i] > 0 || (similar.get(i) ?? 0) >= 0.35 ? s : 0));
  return { results: finish(passages, kept, limit), mode: 'semantic' };
}

// ---------------------------------------------------------------- the tools

export async function callWorkspaceTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const spec = WORKSPACE_TOOLS.find((t) => t.name === name);
  if (!spec) throw new ToolError(`Unknown tool "${name}".`);
  validateToolArguments(spec, args);
  const ws = ctx.principal.workspaceId;

  switch (name) {
    case 'list_rules': {
      // Without a repository (and with several), the rules in effect for the whole workspace.
      const named = String(args.repo ?? '').trim() !== '' || ctx.store.listRepos(ws).length === 1;
      const repo = named ? resolveRepo(ctx, args.repo) : null;
      const scoped = repo ? rulesFor(ctx, repo) : { rules: ctx.store.rulesInEffect(ws), globs: new Map<string, string[]>() };
      const rules = scoped.rules.map((r) => {
        const v = ctx.store.getRuleVersion(ws, r.versionId);
        const plain = v?.card && typeof v.card.plainReading === 'string' ? v.card.plainReading : plainReading(r.clause);
        return {
          key: r.ruleKey,
          title: r.clause.title,
          category: CATEGORY_LABELS[r.clause.category],
          plainReading: plain,
          version: r.version,
          citation: r.clause.citation,
          scope: scoped.globs.get(r.ruleKey),
          approvedBy: approverName(ctx, v?.approvedBy),
          approvedAt: v?.approvedAt ?? null,
          effectiveFrom: v?.effectiveFrom ?? v?.approvedAt ?? null,
        };
      });
      const text = rules.length
        ? [
            `${rules.length} rule(s) in effect${repo ? ` for ${repo.fullName}` : ''}:`,
            ...rules.map((r) => `- ${r.key} v${r.version} "${r.title}" (${r.category}): ${r.plainReading} Approved by ${r.approvedBy ?? 'Legal'}${r.approvedAt ? ` on ${r.approvedAt.slice(0, 10)}` : ''}.`),
          ].join('\n')
        : 'No rules are in effect yet. Rules apply once someone with the Legal role approves them in LexCompiler.';
      return { repo: repo?.fullName ?? null, text, summary: `${rules.length} rules`, data: { repo: repo?.fullName ?? null, rules } };
    }

    case 'check_changes': {
      const repo = resolveRepo(ctx, args.repo);
      const sent = sentFiles(args.files);
      const deleted = (Array.isArray(args.deleted) ? args.deleted : []).slice(0, MAX_CHECK_FILES).map(cleanRepoPath);
      const detail = { paths: sent.map((f) => f.path), deleted };
      const { rules, globs } = rulesFor(ctx, repo);
      if (rules.length === 0) {
        const note = 'No approved rules apply to this repository yet, so there is nothing to check.';
        return { repo: repo.fullName, detail, text: note, summary: 'no rules', data: { repo: repo.fullName, conclusion: 'neutral', rules: [], findings: [], note } };
      }
      const base = await baseCommit(ctx, repo);
      const { files, ignored } = overlay(base.files, sent, deleted);
      const head = await scanFilesScoped(files, rules, globs);
      const findings = classifyFindings(head.findings, await baseFindings(ctx, repo, base, rules, globs), ctx.store.activeExceptions(ws, repo.id));
      const summary = summarizeFindings(findings, head.undecidedRuleKeys);
      ctx.state.remember(ws, repo.id, findings);
      // Findings in the sent files first: those are the ones the change can fix.
      const touched = new Set(sent.map((f) => f.path));
      const ordered = [...findings].sort((a, b) => Number(touched.has(b.filePath)) - Number(touched.has(a.filePath)));
      const conclusion = checkConclusion('pull_request', summary);
      const line = (f: ClassifiedFinding) => `- ${f.ruleKey} ${f.filePath}:${f.startLine}: ${f.message} (fingerprint ${f.fingerprint})`;
      const newOnes = findings.filter((f) => f.state === 'new');
      const waived = findings.filter((f) => f.state === 'waived');
      const existingHere = findings.filter((f) => f.state === 'existing' && touched.has(f.filePath));
      const branch = base.sha === 'working-tree' ? repo.defaultBranch : `${repo.defaultBranch} @ ${base.sha.slice(0, 7)}`;
      const text = [
        `Checked ${sent.length} changed file(s)${deleted.length ? ` and ${deleted.length} deletion(s)` : ''} in ${repo.fullName}, laid over ${branch}, against ${rules.map((r) => `${r.ruleKey} v${r.version}`).join(', ')}. This is what the pull request check would report (conclusion: ${conclusion}).`,
        '',
        newOnes.length ? `New findings (${newOnes.length}). These block the pull request:` : 'No new findings. The pull request check would pass for these changes.',
        ...newOnes.map(line),
        ...(waived.length ? ['', `Waived by an approved exception (${waived.length}):`, ...waived.map(line)] : []),
        ...(existingHere.length ? ['', `Already on ${repo.defaultBranch} in the files you changed (${existingHere.length}); they do not block:`, ...existingHere.map(line)] : []),
        ...(summary.existingCount > existingHere.length ? ['', `${summary.existingCount - existingHere.length} more existing finding(s) elsewhere on ${repo.defaultBranch}.`] : []),
        ...(ignored.length ? ['', `${ignored.length} file(s) are not Python, TypeScript or SQL and were not checked.`] : []),
        ...(summary.undecidedRuleKeys.length ? ['', `Rules that could not be decided on this code: ${summary.undecidedRuleKeys.join(', ')}.`] : []),
      ].join('\n');
      return {
        repo: repo.fullName,
        text,
        summary: `${summary.newCount} new, ${summary.waivedCount} waived, ${summary.existingCount} existing`,
        detail: { ...detail, fingerprints: findings.filter((f) => f.state === 'new').map((f) => f.fingerprint) },
        data: {
          repo: repo.fullName,
          baseCommit: base.sha,
          conclusion,
          summary: { new: summary.newCount, existing: summary.existingCount, waived: summary.waivedCount, undecidedRules: summary.undecidedRuleKeys },
          rules: rules.map((r) => ({ key: r.ruleKey, version: r.version, title: r.clause.title })),
          findings: ordered.map(findingView),
          filesChecked: files.length,
          ...(ignored.length ? { ignoredPaths: ignored } : {}),
        },
      };
    }

    case 'explain_finding': {
      // A finding by fingerprint (or rule, path and line), or just a rule key: the rule's own explanation.
      const hasFinding = (typeof args.fingerprint === 'string' && args.fingerprint !== '') || (typeof args.path === 'string' && Number.isInteger(args.line));
      const found = hasFinding ? lookupFinding(ctx, findingQuery(args)) : null;
      const key = found?.finding.ruleKey ?? (typeof args.rule === 'string' ? args.rule.trim() : '');
      if (!key) throw new ToolError('Give a fingerprint, or rule, path and line, or the rule key (rule).');
      const inEffect = ctx.store.rulesInEffect(ws).find((r) => r.ruleKey.toLowerCase() === key.toLowerCase());
      const version = found ? ctx.store.getRuleVersion(ws, found.finding.ruleVersionId) : inEffect ? ctx.store.getRuleVersion(ws, inEffect.versionId) : undefined;
      if (!version) throw new ToolError(found ? 'The rule version of this finding no longer exists.' : `No rule ${key} is in effect in this workspace.`);
      const approver = approverName(ctx, version.approvedBy);
      const finding = found?.finding;
      const repo = found ? ctx.store.getRepo(found.repoId) : undefined;
      const exception = finding?.exceptionId ? ctx.store.getException(ws, finding.exceptionId) : undefined;
      const requires = plainReading(version.clause);
      const guidance = FIX_GUIDANCE[version.clause.category] ?? 'See the rule text.';
      const text = [
        `${finding?.ruleKey ?? inEffect?.ruleKey ?? key} v${version.version}: ${version.clause.title}`,
        `Approved by ${approver ?? 'Legal'}${version.approvedAt ? ` on ${version.approvedAt.slice(0, 10)}` : ''}${version.effectiveFrom ? `, in effect since ${version.effectiveFrom.slice(0, 10)}` : ''}.`,
        `What it requires: ${requires}`,
        `Source text: "${version.sourceText.slice(0, 1500)}"`,
        ...(finding ? [`This finding: ${finding.message} (${finding.filePath}:${finding.startLine}${repo ? `, ${repo.fullName}` : ''}).`] : []),
        ...(exception ? [`An exception is ${exception.status}${exception.expiresAt ? ` until ${exception.expiresAt.slice(0, 10)}` : ''}.`] : []),
        `How code usually satisfies it: ${guidance}`,
      ].join('\n');
      return {
        repo: repo?.fullName ?? null,
        detail: { ...(finding ? { fingerprint: finding.fingerprint } : { rule: key }) },
        text,
        summary: finding ? `${finding.ruleKey} ${finding.fingerprint.slice(0, 8)}` : key,
        data: {
          ...(finding ? { finding: { ...findingView(finding), repo: repo?.fullName ?? null } } : {}),
          rule: {
            key: finding?.ruleKey ?? inEffect?.ruleKey ?? key,
            title: version.clause.title,
            text: version.sourceText,
            citation: version.clause.citation,
            version: version.version,
            approvedBy: approver ?? version.approvedBy,
            approvedAt: version.approvedAt,
            requires,
          },
          why: finding?.message ?? requires,
          howToFix: guidance,
          ...(exception ? { exception: { id: exception.id, status: exception.status, expiresAt: exception.expiresAt } } : {}),
          citations: searchObligations(ctx.store, ws, `${version.clause.title} ${finding?.message ?? ''}`, 3),
        },
      };
    }

    case 'suggest_fix': {
      const repo = resolveRepo(ctx, args.repo);
      const { finding } = lookupFinding(ctx, { fingerprint: String(args.fingerprint) });
      const scoped = rulesFor(ctx, repo);
      const rule = scoped.rules.find((r) => r.ruleKey === finding.ruleKey);
      if (!rule) throw new ToolError(`${finding.ruleKey} does not apply to ${repo.fullName}.`);
      const sent = sentFiles(args.files);
      const base = await baseCommit(ctx, repo);
      const { files } = overlay(base.files, sent, []);
      const detail = { fingerprint: finding.fingerprint, paths: sent.map((f) => f.path) };
      const scan = await scanFilesScoped(files, [rule], scoped.globs);
      if (!scan.findings.some((f) => f.fingerprint === finding.fingerprint)) {
        return { repo: repo.fullName, detail, data: { verified: false, result: 'not found', note: 'This finding is not in the sent files any more.' } };
      }
      const pr = await synthesizeRemediationPullRequest([rule.clause], files, scan.proofs);
      if (!pr || pr.status !== 'READY_TO_MERGE' || pr.postPatchZ3Status !== 'SAT_COMPLIANT') {
        return {
          repo: repo.fullName,
          detail,
          data: { verified: false, result: 'no verified fix', unresolvedRules: pr?.unresolvedClauseIds ?? [rule.ruleKey], validationErrors: pr?.validationErrors ?? [] },
        };
      }
      return {
        repo: repo.fullName,
        detail,
        data: {
          verified: true,
          gate: `Z3: ${finding.ruleKey} is SAT_COMPLIANT after the patch`,
          rule: finding.ruleKey,
          files: pr.filePatches.map((p) => ({ path: p.filePath, summary: p.summary, linesAdded: p.linesAdded, linesRemoved: p.linesRemoved })),
          diff: pr.filePatches.map((p) => p.unifiedDiff).join('\n'),
        },
      };
    }

    case 'request_exception': {
      if (!can(ctx.principal.role, 'requestExceptions')) throw new ToolError(`Your role (${ctx.principal.role}) cannot request exceptions.`);
      // The end date is optional: without it Legal sets one when it approves.
      let requestedUntil: string | null = null;
      if (args.until !== undefined && args.until !== null && args.until !== '') {
        const until = new Date(String(args.until));
        if (Number.isNaN(until.getTime())) throw new ToolError('"until" must be a date (ISO 8601).');
        if (until.getTime() <= Date.now()) throw new ToolError('"until" must be in the future.');
        if (until.getTime() > Date.now() + 366 * 24 * 3600 * 1000) throw new ToolError('An exception can last at most one year.');
        requestedUntil = until.toISOString();
      }
      const reason = String(args.reason ?? '').trim();
      if (!reason) throw new ToolError('Give Legal a reason.');
      const fingerprint = String(args.fingerprint).trim();

      // A finding from a recent check_changes call or a stored scan; otherwise one the assistant
      // describes itself (rule, path, line), as when the code is not on GitHub yet.
      let ref: FindingRef;
      let repoName: string | null = null;
      let prNumber: number | null = null;
      try {
        const { finding, repoId, scan } = lookupFinding(ctx, { fingerprint });
        repoName = ctx.store.getRepo(repoId)?.fullName ?? null;
        prNumber = scan?.prNumber ?? null;
        ref = { ruleId: finding.ruleId, ruleKey: finding.ruleKey, repoId, fingerprint: finding.fingerprint, filePath: finding.filePath, startLine: finding.startLine, message: finding.message, scanId: scan?.id ?? null, prNumber };
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        const rule = typeof args.rule === 'string' ? ctx.store.rulesInEffect(ws).find((r) => r.ruleKey.toLowerCase() === String(args.rule).trim().toLowerCase()) : undefined;
        if (!rule || typeof args.path !== 'string') throw new ToolError('This finding is not known here yet. Call check_changes first, or pass rule, path and line from it.');
        const repo = resolveRepo(ctx, args.repo);
        repoName = repo.fullName;
        ref = {
          ruleId: rule.ruleId,
          ruleKey: rule.ruleKey,
          repoId: repo.id,
          fingerprint,
          filePath: cleanRepoPath(args.path),
          startLine: Number.isInteger(args.line) ? Number(args.line) : 1,
          message: String(args.message ?? '').slice(0, 1000) || `${rule.ruleKey} finding`,
          scanId: null,
          prNumber: null,
        };
      }
      // One lifecycle: evidence, the pull request comment and Legal's inbox. Without flows only the store.
      const flows: FlowDeps = ctx.flows ?? { store: ctx.store, queue: null, publicUrl: '' };
      const [exception] = await requestExceptions(flows, { workspaceId: ws, findings: [ref], reason, requestedBy: ctx.principal.userId, requesterLabel: requesterLabel(ctx), via: 'assistant', requestedUntil });
      const text =
        exception.status === 'approved'
          ? `An exception for this finding is already approved${exception.expiresAt ? ` until ${exception.expiresAt.slice(0, 10)}` : ''}.`
          : `Exception request ${exception.id.slice(0, 8)} for ${exception.ruleKey} at ${exception.filePath}:${exception.startLine} is waiting for Legal. You cannot approve it; Legal decides in LexCompiler${exception.prNumber ? ', and the pull request gets a comment' : ''}.`;
      return {
        repo: repoName,
        text,
        summary: `${exception.ruleKey} ${exception.status}`,
        detail: { fingerprint: ref.fingerprint, exceptionId: exception.id },
        data: { exceptionId: exception.id, status: exception.status, created: exception.created, rule: exception.ruleKey, path: exception.filePath, requestedUntil: exception.requestedUntil, expiresAt: exception.expiresAt, decidedBy: 'Legal, in the LexCompiler inbox' },
      };
    }

    case 'search_obligations': {
      const query = String(args.query).trim();
      if (!query) throw new ToolError('Pass a query.');
      const { results, mode } = await searchObligationsSemantic(ctx.store, ws, query, Number.isInteger(args.limit) ? Number(args.limit) : 5);
      const text = results.length
        ? [`Closest approved rules and documents for "${query}" (${mode === 'semantic' ? 'semantic search with local embeddings' : 'keyword search'}):`, ...results.map((r) => `- ${r.citation} (score ${r.score}): ${r.text.slice(0, 300)}`)].join('\n')
        : 'Nothing in the approved rules or uploaded documents matches. No rule is in effect for this, or the workspace has none yet.';
      return { text, summary: `${results.length} results (${mode})`, data: { query, mode, results } };
    }

    default:
      throw new ToolError(`Tool "${name}" has no implementation.`);
  }
}
