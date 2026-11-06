import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../util/hash.js';

export interface AttestationSigningKey {
  privateKey: crypto.KeyObject;
  publicKeyPem: string;
  fingerprintSha256: string;
  /** Where the key came from: env PEM, key file, or a newly created key file. */
  source: string;
}

let cached: AttestationSigningKey | null = null;

/** Account name icacls accepts for the current user, e.g. `DOMAIN\user`. */
export function currentWindowsAccount(): string {
  const user = os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
}

/**
 * Windows ignores POSIX mode bits, so `mode: 0o600` alone leaves the key readable by
 * every local user through inherited ACLs. Drop inheritance and grant only the owner.
 */
export function restrictToOwner(keyPath: string): void {
  if (process.platform !== 'win32') return;
  execFileSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${currentWindowsAccount()}:F`], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

/**
 * Loads the Ed25519 attestation key so signatures stay verifiable across restarts:
 * LEXCOMPILER_SIGNING_KEY_PEM (PKCS#8 PEM) wins, then LEXCOMPILER_SIGNING_KEY_PATH,
 * then data/ed25519-signing-key.pem, which is created owner-only (mode 0600, or an
 * owner-only ACL on Windows) on first use.
 */
export function getAttestationSigningKey(): AttestationSigningKey {
  if (cached) return cached;
  let pem = process.env.LEXCOMPILER_SIGNING_KEY_PEM?.trim();
  let source = 'LEXCOMPILER_SIGNING_KEY_PEM';
  if (!pem) {
    const dataDir = path.resolve(process.env.LEXCOMPILER_DATA_DIR || path.join(process.cwd(), 'data'));
    const keyPath = path.resolve(process.env.LEXCOMPILER_SIGNING_KEY_PATH || path.join(dataDir, 'ed25519-signing-key.pem'));
    if (fs.existsSync(keyPath)) {
      pem = fs.readFileSync(keyPath, 'utf8');
      source = keyPath;
    } else {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, pem, { encoding: 'utf8', mode: 0o600 });
      restrictToOwner(keyPath);
      source = `${keyPath} (created)`;
    }
  }
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Attestation signing key must be Ed25519, got ${privateKey.asymmetricKeyType}`);
  }
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  cached = { privateKey, publicKeyPem, fingerprintSha256: sha256Hex(publicKeyPem), source };
  return cached;
}
