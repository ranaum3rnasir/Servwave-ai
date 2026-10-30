/**
 * Roles & Permissions, PRD 2, S02.15 - Users & Teams: Deactivate and Reactivate follow Edit users, Delete follows
 * Delete users, and the Time clock column is gone.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`, the one `settings.routes.tsx` mounts at
 * /settings/users). Every viewer is built from the rules under test, never from a role name. The server rows (a
 * deactivate or reactivate needs Edit users, a permanent delete needs Delete users) are proved against the real
 * routes in backend `permission-users-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role: 'SALES', role_label: 'Sales',
  change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null,
  department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  // The list answer still carries the two stored clock-in values; no screen draws them any more.
  enforce_clock_in_location: true, can_approve_clock_overrides: true,
  ...extra,
});

const ACTIVE = person('u-active', 'Ada', 'Active');
const INACTIVE = person('u-inactive', 'Ian', 'Inactive', { is_active: false, has_login: false });

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 2, type: 'system' },
];

const READ = { action: 'read', subject: 'User' } as const;
const UPDATE = { action: 'update', subject: 'User' } as const;
const DELETE = { action: 'delete', subject: 'User' } as const;

const only = (...rules: Array<{ action: string; subject: string }>): AppAbility => buildAbility(rules);

function serve() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [ACTIVE, INACTIVE] } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

// The page's own "Missing phone" filter is a switch, so the check is on what each toggle is called, not on there being none.
const expectNoClockToggles = () => {
  const names = [...screen.queryAllByRole('switch'), ...screen.queryAllByRole('checkbox')].map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
  expect(names.filter((n) => /clock|location|override/i.test(n))).toEqual([]);
};

const originalMatchMedia = window.matchMedia;
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
  serve();
  mockApi.delete.mockResolvedValue({ data: { message: 'ok' } });
  mockApi.patch.mockResolvedValue({ data: { user: ACTIVE } });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('Users & Teams - a holder of Edit users and not Delete users', () => {
  it('sees Deactivate on an active person and Reactivate on an inactive one, and no Delete anywhere', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
    const active = await rowOf('Ada Active');
    const inactive = await rowOf('Ian Inactive');
    expect(within(active).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(inactive).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(within(inactive).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(within(active).queryByRole('button', { name: 'Reactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('completes a deactivation after the confirmation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
    await user.click(within(await rowOf('Ada Active')).getByRole('button', { name: 'Deactivate' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    // With nothing else picked, the dialog's answer to who gets the person's email is the main mailbox.
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-active', { data: { handover_to: 'main' } }));
    expect(mockApi.delete).toHaveBeenCalledTimes(1);
  });

  it('reactivates an inactive person on Edit users', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
    await user.click(within(await rowOf('Ian Inactive')).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/users/u-inactive', { is_active: true }));
  });
});

describe('Users & Teams - the viewer\'s own row', () => {
  it('offers no Deactivate on it (the server refuses it) and still offers it on everyone else', async () => {
    // The test session's signed-in person (setup.ts) is this id.
    const me = person('00000000-0000-0000-0000-000000000001', 'Mia', 'Self');
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/users') return Promise.resolve({ data: { users: [me, ACTIVE] } });
      if (url === '/api/roles') return Promise.resolve({ data: ROLES });
      if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
      return Promise.resolve({ data: {} });
    });
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
    const own = await rowOf('Mia Self');
    const other = await rowOf('Ada Active');
    expect(within(other).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(own).queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });
});

describe('Users & Teams - a holder of Delete users and not Edit users', () => {
  it('sees Delete on the inactive row only, and no Deactivate or Reactivate', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, DELETE) });
    const active = await rowOf('Ada Active');
    const inactive = await rowOf('Ian Inactive');
    expect(within(inactive).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(active).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reactivate' })).toBeNull();
  });
});

describe('Users & Teams - a viewer who can only read users', () => {
  it('sees the table with no management control, and each person\'s role as plain text', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ) });
    const active = await rowOf('Ada Active');
    await rowOf('Ian Inactive');
    for (const name of [/^edit$/i, /^deactivate$/i, /^reactivate$/i, /^delete$/i, /invite user/i, /send invite/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(within(active).queryByRole('combobox')).toBeNull();
    expect(within(active).getByText('Sales')).toBeInTheDocument();
  });
});

describe('Users & Teams - a permanent delete', () => {
  it('removes an inactive person with no history', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, DELETE) });
    await user.click(within(await rowOf('Ian Inactive')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(mockApi.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-inactive/permanent'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("shows the server's refusal in the dialog when the person has history, and the dialog stays open", async () => {
    const user = userEvent.setup();
    const refusal = "This user has history (3 jobs) and can't be permanently deleted. Keep them deactivated instead.";
    mockApi.delete.mockRejectedValue({ response: { status: 409, data: { error: refusal } } });
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, DELETE) });
    await user.click(within(await rowOf('Ian Inactive')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete user' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(refusal);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('clears a refusal when the dialog is closed and opened again', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockRejectedValue({ response: { status: 409, data: { error: 'Refused for a reason.' } } });
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, DELETE) });
    const open = async () => user.click(within(await rowOf('Ian Inactive')).getByRole('button', { name: 'Delete' }));
    await open();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete user' }));
    await screen.findByRole('alert');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await open();
    expect(within(await screen.findByRole('dialog')).queryByRole('alert')).toBeNull();
  });
});

describe('Users & Teams - no Time clock column', () => {
  const SWITCH_SETS: Array<[string, AppAbility]> = [
    ['everything on', buildAbility([{ action: 'manage', subject: 'all' }])],
    ['Edit users and Delete users', only(READ, UPDATE, DELETE)],
    ['Edit users alone', only(READ, UPDATE)],
    ['View users alone', only(READ)],
  ];

  it.each(SWITCH_SETS)('draws no Time clock heading or toggle on desktop with %s', async (_label, ability) => {
    renderWithProviders(<UsersTeamsPage />, { ability });
    await rowOf('Ada Active');
    expect(screen.queryByRole('columnheader', { name: /time clock/i })).toBeNull();
    expect(screen.queryByText(/time clock|enforce location|approve overrides/i)).toBeNull();
    expectNoClockToggles();
  });

  it.each(SWITCH_SETS)('draws no Time clock label or toggle on a phone-width card with %s', async (_label, ability) => {
    windowWidth(393);
    renderWithProviders(<UsersTeamsPage />, { ability });
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(await within(list).findAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/time clock|enforce location|approve overrides/i)).toBeNull();
    expectNoClockToggles();
  });
});

describe('Users & Teams - the same buttons on a phone-width card', () => {
  it('offers Deactivate, Reactivate and Delete by the same two switches', async () => {
    windowWidth(393);
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
    const list = await screen.findByRole('list', { name: 'Users' });
    const [active, inactive] = await within(list).findAllByRole('listitem');
    expect(within(active).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(inactive).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('offers Delete on the inactive card only to a holder of Delete users', async () => {
    windowWidth(393);
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, DELETE) });
    const list = await screen.findByRole('list', { name: 'Users' });
    const [active, inactive] = await within(list).findAllByRole('listitem');
    expect(within(inactive).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(active).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Reactivate' })).toBeNull();
  });
});
