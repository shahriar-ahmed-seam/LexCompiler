import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDataDir } from './db/backup.js';
import { openDatabase } from './db/index.js';
import { assertSafeBindConfig, httpsOnly, rateLimit, resolveServerSecurityConfig, trustProxySetting } from './security.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-deploy-'));
const servers: http.Server[] = [];
afterAll(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(dir, { recursive: true, force: true });
});

async function serve(app: express.Express): Promise<string> {
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('going online (Phase 7)', () => {
  it('refuses the runtime sandbox on a public host', () => {
    expect(() => assertSafeBindConfig(resolveServerSecurityConfig({ HOST: '0.0.0.0', LEXCOMPILER_API_TOKEN: 't', LEXCOMPILER_ENABLE_RUNTIME_SANDBOX: '1' }))).toThrow(/runtime sandbox/);
    expect(() => assertSafeBindConfig(resolveServerSecurityConfig({ HOST: '0.0.0.0', LEXCOMPILER_API_TOKEN: 't' }))).not.toThrow();
  });

  it('parses the trust proxy setting', () => {
    expect([undefined, 'false', '1', 'true', 'loopback'].map((v) => trustProxySetting(v))).toEqual([undefined, undefined, 1, true, 'loopback']);
  });

  it('rate-limits per client and redirects plain HTTP behind a trusted proxy', async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(httpsOnly('https://lexc.example'));
    app.use('/api/share', rateLimit({ name: 'share links', windowMs: 60_000, max: 2 }));
    app.get('/api/share/x', (_req, res) => res.json({ ok: true }));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    const base = await serve(app);
    const https = { 'X-Forwarded-Proto': 'https' };
    const plain = await fetch(`${base}/api/share/x`, { headers: { 'X-Forwarded-Proto': 'http' }, redirect: 'manual' });
    expect(plain.status).toBe(308);
    expect(plain.headers.get('location')).toBe('https://lexc.example/api/share/x');
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const ok = await fetch(`${base}/api/share/x`, { headers: https });
    expect(ok.headers.get('strict-transport-security')).toContain('max-age=31536000');
    await fetch(`${base}/api/share/x`, { headers: https });
    const limited = await fetch(`${base}/api/share/x`, { headers: https });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client (by X-Forwarded-For through the trusted proxy) has its own budget.
    expect((await fetch(`${base}/api/share/x`, { headers: { ...https, 'X-Forwarded-For': '203.0.113.7' } })).status).toBe(200);
  });

  it('backs up the database and key files, keeping the newest', () => {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const db = openDatabase(path.join(data, 'lexcompiler.db'));
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'W', '2026-01-01')").run();
    fs.writeFileSync(path.join(data, 'ed25519-signing-key.pem'), 'KEY');
    const backups = path.join(dir, 'backups');
    for (let d = 1; d <= 3; d++) backupDataDir(db, data, backups, { now: new Date(`2026-12-0${d}T02:00:00Z`), keep: 2 });
    const folders = fs.readdirSync(backups).sort();
    expect(folders).toHaveLength(2);
    expect(folders[1]).toMatch(/^lexcompiler-2026-12-03/);
    const copy = openDatabase(path.join(backups, folders[1], 'lexcompiler.db'));
    expect(copy.prepare('SELECT name FROM workspaces').all()).toEqual([{ name: 'W' }]);
    expect(fs.readFileSync(path.join(backups, folders[1], 'ed25519-signing-key.pem'), 'utf8')).toBe('KEY');
    copy.close();
    db.close();
  });
});
