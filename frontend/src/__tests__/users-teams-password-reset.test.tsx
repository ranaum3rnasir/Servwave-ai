/**
 * Password reset spec §7 (slice 07): an admin sends a password reset from Users & Teams.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`). Seams: which rows offer the
 * action for which viewer, the confirm dialog's words, the request it makes, and the toast the admin
 * sees. Every viewer is built from the rules under test, never from a role name. The server side
 * (403 without update User, 400 for no login or deactivated, the per-email limit) is proved in
 * backend `admin-password-reset.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { buildAbility, type AppAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@example.test`, first_name: first, last_name: last, role: 'SALES', role_label: 'Sales',
  change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null,
  department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  ...extra,
});

const ACTIVE = person('u-active', 'Ada', 'Active');
const NO_LOGIN = person('u-nologin', 'Nell', 'Nologin', { has_login: false });
const INACTIVE = person('u-inactive', 'Ian', 'Inactive', { is_active: false, has_login: false });
// An older deactivated row still flagged with a login: the action follows "active" too.
const INACTIVE_WITH_LOGIN = person('u-inactive-login', 'Ida', 'Inactive', { is_active: false, has_login: true });

const ROLES = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 2, type: 'system' },
];

const READ = { action: 'read', subject: 'User' } as const;
const UPDATE = { action: 'update', subject: 'User' } as const;
const DELETE = { action: 'delete', subject: 'User' } as const;
const INVITE = { action: 'invite', subject: 'User' } as const;
const only = (...rules: Array<{ action: string; subject: string }>): AppAbility => buildAbility(rules);

const ACTION = 'Send password reset';
const FALLBACK = "We couldn't send the email. Try again or contact ServWave support.";

function serve(users: unknown[] = [ACTIVE, NO_LOGIN, INACTIVE, INACTIVE_WITH_LOGIN]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  mockApi.post.mockResolvedValue({ data: { ok: true, email: ACTIVE.email } });
});

async function openDialogFor(name: string) {
  const user = userEvent.setup();
  renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });
  await user.click(within(await rowOf(name)).getByRole('button', { name: ACTION }));
  return { user, dialog: await screen.findByRole('dialog') };
}

describe('Users & Teams - who is offered "Send password reset"', () => {
  it('a holder of Edit users sees it on an active user with a login, and on no other row', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: only(READ, UPDATE) });

    expect(within(await rowOf('Ada Active')).getByRole('button', { name: ACTION })).toBeInTheDocument();
    expect(within(await rowOf('Nell Nologin')).queryByRole('button', { name: ACTION })).toBeNull();
    expect(within(await rowOf('Ian Inactive')).queryByRole('button', { name: ACTION })).toBeNull();
    expect(within(await rowOf('Ida Inactive')).queryByRole('button', { name: ACTION })).toBeNull();
  });

  it.each([
    ['read only', only(READ)],
    ['Delete users without Edit users', only(READ, DELETE)],
    ['Invite users without Edit users', only(READ, INVITE)],
  ])('a viewer with %s never sees it', async (_label, ability) => {
    renderWithProviders(<UsersTeamsPage />, { ability });

    await rowOf('Ada Active');
    expect(screen.queryByRole('button', { name: ACTION })).toBeNull();
  });
});

describe('Users & Teams - the "Send password reset" confirmation', () => {
  it('names the person and their email, says the old password keeps working, and sends nothing yet', async () => {
    const { dialog } = await openDialogFor('Ada Active');

    expect(dialog).toHaveTextContent(
      'Send a password reset link to Ada Active at ada@example.test? Their current password keeps working until they set a new one.',
    );
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('Cancel closes it and sends nothing', async () => {
    const { user, dialog } = await openDialogFor('Ada Active');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('shows a name with markup in it as plain text', async () => {
    serve([person('u-markup', '<b>Bo</b>', 'Tags')]);
    const { dialog } = await openDialogFor('<b>Bo</b> Tags');

    expect(dialog).toHaveTextContent('Send a password reset link to <b>Bo</b> Tags at');
    expect(dialog.querySelector('b')).toBeNull();
  });
});

describe('Users & Teams - sending the reset link', () => {
  it('confirming asks the server to send it for that person, and says where it went', async () => {
    const { user, dialog } = await openDialogFor('Ada Active');

    await user.click(within(dialog).getByRole('button', { name: 'Send link' }));

    // Its failures get this page's own toast only, not the app-wide rate-limit toast as well.
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u-active/password-reset', undefined, { silentErrors: true }));
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith({ title: 'Reset link sent to ada@example.test.' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("shows the server's message when the send is refused", async () => {
    const message =
      'This person has been sent 3 reset links in the last 15 minutes. Ask them to use the newest email, or try again in a few minutes.';
    mockApi.post.mockRejectedValue({ response: { status: 429, data: { error: message, code: 'reset_link_limit' } } });
    const { user, dialog } = await openDialogFor('Ada Active');

    await user.click(within(dialog).getByRole('button', { name: 'Send link' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ description: message, variant: 'destructive' })),
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Reset link sent/) }));
  });

  it("says plainly when the admin has sent too many links, rather than a bare 'Too many requests'", async () => {
    mockApi.post.mockRejectedValue({ response: { status: 429, data: { error: 'Too many requests', retryAfter: 900 } } });
    const { user, dialog } = await openDialogFor('Ada Active');

    await user.click(within(dialog).getByRole('button', { name: 'Send link' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "You've sent a lot of reset links in the last 15 minutes. Try again in a few minutes.",
          variant: 'destructive',
        }),
      ),
    );
  });

  it('shows the ServWave fallback when the server gave no message, never the raw network text', async () => {
    mockApi.post.mockRejectedValue(new Error('Network Error'));
    const { user, dialog } = await openDialogFor('Ada Active');

    await user.click(within(dialog).getByRole('button', { name: 'Send link' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ description: FALLBACK, variant: 'destructive' })),
    );
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain('Network Error');
  });
});
