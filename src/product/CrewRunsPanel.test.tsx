// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrewRunsPanel } from './CrewRunsPanel';

const BASE = '/api/workspaces/ws-1';
const AGENTS: Array<[string, string, string]> = [
  ['Regulatory horizon scanner', 'CrewAI', 'Read 13 feed items; 1 match the categories of 1 active rule(s).'],
  ['Deontic extractor', 'DSPy', 'Compiled 1 rule(s) to deontic logic, SMT-LIB2 and Rego.'],
  ['Polyglot AST mapper', 'Hermes-style tool calls (Ollama)', "Scanned 6 files; the rules' patterns match 3 location(s)."],
  ['Contextual graph RAG', 'LangGraph', 'Retrieved 4 chunk(s) from 4 source(s) for the rules.'],
  ['Z3 formal critic', 'Pydantic-AI', 'Z3 checked 1 rule(s): 1 UNSAT with unsat cores, 0 not violated.'],
  ['Remediation and PR gate', 'OpenAI Agents SDK', 'Patched 1 file(s); post-patch Z3 SAT_COMPLIANT, so the patch passes the gate. Opened pull request #12.'],
];
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  startedAt: '2026-10-30T07:00:00.000Z',
  finishedAt: '2026-10-30T07:00:10.500Z',
  gate: 'PATCH_VERIFIED',
  status: 'COMPLETED',
  latencyMs: 10500,
  totalTokens: 38863,
  triggeredBy: 'nusrat@finhealth.example',
  target: { repoFullName: 'acme/core', commitSha: '858dc92cdeb63' },
  steps: AGENTS.map(([agentName, pythonAdapter, summary], i) => ({
    stepNumber: i + 1,
    agentName,
    pythonAdapter,
    summary,
    status: 'COMPLETED',
    handoff: i === 5 ? { pullRequest: { created: true, prNumber: 12, url: 'https://github.com/acme/core/pull/12' } } : {},
  })),
  ...extra,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const json = routes[url];
      return new Response(JSON.stringify(json ?? { error: 'not mocked' }), { status: json === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
  return calls;
}

describe('CrewRunsPanel', () => {
  it('lists recent runs with the gate badge, target and duration', async () => {
    stubApi({ [`${BASE}/crew-runs`]: { runs: [{ ...run('r1', { gate: 'PATCH_BLOCKED' }), steps: undefined }] } });
    render(<CrewRunsPanel workspaceId="ws-1" />);
    const row = (await screen.findByText('Patch not proven')).closest('tr')!;
    expect(row.textContent).toContain('acme/core');
    expect(row.textContent).toContain('858dc92');
    expect(row.textContent).toContain('10.5 s');
    expect(row.textContent).toContain('38863');
    expect(row.textContent).toContain('nusrat@finhealth.example');
  });

  it('fetches a run on demand and shows its steps and pull request', async () => {
    const calls = stubApi({
      [`${BASE}/crew-runs`]: { runs: [{ ...run('r1'), steps: undefined }] },
      [`${BASE}/crew-runs/r1`]: run('r1'),
    });
    render(<CrewRunsPanel workspaceId="ws-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show steps' }));
    await waitFor(() => expect(calls).toContain(`${BASE}/crew-runs/r1`));
    const step1 = await screen.findByRole('listitem', { name: 'Step 1: Regulatory horizon scanner' });
    expect(step1.textContent).toContain('(CrewAI)');
    expect(screen.getByRole('listitem', { name: 'Step 6: Remediation and PR gate' }).textContent).toContain('post-patch Z3 SAT_COMPLIANT');
    expect(screen.getByRole('link', { name: 'pull request #12' }).getAttribute('href')).toBe('https://github.com/acme/core/pull/12');
  });

  it('shows why a blocked run opened no pull request, with the fix agent suggestions', async () => {
    const blocked = run('blocked', { gate: 'PATCH_BLOCKED' });
    (blocked.steps as Array<Record<string, unknown>>)[5] = {
      ...blocked.steps[5],
      summary: 'Patched 1 file(s); post-patch Z3 UNSAT_VIOLATION, so the gate blocks it.',
      handoff: { pullRequestError: 'R-1 is not proven after the patch', modelFixes: [{ ruleKey: 'R-2', path: 'api/loans.py', startLine: 9, endLine: 9, body: 'logger.info(redact_pii(user.ssn))' }] },
    };
    stubApi({
      [`${BASE}/crew-runs`]: { runs: [{ ...blocked, steps: undefined }] },
      [`${BASE}/crew-runs/blocked`]: blocked,
    });
    render(<CrewRunsPanel workspaceId="ws-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show steps' }));
    const region = await screen.findByRole('region', { name: 'Fix agent suggestions' });
    expect(region.textContent).toContain('nothing was committed');
    expect(region.textContent).toContain('R-2 at api/loans.py:9');
    expect(screen.getByText(/No pull request: R-1 is not proven/)).toBeTruthy();
  });

  it('shows an empty state and a Failed badge', async () => {
    stubApi({
      [`${BASE}/crew-runs`]: {
        runs: [{ ...run('bad', { status: 'FAILED', gate: 'INCOMPLETE', steps: undefined }) }],
      },
    });
    render(<CrewRunsPanel workspaceId="ws-1" />);
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(screen.queryByText('A step failed')).toBeNull();
  });

  it('shows the empty state when there are no runs', async () => {
    stubApi({ [`${BASE}/crew-runs`]: { runs: [] } });
    render(<CrewRunsPanel workspaceId="ws-1" />);
    expect(await screen.findByText('No agent runs yet')).toBeTruthy();
  });
});
