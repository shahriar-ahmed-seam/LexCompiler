import crypto from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AttestationAlgorithm, AttestationSigner } from '../enterprise/attestationSigner.js';
import { getAttestationSigningKey } from '../enterprise/signingKey.js';
import { requestTimestamp } from '../enterprise/timestamp.js';

/**
 * The evidence log (product guide, Phase 5): an append-only, hash-chained, signed record per
 * workspace. Each record has a header and a body:
 * - the header holds the sequence number, time, type, workspace, key id, the previous header's
 *   SHA-256 and the body's SHA-256, and is signed;
 * - the body holds the details.
 * A share link can then include every header of a period (so nothing can be removed unseen)
 * and only the bodies about that customer. The database refuses UPDATE and DELETE on the table.
 *
 * The end of this file keeps the API of the product dashboard's evidence log working
 * (EvidenceEntry, ChainCheck, toEntry, verifyEntries, list, count, verify) over this engine.
 */

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: sorted keys, no whitespace, undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type EvidenceType =
  | 'scan.completed'
  | 'rule.approved'
  | 'rule.rejected'
  | 'rule.retired'
  | 'rule.rescheduled'
  | 'exception.requested'
  | 'exception.approved'
  | 'exception.rejected'
  | 'exception.revoked'
  | 'exception.expired'
  | 'share.created'
  | 'share.revoked';

export interface EvidenceHeader {
  v: 1;
  workspace: string;
  seq: number;
  type: EvidenceType;
  at: string;
  prev: string | null;
  body_sha256: string;
  key_id: string;
}

/** A record as stored: the exact signed header text, its hash, the body text and the signature. */
export interface EvidenceRecord {
  seq: number;
  header: string;
  headerSha256: string;
  body: string;
  signature: string;
}

/**
 * What a body is about, so a share can pick the bodies of its rules and repositories. Every body
 * carries these two fields.
 */
export interface EvidenceSubjects {
  ruleIds: string[];
  repoIds: string[];
}

/** An RFC 3161 token over one header's exact text. */
export interface EvidenceTimestamp {
  seq: number;
  headerSha256: string;
  tsaUrl: string;
  genTime: string;
  serial: string;
  tokenBase64: string;
}

export interface PublicKeyEntry {
  keyId: string;
  algorithm: AttestationAlgorithm;
  publicKeyPem: string;
  validFrom: string;
  validTo: string | null;
}

type Row = Record<string, unknown>;

