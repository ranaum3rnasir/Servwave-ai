/**
 * Mobile slice 48: reorder the settings lists and the dashboard widgets without dragging.
 *
 * A finger cannot drag these rows, so each of the four reorderable surfaces gets Move up /
 * Move down beside its drag handle. Every test here drives the control the way a tap does
 * (a click on the named button) and checks the order that is SAVED, which must be the same
 * complete list a drag would have sent. The drag paths keep their own tests (decline reasons:
 * settings-decline-reasons.test.tsx) and are re-checked at the bottom of this file so the new
 * buttons cannot have replaced them.
 *
 * The real thing, on six devices and in a throwaway org, is e2e/mobile/reorder-by-tap.spec.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, serveDashboard } from './helpers';
import { installListsServer, row } from './listsFake';
import { buildAbility } from '@/lib/ability';
import { moveInList } from '@/lib/moveInList';
import DeclineReasonsPage from '@/pages/v2/settings/DeclineReasonsPage';
import JobSubStatusesPage from '@/pages/v2/settings/JobSubStatusesPage';
import ListsPage from '@/pages/v2/settings/ListsPage';
import DashboardPage from '@/pages/v2/dashboard/DashboardPage';
import CatalogDrawer from '@/components/dashboard/CatalogDrawer';
import { dashboardSeed } from '@/lib/api/_mock/dashboard';

// The dashboard seam reads VITE_DASHBOARD_USE_MOCK once, when its module loads. A developer's
// untracked frontend/.env.local sets it to 'true' (offline scaffolding), which swaps the API for
// the static seed and breaks the "no plans to show" state these tests rely on. Hoisted so it is
// pinned to the live (mocked axios) path BEFORE any import below evaluates the module.
vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
}));

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const originalMatchMedia = window.matchMedia;
/** Answers matchMedia the way a window of this width would (the hooks read min/max-width). */
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? px <= Number(v) : px >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.patch.mockResolvedValue({ data: {} });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const tap = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('moveInList', () => {
  it('moves one step and returns the complete new order', () => {
    expect(moveInList(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c']);
    expect(moveInList(['a', 'b', 'c'], 1, 'down')).toEqual(['a', 'c', 'b']);
  });

  it('has nowhere to go at either end, or for an unknown index', () => {
    expect(moveInList(['a', 'b'], 0, 'up')).toBeNull();
    expect(moveInList(['a', 'b'], 1, 'down')).toBeNull();
    expect(moveInList(['a', 'b'], 5, 'down')).toBeNull();
    expect(moveInList(['a', 'b'], -1, 'up')).toBeNull();
  });

  it('does not change the list it was given', () => {
    const list = ['a', 'b', 'c'];
    moveInList(list, 0, 'down');
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('Estimate decline reasons: Move up / Move down', () => {
  const LIST = [
    { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
    { code: 'TIMING', label: 'Timing', is_active: true, sort_order: 1, is_builtin: true },
    { code: 'OTHER', label: 'Other', is_active: true, sort_order: 2, is_builtin: true },
  ];
  beforeEach(() => {
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/api/lost-reason-options' ? { lost_reason_options: LIST } : {} }),
    );
  });

  it('Move down sends the whole new order, keyed by code', async () => {
    renderWithProviders(<DeclineReasonsPage />, { ability: ADMIN });
    await screen.findByLabelText('Rename Price');
    tap('Move Price down');
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/lost-reason-options/reorder', {
        ordered_codes: ['TIMING', 'PRICE', 'OTHER'],
      }),
    );
  });

  it('Move up sends the whole new order, and the ends cannot move past themselves', async () => {
    renderWithProviders(<DeclineReasonsPage />, { ability: ADMIN });
    await screen.findByLabelText('Rename Price');
    expect(screen.getByRole('button', { name: 'Move Price up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Other down' })).toBeDisabled();
    tap('Move Other up');
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/lost-reason-options/reorder', {
        ordered_codes: ['PRICE', 'OTHER', 'TIMING'],
      }),
    );
  });
});

describe('Job sub-statuses: Move up / Move down', () => {
  const ROWS = [
    { id: 's1', parent: 'IN_PROGRESS', label: 'Need To Order Supplies', sort_order: 0 },
    { id: 's2', parent: 'IN_PROGRESS', label: 'Waiting On Customer', sort_order: 1 },
    { id: 's3', parent: 'SCHEDULED', label: 'Confirm Access', sort_order: 0 },
  ];
  beforeEach(() => {
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/api/job-sub-statuses' ? { job_sub_statuses: ROWS } : {} }),
    );
  });

  it('reorders inside its own status only, sending that status and the whole new id list', async () => {
    renderWithProviders(<JobSubStatusesPage />, { ability: ADMIN });
    await screen.findByLabelText('Rename Need To Order Supplies');
    tap('Move Need To Order Supplies down');
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/job-sub-statuses/reorder', {
        parent: 'IN_PROGRESS',
        ordered_ids: ['s2', 's1'],
      }),
    );
  });

  it('a single sub-status has nowhere to move', async () => {
    renderWithProviders(<JobSubStatusesPage />, { ability: ADMIN });
    await screen.findByLabelText('Rename Confirm Access');
    expect(screen.getByRole('button', { name: 'Move Confirm Access up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Confirm Access down' })).toBeDisabled();
  });
});

