import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_REPO_FILES } from './analyzer/repoBaseline.js';
import { AiGateway } from './ai/gateway.js';
import { getBanglaInitialClauses } from './compiler/legalCompiler.js';
import { openDatabase } from './db/index.js';
import { DocumentError, extractDocumentText, looksLikeLegacyBangla, splitClauses } from './product/documents.js';
import { createProductRouter } from './product/router.js';
import { buildRuleCard, findHighlights } from './product/ruleCard.js';
import { ProductStore, type ExceptionRecord, type Repo, type RuleVersion } from './product/store.js';

/** The §4.2 text from the walkthrough (product guide, Phase 3 test). */
const DPA_42 =
  '4.2 Retention. All personal data received from the Customer must be encrypted at rest with tenant-isolated keys and purged within 72 hours across all storage tiers.';
const DPA_DOC = `Data Processing Agreement between Klinikum Spree and FinHealth AI

1. Definitions
"Personal data" has the meaning given in the GDPR.

4.2 Retention. All personal data received from the Customer must be encrypted at rest with tenant-isolated keys and purged within 72 hours across all storage tiers.

Section 5 Audits
The Customer may audit the Processor once a year.

Article 17 Erasure
On request, the Processor shall erase all records that refer to a data subject.

§ 9 Logging
Personal data shall not be written to application logs in plain text.
`;

/**
 * A one-page PDF with the given lines in Helvetica, built by hand so the test needs no PDF writer.
 * Lines wrap at 90 characters, as in a real document (text past the page edge is not extracted).
 */
