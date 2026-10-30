/**
 * Roles & Permissions alignment, AL-13b (P19, A5): an Admin can erase a deactivated person's personal data from the Users page;
 * an erased person has no Reactivate, Erase or Delete and is badged. The server side is proved against the real routes in
 * backend `permission-erase-personal-data-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@test.com`, first_name: first, last_name: last, role: 'SALES', role_label: 'Sales',
  change_count: 0, is_active: true, has_login: false, phone: '', phone_ext: null, department_id: null,
  department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, mailbox: null, email_page_closed: false,
  erased_at: null, ...extra,
});
const FORMER = person('u-former', 'Ian', 'Former', { is_active: false });
const ERASED = person('u-erased', 'Former', 'user', { is_active: false, erased_at: '2026-10-17T00:00:00Z' });

const ADMIN_RULES = buildAbility([{ action: 'manage', subject: 'all' }]);

function signInAs(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'me', role: 'ADMIN', is_admin: isAdmin }, isAuthenticated: true, isLoading: false, error: null })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [FORMER, ERASED] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
  mockApi.post.mockResolvedValue({ data: { message: 'Personal data erased' } });
});

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('Erase personal data on the Users page', () => {
  it('is offered to an Admin on a deactivated person, asks first, and sends the erase', async () => {
    signInAs(true);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_RULES });
    await user.click(within(await rowOf('Ian Former')).getByRole('button', { name: 'Erase personal data' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Their records stay and show them as Former user. They can’t be reactivated.');
    expect(mockApi.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Erase personal data' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-former/erase-personal-data'));
  });

  it('is not offered to someone who is not an Admin', async () => {
    signInAs(false);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_RULES });
    const row = await rowOf('Ian Former');
    expect(within(row).queryByRole('button', { name: 'Erase personal data' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
  });

  it('shows an erased person as Former user with an Erased badge and no way back: no Reactivate, Erase or Delete', async () => {
    signInAs(true);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN_RULES });
    const row = await rowOf('Former user');
    expect(within(row).getByText('Erased')).toBeInTheDocument();
    for (const name of ['Reactivate', 'Erase personal data', 'Delete']) {
      expect(within(row).queryByRole('button', { name })).toBeNull();
    }
  });
});
