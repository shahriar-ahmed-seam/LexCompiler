import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAttestationSigner, keyIdFor, type AttestationSigner } from '../enterprise/attestationSigner.js';
import { restrictToOwner } from '../enterprise/signingKey.js';

/**
 * One signing key per workspace (product guide, Phase 5): each workspace's evidence is signed
 * with its own Ed25519 key, kept in `<data>/workspace-keys/<workspaceId>.pem` (owner-only), so a
 * workspace's records and published keys say nothing about other workspaces.
 *
 * With LEXCOMPILER_SIGNER=gcp-kms or aws-kms the server's KMS key signs for every workspace;
 * a key per workspace there needs a KMS key per workspace in the configuration.
 */
export function workspaceSigners(dataDir: string, env: NodeJS.ProcessEnv = process.env): (workspaceId: string) => Promise<AttestationSigner> {
  const cache = new Map<string, AttestationSigner>();
  const kind = env.LEXCOMPILER_SIGNER || 'local';
  return async (workspaceId: string) => {
    if (kind !== 'local') return getAttestationSigner();
    const known = cache.get(workspaceId);
    if (known) return known;
    if (!/^[A-Za-z0-9-]+$/.test(workspaceId)) throw new Error(`unexpected workspace id "${workspaceId}"`);
    const dir = path.join(dataDir, 'workspace-keys');
    const file = path.join(dir, `${workspaceId}.pem`);
    let pem: string;
    if (fs.existsSync(file)) {
      pem = fs.readFileSync(file, 'utf8');
    } else {
      fs.mkdirSync(dir, { recursive: true });
      pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      // wx: never overwrite a key another process just created.
      try {
        fs.writeFileSync(file, pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        restrictToOwner(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        pem = fs.readFileSync(file, 'utf8');
      }
    }
    const privateKey = crypto.createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
    const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const signer: AttestationSigner = {
      keyId: keyIdFor(publicKeyPem),
      algorithm: 'Ed25519',
      publicKeyPem,
      backend: `workspace key file (${path.basename(file)})`,
      sign: async (data) => crypto.sign(null, data, privateKey),
    };
    cache.set(workspaceId, signer);
    return signer;
  };
}
