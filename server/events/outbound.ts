import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { JobHandler, JobQueue } from '../jobs/queue.js';
import type { ClassifiedFinding } from '../product/scanner.js';
import { StoreError, type ExceptionRecord, type FeedItem, type FeedNote, type OutboundDelivery, type ProductStore, type Repo, type RuleInEffect, type ScanRecord } from '../product/store.js';

/**
 * Workspace event webhooks: LexCompiler posts a signed JSON event to one URL per workspace (for
 * example an n8n workflow) when a scan completes, the regulation watch finds an item that may
 * affect rules, or an exception is requested or decided. Payloads carry names, counts and places
 * (rule keys, repository, commit, file path and line), never source code, snippets or secrets.
 */

export const EVENT_TYPES = ['scan.completed', 'regulation.watch', 'exception.requested', 'exception.decided'] as const;
export type WorkspaceEventType = (typeof EVENT_TYPES)[number];
/** Sent only by "Send test event"; it is not a subscription choice. */
export const TEST_EVENT = 'webhook.test';

export const EVENT_JOB_KIND = 'event_delivery';
/** One delivery (all addresses together) never holds the shared job worker longer than this. */
const TIMEOUT_MS = 10_000;
/** At most this many of a host's addresses are tried. */
const MAX_ADDRESSES = 3;
/** Errors that mean "could not connect to this address"; the next address is tried. */
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL']);
const MAX_FINDINGS = 20;

type Lookup = (hostname: string) => Promise<string[]>;

export interface OutboundDeps {
  store: ProductStore;
  /** A getter when the queue is built after the code that emits. Null in tests that don't run jobs. */
  queue: JobQueue | null | (() => JobQueue | null);
  /** Where links in payloads point. */
  publicUrl?: string;
  /** Resolves a hostname to its addresses (tests). */
  lookup?: Lookup;
  env?: NodeJS.ProcessEnv;
}

export interface EventEnvelope {
  id: string;
  type: string;
  workspaceId: string;
  createdAt: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------- address checks

const defaultLookup: Lookup = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** DNS failed in a way that may pass (resolver timeout, SERVFAIL): the delivery is retried, not dropped. */
export class TransientLookupError extends StoreError {
  constructor(message: string) {
    super(message, 503);
  }
}

function ipv4Private(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved and broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address (any notation, including an embedded dotted IPv4). */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** Loopback, private, link-local, unspecified or carrier-grade NAT addresses, IPv4 or IPv6. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true; // not an address we can reason about: treat as internal
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  // :: , ::1 and the IPv4-compatible ::a.b.c.d (the whole ::/96 block)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return ipv4Private(v4Of(g6, g7));
  // NAT64 64:ff9b::/96 (embedded IPv4 checked) and the local-use 64:ff9b:1::/48
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? ipv4Private(v4Of(g6, g7)) : g2 === 1;
  // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits
  if (g0 === 0x2002) return ipv4Private(v4Of(g1, g2));
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

/**
 * Whether the URL may receive events. https goes to any public host; anything that resolves to a
 * loopback, private or link-local address needs LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS=1, and plain
 * http is for such addresses only. Every address the host resolves to is checked. Returns the
 * addresses to connect to.
 */
export async function checkWebhookUrl(raw: string, options: { env?: NodeJS.ProcessEnv; lookup?: Lookup } = {}): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError('the webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new StoreError('the webhook URL must be http or https');
  if (url.username || url.password) throw new StoreError('the webhook URL must not contain a user name or password');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (options.lookup ?? defaultLookup)(host);
    } catch (err) {
      // "No such host" will not change on a retry; a resolver timeout or SERVFAIL may.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') addresses = [];
      else throw new TransientLookupError('the webhook host could not be resolved right now (DNS error), will retry');
    }
  }
  if (addresses.length === 0) throw new StoreError('the webhook host could not be resolved');
  const allowPrivate = (options.env ?? process.env).LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS === '1';
  if (addresses.some(isPrivateAddress) && !allowPrivate) {
    throw new StoreError('the webhook host is a private or loopback address; set LEXCOMPILER_ALLOW_PRIVATE_WEBHOOKS=1 on the server to allow it');
  }
  if (url.protocol === 'http:' && !addresses.every(isPrivateAddress)) throw new StoreError('plain http is only allowed for private or loopback hosts; use https');
  return { url, addresses };
}

