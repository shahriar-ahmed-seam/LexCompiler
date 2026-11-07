import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { signBody } from './events/outbound.js';

interface N8nNode {
  name: string;
  type: string;
  typeVersion: number;
  disabled?: boolean;
  parameters: Record<string, any>;
}
interface N8nWorkflow {
  name: string;
  active: boolean;
  settings: Record<string, unknown>;
  nodes: N8nNode[];
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
}

const FILE = path.join(process.cwd(), 'integrations', 'n8n', 'lexcompiler-events.workflow.json');
const workflow = JSON.parse(fs.readFileSync(FILE, 'utf8')) as N8nWorkflow;
const node = (name: string) => workflow.nodes.find((n) => n.name === name)!;

/** Runs a Code node's JavaScript the way n8n does for "run once for all items", with stubbed globals. */
async function runCode(name: string, input: { json: unknown; binary?: unknown }, env: Record<string, string> = {}, helpers?: unknown): Promise<any[]> {
  const source = node(name).parameters.jsCode as string;
  const context = vm.createContext({ $input: { first: () => input }, $env: env, require, Buffer });
  const fn = vm.runInContext(`(async function () {\n${source}\n})`, context) as () => Promise<any[]>;
  return fn.call({ helpers });
}

const SECRET = 'test-secret-not-real';
const event = { id: 'ev-1', type: 'scan.completed', workspaceId: 'ws-1', createdAt: '2025-01-01T00:00:00.000Z', data: { repository: 'acme/core', counts: { new: 1, existing: 0, waived: 0 }, conclusion: 'failure', findings: [{ rule: 'GDPR-17', path: 'a.py', line: 3, state: 'new', message: 'Kept too long' }] } };
const rawBody = JSON.stringify(event);
const webhookItem = (body: string, signature: string) => ({
  json: { headers: { 'x-lexcompiler-signature': signature, 'content-type': 'application/json' }, body: JSON.parse(rawBody) },
  binary: { data: { data: Buffer.from(body).toString('base64'), mimeType: 'application/json' } },
});

describe('n8n workflow export', () => {
  it('is an inactive workflow whose connections all point at existing nodes', () => {
    expect(workflow.active).toBe(false);
    expect(workflow.settings).toBeTruthy();
    const names = workflow.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [from, c] of Object.entries(workflow.connections)) {
      expect(names, `source ${from}`).toContain(from);
      for (const branch of c.main) for (const target of branch) expect(names, `${from} -> ${target.node}`).toContain(target.node);
    }
    for (const n of workflow.nodes) expect(n.type).toMatch(/^n8n-nodes-base\./);
  });

  it('listens on POST /webhook/lexcompiler with the raw body and answers through a node', () => {
    const hook = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook')!;
    expect(hook.typeVersion).toBe(2);
    expect(hook.parameters).toMatchObject({ path: 'lexcompiler', httpMethod: 'POST', responseMode: 'responseNode', options: { rawBody: true } });
    expect(workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook').length).toBeGreaterThanOrEqual(2);
    expect(node('Respond 401').parameters.options.responseCode).toBe(401);
  });

  it('keeps the Slack and email nodes, switched off', () => {
    const slack = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.slack');
    const email = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.emailSend');
    expect(slack).toHaveLength(1);
    expect(email).toHaveLength(1);
    for (const n of [...slack, ...email]) expect(n.disabled).toBe(true);
    expect(workflow.nodes.filter((n) => n.disabled).map((n) => n.name).sort()).toEqual(['Email (disabled)', 'Slack (disabled)']);
  });

  it('has a branch and a formatter for each event type', () => {
    const outputs = node('Event type').parameters.rules.values.map((v: any) => v.outputKey);
    expect(outputs).toHaveLength(5);
    for (const t of ['regulation.watch', 'exception.requested', 'exception.decided', 'webhook.test']) expect(outputs).toContain(t);
    // Five rule outputs and the fallback (events nobody needs to read about).
    expect(workflow.connections['Event type'].main).toHaveLength(6);
    expect(workflow.connections['Event type'].main[5][0].node).toBe('Respond OK');
  });
});

