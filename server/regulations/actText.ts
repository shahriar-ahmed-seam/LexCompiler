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

/** Over-length text is refused, never cut: a document that silently ends half-way would be compiled as the whole act. */
function limit(text: string): string {
  if (text.length > MAX_ACT_TEXT) {
    throw new StoreError(`the text is longer than ${MAX_ACT_TEXT.toLocaleString('en-US')} characters, so it was not stored; download the part you need and upload it instead`, 413);
  }
  return text;
}

/** The act's own title from EUR-Lex XHTML: the consecutive "oj-doc-ti" paragraphs of its heading ("REGULATION (EU) ... amending ..."). */
export function eurLexTitle(html: string): string | null {
  const re = /<p\b[^>]*\bclass="[^"]*\boj-doc-ti\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  const parts: string[] = [];
  let end = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (parts.length > 0 && html.slice(end, m.index).trim() !== '') break;
    const t = htmlToText(m[1]).replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
    end = m.index + m[0].length;
  }
  return parts.join(' ').slice(0, 200).trim() || null;
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

async function getOk(f: typeof fetch, url: string, init: RequestInit, what: string, explain?: (status: number) => StoreError | undefined): Promise<Response> {
  const res = await f(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(60_000) }).catch((err: unknown) => {
    throw new StoreError(`${what} could not be reached: ${err instanceof Error ? err.message : String(err)}`, 502);
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw explain?.(res.status) ?? new StoreError(`${what} answered ${res.status}`, res.status === 404 ? 404 : 502);
  }
  return res;
}

async function fetchEurLexText(item: FeedItem, f: typeof fetch): Promise<ActText> {
  const celex = celexOf(item);
  if (!celex) throw new StoreError('this feed item has no CELEX number to look up', 422);
  // Cellar answers 404 or 406 when it holds no machine-readable text for the act (some corrigenda are published only as PDF).
  const noText = (status: number) =>
    status === 404 || status === 406
      ? new StoreError(`EUR-Lex publishes no machine-readable text for ${celex} (Cellar answered ${status}); download it from EUR-Lex and upload it instead`, 422)
      : undefined;
  const res = await getOk(f, cellarUrl(celex), { headers: { Accept: 'application/xhtml+xml;q=0.9, text/html;q=0.8', 'Accept-Language': 'eng' } }, 'EUR-Lex (Cellar)', noText);
  const html = await res.text();
  const text = htmlToText(html);
  if (!text) throw new StoreError('EUR-Lex returned no text for this act', 422);
  return { title: eurLexTitle(html) ?? item.title, text: limit(text), sourceUrl: item.url ?? `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`, format: 'xhtml' };
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
  return { title: meta.title || item.title, text: limit(text), sourceUrl: meta.html_url || item.url || source, format: meta.raw_text_url ? 'text' : 'xhtml' };
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
    const b = ipv6Bytes(v);
    if (!b) return true;
    const v4 = (i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4(12)); // ::ffff:a.b.c.d
    if (zero(0, 12)) return true; // ::, ::1 and IPv4-compatible ::a.b.c.d
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateAddress(v4(12)); // NAT64 64:ff9b::/96
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4(2)); // 6to4 2002::/16
    // unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
    return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) || b[0] === 0xff;
  }
  return false;
};

/** The 16 bytes of a valid IPv6 literal (with "::" and a dotted IPv4 tail expanded), or null. */
function ipv6Bytes(literal: string): number[] | null {
  let s = literal.split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, s.length - dotted[0].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes.length === 16 ? bytes : null;
}

/** Only public http(s) pages: no localhost, internal names or private addresses. */
export async function assertPublicHttpUrl(raw: string, lookup: ActTextDeps['lookup'] = async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StoreError('that is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new StoreError('only http and https URLs can be imported');
  if (url.username || url.password) throw new StoreError('the URL must not contain a user name or password');
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

/** Wording of bot-check and "access denied" pages. */
const CHALLENGE = /just a moment|verify (?:that )?you are (?:a )?human|are you a robot|checking your browser|access denied|attention required|captcha|enable javascript and cookies|unusual traffic|request blocked|pardon our interruption/i;

/**
 * What the target answered, as an error, or null when it is a page worth importing. A bot check
 * (WAF/Cloudflare headers, 202/403/429/503, or challenge wording on a short page) is reported
 * as blocked; any other non-2xx answer is an error page, not a document. Nothing is retried or worked around.
 */
function pageProblem(r: { statusCode?: number; headers?: Record<string, unknown>; content?: unknown }): StoreError | null {
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const content = typeof r.content === 'string' ? r.content.trim() : '';
  const blocked = () => new StoreError(BLOCKED_MESSAGE, 422);
  if ('x-amzn-waf-action' in headers || 'cf-mitigated' in headers) return blocked();
  const status = Number(r.statusCode);
  if ([202, 403, 429, 503].includes(status)) return blocked();
  if (Number.isFinite(status) && status > 0 && (status < 200 || status >= 300)) {
    return new StoreError(`that page answered HTTP ${status}, so it was not imported`, status >= 500 ? 502 : 422);
  }
  if (content.length < 3000 && CHALLENGE.test(content)) return blocked();
  if (content.length < 200) return new StoreError('that page has almost no text, so it was not imported', 422);
  return null;
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
  const problem = pageProblem(body);
  if (problem) throw problem;
  const text = limit(String(body.content).replace(/\r\n?/g, '\n').trim());
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || url.hostname;
  return { title: title.slice(0, 200), text, sourceUrl: url.href, format: 'markdown' };
}
