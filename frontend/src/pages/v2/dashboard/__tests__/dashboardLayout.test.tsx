/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.4 - the routed dashboard reads and writes the layout on the server, not in the browser:
 * it draws the saved order, saves a reorder, a hide, an added tile and a time-range choice straight away, finds the
 * saved layout again on a fresh load, never reads the browser's copy, and tells a person with an empty layout what to do.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage). The server is a small fake behind the mocked axios:
 * `GET /api/dashboard` answers the tiles, `GET /api/dashboard/layout` the layout, `PUT` there remembers a save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { serveDashboard, renderDashboard } from '@/__tests__/harness/dashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

const hoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: '/somewhere' });
const answer: DashboardResponse = {
  tiles: [meta('kpi.jobs_today', 'jobs'), meta('kpi.jobs_week', 'jobs'), meta('kpi.open_leads', 'leads'), meta('coming_up', 'jobs')],
  categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'leads', label: 'Leads' }],
  data: {
    'kpi.jobs_today': { total: 3, scheduled: 2, in_progress: 1, completed: 0, vs_yesterday: 0 },
    'kpi.jobs_week': { completed: 1, scheduled: 4 },
    'kpi.open_leads': { count: 2, no_owner: 1 },
    coming_up: [],
  },
  generated_at: '2026-10-12T10:00:00.000Z',
};
const titlesOnPage = () => screen.getAllByRole('button', { name: /^Hide / }).map((b) => b.getAttribute('aria-label')!.replace(/^Hide /, ''));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the dashboard layout is the server\'s', () => {
  it('draws the tiles in the order the server sent, leaving out the hidden ones', async () => {
    serveDashboard(answer, [
      { id: 'kpi.open_leads', visible: true }, { id: 'kpi.jobs_today', visible: false }, { id: 'kpi.jobs_week', visible: true },
    ]);
    renderDashboard({ ability: ADMIN });

    await screen.findByText('Open Leads');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']);
  });

  it('does not read the layout this browser used to keep', async () => {
    localStorage.setItem(
      'alpha:dashboard-layout:v1:00000000-0000-0000-0000-000000000001',
      JSON.stringify([{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: false }]),
    );
    serveDashboard(answer, [{ id: 'kpi.open_leads', visible: true }]);
    renderDashboard({ ability: ADMIN });

    await screen.findByText('Open Leads');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(titlesOnPage()).toEqual(['Open Leads']);
  });

  it('saves a hide straight away, without any further action', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Open Leads');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Jobs Today' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual([{ id: 'kpi.jobs_today', visible: false }, { id: 'kpi.open_leads', visible: true }]);
    expect(titlesOnPage()).toEqual(['Open Leads']);
    expect(mockApi.put).toHaveBeenCalledWith('/api/dashboard/layout', { layout: server.saves[0] });
  });

  it('draws a default tile the server added at the end after the rest, and sends it back with them on the next save (S09.8)', async () => {
    // The server's answer is the saved layout merged forward: the last entry is a default tile the person never saw.
    const server = serveDashboard(answer, [{ id: 'kpi.open_leads', visible: true }, { id: 'kpi.jobs_today', visible: false }, { id: 'coming_up', visible: true }]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Open Leads');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(titlesOnPage()).toEqual(['Open Leads', 'Coming Up']);

    fireEvent.click(screen.getByRole('button', { name: 'Hide Open Leads' }));
    await waitFor(() => expect(server.saves).toHaveLength(1));
    // The whole list goes back, the hidden tile still in it: that is what keeps a default tile from being added twice.
    expect(server.saves[0]).toEqual([{ id: 'kpi.open_leads', visible: false }, { id: 'kpi.jobs_today', visible: false }, { id: 'coming_up', visible: true }]);
  });

  it('saves a reorder straight away, and a fresh load finds the new order', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }, { id: 'kpi.jobs_week', visible: true }]);
    const first = renderDashboard({ ability: ADMIN });
    await screen.findByText('Open Leads');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Move Jobs Today down' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]!.map((e) => e.id)).toEqual(['kpi.open_leads', 'kpi.jobs_today', 'kpi.jobs_week']);
    expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs Today', 'Jobs This Week']);

    // A reload: a new page, nothing carried over in the browser, reads the order from the server.
    first.unmount();
    localStorage.clear();
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Open Leads');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs Today', 'Jobs This Week']);
  });

  it('saves a time-range choice, and the numbers shown do not change with it', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');
    // In edit mode the picker also lists the title: the tile is the one inside a button.
    const total = () => screen.getAllByText('Jobs Today').map((e) => e.closest('button')?.textContent).find(Boolean);
    const before = total();
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Jobs Today time range' }));
    await user.click(await screen.findByRole('option', { name: '7d' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual([{ id: 'kpi.jobs_today', visible: true, range: '7d' }]);
    expect(total()).toBe(before);
  });

  it('saves a tile added from the picker', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual([{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: true }]);
  });

  it('asks the server to put the role\'s default back when the button "Reset to my role\'s default" is pressed', async () => {
    const roleDefault = [{ id: 'kpi.open_leads', visible: true }, { id: 'kpi.jobs_week', visible: true }];
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }], roleDefault);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(screen.queryByRole('button', { name: /Reset to default/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));

    await waitFor(() => expect(server.resets).toBe(1));
    await waitFor(() => expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']));
    // The server made the layout: the page sent no layout of its own.
    expect(server.saves).toEqual([]);
    expect(server.layout).toEqual(roleDefault);
  });

  it('shows an empty page after a reset to an empty default (a role made from blank)', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }], []);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));

    await waitFor(() => expect(server.resets).toBe(1));
    expect(await screen.findByText(/Nothing is on your home page yet/)).toBeInTheDocument();
  });

  it('keeps an edit made after a reset: later saves go on from the reset layout', async () => {
    const roleDefault = [{ id: 'kpi.open_leads', visible: true }, { id: 'kpi.jobs_week', visible: true }];
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }], roleDefault);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: "Reset to my role's default" }));
    await waitFor(() => expect(titlesOnPage()).toEqual(['Open Leads', 'Jobs This Week']));

    fireEvent.click(screen.getByRole('button', { name: 'Hide Open Leads' }));
    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual([{ id: 'kpi.open_leads', visible: false }, { id: 'kpi.jobs_week', visible: true }]);
  });

  it('does not offer the reset while the saved layout could not be read, so nothing is put over it', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }], undefined, {
      routes: [{ match: (url) => url === '/api/dashboard/layout', data: () => { throw new Error('Network Error'); } }],
    });
    renderDashboard({ ability: ADMIN });

    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    await screen.findByText(/Edit mode/);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/dashboard/layout'));
    expect(screen.queryByRole('button', { name: "Reset to my role's default" })).not.toBeInTheDocument();
    expect(server.resets).toBe(0);
  });
});

