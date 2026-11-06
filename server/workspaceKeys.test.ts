import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDataDir } from './db/backup.js';
import { openDatabase } from './db/index.js';
import { keyIdFor, type AttestationSigner } from './enterprise/attestationSigner.js';
import { EvidenceLog, verifyRecords } from './evidence/log.js';
import { workspaceSigners } from './evidence/signer.js';
import { ProductStore } from './product/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-wskeys-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function serverSigner(): AttestationSigner {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { keyId: keyIdFor(publicKeyPem), algorithm: 'Ed25519', publicKeyPem, backend: 'server', sign: async (d) => crypto.sign(null, d, privateKey) };
}

describe('one signing key per workspace', () => {
  it('creates a key per workspace on first use, keeps it across restarts, and refuses odd ids', async () => {
    const data = path.join(dir, 'a');
    const signers = workspaceSigners(data, {});
    const a = await signers('11111111-aaaa-4bbb-8ccc-000000000001');
    const b = await signers('11111111-aaaa-4bbb-8ccc-000000000002');
    expect(a.keyId).not.toBe(b.keyId);
    expect(fs.readdirSync(path.join(data, 'workspace-keys')).sort()).toEqual(['11111111-aaaa-4bbb-8ccc-000000000001.pem', '11111111-aaaa-4bbb-8ccc-000000000002.pem']);
    // A restart reads the same key.
    expect((await workspaceSigners(data, {})('11111111-aaaa-4bbb-8ccc-000000000001')).keyId).toBe(a.keyId);
    await expect(signers('../escape')).rejects.toThrow(/unexpected workspace id/);
  });

  it("publishes only a workspace's own keys, and keeps records signed with the old server key valid", async () => {
    const db = openDatabase(':memory:');
    const store = new ProductStore(db);
    const w1 = store.createWorkspace('One', null).id;
    const w2 = store.createWorkspace('Two', null).id;
    // Before: the server key signed for every workspace.
    const server = serverSigner();
    const old = new EvidenceLog(db, async () => server);
    await old.append(w1, 'rule.retired', { ruleIds: ['r'], repoIds: [] });
    // After: each workspace's own key, continuing the same chain.
    const log = new EvidenceLog(db, workspaceSigners(path.join(dir, 'b'), {}));
    await log.append(w1, 'rule.retired', { ruleIds: ['r'], repoIds: [], n: 2 });
    await log.append(w2, 'rule.retired', { ruleIds: ['r'], repoIds: [] });

    const known = [{ keyId: server.keyId, algorithm: server.algorithm, publicKeyPem: server.publicKeyPem, firstUsedAt: '2026-01-01T00:00:00.000Z' }];
    const keys1 = await log.publicKeys(w1, known, new Map());
    const keys2 = await log.publicKeys(w2, known, new Map());
    const own1 = (await workspaceSigners(path.join(dir, 'b'), {})(w1)).keyId;
    expect(keys1.map((k) => k.keyId).sort()).toEqual([server.keyId, own1].sort());
    expect(keys2.map((k) => k.keyId)).not.toContain(own1);
    expect(keys2.map((k) => k.keyId)).not.toContain(server.keyId);
    // validFrom is the first record each key signed in this workspace.
    const first = JSON.parse(log.records(w1)[0].header).at;
    expect(keys1.find((k) => k.keyId === server.keyId)!.validFrom).toBe(first);
    expect(verifyRecords(log.records(w1), keys1)).toEqual([]);
    // Workspace Two's keys don't verify workspace One's records.
    expect(verifyRecords(log.records(w1), keys2).length).toBeGreaterThan(0);
    db.close();
  });

  it('backs up the workspace keys with the database', () => {
    const data = path.join(dir, 'c');
    fs.mkdirSync(path.join(data, 'workspace-keys'), { recursive: true });
    fs.writeFileSync(path.join(data, 'workspace-keys', 'w.pem'), 'KEY');
    const db = openDatabase(path.join(data, 'lexcompiler.db'));
    const result = backupDataDir(db, data, path.join(dir, 'backups'));
    expect(result.files).toContain('workspace-keys/w.pem');
    expect(fs.readFileSync(path.join(result.folder, 'workspace-keys', 'w.pem'), 'utf8')).toBe('KEY');
    db.close();
  });
});
