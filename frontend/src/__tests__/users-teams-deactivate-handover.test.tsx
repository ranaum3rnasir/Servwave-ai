/**
 * Roles & Permissions, PRD 10, S10.21 (and PRD 2 story 67c) - the deactivate dialog asks who should get the leaver's email.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`, what `settings.routes.tsx` mounts at /settings/users) with
 * the real data hooks; only the network layer is mocked. The viewer holds Edit users and NOT Delete users, built from the
 * rules under test and never from a role name; the server's side of the same flow (a holder of Edit users without Delete
 * users deactivates, with and without a target) is proved against the real routes in backend
 * `permission-mailbox-handover-db.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

// The Email plan feature, switched per test.
const plan = vi.hoisted(() => ({ email: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (key: string) => (key === 'email' ? plan.email : true),
}));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, extra: Record<string, unknown> = {}) => ({
  id, email: `${id}@test.com`, first_name: first, last_name: last, role: 'SALES', role_label: 'Sales',
  change_count: 0, is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null,
  department: null, created_at: '', updated_at: '', custom_role_id: null, custom_role: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, mailbox: null, email_page_closed: false,
  ...extra,
});

const LEAVER = person('u-leaver', 'Jane', 'Leaver');
const COLLEAGUE = person('u-colleague', 'Cora', 'Colleague');
const FORMER = person('u-former', 'Ian', 'Former', { is_active: false, has_login: false });

// Edit users, not Delete users.
const EDITOR = buildAbility([{ action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }]);

function serve(users: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

async function openDeactivate(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await rowOf(name)).getByRole('button', { name: 'Deactivate' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  plan.email = true;
  mockApi.delete.mockResolvedValue({ data: { message: 'User deactivated' } });
});

describe('the deactivate dialog (a holder of Edit users without Delete users)', () => {
  it('asks "Who should get <name>\'s email?" with "Main mailbox" chosen, and sends that choice', async () => {
    serve([LEAVER, COLLEAGUE, FORMER]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openDeactivate(user, 'Jane Leaver');
    const picker = within(dialog).getByRole('combobox', { name: "Who should get Jane's email?" });
    expect(picker).toHaveTextContent('Main mailbox');

    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-leaver', { data: { handover_to: 'main' } }));
    expect(mockApi.delete).toHaveBeenCalledTimes(1);
  });

  it('offers every active person but not the one leaving or the ones already inactive, and sends the chosen person', async () => {
    serve([LEAVER, COLLEAGUE, FORMER]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openDeactivate(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: "Who should get Jane's email?" }));
    const listed = (await screen.findAllByRole('option')).map((o) => o.textContent?.trim());
    expect(listed).toEqual(['Main mailbox', 'Cora Colleague']);

    await user.click(screen.getByRole('option', { name: 'Cora Colleague' }));
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-leaver', { data: { handover_to: 'u-colleague' } }));
  });

  it('stays usable with a company of 150 people: the picker is searchable and finds one by name', async () => {
    const crowd = Array.from({ length: 150 }, (_, n) => person(`u-${n}`, `Worker${n}`, 'Crowd'));
    serve([LEAVER, ...crowd]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openDeactivate(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: "Who should get Jane's email?" }));
    const search = await screen.findByRole('searchbox');
    expect(screen.getAllByRole('option').length).toBe(151);

    await user.type(search, 'Worker117');
    // The chosen row ("Main mailbox") stays reachable above the matches; every other person is filtered out.
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Main mailbox', 'Worker117 Crowd']);
    await user.click(screen.getByRole('option', { name: 'Worker117 Crowd' }));
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-leaver', { data: { handover_to: 'u-117' } }));
  }, 60_000);

  it('starts every opening on "Main mailbox", whoever was picked the last time', async () => {
    serve([LEAVER, COLLEAGUE]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    let dialog = await openDeactivate(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: "Who should get Jane's email?" }));
    await user.click(await screen.findByRole('option', { name: 'Cora Colleague' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    dialog = await openDeactivate(user, 'Jane Leaver');
    expect(within(dialog).getByRole('combobox', { name: "Who should get Jane's email?" })).toHaveTextContent('Main mailbox');
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('names no email provider and no other vendor', async () => {
    serve([LEAVER, COLLEAGUE]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openDeactivate(user, 'Jane Leaver');
    expect(dialog.textContent ?? '').not.toMatch(/resend|supabase|ctm|calltracking|render|twilio|stripe/i);
  });

  it('leaves the question out when the company\'s plan has no email, and asks for no handover', async () => {
    plan.email = false;
    serve([LEAVER, COLLEAGUE]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openDeactivate(user, 'Jane Leaver');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByText(/email\?/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u-leaver'));
  });
});
