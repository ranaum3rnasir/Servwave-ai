/**
 * Security finding H2, build item 10 (ticket 22): when Revoke can't remove a person's login, the Admin sees the error, never
 * "done", and the row shows what the server holds.
 *
 * Renders the ROUTED page as an Admin. The server's answer (502 with ServWave's own words, nothing changed) is proved against
 * the real route in backend `permission-revoke-locks-out-db.test.ts`; here the screen shows it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

// The server's own words for a failed revoke (backend user.controller REVOKE_LOGIN_FAILED_MESSAGE).
const FAILED = "Could not revoke this person's login. They can still sign in. Please try again.";

const SAM = {
  id: 'u-sam', email: 'sam@test.com', first_name: 'Sam', last_name: 'Seller', role: 'SALES', role_label: 'Sales',
  is_admin: false, admin_box: false, change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null,
  department_id: null, department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
};

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 1, type: 'system' },
];

const ADMIN_ABILITY = buildAbility([
  { action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }, { action: 'delete', subject: 'User' },
  { action: 'invite', subject: 'User' }, { action: 'manage_roles', subject: 'Role' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', is_admin: true, org_owner_user_id: '00000000-0000-0000-0000-000000000001',
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [SAM] } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
});

async function revokeSam() {
  const user = userEvent.setup();
  renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });
  const row = (await screen.findByText('Sam Seller')).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Revoke login' }));
  const dialog = await screen.findByRole('dialog');
  const usersReads = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/users').length;
  const readsBefore = usersReads();
  await user.click(within(dialog).getByRole('button', { name: 'Revoke login' }));
  return { readsBefore, usersReads };
}

describe('Users & Teams - Revoke login that fails', () => {
  it("shows the server's error and nothing that says it worked; the list is read again", async () => {
    mockApi.post.mockRejectedValue({ response: { status: 502, data: { error: FAILED } } });
    const { readsBefore, usersReads } = await revokeSam();

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-sam/revoke-login'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ description: FAILED, variant: 'destructive' })),
    );
    // Nothing on screen claims success.
    for (const [arg] of mockToast.mock.calls) expect((arg as { variant?: string }).variant).toBe('destructive');
    // The row is read again, so it shows the login the person still has.
    await waitFor(() => expect(usersReads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('with no answer from the server it says it may not have finished, never the raw network text', async () => {
    mockApi.post.mockRejectedValue(new Error('Network Error'));
    await revokeSam();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Revoke login may not have finished. Check the list and try again.', variant: 'destructive' }),
      ),
    );
    expect(JSON.stringify(mockToast.mock.calls)).not.toMatch(/Network Error|supabase/i);
  });
});

describe('Users & Teams - a revoke that did not finish', () => {
  const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;
  const serve = (users: unknown[]) =>
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/users') return Promise.resolve({ data: { users } });
      if (url === '/api/roles') return Promise.resolve({ data: ROLES });
      if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
      return Promise.resolve({ data: {} });
    });

  it('still offers Revoke login, so "Please try again" can be done, and sends it again', async () => {
    serve([{ ...SAM, has_login: false, revoke_pending: true }]);
    mockApi.post.mockResolvedValue({ data: { user: { ...SAM, has_login: false, revoke_pending: false } } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    await user.click(within(await rowOf('Sam Seller')).getByRole('button', { name: 'Revoke login' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke login' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-sam/revoke-login'));
  });

  it('offers no Revoke login for a person with no login and nothing unfinished', async () => {
    serve([{ ...SAM, has_login: false, revoke_pending: false }]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_ABILITY });

    expect(within(await rowOf('Sam Seller')).queryByRole('button', { name: 'Revoke login' })).toBeNull();
  });
});
