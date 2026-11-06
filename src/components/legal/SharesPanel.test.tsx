// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharesPanel } from './SharesPanel';
import { expectNamedControls } from '../../test/a11y';

const BASE = '/api/workspaces/ws-1';
const share = { id: 'sh-1', label: 'Q4 audit', counterpartyName: 'Klinikum Spree', ruleIds: ['r1'], periodFrom: '2026-10-01T00:00:00.000Z', periodTo: '2026-10-31T23:59:59.999Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, views: 1 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SharesPanel', () => {
  it('creates a link for the chosen rules, shows the views, and revokes', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const json =
          url === `${BASE}/shares` && init?.method === 'POST'
            ? { ...share, token: 'lexc_share_x', url: 'http://lexc.test/share/lexc_share_x' }
            : url === `${BASE}/shares`
              ? [share]
              : url.endsWith('/views')
                ? [{ at: '2026-10-20T08:00:00.000Z', ip: '203.0.113.9', userAgent: 'Firefox' }]
                : { ...share, revokedAt: '2026-10-21T00:00:00Z' };
        return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
      })
    );
    const { container } = render(
      <SharesPanel
        base={BASE}
        rules={[
          { id: 'r1', key: 'R-1', title: 'Retention', versions: [{ status: 'approved' }] },
          { id: 'r2', key: 'R-2', title: 'Draft only', versions: [{ status: 'draft' }] },
        ]}
        counterparties={[{ id: 'cp-1', name: 'Klinikum Spree' }]}
      />
    );
    const item = await screen.findByRole('listitem', { name: 'Share Q4 audit' });
    expect(within(item).getByText(/1 view/)).toBeTruthy();
    // Only approved rules can be shared.
    expect(screen.queryByRole('checkbox', { name: /R-2/ })).toBeNull();

    const create = screen.getByRole('button', { name: 'Create share link' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'R-1 Retention' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Counterparty' }), { target: { value: 'cp-1' } });
    fireEvent.click(create);
    expect(((await screen.findByRole('textbox', { name: 'Share link' })) as HTMLInputElement).value).toBe('http://lexc.test/share/lexc_share_x');
    const posted = calls.find((c) => c.url === `${BASE}/shares` && c.body)!.body as Record<string, unknown>;
    expect(posted).toMatchObject({ ruleIds: ['r1'], counterpartyId: 'cp-1' });
    expect(String(posted.periodFrom)).toMatch(/T00:00:00.000Z$/);
    expectNamedControls(container);

    fireEvent.click(within(item).getByRole('button', { name: 'Views of Q4 audit' }));
    expect((await screen.findByRole('list', { name: 'Views of Q4 audit' })).textContent).toContain('203.0.113.9 · Firefox');
    fireEvent.click(within(item).getByRole('button', { name: 'Revoke Q4 audit' }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/shares/sh-1/revoke`)).toBe(true));
    expect((await screen.findByRole('status')).textContent).toContain('Link revoked');
  });
});