describe('Lists (Job types): Move up / Move down', () => {
  beforeEach(() => {
    installListsServer(
      mockApi,
      {
        '/api/job-types': { rows: [row('j1', 'Install', { sort_order: 0 }), row('j2', 'Repair', { sort_order: 1 }), row('j3', 'Service', { sort_order: 2 })] },
        '/api/lead-sources': { rows: [row('s1', 'Google')] },
      },
      (_m, url) => (url === '/api/organization' ? { id: 'o1' } : {}),
    );
  });

  const jobTypeOrder = () =>
    within(screen.getByRole('list', { name: 'Job types' }))
      .getAllByRole('listitem')
      .map((li) => within(li).getByRole('button', { name: /^Rename / }).getAttribute('aria-label')!.replace(/^Rename /, ''));

  it('Move down reorders the rows, and the lists that cannot be reordered get no buttons', async () => {
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    await screen.findByText('Install');
    expect(jobTypeOrder()).toEqual(['Install', 'Repair', 'Service']);
    tap('Move Install down');
    await waitFor(() => expect(jobTypeOrder()).toEqual(['Repair', 'Install', 'Service']));
    tap('Move Service up');
    await waitFor(() => expect(jobTypeOrder()).toEqual(['Repair', 'Service', 'Install']));
    // Sources are not a reorderable list: no Move buttons for them.
    expect(screen.queryByRole('button', { name: 'Move Google up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move Google down' })).not.toBeInTheDocument();
  });

  it('the ends are off (aria-disabled, still focusable)', async () => {
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    await screen.findByText('Install');
    expect(screen.getByRole('button', { name: 'Move Install up' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Move Service down' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Dashboard widgets in edit mode', () => {
  let server: ReturnType<typeof serveDashboard>;
  beforeEach(() => {
    // An administrator's answer: every tile is theirs. Recurring has no plans to show, so it says so (it keeps its cell).
    // The layout is the server's: the factory one to start with, and a save is remembered.
    server = serveDashboard({ ...dashboardSeed, data: { ...dashboardSeed.data, 'kpi.recurring': null } });
  });

  /**
   * Opens the page and waits for its data to settle: a tile with nothing to show swaps its figure for a plain
   * line once the data arrives (Recurring has no plans to show), so the cells are only stable after that.
   */
  async function settled() {
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    // 10 s, not waitFor's 1 s: the dashboard's first data pass is slow on a loaded machine.
    await waitFor(() => expect(screen.getByText('No active plans')).toBeInTheDocument(), { timeout: 10_000 });
  }
  // Two default widgets share a title, so a widget is addressed by its place on the page.
  const hides = () => screen.getAllByRole('button', { name: /^Hide / });
  const ups = () => screen.getAllByRole('button', { name: /^Move .* up$/ });
  const downs = () => screen.getAllByRole('button', { name: /^Move .* down$/ });
  /** The widgets' names, top to bottom. */
  const titles = () => hides().map((b) => b.getAttribute('aria-label')!.replace(/^Hide /, ''));
  // The layout the page last saved to the server (null until it has saved one).
  const savedVisibleIds = () => {
    const last = server.saves[server.saves.length - 1];
    return last ? last.filter((i) => i.visible).map((i) => i.id) : null;
  };

  it('has a Move up / Move down pair for every visible widget in edit mode only', async () => {
    await settled();
    expect(screen.queryByRole('button', { name: /^Move .* (up|down)$/ })).not.toBeInTheDocument();
    tap(/Customize home page/);
    expect(hides().length).toBeGreaterThan(2);
    expect(ups()).toHaveLength(hides().length);
    expect(downs()).toHaveLength(hides().length);
  });

  it('Move down puts a widget after its neighbour, Move up puts it back, and the order is saved', async () => {
    await settled();
    tap(/Customize home page/);
    const before = titles();
    const [first, second] = before as [string, string];

    fireEvent.click(downs()[0]!);
    expect(titles().slice(0, 2)).toEqual([second, first]);
    // The save is sent to the server as the edit is made, with no button to press.
    await waitFor(() => expect(savedVisibleIds(), 'the new order is persisted').not.toBeNull());
    const ids = savedVisibleIds();
    // The saved list also holds tiles that are not drawn on this page, so compare the order, not the count.
    expect(ids!.indexOf('kpi.collected_today')).toBeLessThan(ids!.indexOf('kpi.revenue_mtd'));

    fireEvent.click(ups()[1]!);
    expect(titles()).toEqual(before);
    await waitFor(() => expect(savedVisibleIds()).not.toEqual(ids));
  });

  it('the first widget cannot go up and the last cannot go down', async () => {
    await settled();
    tap(/Customize home page/);
    expect(ups()[0]).toBeDisabled();
    expect(downs()[0]).toBeEnabled();
    expect(downs()[downs().length - 1]).toBeDisabled();
    expect(ups()[ups().length - 1]).toBeEnabled();
  });

  it('Move steps over a hidden widget to the next one the user can see', async () => {
    await settled();
    tap(/Customize home page/);
    const before = titles();
    // Hide the second widget; the first now moves past the THIRD.
    fireEvent.click(hides()[1]!);
    const [first, , third] = before as [string, string, string];
    expect(titles().slice(0, 2)).toEqual([first, third]);
    fireEvent.click(downs()[0]!);
    expect(titles().slice(0, 2)).toEqual([third, first]);
  });

  it('a phone gets the catalog as a sheet it opens on purpose, not a rail beside the widgets', async () => {
    windowWidth(393);
    await settled();
    tap(/Customize home page/);
    // Opening edit mode must not cover the widgets with a sheet.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    tap(/Add widgets/);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/Add to home page/)).toBeInTheDocument();
    // Close the sheet, and the Add control is back for the next time.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Add widgets/ })).toBeInTheDocument();
  });

  it('a phone can add a widget from the catalog sheet, and move widgets, and the layout is kept', async () => {
    windowWidth(393);
    await settled();
    tap(/Customize home page/);
    const firstName = titles()[0]!;
    const countBefore = hides().length;
    fireEvent.click(hides()[0]!);
    expect(hides()).toHaveLength(countBefore - 1);
    tap(/Add widgets/);
    const sheet = await screen.findByRole('dialog');
    // The catalog offers the hidden widget; adding it brings it back.
    fireEvent.click(within(sheet).getAllByRole('button', { name: `Add ${firstName}` })[0]!);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(hides()).toHaveLength(countBefore));
    // It comes back where it was (a hidden widget keeps its place); move it down by tap.
    expect(titles()[0]).toBe(firstName);
    const idsBefore = savedVisibleIds();
    fireEvent.click(downs()[0]!);
    await waitFor(() => expect(savedVisibleIds()).not.toEqual(idsBefore));
    expect(titles()[0]).not.toBe(firstName);
  });

  it('from md up the catalog is still the rail beside the widgets, open as edit mode opens', async () => {
    windowWidth(1280);
    await settled();
    tap(/Customize home page/);
    expect(screen.getByText(/Add to home page/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add widgets/ })).not.toBeInTheDocument();
  });
});

describe('CatalogDrawer presentation', () => {
  it('below md it is a dialog (a sheet); from md up it is a plain rail', () => {
    windowWidth(393);
    const phone = renderWithProviders(<CatalogDrawer open layout={[]} tiles={[{ id: 'kpi.jobs_today', category: 'jobs', mode: 'company', label: null }]} categories={[{ id: 'jobs', label: 'Jobs' }]} onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    phone.unmount();

    windowWidth(1280);
    renderWithProviders(<CatalogDrawer open layout={[]} tiles={[{ id: 'kpi.jobs_today', category: 'jobs', mode: 'company', label: null }]} categories={[{ id: 'jobs', label: 'Jobs' }]} onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('drag still works (the buttons sit beside the handle, they do not replace it)', () => {
  it('decline reasons: dropping one row on another still sends the whole new order', async () => {
    mockApi.get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === '/api/lost-reason-options'
            ? {
                lost_reason_options: [
                  { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
                  { code: 'TIMING', label: 'Timing', is_active: true, sort_order: 1, is_builtin: true },
                ],
              }
            : {},
      }),
    );
    renderWithProviders(<DeclineReasonsPage />, { ability: ADMIN });
    const source = (await screen.findByLabelText('Rename Timing')).parentElement as HTMLElement;
    const target = screen.getByLabelText('Rename Price').parentElement as HTMLElement;
    expect(source).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    fireEvent.dragOver(target);
    fireEvent.drop(target, { dataTransfer: { getData: () => 'TIMING' } });
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/lost-reason-options/reorder', { ordered_codes: ['TIMING', 'PRICE'] }),
    );
  });
});