// ---------------------------------------------------------------- signing and sending

export function signBody(secret: string, body: string | Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** The connection to this address never got established, so the next address may work. */
  connectFailed?: boolean;
  /** A refused address or a removed webhook: retrying cannot help. */
  permanent?: boolean;
}

/** One POST, connecting to an address that was just checked, so DNS cannot change between the check and the send. */
function post(url: URL, address: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<SendResult> {
  return new Promise((resolve) => {
    const family = net.isIPv6(address) ? 6 : 4;
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => (opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as never,
    });
    let connected = false;
    req.on('socket', (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once('connect', () => (connected = true));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer within ${Math.ceil(timeoutMs / 1000)} seconds`), { code: connected ? 'ETIMEDOUT_RESPONSE' : 'ETIMEDOUT' })), timeoutMs);
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300 ? { ok: true, status, error: null } : { ok: false, status, error: `the receiver answered ${status}` });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code ?? '';
      resolve({ ok: false, status: null, error: err.message, connectFailed: !connected && CONNECT_ERRORS.has(code) });
    });
    req.end(body);
  });
}

/** Tries the checked addresses in order (IPv4 first), moving on only when a connection could not be made. */
async function postToAny(url: URL, addresses: string[], headers: Record<string, string>, body: string): Promise<SendResult> {
  const ordered = [...addresses.filter((a) => !net.isIPv6(a)), ...addresses.filter((a) => net.isIPv6(a))].slice(0, MAX_ADDRESSES);
  const errors: string[] = [];
  const deadline = Date.now() + TIMEOUT_MS;
  for (const address of ordered) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const result = await post(url, address, headers, body, left);
    if (!result.connectFailed) return result;
    errors.push(result.error ?? 'connection failed');
  }
  return { ok: false, status: null, error: errors.join('; ') };
}

/** Sends the event once, checking the address again (DNS can change after the URL was saved). */
async function send(deps: Pick<OutboundDeps, 'store' | 'lookup' | 'env'>, event: EventEnvelope): Promise<SendResult> {
  // Always the current configuration (URL, secret, subscriptions), never what it was when the event was queued.
  const webhook = deps.store.getWorkspaceWebhook(event.workspaceId);
  if (!webhook) return { ok: false, status: null, error: 'the workspace has no webhook any more', permanent: true };
  if (event.type !== TEST_EVENT && !webhook.events.includes(event.type)) {
    return { ok: false, status: null, error: `the webhook is no longer subscribed to ${event.type}`, permanent: true };
  }
  let target: { url: URL; addresses: string[] };
  try {
    target = await checkWebhookUrl(webhook.url, { env: deps.env, lookup: deps.lookup });
  } catch (err) {
    // Only a refused address is permanent; a DNS hiccup is retried by the queue.
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err), permanent: !(err instanceof TransientLookupError) };
  }
  const body = JSON.stringify(event);
  return postToAny(
    target.url,
    target.addresses,
    {
      'Content-Type': 'application/json',
      'User-Agent': 'LexCompiler-Webhooks/1',
      'X-LexCompiler-Event': event.type,
      'X-LexCompiler-Delivery': event.id,
      'X-LexCompiler-Signature': signBody(webhook.secret, body),
    },
    body
  );
}

const queueOf = (deps: OutboundDeps): JobQueue | null => (typeof deps.queue === 'function' ? deps.queue() : deps.queue);

function envelope(workspaceId: string, type: string, data: Record<string, unknown>): EventEnvelope {
  return { id: crypto.randomUUID(), type, workspaceId, createdAt: new Date().toISOString(), data };
}

/**
 * Queues an event for the workspace's webhook. Does nothing without a webhook or when the event
 * type is not subscribed, and never throws: an event must not fail the flow that raised it.
 */
export function emitWorkspaceEvent(deps: OutboundDeps, workspaceId: string, type: WorkspaceEventType, data: Record<string, unknown>): void {
  try {
    const webhook = deps.store.getWorkspaceWebhook(workspaceId);
    if (!webhook || !webhook.events.includes(type)) return;
    const queue = queueOf(deps);
    if (!queue) return;
    const event = envelope(workspaceId, type, data);
    deps.store.recordOutboundDelivery({ workspaceId, eventId: event.id, eventType: type });
    queue.enqueue(EVENT_JOB_KIND, { event } as unknown as Record<string, unknown>, { dedupeKey: `event:${event.id}` });
  } catch (err) {
    console.error(`[events] ${type} for ${workspaceId} not queued: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** "Send test event": one attempt now, outside the queue, and its result. */
export async function sendTestEvent(deps: OutboundDeps, workspaceId: string, data: Record<string, unknown> = {}): Promise<OutboundDelivery> {
  const event = envelope(workspaceId, TEST_EVENT, data);
  deps.store.recordOutboundDelivery({ workspaceId, eventId: event.id, eventType: TEST_EVENT });
  const result = await send(deps, event);
  deps.store.updateOutboundDelivery(event.id, { status: result.ok ? 'delivered' : 'failed', attempts: 1, responseStatus: result.status, error: result.error });
  return deps.store.getOutboundDelivery(event.id)!;
}

/**
 * The `event_delivery` job. A non-2xx answer or a network error throws, so the queue retries
 * with its backoff; the delivery is marked failed after the queue's last attempt. A refused
 * address is marked failed at once (nothing to retry).
 */
export function createEventDeliveryHandler(deps: Pick<OutboundDeps, 'store' | 'lookup' | 'env'>): JobHandler {
  return async (payload, ctx) => {
    const event = payload.event as EventEnvelope;
    const result = await send(deps, event);
    if (result.ok) {
      deps.store.updateOutboundDelivery(event.id, { status: 'delivered', attempts: ctx.attempt, responseStatus: result.status });
      return;
    }
    const last = Boolean(result.permanent) || ctx.attempt >= ctx.maxAttempts;
    deps.store.updateOutboundDelivery(event.id, { status: last ? 'failed' : 'pending', attempts: ctx.attempt, responseStatus: result.status, error: result.error });
    if (result.permanent) return;
    throw new Error(`webhook delivery ${event.id} (${event.type}): ${result.error}`);
  };
}

// ---------------------------------------------------------------- payloads (no code, no secrets)

const clip = (s: string | null | undefined, n = 300) => (s ? s.slice(0, n) : null);
const link = (publicUrl: string | undefined, path: string) => (publicUrl ? `${publicUrl.replace(/\/+$/, '')}${path}` : null);

export function scanEventData(
  scan: ScanRecord,
  repo: Pick<Repo, 'fullName'>,
  rules: Array<Pick<RuleInEffect, 'ruleKey' | 'clause'>>,
  findings: ClassifiedFinding[],
  publicUrl?: string
): Record<string, unknown> {
  return {
    repository: repo.fullName,
    commit: scan.commitSha,
    prNumber: scan.prNumber,
    trigger: scan.trigger,
    conclusion: scan.conclusion,
    filesScanned: scan.filesScanned,
    counts: { new: scan.summary?.newCount ?? 0, existing: scan.summary?.existingCount ?? 0, waived: scan.summary?.waivedCount ?? 0 },
    undecidedRuleKeys: scan.summary?.undecidedRuleKeys ?? [],
    rules: rules.map((r) => ({ key: r.ruleKey, title: r.clause.title })),
    // New findings first; the rest are in LexCompiler.
    findings: [...findings]
      .sort((a, b) => Number(b.state === 'new') - Number(a.state === 'new'))
      .slice(0, MAX_FINDINGS)
      .map((f) => ({ rule: f.ruleKey, path: f.filePath, line: f.startLine, state: f.state, message: clip(f.message) })),
    findingsTotal: findings.length,
    url: link(publicUrl, `/app/checks/${scan.id}`),
  };
}

export function exceptionEventData(e: ExceptionRecord, publicUrl?: string): Record<string, unknown> {
  return {
    id: e.id,
    rule: e.ruleKey,
    ruleTitle: e.ruleTitle,
    repository: e.repoFullName,
    path: e.filePath ?? e.pathGlob,
    line: e.startLine,
    prNumber: e.prNumber,
    status: e.status,
    requester: e.requesterLabel,
    requestedFrom: e.requestedFrom,
    expiresAt: e.expiresAt,
    decisionNote: clip(e.decisionNote, 500),
    url: link(publicUrl, '/app/exceptions'),
  };
}

export function feedEventData(item: FeedItem, note: Pick<FeedNote, 'affectedRuleKeys' | 'summary'>): Record<string, unknown> {
  return { title: item.title, link: item.url, source: item.source, publishedAt: item.publicationDate, matchedRules: note.affectedRuleKeys, summary: note.summary };
}
