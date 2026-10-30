/**
 * Roles & Permissions, PRD 2, S02.14 - Users & Teams: inviting follows Invite users.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`, the one `settings.routes.tsx` mounts at
 * /settings/users). The "Invite User" button and each not-yet-joined row's "Send invite" show only to a holder of
 * Invite users AND Manage roles and permissions (every invite sets a role); Create users and Edit users alone no
 * longer show any invite control. Every viewer is built from the rules under test, never from a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
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
  department: null, enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
  custom_role_id: null, custom_role: null,
  ...extra,
});

/** Joined: has a login. Pending: invited-in-name-only, no login yet, so the row offers Send invite. */
const JOINED = person('u-joined', 'Jo', 'Joined');
const PENDING = person('u-pending', 'Pen', 'Pending', { has_login: false });

const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 1, type: 'system' },
  { role: 'front-desk', label: 'Front desk', fullAccess: false, editable: true, userCount: 0, type: 'custom', id: 'cr-front', base_role: 'SALES' },
];

const READ = { action: 'read', subject: 'User' } as const;
const CREATE = { action: 'create', subject: 'User' } as const;
const UPDATE = { action: 'update', subject: 'User' } as const;
const INVITE = { action: 'invite', subject: 'User' } as const;
const MANAGE_ROLES = { action: 'manage_roles', subject: 'Role' } as const;

const only = (...rules: Array<{ action: string; subject: string }>): AppAbility => buildAbility(rules);

function serve() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [JOINED, PENDING] } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  mockApi.post.mockResolvedValue({ data: { user: PENDING, email_sent: true, invite_url: 'x' } });
});

describe('Users & Teams - who is offered an invite', () => {
  it.each([
    ['Create users alone', only(READ, CREATE)],
    ['Create users with Manage roles and permissions', only(READ, CREATE, MANAGE_ROLES)],
    ['Edit users with Create users and Manage roles and permissions', only(READ, UPDATE, CREATE, MANAGE_ROLES)],
    ['Invite users alone', only(READ, INVITE)],
    ['Invite users with Edit users', only(READ, UPDATE, INVITE)],
    ['Manage roles and permissions with Edit users', only(READ, UPDATE, MANAGE_ROLES)],
  ])('shows neither Invite user nor Send invite to a holder of %s', async (_label, ability) => {
    renderWithProviders(<UsersTeamsPage />, { ability });
    const row = await rowOf('Pen Pending');
    expect(screen.queryByRole('button', { name: /invite user/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Send invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send invite' })).toBeNull();
  });

  it('shows both to a holder of Invite users and Manage roles and permissions, whatever else they hold', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, INVITE, MANAGE_ROLES) });
    const row = await rowOf('Pen Pending');
    expect(screen.getByRole('button', { name: /invite user/i })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Send invite' })).toBeInTheDocument();
    // A person who already has a login has nothing to resend.
    expect(within(await rowOf('Jo Joined')).queryByRole('button', { name: 'Send invite' })).toBeNull();
  });

  it('re-sends an invite from the row with Invite users and Manage roles and permissions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, INVITE, MANAGE_ROLES) });
    await user.click(within(await rowOf('Pen Pending')).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-pending/invite'));
  });

  it('opens the invite card for that holder, with the role picker listing every role by name and asking nothing on choosing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, INVITE, MANAGE_ROLES) });
    await user.click(await screen.findByRole('button', { name: /invite user/i }));
    for (const [placeholder, value] of [['First name *', 'Pat'], ['Last name *', 'Hall'], ['Email *', 'pat@test.com']] as const) {
      fireEvent.change(await screen.findByPlaceholderText(placeholder), { target: { value } });
    }
    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Administrator (Owner)', 'Sales', 'Front desk',
    ]);
    await user.click(screen.getByRole('option', { name: 'Front desk' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The pending row carries its own Send invite; the card's is the one beside the fields.
    const card = screen.getByPlaceholderText('First name *').closest('div.grid') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post.mock.calls[0]![0]).toBe('/api/users/invite');
    expect(mockApi.post.mock.calls[0]![1]).toMatchObject({ role: 'SALES', custom_role_id: 'cr-front' });
  });
});
