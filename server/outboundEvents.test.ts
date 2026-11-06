import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { checkWebhookUrl, createEventDeliveryHandler, EVENT_JOB_KIND, emitWorkspaceEvent, exceptionEventData, isPrivateAddress, scanEventData, signBody, type OutboundDeps } from './events/outbound.js';
import { JobQueue } from './jobs/queue.js';
import { createProductRouter } from './product/router.js';
import type { ClassifiedFinding } from './product/scanner.js';
import { ProductStore, type ExceptionRecord, type RuleInEffect, type ScanRecord } from './product/store.js';

const PRIVATE_ENV = 'LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS';
const savedEnv = process.env[PRIVATE_ENV];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-events-'));
let store: ProductStore;
let workspaceId: string;
let api: http.Server;
let base: string;

/** A receiver that records every request and answers with `status`. */
interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}
let receiver: http.Server;
let receiverUrl: string;
let received: Received[] = [];
let replyStatus = 200;

beforeAll(async () => {
  process.env[PRIVATE_ENV] = '1';
  store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
  const owner = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true });
  workspaceId = store.createWorkspace('FinHealth AI', owner.id).id;
  store.invite(workspaceId, 'nusrat@example.test', 'legal', owner.id);
  store.acceptInvitations(store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.test', emailVerified: true }));
  store.invite(workspaceId, 'tanvir@example.test', 'engineer', owner.id);
  store.acceptInvitations(store.upsertUser({ sub: 'tanvir', email: 'tanvir@example.test', emailVerified: true }));
  store.upsertUser({ sub: 'stranger', email: 'stranger@example.test', emailVerified: true });

  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(replyStatus).end('{}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook/lexcompiler`;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const sub = req.header('x-test-user');
    res.locals.principal = sub ? { sub, globalRole: sub === 'root' ? 'admin' : 'member', via: 'oidc-session' } : null;
    next();
  });
  app.use('/api', createProductRouter(store, null, { reposRoot: path.join(dataDir, 'repos'), publicUrl: 'http://lexc.test' }));
  api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterEach(() => {
  received = [];
  replyStatus = 200;
  process.env[PRIVATE_ENV] = '1';
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env[PRIVATE_ENV];
  else process.env[PRIVATE_ENV] = savedEnv;
  api?.close();
  receiver?.close();
  store?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: string, p: string, user: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** A workspace with its own webhook and queue, so these tests don't depend on each other. */
function setup(events: string[], url = receiverUrl, options: { maxAttempts?: number; lookup?: (host: string) => Promise<string[]> } = {}) {
  const ws = store.createWorkspace(`ws-${crypto.randomUUID().slice(0, 8)}`, null).id;
  const { newSecret } = store.setWorkspaceWebhook(ws, { url, events });
  // The jobs table is shared by every queue on this database; start from an empty one.
  store.db.exec('DELETE FROM jobs');
  const queue = new JobQueue(store.db, { [EVENT_JOB_KIND]: createEventDeliveryHandler({ store, lookup: options.lookup }) }, { maxAttempts: options.maxAttempts ?? 3, backoffMs: () => 0 });
  const deps: OutboundDeps = { store, queue, publicUrl: 'http://lexc.test' };
  return { ws, secret: newSecret!, queue, deps };
}

describe('event signature', () => {
  it('is the HMAC-SHA256 of the exact body, in hex, after "sha256="', () => {
    const body = '{"id":"1","data":{"text":"é  spaced"}}';
    const expected = crypto.createHmac('sha256', 'shh').update(Buffer.from(body, 'utf8')).digest('hex');
    expect(signBody('shh', body)).toBe(`sha256=${expected}`);
    expect(signBody('shh', body + ' ')).not.toBe(signBody('shh', body));
    expect(signBody('other', body)).not.toBe(signBody('shh', body));
  });
});

describe('emitting events', () => {
  it('does nothing without a webhook or for a type that is not subscribed', () => {
    const { ws, deps, queue: q } = setup(['exception.requested']);
    const none = store.createWorkspace('no hook', null).id;
    const queue = new JobQueue(store.db, { [EVENT_JOB_KIND]: async () => undefined });
    emitWorkspaceEvent({ store, queue }, none, 'scan.completed', {});
    emitWorkspaceEvent(deps, ws, 'scan.completed', {});
    expect(queue.counts().queued).toBe(0);
    expect(q.counts().queued).toBe(0);
    expect(store.listOutboundDeliveries(ws)).toHaveLength(0);
    emitWorkspaceEvent(deps, ws, 'exception.requested', { id: 'e1' });
    expect(q.counts().queued).toBe(1);
    expect(store.listOutboundDeliveries(ws)).toMatchObject([{ eventType: 'exception.requested', status: 'pending', attempts: 0 }]);
  });

  it('never throws, even when the queue does', () => {
    const { ws } = setup(['scan.completed']);
    const broken = { enqueue: () => { throw new Error('boom'); } } as unknown as JobQueue;
    expect(() => emitWorkspaceEvent({ store, queue: broken }, ws, 'scan.completed', {})).not.toThrow();
  });

  it('delivers to a local receiver, which can verify the signature and headers', async () => {
    const { ws, secret, queue, deps } = setup(['scan.completed']);
    emitWorkspaceEvent(deps, ws, 'scan.completed', { repository: 'acme/core', counts: { new: 2 } });
    expect(await queue.drain()).toBe(1);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    const event = JSON.parse(body) as { id: string; type: string; workspaceId: string; createdAt: string; data: unknown };
    expect(event).toMatchObject({ type: 'scan.completed', workspaceId: ws, data: { repository: 'acme/core', counts: { new: 2 } } });
    expect(Object.keys(event).sort()).toEqual(['createdAt', 'data', 'id', 'type', 'workspaceId']);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('LexCompiler-Webhooks/1');
    expect(headers['x-lexcompiler-event']).toBe('scan.completed');
    expect(headers['x-lexcompiler-delivery']).toBe(event.id);
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(headers['x-lexcompiler-signature']).toBe(expected);
    expect(store.getOutboundDelivery(event.id)).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200, error: null });
    expect(queue.counts().done).toBeGreaterThanOrEqual(1);
  });

  it('retries a failing receiver and marks the delivery failed after the last attempt', async () => {
    replyStatus = 500;
    const { ws, queue, deps } = setup(['exception.decided'], receiverUrl, { maxAttempts: 2 });
    emitWorkspaceEvent(deps, ws, 'exception.decided', { id: 'e2' });
    const [pending] = store.listOutboundDeliveries(ws);
    expect(await queue.drain()).toBe(2);
    expect(received).toHaveLength(2);
    // The same event id both times, so the receiver can drop duplicates.
    expect(received[1].headers['x-lexcompiler-delivery']).toBe(received[0].headers['x-lexcompiler-delivery']);
    expect(store.getOutboundDelivery(pending.eventId)).toMatchObject({ status: 'failed', attempts: 2, responseStatus: 500 });
    expect(queue.counts().failed).toBeGreaterThanOrEqual(1);
  });

  it('stays pending between attempts, and is delivered when a retry succeeds', async () => {
    replyStatus = 503;
    const { ws, queue, deps } = setup(['exception.decided']);
    emitWorkspaceEvent(deps, ws, 'exception.decided', {});
    await queue.runOnce();
    const eventId = store.listOutboundDeliveries(ws)[0].eventId;
    expect(store.getOutboundDelivery(eventId)).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 503 });
    replyStatus = 204;
    await queue.runOnce();
    expect(store.getOutboundDelivery(eventId)).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 204 });
  });

  it('checks the address again at delivery time and does not retry a refused one', async () => {
    const { ws, queue, deps } = setup(['scan.completed']);
    emitWorkspaceEvent(deps, ws, 'scan.completed', {});
    delete process.env[PRIVATE_ENV];
    await queue.drain();
    expect(received).toHaveLength(0);
    expect(store.listOutboundDeliveries(ws)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(store.listOutboundDeliveries(ws)[0].error).toMatch(/private or loopback/);
  });
});

