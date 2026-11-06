// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegalWorkspace } from './LegalWorkspace';
import { expectNamedControls } from '../../test/a11y';
import { mockFetch } from '../../test/fixtures';

const WS = 'ws-1';
const TEXT = '4.2 Retention. All personal data must be encrypted at rest with tenant-isolated keys and purged within 72 hours.';
const at = (s: string) => TEXT.indexOf(s);
const routes = {
  '/api/workspaces': [{ id: WS, name: 'FinHealth AI', role: 'legal' }],
  '/api/rule-categories': [
    { id: 'RETENTION_AND_TENANT_KMS', label: 'Retention and tenant keys' },
    { id: 'PII_LOGGING_BAN', label: 'No personal data in logs' },
  ],
  [`/api/workspaces/${WS}/documents`]: [{ id: 'doc-1', title: 'Klinikum Spree DPA', kind: 'contract', fileFormat: 'pdf', uploadedAt: '2026-11-10T09:00:00Z' }],
  [`/api/workspaces/${WS}/counterparties`]: [{ id: 'cp-1', name: 'Klinikum Spree' }],
  [`/api/workspaces/${WS}/shares`]: [],
  [`/api/workspaces/${WS}/coming-up`]: { upcoming: [], results: [] },
  [`/api/workspaces/${WS}/feed`]: [],
  [`/api/workspaces/${WS}/repos`]: [],
  [`/api/workspaces/${WS}/rules`]: [
    { id: 'r1', key: 'R-1', title: 'Retention and tenant keys', versions: [{ id: 'v1', version: 1, status: 'draft', approvedBy: null, approvedAt: null, effectiveFrom: null, createdAt: '2026-11-10T09:00:00Z' }] },
  ],
  [`/api/workspaces/${WS}/documents/doc-1`]: {
    clauses: [
      { index: 0, number: '1', text: '1. Definitions. Terms have their GDPR meaning.', normative: false, normativeMatches: [] },
      { index: 1, number: '4.2', text: TEXT, normative: true, normativeMatches: [{ start: at('must'), end: at('must') + 4, text: 'must' }] },
    ],
  },
  [`/api/workspaces/${WS}/rule-card`]: {
    category: 'RETENTION_AND_TENANT_KMS',
    categoryLabel: 'Retention and tenant keys',
    categoryFromWording: true,
    plainReading: 'Personal data must be deleted within 72 hours, and stored encrypted with a key that belongs to one tenant only.',
    highlights: [
      { start: at('must'), end: at('must') + 4, text: 'must', kind: 'normative' },
      { start: at('tenant-isolated keys'), end: at('tenant-isolated keys') + 20, text: 'tenant-isolated keys', kind: 'keyword' },
      { start: at('72 hours'), end: at('72 hours') + 8, text: '72 hours', kind: 'value' },
    ],
    values: [
      { field: 'maxRetentionHours', label: 'Delete within (hours)', value: 72, source: 'parser', question: null },
      { field: 'requiresTenantIsolatedKeys', label: 'Tenant-isolated keys', value: true, source: 'parser', question: null },
    ],
    questions: [{ id: 'clock-start', text: 'When does the retention clock start: at upload, or when processing ends?' }],
    ai: null,
    aiNote: null,
    compiled: { smtLib2: '(assert (<= retention_hours 72))', rego: 'deny[msg] { true }' },
    impact: [{ repoId: 'repo-1', repoName: 'acme/core-platform', failures: 3, places: [{ filePath: 'schema/postgres_pii.sql', line: 4 }, { filePath: 'workers/redis_cache_worker.py', line: 8 }, { filePath: 'api/fastapi_intake.py', line: 20 }] }],
  },
  [`/api/workspaces/${WS}/rule-versions/v1/approve`]: { id: 'v1', version: 1, status: 'approved', queuedScans: [{ repoId: 'repo-1', jobId: 'j1' }] },
  [`/api/workspaces/${WS}/inbox`]: {
    exceptionRequests: [
      {
        id: 'ex-1',
        ruleKey: 'R-1',
        repoName: 'acme/core-platform',
        filePath: 'api/loan_applications.py',
        startLine: 20,
        pathGlob: null,
        message: 'create_application logs national_id without redaction',
        reason: 'Requested from GitHub by @tanvir on pull request #1',
        requestedBy: 'github:tanvir',
        requestedFrom: 'github',
        prNumber: 1,
      },
    ],
    ruleDrafts: [{ versionId: 'v1', ruleKey: 'R-1', version: 1 }],
  },
  [`/api/workspaces/${WS}/exceptions/ex-1/approve`]: { id: 'ex-1', status: 'approved', rerunJobId: 'job-7' },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("lawyer's workspace", () => {
  it('opens a document, shows skipped clauses, and builds the card for §4.2 with highlights and impact', async () => {
    const fetchMock = mockFetch(routes);
    render(<LegalWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /Klinikum Spree DPA/ }));
    expect(await screen.findByRole('button', { name: 'Clause 1 (not normative, skipped)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clause 4.2' }));

    const card = await screen.findByRole('article', { name: 'Rule card' });
    const marks = [...card.querySelectorAll('mark')].map((m) => [m.textContent, m.getAttribute('data-kind')]);
    expect(marks).toEqual([
      ['must', 'normative'],
      ['tenant-isolated keys', 'keyword'],
      ['72 hours', 'value'],
    ]);
    expect((within(card).getByRole('combobox', { name: 'Category' }) as HTMLSelectElement).value).toBe('RETENTION_AND_TENANT_KMS');
    expect((within(card).getByRole('spinbutton', { name: /Delete within \(hours\)/ }) as HTMLInputElement).value).toBe('72');
    expect(within(card).getByText('When does the retention clock start: at upload, or when processing ends?')).toBeTruthy();
    expect(within(card).getByRole('status', { name: 'Impact preview' }).textContent).toContain('3 places would fail');
    const preview = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) => String(u).endsWith('/rule-card'));
    expect(JSON.parse(String(preview![1].body))).toMatchObject({ text: TEXT, scope: { all: true } });
  });

  it('approves a draft and says how many repositories are rescanned', async () => {
    const fetchMock = mockFetch(routes);
    render(<LegalWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve R-1 v1' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${WS}/rule-versions/v1/approve`, expect.objectContaining({ method: 'POST' })));
    expect((await screen.findByText(/queued for a scan of main/)).textContent).toBe('Approved. 1 repository queued for a scan of main.');
  });

  it('approves an exception from the inbox with a reason and an end date', async () => {
    const fetchMock = mockFetch(routes);
    render(<LegalWorkspace />);
    const request = await screen.findByRole('listitem', { name: 'Exception request for R-1 at api/loan_applications.py:20' });
    expect(within(request).getByText(/@tanvir on GitHub/)).toBeTruthy();
    const approve = within(request).getByRole('button', { name: 'Approve exception' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(within(request).getByRole('textbox', { name: 'Reason for the decision' }), { target: { value: 'Endpoint does not store PII; storage is added in LN-12' } });
    fireEvent.change(within(request).getByLabelText('Waived until'), { target: { value: '2026-11-30' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${WS}/exceptions/ex-1/approve`, expect.anything()));
    const call = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) => u.endsWith('/exceptions/ex-1/approve'))!;
    expect(JSON.parse(String(call[1].body))).toEqual({ note: 'Endpoint does not store PII; storage is added in LN-12', expiresAt: '2026-11-30T23:59:59.000Z' });
    expect((await screen.findByText(/Exception approved/)).textContent).toBe('Exception approved. The pull request check runs again.');
  });

  it('names every control', async () => {
    mockFetch(routes);
    const { container } = render(<LegalWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /Klinikum Spree DPA/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clause 4.2' }));
    await screen.findByRole('article', { name: 'Rule card' });
    expectNamedControls(container);
  });
});
