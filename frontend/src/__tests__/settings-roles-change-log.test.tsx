/**
 * Roles & Permissions, PRD 2, S02.12 - the Change log tab on the Roles page.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * against the real answer shapes of the Roles API and of the role's change log read. A switch's name and the words of
 * its values are read from the catalog fixture, never typed here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { RoleSwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';
import { logEntry, logServer, reachEnd, installObserverDouble, watching } from './support/changeLogServer';

const mockApi = vi.mocked(api);

vi.mock('@/pages/v2/settings/settingsBar', () => ({ useSettingsBar: () => ({ registerSaver: () => {} }) }));

// Sales first: the page opens on the first role it lists.
const ROLES = [
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'night_desk', label: 'Night desk', description: '', fullAccess: false, editable: true, userCount: 0, type: 'custom', base_role: 'SALES' },
];

const setOf = (role: string): RoleSwitchSet => ({
  role, label: ROLES.find((r) => r.role === role)!.label, type: role === 'night_desk' ? 'custom' : 'system', editable: true, base_role: 'SALES',
  made_from_role_key: role === 'night_desk' ? 'SALES' : null, made_from_blank: false, values: presetSet('SALES'), all_views_off: false,
});

/** The log each role answers with, by role key. */
let LOGS: Record<string, ReturnType<typeof logServer>> = {};
let TIMEZONE = 'America/New_York';

function serve(logs: Record<string, ReturnType<typeof logEntry>[]>) {
  LOGS = Object.fromEntries(Object.entries(logs).map(([role, entries]) => [role, logServer(entries)]));
  mockApi.get.mockImplementation((url: string, config?: unknown) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES.map((r) => ({ ...r })) });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: TIMEZONE } });
    const log = url.match(/^\/api\/roles\/([^/]+)\/change-log$/);
    if (log) return Promise.resolve(LOGS[log[1]!]?.answer(config as never) ?? { data: { total: 0, has_more: false, entries: [] } });
    const set = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (set) return Promise.resolve({ data: setOf(set[1]!) });
    return Promise.resolve({ data: [] });
  });
}

const logCalls = (role: string) => mockApi.get.mock.calls.filter(([url]) => url === `/api/roles/${role}/change-log`);

async function openLog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Change log' }));
}

const rows = () => screen.queryAllByRole('listitem').filter((li) => li.hasAttribute('data-change-entry'));

installObserverDouble();

