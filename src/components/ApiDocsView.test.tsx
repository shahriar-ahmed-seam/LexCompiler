// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiDocsView } from './ApiDocsView';
import { API_SECTIONS } from '../apiDocs';
import { expectNamedControls } from '../test/a11y';

afterEach(() => {
  cleanup();
});

const totalEndpoints = API_SECTIONS.reduce(
  (n, s) => n + s.pages.reduce((m, p) => m + (p.endpoints?.length ?? 0), 0),
  0
);

describe('api docs view', () => {
  it('shows the introduction page and every section in the nav', () => {
    render(<ApiDocsView />);
    expect(screen.getByRole('heading', { name: 'Introduction' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'API docs sections' });
    for (const section of API_SECTIONS) {
      expect(within(nav).getByText(section.title)).toBeTruthy();
    }
    expect(within(nav).getByText(`${totalEndpoints} endpoints`, { exact: false })).toBeTruthy();
  });

  it('opens a page and renders its endpoint cards with method and access badges', () => {
    render(<ApiDocsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Outbound events' }));
    expect(screen.getByRole('heading', { name: 'Outbound events' })).toBeTruthy();

    const card = screen.getByRole('article', { name: 'PUT /api/workspaces/:workspaceId/webhook' });
    expect(within(card).getByText('PUT')).toBeTruthy();
    expect(within(card).getByText('manageWorkspace · owner')).toBeTruthy();
    expect(within(card).getByText('rotateSecret')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Copy the example' })).toBeTruthy();
  });

  it('searches endpoints across all pages and links back to the owning page', () => {
    render(<ApiDocsView />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search endpoints' }), {
      target: { value: 'pack.zip' },
    });
    const card = screen.getByRole('article', { name: 'GET /api/share/:token/pack.zip' });
    expect(within(card).getByText('public')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Public share routes' }));
    expect(screen.getByRole('heading', { name: 'Public share routes' })).toBeTruthy();
  });

  it('reports an empty search without crashing', () => {
    render(<ApiDocsView />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search endpoints' }), {
      target: { value: 'no-such-endpoint-xyz' },
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    expect(screen.getByText('0 endpoints match', { exact: false })).toBeTruthy();
  });

  it('names every control', () => {
    const { container } = render(<ApiDocsView />);
    expectNamedControls(container);
  });
});