describe('delivery against the current configuration', () => {
  const port = () => (receiver.address() as AddressInfo).port;

  it('falls back to the next address when the first refuses the connection (localhost -> ::1 then 127.0.0.1)', async () => {
    // The receiver listens on 127.0.0.1 only; the resolver answers ::1 first, as it does on many machines.
    const lookup = async () => ['::1', '127.0.0.1'];
    const { ws, queue, deps } = setup(['scan.completed'], `http://localhost:${port()}/webhook/lexcompiler`, { lookup });
    emitWorkspaceEvent(deps, ws, 'scan.completed', { repository: 'acme/core' });
    await queue.drain();
    expect(received).toHaveLength(1);
    expect(received[0].headers.host).toBe(`localhost:${port()}`);
    expect(store.listOutboundDeliveries(ws)[0]).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200, error: null });
  });

  it('still refuses the whole host when any resolved address is disallowed', async () => {
    const lookup = async () => ['93.184.216.34', '127.0.0.1'];
    const { ws, queue, deps } = setup(['scan.completed'], `http://localhost:${port()}/x`, { lookup });
    emitWorkspaceEvent(deps, ws, 'scan.completed', {});
    delete process.env[PRIVATE_ENV];
    await queue.drain();
    expect(received).toHaveLength(0);
    expect(store.listOutboundDeliveries(ws)[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('fails and retries when every address refuses the connection', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const { ws, queue, deps } = setup(['scan.completed'], `http://localhost:${deadPort}/x`, { lookup: async () => ['::1', '127.0.0.1'], maxAttempts: 2 });
    emitWorkspaceEvent(deps, ws, 'scan.completed', {});
    await queue.runOnce();
    expect(store.listOutboundDeliveries(ws)[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(store.listOutboundDeliveries(ws)[0].error).toMatch(/ECONNREFUSED/);
    await queue.runOnce();
    expect(store.listOutboundDeliveries(ws)[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('uses the URL and secret current at delivery time, and clears the old error', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const { ws, queue, deps } = setup(['scan.completed'], `http://127.0.0.1:${deadPort}/old`);
    emitWorkspaceEvent(deps, ws, 'scan.completed', {});
    await queue.runOnce();
    const eventId = store.listOutboundDeliveries(ws)[0].eventId;
    expect(store.getOutboundDelivery(eventId)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(store.getOutboundDelivery(eventId)!.error).toMatch(/ECONNREFUSED/);
    // The owner fixes the URL and rotates the secret before the retry.
    const { newSecret } = store.setWorkspaceWebhook(ws, { url: `http://127.0.0.1:${port()}/new`, events: ['scan.completed'], rotateSecret: true });
    await queue.drain();
    expect(received).toHaveLength(1);
    expect(received[0].body).toContain(eventId);
    const secret = newSecret ?? store.getWorkspaceWebhook(ws)!.secret;
    expect(received[0].headers['x-lexcompiler-signature']).toBe(signBody(secret, received[0].body));
    expect(store.getOutboundDelivery(eventId)).toMatchObject({ status: 'delivered', attempts: 2, responseStatus: 200, error: null });
  });

  it('fails without retrying when the webhook was deleted or the event unsubscribed', async () => {
    const a = setup(['scan.completed']);
    emitWorkspaceEvent(a.deps, a.ws, 'scan.completed', {});
    store.deleteWorkspaceWebhook(a.ws);
    await a.queue.drain();
    expect(received).toHaveLength(0);
    expect(store.listOutboundDeliveries(a.ws)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(store.listOutboundDeliveries(a.ws)[0].error).toMatch(/no webhook/);

    const b = setup(['scan.completed', 'exception.decided']);
    emitWorkspaceEvent(b.deps, b.ws, 'scan.completed', {});
    store.setWorkspaceWebhook(b.ws, { url: receiverUrl, events: ['exception.decided'] });
    await b.queue.drain();
    expect(received).toHaveLength(0);
    expect(store.listOutboundDeliveries(b.ws)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(store.listOutboundDeliveries(b.ws)[0].error).toMatch(/no longer subscribed to scan.completed/);
    expect(b.queue.counts().failed + b.queue.counts().done).toBeGreaterThanOrEqual(1);
  });
});

describe('webhook URL guard', () => {
  const publicLookup = async () => ['93.184.216.34'];
  const on = { LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS: '1' } as NodeJS.ProcessEnv;
  const off = {} as NodeJS.ProcessEnv;

  it('allows https to a public host and nothing but http(s)', async () => {
    await expect(checkWebhookUrl('https://hooks.example.com/x', { env: off, lookup: publicLookup })).resolves.toMatchObject({ addresses: ['93.184.216.34'] });
    await expect(checkWebhookUrl('ftp://hooks.example.com/x', { env: off, lookup: publicLookup })).rejects.toThrow(/http or https/);
    await expect(checkWebhookUrl('not a url', { env: off })).rejects.toThrow(/valid URL/);
    await expect(checkWebhookUrl('https://user:pw@hooks.example.com/x', { env: off, lookup: publicLookup })).rejects.toThrow(/user name/);
  });

  it('refuses plain http to a public host, even with the variable', async () => {
    await expect(checkWebhookUrl('http://hooks.example.com/x', { env: on, lookup: publicLookup })).rejects.toThrow(/plain http/);
  });

  it('refuses http to localhost without the variable and allows it with it', async () => {
    await expect(checkWebhookUrl('http://localhost:5678/webhook/lexcompiler', { env: off, lookup: async () => ['127.0.0.1', '::1'] })).rejects.toThrow(/LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS/);
    await expect(checkWebhookUrl('http://127.0.0.1:5678/x', { env: off })).rejects.toThrow(/LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS/);
    await expect(checkWebhookUrl('http://localhost:5678/webhook/lexcompiler', { env: on, lookup: async () => ['127.0.0.1'] })).resolves.toBeTruthy();
    await expect(checkWebhookUrl('http://192.168.1.20:5678/x', { env: on })).resolves.toBeTruthy();
  });

  it('refuses https to private and loopback addresses without the variable', async () => {
    for (const url of ['https://10.0.0.5/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://172.16.0.1/x', 'https://[::ffff:10.0.0.1]/x']) {
      await expect(checkWebhookUrl(url, { env: off })).rejects.toThrow(/private or loopback/);
    }
    await expect(checkWebhookUrl('https://10.0.0.5/x', { env: on })).resolves.toBeTruthy();
  });

  it('checks every address a name resolves to', async () => {
    await expect(checkWebhookUrl('https://rebind.example.com/x', { env: off, lookup: async () => ['93.184.216.34', '10.1.2.3'] })).rejects.toThrow(/private or loopback/);
    await expect(checkWebhookUrl('https://nowhere.example.com/x', { env: off, lookup: async () => [] })).rejects.toThrow(/resolved/);
  });

  it('recognises private ranges', () => {
    for (const a of ['127.0.0.1', '10.255.0.1', '172.31.9.9', '192.168.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:7f00:1']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe('payloads', () => {
  it('carry places and counts, not source code or snippets', () => {
    const secretCode = 'password = "hunter2-SECRET-SNIPPET"';
    const finding: ClassifiedFinding = {
      ruleId: 'r1', ruleKey: 'GDPR-17', ruleVersionId: 'v1', fingerprint: 'fp', filePath: 'src/user.py', startLine: 12, endLine: 14,
      constructType: 'FunctionDef', message: 'Personal data is kept without a purge job', snippet: secretCode, state: 'new', exceptionId: null,
    };
    const scan = {
      id: 's1', commitSha: 'abcdef1234567', prNumber: 7, trigger: 'pull_request', conclusion: 'failure', filesScanned: 3,
      summary: { newCount: 1, existingCount: 0, waivedCount: 0, undecidedRuleKeys: [], perRule: [] },
    } as unknown as ScanRecord;
    const rules = [{ ruleKey: 'GDPR-17', clause: { title: 'Erasure' } }] as unknown as RuleInEffect[];
    const data = scanEventData(scan, { fullName: 'acme/core' }, rules, [finding], 'http://lexc.test/');
    const json = JSON.stringify(data);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('snippet');
    expect(data).toMatchObject({
      repository: 'acme/core', commit: 'abcdef1234567', prNumber: 7, conclusion: 'failure', counts: { new: 1, existing: 0, waived: 0 },
      rules: [{ key: 'GDPR-17', title: 'Erasure' }], findings: [{ rule: 'GDPR-17', path: 'src/user.py', line: 12 }], url: 'http://lexc.test/app/checks/s1',
    });

    const exception = { id: 'e1', ruleKey: 'GDPR-17', ruleTitle: 'Erasure', repoFullName: 'acme/core', filePath: 'src/user.py', startLine: 12, status: 'requested', requesterLabel: 'Tanvir via Kiro', reason: 'private business reason', requestedFrom: 'assistant' } as unknown as ExceptionRecord;
    const ex = JSON.stringify(exceptionEventData(exception));
    expect(ex).toContain('Tanvir via Kiro');
    expect(ex).not.toContain('private business reason');
  });
});

describe('webhook routes', () => {
  const path_ = () => `/workspaces/${workspaceId}/webhook`;

  it('are for the owner only', async () => {
    for (const user of ['nusrat', 'tanvir']) {
      expect((await call('GET', path_(), user)).status).toBe(403);
      expect((await call('PUT', path_(), user, { url: receiverUrl })).status).toBe(403);
      expect((await call('DELETE', path_(), user)).status).toBe(403);
      expect((await call('POST', `${path_()}/test`, user, {})).status).toBe(403);
      expect((await call('GET', `${path_()}/deliveries`, user)).status).toBe(403);
    }
    // Not a member: the workspace is hidden.
    expect((await call('GET', path_(), 'stranger')).status).toBe(404);
    expect(store.getWorkspaceWebhook(workspaceId)).toBeUndefined();
  });

  it('return the secret only when it is created or rotated, and never on GET', async () => {
    expect((await call('GET', path_(), 'arif')).body).toMatchObject({ configured: false });

    const created = await call('PUT', path_(), 'arif', { url: receiverUrl, events: ['scan.completed', 'exception.decided'] });
    expect(created.status).toBe(201);
    expect(typeof created.body.secret).toBe('string');
    expect(Buffer.from(created.body.secret, 'base64url')).toHaveLength(32);
    expect(created.body).toMatchObject({ configured: true, url: receiverUrl, events: ['scan.completed', 'exception.decided'] });

    const got = await call('GET', path_(), 'arif');
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain(created.body.secret);
    expect(got.body.secret).toBeUndefined();
    expect(got.body).toMatchObject({ url: receiverUrl, events: ['scan.completed', 'exception.decided'] });
    expect(got.body.createdAt).toBeTruthy();
    expect(got.body.updatedAt).toBeTruthy();

    // Changing the events keeps the secret and does not show it.
    const updated = await call('PUT', path_(), 'arif', { url: receiverUrl, events: ['regulation.watch'] });
    expect(updated.status).toBe(200);
    expect(updated.body.secret).toBeUndefined();
    expect(updated.body.events).toEqual(['regulation.watch']);
    expect(store.getWorkspaceWebhook(workspaceId)!.secret).toBe(created.body.secret);

    const rotated = await call('PUT', path_(), 'arif', { url: receiverUrl, rotateSecret: true });
    expect(rotated.body.secret).toBeTruthy();
    expect(rotated.body.secret).not.toBe(created.body.secret);
    expect(store.getWorkspaceWebhook(workspaceId)!.secret).toBe(rotated.body.secret);
    // Without "events" a PUT subscribes to every event.
    expect(rotated.body.events).toHaveLength(4);
    expect((await call('GET', path_(), 'root')).status).toBe(200);
  });

  it('refuse bad input and addresses the guard does not allow', async () => {
    expect((await call('PUT', path_(), 'arif', {})).status).toBe(400);
    expect((await call('PUT', path_(), 'arif', { url: receiverUrl, events: ['nope'] })).status).toBe(400);
    expect((await call('PUT', path_(), 'arif', { url: receiverUrl, events: [] })).status).toBe(400);
    delete process.env[PRIVATE_ENV];
    expect((await call('PUT', path_(), 'arif', { url: 'http://localhost:5678/webhook/lexcompiler' })).status).toBe(400);
    expect((await call('PUT', path_(), 'arif', { url: 'https://10.0.0.5/hook' })).status).toBe(400);
  });

  it('send a test event and list the deliveries', async () => {
    const secret = store.getWorkspaceWebhook(workspaceId)!.secret;
    const sent = await call('POST', `${path_()}/test`, 'arif', {});
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ eventType: 'webhook.test', status: 'delivered', responseStatus: 200, attempts: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].headers['x-lexcompiler-event']).toBe('webhook.test');
    expect(received[0].headers['x-lexcompiler-signature']).toBe(signBody(secret, received[0].body));

    replyStatus = 500;
    const failed = await call('POST', `${path_()}/test`, 'arif', {});
    expect(failed.body).toMatchObject({ status: 'failed', responseStatus: 500 });

    const list = await call('GET', `${path_()}/deliveries`, 'arif');
    expect(list.body.map((d: { status: string }) => d.status)).toEqual(['failed', 'delivered']);
  });

  it('delete the webhook, and the test then needs a new one', async () => {
    expect((await call('DELETE', path_(), 'arif')).body).toEqual({ deleted: true });
    expect((await call('GET', path_(), 'arif')).body).toMatchObject({ configured: false });
    expect((await call('POST', `${path_()}/test`, 'arif', {})).status).toBe(409);
    expect((await call('DELETE', path_(), 'arif')).body).toEqual({ deleted: false });
  });
});
