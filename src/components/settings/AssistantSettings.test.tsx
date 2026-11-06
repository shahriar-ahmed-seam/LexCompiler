// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantSettings, clientConfigs } from './AssistantSettings';
import { expectNamedControls } from '../../test/a11y';
import { mockFetch } from '../../test/fixtures';

const WS = 'ws-1';
const TOKEN = `lexc_pat_${'x'.repeat(43)}`;
const routes = {
  '/api/workspaces': [{ id: WS, name: 'FinHealth AI', role: 'engineer' }],
  [`/api/workspaces/${WS}/tokens`]: {
    mcpUrl: 'http://localhost:3001/mcp',
    tokens: [{ id: 't1', name: 'Old laptop', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null }],
  },
  [`/api/workspaces/${WS}/tokens/t1/revoke`]: { id: 't1', revokedAt: '2026-10-30T00:00:00Z' },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('clientConfigs', () => {
  it('names the variable where the client expands it, and holds the token only where it cannot', () => {
    const configs = clientConfigs('http://localhost:3001/mcp', TOKEN);
    expect(configs.map((c) => c.client)).toEqual(['Kiro', 'VS Code with Copilot', 'Claude Code', 'Claude Desktop', 'Cursor', 'Codex', 'Antigravity']);
    for (const c of configs) expect(c.text.includes(TOKEN)).toBe(c.holdsToken);
    expect(configs.filter((c) => c.holdsToken).map((c) => c.client)).toEqual(['Claude Desktop', 'Antigravity']);
    expect(configs.find((c) => c.client === 'Codex')!.text).toContain('bearer_token_env_var = "LEXCOMPILER_TOKEN"');
    expect(JSON.parse(configs.find((c) => c.client === 'Antigravity')!.text).mcpServers.lexcompiler.serverUrl).toBe('http://localhost:3001/mcp');
    expect(JSON.parse(configs.find((c) => c.client === 'Claude Code')!.text).mcpServers.lexcompiler).toEqual({
      type: 'http',
      url: 'http://localhost:3001/mcp',
      headers: { Authorization: 'Bearer ${LEXCOMPILER_TOKEN}' },
    });
  });
});

describe('AssistantSettings', () => {
  it('creates a token, shows it once with a configuration, and revokes tokens', async () => {
    const fetchMock = mockFetch({ ...routes });
    // Creating answers with the new token (POST to the same path as the list).
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost').pathname;
      const body = url === `/api/workspaces/${WS}/tokens` && init?.method === 'POST' ? { id: 't2', name: 'Laptop', token: TOKEN } : (routes as Record<string, unknown>)[url];
      return new Response(JSON.stringify(body ?? { error: 'not mocked' }), { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    });
    const { container } = render(<AssistantSettings />);
    await screen.findByRole('listitem', { name: 'Token Old laptop' });

    const create = screen.getByRole('button', { name: 'Create token' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Laptop' } });
    fireEvent.click(create);
    expect(((await screen.findByRole('textbox', { name: 'New token' })) as HTMLInputElement).value).toBe(TOKEN);
    const call = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ name: 'Laptop', days: 90 });

    // Claude Code is shown first and names the variable; Antigravity's file holds the token.
    expect(screen.getByLabelText('Claude Code configuration').textContent).toContain('${LEXCOMPILER_TOKEN}');
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant' }), { target: { value: 'Antigravity' } });
    expect(screen.getByLabelText('Antigravity configuration').textContent).toContain(TOKEN);
    expect(screen.getByText(/keep it private/)).toBeTruthy();
    expectNamedControls(container);

    fireEvent.click(within(screen.getByRole('listitem', { name: 'Token Old laptop' })).getByRole('button', { name: 'Revoke Old laptop' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${WS}/tokens/t1/revoke`, expect.anything()));
    expect((await screen.findByRole('status')).textContent).toContain('Revoked "Old laptop"');
  });
});
