import { createTwoFilesPatch } from 'diff';
import { analyzeFullRepositoryAsync, checkSourceSyntaxAsync } from '../analyzer/astAnalyzer.js';
import { executeSchemaOnPostgres } from '../sandbox/postgresSandbox.js';
import { verifyRepositoryAgainstClauses } from '../prover/z3Engine.js';
import { sha256Hex } from '../util/hash.js';
import type {
  ASTFindingNode,
  ClauseVerificationProof,
  FilePatchDiff,
  LegalClause,
  RemediationPullRequest,
  SourceEditAnchor,
  TargetRepoFile,
  Z3RepairTarget,
} from '../../shared/types.js';

const MAX_REPAIR_ROUNDS = 4;

/**
 * Inserted when a patch introduces redact_pii(...). Keyed HMAC tokens: the raw value
 * cannot be recovered from logs, and setting PII_REDACTION_KEY keeps tokens stable
 * across processes for correlation.
 */
export const REDACT_PII_HELPER = `import hashlib as _lexc_hashlib
import hmac as _lexc_hmac
import os as _lexc_os

_PII_REDACTION_KEY = _lexc_os.environ.get("PII_REDACTION_KEY", "").encode("utf-8") or _lexc_os.urandom(32)


def redact_pii(value: object) -> str:
    """Keyed HMAC-SHA256 token so logs never contain raw PII (HIPAA §164.312(b))."""
    digest = _lexc_hmac.new(_PII_REDACTION_KEY, str(value).encode("utf-8"), _lexc_hashlib.sha256).hexdigest()[:16]
    return f"[REDACTED:{digest}]"
`;

/**
 * Inserted when a patch introduces encrypt_with_tenant_kms(...). It never returns
 * plaintext: without a configured KMS client it fails closed.
 */
export const REQUIRE_CONSENT_HELPER = `# Set to an object exposing has_consent(subject) -> bool (your consent / lawful-basis registry).
CONSENT_REGISTRY = None


def require_consent(subject):
    """Fails closed: processing stops unless the registry records consent or another lawful basis."""
    if CONSENT_REGISTRY is None:
        raise PermissionError("CONSENT_REGISTRY is not configured; refusing to process personal data")
    if not CONSENT_REGISTRY.has_consent(subject):
        raise PermissionError("No consent or other lawful basis is recorded for this data subject")`;

export const TENANT_KMS_HELPER = `# Set to a KMS client exposing encrypt(tenant_id: str, plaintext: bytes) -> bytes (e.g. an AWS KMS wrapper).
TENANT_KMS_CLIENT = None


def encrypt_with_tenant_kms(plaintext: str, tenant_id: str) -> str:
    """Envelope-encrypts PII with the tenant's KMS key; fails closed when no client is configured."""
    if TENANT_KMS_CLIENT is None:
        raise RuntimeError("TENANT_KMS_CLIENT is not configured; refusing to persist PII without tenant-isolated encryption")
    import base64
    return base64.b64encode(TENANT_KMS_CLIENT.encrypt(tenant_id, plaintext.encode("utf-8"))).decode("ascii")
`;

interface TextEdit {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  /** Human-readable description for the patch summary. */
  note: string;
}

