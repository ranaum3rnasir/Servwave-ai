/**
 * Roles & Permissions ticket 27 (D1) - Make Owner on Users & Teams. Only the Owner sees it, and only on a row the server marks
 * as able to become the Owner (`owner_eligible`: an active Admin who has signed in). Pressing it confirms first, then the
 * request goes to the server and the screen says to check email: nothing changes until the Owner opens the emailed link. A
 * refusal shows the server's words.
 *
 * Who the Owner is comes from the sign-in payload (`org_owner_user_id`); the server side is proved against the real routes in
 * backend `permission-make-owner-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role: 'ADMIN', role_label: 'Admin',
  is_admin: true, admin_box: true, change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null,
  department_id: null, department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  owner_eligible: false, ...extra,
});

const OWNER = person('u-owner', 'Olive', 'Owner');
const ELIGIBLE = person('u-bea', 'Bea', 'Ready', { owner_eligible: true });
const NEVER_SIGNED_IN = person('u-ned', 'Ned', 'New');
const TECH = person('u-tom', 'Tom', 'Tech', { role: 'TECHNICIAN', role_label: 'Technician', is_admin: false, admin_box: false });

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 3, type: 'system' },
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

function listing(users: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listing([OWNER, ELIGIBLE, NEVER_SIGNED_IN, TECH]);
});

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;
const makeOwnerIn = (row: HTMLElement) => within(row).queryByRole('button', { name: 'Make Owner' });

describe('Users & Teams - Make Owner (ticket 27)', () => {
  it('the Owner sees Make Owner, enabled, only on rows that can become the Owner', async () => {
    signedInAs('u-owner');
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });
    expect(makeOwnerIn(await rowOf('Bea Ready'))).toBeEnabled();
    expect(makeOwnerIn(await rowOf('Ned New'))).toBeNull();
    expect(makeOwnerIn(await rowOf('Tom Tech'))).toBeNull();
    expect(makeOwnerIn(await rowOf('Olive Owner'))).toBeNull();
  });

  it('anyone but the Owner never sees it, even on a row marked eligible', async () => {
    signedInAs('u-bea');
    listing([OWNER, ELIGIBLE, person('u-cal', 'Cal', 'Other', { owner_eligible: true })]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });
    await rowOf('Cal Other');
    expect(screen.queryByRole('button', { name: 'Make Owner' })).toBeNull();
  });

  it('confirms, asks the server, then tells the Owner to check their email; nothing is sent on Cancel', async () => {
    signedInAs('u-owner');
    mockApi.post.mockResolvedValue({ data: { email_sent: true } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    await user.click(makeOwnerIn(await rowOf('Bea Ready'))!);
    expect(await screen.findByText(/Make Bea Ready the Owner\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.post).not.toHaveBeenCalled();

    await user.click(makeOwnerIn(await rowOf('Bea Ready'))!);
    await user.click(await screen.findByRole('button', { name: 'Email me the link' }));
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-bea/make-owner', undefined, { silentErrors: true });
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(screen.getByText(/Nothing changes until\s+you open it/)).toBeInTheDocument();
  });

  it("shows the server's refusal in the dialog", async () => {
    signedInAs('u-owner');
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'Only an active Admin who has signed in can become the Owner.' } } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });
    await user.click(makeOwnerIn(await rowOf('Bea Ready'))!);
    await user.click(await screen.findByRole('button', { name: 'Email me the link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only an active Admin who has signed in can become the Owner.');
    expect(screen.queryByText('Check your email')).toBeNull();
  });
});
