import dns from 'node:dns/promises';
import net from 'node:net';
import { CELLAR_RESOURCE } from './eurLex.js';
import { StoreError, type FeedItem } from '../product/store.js';

/**
 * The text of an amended act for Legal, from official sources: the Publications Office's Cellar
 * interface (EUR-Lex) and the Federal Register API need no key. "Import from URL" for any other
 * public page goes through Browserbase Fetch, only when BROWSERBASE_API_KEY is set; it never turns
 * on proxies and never tries to get past a bot check (a blocked page is reported, not worked around).
 */

export interface ActText {
  title: string;
  text: string;
  sourceUrl: string;
  format: 'xhtml' | 'text' | 'markdown';
}

export interface ActTextDeps {
  fetch?: typeof fetch;
  /** Browserbase API key; defaults to BROWSERBASE_API_KEY. */
  browserbaseKey?: string | null;
  /** Resolves a host name to its addresses (tests inject it; default is DNS). */
  lookup?: (host: string) => Promise<string[]>;
}

/** The same ceiling as an uploaded document's text. */
export const MAX_ACT_TEXT = 500_000;
export const BLOCKED_MESSAGE = 'This site blocks automated access. Download the document and upload it instead.';
const BROWSERBASE_FETCH = 'https://api.browserbase.com/v1/fetch';
const CELEX = /^[0-9A-Z()]{5,40}$/;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»' };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

/** XHTML or HTML to plain text: headings and paragraphs stay on their own lines, table rows become lines. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '');
  // <pre> keeps its line breaks (the Federal Register's raw text is one <pre>).
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => inner.replace(/\n/g, ''));
  s = s.replace(/\s+/g, ' ');
  // A table cell stays on its row's line (EUR-Lex lays out "(a)" and its text as two cells).
  s = s.replace(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `${inner.replace(/<\/?p\b[^>]*>/gi, ' ')} `);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(h[1-6]|p|div|li|tr|table|ul|ol|section|article|blockquote)\s*>/gi, '\n').replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<(h[1-6]|p|div|table|section|article)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(//g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string): string {
  if (text.length <= MAX_ACT_TEXT) return text;
  const cut = text.lastIndexOf('\n', MAX_ACT_TEXT);
  return text.slice(0, cut > MAX_ACT_TEXT / 2 ? cut : MAX_ACT_TEXT);
}

/** The CELEX number of a feed item: its document number ("CELEX:32016R0679R(02)") or its URL. */
export function celexOf(item: Pick<FeedItem, 'documentNumber' | 'url'>): string | null {
  const candidates = [item.documentNumber.replace(/^CELEX:/i, '').trim(), /CELEX(?::|%3A)([0-9A-Z()%]+)/i.exec(item.url ?? '')?.[1] ?? ''];
  for (const c of candidates) {
    let v = c;
    try {
      v = decodeURIComponent(c);
    } catch {
      /* keep as is */
    }
    if (CELEX.test(v)) return v;
  }
  return null;
}

/** The Cellar URL of a CELEX number; brackets must be percent-encoded (32016R0679R%2802%29). */
export const cellarUrl = (celex: string) => `${CELLAR_RESOURCE}${encodeURIComponent(celex).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

async function getOk(f: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  const res = await f(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(60_000) }).catch((err: unknown) => {
    throw new StoreError(`${what} could not be reached: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  if (!res.ok) throw new StoreError(`${what} answered ${res.status}`, res.status === 404 ? 404 : 502);
  return res;
}

