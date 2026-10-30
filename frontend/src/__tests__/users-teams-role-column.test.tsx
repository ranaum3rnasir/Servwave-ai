/**
 * Roles & Permissions, PRD 2, S02.13 - Users & Teams: the role column, the role picker by name, and the confirmation on
 * every role change.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`, the one `settings.routes.tsx` mounts at
 * /settings/users) against the shapes the real routes answer: the users list with each person's role name and number
 * of changes, and the roles list with the built-in and the custom roles. Every viewer is built from the rules under
 * test (Manage roles and permissions, Edit users), never from a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { toast } from '@/components/ui/use-toast';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

/** The default signed-in person of the suite (see setup.ts): their own row is never editable. */
const ME = '00000000-0000-0000-0000-000000000001';

const person = (id: string, first: string, last: string, role: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role,
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
  custom_role_id: null, custom_role: null,
  ...extra,
});

const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 1, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 1, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 0, type: 'system' },
  { role: 'front-desk', label: 'Front desk', fullAccess: false, editable: true, userCount: 0, type: 'custom', id: 'cr-front', base_role: 'SALES' },
  { role: 'bookkeeper', label: 'Bookkeeper', fullAccess: false, editable: true, userCount: 0, type: 'custom', id: 'cr-books', base_role: 'DISPATCHER' },
];

/** Manage roles and permissions with Edit users: the viewer who gets the role picker. */
const MANAGER: AppAbility = buildAbility([
  { action: 'read', subject: 'User' },
  { action: 'update', subject: 'User' },
  { action: 'manage_roles', subject: 'Role' },
]);
/** The Invite user button follows Invite users with Manage roles and permissions (S02.14). */
const INVITER: AppAbility = buildAbility([
  { action: 'read', subject: 'User' },
  { action: 'invite', subject: 'User' },
  { action: 'manage_roles', subject: 'Role' },
]);
/** Edit users without Manage roles and permissions: sees the role as text. */
const USER_EDITOR: AppAbility = buildAbility([
  { action: 'read', subject: 'User' },
  { action: 'update', subject: 'User' },
]);

const DEE = person('u-dee', 'Dee', 'Spatch', 'DISPATCHER', { role_label: 'Dispatcher', change_count: 3 });
const SAM = person('u-sam', 'Sam', 'Seller', 'SALES', { role_label: 'Sales', change_count: 0 });
const ANNA = person('u-anna', 'Anna', 'Admin', 'ADMIN', { role_label: 'Administrator (Owner)', change_count: 0 });
const MINE = person(ME, 'Mia', 'Manager', 'SALES', { role_label: 'Sales', change_count: 0 });
const CLERK = person('u-cleo', 'Cleo', 'Clerk', 'SALES', {
  role_label: 'Front desk', change_count: 1, custom_role_id: 'cr-front', custom_role: { key: 'front-desk', label: 'Front desk' },
});

function serve(users: unknown[], roles: unknown = ROLES) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/roles') return Promise.resolve({ data: roles });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

/** The table row of a person, by their name. */
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  serve([DEE, SAM, ANNA, MINE, CLERK]);
  mockApi.patch.mockResolvedValue({ data: { user: DEE } });
});

describe('Users & Teams - the role column', () => {
  it('reads "<role> · N changes" for a person with changes and just the role name for one without', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: USER_EDITOR });
    expect((await rowOf('Dee Spatch')).textContent).toContain('Dispatcher · 3 changes');
    expect((await rowOf('Cleo Clerk')).textContent).toContain('Front desk · 1 change');
    expect((await rowOf('Cleo Clerk')).textContent).not.toContain('1 changes');
    const sam = (await rowOf('Sam Seller')).textContent ?? '';
    expect(sam).toContain('Sales');
    expect(sam).not.toMatch(/change/i);
  });

  it('shows no raw role code anywhere on the page, for a viewer who edits roles and one who does not', async () => {
    for (const ability of [USER_EDITOR, MANAGER]) {
      const view = renderWithProviders(<UsersTeamsPage />, { ability });
      await screen.findByText('Dee Spatch');
      for (const code of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']) {
        expect(document.body.textContent).not.toContain(code);
      }
      // The Teams tab lists members with their role: the name there too.
      view.unmount();
    }
  });

  it('names a person by the role list when the users list carries no role name yet', async () => {
    serve([{ ...SAM, role_label: undefined, change_count: undefined }]);
    renderWithProviders(<UsersTeamsPage />, { ability: USER_EDITOR });
    expect((await rowOf('Sam Seller')).textContent).toContain('Sales');
    expect(document.body.textContent).not.toContain('SALES');
  });
});

