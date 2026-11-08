// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhooksPanel } from './WebhooksPanel';

const BASE = '/api/workspaces/ws-1';
const EVENTS = ['scan.completed', 'regulation.watch', 'exception.requested', 'exception.decided'];
const configured = {
  configured: true,
  url: 'https://n8n.example.com/webhook/lex',
  events: EVENTS.slice(0, 2),
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  availableEvents: EVENTS,
};
const delivery = {
  id: 'd1',
  eventType: 'scan.completed',
  status: 'delivered',
  attempts: 1,
  responseStatus: 200,
  error: null,
  createdAt: '2026-11-05T08:00:00.000Z',
  deliveredAt: '2026-11-05T08:00:02.000Z',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = routes[`${method} ${url}`] ?? routes[url];
      return new Response(JSON.stringify(json ?? { error: 'not mocked' }), { status: json === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
  return calls;
}

const OWNER = { id: 'ws-1', role: 'owner' as const };
const VIEWER = { id: 'ws-1', role: 'viewer' as const };

describe('WebhooksPanel', () => {
  it('shows the configured endpoint, subscribed events and deliveries to the owner', async () => {
    stubApi({ [`${BASE}/webhook`]: configured, [`${BASE}/webhook/deliveries`]: [delivery] });
    render(<WebhooksPanel workspace={OWNER} />);
    const urlInput = (await screen.findByLabelText('Endpoint URL')) as HTMLInputElement;
    await waitFor(() => expect(urlInput.value).toBe(configured.url));
    expect(screen.getByText('regulation.watch').closest('label')!.className).toContain('indigo');
    expect(screen.getByText('exception.decided').closest('label')!.className).not.toContain('indigo');
    const row = (await screen.findByText('delivered')).closest('tr')!;
    expect(row.textContent).toContain('scan.completed');
    expect(row.textContent).toContain('200');
  });

  it('creates the webhook and shows the signing secret once', async () => {
    const calls = stubApi({
      [`${BASE}/webhook`]: { configured: false, availableEvents: EVENTS },
      [`${BASE}/webhook/deliveries`]: [],
      [`PUT ${BASE}/webhook`]: { configured: true, secret: 'whsec_once' },
    });
    render(<WebhooksPanel workspace={OWNER} />);
    const input = (await screen.findByLabelText('Endpoint URL')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(''));
    fireEvent.change(input, { target: { value: 'https://n8n.example.com/hook' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'exception.decided' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === `${BASE}/webhook`)).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ url: 'https://n8n.example.com/hook', events: EVENTS.slice(0, 3) });
    expect(await screen.findByText(/whsec_once/)).toBeTruthy();
  });

  it('sends a test event and rotates the secret', async () => {
    const calls = stubApi({
      [`${BASE}/webhook`]: configured,
      [`${BASE}/webhook/deliveries`]: [delivery],
      [`POST ${BASE}/webhook/test`]: { ...delivery, id: 'd2', eventType: 'webhook.test' },
      [`PUT ${BASE}/webhook`]: { configured: true, secret: 'whsec_rotated' },
    });
    render(<WebhooksPanel workspace={OWNER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test event' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/webhook/test`)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ url: configured.url, events: configured.events, rotateSecret: true });
    expect(await screen.findByText(/whsec_rotated/)).toBeTruthy();
  });

  it('removes the webhook after confirmation', async () => {
    const calls = stubApi({
      [`${BASE}/webhook`]: configured,
      [`${BASE}/webhook/deliveries`]: [],
      [`DELETE ${BASE}/webhook`]: { deleted: true },
    });
    render(<WebhooksPanel workspace={OWNER} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove webhook' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `${BASE}/webhook`)).toBe(true));
  });

  it('hides management from members who are not the owner', async () => {
    stubApi({});
    render(<WebhooksPanel workspace={VIEWER} />);
    expect(await screen.findByText(/Only the workspace owner/)).toBeTruthy();
    expect(screen.queryByLabelText('Endpoint URL')).toBeNull();
  });
});