describe('a tile the person lost (S09.7)', () => {
  // The server keeps the tile in the layout, in its place, flagged not available.
  const lost = (id: string, extra: Record<string, unknown> = {}) => ({ id, visible: true, available: false as const, ...extra });
  // The dashboard answer the server sends once the leads category is gone: no leads tile among the tiles.
  const withoutLeads: DashboardResponse = { ...answer, tiles: answer.tiles.filter((t) => t.id !== 'kpi.open_leads') };

  it('never draws a flagged tile, even one the dashboard answer still carries, and is not thrown by it', async () => {
    serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }, lost('kpi.open_leads'), { id: 'kpi.jobs_week', visible: true }]);
    renderDashboard({ ability: ADMIN });

    await screen.findByText('Jobs Today');
    expect(screen.queryByText('Open Leads')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(titlesOnPage()).toEqual(['Jobs Today', 'Jobs This Week']);
  });

  it('does not offer a lost tile in the picker, and does not count it as a tile on the page', async () => {
    serveDashboard(withoutLeads, [{ id: 'kpi.jobs_today', visible: true }, lost('kpi.open_leads')]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    await screen.findByRole('button', { name: 'Add Jobs This Week' });
    expect(screen.queryByRole('button', { name: 'Add Open Leads' })).not.toBeInTheDocument();
    expect(screen.queryByText('Open Leads')).not.toBeInTheDocument();
  });

  it('says the page is empty when every tile left in the layout is a lost one', async () => {
    serveDashboard(withoutLeads, [lost('kpi.open_leads')]);
    renderDashboard({ ability: ADMIN });
    expect(await screen.findByText(/Nothing is on your home page yet/)).toBeInTheDocument();
  });

  it('sends the lost tile back in its place, as the server gave it, when another tile is changed', async () => {
    const stored = [{ id: 'kpi.jobs_today', visible: true }, lost('kpi.open_leads', { size: 'full', range: '7d' }), { id: 'kpi.jobs_week', visible: true }];
    const server = serveDashboard(withoutLeads, stored);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Jobs This Week' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]).toEqual([stored[0], stored[1], { id: 'kpi.jobs_week', visible: false }]);
  });

  it('steps a tile over a lost one when it is moved, and still sends the lost one back', async () => {
    const server = serveDashboard(withoutLeads, [{ id: 'kpi.jobs_today', visible: true }, lost('kpi.open_leads'), { id: 'kpi.jobs_week', visible: true }]);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Jobs Today down' }));

    await waitFor(() => expect(server.saves).toHaveLength(1));
    expect(server.saves[0]!.map((e) => e.id).filter((id) => id !== 'kpi.open_leads')).toEqual(['kpi.jobs_week', 'kpi.jobs_today']);
    expect(server.saves[0]).toContainEqual(lost('kpi.open_leads'));
    await waitFor(() => expect(titlesOnPage()).toEqual(['Jobs This Week', 'Jobs Today']));
  });

  it('puts the screen back as the server has it, and says something plain, when a save is refused for a tile that was lost meanwhile', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }, { id: 'kpi.open_leads', visible: false }]);
    mockApi.put.mockImplementation((() => {
      // Between the page's last read and this save the person lost the leads category: the server now holds the tile as lost.
      server.layout = [{ id: 'kpi.jobs_today', visible: true }, lost('kpi.open_leads', { visible: false })];
      return Promise.reject({ response: { status: 409, data: { error: "That tile isn't available with your access.", code: 'TILE_NOT_AVAILABLE' } } });
    }) as never);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');

    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    expect(hoisted.toast.mock.calls[0]![0]).toMatchObject({ description: "That tile isn't available with your access.", variant: 'destructive' });
    // The layout is read again, and the tile the server now holds as lost is not drawn (the picker still lists it only
    // because this fake dashboard answer was not updated).
    await waitFor(() => expect(server.layoutReads).toBe(2));
    await waitFor(() => expect(titlesOnPage()).toEqual(['Jobs Today']));
  });

  it('says nothing for a save that fails for another reason', async () => {
    serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }]);
    mockApi.put.mockRejectedValue({ response: { status: 400, data: { error: 'Validation failed' } } } as never);
    renderDashboard({ ability: ADMIN });
    await screen.findByText('Jobs Today');
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    await waitFor(() => expect(titlesOnPage()).toEqual(['Jobs Today']));
    expect(hoisted.toast).not.toHaveBeenCalled();
  });
});