/** Applies non-overlapping edits (1-based lines, 0-based columns) from the end of the file backwards. */
export function applyEdits(content: string, edits: TextEdit[]): { content: string; applied: TextEdit[] } {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const offset = (line: number, col: number) => (lineStarts[line - 1] ?? content.length) + col;
  const sorted = edits
    .map((e) => ({ e, start: offset(e.line, e.column), end: offset(e.endLine, e.endColumn) }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let next = content;
  let lowerBound = Infinity;
  const applied: TextEdit[] = [];
  for (const { e, start, end } of sorted) {
    if (end > lowerBound || start > end) continue; // overlaps an edit already applied
    next = next.slice(0, start) + e.text + next.slice(end);
    lowerBound = start;
    applied.push(e);
  }
  return { content: next, applied: applied.reverse() };
}

function spanMatches(content: string, a: SourceEditAnchor): boolean {
  if (!a.sourceText) return true;
  const lines = content.split('\n');
  if (a.line === a.endLine) {
    return (lines[a.line - 1] || '').slice(a.column, a.endColumn) === a.sourceText;
  }
  const parts = [(lines[a.line - 1] || '').slice(a.column), ...lines.slice(a.line, a.endLine - 1), (lines[a.endLine - 1] || '').slice(0, a.endColumn)];
  return parts.join('\n') === a.sourceText;
}

function replaceAnchor(a: SourceEditAnchor, text: string, note: string): TextEdit {
  return { line: a.line, column: a.column, endLine: a.endLine, endColumn: a.endColumn, text, note };
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

function quoteLike(sourceText: string, value: string): string {
  const q = sourceText.startsWith("'") ? "'" : sourceText.startsWith('`') ? '`' : '"';
  return `${q}${value}${q}`;
}

/** Python helper insertion point: after the last top-level import, else after the header comments. */
function pythonHelperEdit(content: string, helper: string, note: string): TextEdit {
  const lines = content.split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(import\s|from\s+\S+\s+import\s)/.test(lines[i])) insertAt = i + 1;
    else if (insertAt >= 0 && lines[i].trim() && !/^\s/.test(lines[i]) && !/^[)\\]/.test(lines[i])) break;
  }
  if (insertAt < 0) {
    insertAt = 0;
    while (insertAt < lines.length && (/^\s*#/.test(lines[insertAt]) || !lines[insertAt].trim())) insertAt++;
  }
  return { line: insertAt + 1, column: 0, endLine: insertAt + 1, endColumn: 0, text: `\n${helper}\n\n`, note };
}

/** Collapses targets per finding+action, keeping the strictest required value. */
function mergeTargets(targets: Z3RepairTarget[]): Z3RepairTarget[] {
  const byKey = new Map<string, Z3RepairTarget>();
  for (const t of targets) {
    const key = `${t.findingId}|${t.repairAction}|${t.anchorSymbol || ''}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, t);
      continue;
    }
    if ((t.repairAction === 'SET_RETENTION_BOUND' || t.repairAction === 'ADD_RETENTION_COLUMN') && Number(t.requiredValue) < Number(prev.requiredValue)) {
      byKey.set(key, t);
    }
    if (t.repairAction === 'SET_BREACH_DEADLINE' && Number(t.requiredValue) < Number(prev.requiredValue)) {
      byKey.set(key, t);
    }
    if (t.repairAction === 'RAISE_CONFIDENCE_GATE' && Number(t.requiredValue) > Number(prev.requiredValue)) {
      byKey.set(key, t);
    }
  }
  return [...byKey.values()];
}

/** Translates repair targets into exact text edits at the analyzer's anchors. */
function editsForTargets(
  content: string,
  finding: ASTFindingNode,
  targets: Z3RepairTarget[]
): TextEdit[] {
  const edits: TextEdit[] = [];
  const anchors = (role: SourceEditAnchor['role']) =>
    (finding.editAnchors || []).filter((a) => a.role === role && spanMatches(content, a));
  let needsKmsHelper = false;
  let needsRedactHelper = false;
  let needsConsentHelper = false;

  for (const t of targets) {
    switch (t.repairAction) {
      case 'SET_RETENTION_BOUND': {
        const hours = Number(t.requiredValue);
        for (const a of anchors('RETENTION_TTL_LITERAL')) {
          const perUnit = a.hoursPerUnit || 1;
          const value = hours / perUnit;
          edits.push(replaceAnchor(a, formatNumber(value), `${a.symbol}: ${a.sourceText} → ${formatNumber(value)} (${hours}h)`));
        }
        for (const a of anchors('RETENTION_ANNOTATION_LITERAL')) {
          edits.push(replaceAnchor(a, `@retention_hours(${formatNumber(hours)})`, `@retention_hours → ${hours}`));
        }
        break;
      }
      case 'ADD_RETENTION_COLUMN': {
        const a = anchors('SQL_COLUMN_INSERTION_POINT')[0];
        if (a) {
          const indent = a.context?.indent || '    ';
          const h = formatNumber(Number(t.requiredValue));
          edits.push({ ...replaceAnchor(a, `${indent}retention_ttl_hours INT DEFAULT ${h}, -- @retention_hours(${h})\n`, `add retention_ttl_hours DEFAULT ${h}`) });
        }
        break;
      }
      case 'ADD_TENANT_KMS_COLUMN': {
        const a = anchors('SQL_COLUMN_INSERTION_POINT')[0];
        if (a) {
          const indent = a.context?.indent || '    ';
          edits.push({
            ...replaceAnchor(a, `${indent}tenant_kms_key_id VARCHAR(128) NOT NULL, -- @tenant_isolated_kms\n`, 'add tenant_kms_key_id column'),
            // Keep the column insertion ahead of a retention insertion at the same point.
            column: 0,
          });
        }
        break;
      }
      case 'ENCRYPT_COLUMN': {
        for (const a of anchors('SQL_COLUMN_ENCRYPTION_ANNOTATION')) {
          const text = a.context?.hasComment === 'true' ? ' @encrypted(AES-256-GCM)' : ' -- @encrypted(AES-256-GCM)';
          edits.push(replaceAnchor(a, text, `mark ${a.symbol} @encrypted(AES-256-GCM)`));
        }
        break;
      }
      case 'CASCADE_FOREIGN_KEY': {
        for (const a of anchors('SQL_FOREIGN_KEY_ON_DELETE')) {
          if (t.anchorSymbol && a.symbol !== t.anchorSymbol) continue;
          edits.push(replaceAnchor(a, a.sourceText ? 'ON DELETE CASCADE' : ' ON DELETE CASCADE', `${a.symbol} ON DELETE CASCADE`));
        }
        break;
      }
      case 'ENABLE_TENANT_KMS': {
        for (const a of anchors('TENANT_KMS_FLAG')) {
          if (a.booleanValue !== true) edits.push(replaceAnchor(a, 'True', `${a.symbol} = True`));
        }
        for (const a of anchors('CIPHER_LABEL')) {
          if (/shared/i.test(a.sourceText)) edits.push(replaceAnchor(a, quoteLike(a.sourceText, 'AES-256-GCM-TENANT-KMS'), `${a.symbol} = AES-256-GCM-TENANT-KMS`));
        }
        for (const a of anchors('SHARED_KEY_ENCRYPT_CALL')) {
          const tenantArg = a.context?.tenantArg;
          const endLine = Number(a.context?.callEndLine);
          const endCol = Number(a.context?.callEndColumn);
          if (!tenantArg || !endLine || !endCol) continue; // no tenant id in scope: left unresolved
          edits.push(replaceAnchor(a, 'encrypt_with_tenant_kms', `${a.sourceText}(...) → encrypt_with_tenant_kms(...)`));
          edits.push({ line: endLine, column: endCol - 1, endLine, endColumn: endCol - 1, text: `, tenant_id=${tenantArg}`, note: '' });
          needsKmsHelper = true;
        }
        break;
      }
      case 'REDACT_LOG_ARGUMENTS': {
        for (const a of anchors('PII_LOG_ARGUMENT')) {
          edits.push(replaceAnchor(a, `redact_pii(${a.sourceText})`, `redact ${a.sourceText} in ${finding.functionName}`));
          needsRedactHelper = true;
        }
        break;
      }
      case 'RAISE_CONFIDENCE_GATE': {
        const required = Number(t.requiredValue);
        for (const a of anchors('AI_CONFIDENCE_THRESHOLD')) {
          const value = a.context?.scale === 'percent' ? formatNumber(required * 100) : required.toFixed(2);
          edits.push(replaceAnchor(a, value, `${a.symbol}: ${a.sourceText} → ${value}`));
        }
        break;
      }
      case 'ENABLE_HUMAN_OVERSIGHT':
        for (const a of anchors('HUMAN_OVERSIGHT_FLAG')) edits.push(replaceAnchor(a, 'true', `${a.symbol} = true`));
        break;
      case 'ENABLE_AUDIT_LOG':
        for (const a of anchors('AUDIT_LOG_FLAG')) edits.push(replaceAnchor(a, 'true', `${a.symbol} = true`));
        break;
      case 'PIN_EGRESS_REGION':
      case 'ENABLE_SOVEREIGN_GUARD': {
        if (t.repairAction === 'PIN_EGRESS_REGION') {
          for (const a of anchors('EGRESS_REGION_LITERAL')) {
            edits.push(replaceAnchor(a, quoteLike(a.sourceText, String(t.requiredValue)), `${a.symbol}: ${a.sourceText} → "${t.requiredValue}"`));
          }
        }
        for (const a of anchors('SOVEREIGN_BOUNDARY_FLAG')) {
          if (a.booleanValue !== true) edits.push(replaceAnchor(a, 'true', `${a.symbol} = true`));
        }
        break;
      }
      case 'INSERT_CONSENT_CHECK': {
        for (const a of anchors('CONSENT_CHECK_INSERTION_POINT')) {
          const indent = a.context?.indent || '    ';
          edits.push(replaceAnchor(a, `${indent}require_consent(${a.context?.subject || 'None'})\n`, `${a.symbol}: require_consent(${a.context?.subject})`));
          needsConsentHelper = true;
        }
        break;
      }
      case 'SET_BREACH_DEADLINE': {
        const hours = Number(t.requiredValue);
        for (const a of anchors('BREACH_DEADLINE_LITERAL')) {
          const value = formatNumber(hours / (a.hoursPerUnit || 1));
          edits.push(replaceAnchor(a, value, `${a.symbol}: ${a.sourceText} → ${value} (${hours}h)`));
        }
        break;
      }
      case 'ADD_BREACH_POLICY': {
        if (finding.language === 'python' && !/BREACH_NOTIFICATION_DEADLINE_HOURS\s*=/.test(content)) {
          const h = formatNumber(Number(t.requiredValue));
          edits.push(pythonHelperEdit(content, `# GDPR Art. 33(1): notify the supervisory authority of a personal-data breach within this window.\nBREACH_NOTIFICATION_DEADLINE_HOURS = ${h}`, `add BREACH_NOTIFICATION_DEADLINE_HOURS = ${h}`));
        }
        break;
      }
      case 'REMOVE_UNUSED_PII_FIELD': {
        for (const a of anchors('PII_MODEL_FIELD')) edits.push(replaceAnchor(a, '', `remove unused PII field ${a.symbol}`));
        break;
      }
      case 'PIN_PROCESSING_PURPOSE': {
        const purpose = String(t.requiredValue);
        const literal = anchors('PROCESSING_PURPOSE_LITERAL')[0];
        if (literal) {
          if (literal.stringValue !== purpose) edits.push(replaceAnchor(literal, quoteLike(literal.sourceText, purpose), `${literal.symbol} → "${purpose}"`));
        } else if (finding.language === 'python' && !/^PROCESSING_PURPOSE\s*=/m.test(content)) {
          edits.push(pythonHelperEdit(content, `# GDPR Art. 5(1)(b): the purpose this module processes personal data for.\nPROCESSING_PURPOSE = "${purpose}"`, `declare PROCESSING_PURPOSE = "${purpose}"`));
        }
        break;
      }
      default:
        break;
    }
  }

  if (needsKmsHelper && !/def encrypt_with_tenant_kms\(/.test(content)) {
    edits.push(pythonHelperEdit(content, TENANT_KMS_HELPER, 'add fail-closed encrypt_with_tenant_kms helper'));
  }
  if (needsConsentHelper && !/def require_consent\(/.test(content)) {
    edits.push(pythonHelperEdit(content, REQUIRE_CONSENT_HELPER, 'add fail-closed require_consent helper'));
  }
  // A file that already defines or imports redact_pii (for example from a shared privacy module) uses it.
  if (needsRedactHelper && !/def redact_pii\(/.test(content) && !/^[ \t]*from[ \t]+[\w.]+[ \t]+import[^\n#]*\bredact_pii\b/m.test(content)) {
    edits.push(pythonHelperEdit(content, REDACT_PII_HELPER, 'add keyed redact_pii helper'));
  }
  return edits;
}

function createUnifiedDiff(filePath: string, original: string, patched: string): { patch: string; added: number; removed: number } {
  const patch = createTwoFilesPatch(`a/${filePath}`, `b/${filePath}`, original, patched, '', '', { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { patch, added, removed };
}

function titleFor(targets: Z3RepairTarget[]): string {
  const parts: string[] = [];
  const retention = targets.filter((t) => t.repairAction === 'SET_RETENTION_BOUND' || t.repairAction === 'ADD_RETENTION_COLUMN');
  if (retention.length) parts.push(`${formatNumber(Math.min(...retention.map((t) => Number(t.requiredValue))))}h PII retention`);
  if (targets.some((t) => t.repairAction === 'ENABLE_TENANT_KMS' || t.repairAction === 'ADD_TENANT_KMS_COLUMN')) parts.push('tenant-isolated KMS keys');
  if (targets.some((t) => t.repairAction === 'ENCRYPT_COLUMN')) parts.push('column encryption');
  if (targets.some((t) => t.repairAction === 'REDACT_LOG_ARGUMENTS')) parts.push('PII log redaction');
  const conf = targets.filter((t) => t.repairAction === 'RAISE_CONFIDENCE_GATE');
  if (conf.length) parts.push(`${Math.max(...conf.map((t) => Number(t.requiredValue))).toFixed(2)} AI confidence gate`);
  if (targets.some((t) => t.repairAction === 'ENABLE_HUMAN_OVERSIGHT' || t.repairAction === 'ENABLE_AUDIT_LOG')) parts.push('human oversight & audit log');
  const regions = [...new Set(targets.filter((t) => t.repairAction === 'PIN_EGRESS_REGION').map((t) => String(t.requiredValue)))];
  if (regions.length) parts.push(`${regions.join('/')} data residency`);
  if (targets.some((t) => t.repairAction === 'CASCADE_FOREIGN_KEY')) parts.push('erasure cascade');
  if (targets.some((t) => t.repairAction === 'INSERT_CONSENT_CHECK')) parts.push('consent checks');
  if (targets.some((t) => t.repairAction === 'SET_BREACH_DEADLINE' || t.repairAction === 'ADD_BREACH_POLICY')) parts.push('breach-notification deadline');
  if (targets.some((t) => t.repairAction === 'REMOVE_UNUSED_PII_FIELD')) parts.push('data minimisation');
  if (targets.some((t) => t.repairAction === 'PIN_PROCESSING_PURPOSE')) parts.push('processing purpose');
  return `fix(compliance): enforce ${parts.join(', ') || 'statutory invariants'}`;
}

/**
 * Counterexample-guided repair loop: each round takes the repair targets of every
 * clause Z3 still refutes, rewrites only the anchored source spans (strictest value
 * wins when clauses disagree), re-parses the patched files, and re-verifies with Z3.
 * The PR is READY_TO_MERGE only when every clause is SAT and every patched file
 * still parses; otherwise it is BLOCKED_UNRESOLVED with the reasons listed.
 */
export async function synthesizeRemediationPullRequest(
  clauses: LegalClause[],
  currentFiles: TargetRepoFile[],
  currentProofs: ClauseVerificationProof[]
): Promise<RemediationPullRequest | null> {
  const violatedProofs = currentProofs.filter((p) => p.status === 'UNSAT_VIOLATION');
  if (violatedProofs.length === 0) {
    return null;
  }

  const originals = new Map(currentFiles.map((f) => [f.path, f.content]));
  let files: TargetRepoFile[] = currentFiles.map((f) => ({ ...f }));
  let proofs = currentProofs;
  let analysis = await analyzeFullRepositoryAsync(files);
  let verifyMs = 0;
  let merkleAuditRoot = '';
  let rounds = 0;
  const notesByFile = new Map<string, string[]>();
  const clausesByFile = new Map<string, Set<string>>();
  const nodeByFile = new Map<string, string>();
  const lineByFile = new Map<string, [number, number]>();
  const allTargets: Z3RepairTarget[] = [];

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    const leftover = proofs.filter((p) => p.status === 'UNSAT_VIOLATION');
    if (leftover.length === 0) break;
    const targets = mergeTargets(leftover.flatMap((p) => p.repairTargets || []));
    const findingsById = new Map(analysis.astFindings.map((f) => [f.id, f]));
    let changed = false;

    files = files.map((file) => {
      const fileTargets = targets.filter((t) => t.filePath === file.path);
      if (fileTargets.length === 0) return file;
      const edits: TextEdit[] = [];
      const byFinding = new Map<string, Z3RepairTarget[]>();
      for (const t of fileTargets) byFinding.set(t.findingId, [...(byFinding.get(t.findingId) || []), t]);
      for (const [findingId, ts] of byFinding) {
        const finding = findingsById.get(findingId);
        if (finding) edits.push(...editsForTargets(file.content, finding, ts));
      }
      if (edits.length === 0) return file;
      // Findings in the same file can request the same helper insertion; apply it once.
      const unique = edits.filter(
        (e, i) => edits.findIndex((x) => x.line === e.line && x.column === e.column && x.endLine === e.endLine && x.endColumn === e.endColumn && x.text === e.text) === i
      );
      const { content, applied } = applyEdits(file.content, unique);
      if (content === file.content) return file;
      changed = true;
      allTargets.push(...fileTargets);
      notesByFile.set(file.path, [...(notesByFile.get(file.path) || []), ...applied.map((e) => e.note).filter(Boolean)]);
      const ids = clausesByFile.get(file.path) || new Set<string>();
      for (const p of leftover) {
        if ((p.repairTargets || []).some((t) => t.filePath === file.path)) ids.add(p.clauseId);
      }
      clausesByFile.set(file.path, ids);
      if (!nodeByFile.has(file.path)) nodeByFile.set(file.path, fileTargets[0].nodeId);
      if (!lineByFile.has(file.path)) {
        const f = findingsById.get(fileTargets[0].findingId);
        lineByFile.set(file.path, [f?.line ?? 1, f?.endLine ?? 1]);
      }
      return { ...file, content };
    });

    if (!changed) break;
    rounds++;
    analysis = await analyzeFullRepositoryAsync(files);
    const verification = await verifyRepositoryAgainstClauses(clauses, analysis.sqlTables, analysis.astFindings);
    proofs = verification.proofs;
    verifyMs += verification.totalZ3ExecutionMs;
    merkleAuditRoot = verification.merkleAuditRoot;
  }

  const filePatches: FilePatchDiff[] = [];
  const syntaxFailures: string[] = [];
  for (const file of files) {
    const original = originals.get(file.path) ?? '';
    if (file.content === original) continue;
    let syntaxCheck = await checkSourceSyntaxAsync(file);
    if (syntaxCheck.passed && file.language === 'sql') {
      // The patched DDL must also be accepted by a real PostgreSQL engine.
      try {
        await executeSchemaOnPostgres(file.content);
        syntaxCheck = { passed: true, message: 'Executed on PostgreSQL' };
      } catch (err) {
        syntaxCheck = { passed: false, message: `PostgreSQL rejected the schema: ${(err as Error).message}` };
      }
    }
    if (!syntaxCheck.passed) syntaxFailures.push(`${file.path}: ${syntaxCheck.message}`);
    const diff = createUnifiedDiff(file.path, original, file.content);
    const [start, end] = lineByFile.get(file.path) || [1, 1];
    filePatches.push({
      nodeId: nodeByFile.get(file.path) || 'node-postgres-schema',
      filePath: file.path,
      language: file.language,
      summary: [...new Set(notesByFile.get(file.path) || [])].join('; ') || `Patch for ${file.path}`,
      offendingLineStart: start,
      offendingLineEnd: end,
      originalContent: original,
      patchedContent: file.content,
      unifiedDiff: diff.patch,
      linesAdded: diff.added,
      linesRemoved: diff.removed,
      addressedClauseIds: [...(clausesByFile.get(file.path) || [])],
      syntaxCheck,
    });
  }

  const unresolvedClauseIds = proofs.filter((p) => p.status !== 'SAT_COMPLIANT').map((p) => p.clauseId);
  const allResolved = unresolvedClauseIds.length === 0 && syntaxFailures.length === 0;

  if (filePatches.length === 0) {
    return {
      prId: `PR-LEX-${sha256Hex(JSON.stringify(violatedProofs.map((p) => p.clauseId))).slice(0, 8)}`,
      prNumber: 0,
      title: 'No automatic remediation available',
      branchName: '',
      baseBranch: 'main',
      status: 'BLOCKED_UNRESOLVED',
      createdAt: new Date().toISOString(),
      triggeredBy: violatedProofs.map((p) => p.citation).join(' + '),
      addressedViolationsCount: 0,
      addressedClauses: [],
      prePatchZ3Status: 'UNSAT_VIOLATION',
      postPatchZ3Status: 'UNSAT_VIOLATION',
      postPatchVerifyTimeMs: 0,
      cegisIterations: 0,
      unresolvedClauseIds: violatedProofs.map((p) => p.clauseId),
      cryptographicAttestationHash: '',
      executiveSummary:
        'Z3 reports violations, but the analyzer found no editable source anchors for them (for example a value computed at runtime or a missing tenant id in scope). Fix these manually.',
      filePatches: [],
    };
  }

  const patchedPaths = filePatches.map((fp) => fp.filePath).join(', ');
  const executiveSummary = allResolved
    ? `LexCompiler patched ${filePatches.length} file(s) (${patchedPaths}) in ${rounds} repair round(s). ` +
      `Every patched file re-parses, and post-patch re-verification in Microsoft Z3 found all ${clauses.length} clauses SAT_COMPLIANT (${verifyMs} ms).`
    : `LexCompiler patched ${filePatches.length} file(s) (${patchedPaths}) in ${rounds} repair round(s), but the result is blocked by the pre-PR gate: ` +
      [
        unresolvedClauseIds.length > 0
          ? `Z3 still reports ${unresolvedClauseIds.length} of ${clauses.length} clauses unresolved (${unresolvedClauseIds.join(', ')})`
          : '',
        syntaxFailures.length > 0 ? `patched files fail to parse (${syntaxFailures.join('; ')})` : '',
      ]
        .filter(Boolean)
        .join('; ') +
      '. The PR cannot be applied.';

  const fingerprint = sha256Hex(filePatches.map((fp) => `${fp.filePath}\n${fp.patchedContent}`).join('\n'));
  return {
    prId: `PR-LEX-${fingerprint.slice(0, 8)}`,
    // Local remediation bundle: LexCompiler does not open GitHub pull requests.
    prNumber: 0,
    title: titleFor(allTargets),
    branchName: `lexcompiler/remediate-${fingerprint.slice(0, 8)}`,
    baseBranch: 'main',
    status: allResolved ? 'READY_TO_MERGE' : 'BLOCKED_UNRESOLVED',
    createdAt: new Date().toISOString(),
    triggeredBy: violatedProofs.map((p) => p.citation).join(' + '),
    addressedViolationsCount: violatedProofs.length,
    addressedClauses: violatedProofs.map((p) => ({ clauseId: p.clauseId, citation: p.citation, title: p.title })),
    prePatchZ3Status: 'UNSAT_VIOLATION',
    postPatchZ3Status: allResolved ? 'SAT_COMPLIANT' : 'UNSAT_VIOLATION',
    postPatchVerifyTimeMs: Math.round(verifyMs * 100) / 100,
    cegisIterations: rounds,
    unresolvedClauseIds,
    validationErrors: syntaxFailures,
    cryptographicAttestationHash: merkleAuditRoot,
    executiveSummary,
    filePatches,
  };
}
