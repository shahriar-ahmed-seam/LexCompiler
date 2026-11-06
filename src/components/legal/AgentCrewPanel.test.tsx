// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentCrewPanel } from './AgentCrewPanel';
import { expectNamedControls } from '../../test/a11y';

const BASE = '/api/workspaces/ws-1';
const AGENTS = [
  ['Regulatory horizon scanner', 'CrewAI', 'Read 13 feed items; 1 match the categories of 1 active rule(s).'],
  ['Deontic extractor', 'DSPy', 'Compiled 1 rule(s) to deontic logic, SMT-LIB2 and Rego.'],
  ['Polyglot AST mapper', 'Hermes-style tool calls (Ollama)', "Scanned 6 files; the rules' patterns match 3 location(s)."],
  ['Contextual graph RAG', 'LangGraph', 'Retrieved 4 chunk(s) from 4 source(s) for the rules.'],
  ['Z3 formal critic', 'Pydantic-AI', 'Z3 checked 1 rule(s): 1 UNSAT with unsat cores, 0 not violated.'],
  ['Remediation and PR gate', 'OpenAI Agents SDK', 'Patched 1 file(s) for 1 rule(s); post-patch Z3 SAT_COMPLIANT, so the patch passes the gate. Opened pull request #12.'],
];
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  startedAt: '2026-10-30T07:00:00.000Z',
  gate: 'PATCH_VERIFIED',
  status: 'COMPLETED',
  latencyMs: 10500,
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

function stubApi(runs: unknown[] = []) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const routes: Record<string, unknown> = {
    [`${BASE}/repos`]: [
      { id: 'repo-1', fullName: 'acme/core', source: 'github' },
      { id: 'repo-2', fullName: 'acme/local', source: 'local' },
    ],
    [`${BASE}/crew-runs`]: { runs },
    [`${BASE}/repos/repo-1/crew-runs`]: run('new-run'),
    [`${BASE}/crew-runs/old-run`]: run('old-run', { gate: 'PATCH_BLOCKED', steps: run('x').steps.map((s, i) => (i === 5 ? { ...s, summary: 'Patched 1 file(s); post-patch Z3 UNSAT_VIOLATION, so the gate blocks it.', handoff: {} } : s)) }),
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

describe('AgentCrewPanel', () => {
  it('runs the agents on a GitHub repository, asks for a fix PR when ticked, and shows each step', async () => {
    const calls = stubApi();
    const { container } = render(<AgentCrewPanel base={BASE} canRun />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Open a fix pull request if Z3 proves the patch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the agents on acme/core' }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/repos/repo-1/crew-runs`)).toBe(true));
    expect(calls.find((c) => c.url === `${BASE}/repos/repo-1/crew-runs`)!.body).toEqual({ openPullRequest: true, allRules: false });

    const step1 = await screen.findByRole('listitem', { name: 'Step 1: Regulatory horizon scanner' });
    expect(step1.textContent).toContain('(CrewAI)');
    expect(step1.textContent).toContain('Read 13 feed items');
    expect(screen.getByRole('listitem', { name: 'Step 6: Remediation and PR gate' }).textContent).toContain('post-patch Z3 SAT_COMPLIANT');
    expect(screen.getByRole('link', { name: 'pull request #12' }).getAttribute('href')).toBe('https://github.com/acme/core/pull/12');
    expectNamedControls(container);
  });

  it('offers a pull request only for GitHub repositories', async () => {
    const calls = stubApi();
    render(<AgentCrewPanel base={BASE} canRun />);
    await screen.findByRole('button', { name: 'Run the agents on acme/local' });
    expect(screen.getAllByRole('checkbox', { name: /pull request/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: /Check every rule in effect/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the agents on acme/local' }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/repos/repo-2/crew-runs`)).toBe(true));
    expect(calls.find((c) => c.url === `${BASE}/repos/repo-2/crew-runs`)!.body).toEqual({ openPullRequest: false, allRules: true });
  });

  it('lists recent runs with the gate, and opens one to read its steps', async () => {
    stubApi([{ ...run('old-run', { gate: 'PATCH_BLOCKED' }), steps: undefined }]);
    render(<AgentCrewPanel base={BASE} canRun={false} />);
    const item = await screen.findByRole('listitem', { name: 'Crew run on acme/core at 858dc92' });
    expect(item.textContent).toContain('Patch not proven');
    expect(item.textContent).toContain('10.5 s');
    expect(screen.queryByRole('button', { name: /Run the agents/ })).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Show the steps of the run on acme/core at 858dc92' }));
    expect((await screen.findByRole('listitem', { name: 'Step 6: Remediation and PR gate' })).textContent).toContain('the gate blocks it');
    expect(screen.queryByRole('link', { name: /pull request/ })).toBeNull();
  });

  it("lists the fix agent's suggestions for a run the gate blocked", async () => {
    const blocked = run('blocked-run', { gate: 'PATCH_BLOCKED' });
    (blocked.steps as Array<Record<string, unknown>>)[5] = { ...blocked.steps[5], handoff: { modelFixes: [{ ruleKey: 'R-2', path: 'api/loans.py', startLine: 9, endLine: 9, body: 'R-2 · redact before logging' }] } };
    stubApi([{ ...blocked, steps: undefined }]);
    render(<AgentCrewPanel base={BASE} canRun={false} />);
    const item = await screen.findByRole('listitem', { name: 'Crew run on acme/core at 858dc92' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(blocked), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    fireEvent.click(within(item).getByRole('button', { name: 'Show the steps of the run on acme/core at 858dc92' }));
    const region = await screen.findByRole('region', { name: 'Fix agent suggestions' });
    expect(region.textContent).toContain('nothing was committed');
    expect(region.textContent).toContain('R-2 at api/loans.py:9');
  });

  it('shows why a run was refused', async () => {
    stubApi();
    render(<AgentCrewPanel base={BASE} canRun />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run the agents on acme/local' }));
    // repo-2's run isn't mocked, so the API answers 404 with this error.
    expect((await screen.findByRole('alert')).textContent).toBe('not mocked');
  });
});
