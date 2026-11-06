/**
 * Checks a share's evidence headers in the browser with Web Crypto (product guide, Phase 5,
 * item 6): each signature, continuous sequence numbers and the hash chain. This runs code
 * LexCompiler serves, so the independent check is verify.mjs with keys from the company's site.
 */

export interface BrowserKey {
  keyId: string;
  algorithm: 'Ed25519' | 'ECDSA_P256_SHA256';
  publicKeyPem: string;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** DER ECDSA signature → the raw r||s form Web Crypto expects. */
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

export async function verifyHeadersInBrowser(headers: Array<{ header: string; signature: string }>, keys: BrowserKey[], subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string[]> {
  const imported = new Map<string, { key: CryptoKey; algorithm: BrowserKey['algorithm'] }>();
  for (const k of keys) {
    const der = fromBase64(k.publicKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    const algo = k.algorithm === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
    try {
      imported.set(k.keyId, { key: await subtle.importKey('spki', der, algo, false, ['verify']), algorithm: k.algorithm });
    } catch {
      // A key this browser can't import counts as unknown below.
    }
  }
  const enc = new TextEncoder();
  const problems: string[] = [];
  let prevHash: string | null = null;
  let prevSeq: number | null = null;
  for (const { header, signature } of headers) {
    const h = JSON.parse(header) as { seq: number; prev: string | null; key_id: string };
    const k = imported.get(h.key_id);
    let ok = false;
    if (k) {
      const sig = fromBase64(signature);
      ok =
        k.algorithm === 'Ed25519'
          ? await subtle.verify({ name: 'Ed25519' }, k.key, sig, enc.encode(header))
          : await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k.key, derToRaw(sig), enc.encode(header));
    }
    if (!ok) problems.push(`#${h.seq}: bad signature or unknown key`);
    if (prevSeq !== null && h.seq !== prevSeq + 1) problems.push(`#${h.seq}: records missing before it`);
    if (prevHash !== null && h.prev !== prevHash) problems.push(`#${h.seq}: chain broken`);
    prevHash = hex(await subtle.digest('SHA-256', enc.encode(header)));
    prevSeq = h.seq;
  }
  return problems;
}
