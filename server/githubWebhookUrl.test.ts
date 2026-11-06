import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubApp } from './github/client.js';

/** A GitHub API stand-in for /app/hook/config that records each request. */
function fakeHookConfig(initialUrl: string) {
  let url = initialUrl;
  const requests: Array<{ method: string; path: string; body?: unknown; auth: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', path, body, auth: String((init?.headers as Record<string, string>).Authorization) });
    if (path !== '/app/hook/config') return new Response('{}', { status: 404 });
    if (init?.method === 'PATCH') url = (body as { url: string }).url;
    return new Response(JSON.stringify({ url, content_type: 'json' }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests, current: () => url };
}

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = (fetchImpl: typeof fetch) =>
  new GitHubApp(
    {
      appId: '123',
      slug: 'lexc-test',
      name: 'LexCompiler Test',
      htmlUrl: null,
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      webhookSecret: 's',
      clientId: 'c',
      clientSecret: 'c',
      source: 'file',
    } as never,
    { apiUrl: 'https://api.github.test', webUrl: 'https://github.test' } as never,
    fetchImpl,
    { retryDelaysMs: [] }
  );

describe("the App's webhook URL", () => {
  it('points the webhook at the new tunnel URL, as the app', async () => {
    const gh = fakeHookConfig('https://old-tunnel.trycloudflare.com/api/github/webhooks');
    const previous = await app(gh.fetchImpl).syncWebhookUrl('https://new-tunnel.trycloudflare.com/api/github/webhooks');
    expect(previous).toBe('https://old-tunnel.trycloudflare.com/api/github/webhooks');
    expect(gh.current()).toBe('https://new-tunnel.trycloudflare.com/api/github/webhooks');
    expect(gh.requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
    expect(gh.requests[1].body).toEqual({ url: 'https://new-tunnel.trycloudflare.com/api/github/webhooks' });
    // An app JWT (three base64url parts), not an installation token.
    expect(gh.requests[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('changes nothing when the webhook already points there', async () => {
    const gh = fakeHookConfig('https://same.example.test/api/github/webhooks');
    expect(await app(gh.fetchImpl).syncWebhookUrl('https://same.example.test/api/github/webhooks')).toBeNull();
    expect(gh.requests.map((r) => r.method)).toEqual(['GET']);
  });
});
