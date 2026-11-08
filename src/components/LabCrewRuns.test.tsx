// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LabCrewRuns } from './LabCrewRuns';
import { expectNamedControls } from '../test/a11y';
import { mockFetch } from '../test/fixtures';

const RUN = {
  id: 'run-1',
  source: 'server',
  startedAt: '2026-11-08T12:00:00.000Z',
  finishedAt: '2026-11-08T12:00:04.000Z',
  status: 'COMPLETED',
  gate: 'PATCH_VERIFIED',
  useModels: false,
  totalTokens: 1240,
  latencyMs: 4200,
  triggeredBy: 'arif',
  stepStatuses: ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED'],
  steps: [
    { stepNumber: 1, agentName: 'Regulatory horizon scanner', pythonAdapter: 'CrewAI', summary: 'Picked 2 feed items', status: 'COMPLETED' },
    { stepNumber: 2, agentName: 'Deontic extractor', pythonAdapter: 'DSPy', summary: 'Compiled 4 clauses', status: 'COMPLETED' },
  ],
};

afterEach(() => {
  cleanup();
});

describe('lab crew runs', () => {
  it('lists the stored runs and expands one to show its steps', async () => {
    const fetchMock = mockFetch({
      '/api/agents/crew/runs': { runs: [RUN] },
      '/api/agents/crew/runs/run-1': RUN,
    });
    render(<LabCrewRuns />);

    const item = await screen.findByRole('listitem', { name: 'Crew run on Demo clauses' });
    expect(within(item).getByText('Patch proven by Z3')).toBeTruthy();
    expect(within(item).getByText('This server')).toBeTruthy();
    expect(within(item).getByText(/1 240|1240 tokens/)).toBeTruthy();

    fireEvent.click(within(item).getByRole('button', { name: 'Show the steps of the run on Demo clauses' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agents/crew/runs/run-1'));
    expect((await within(item).findByText(/Picked 2 feed items/)).textContent).toContain('CrewAI');

    // Collapsing drops the detail, so expanding again fetches it once more.
    fireEvent.click(within(item).getByRole('button', { name: 'Hide the steps of the run on Demo clauses' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Show the steps of the run on Demo clauses' }));
    expect(await within(item).findByText(/Picked 2 feed items/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/agents/crew/runs/run-1')).toHaveLength(2);
  });

  it('shows an empty state when no run was stored', async () => {
    mockFetch({ '/api/agents/crew/runs': { runs: [] } });
    render(<LabCrewRuns />);
    expect((await screen.findByText(/No stored runs yet/)).textContent).toContain('Python crew');
  });

  it('reports a failed listing without breaking the page', async () => {
    mockFetch({});
    render(<LabCrewRuns />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('names every control', async () => {
    mockFetch({ '/api/agents/crew/runs': { runs: [RUN] } });
    const { container } = render(<LabCrewRuns />);
    await screen.findByRole('listitem', { name: 'Crew run on Demo clauses' });
    expectNamedControls(container);
  });
});
