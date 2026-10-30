/**
 * Roles & Permissions AL-16 (ticket 24) - Users & Teams marks the company's Owner and keeps the actions that would remove
 * them off: Revoke login, Deactivate, the Admin switch, and a role change off the Administrator role. Each says why on
 * hover and on tap. Another Admin's row keeps every action.
 *
 * Renders the ROUTED page. Who the Owner is comes from the sign-in payload (`org_owner_user_id`); the server refusal
 * (409 "The Owner can't be removed.") is proved against the real routes in backend `permission-owner-db.test.ts`.
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
const OWNER_REASON = "The Owner can't be removed.";

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role: 'ADMIN', role_label: 'Admin',
  is_admin: true, admin_box: true, change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null,
  department_id: null, department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  ...extra,
});

const OWNER = person('u-owner', 'Olive', 'Owner');
const OTHER_ADMIN = person('u-ada', 'Ada', 'Admin');

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 2, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 0, type: 'system' },
];

// An Admin viewer: every user and role control is theirs.
const ADMIN_ABILITY = buildAbility([
  { action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }, { action: 'delete', subject: 'User' },
  { action: 'invite', subject: 'User' }, { action: 'manage_roles', subject: 'Role' },
]);

function signedInWithOwner(ownerId: string | null, viewerId = '00000000-0000-0000-0000-000000000001') {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: viewerId, email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', is_admin: true, org_owner_user_id: ownerId,
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [OWNER, OTHER_ADMIN] } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
});

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

/** The control is disabled and says why (the reason is its description, and the hover title of its shell). */
function expectOffWithReason(control: HTMLElement) {
  expect(control).toBeDisabled();
  const describedBy = control.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toBe(OWNER_REASON);
  expect(control.closest('[data-disabled-reason-shell]')).toHaveAttribute('title', OWNER_REASON);
}

describe('Users & Teams - the Owner', () => {
  it("marks the Owner's row and keeps every action that would remove them off, with the reason", async () => {
    signedInWithOwner('u-owner');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const owner = await rowOf('Olive Owner');
    expect(within(owner).getByText('Owner')).toBeInTheDocument();
    expectOffWithReason(within(owner).getByRole('button', { name: 'Revoke login' }));
    expectOffWithReason(within(owner).getByRole('button', { name: 'Deactivate' }));
    expectOffWithReason(within(owner).getByRole('switch', { name: 'Admin: Olive Owner' }));
    // On the Administrator role, every other role would take Admin away.
    expectOffWithReason(within(owner).getByRole('combobox', { name: 'Role for Olive Owner' }));
  });

  it('keeps the role picker off for an Owner whose Admin is the flag on a custom role, not the Administrator role name', async () => {
    // Admin is a flag on the person (AL-03), never the Administrator role name: the Owner's role is never changed here,
    // whatever role they sit on.
    const onCustomRole = person('u-owner', 'Olive', 'Owner', {
      role: 'DISPATCHER', role_label: 'Night shift', admin_box: false, custom_role_id: 'r-night', custom_role: { id: 'r-night', key: 'night', label: 'Night shift' },
    });
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/users') return Promise.resolve({ data: { users: [onCustomRole, OTHER_ADMIN] } });
      if (url === '/api/roles') return Promise.resolve({ data: ROLES });
      if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
      return Promise.resolve({ data: {} });
    });
    signedInWithOwner('u-owner');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const owner = await rowOf('Olive Owner');
    expectOffWithReason(within(owner).getByRole('combobox', { name: 'Role for Olive Owner' }));
  });

  it("leaves another Admin's row as it was for the Owner: no badge, every action on", async () => {
    // Acting on another Admin is the Owner's (ticket 26), so the Owner is the one looking.
    signedInWithOwner('u-owner', 'u-owner');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const other = await rowOf('Ada Admin');
    expect(within(other).queryByText('Owner')).toBeNull();
    expect(within(other).getByRole('button', { name: 'Revoke login' })).toBeEnabled();
    expect(within(other).getByRole('button', { name: 'Deactivate' })).toBeEnabled();
    expect(within(other).getByRole('switch', { name: 'Admin: Ada Admin' })).toBeEnabled();
    expect(within(other).getByRole('combobox', { name: 'Role for Ada Admin' })).toBeEnabled();
  });

  it('marks no one when the company has no Owner (and, with no Owner, no one changes an Admin)', async () => {
    signedInWithOwner(null);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    const owner = await rowOf('Olive Owner');
    expect(screen.queryByText('Owner')).toBeNull();
    const deactivate = within(owner).getByRole('button', { name: 'Deactivate' });
    expect(deactivate).toBeDisabled();
    expect(deactivate.closest('[data-disabled-reason-shell]')).toHaveAttribute('title', 'Only the Owner can change Admins.');
  });
});
