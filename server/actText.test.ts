import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { assertPublicHttpUrl, BLOCKED_MESSAGE, celexOf, cellarUrl, fetchActText, fetchUrlText, htmlToText } from './regulations/actText.js';
import { createProductRouter } from './product/router.js';
import { ProductStore, StoreError, type FeedItem } from './product/store.js';

const item = (over: Partial<FeedItem>): FeedItem => ({
  id: 'EUR_LEX:CELEX:32016R0679R(02)',
  source: 'EUR_LEX',
  documentNumber: 'CELEX:32016R0679R(02)',
  title: 'Corrigendum to the GDPR',
  publicationDate: '2021-03-23',
  agency: null,
  excerpt: '',
  url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679R(02)',
  kind: 'CHANGE_NOTICE',
  illustrative: false,
  firstSeenAt: '2026-11-01T00:00:00Z',
  ...over,
});

const XHTML = `<?xml version="1.0"?><html><head><title>x</title><style>p{}</style></head><body>
<p class="oj-ti-art">Article 5</p><p class="oj-sti-art">Principles relating to processing &amp; storage</p>
<p class="oj-normal">1.   Personal data shall be:</p>
<table><tr><td><p>(a)</p></td><td><p>processed lawfully;</p></td></tr><tr><td><p>(b)</p></td><td><p>collected for specified purposes.</p></td></tr></table>
<p class="oj-ti-art">Article 6</p></body></html>`;

interface Call {
  url: string;
  init?: RequestInit;
}
const stub = (answer: (url: string, init?: RequestInit) => Response) => {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input), init);
  }) as typeof fetch;
  return { f, calls };
};
const publicHost = async () => ['93.184.216.34'];

