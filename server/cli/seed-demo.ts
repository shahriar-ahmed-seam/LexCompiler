/**
 * Seeds the demo workspace. Safe to run more than once.
 *
 *   npm run seed:demo -- [options]
 *
 *   --demo                     shortcut for --accounts --approve-all-but-dpa --ai cloud --ai-budget 15000
 *   --accounts                 sign-in accounts for the four personas (passwords in data/demo-accounts.txt)
 *   --reset-passwords          new passwords for existing demo accounts
 *   --fresh                    archive the current workspace and start a new one (evidence is append-only,
 *                              so history is kept in the archived workspace; repositories and the demo
 *                              people's coding-assistant tokens move over, and old scans are deleted)
 *   --activate-builtins        approve the four built-in illustrative clauses as R-1 to R-4
 *   --approve-all-but-dpa      approve three of them as Nusrat, leaving the DPA retention clause to approve live
 *   --ai off|local|cloud       the workspace's AI setting; --ai-budget <tokens per day>
 *   --engineer-github <login>  GitHub account that plays Tanvir (maps "Request exception" clicks to him)
 *   --link-installation <id>   link a GitHub App installation
 *   --owner-email a@x --legal-email b@x --engineer-email c@x --viewer-email d@x   invitations (OIDC sign-in)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AiGateway } from '../ai/gateway.js';
import { hashPassword } from '../auth/passwords.js';
import { getInitialClauses } from '../compiler/legalCompiler.js';
import { closeDb, dataDir, getDb } from '../db/index.js';
import { EvidenceLog } from '../evidence/log.js';
import { JobQueue } from '../jobs/queue.js';
import { compileClauseSync } from '../product/clauses.js';
import { rulesChanged, type FlowDeps } from '../product/flows.js';
import { GovernanceStore } from '../product/governance.js';
import { ProductStore, type WorkspaceRole } from '../product/store.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const flag = (name: string) => args.includes(`--${name}`) || (demo && ['accounts', 'approve-all-but-dpa'].includes(name));
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  if (demo && name === 'ai') return 'cloud';
  if (demo && name === 'ai-budget') return '15000';
  return undefined;
};

const WORKSPACE_NAME = value('workspace') || 'FinHealth AI';

const PERSONAS: Array<{ email: string; name: string; title: string; role: WorkspaceRole }> = [
  { email: 'arif@finhealth.example', name: 'Arif Hossain', title: 'Engineering Manager', role: 'owner' },
  { email: 'nusrat@finhealth.example', name: 'Nusrat Jahan', title: 'Head of Legal', role: 'legal' },
  { email: 'tanvir@finhealth.example', name: 'Tanvir Rahman', title: 'Backend Engineer', role: 'engineer' },
  { email: 'lena@klinikum-spree.example', name: 'Lena Fischer', title: 'Security Officer, Klinikum Spree', role: 'viewer' },
];

/** Readable random passwords: three groups of four, no look-alike characters. */
function newPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${group()}-${group()}-${group()}`;
}

async function main() {
  const db = getDb();
  const store = new ProductStore(db);
  const gov = new GovernanceStore(db);
  const evidence = new EvidenceLog(db);
  // Only to queue work for the running server, which polls the jobs table.
  const noop = async () => undefined;
  const queue = new JobQueue(db, { scan: noop, rules_changed: noop, pr_comment: noop });
  const flows: FlowDeps = { store, gov, evidence, queue, publicUrl: process.env.LEXCOMPILER_PUBLIC_URL || 'http://localhost:3001' };
  const seedUser = store.upsertUser({ sub: 'system:seed', name: 'Demo seed' });

  let workspace = store.findWorkspaceByName(WORKSPACE_NAME);
  const carryInstallations: number[] = [];
  let archivedId: string | null = null;
  if (workspace && flag('fresh')) {
    const old = workspace;
    archivedId = old.id;
    for (const inst of store.listInstallationsForWorkspace(old.id)) carryInstallations.push(inst.installationId);
    gov.archiveWorkspace(old.id, `${old.name} (archived ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
    console.log(`Archived workspace ${old.id}; its evidence log stays with it.`);
    workspace = undefined;
  }
  workspace ??= store.createWorkspace(WORKSPACE_NAME, null, seedUser.id);
  console.log(`Workspace "${workspace.name}": ${workspace.id}`);

  // Sign-in accounts.
  const people = new Map<WorkspaceRole, string>();
  if (flag('accounts')) {
    const lines: string[] = [`LexCompiler demo accounts (${new Date().toISOString()}). Keep this file private.`, ''];
    const file = path.join(dataDir(), 'demo-accounts.txt');
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    for (const p of PERSONAS) {
      const user = store.upsertUser({ sub: `password:${p.email}`, email: p.email, emailVerified: true, name: p.name });
      gov.setProfile(user.id, { title: p.title, ...(p.role === 'engineer' && value('engineer-github') ? { githubLogin: value('engineer-github') } : {}) });
      const known = gov.findUserByEmail(p.email);
      let password = new RegExp(`^${p.email.replace(/[.]/g, '\\.')}\\s+(\\S+)`, 'm').exec(previous)?.[1];
      if (!known?.passwordHash || !password || flag('reset-passwords')) {
        password = newPassword();
        gov.setPassword(user.id, await hashPassword(password));
      }
      store.setMemberRole(workspace.id, user.id, p.role);
      people.set(p.role, user.id);
      lines.push(`${p.email}  ${password}  ${p.name}, ${p.title} (${p.role})`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.log(`  accounts for ${PERSONAS.map((p) => p.name).join(', ')}; passwords in ${file}`);
    if (archivedId) {
      // Coding assistants stay connected: their tokens follow the same people to the new workspace.
      const ids = [...people.values()];
      const moved = db
        .prepare(`UPDATE api_tokens SET workspace_id = ? WHERE workspace_id = ? AND revoked_at IS NULL AND user_id IN (${ids.map(() => '?').join(', ')})`)
        .run(workspace.id, archivedId, ...ids);
      if (Number(moved.changes)) console.log(`  moved ${moved.changes} coding-assistant token(s) to the new workspace`);
    }
  }

  for (const [name, role] of [
    ['owner-email', 'owner'],
    ['legal-email', 'legal'],
    ['engineer-email', 'engineer'],
    ['viewer-email', 'viewer'],
  ] as const) {
    const email = value(name);
    if (email) {
      store.invite(workspace.id, email, role as WorkspaceRole, seedUser.id);
      console.log(`  invited ${email} as ${role}`);
    }
  }

  for (const name of ['Klinikum Spree', 'Nodi Microfinance']) store.createCounterparty(workspace.id, name);

  // GitHub: move installations from an archived workspace, or link one by id.
  const link = value('link-installation');
  if (link) carryInstallations.push(Number(link));
  for (const id of new Set(carryInstallations)) {
    store.linkInstallation(id, workspace.id);
    const repoIds = store.listRepos(workspace.id).filter((r) => r.installationId === id).map((r) => r.id);
    // Scans recorded under the old workspace's rules would show up in the new one; start clean.
    for (const repoId of repoIds) db.prepare('DELETE FROM scans WHERE repo_id = ?').run(repoId);
    console.log(`  linked GitHub installation ${id} (${repoIds.length} repositories)`);
  }

  // Rules.
  const approveBuiltins = flag('activate-builtins') || flag('approve-all-but-dpa');
  if (approveBuiltins) {
    if (store.listRules(workspace.id).length > 0) {
      console.log('  rules already exist; built-in clauses skipped');
    } else {
      const approver = people.get('legal') ?? seedUser.id;
      const builtins = getInitialClauses().filter((c) => !(flag('approve-all-but-dpa') && c.category === 'RETENTION_AND_TENANT_KMS'));
      for (const builtin of builtins) {
        const key = store.nextRuleKey(workspace.id);
        const clause = compileClauseSync({ text: builtin.rawLegalText, key, title: builtin.title, citation: builtin.citation, category: builtin.category, frameworkId: builtin.frameworkId });
        const { rule, version } = store.createRuleDraft({ workspaceId: workspace.id, title: builtin.title, sourceText: builtin.rawLegalText, clause: { ...clause, illustrative: true }, createdBy: approver });
        const approved = store.approveRuleVersion(workspace.id, version.id, approver, { note: 'Illustrative clause from the LexCompiler library, approved for the demo.' });
        evidence.append(workspace.id, 'rule.approved', {
          rule: key,
          title: rule.title,
          version: approved.version,
          clause_sha256: approved.clauseSha256,
          category: approved.clause.category,
          effective_from: approved.effectiveFrom,
          source_text: approved.sourceText,
          decided_by: people.has('legal') ? 'Nusrat Jahan' : 'the demo seed',
          note: approved.decisionNote,
        });
        console.log(`  ${key} approved: ${builtin.title}`);
      }
      if (flag('approve-all-but-dpa')) console.log('  the DPA retention clause (72 hours, tenant keys) is left for Legal to approve in the demo');
    }
  }

  const aiMode = value('ai');
  if (aiMode) {
    const gw = new AiGateway(db);
    const s = gw.setSettings(workspace.id, { mode: aiMode, ...(value('ai-budget') ? { dailyTokenBudget: Number(value('ai-budget')) } : {}) }, people.get('owner') ?? seedUser.id);
    console.log(`  AI: ${s.mode}, ${s.dailyTokenBudget} tokens a day`);
  }

  if (approveBuiltins || carryInstallations.length > 0) {
    // The running server re-checks the default branch and open pull requests with these rules.
    rulesChanged(flows, workspace.id);
  }

  const unlinked = store.listUnlinkedInstallations();
  if (unlinked.length > 0) console.log(`  unlinked GitHub installations: ${unlinked.map((i) => `${i.installationId} (${i.accountLogin})`).join(', ')}; pass --link-installation <id>`);
  closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
