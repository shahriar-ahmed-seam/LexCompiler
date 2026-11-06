// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangesPanel } from './ChangesPanel';
import { EffectiveDateControl, RescopeControl } from './RuleControls';
import { expectNamedControls } from '../../test/a11y';

const BASE = '/api/workspaces/ws-1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const routes: Record<string, unknown> = {
    [`${BASE}/coming-up`]: {
      upcoming: [],
      results: [
        {
          repoName: 'acme/core-platform',
          versionId: 'v2',
          ruleKey: 'R-3',
          version: 2,
          effectiveFrom: '2027-01-01T00:00:00.000Z',
          commitSha: 'abc',
          computedAt: '2026-12-01T00:00:00Z',
          findings: [{ filePath: 'services/ai_credit_triage.ts', startLine: 20, message: 'threshold 0.85 is below 0.92' }],
        },
      ],
    },
    [`${BASE}/feed`]: [
      { id: 'FEDERAL_REGISTER:2026-21001', source: 'FEDERAL_REGISTER', documentNumber: '2026-21001', title: 'Health data retention', publicationDate: '2026-10-28', excerpt: 'Must purge within 24 hours.', url: 'https://www.federalregister.gov/d/2026-21001', kind: 'TEXT', illustrative: false, documentId: null, watch: { affectedRuleKeys: ['R-1'], summary: 'Health data must be purged within 24 hours.', model: 'deepseek-chat' } },
      { id: 'EUR_LEX:32026R0999', source: 'EUR_LEX', documentNumber: '32026R0999', title: 'Corrigendum', publicationDate: '2026-10-27', excerpt: 'Amends Article 14.', url: null, kind: 'CHANGE_NOTICE', illustrative: false, documentId: null },
    ],
    [`${BASE}/repos`]: [{ id: 'repo-1', fullName: 'acme/core-platform', source: 'github' }],
    [`${BASE}/repos/repo-1/fix-pr`]: { created: true, prNumber: 101, url: 'https://github.com/acme/core-platform/pull/101', files: ['api/fastapi_intake.py'] },
    [`${BASE}/counterparties`]: [{ id: 'cp-1', name: 'Nodi Microfinance', scope: [{ repoId: 'repo-1', pathGlob: 'workers/**' }] }],
    [`${BASE}/feed/FEDERAL_REGISTER%3A2026-21001/draft`]: { rule: { key: 'R-5' }, version: { version: 1 } },
    [`${BASE}/counterparties/cp-1/scope`]: { id: 'cp-1', name: 'Nodi Microfinance', scope: [] },
    [`${BASE}/feed/watch`]: { noted: 1, summarized: 0, refused: 'ai_off', errors: [] },
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = routes[url];
      return new Response(JSON.stringify(json ?? { error: 'not mocked' }), { status: json === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
  return calls;
}

describe('ChangesPanel', () => {
  it('lists what a future version will find, drafts a rule change from the feed, and saves counterparty paths', async () => {
    const calls = stubApi();
    const onChanged = vi.fn(async () => undefined);
    const { container } = render(<ChangesPanel base={BASE} canEdit onChanged={onChanged} />);
    const coming = await screen.findByRole('article', { name: 'R-3 v2 coming up' });
    expect(coming.textContent).toContain('takes effect on 1 January 2027');
    expect(coming.textContent).toContain('services/ai_credit_triage.ts:20');

    // A change notice has nothing to compile; a text item can be drafted.
    const notice = screen.getByRole('listitem', { name: 'Feed item 32026R0999' });
    expect(within(notice).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Draft rule change from 2026-21001' }));
    expect((await screen.findByRole('status')).textContent).toContain('R-5 v1 drafted from 2026-21001. Nothing takes effect until it is approved.');
    expect(onChanged).toHaveBeenCalled();

    const paths = screen.getByRole('textbox', { name: "Paths that handle Nodi Microfinance's data" }) as HTMLTextAreaElement;
    expect(paths.value).toBe('acme/core-platform: workers/**');
    fireEvent.change(paths, { target: { value: 'acme/core-platform: api/loan_*\nacme/core-platform: workers/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save paths for Nodi Microfinance' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/counterparties/cp-1/scope'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/scope'))!.body).toEqual({
      scope: [
        { repoId: 'repo-1', pathGlob: 'api/loan_*' },
        { repoId: 'repo-1', pathGlob: 'workers/**' },
      ],
    });
    expectNamedControls(container);
  });

  it('refuses a path line for a repository the workspace does not have', async () => {
    stubApi();
    render(<ChangesPanel base={BASE} canEdit onChanged={async () => undefined} />);
    const paths = (await screen.findByRole('textbox', { name: "Paths that handle Nodi Microfinance's data" })) as HTMLTextAreaElement;
    fireEvent.change(paths, { target: { value: 'other/repo: **' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save paths for Nodi Microfinance' }));
    expect(screen.getByText(/write "repository: path glob"/)).toBeTruthy();
  });
});

describe('Regulation watch', () => {
  it('shows the summary and the rules an item may affect, and runs the watch for Legal', async () => {
    const calls = stubApi();
    render(<ChangesPanel base={BASE} canEdit onChanged={async () => undefined} />);
    const item = await screen.findByRole('listitem', { name: 'Feed item 2026-21001' });
    expect(item.textContent).toContain('Regulation watch: Health data must be purged within 24 hours.');
    expect(item.textContent).toContain('May affect R-1.');
    fireEvent.click(screen.getByRole('button', { name: 'Run regulation watch' }));
    expect((await screen.findByRole('status')).textContent).toBe('Regulation watch checked 1 new item and summarized 0. AI is off for this workspace, so no summaries were written.');
    expect(calls.some((c) => c.url === `${BASE}/feed/watch`)).toBe(true);
  });

  it('is not offered to roles that cannot edit rules', async () => {
    stubApi();
    render(<ChangesPanel base={BASE} canEdit={false} onChanged={async () => undefined} />);
    await screen.findByRole('listitem', { name: 'Feed item 2026-21001' });
    expect(screen.queryByRole('button', { name: 'Run regulation watch' })).toBeNull();
  });
});

describe('Open fix PR', () => {
  it('opens a fix pull request for a GitHub repository and links it', async () => {
    const calls = stubApi();
    render(<ChangesPanel base={BASE} canEdit={false} canOpenFixes onChanged={async () => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open fix PR for acme/core-platform' }));
    expect((await screen.findByRole('link', { name: 'pull request #101' })).getAttribute('href')).toBe('https://github.com/acme/core-platform/pull/101');
    expect(calls.some((c) => c.url === `${BASE}/repos/repo-1/fix-pr`)).toBe(true);
  });

  it('is hidden for roles that cannot run scans', async () => {
    stubApi();
    render(<ChangesPanel base={BASE} canEdit={false} onChanged={async () => undefined} />);
    await screen.findByRole('article', { name: 'R-3 v2 coming up' });
    expect(screen.queryByRole('button', { name: /Open fix PR/ })).toBeNull();
  });
});

describe('RuleControls', () => {
  it('moves an effective date and drafts a new scope', () => {
    const onMove = vi.fn();
    const onRescope = vi.fn();
    render(
      <>
        <EffectiveDateControl ruleKey="R-3" version={2} effectiveFrom="2027-01-01T00:00:00.000Z" busy={false} onMove={onMove} />
        <RescopeControl ruleKey="R-1" counterparties={[{ id: 'cp-1', name: 'Klinikum Spree' }]} busy={false} onRescope={onRescope} />
      </>
    );
    fireEvent.change(screen.getByLabelText('New effective date for R-3 v2'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move date of R-3 v2' }));
    expect(onMove).toHaveBeenCalledWith('2026-12-01T00:00:00.000Z');
    fireEvent.click(screen.getByRole('button', { name: 'Change scope of R-1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Klinikum Spree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft R-1 for these counterparties' }));
    expect(onRescope).toHaveBeenCalledWith({ counterpartyIds: ['cp-1'] });
  });
});
