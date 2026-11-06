import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index.js';

/**
 * Daily backups (product guide, Phase 7): a consistent copy of the database made with
 * `VACUUM INTO` (safe while the server writes), plus the key and credential files of the data
 * directory, in one dated folder. The newest `keep` folders are kept.
 */

/** Files next to the database that a restore needs: signing key, trusted keys, revocations, GitHub App. */
const DATA_FILES = ['ed25519-signing-key.pem', 'attestation-keys.json', 'revocations.json', 'github-app.json', 'active-clauses.json'];

export function backupDataDir(db: Db, dataDir: string, backupDir: string, options: { now?: Date; keep?: number } = {}): { folder: string; files: string[]; removed: string[] } {
  const now = options.now ?? new Date();
  const keep = options.keep ?? 14;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const folder = path.join(backupDir, `lexcompiler-${stamp}`);
  if (path.resolve(folder).startsWith(path.resolve(dataDir) + path.sep) && path.resolve(backupDir) === path.resolve(dataDir)) {
    throw new Error('the backup folder must not be the data folder itself');
  }
  fs.mkdirSync(folder, { recursive: true });
  const dbFile = path.join(folder, 'lexcompiler.db');
  // VACUUM INTO takes a string literal; the path comes from configuration, quotes are escaped.
  db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  const files = ['lexcompiler.db'];
  for (const name of DATA_FILES) {
    const src = path.join(dataDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(folder, name));
    // Keys stay readable by the owner only (Windows ignores the mode; the folder's ACL applies).
    fs.chmodSync(path.join(folder, name), 0o600);
    files.push(name);
  }
  // One signing key per workspace (data/workspace-keys).
  const keysDir = path.join(dataDir, 'workspace-keys');
  if (fs.existsSync(keysDir)) {
    fs.mkdirSync(path.join(folder, 'workspace-keys'), { recursive: true });
    for (const name of fs.readdirSync(keysDir).filter((n) => n.endsWith('.pem'))) {
      fs.copyFileSync(path.join(keysDir, name), path.join(folder, 'workspace-keys', name));
      fs.chmodSync(path.join(folder, 'workspace-keys', name), 0o600);
      files.push(`workspace-keys/${name}`);
    }
  }
  const all = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('lexcompiler-'))
    .map((e) => e.name)
    .sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
  return { folder, files, removed };
}
