/**
 * npm run backup [-- <folder>]: a consistent copy of the database and key files, now.
 * The folder defaults to LEXCOMPILER_BACKUP_DIR, then data/backups.
 */
import path from 'node:path';
import { backupDataDir } from '../db/backup.js';
import { dataDir, getDb } from '../db/index.js';

const target = path.resolve(process.argv[2] || process.env.LEXCOMPILER_BACKUP_DIR || path.join(dataDir(), 'backups'));
const result = backupDataDir(getDb(), dataDir(), target);
console.log(`Backed up ${result.files.join(', ')} to ${result.folder}${result.removed.length ? `; removed ${result.removed.length} older backups` : ''}.`);