describe('Users & Teams - the role picker', () => {
  it('shows a holder of Manage roles and permissions a picker with every role by name, built-in first, then custom by name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    await rowOf('Dee Spatch');
    await user.click(await screen.findByRole('combobox', { name: 'Role for Dee Spatch' }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(['Administrator (Owner)', 'Sales', 'Dispatcher', 'Technician', 'Bookkeeper', 'Front desk']);
    expect(screen.queryByRole('option', { name: /^(ADMIN|SALES|DISPATCHER|TECHNICIAN)$/ })).toBeNull();
  });

  it('keeps the change count beside the picker', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const row = await rowOf('Dee Spatch');
    expect(within(row).getByRole('combobox', { name: 'Role for Dee Spatch' })).toBeInTheDocument();
    expect(row.textContent).toContain('3 changes');
  });

  it('shows a person with Edit users but not Manage roles and permissions the role as text', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: USER_EDITOR });
    const row = await rowOf('Dee Spatch');
    expect(within(row).queryByRole('combobox', { name: /Role for/ })).toBeNull();
    expect(row.textContent).toContain('Dispatcher');
  });

  it('does not ask for the roles list when the viewer may not read it, and still names every role from the users list', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: USER_EDITOR });
    const row = await rowOf('Cleo Clerk');
    expect(row.textContent).toContain('Front desk');
    expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain('/api/roles');
  });

  it('asks for the roles list when the viewer holds Manage roles and permissions', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    await rowOf('Cleo Clerk');
    expect(mockApi.get.mock.calls.map((c) => c[0])).toContain('/api/roles');
  });

  it("never lets the viewer edit their own row", async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const mine = await rowOf('Mia Manager');
    expect(within(mine).queryByRole('combobox', { name: /Role for/ })).toBeNull();
    expect(mine.textContent).toContain('Sales');
    // Another row of the same page still has its picker.
    expect(within(await rowOf('Sam Seller')).getByRole('combobox', { name: 'Role for Sam Seller' })).toBeInTheDocument();
  });

  it('finds a role by typing part of its name when a company has 120 roles', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      role: `custom-${i}`, label: `Crew role ${String(i).padStart(3, '0')}`, fullAccess: false, editable: true, userCount: 0,
      type: 'custom', id: `cr-${i}`, base_role: 'TECHNICIAN',
    }));
    serve([SAM], [...ROLES.slice(0, 4), ...many]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    await rowOf('Sam Seller');
    await user.click(await screen.findByRole('combobox', { name: 'Role for Sam Seller' }));
    await user.type(await screen.findByPlaceholderText('Search roles'), '087');
    // The list narrows to the roles that match what was typed (a fuzzy match may keep a few more than one).
    const option = await screen.findByRole('option', { name: 'Crew role 087' });
    expect(screen.getAllByRole('option').length).toBeLessThan(10);
    await user.click(option);
    expect(await screen.findByText(/Give Sam Seller the Crew role 087 role\?/)).toBeInTheDocument();
  });
});

