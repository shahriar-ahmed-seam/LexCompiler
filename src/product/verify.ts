import type { PublicKey } from './types';

/**
 * Checks evidence records in the browser with Web Crypto: each header's Ed25519 or ECDSA P-256 signature, the
 * sequence, the hash chain, and each body's SHA-256. The same checks as the server and the
 * offline verifier, run by code on the auditor's side.
 */
export interface BrowserCheck {
  supported: boolean;
  ok: boolean;
  count: number;
  problems: string[];
  ms: number;
}

const enc = new TextEncoder();
const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const pemToDer = (pem: string) => toBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
/** DER ECDSA signature to the raw r||s form Web Crypto expects. */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let p = 2;
  const read = () => {
    const len = der[p + 1];
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyInBrowser(records: Array<{ headerJson: string; signature: string; bodyJson?: string }>, keys: PublicKey[]): Promise<BrowserCheck> {
  const t0 = performance.now();
  const imported = new Map<string, { key: CryptoKey; ecdsa: boolean }>();
  try {
    for (const k of keys) {
      const ecdsa = k.algorithm !== 'Ed25519';
      const algo = ecdsa ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' };
      imported.set(k.keyId, { key: await crypto.subtle.importKey('spki', pemToDer(k.publicKeyPem), algo, false, ['verify']), ecdsa });
    }
  } catch {
    return { supported: false, ok: false, count: 0, problems: ['This browser cannot check these signatures (Ed25519 or ECDSA P-256). Use a current Chrome, Edge, Firefox or Safari.'], ms: 0 };
  }
  const ordered = [...records].sort((a, b) => JSON.parse(a.headerJson).seq - JSON.parse(b.headerJson).seq);
  const problems: string[] = [];
  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  for (const r of ordered) {
    const h = JSON.parse(r.headerJson) as { seq: number; prev: string | null; body_sha256: string; key_id: string };
    const key = imported.get(h.key_id);
    const sig = toBytes(r.signature);
    const valid = key
      ? key.ecdsa
        ? await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.key, derToRaw(sig), enc.encode(r.headerJson))
        : await crypto.subtle.verify({ name: 'Ed25519' }, key.key, sig, enc.encode(r.headerJson))
      : false;
    if (!valid) problems.push(`#${h.seq}: bad signature or unknown key`);
    if (prevSeq !== null && h.seq !== prevSeq + 1) problems.push(`#${h.seq}: records missing before it`);
    if (prevHash !== null && h.prev !== prevHash) problems.push(`#${h.seq}: chain broken`);
    if (r.bodyJson !== undefined && (await sha256Hex(r.bodyJson)) !== h.body_sha256) problems.push(`#${h.seq}: body does not match its signed header`);
    prevHash = await sha256Hex(r.headerJson);
    prevSeq = h.seq;
  }
  return { supported: true, ok: problems.length === 0, count: ordered.length, problems, ms: Math.round(performance.now() - t0) };
}