describe('an edit made after the saved layout could not be read', () => {
  it('saves nothing, so the saved layout is never overwritten by a layout built from nothing', async () => {
    const server = serveDashboard(answer, [{ id: 'kpi.jobs_today', visible: true }], undefined, {
      routes: [{ match: (url) => url === '/api/dashboard/layout', data: () => { throw new Error('Network Error'); } }],
    });
    renderDashboard({ ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/dashboard/layout'));

    fireEvent.click(await screen.findByRole('button', { name: 'Add Open Leads' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(server.saves).toEqual([]);
  });
});

describe('an empty layout', () => {
  it('says so, and points at Customize home page, when the person has tiles they could add', async () => {
    serveDashboard(answer, []);
    renderDashboard({ ability: ADMIN });

    expect(await screen.findByText(/Nothing is on your home page yet/)).toBeInTheDocument();
    expect(screen.queryByText('No tiles are available with your access.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Customize home page/ }));
    expect(await screen.findByRole('button', { name: 'Add Jobs Today' })).toBeInTheDocument();
  });

  it('shows the no-tiles line with the customize button when the person\'s access unlocks no tile', async () => {
    serveDashboard({ tiles: [], categories: [], data: {}, generated_at: answer.generated_at }, []);
    renderDashboard({ ability: ADMIN });

    expect(await screen.findByText('No tiles are available with your access.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is on your home page yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Customize home page/ })).toBeInTheDocument();
  });

  it('draws nothing from a layout that names only tiles the person does not have, and keeps the page working', async () => {
    serveDashboard(answer, [{ id: 'kpi.ar', visible: true }, { id: 'tile.retired.long.ago', visible: true }]);
    renderDashboard({ ability: ADMIN });
    expect(await screen.findByText(/Nothing is on your home page yet/)).toBeInTheDocument();
    expect(screen.queryByText('Unpaid Balance')).not.toBeInTheDocument();
  });
});
