/**
 * Roles & Permissions alignment, AL-13a (P19): the deactivate dialog says what the person still has open and lets an Admin
 * move it to someone else first. Deactivating itself changes no record. The server side is proved against the real routes in
 * backend `permission-deactivation-keeps-data-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';
import { toast } from '@/components/ui/use-toast';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string) => ({
  id, email: `${id}@test.com`, first_name: first, last_name: last, role: 'SALES', role_label: 'Sales',
  change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null,
  department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, mailbox: null, email_page_closed: false,
});
const LEAVER = person('u-leaver', 'Jane', 'Leaver');
const COLLEAGUE = person('u-colleague', 'Cora', 'Colleague');

const SUMMARY = {
  person: { id: 'u-leaver', first_name: 'Jane', last_name: 'Leaver', is_active: true },
  modules: [
    { key: 'tasks', label: 'Tasks', open: 3 },
    { key: 'leads', label: 'Leads', open: 1 },
    { key: 'jobs', label: 'Jobs', open: 0 },
  ],
  total: 4,
};

const EDITOR = buildAbility([{ action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }]);

function serve(summary: unknown) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [LEAVER, COLLEAGUE] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users/u-leaver/deactivation-summary') return Promise.resolve({ data: summary });
    return Promise.resolve({ data: {} });
  });
}

function signInAs(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'me', role: 'ADMIN', is_admin: isAdmin }, isAuthenticated: true, isLoading: false, error: null })) as never);
}

async function openDeactivate(user: ReturnType<typeof userEvent.setup>) {
  const row = (await screen.findByText('Jane Leaver')).closest('tr') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Deactivate' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.delete.mockResolvedValue({ data: { message: 'User deactivated' } });
  mockApi.post.mockResolvedValue({ data: { moved: { tasks: 3, leads: 1, jobs: 0 }, skipped: { tasks: 0, leads: 0, jobs: 0 } } });
});

describe('the deactivate dialog and the person\'s open records', () => {
  it('says how many open tasks, leads and jobs still name them, leaving out a module with none, and that the name stays marked', async () => {
    serve(SUMMARY);
    signInAs(false);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Jane still has 3 open tasks, 1 open lead. Their name stays on them, marked Deactivated.');
  });

  it('says nothing when the person has nothing open', async () => {
    serve({ ...SUMMARY, modules: SUMMARY.modules.map((m) => ({ ...m, open: 0 })), total: 0 });
    signInAs(true);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/users/u-leaver/deactivation-summary'));
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
  });

  it('offers a move only to an Admin, and a person who is not an Admin only reads the numbers', async () => {
    serve(SUMMARY);
    signInAs(false);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    await within(dialog).findByRole('status');
    expect(within(dialog).queryByRole('combobox', { name: 'Move their open records to' })).toBeNull();
  });

  it('leaves the records alone by default: deactivating sends no reassign', async () => {
    serve(SUMMARY);
    signInAs(true);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    expect(await within(dialog).findByRole('combobox', { name: 'Move their open records to' })).toHaveTextContent('Leave them as they are');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('for an Admin who picks someone, moves the modules that have open records first, then deactivates', async () => {
    serve(SUMMARY);
    signInAs(true);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    await user.click(await within(dialog).findByRole('combobox', { name: 'Move their open records to' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent?.trim())).toEqual(['Leave them as they are', 'Cora Colleague']);
    await user.click(screen.getByRole('option', { name: 'Cora Colleague' }));
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-leaver/reassign', { to_user_id: 'u-colleague', modules: ['tasks', 'leads'] });
    expect(mockApi.post.mock.invocationCallOrder[0]!).toBeLessThan(mockApi.delete.mock.invocationCallOrder[0]!);
  });

  it('does not deactivate when the move was refused', async () => {
    serve(SUMMARY);
    signInAs(true);
    mockApi.post.mockRejectedValue({ response: { status: 403, data: { error: 'Only an Admin can reassign' } } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    await user.click(await within(dialog).findByRole('combobox', { name: 'Move their open records to' }));
    await user.click(await screen.findByRole('option', { name: 'Cora Colleague' }));
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  // Pre-PR review CR-5: a status never claims success for a failure. Records the person taking over could not hold stay with the
  // leaver, and the Admin is told how many, by module.
  async function moveTo(skipped: { tasks: number; leads: number; jobs: number }) {
    serve(SUMMARY);
    signInAs(true);
    mockApi.post.mockResolvedValue({ data: { moved: { tasks: 3, leads: 0, jobs: 0 }, skipped } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user);
    await user.click(await within(dialog).findByRole('combobox', { name: 'Move their open records to' }));
    await user.click(await screen.findByRole('option', { name: 'Cora Colleague' }));
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
  }

  it('tells the Admin how many open records could not be moved', async () => {
    await moveTo({ tasks: 0, leads: 1, jobs: 2 });
    const told = vi.mocked(toast).mock.calls.map(([t]) => t as { title?: string; description?: string });
    const warning = told.find((t) => /not moved/i.test(t.title ?? ''));
    expect(warning?.description).toMatch(/1 open lead, 2 open jobs/);
  });

  it('says nothing more when everything moved', async () => {
    await moveTo({ tasks: 0, leads: 0, jobs: 0 });
    const told = vi.mocked(toast).mock.calls.map(([t]) => t as { title?: string });
    expect(told.some((t) => /not moved/i.test(t.title ?? ''))).toBe(false);
  });
});