async function fetchEurLexText(item: FeedItem, f: typeof fetch): Promise<ActText> {
  const celex = celexOf(item);
  if (!celex) throw new StoreError('this feed item has no CELEX number to look up', 422);
  const res = await getOk(f, cellarUrl(celex), { headers: { Accept: 'application/xhtml+xml;q=0.9, text/html;q=0.8', 'Accept-Language': 'eng' } }, 'EUR-Lex (Cellar)');
  const text = htmlToText(await res.text());
  if (!text) throw new StoreError('EUR-Lex returned no text for this act', 422);
  return { title: item.title, text: clip(text), sourceUrl: item.url ?? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`, format: 'xhtml' };
}

async function fetchFederalRegisterText(item: FeedItem, f: typeof fetch): Promise<ActText> {
  const meta = (await (await getOk(f, `https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(item.documentNumber)}.json`, { headers: { Accept: 'application/json' } }, 'The Federal Register')).json()) as {
    title?: string;
    raw_text_url?: string;
    body_html_url?: string;
    html_url?: string;
  };
  const source = meta.raw_text_url || meta.body_html_url;
  if (!source || !/^https:\/\/([a-z0-9-]+\.)*federalregister\.gov\//i.test(source)) throw new StoreError('the Federal Register has no text for this document yet', 422);
  const text = htmlToText(await (await getOk(f, source, {}, 'The Federal Register')).text());
  if (!text) throw new StoreError('the Federal Register returned no text for this document', 422);
  return { title: meta.title || item.title, text: clip(text), sourceUrl: meta.html_url || item.url || source, format: meta.raw_text_url ? 'text' : 'xhtml' };
}

/** The amended act's text for a feed item, from its official source. */
export async function fetchActText(item: FeedItem, deps: ActTextDeps = {}): Promise<ActText> {
  const f = deps.fetch ?? fetch;
  return item.source === 'EUR_LEX' ? fetchEurLexText(item, f) : fetchFederalRegisterText(item, f);
}

const isPrivateAddress = (ip: string): boolean => {
  const v = ip.toLowerCase();
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(v)) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (mapped) {
      const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
  }
  return false;
};

/** Only public http(s) pages: no localhost, internal names or private addresses. */
export async function assertPublicHttpUrl(raw: string, lookup: ActTextDeps['lookup'] = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError('that is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new StoreError('only http and https URLs can be imported');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const refuse = () => new StoreError('that address is not a public web page', 400);
  const named = !net.isIP(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (named && !host.includes('.'))) throw refuse();
  if (!named) {
    if (isPrivateAddress(host)) throw refuse();
    return url;
  }
  const addresses = await lookup(host).catch(() => [] as string[]);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw refuse();
  return url;
}

/** A bot challenge in Browserbase's answer: WAF/Cloudflare headers, an empty 202/403/429, or next to no content. */
function looksBlocked(r: { statusCode?: number; headers?: Record<string, unknown>; content?: unknown }): boolean {
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const content = typeof r.content === 'string' ? r.content.trim() : '';
  if ('x-amzn-waf-action' in headers || 'cf-mitigated' in headers) return true;
  if ([202, 403, 429].includes(Number(r.statusCode)) && !content) return true;
  return content.length < 200;
}

/** Any public page, through Browserbase Fetch (markdown). Needs BROWSERBASE_API_KEY. */
export async function fetchUrlText(rawUrl: string, deps: ActTextDeps = {}): Promise<ActText> {
  const key = deps.browserbaseKey === undefined ? process.env.BROWSERBASE_API_KEY : deps.browserbaseKey;
  if (!key) throw new StoreError('Import from URL is not set up on this server (BROWSERBASE_API_KEY is missing)', 503);
  const url = await assertPublicHttpUrl(rawUrl, deps.lookup);
  const f = deps.fetch ?? fetch;
  const res = await f(BROWSERBASE_FETCH, {
    method: 'POST',
    headers: { 'X-BB-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.href, format: 'markdown', allowRedirects: true }),
    signal: AbortSignal.timeout(60_000),
  }).catch((err: unknown) => {
    throw new StoreError(`Browserbase could not be reached: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  if (res.status === 401 || res.status === 403) throw new StoreError('Browserbase refused the API key', 502);
  if (!res.ok) throw new StoreError(`Browserbase answered ${res.status}`, 502);
  const body = (await res.json()) as { statusCode?: number; headers?: Record<string, unknown>; content?: unknown };
  if (looksBlocked(body)) throw new StoreError(BLOCKED_MESSAGE, 422);
  const text = clip(String(body.content).replace(/\r\n?/g, '\n').trim());
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || url.hostname;
  return { title: title.slice(0, 200), text, sourceUrl: url.href, format: 'markdown' };
}
