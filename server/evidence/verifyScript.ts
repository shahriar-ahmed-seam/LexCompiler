/**
 * verify.mjs, shipped in every evidence pack (product guide, Phase 5). It needs only Node and
 * checks the pack against keys the auditor takes from the company's own website, not the pack.
 * Kept as a string so the server build ships it unchanged.
 */
export const VERIFY_MJS = `// verify.mjs: node verify.mjs <pack folder> <keys.json>
// Take keys.json from the company's own website, not from the pack.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, keysFile] = process.argv.slice(2);
if (!dir || !keysFile) {
  console.error('usage: node verify.mjs <pack folder> <keys.json>');
  process.exit(2);
}
const keys = new Map(JSON.parse(fs.readFileSync(keysFile, 'utf8')).map((k) => [k.keyId, k]));
const rows = (f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const verify = (k, data, sig) =>
  k.algorithm === 'ECDSA_P256_SHA256'
    ? crypto.verify('sha256', data, { key: k.publicKeyPem, dsaEncoding: 'der' }, sig)
    : crypto.verify(null, data, crypto.createPublicKey(k.publicKeyPem), sig);

const problems = [];
const bodyHash = new Map();
let prevHash = null;
let prevSeq = null;
for (const { header, signature } of rows('headers.jsonl')) { // header = the exact signed JSON text
  let h;
  try {
    h = JSON.parse(header);
  } catch {
    problems.push('a header is not valid JSON');
    continue;
  }
  const key = keys.get(h.key_id);
  let ok = false;
  try {
    ok = !!key && verify(key, Buffer.from(header, 'utf8'), Buffer.from(signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) problems.push(\`#\${h.seq}: bad signature or unknown key\`);
  if (prevSeq !== null && h.seq !== prevSeq + 1) problems.push(\`#\${h.seq}: records missing before it\`);
  if (prevHash !== null && h.prev !== prevHash) problems.push(\`#\${h.seq}: chain broken\`);
  bodyHash.set(h.seq, h.body_sha256);
  prevHash = sha256(header);
  prevSeq = h.seq;
}
// Headers a Time-Stamp Authority vouched for: the stamped text must be the header in the chain.
// (The tokens themselves are checked with OpenSSL; see README.txt.)
let stamped = 0;
const tsDir = path.join(dir, 'timestamps');
if (fs.existsSync(tsDir)) {
  const bySeq = new Map(rows('headers.jsonl').map((r) => [JSON.parse(r.header).seq, r.header]));
  for (const f of fs.readdirSync(tsDir).filter((n) => n.endsWith('.header'))) {
    const seq = Number(f.slice(0, -'.header'.length));
    if (fs.readFileSync(path.join(tsDir, f), 'utf8') !== bySeq.get(seq)) problems.push(\`timestamp #\${seq}: the stamped header is not the one in headers.jsonl\`);
    else stamped++;
  }
}
let bodies = 0;
for (const { seq, body } of rows('bodies.jsonl')) {
  bodies++;
  if (bodyHash.get(seq) !== sha256(body)) problems.push(\`body #\${seq}: does not match its signed header\`);
}
console.log(problems.length ? problems.join('\\n')
  : \`OK: \${bodyHash.size} signed headers in an unbroken chain; \${bodies} bodies match.\${stamped ? \` \${stamped} timestamped headers match the chain.\` : ''}\`);
process.exit(problems.length ? 1 : 0);
`;
