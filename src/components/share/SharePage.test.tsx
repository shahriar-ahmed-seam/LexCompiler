// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharePage } from './SharePage';
import { expectNamedControls } from '../../test/a11y';
import { mockFetch } from '../../test/fixtures';

const TOKEN = 'lexc_share_abc';
const view = {
  workspace: { id: 'ws-1', name: 'FinHealth AI' },
  label: 'Q4 audit',
  counterparty: 'Klinikum Spree',
  period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' },
  expiresAt: '2026-11-06T00:00:00.000Z',
  repos: ['acme/core-platform'],
  rules: [
    {
      key: 'R-1',
      title: 'Retention and tenant keys',
      versions: [{ version: 1, status: 'approved', text: '4.2 Retention. Personal data must be purged within 72 hours.', citation: 'Klinikum DPA §4.2', clauseSha256: 'c'.repeat(64), approvedBy: 'Nusrat', approvedAt: '2026-10-10T09:00:00Z', effectiveFrom: null }],
    },
  ],
  scans: [
    { id: 's1', at: '2026-10-12T10:00:00Z', repo: 'acme/core-platform', commit: 'a'.repeat(40), pullRequest: 1, conclusion: 'failure', perRule: [{ ruleKey: 'R-1', newCount: 1, existingCount: 0, waivedCount: 0 }], evidence: { seq: 4, headerSha256: 'd'.repeat(64) } },
  ],
  openFindings: [],
  exceptions: [{ id: 'e1', ruleKey: 'R-1', repo: 'acme/core-platform', where: 'api/loan_applications.py:20', reason: 'Behind a flag', status: 'approved', decidedBy: 'Nusrat', decidedAt: '2026-10-13T00:00:00Z', decisionNote: 'Until LN-12', expiresAt: '2026-11-30T00:00:00Z' }],
  evidence: { headers: [], bodySeqs: [] },
  keysUrl: 'http://lexc.test/.well-known/lexcompiler/ws-1/keys.json',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SharePage', () => {
  it('shows the rule history, checks and exceptions without signing in, and offers the pack', async () => {
    mockFetch({ [`/api/share/${TOKEN}`]: view });
    const { container } = render(<SharePage token={TOKEN} />);
    const history = await screen.findByRole('article', { name: 'R-1 history' });
    expect(within(history).getByText(/approved by Nusrat on 2026-10-10/)).toBeTruthy();
    expect(screen.getByText(/Shared with Klinikum Spree/)).toBeTruthy();
    expect(screen.getByRole('cell', { name: /#4 dddddddd/ })).toBeTruthy();
    expect(screen.getByText(/Decided by Nusrat on 2026-10-13: Until LN-12/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download the evidence pack/ }).getAttribute('href')).toBe(`/api/share/${TOKEN}/pack.zip`);
    expectNamedControls(container);
  });

  it('says so when the link was revoked or expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This link is not valid: it was revoked, it expired, or it is wrong.' }), { status: 404 })));
    render(<SharePage token="lexc_share_gone" />);
    expect((await screen.findByRole('alert')).textContent).toContain('not valid');
  });
});