/** A wide window, where the roles are a side list of buttons rather than a picker. */
const originalMatchMedia = window.matchMedia;
function wideWindow() {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? 1400 <= Number(v) : 1400 >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

beforeEach(() => {
  vi.clearAllMocks();
  wideWindow();
  TIMEZONE = 'America/New_York';
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('the Change log tab on the Roles page', () => {
  it('sits beside the switches, and reads nothing until it is opened', async () => {
    serve({ SALES: [logEntry()] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);

    expect(await screen.findByRole('tab', { name: 'Permissions' })).toBeInTheDocument();
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    expect(logCalls('SALES')).toHaveLength(0);

    await openLog(user);
    await waitFor(() => expect(logCalls('SALES')).toHaveLength(1));
    expect(logCalls('SALES')[0]![1]).toMatchObject({ params: { limit: 50, offset: 0 } });
  });

  it('keeps the switches and what was edited on them while the log is open', async () => {
    serve({ SALES: [logEntry()] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    const flipped = catalogSwitch('export_customers');
    const toggle = await screen.findByRole('switch', { name: flipped.label });
    const before = toggle.getAttribute('aria-checked');
    await user.click(toggle);
    expect(screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked')).not.toBe(before);

    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked')).not.toBe(before);
  });

  it('draws only the log under the tabs while it is open: the switch editor is out of the page, and back as it was left', async () => {
    serve({ SALES: [logEntry()] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    const flipped = catalogSwitch('export_customers');
    await user.click(await screen.findByRole('switch', { name: flipped.label }));
    const editedTo = screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked');

    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });
    // Kept mounted (the edit survives) but hidden, so the log is the first thing under the tabs rather than ~8,000px down.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    const panel = document.querySelector('[role="tabpanel"][data-state="inactive"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel).not.toBeVisible();
    expect(screen.getByRole('list', { name: 'Change log' })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked')).toBe(editedTo);
    expect(screen.queryByRole('list', { name: 'Change log' })).not.toBeInTheDocument();
  });

  it('says who, when, which switch, from, to and why, in the words of the editor', async () => {
    TIMEZONE = 'America/Los_Angeles';
    const scope = catalogSwitch('leads_scope');
    const methods = catalogSwitch('allowed_payment_methods');
    serve({
      SALES: [
        logEntry({ switch_key: 'view_customers', from: false, to: true, reason: 'manual', created_at: '2026-03-05T02:30:00.000Z' }),
        logEntry({ switch_key: scope.key, from: 'attached', to: 'all', reason: 'reset', actor: { id: 'a2', name: 'Eli Owner' } }),
        logEntry({ switch_key: methods.key, from: 'all_accepted', to: ['CASH', 'CHECK'], reason: 'manual' }),
        logEntry({ switch_key: 'export_customers', from: true, to: false, reason: 'migration', actor: null }),
        logEntry({ switch_key: null, switch_label: null, from: null, to: null, reason: 'save as role' }),
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });

    const [edit, reset, list, migration, created] = rows();
    // Who, when (the company's clock, with the year), the catalog's label, from and to.
    expect(within(edit!).getByText(catalogSwitch('view_customers').label)).toBeInTheDocument();
    expect(edit!.textContent).toMatch(/Off.*On/);
    expect(edit!.textContent).toContain('Dana Admin');
    expect(edit!.textContent).toContain('Manual edit');
    expect(edit!.textContent).toMatch(/Mar 4, 2026.*6:30\s?PM/);
    // A scope switch: the editor's own words for its choices.
    expect(within(reset!).getByText(scope.label)).toBeInTheDocument();
    expect(reset!.textContent).toMatch(/Attached.*All/);
    expect(reset!.textContent).toContain('Eli Owner');
    expect(reset!.textContent).toContain('Reset');
    // A list switch: its marker and its chosen members, as the editor shows them.
    expect(list!.textContent).toContain('All accepted methods');
    expect(list!.textContent).toMatch(/Cash, Check/);
    // A migration has no person behind it.
    expect(migration!.textContent).toContain('System');
    expect(migration!.textContent).toContain('Migration');
    expect(migration!.textContent).toMatch(/On.*Off/);
    // The event a Save as role writes has no switch and no values.
    expect(created!.textContent).toContain('Role created through Save as role');
    expect(created!.textContent).not.toMatch(/→|\bOn\b|\bOff\b/);
    expect(created!.textContent).toContain('Save as role');
  });

  it('never shows a raw key: a switch the catalog no longer holds gets a plain line', async () => {
    serve({ SALES: [logEntry({ switch_key: 'a_switch_that_was_removed', switch_label: null, from: true, to: false })] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await screen.findByText('A switch that no longer exists');
    expect(document.body.textContent).not.toContain('a_switch_that_was_removed');
    expect(rows()[0]!.textContent).toMatch(/On.*Off/);
  });

  it('says so plainly when the role has no changes yet', async () => {
    serve({ SALES: [] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('keeps the entries in the order the server sends them, newest first', async () => {
    const keys = ['view_customers', 'create_customers', 'edit_customers'];
    serve({ SALES: keys.map((switch_key) => logEntry({ switch_key })) });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });
    expect(rows().map((r) => within(r).getAllByText(/./)[0]!.textContent)).toEqual(keys.map((k) => catalogSwitch(k).label));
  });

  it('loads older entries as its end is reached, three hundred of them over six pages, each once', async () => {
    const all = Array.from({ length: 300 }, (_, i) => logEntry({ id: `row-${i}`, switch_key: 'view_customers' }));
    serve({ SALES: all });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await waitFor(() => expect(rows()).toHaveLength(50));
    // The log is its own scroller, and says older entries are on their way.
    expect(document.querySelector('[data-change-log]')!.className).toContain('overflow-y-auto');

    for (let page = 2; page <= 6; page++) {
      await reachEnd();
      await waitFor(() => expect(rows()).toHaveLength(page * 50));
    }
    expect(LOGS.SALES!.offsets).toEqual([0, 50, 100, 150, 200, 250]);
    expect(new Set(rows().map((r) => r.textContent)).size).toBeGreaterThan(0);
    // Nothing older: the end says so, and nothing is watched any more.
    await screen.findByText('That’s every change.');
    expect(watching()).toBe(0);
    await reachEnd();
    expect(LOGS.SALES!.offsets).toHaveLength(6);
  });

  it('shows "Loading older changes" while a page is on its way, and offers the same load by button', async () => {
    const all = Array.from({ length: 80 }, (_, i) => logEntry({ id: `row-${i}` }));
    serve({ SALES: all });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await waitFor(() => expect(rows()).toHaveLength(50));

    let release: () => void = () => {};
    const slow = LOGS.SALES!.answer;
    mockApi.get.mockImplementation((url: string, config?: unknown) =>
      url === '/api/roles/SALES/change-log'
        ? new Promise((resolve) => { release = () => resolve(slow(config as never)); })
        : Promise.resolve({ data: url === '/api/permission-switches/catalog' ? FIXTURE_CATALOG : [] }),
    );
    await user.click(screen.getByRole('button', { name: 'Load older changes' }));
    expect(await screen.findByText('Loading older changes')).toBeInTheDocument();
    release();
    await waitFor(() => expect(rows()).toHaveLength(80));
    expect(screen.queryByText('Loading older changes')).toBeNull();
  });

  it('shows an entry once when a new write slides it across a page edge', async () => {
    const all = Array.from({ length: 70 }, (_, i) => logEntry({ id: `row-${i}` }));
    serve({ SALES: all });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await waitFor(() => expect(rows()).toHaveLength(50));
    // Someone saves a change meanwhile: everything moves one place down, so the old page's last entry comes round again.
    const sliding = [logEntry({ id: 'row-new' }), ...all];
    LOGS.SALES = logServer(sliding);
    await reachEnd();
    await waitFor(() => expect(rows()).toHaveLength(70));
  });

  it('says the older entries could not be loaded, keeps what is shown, and tries again on Retry', async () => {
    const all = Array.from({ length: 80 }, (_, i) => logEntry({ id: `row-${i}` }));
    serve({ SALES: all });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await waitFor(() => expect(rows()).toHaveLength(50));
    const working = LOGS.SALES!.answer;
    let failing = true;
    mockApi.get.mockImplementation((url: string, config?: unknown) => {
      if (url !== '/api/roles/SALES/change-log') return Promise.resolve({ data: url === '/api/permission-switches/catalog' ? FIXTURE_CATALOG : [] });
      return failing ? Promise.reject(new Error('offline')) : Promise.resolve(working(config as never));
    });
    await reachEnd();
    expect(await screen.findByText("Couldn't load older changes.")).toBeInTheDocument();
    expect(rows()).toHaveLength(50);
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(rows()).toHaveLength(80));
  });

  it('reads the log of the role that is picked, and each role\'s own', async () => {
    serve({ SALES: [logEntry({ switch_key: 'view_customers' })], night_desk: [logEntry({ switch_key: 'create_customers', reason: 'save as role' })] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openLog(user);
    await screen.findByText(catalogSwitch('view_customers').label, { selector: 'p' });

    await user.click(await screen.findByRole('button', { name: /Night desk/ }));
    await screen.findByText(catalogSwitch('create_customers').label, { selector: 'p' });
    expect(screen.queryByText(catalogSwitch('view_customers').label, { selector: 'p' })).toBeNull();
    expect(logCalls('night_desk')).toHaveLength(1);
  });

  it('starts over from the newest entries after the role is reset', async () => {
    serve({ night_desk: [logEntry()] });
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night desk/ }));
    await openLog(user);
    await waitFor(() => expect(logCalls('night_desk')).toHaveLength(1));

    mockApi.post.mockResolvedValue({ data: setOf('night_desk') });
    await user.click(await screen.findByRole('button', { name: 'Reset to default' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Reset to/ }));
    await waitFor(() => expect(logCalls('night_desk').length).toBeGreaterThan(1));
    expect(logCalls('night_desk').every(([, config]) => (config as { params: { offset: number } }).params.offset === 0)).toBe(true);
  });
});