describe('Users & Teams - the confirmation on every role change', () => {
  async function pick(name: string, roleLabel: string) {
    const user = userEvent.setup();
    await rowOf(name);
    await user.click(screen.getByRole('combobox', { name: `Role for ${name}` }));
    await user.click(await screen.findByRole('option', { name: roleLabel }));
    return { user, dialog: await screen.findByRole('dialog') };
  }

  it('names the number of changes the new role replaces, for a person who has changes', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { dialog } = await pick('Dee Spatch', 'Sales');
    expect(dialog.textContent).toContain("Dee Spatch has 3 changes from Dispatcher. Giving them the Sales role replaces all their switches with the values of that role.");
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('asks even for a person with no changes, so a misclick moves nobody', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { dialog } = await pick('Sam Seller', 'Dispatcher');
    expect(dialog.textContent).toContain("Give Sam Seller the Dispatcher role? Their switches will be set to the values of that role.");
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('gives no role name a possessive, for a custom role with a long name too', async () => {
    const long = { role: 'regional-dispatch', label: 'Regional dispatch and scheduling coordinators', fullAccess: false, editable: true, userCount: 0, type: 'custom', id: 'cr-long', base_role: 'DISPATCHER' };
    serve([DEE, SAM, ANNA, MINE, CLERK], [...ROLES, long]);
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const withChanges = await pick('Dee Spatch', 'Regional dispatch and scheduling coordinators');
    expect(withChanges.dialog.textContent).not.toMatch(/\w's\b/);
    expect(withChanges.dialog.textContent).toContain('Giving them the Regional dispatch and scheduling coordinators role replaces all their switches with the values of that role.');
    await withChanges.user.click(within(withChanges.dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const none = await pick('Sam Seller', 'Regional dispatch and scheduling coordinators');
    expect(none.dialog.textContent).not.toMatch(/\w's\b/);
    expect(none.dialog.textContent).toContain('Give Sam Seller the Regional dispatch and scheduling coordinators role? Their switches will be set to the values of that role.');
  });

  it('says full access and no switches when the person is moved to Admin', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { dialog } = await pick('Sam Seller', 'Administrator (Owner)');
    expect(dialog.textContent).toMatch(/full access and no switches/i);
  });

  it('sends nothing and leaves the old role when the confirmation is cancelled', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { user, dialog } = await pick('Dee Spatch', 'Sales');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(within(await rowOf('Dee Spatch')).getByRole('combobox', { name: 'Role for Dee Spatch' })).toHaveTextContent('Dispatcher');
  });

  it('sends the built-in role and no custom-role link, and the list then shows the person with no changes', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { user, dialog } = await pick('Cleo Clerk', 'Technician');
    // After the change the server answers with the person on the new role and none of their old changes.
    serve([DEE, SAM, ANNA, MINE, { ...CLERK, role: 'TECHNICIAN', role_label: 'Technician', change_count: 0, custom_role_id: null, custom_role: null }]);
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/users/u-cleo', { role: 'TECHNICIAN', custom_role_id: null }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const row = await rowOf('Cleo Clerk');
    await waitFor(() => expect(row.textContent).not.toMatch(/change/i));
    expect(within(row).getByRole('combobox', { name: 'Role for Cleo Clerk' })).toHaveTextContent('Technician');
  });

  it('sends the custom-role link with its built-in base when a custom role is picked', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { user, dialog } = await pick('Dee Spatch', 'Bookkeeper');
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/users/u-dee', { role: 'DISPATCHER', custom_role_id: 'cr-books' }));
  });

  it('shows the server\'s refusal plainly when the last active admin would be moved off Admin', async () => {
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: 'Cannot remove the last active admin. Assign another admin first.' } } });
    renderWithProviders(<UsersTeamsPage />, { ability: MANAGER });
    const { user, dialog } = await pick('Anna Admin', 'Sales');
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Cannot remove the last active admin. Assign another admin first.' })),
    );
    expect(within(await rowOf('Anna Admin')).getByRole('combobox', { name: 'Role for Anna Admin' })).toHaveTextContent('Administrator (Owner)');
  });
});

describe('Users & Teams - the invite dialog\'s role picker', () => {
  it('lists the roles by name, sends the custom-role link with its base role, and asks nothing on choosing', async () => {
    mockApi.post.mockResolvedValue({ data: { user: SAM, email_sent: true, invite_url: 'x' } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: INVITER });
    await user.click(await screen.findByRole('button', { name: /Invite User/i }));
    for (const [placeholder, value] of [['First name *', 'Pat'], ['Last name *', 'Hall'], ['Email *', 'pat@test.com']] as const) {
      fireEvent.change(await screen.findByPlaceholderText(placeholder), { target: { value } });
    }
    const picker = screen.getByRole('combobox', { name: 'Role' });
    await user.click(picker);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Administrator (Owner)', 'Sales', 'Dispatcher', 'Technician', 'Bookkeeper', 'Front desk',
    ]);
    await user.click(screen.getByRole('option', { name: 'Front desk' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post.mock.calls[0]![0]).toBe('/api/users/invite');
    expect(mockApi.post.mock.calls[0]![1]).toMatchObject({ role: 'SALES', custom_role_id: 'cr-front' });
  });
});
