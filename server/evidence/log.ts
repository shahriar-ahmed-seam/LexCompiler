import crypto from 'node:crypto';
import { getAttestationSigningKey } from '../enterprise/signingKey.js';
import { nowIso, transaction, type Db } from '../db/index.js';
import { sha256Hex } from '../util/hash.js';

/**
 * The workspace's evidence log: append-only (database triggers refuse UPDATE and DELETE), each
 * header signed with Ed25519 and carrying the SHA-256 of the header before it and of its body.
 * A share link can include every header of a period, so an auditor sees nothing was removed,
 * with only the bodies in scope.
 */

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

export interface EvidenceSigner {
  keyId: string;
  publicKeyPem: string;
  sign(data: Buffer): Buffer;
}

export function defaultEvidenceSigner(): EvidenceSigner {
  const key = getAttestationSigningKey();
  return { keyId: `ed25519:${key.fingerprintSha256.slice(0, 16)}`, publicKeyPem: key.publicKeyPem, sign: (data) => crypto.sign(null, data, key.privateKey) };
}

export interface EvidenceHeader {
  v: 1;
  workspace: string;
  seq: number;
  type: string;
  at: string;
  prev: string | null;
  body_sha256: string;
  key_id: string;
}

export interface EvidenceEntry {
  seq: number;
  header: EvidenceHeader;
  /** The exact signed text of the header. */
  headerJson: string;
  headerSha256: string;
  bodyJson: string;
  body: Record<string, unknown>;
  /** Base64 Ed25519 signature over headerJson. */
  signature: string;
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  problems: string[];
  keyIds: string[];
  lastHeaderSha256: string | null;
  checkedAt: string;
}

type Row = Record<string, unknown>;

function entryFrom(r: Row): EvidenceEntry {
  const headerJson = String(r.header);
  const bodyJson = String(r.body);
  return {
    seq: Number(r.seq),
    header: JSON.parse(headerJson) as EvidenceHeader,
    headerJson,
    headerSha256: String(r.header_sha256),
    bodyJson,
    body: JSON.parse(bodyJson) as Record<string, unknown>,
    signature: String(r.signature),
  };
}

/** Checks signatures, the sequence, the hash chain and body hashes. Used by the server, the verifier and tests. */
export function verifyEntries(entries: Array<Pick<EvidenceEntry, 'headerJson' | 'signature' | 'bodyJson'>>, keys: Array<{ keyId: string; publicKeyPem: string }>, options: { bodies?: boolean } = {}): ChainCheck {
  const keyObjects = new Map(keys.map((k) => [k.keyId, crypto.createPublicKey(k.publicKeyPem)]));
  const problems: string[] = [];
  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  for (const e of entries) {
    const h = JSON.parse(e.headerJson) as EvidenceHeader;
    const key = keyObjects.get(h.key_id);
    if (!key || !crypto.verify(null, Buffer.from(e.headerJson, 'utf8'), key, Buffer.from(e.signature, 'base64'))) problems.push(`#${h.seq}: bad signature or unknown key`);
    if (prevSeq !== null && h.seq !== prevSeq + 1) problems.push(`#${h.seq}: records missing before it`);
    if (prevHash !== null && h.prev !== prevHash) problems.push(`#${h.seq}: chain broken`);
    if (options.bodies !== false && e.bodyJson && sha256Hex(e.bodyJson) !== h.body_sha256) problems.push(`#${h.seq}: body does not match its signed header`);
    prevHash = sha256Hex(e.headerJson);
    prevSeq = h.seq;
  }
  return { ok: problems.length === 0, count: entries.length, problems, keyIds: [...keyObjects.keys()], lastHeaderSha256: prevHash, checkedAt: nowIso() };
}

export class EvidenceLog {
  private signer: EvidenceSigner | null;

  constructor(
    private readonly db: Db,
    signer?: EvidenceSigner
  ) {
    this.signer = signer ?? null;
  }

  private get s(): EvidenceSigner {
    return (this.signer ??= defaultEvidenceSigner());
  }

  /** Appends one signed record. Call it outside other transactions. */
  append(workspaceId: string, type: string, body: Record<string, unknown>): EvidenceEntry {
    return transaction(this.db, () => {
      const prev = this.db.prepare('SELECT seq, header_sha256 FROM evidence WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1').get(workspaceId) as Row | undefined;
      const bodyJson = canonicalJson(body);
      const header: EvidenceHeader = {
        v: 1,
        workspace: workspaceId,
        seq: Number(prev?.seq ?? 0) + 1,
        type,
        at: nowIso(),
        prev: prev ? String(prev.header_sha256) : null,
        body_sha256: sha256Hex(bodyJson),
        key_id: this.s.keyId,
      };
      const headerJson = canonicalJson(header);
      const headerSha256 = sha256Hex(headerJson);
      const signature = this.s.sign(Buffer.from(headerJson, 'utf8')).toString('base64');
      this.db
        .prepare('INSERT INTO evidence (workspace_id, seq, header, header_sha256, body, signature) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workspaceId, header.seq, headerJson, headerSha256, bodyJson, signature);
      return { seq: header.seq, header, headerJson, headerSha256, bodyJson, body, signature };
    });
  }

  /** Records in order. `from`/`to` filter by time; `latest` returns the newest N (still in order). */
  list(workspaceId: string, options: { from?: string; to?: string; latest?: number } = {}): EvidenceEntry[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE workspace_id = ? ORDER BY seq').all(workspaceId) as Row[];
    let entries = rows.map(entryFrom);
    if (options.from || options.to) {
      const from = options.from ?? '0000';
      const to = options.to ?? '9999';
      entries = entries.filter((e) => e.header.at >= from && e.header.at <= to);
    }
    return options.latest ? entries.slice(-options.latest) : entries;
  }

  count(workspaceId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE workspace_id = ?').get(workspaceId) as Row).n);
  }

  publicKeys(): Array<{ keyId: string; algorithm: 'Ed25519'; publicKeyPem: string }> {
    return [{ keyId: this.s.keyId, algorithm: 'Ed25519', publicKeyPem: this.s.publicKeyPem }];
  }

  verify(workspaceId: string): ChainCheck {
    return verifyEntries(this.list(workspaceId), this.publicKeys());
  }
}