describe('Event type switch', () => {
  const rules = node('Event type').parameters.rules.values as Array<{ outputKey: string; conditions: { conditions: Array<{ leftValue: string; rightValue: string }> } }>;
  /** Evaluates a rule's condition the way n8n would, for an event, using the same JavaScript expression. */
  const matches = (rule: (typeof rules)[number], e: any): boolean => {
    const c = rule.conditions.conditions[0];
    const expr = c.leftValue.slice(4, -3); // from "={{ " ... " }}"
    const value = vm.runInNewContext(expr, { $json: { event: e } });
    return typeof value === 'boolean' ? value : value === c.rightValue;
  };
  const outputFor = (e: any) => {
    const i = rules.findIndex((r) => matches(r, e));
    return i === -1 ? rules.length : i;
  };
  const scan = (data: object) => ({ type: 'scan.completed', data: { counts: { new: 0, existing: 0, waived: 0 }, conclusion: 'success', ...data } });
  const formatterOf = (output: number) => workflow.connections['Event type'].main[output][0].node;

  it('passes scans with new findings, a failure or a pending decision, and drops the rest', () => {
    expect(outputFor(scan({ counts: { new: 2, existing: 0, waived: 0 } }))).toBe(0);
    expect(outputFor(scan({ conclusion: 'failure' }))).toBe(0);
    expect(outputFor(scan({ conclusion: 'action_required' }))).toBe(0);
    for (const conclusion of ['success', 'neutral']) expect(outputFor(scan({ conclusion }))).toBe(rules.length);
  });

  it('sends each event type to its own formatter, and the rest to Respond OK', () => {
    expect(formatterOf(outputFor(scan({ conclusion: 'failure' })))).toBe('Format scan.completed');
    for (const t of ['regulation.watch', 'exception.requested', 'exception.decided', 'webhook.test']) {
      expect(formatterOf(outputFor({ type: t, data: {} })), t).toBe(`Format ${t}`);
    }
    expect(formatterOf(outputFor(scan({})))).toBe('Respond OK');
  });
});

describe('Verify signature code node', () => {
  it('accepts a correctly signed body and returns the event', async () => {
    const [out] = await runCode('Verify signature', webhookItem(rawBody, signBody(SECRET, rawBody)), { LEXCOMPILER_WEBHOOK_SECRET: SECRET });
    expect(out.json.valid).toBe(true);
    expect(out.json.event).toEqual(event);
  });

  it("reads the bytes through n8n's binary helper when there is one", async () => {
    const helpers = { getBinaryDataBuffer: async () => Buffer.from(rawBody) };
    const item = { ...webhookItem(rawBody, signBody(SECRET, rawBody)), binary: { data: { data: 'filesystem-v2', id: 'x' } } };
    const [out] = await runCode('Verify signature', item, { LEXCOMPILER_WEBHOOK_SECRET: SECRET }, helpers);
    expect(out.json.valid).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a bad or missing signature and a missing raw body', async () => {
    const env = { LEXCOMPILER_WEBHOOK_SECRET: SECRET };
    const good = signBody(SECRET, rawBody);
    const tampered = rawBody.replace('"new":1', '"new":0');
    expect(tampered).not.toBe(rawBody);
    for (const item of [
      webhookItem(tampered, good),
      webhookItem(rawBody, signBody('another-secret', rawBody)),
      webhookItem(rawBody, 'sha256=' + 'a'.repeat(64)),
      webhookItem(rawBody, good.slice(0, -2)),
      webhookItem(rawBody, ''),
    ]) {
      const [out] = await runCode('Verify signature', item, env);
      expect(out.json.valid).toBe(false);
      expect(out.json.event).toBeNull();
    }
    const [noRaw] = await runCode('Verify signature', { json: { headers: { 'x-lexcompiler-signature': good } } }, env);
    expect(noRaw.json).toMatchObject({ valid: false });
    await expect(runCode('Verify signature', webhookItem(rawBody, good), {})).rejects.toThrow(/LEXCOMPILER_WEBHOOK_SECRET/);
  });

  it('uses the same HMAC as the sender', () => {
    expect(signBody(SECRET, rawBody)).toBe(`sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`);
  });
});

describe('format nodes', () => {
  const run = (name: string, e: unknown) => runCode(name, { json: { valid: true, event: e } });

  it('write plain-English messages with a title, text and url', async () => {
    const [scan] = await run('Format scan.completed', { ...event, data: { ...event.data, commit: 'abcdef123456', url: 'http://lexc.test/app/checks/s1' } });
    expect(scan.json.title).toContain('acme/core');
    expect(scan.json.text).toContain('1 new');
    expect(scan.json.text).toContain('GDPR-17: a.py:3');
    expect(scan.json.url).toBe('http://lexc.test/app/checks/s1');
    const [watch] = await run('Format regulation.watch', { type: 'regulation.watch', data: { title: 'New rule', link: 'http://x.test/n', matchedRules: ['GDPR-17'], summary: 'Keep less.' } });
    expect(watch.json).toMatchObject({ title: 'Regulation watch: New rule', url: 'http://x.test/n' });
    expect(watch.json.text).toContain('GDPR-17');
    const [req] = await run('Format exception.requested', { type: 'exception.requested', data: { rule: 'GDPR-17', requester: 'Tanvir', repository: 'acme/core', path: 'a.py', line: 3 } });
    expect(req.json.text).toContain('Tanvir asked for an exception to GDPR-17');
    const [dec] = await run('Format exception.decided', { type: 'exception.decided', data: { rule: 'GDPR-17', status: 'approved', expiresAt: '2025-06-30T00:00:00Z', decisionNote: 'ok' } });
    expect(dec.json.title).toBe('Exception approved for GDPR-17');
    expect(dec.json.text).toContain('until 2025-06-30');
    const [test] = await run('Format webhook.test', { type: 'webhook.test', data: { message: 'Hello' } });
    expect(test.json).toMatchObject({ title: 'LexCompiler test event', text: 'Hello' });
  });
});