describe('act text from official sources', () => {
  it('percent-encodes the brackets of a CELEX number and sends the Cellar headers', async () => {
    expect(cellarUrl('32016R0679R(02)')).toBe('https://publications.europa.eu/resource/celex/32016R0679R%2802%29');
    expect(celexOf(item({}))).toBe('32016R0679R(02)');
    expect(celexOf(item({ documentNumber: 'x', url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679' }))).toBe('32016R0679');
    const { f, calls } = stub(() => new Response(XHTML));
    await fetchActText(item({}), { fetch: f });
    expect(calls[0].url).toBe('https://publications.europa.eu/resource/celex/32016R0679R%2802%29');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/xhtml+xml;q=0.9, text/html;q=0.8');
    expect(headers['Accept-Language']).toBe('eng');
    expect(calls[0].init?.redirect).toBe('follow');
  });

  it('keeps article headings, numbers and paragraph breaks when it converts XHTML', async () => {
    const act = await fetchActText(item({}), { fetch: stub(() => new Response(XHTML)).f });
    expect(act.format).toBe('xhtml');
    expect(act.text).toBe('Article 5\n\nPrinciples relating to processing & storage\n\n1. Personal data shall be:\n\n(a) processed lawfully;\n(b) collected for specified purposes.\n\nArticle 6');
    expect(htmlToText('<p>a</p><p>b</p><script>evil()</script>')).toBe('a\n\nb');
  });

  it('reports an unreachable or missing act as an error', async () => {
    await expect(fetchActText(item({}), { fetch: stub(() => new Response('', { status: 404 })).f })).rejects.toMatchObject({ status: 404 });
    await expect(fetchActText(item({ documentNumber: 'bad one', url: null }), { fetch: stub(() => new Response('')).f })).rejects.toMatchObject({ status: 422 });
  });

  it('reads a Federal Register document in two steps: the API, then its raw text', async () => {
    const { f, calls } = stub((url) =>
      url.endsWith('/documents/2026-21001.json')
        ? Response.json({ title: 'Health data retention', raw_text_url: 'https://www.federalregister.gov/documents/full_text/text/2026/10/28/2026-21001.txt', html_url: 'https://www.federalregister.gov/d/2026-21001' })
        : new Response('<html><body><pre>Sec. 1 Purge.\n\nCovered entities must purge &amp; encrypt.</pre></body></html>')
    );
    const act = await fetchActText(item({ source: 'FEDERAL_REGISTER', documentNumber: '2026-21001', kind: 'TEXT' }), { fetch: f });
    expect(calls.map((c) => c.url)).toEqual(['https://www.federalregister.gov/api/v1/documents/2026-21001.json', 'https://www.federalregister.gov/documents/full_text/text/2026/10/28/2026-21001.txt']);
    expect(act).toMatchObject({ title: 'Health data retention', sourceUrl: 'https://www.federalregister.gov/d/2026-21001', format: 'text' });
    expect(act.text).toBe('Sec. 1 Purge.\n\nCovered entities must purge & encrypt.');
  });
});

describe('Import from URL (Browserbase Fetch)', () => {
  const page = '# Circular 12\n\n' + 'Banks must report incidents within 24 hours. '.repeat(10);

  it('posts to the Fetch API with the key, markdown and redirects, and never asks for proxies', async () => {
    const { f, calls } = stub(() => Response.json({ statusCode: 200, headers: {}, content: page }));
    const out = await fetchUrlText('https://example.org/circular', { fetch: f, browserbaseKey: 'bb-test-key', lookup: publicHost });
    expect(calls[0].url).toBe('https://api.browserbase.com/v1/fetch');
    expect(calls[0].init?.method).toBe('POST');
    expect((calls[0].init?.headers as Record<string, string>)['X-BB-API-Key']).toBe('bb-test-key');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ url: 'https://example.org/circular', format: 'markdown', allowRedirects: true });
    expect(JSON.stringify(body)).not.toMatch(/prox/i);
    expect(out).toMatchObject({ title: 'Circular 12', sourceUrl: 'https://example.org/circular', format: 'markdown' });
  });

  it.each([
    ['a WAF challenge header', { statusCode: 200, headers: { 'x-amzn-waf-action': 'challenge' }, content: page }],
    ['a Cloudflare mitigation header', { statusCode: 200, headers: { 'CF-Mitigated': 'challenge' }, content: page }],
    ['an empty 202', { statusCode: 202, headers: {}, content: '' }],
    ['an empty 403', { statusCode: 403, headers: {}, content: '' }],
    ['an empty 429', { statusCode: 429, headers: {}, content: '' }],
    ['almost no content', { statusCode: 200, headers: {}, content: 'Just a moment...' }],
  ])('answers 422 with the upload hint on %s', async (_name, answer) => {
    const { f } = stub(() => Response.json(answer));
    const err = await fetchUrlText('https://example.org/x', { fetch: f, browserbaseKey: 'k', lookup: publicHost }).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ status: 422, message: BLOCKED_MESSAGE });
  });

  it('needs the key, and refuses non-http, localhost and private addresses before calling out', async () => {
    const { f, calls } = stub(() => Response.json({}));
    await expect(fetchUrlText('https://example.org/x', { fetch: f, browserbaseKey: null })).rejects.toMatchObject({ status: 503 });
    for (const url of ['file:///etc/passwd', 'ftp://example.org/a', 'http://localhost:3001/api', 'http://127.0.0.1/', 'http://10.0.0.5/x', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:192.168.1.1]/', 'http://intranet/', 'http://db.internal/', 'not a url']) {
      await expect(fetchUrlText(url, { fetch: f, browserbaseKey: 'k', lookup: publicHost }), url).rejects.toBeInstanceOf(StoreError);
    }
    // A public-looking name that resolves to a private address is refused too.
    await expect(assertPublicHttpUrl('https://sneaky.example.org/', async () => ['10.1.2.3'])).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('act text routes', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexc-acttext-'));
  let server: http.Server;
  let origin: string;
  let store: ProductStore;
  let ws: string;
  let key: string | null = null;
  const fetched: string[] = [];

  beforeAll(async () => {
    store = new ProductStore(openDatabase(path.join(dataDir, 'lexcompiler.db')));
    const owner = store.upsertUser({ sub: 'arif', email: 'arif@example.test', emailVerified: true, name: 'Arif' });
    ws = store.createWorkspace('FinHealth AI', owner.id).id;
    store.invite(ws, 'nusrat@example.test', 'legal', owner.id);
    store.acceptInvitations(store.upsertUser({ sub: 'nusrat', email: 'nusrat@example.test', emailVerified: true, name: 'Nusrat' }));
    store.addFeedItems([{ id: 'EUR_LEX:CELEX:32016R0679R(02)', source: 'EUR_LEX', documentNumber: 'CELEX:32016R0679R(02)', title: 'Corrigendum to the GDPR', publicationDate: '2021-03-23', agency: null, excerpt: 'x', url: null, kind: 'CHANGE_NOTICE', illustrative: false }]);
    const fakeFetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      if (String(input).startsWith('https://api.browserbase.com/')) return Response.json({ statusCode: 200, headers: {}, content: `# Circular\n\n${'Banks must report incidents within 24 hours. '.repeat(10)}` });
      return new Response(XHTML);
    }) as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use('/api', (_req, res, next) => {
      res.locals.principal = { sub: 'nusrat', globalRole: 'member', via: 'oidc-session' };
      next();
    });
    app.use('/api', createProductRouter(store, null, { reposRoot: dataDir, actText: { fetch: fakeFetch, get browserbaseKey() { return key; }, lookup: publicHost } }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces/${ws}`;
  });
  afterAll(() => {
    server?.close();
    store?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = async (p: string, body: unknown = {}) => {
    const res = await fetch(`${origin}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  it('fetch-text stores the act as a regulation document linked to the feed item, once', async () => {
    const id = encodeURIComponent('EUR_LEX:CELEX:32016R0679R(02)');
    const first = await post(`/feed/${id}/fetch-text`);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ kind: 'regulation', title: 'Corrigendum to the GDPR' });
    expect(first.body.clauses.length).toBeGreaterThan(0);
    const row = store.db.prepare('SELECT feed_item_id, source_url FROM documents WHERE id = ?').get(first.body.id) as { feed_item_id: string; source_url: string };
    expect(row.feed_item_id).toBe('EUR_LEX:CELEX:32016R0679R(02)');
    expect(row.source_url).toContain('CELEX:32016R0679R(02)');
    const again = await post(`/feed/${id}/fetch-text`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(fetched.filter((u) => u.includes('publications.europa.eu'))).toEqual(['https://publications.europa.eu/resource/celex/32016R0679R%2802%29']);
    expect((await post('/feed/nope/fetch-text')).status).toBe(404);
  });

  it('from-url answers 503 without BROWSERBASE_API_KEY and imports with it', async () => {
    key = null;
    const off = await post('/documents/from-url', { url: 'https://example.org/circular' });
    expect(off.status).toBe(503);
    expect(off.body.error).toContain('BROWSERBASE_API_KEY');
    expect((await (await fetch(`${origin}/integrations`)).json())).toEqual({ browserbase: false });
    key = 'bb-test-key';
    expect((await (await fetch(`${origin}/integrations`)).json())).toEqual({ browserbase: true });
    const on = await post('/documents/from-url', { url: 'https://example.org/circular' });
    expect(on.status).toBe(201);
    expect(on.body).toMatchObject({ title: 'Circular', kind: 'regulation' });
    const row = store.db.prepare('SELECT source_url FROM documents WHERE id = ?').get(on.body.id) as { source_url: string };
    expect(row.source_url).toBe('https://example.org/circular');
    expect((await post('/documents/from-url', { url: 'http://localhost:3001/' })).status).toBe(400);
  });
});
