/** Shapes of the API responses the product app reads. */

export type Role = 'owner' | 'legal' | 'engineer' | 'viewer' | 'admin';

export interface Me {
  sub: string;
  name?: string;
  email?: string;
  via: string;
  userId: string;
  globalRole: string;
  workspaces: Array<{ id: string; name: string; role: Role; createdAt: string }>;
}

export interface ScanSummary {
  newCount: number;
  existingCount: number;
  waivedCount: number;
  undecidedRuleKeys: string[];
  perRule: Array<{ ruleKey: string; newCount: number; existingCount: number; waivedCount: number }>;
}

export interface ScanRecord {
  id: string;
  repoId: string;
  repoFullName: string;
  commitSha: string;
  baseSha: string | null;
  trigger: string;
  prNumber: number | null;
  ruleVersions: Array<{ ruleKey: string; versionId: string; version: number; clauseSha256: string }>;
  lexcompilerVersion: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  conclusion: string | null;
  checkRunId: number | null;
  filesScanned: number | null;
  summary: ScanSummary | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Finding {
  id: string;
  ruleId: string;
  ruleKey: string;
  fingerprint: string;
  filePath: string;
  startLine: number;
  endLine: number;
  constructType: string;
  message: string;
  snippet: string;
  state: 'new' | 'existing' | 'waived';
  exceptionId: string | null;
}

export interface ExceptionRecord {
  id: string;
  ruleId: string;
  ruleKey: string | null;
  ruleTitle: string | null;
  repoId: string | null;
  repoFullName: string | null;
  fingerprint: string | null;
  filePath: string | null;
  startLine: number | null;
  message: string | null;
  reason: string;
  requesterLabel: string | null;
  requestedFrom: string | null;
  requestedAt: string;
  prNumber: number | null;
  scanId: string | null;
  status: 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked';
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string | null;
}

export interface Activity {
  at: string;
  seq: number | null;
  kind: string;
  text: string;
  link: string | null;
}

export interface Overview {
  workspace: { id: string; name: string; createdAt: string; plan: string; planLabel: string };
  role: Role;
  counts: {
    rulesInEffect: number;
    drafts: number;
    scheduled: number;
    exceptionsWaiting: number;
    exceptionsActive: number;
    evidenceRecords: number;
    members: number;
    aiMode: 'off' | 'local' | 'cloud';
    aiTokensToday: number;
    aiDailyBudget: number;
    assistantCallsToday: number;
  };
  repos: Array<{
    id: string;
    fullName: string;
    defaultBranch: string;
    source: string;
    lastScan: { id: string; commitSha: string; conclusion: string | null; finishedAt: string | null; summary: ScanSummary | null } | null;
    pullRequests: Array<{ scanId: string; prNumber: number; commitSha: string; conclusion: string | null; status: string; createdAt: string; summary: ScanSummary | null }>;
  }>;
  activity: Activity[];
}

export interface RuleVersionSummary {
  id: string;
  version: number;
  status: 'draft' | 'approved' | 'rejected' | 'retired';
  scheduled: boolean;
  inEffect: boolean;
  category: string;
  categoryLabel: string;
  requires: string;
  sourceText: string;
  citation: string;
  clauseSha256: string;
  smtLib2: string;
  rego: string;
  answers: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  effectiveFrom: string | null;
  note: string | null;
}

export interface RuleSummary {
  id: string;
  key: string;
  title: string;
  retiredAt: string | null;
  current: RuleVersionSummary | null;
  latest: RuleVersionSummary;
  hasDraft: boolean;
  versions: RuleVersionSummary[];
}

export interface RuleCard {
  category: string;
  categoryLabel: string;
  inferredCategory: string;
  value: { field: string | null; unit: string | null; value: number | null; status: 'confirmed' | 'question' | 'set_by_legal' | 'not_needed'; question: string | null; parserValue: number | null; modelValue: number | null; quote: string | null };
  ai: { mode: 'off' | 'local' | 'cloud'; status: string; model: string | null; endpointHost: string | null; detail: string | null; tokens: number; latencyMs: number };
  highlights: Array<{ start: number; end: number; kind: 'value' | 'obligation' | 'quote' }>;
  plainReading: string;
  reviewNotes: string[];
  impact: Array<{ repoId: string; repoFullName: string; commitSha: string; scannedAt: string | null; failing: number; locations: Array<{ filePath: string; line: number; explanation: string }> }>;
  compiled: { smtLib2: string; rego: string; formula: string };
}

export interface EvidenceRecord {
  seq: number;
  header: { v: 1; workspace: string; seq: number; type: string; at: string; prev: string | null; body_sha256: string; key_id: string };
  headerJson: string;
  headerSha256: string;
  signature: string;
  body: Record<string, unknown>;
  bodyJson: string;
  kind: string;
  text: string;
  link: string | null;
}

export interface PublicKey {
  keyId: string;
  algorithm: string;
  publicKeyPem: string;
}

export interface ShareRecord {
  id: string;
  label: string | null;
  periodFrom: string;
  periodTo: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  lastViewedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
  url?: string;
}

export interface TokenRecord {
  id: string;
  userName: string | null;
  name: string;
  hint: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastClient: string | null;
  status: 'active' | 'expired' | 'revoked';
  token?: string;
  mcpUrl?: string;
}

export interface AssistantCall {
  id: string;
  userName: string | null;
  client: string | null;
  tool: string | null;
  repo: string | null;
  outcome: string;
  summary: string | null;
  durationMs: number;
  createdAt: string;
}

const PERMS = {
  manageWorkspace: ['owner'],
  editRules: ['legal'],
  decideExceptions: ['legal'],
  requestExceptions: ['owner', 'legal', 'engineer'],
  createShares: ['owner', 'legal'],
} as const;

export function can(role: Role | undefined, action: keyof typeof PERMS): boolean {
  return role === 'admin' || (!!role && (PERMS[action] as readonly string[]).includes(role));
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', legal: 'Legal', engineer: 'Engineer', viewer: 'Viewer', admin: 'Administrator' };