export class EvidenceLog {
  /** Appends run one at a time in this process, so each header points at the one before it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly db: Db,
    /** The key that signs a workspace's records (one per workspace: `workspaceSigners`). */
    private readonly signer: (workspaceId: string) => Promise<AttestationSigner>,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Appends a signed record and returns its sequence number and header hash. */
  append(workspaceId: string, type: EvidenceType, body: EvidenceSubjects & Record<string, unknown>): Promise<{ seq: number; headerSha256: string; at: string }> {
    const run = this.queue.then(async () => {
      const signer = await this.signer(workspaceId);
      const bodyText = canonicalJson(body);
      const prev = this.db.prepare('SELECT seq, header_sha256 FROM evidence WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1').get(workspaceId) as Row | undefined;
      const header: EvidenceHeader = {
        v: 1,
        workspace: workspaceId,
        seq: prev ? Number(prev.seq) + 1 : 1,
        type,
        at: this.now().toISOString(),
        prev: prev ? String(prev.header_sha256) : null,
        body_sha256: sha256(bodyText),
        key_id: signer.keyId,
      };
      const headerText = canonicalJson(header);
      const signature = (await signer.sign(Buffer.from(headerText, 'utf8'))).toString('base64');
      const headerSha256 = sha256(headerText);
      // One server process writes (the queue above). A second process appending at the same
      // moment fails on the (workspace, seq) primary key instead of forking the chain.
      this.db
        .prepare('INSERT INTO evidence (workspace_id, seq, header, header_sha256, body, signature) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workspaceId, header.seq, headerText, headerSha256, bodyText, signature);
      return { seq: header.seq, headerSha256, at: header.at };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Records whose header time is within [from, to], in sequence order (all when no period). */
  records(workspaceId: string, period: { from?: string; to?: string } = {}): EvidenceRecord[] {
    const rows = this.db.prepare('SELECT seq, header, header_sha256, body, signature FROM evidence WHERE workspace_id = ? ORDER BY seq').all(workspaceId) as Row[];
    return rows
      .map((r) => ({ seq: Number(r.seq), header: String(r.header), headerSha256: String(r.header_sha256), body: String(r.body), signature: String(r.signature) }))
      .filter((r) => {
        const at = (JSON.parse(r.header) as EvidenceHeader).at;
        return (!period.from || at >= period.from) && (!period.to || at <= period.to);
      });
  }

  /**
   * Has a Time-Stamp Authority (RFC 3161) vouch for the newest header's exact text, unless that
   * header already has a token. Returns the new timestamp, or null when there was nothing to do.
   */
  async timestampLatest(workspaceId: string, tsaUrl: string, fetchImpl: typeof fetch = fetch): Promise<EvidenceTimestamp | null> {
    const last = this.db.prepare('SELECT seq, header, header_sha256 FROM evidence WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1').get(workspaceId) as Row | undefined;
    if (!last) return null;
    if (this.db.prepare('SELECT 1 FROM evidence_timestamps WHERE workspace_id = ? AND seq = ?').get(workspaceId, Number(last.seq))) return null;
    const token = await requestTimestamp(Buffer.from(String(last.header), 'utf8'), tsaUrl, fetchImpl);
    this.db
      .prepare('INSERT INTO evidence_timestamps (workspace_id, seq, header_sha256, tsa_url, gen_time, serial, token_base64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, Number(last.seq), String(last.header_sha256), tsaUrl, token.genTime, token.serialNumber, token.tokenBase64, this.now().toISOString());
    return { seq: Number(last.seq), headerSha256: String(last.header_sha256), tsaUrl, genTime: token.genTime, serial: token.serialNumber, tokenBase64: token.tokenBase64 };
  }

  /** Timestamps of this workspace's headers, in sequence order. */
  timestamps(workspaceId: string): EvidenceTimestamp[] {
    return (this.db.prepare('SELECT * FROM evidence_timestamps WHERE workspace_id = ? ORDER BY seq').all(workspaceId) as Row[]).map((r) => ({
      seq: Number(r.seq),
      headerSha256: String(r.header_sha256),
      tsaUrl: String(r.tsa_url),
      genTime: String(r.gen_time),
      serial: String(r.serial),
      tokenBase64: String(r.token_base64),
    }));
  }

  /** Every key that signed this workspace's records, plus the current one. */
  async publicKeys(workspaceId: string, known: Array<{ keyId: string; algorithm: AttestationAlgorithm; publicKeyPem: string; firstUsedAt: string }>, revokedKeyIds: Map<string, string>): Promise<PublicKeyEntry[]> {
    const current = await this.signer(workspaceId);
    // Each key that signed here, with the time of its first record in this workspace.
    const firstUse = new Map(
      (this.db.prepare('SELECT json_extract(header, \'$.key_id\') AS k, MIN(json_extract(header, \'$.at\')) AS at FROM evidence WHERE workspace_id = ? GROUP BY k').all(workspaceId) as Row[]).map((r) => [String(r.k), String(r.at)])
    );
    const used = new Set([...firstUse.keys(), current.keyId]);
    const byId = new Map(known.map((k) => [k.keyId, k]));
    if (!byId.has(current.keyId)) byId.set(current.keyId, { keyId: current.keyId, algorithm: current.algorithm, publicKeyPem: current.publicKeyPem, firstUsedAt: this.now().toISOString() });
    return [...used]
      .map((id) => byId.get(id))
      .filter((k): k is NonNullable<typeof k> => !!k)
      .map((k) => ({ keyId: k.keyId, algorithm: k.algorithm, publicKeyPem: k.publicKeyPem, validFrom: firstUse.get(k.keyId) ?? k.firstUsedAt, validTo: revokedKeyIds.get(k.keyId) ?? null }));
  }

  /** Records as entries (parsed header and body as well as their exact text), in order. `latest` keeps the newest N. */
  list(workspaceId: string, options: { from?: string; to?: string; latest?: number } = {}): EvidenceEntry[] {
    const entries = this.records(workspaceId, { from: options.from, to: options.to }).map(toEntry);
    return options.latest ? entries.slice(-options.latest) : entries;
  }

  count(workspaceId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE workspace_id = ?').get(workspaceId) as Row).n);
  }

  /**
   * The server's own check of a workspace's whole chain, with bodies. Pass the keys the
   * workspace publishes (`keysFor`); without them, the keys that signed here and are known to
   * this log (the current signer) are used.
   */
  async verify(workspaceId: string, keys?: Array<Pick<PublicKeyEntry, 'keyId' | 'publicKeyPem'> & { algorithm?: AttestationAlgorithm }>): Promise<ChainCheck> {
    return verifyEntries(this.list(workspaceId), keys ?? (await this.publicKeys(workspaceId, [], new Map())));
  }
}

/**
 * Checks headers in sequence: each signature, continuous sequence numbers and the hash chain.
 * Used by the server's own consistency check; auditors run verify.mjs from the pack instead.
 */
export function verifyRecords(records: Array<Pick<EvidenceRecord, 'header' | 'signature'> & { body?: string }>, keys: PublicKeyEntry[]): string[] {
  const byId = new Map(keys.map((k) => [k.keyId, k]));
  const problems: string[] = [];
  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  for (const r of records) {
    const h = JSON.parse(r.header) as EvidenceHeader;
    const key = byId.get(h.key_id);
    const ok =
      !!key &&
      (key.algorithm === 'Ed25519'
        ? crypto.verify(null, Buffer.from(r.header, 'utf8'), key.publicKeyPem, Buffer.from(r.signature, 'base64'))
        : crypto.verify('sha256', Buffer.from(r.header, 'utf8'), { key: key.publicKeyPem, dsaEncoding: 'der' }, Buffer.from(r.signature, 'base64')));
    if (!ok) problems.push(`#${h.seq}: bad signature or unknown key`);
    if (prevSeq !== null && h.seq !== prevSeq + 1) problems.push(`#${h.seq}: records missing before it`);
    if (prevHash !== null && h.prev !== prevHash) problems.push(`#${h.seq}: chain broken`);
    if (r.body !== undefined && sha256(r.body) !== h.body_sha256) problems.push(`body #${h.seq}: does not match its signed header`);
    prevHash = sha256(r.header);
    prevSeq = h.seq;
  }
  return problems;
}

/* ---- Compatibility with the product dashboard's evidence API ---- */

/** A record with its header and body parsed, next to their exact signed text. */
export interface EvidenceEntry {
  seq: number;
  header: EvidenceHeader;
  /** The exact signed text of the header. */
  headerJson: string;
  headerSha256: string;
  bodyJson: string;
  body: Record<string, unknown>;
  /** Base64 signature over headerJson. */
  signature: string;
}

/** The result of checking a chain: problems found, keys offered, and the last header's hash. */
export interface ChainCheck {
  ok: boolean;
  count: number;
  problems: string[];
  keyIds: string[];
  lastHeaderSha256: string | null;
  checkedAt: string;
}

export function toEntry(r: EvidenceRecord): EvidenceEntry {
  return {
    seq: r.seq,
    header: JSON.parse(r.header) as EvidenceHeader,
    headerJson: r.header,
    headerSha256: r.headerSha256,
    bodyJson: r.body,
    body: JSON.parse(r.body) as Record<string, unknown>,
    signature: r.signature,
  };
}

/**
 * Checks signatures (Ed25519 or ECDSA P-256), the sequence, the hash chain and, unless
 * `bodies: false`, each body given against its header. A record without `bodyJson` (a body not
 * in a share) is checked by its header only. Keys without an algorithm are Ed25519.
 */
export function verifyEntries(
  entries: Array<{ headerJson: string; signature: string; bodyJson?: string | null }>,
  keys: Array<{ keyId: string; publicKeyPem: string; algorithm?: AttestationAlgorithm }>,
  options: { bodies?: boolean } = {}
): ChainCheck {
  const entriesKeys: PublicKeyEntry[] = keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm ?? 'Ed25519', publicKeyPem: k.publicKeyPem, validFrom: '', validTo: null }));
  const records = entries.map((e) => ({ header: e.headerJson, signature: e.signature, body: options.bodies !== false && e.bodyJson ? e.bodyJson : undefined }));
  const problems = verifyRecords(records, entriesKeys).map((p) => p.replace(/^body #(\d+): /, '#$1: body '));
  const last = entries.at(-1);
  return { ok: problems.length === 0, count: entries.length, problems, keyIds: entriesKeys.map((k) => k.keyId), lastHeaderSha256: last ? sha256(last.headerJson) : null, checkedAt: new Date().toISOString() };
}

/**
 * The server-wide attestation key that the product dashboard's earlier log signed every
 * workspace's records with (key id `ed25519:<first 16 hex of its fingerprint>`). Add it to the
 * `known` keys of `publicKeys` so those records still verify; it is listed only for a workspace
 * whose headers name it.
 */
export function legacyAttestationKey(): { keyId: string; algorithm: AttestationAlgorithm; publicKeyPem: string; firstUsedAt: string } {
  const key = getAttestationSigningKey();
  return { keyId: `ed25519:${key.fingerprintSha256.slice(0, 16)}`, algorithm: 'Ed25519', publicKeyPem: key.publicKeyPem, firstUsedAt: new Date(0).toISOString() };
}
