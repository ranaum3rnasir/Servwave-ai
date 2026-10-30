/**
 * Roles & Permissions ticket 26 - only the Owner changes Admins. On Users & Teams, anyone but the Owner sees the Admin switch
 * and every action on another Admin's row off, each saying why ("Only the Owner can change Admins.") on hover and on tap.
 * The Owner sees them on. A row that is not an Admin keeps its actions, but its Admin switch is off too: making an Admin is
 * the Owner's.
 *
 * Renders the ROUTED page. Who the Owner is comes from the sign-in payload (`org_owner_user_id`); the server refusal (403)
 * is proved against the real routes in backend `permission-owner-changes-admins-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);
const ONLY_THE_OWNER = 'Only the Owner can change Admins.';

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role: 'ADMIN', role_label: 'Admin',
  is_admin: true, admin_box: true, change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null,
  department_id: null, department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  ...extra,
});

const OWNER = person('u-owner', 'Olive', 'Owner');
const VIEWER = person('u-ada', 'Ada', 'Admin');
const ACTIVE_ADMIN = person('u-alex', 'Alex', 'Active');
const INVITED_ADMIN = person('u-ivy', 'Ivy', 'Invited', { has_login: false });
const LEFT_ADMIN = person('u-lee', 'Lee', 'Left', { is_active: false, has_login: false });
const TECH = person('u-tom', 'Tom', 'Tech', { role: 'TECHNICIAN', role_label: 'Technician', is_admin: false, admin_box: false });

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 5, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 1, type: 'system' },
];

const ADMIN_ABILITY = buildAbility([
  { action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }, { action: 'delete', subject: 'User' },
  { action: 'invite', subject: 'User' }, { action: 'manage_roles', subject: 'Role' },
]);

function signedInAs(viewerId: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: viewerId, email: 'viewer@test.com', first_name: 'V', last_name: 'V', role: 'ADMIN', is_admin: true, org_owner_user_id: 'u-owner' },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [OWNER, VIEWER, ACTIVE_ADMIN, INVITED_ADMIN, LEFT_ADMIN, TECH] } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
});

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

/** The control is off and says why: its description, and the hover title of its shell. */
function expectOffWithReason(control: HTMLElement) {
  expect(control).toBeDisabled();
  expect(control.closest('[data-disabled-reason-shell]')).toHaveAttribute('title', ONLY_THE_OWNER);
  const describedBy = control.getAttribute('aria-describedby');
  if (describedBy) expect(document.getElementById(describedBy)?.textContent).toBe(ONLY_THE_OWNER);
}

describe("Users & Teams - only the Owner changes Admins (ticket 26)", () => {
  it("shows an Admin who is not the Owner every Admin control off, with the reason", async () => {
    signedInAs('u-ada');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const active = await rowOf('Alex Active');
    expectOffWithReason(within(active).getByRole('switch', { name: 'Admin: Alex Active' }));
    expectOffWithReason(within(active).getByRole('combobox', { name: 'Role for Alex Active' }));
    for (const name of ['Edit', 'Revoke login', 'Send password reset', 'Deactivate']) {
      expectOffWithReason(within(active).getByRole('button', { name }));
    }
    expectOffWithReason(within(await rowOf('Ivy Invited')).getByRole('button', { name: 'Send invite' }));
    const left = await rowOf('Lee Left');
    for (const name of ['Reactivate', 'Erase personal data', 'Delete']) {
      expectOffWithReason(within(left).getByRole('button', { name }));
    }

    // Someone who is not an Admin keeps their actions; only making them an Admin is off.
    const tech = await rowOf('Tom Tech');
    expectOffWithReason(within(tech).getByRole('switch', { name: 'Admin: Tom Tech' }));
    expect(within(tech).getByRole('combobox', { name: 'Role for Tom Tech' })).toBeEnabled();
    expect(within(tech).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(within(tech).getByRole('button', { name: 'Deactivate' })).toBeEnabled();

    // Their own account stays theirs to edit.
    expect(within(await rowOf('Ada Admin')).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('shows the Owner the same controls on', async () => {
    signedInAs('u-owner');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const active = await rowOf('Alex Active');
    expect(within(active).getByRole('switch', { name: 'Admin: Alex Active' })).toBeEnabled();
    expect(within(active).getByRole('combobox', { name: 'Role for Alex Active' })).toBeEnabled();
    for (const name of ['Edit', 'Revoke login', 'Send password reset', 'Deactivate']) {
      expect(within(active).getByRole('button', { name })).toBeEnabled();
    }
    expect(within(await rowOf('Ivy Invited')).getByRole('button', { name: 'Send invite' })).toBeEnabled();
    const left = await rowOf('Lee Left');
    for (const name of ['Reactivate', 'Erase personal data', 'Delete']) {
      expect(within(left).getByRole('button', { name })).toBeEnabled();
    }
    expect(within(await rowOf('Tom Tech')).getByRole('switch', { name: 'Admin: Tom Tech' })).toBeEnabled();
  });
});
