import { describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { ProductStore } from './product/store.js';
import { GovernanceStore } from './product/governance.js';

describe('GovernanceStore adapters over ProductStore', () => {
  it('reads and writes tokens, MCP calls, exceptions and shares through ProductStore with the old shapes', () => {
    const db = openDatabase(':memory:');
    const store = new ProductStore(db);
    const gov = new GovernanceStore(db, store);
    const owner = store.upsertUser({ sub: 'password:o@x', email: 'o@x', name: 'Olga' });
    const eng = store.upsertUser({ sub: 'password:e@x', email: 'e@x', name: 'Eve' });
    const legal = store.upsertUser({ sub: 'password:l@x', email: 'l@x', name: 'Lena' });
    const ws = store.createWorkspace('W', owner.id);
    store.setMemberRole(ws.id, eng.id, 'engineer');
    store.setMemberRole(ws.id, legal.id, 'legal');
    const now = new Date().toISOString();
    db.prepare("INSERT INTO rules (id, workspace_id, key, title, created_at) VALUES ('r1', ?, 'R-1', 'Keep less', ?)").run(ws.id, now);
    db.prepare("INSERT INTO rule_versions (id, rule_id, version, status, source_text, clause_json, clause_sha256, created_by, created_at) VALUES ('v1','r1',1,'approved','x','{}','h','u',?)").run(now);

    // tokens
    const { token, record } = gov.createToken({ workspaceId: ws.id, userId: eng.id, name: 'Kiro', days: 30 });
    expect(record.hint).toBe(token.slice(-4));
    expect(record.userName).toBe('Eve');
    const p = store.createApiToken(ws.id, owner.id, 'mine');
    db.prepare('UPDATE api_tokens SET token_hint = NULL WHERE id = ?').run(p.record.id);
    expect(gov.listTokens(ws.id, null).map((t) => t.hint).sort()).toEqual(['', token.slice(-4)].sort());
    expect(gov.listTokens(ws.id, eng.id)).toHaveLength(1);
    const who = gov.authenticateToken(token)!;
    expect(who).toMatchObject({ role: 'engineer', user: { id: eng.id, name: 'Eve', email: 'e@x' }, token: { status: 'active' } });
    gov.setTokenClient(record.id, 'Kiro');
    expect(gov.getToken(ws.id, record.id)!.lastClient).toBe('Kiro');
    expect(() => gov.revokeToken(ws.id, p.record.id, { userId: eng.id, canRevokeOthers: false })).toThrow('only the token owner');
    expect(() => store.revokeApiToken(ws.id, eng.id, p.record.id)).toThrow('unknown token');
    expect(gov.revokeToken(ws.id, record.id, { userId: owner.id, canRevokeOthers: true }).status).toBe('revoked');
    expect(gov.authenticateToken(token)).toBeNull();
    const t2 = store.createApiToken(ws.id, eng.id, 'again');
    expect(store.tokenPrincipal(t2.token)).not.toBeNull();
    db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(now, ws.id);
    expect(store.tokenPrincipal(t2.token)).toBeNull();
    db.prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(ws.id);

    // MCP log
    gov.logMcpCall({ workspaceId: ws.id, tokenId: t2.record.id, userId: eng.id, client: 'Kiro', method: 'tools/call', tool: 'check_changes', outcome: 'ok', summary: '1 new', durationMs: 3 });
    store.recordMcpCall({ workspaceId: ws.id, tokenId: t2.record.id, method: 'tools/list', tool: null, repo: null, outcome: 'ok', durationMs: 1, detail: null });
    expect(gov.listMcpCalls(ws.id)).toEqual([expect.objectContaining({ userName: 'Eve', client: 'Kiro', tool: 'check_changes', summary: '1 new' })]);
    expect(store.listMcpCalls(ws.id).map((c) => c.userId)).toEqual([eng.id, eng.id]);

    // exceptions
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const req = gov.requestException({ workspaceId: ws.id, ruleId: 'r1', ruleKey: 'R-1', repoId: null, fingerprint: 'fp1', filePath: 'a.py', startLine: 3, message: 'm', reason: 'because', requestedBy: eng.id, requesterLabel: 'Eve via Kiro', requestedFrom: 'mcp', prNumber: 7, expiresAt: until });
    expect(req.created).toBe(true);
    expect(req.record).toMatchObject({ ruleKey: 'R-1', ruleTitle: 'Keep less', requesterLabel: 'Eve via Kiro', requestedFrom: 'assistant', requestedUntil: until, expiresAt: null, prNumber: 7, filePath: 'a.py', status: 'requested' });
    expect(gov.requestException({ workspaceId: ws.id, ruleId: 'r1', ruleKey: 'R-1', repoId: null, fingerprint: 'fp1', filePath: 'a.py', startLine: 3, message: 'm', reason: 'again', requestedBy: eng.id, requesterLabel: 'x', requestedFrom: 'dashboard' }).created).toBe(false);
    expect(gov.listExceptions(ws.id, ['requested', 'approved'])).toHaveLength(1);
    expect(gov.listExceptions(ws.id, ['rejected'])).toHaveLength(0);
    expect(() => gov.decideException(ws.id, req.record.id, { decision: 'approved', userId: legal.id, note: 'ok' })).toThrow('expiry date');
    expect(() => gov.decideException(ws.id, req.record.id, { decision: 'approved', userId: legal.id, note: 'ok', expiresAt: '2001-01-01' })).toThrow('future');
    const ok = gov.decideException(ws.id, req.record.id, { decision: 'approved', userId: legal.id, note: 'fine', expiresAt: until });
    expect(ok).toMatchObject({ status: 'approved', decidedByName: 'Lena', expiresAt: until });
    expect(gov.revokeException(ws.id, ok.id, legal.id, '').status).toBe('revoked');
    expect(() => gov.revokeException(ws.id, ok.id, legal.id, '')).toThrow('only approved');
    const req2 = gov.requestException({ workspaceId: ws.id, ruleId: 'r1', ruleKey: 'R-1', repoId: null, fingerprint: 'fp2', filePath: 'b.py', startLine: 1, message: 'm', reason: 'r', requestedBy: eng.id, requesterLabel: 'Eve', requestedFrom: 'github' });
    gov.decideException(ws.id, req2.record.id, { decision: 'approved', userId: legal.id, note: 'n', expiresAt: until });
    expect(gov.expireDue(new Date(Date.now() + 20 * 86_400_000).toISOString()).map((e) => e.status)).toEqual(['expired']);

    // shares
    const sh = gov.createShare({ workspaceId: ws.id, label: '  ', periodFrom: '2020-01-01', periodTo: '2099-01-01', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdBy: legal.id });
    expect(sh.token).toMatch(/^lexc_share_/);
    expect(sh.record).toMatchObject({ label: 'Evidence', ruleIds: ['r1'], createdByName: 'Lena', status: 'active', views: 0, lastViewedAt: null });
    expect(gov.shareByToken(sh.token)?.id).toBe(sh.record.id);
    gov.logShareView(sh.record.id, '1.2.3.4', 'ua');
    expect(gov.getShare(ws.id, sh.record.id)).toMatchObject({ views: 1, lastViewedAt: expect.any(String) });
    expect(gov.listShareViews(sh.record.id)).toHaveLength(1);
    expect(gov.revokeShare(ws.id, sh.record.id).status).toBe('revoked');
    expect(gov.revokeShare(ws.id, sh.record.id).status).toBe('revoked');
    expect(gov.shareByToken(sh.token)).toBeUndefined();

    // scans
    db.prepare("INSERT INTO repos (id, workspace_id, source, full_name, created_at) VALUES ('rp', ?, 'local', 'acme/x', ?)").run(ws.id, now);
    expect(gov.latestBranchScan('rp')).toBeUndefined();
    expect(store.latestBranchScan('rp')).toBeNull();
  });
});