function makePdf(paragraphs: string[]): Buffer {
  const lines = paragraphs.flatMap((p) => p.match(/.{1,90}(?:\s|$)|\S+/g)?.map((l) => l.trimEnd()) ?? ['']);
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = ['BT', '/F1 10 Tf', '14 TL', '40 800 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A minimal .docx with one paragraph per line. */
async function makeDocx(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const xmlEsc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('documents', () => {
  it('splits on numbered headings, keeps every part and marks normative clauses', () => {
    const clauses = splitClauses(DPA_DOC);
    expect(clauses.map((c) => c.number)).toEqual([null, '1', '4.2', '5', '17', '9']);
    expect(clauses.map((c) => c.normative)).toEqual([false, false, true, false, true, true]);
    const c42 = clauses[2];
    expect(c42.text).toBe(DPA_42);
    expect(DPA_DOC.slice(c42.start, c42.end)).toBe(c42.text);
    expect(c42.normativeMatches.map((m) => m.text)).toEqual(['must']);
    expect(clauses[5].normativeMatches.map((m) => m.text)).toEqual(['shall not']);
  });

  it('splits Bangla clauses on ধারা headings with Bangla digits', () => {
    const text = `ভূমিকা\nএই নীতিমালা সকল ব্যাংকের জন্য প্রযোজ্য।\nধারা ৪.২ গ্রাহকের তথ্য ৪৮ ঘণ্টার মধ্যে অবশ্যই মুছে ফেলতে হবে।\nধারা ৫ ব্যাংক বছরে একবার নিরীক্ষা করবে।`;
    const clauses = splitClauses(text);
    expect(clauses.map((c) => c.number)).toEqual([null, '4.2', '5']);
    expect(clauses.map((c) => c.normative)).toEqual([false, true, false]);
    expect(clauses[1].normativeMatches.map((m) => m.text)).toEqual(['অবশ্যই']);
    expect(splitClauses('ধারা ৭ এই তথ্য বিদেশে পাঠানো যাবে না।')[0].normativeMatches.map((m) => m.text)).toEqual(['যাবে না']);
  });

  it('reads text from a PDF, a Word file and plain text, and hashes the original bytes', async () => {
    const pdf = await extractDocumentText(makePdf(['4.2 Retention. Personal data must be purged within 72 hours.', '5. Audits. Once a year.']), 'dpa.pdf');
    expect(pdf.format).toBe('pdf');
    expect(pdf.pages).toBe(1);
    expect(pdf.text).toContain('purged within 72 hours');
    expect(splitClauses(pdf.text).map((c) => c.number)).toEqual(['4.2', '5']);
    expect(pdf.fileSha256).toMatch(/^[0-9a-f]{64}$/);

    const docx = await extractDocumentText(await makeDocx(['4.2 Retention. Personal data must be purged within 72 hours.', 'Section 5 Audits']), 'dpa.docx');
    expect(docx.format).toBe('docx');
    expect(splitClauses(docx.text).map((c) => c.number)).toEqual(['4.2', '5']);

    const txt = await extractDocumentText(Buffer.from('﻿4.2 Text\r\nmust be kept.\r\n'), 'dpa.txt');
    expect(txt).toMatchObject({ format: 'text', text: '4.2 Text\nmust be kept.\n' });
  });

  it('refuses files whose contents do not match their name, and empty or scanned PDFs', async () => {
    await expect(extractDocumentText(Buffer.from('not a pdf'), 'contract.pdf')).rejects.toBeInstanceOf(DocumentError);
    await expect(extractDocumentText(Buffer.alloc(0), 'x.txt')).rejects.toThrow('empty');
    await expect(extractDocumentText(makePdf([]), 'scan.pdf')).rejects.toThrow('no text layer');
  });

  it('spots Bangla text in the old Bijoy encoding', () => {
    // Bijoy-encoded Bangla extracts as Latin letters like these.
    expect(looksLikeLegacyBangla('MÖvn‡Ki mKj e¨w³MZ Z_¨ Aek¨B 48 N›Uvi g‡a¨ gy‡Q †dj‡Z n‡e')).toBe(true);
    expect(looksLikeLegacyBangla(getBanglaInitialClauses()[0].rawLegalText)).toBe(false);
  });
});

describe('rule card', () => {
  it('reads 72 hours and tenant-isolated keys from §4.2, highlights them and asks when the clock starts', async () => {
    const card = await buildRuleCard({ text: DPA_42, key: 'R-1' });
    expect(card.category).toBe('RETENTION_AND_TENANT_KMS');
    expect(card.categoryLabel).toBe('Retention and tenant keys');
    expect(card.categoryFromWording).toBe(true);
    expect(card.values).toEqual([
      { field: 'maxRetentionHours', label: 'Delete within (hours)', value: 72, source: 'parser', question: null },
      { field: 'requiresTenantIsolatedKeys', label: 'Tenant-isolated keys', value: true, source: 'parser', question: null },
    ]);
    const highlighted = card.highlights.map((h) => h.text);
    expect(highlighted).toContain('72 hours');
    expect(highlighted.some((t) => /tenant-isolated keys/.test(t))).toBe(true);
    for (const h of card.highlights) expect(DPA_42.slice(h.start, h.end)).toBe(h.text);
    expect(card.questions.map((q) => q.id)).toContain('clock-start');
    expect(card.plainReading).toBe('Personal data must be deleted within 72 hours, and stored encrypted with a key that belongs to one tenant only.');
  });

  it('highlights Bangla values at the right offsets', () => {
    const text = getBanglaInitialClauses()[0].rawLegalText;
    const hs = findHighlights(text, 'RETENTION_AND_TENANT_KMS');
    const value = hs.find((h) => h.kind === 'value');
    expect(value?.text).toBe('৪৮ ঘণ্টা');
    for (const h of hs) expect(text.slice(h.start, h.end)).toBe(h.text);
  });

  it('turns two candidate durations into a question, and enforces what Legal sets', async () => {
    const text = 'Personal data must be purged within 72 hours, or within 9999 hours where the backup policy applies.';
    const card = await buildRuleCard({ text, key: 'R-1' });
    expect(card.values[0]).toMatchObject({ field: 'maxRetentionHours', value: null, source: 'question' });
    expect(card.values[0].question).toMatch(/Several durations/);
    const set = await buildRuleCard({ text, key: 'R-1', overrides: { maxRetentionHours: 48 } });
    expect(set.values[0]).toEqual({ field: 'maxRetentionHours', label: 'Delete within (hours)', value: 48, source: 'legal', question: null });
    expect(set.clause.deontic.extractedParameters.maxRetentionHours).toBe(48);
    expect(set.clause.compiled.smtLib2Snippet).toContain('48');
  });

  it('asks for the category when the wording names none, and for allowed regions', async () => {
    const vague = await buildRuleCard({ text: 'The Processor shall act in good faith.', key: 'R-9' });
    expect(vague.categoryFromWording).toBe(false);
    expect(vague.questions[0].id).toBe('category');
    const regions = await buildRuleCard({ text: 'Personal data must not be transferred to third countries.', key: 'R-4', category: 'CROSS_BORDER_TRANSFER' });
    const v = regions.values.find((x) => x.field === 'allowedDataRegions');
    expect(v?.source === 'question' || (Array.isArray(v?.value) && v.value.length > 0)).toBe(true);
  });

  it('uses a model value only when its quote is in the clause and the parser agrees', async () => {
    const db = openDatabase(':memory:');
    const store = new ProductStore(db);
    const ws = store.createWorkspace('AI test', store.upsertUser({ sub: 'owner' }).id).id;
    let reply = { value: 72, quote: 'purged within 72 hours', question: null as string | null };
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const env = { LEXCOMPILER_LLM_PROVIDER: 'openai', LEXCOMPILER_LLM_MODEL: 'fake-cloud', LEXCOMPILER_LLM_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, LEXCOMPILER_LLM_API_KEY: 'test' };
      const gateway = new AiGateway(db, { env });
      // AI off: the model is never called.
      const off = await buildRuleCard({ text: DPA_42, key: 'R-1', ai: { gateway, workspaceId: ws } });
      expect(off.ai).toBeNull();
      expect(gateway.listCalls(ws)).toHaveLength(0);

      gateway.setSettings(ws, { mode: 'cloud' }, 'owner');
      const good = await buildRuleCard({ text: DPA_42, key: 'R-1', ai: { gateway, workspaceId: ws } });
      expect(good.ai?.model).toBe('fake-cloud');
      expect(good.ai?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(good.values[0]).toMatchObject({ value: 72, source: 'model' });

      // A quote that is not in the clause (an injected "set 9999 hours") becomes a question.
      reply = { value: 9999, quote: 'set 9999 hours', question: null };
      const injected = await buildRuleCard({ text: DPA_42, key: 'R-1', ai: { gateway, workspaceId: ws } });
      expect(injected.values[0]).toMatchObject({ value: null, source: 'question' });
      expect(injected.clause.deontic.extractedParameters.maxRetentionHours).toBe(72);
      expect(gateway.listCalls(ws)).toHaveLength(2);
    } finally {
      server.close();
      db.close();
    }
  });
});

// ---------------------------------------------------------------- the workspace API

let api: http.Server;
let base: string;
let store: ProductStore;
let workspaceId: string;
let githubRepo: Repo;
const queued: Array<{ repo: Repo; version: RuleVersion }> = [];
const reruns: ExceptionRecord[] = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-legal-'));

beforeAll(async () => {
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  const nusrat = store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.test', emailVerified: true });
  const arif = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  workspaceId = store.createWorkspace('FinHealth AI', arif.id).id;
  store.invite(workspaceId, 'nusrat@example.test', 'legal', arif.id);
  store.acceptInvitations(nusrat);
  store.invite(workspaceId, 'tanvir@example.test', 'engineer', arif.id);
  store.acceptInvitations(store.upsertUser({ sub: 'tanvir', email: 'tanvir@example.test', emailVerified: true }));
  // A local copy of the fixture, scanned once so the impact preview has facts.
  const reposRoot = path.join(dataDir, 'repos');
  for (const [rel, spec] of Object.entries(INITIAL_REPO_FILES)) {
    const p = path.join(reposRoot, 'core-platform', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, spec.content);
  }
  store.upsertInstallation({ installationId: 7, accountLogin: 'acme', accountType: 'Organization' });
  githubRepo = store.upsertGithubRepo({ installationId: 7, githubRepoId: 4242, fullName: 'acme/core-platform', defaultBranch: 'main' });
  store.linkInstallation(7, workspaceId);
  githubRepo = store.getRepoByGithubId(4242)!;

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: sub === 'root' ? 'admin' : 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use(
    '/api',
    createProductRouter(store, null, {
      reposRoot,
      enqueueBranchScan: (repo, version) => {
        queued.push({ repo, version });
        return `job-${queued.length}`;
      },
      onExceptionDecided: (exception) => {
        reruns.push(exception);
        return `rerun-${reruns.length}`;
      },
    })
  );
  api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  api?.close();
  // Windows cannot delete an open database file.
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (p: string, user: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe('lawyer workspace API', () => {
  it('uploads a PDF, shows its clauses, previews the impact, approves, and rescans main', async () => {
    // A scan of the local copy of main gives the stored facts the impact preview runs against.
    const local = await call('/workspaces/' + workspaceId + '/repos', 'root', { name: 'core-platform (local)', localPath: 'core-platform' });
    expect(local.status).toBe(201);
    expect((await call(`/workspaces/${workspaceId}/repos/${local.body.id}/scan`, 'root', {})).status).toBe(200);

    const pdf = makePdf(DPA_DOC.split('\n'));
    const up = await call(`/workspaces/${workspaceId}/documents`, 'nusrat', { title: 'Klinikum Spree DPA', kind: 'contract', fileName: 'klinikum-dpa.pdf', contentBase64: pdf.toString('base64') });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ title: 'Klinikum Spree DPA', fileFormat: 'pdf', fileName: 'klinikum-dpa.pdf' });
    const clause = up.body.clauses.find((c: { number: string }) => c.number === '4.2');
    expect(clause.normative).toBe(true);
    // The original file comes back byte for byte.
    const file = await fetch(`${base}/workspaces/${workspaceId}/documents/${up.body.id}/file`, { headers: { 'x-test-user': 'nusrat' } });
    expect(Buffer.from(await file.arrayBuffer()).equals(pdf)).toBe(true);
    // Engineers can read documents but not add them.
    expect((await call(`/workspaces/${workspaceId}/documents`, 'tanvir', { text: 'x' })).status).toBe(403);
    expect((await call(`/workspaces/${workspaceId}/documents`, 'tanvir')).body).toHaveLength(1);

    const preview = await call(`/workspaces/${workspaceId}/rule-card`, 'nusrat', { text: clause.text, normativeMatches: clause.normativeMatches });
    expect(preview.status).toBe(200);
    expect(preview.body.categoryLabel).toBe('Retention and tenant keys');
    expect(preview.body.values[0]).toMatchObject({ value: 72, source: 'parser' });
    expect(preview.body.compiled.smtLib2).toContain('assert');
    const impactLocal = preview.body.impact.find((i: { repoId: string }) => i.repoId === local.body.id);
    expect(impactLocal.failures).toBeGreaterThanOrEqual(3);
    const impactGithub = preview.body.impact.find((i: { repoId: string }) => i.repoId === githubRepo.id);
    expect(impactGithub).toMatchObject({ failures: null, scanId: null });

    const draft = await call(`/workspaces/${workspaceId}/rules`, 'nusrat', { rawLegalText: clause.text, title: 'Retention and tenant keys', citation: 'Klinikum DPA §4.2', documentId: up.body.id });
    expect(draft.status).toBe(201);
    expect(draft.body.version.card.values[0]).toMatchObject({ value: 72, source: 'parser' });
    expect(draft.body.version.scope).toEqual({ all: true });

    const approved = await call(`/workspaces/${workspaceId}/rule-versions/${draft.body.version.id}/approve`, 'nusrat', {});
    expect(approved.status).toBe(200);
    expect(approved.body.approvedBy).toBeTruthy();
    // Only the GitHub repository is rescanned by the app; local folders are scanned by hand.
    expect(approved.body.queuedScans).toEqual([{ repoId: githubRepo.id, jobId: `job-${queued.length}` }]);
    expect(queued.at(-1)).toMatchObject({ repo: { id: githubRepo.id }, version: { id: draft.body.version.id } });
  });

  it('will not approve a draft while a value is an open question', async () => {
    const text = 'Personal data must be purged within 72 hours, or within 30 days for backups.';
    const draft = await call(`/workspaces/${workspaceId}/rules`, 'nusrat', { rawLegalText: text });
    expect(draft.body.version.card.values[0]).toMatchObject({ source: 'question' });
    const refused = await call(`/workspaces/${workspaceId}/rule-versions/${draft.body.version.id}/approve`, 'nusrat', {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Delete within \(hours\)/);
    // With the value set on the card, the new draft can be approved.
    const set = await call(`/workspaces/${workspaceId}/rules`, 'nusrat', { rawLegalText: text, ruleId: draft.body.rule.id, values: { maxRetentionHours: 72 } });
    expect(set.body.version.card.values[0]).toMatchObject({ value: 72, source: 'legal' });
    expect((await call(`/workspaces/${workspaceId}/rule-versions/${set.body.version.id}/approve`, 'nusrat', {})).status).toBe(200);
  });

  it('lets an engineer request an exception, shows it in the inbox, and lets Legal decide it', async () => {
    const [local] = store.listRepos(workspaceId).filter((r) => r.source === 'local');
    const scan = await call(`/workspaces/${workspaceId}/repos/${local.id}/scan`, 'root', {});
    const finding = scan.body.findings.find((f: { ruleKey: string }) => f.ruleKey === 'R-1');
    expect(finding).toBeTruthy();

    // Viewers and strangers cannot ask; engineers can.
    expect((await call(`/workspaces/${workspaceId}/exceptions`, 'stranger', { scanId: scan.body.id, fingerprint: finding.fingerprint, reason: 'x' })).status).toBe(404);
    const asked = await call(`/workspaces/${workspaceId}/exceptions`, 'tanvir', { scanId: scan.body.id, fingerprint: finding.fingerprint, reason: 'Cache is flushed by the nightly job' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'requested', requestedFrom: 'dashboard', ruleKey: 'R-1', filePath: finding.filePath });
    // Asking again returns the open request.
    expect((await call(`/workspaces/${workspaceId}/exceptions`, 'tanvir', { scanId: scan.body.id, fingerprint: finding.fingerprint, reason: 'again' })).status).toBe(200);

    const inbox = await call(`/workspaces/${workspaceId}/inbox`, 'nusrat');
    expect(inbox.body.exceptionRequests.map((e: { id: string }) => e.id)).toEqual([asked.body.id]);
    expect(inbox.body.ruleDrafts.map((d: { ruleKey: string }) => d.ruleKey)).toContain('R-2');

    // Only Legal decides, an approval needs an expiry, and deciding re-runs the check.
    expect((await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/approve`, 'tanvir', { note: 'ok', expiresAt: '2099-01-01' })).status).toBe(403);
    expect((await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/approve`, 'nusrat', { note: 'ok' })).status).toBe(400);
    const until = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const ok = await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/approve`, 'nusrat', { note: 'Flushed nightly; fix in LN-14', expiresAt: until });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decisionNote: 'Flushed nightly; fix in LN-14', expiresAt: until, rerunJobId: `rerun-${reruns.length}` });
    expect((await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/approve`, 'nusrat', { note: 'again', expiresAt: until })).status).toBe(409);

    // The waived finding no longer fails the next scan.
    const rescan = await call(`/workspaces/${workspaceId}/repos/${local.id}/scan`, 'root', {});
    expect(rescan.body.findings.find((f: { fingerprint: string }) => f.fingerprint === finding.fingerprint).state).toBe('waived');

    // The test-only admin action moves the expiry to yesterday; the finding counts again.
    expect((await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/expiry`, 'nusrat', { expiresAt: '2000-01-01' })).status).toBe(403);
    const expired = await call(`/workspaces/${workspaceId}/exceptions/${asked.body.id}/expiry`, 'root', { expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
    expect(expired.body.status).toBe('expired');
    const after = await call(`/workspaces/${workspaceId}/repos/${local.id}/scan`, 'root', {});
    expect(after.body.findings.find((f: { fingerprint: string }) => f.fingerprint === finding.fingerprint).state).not.toBe('waived');
    expect((await call(`/workspaces/${workspaceId}/exceptions?status=expired`, 'tanvir')).body).toHaveLength(1);
  });

  it('refuses a Bangla upload in the old Bijoy encoding', async () => {
    const r = await call(`/workspaces/${workspaceId}/documents`, 'nusrat', { title: 'Circular', kind: 'regulation', language: 'bn', text: 'MÖvn‡Ki mKj e¨w³MZ Z_¨ Aek¨B 48 N›Uvi g‡a¨ gy‡Q †dj‡Z n‡e' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/Bijoy/);
  });
});
