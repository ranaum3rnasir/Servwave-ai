/**
 * Roles & Permissions, PRD 10, S10.22 - a holder of Edit users hands a leaver's mailbox on later, from the Users page.
 *
 * Renders the ROUTED page (`@/pages/v2/settings/UsersTeamsPage`, what `settings.routes.tsx` mounts at /settings/users) with
 * the real data hooks; only the network layer is mocked. The viewer holds Edit users and NOT Delete users, built from the
 * rules under test and never from a role name. The server's side (conversations and addresses carried along, the previous
 * holder losing the mailbox on the next request, the refusal without Edit users) is proved against the real routes in
 * backend `permission-mailbox-handover-person-db.test.ts`.
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
  enforce_clock_in_location: false, can_approve_clock_overrides: false, mailbox: null, mailbox_handover: null, email_page_closed: false,
  ...extra,
});

const HEIR = person('u-heir', 'Cora', 'Colleague');
const OTHER = person('u-other', 'Omar', 'Other');
const LEFT = { is_active: false, has_login: false };
const WITH_HEIR = person('u-leaver', 'Jane', 'Leaver', { ...LEFT, mailbox_handover: { to: 'person', user_id: 'u-heir', name: 'Cora Colleague' } });
const IN_MAIN = person('u-merged', 'Ian', 'Merged', { ...LEFT, mailbox_handover: { to: 'main' } });

// Edit users, not Delete users.
const EDITOR = buildAbility([{ action: 'read', subject: 'User' }, { action: 'update', subject: 'User' }]);
const READER = buildAbility([{ action: 'read', subject: 'User' }]);

function serve(users: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

async function openMove(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await rowOf(name)).getByRole('button', { name: 'Move mailbox' }));
  return screen.findByRole('dialog');
}

const PICKER = "Who should get Jane's email?";

beforeEach(() => {
  vi.clearAllMocks();
  plan.email = true;
  mockApi.put.mockResolvedValue({ data: { moved: true } });
});

describe('the Users page says where a leaver\'s mailbox is', () => {
  it('names the person who holds it, or the main mailbox, on the leaver\'s row', async () => {
    serve([HEIR, WITH_HEIR, IN_MAIN]);
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    expect(within(await rowOf('Jane Leaver')).getByText('With Cora Colleague')).toBeInTheDocument();
    expect(within(await rowOf('Ian Merged')).getByText('In the main mailbox')).toBeInTheDocument();
    expect(within(await rowOf('Cora Colleague')).queryByText(/^With |In the main mailbox/)).toBeNull();
  });
});

describe('Move mailbox (a holder of Edit users without Delete users)', () => {
  it('offers the control on a leaver whose mailbox was handed on, and on nobody else', async () => {
    const noMailbox = person('u-nobox', 'Nora', 'Nobox', LEFT);
    serve([HEIR, WITH_HEIR, IN_MAIN, noMailbox]);
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    expect(within(await rowOf('Jane Leaver')).getByRole('button', { name: 'Move mailbox' })).toBeInTheDocument();
    expect(within(await rowOf('Ian Merged')).getByRole('button', { name: 'Move mailbox' })).toBeInTheDocument();
    expect(within(await rowOf('Cora Colleague')).queryByRole('button', { name: 'Move mailbox' })).toBeNull();
    expect(within(await rowOf('Nora Nobox')).queryByRole('button', { name: 'Move mailbox' })).toBeNull();
  });

  it('does not offer it to a viewer without Edit users, or when the plan has no email', async () => {
    serve([HEIR, WITH_HEIR]);
    const first = renderWithProviders(<UsersTeamsPage />, { ability: READER });
    await rowOf('Jane Leaver');
    expect(screen.queryByRole('button', { name: 'Move mailbox' })).toBeNull();
    first.unmount();

    plan.email = false;
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    await rowOf('Jane Leaver');
    expect(screen.queryByRole('button', { name: 'Move mailbox' })).toBeNull();
  });

  it('opens on where the mailbox is now, keeps Move off until another answer is picked, and sends "main"', async () => {
    serve([HEIR, OTHER, WITH_HEIR]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openMove(user, 'Jane Leaver');
    expect(within(dialog).getByRole('heading', { name: /^Move Jane Leaver.s mailbox$/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: PICKER })).toHaveTextContent('Cora Colleague');
    expect(within(dialog).getByRole('button', { name: 'Move mailbox' })).toBeDisabled();

    await user.click(within(dialog).getByRole('combobox', { name: PICKER }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent?.trim())).toEqual(['Main mailbox', 'Cora Colleague', 'Omar Other']);
    await user.click(screen.getByRole('option', { name: 'Main mailbox' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move mailbox' }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u-leaver/mailbox-handover', { handover_to: 'main' }));
    expect(mockApi.put).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('moves a mailbox that sits in the main mailbox to a person', async () => {
    serve([HEIR, OTHER, IN_MAIN]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openMove(user, 'Ian Merged');
    const picker = within(dialog).getByRole('combobox', { name: "Who should get Ian's email?" });
    expect(picker).toHaveTextContent('Main mailbox');
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Omar Other' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move mailbox' }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u-merged/mailbox-handover', { handover_to: 'u-other' }));
  });

  it('stays usable with a company of 150 people: the picker is searchable and finds one by name', async () => {
    const crowd = Array.from({ length: 150 }, (_, n) => person(`u-${n}`, `Worker${n}`, 'Crowd'));
    serve([WITH_HEIR, HEIR, ...crowd]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openMove(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: PICKER }));
    const search = await screen.findByRole('searchbox');
    expect(screen.getAllByRole('option').length).toBe(152);

    await user.type(search, 'Worker117');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.trim())).toEqual(['Cora Colleague', 'Worker117 Crowd']);
    await user.click(screen.getByRole('option', { name: 'Worker117 Crowd' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move mailbox' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u-leaver/mailbox-handover', { handover_to: 'u-117' }));
  }, 60_000);

  it('starts every opening on where the mailbox is, whoever was picked the last time', async () => {
    serve([HEIR, OTHER, WITH_HEIR]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    let dialog = await openMove(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: PICKER }));
    await user.click(await screen.findByRole('option', { name: 'Omar Other' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    dialog = await openMove(user, 'Jane Leaver');
    expect(within(dialog).getByRole('combobox', { name: PICKER })).toHaveTextContent('Cora Colleague');
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('keeps the dialog open when the server refuses, so the pick can be changed', async () => {
    serve([HEIR, OTHER, WITH_HEIR]);
    mockApi.put.mockRejectedValue({ response: { status: 400, data: { error: 'Choose an active person in your company, or the main mailbox, to receive this email.' } } });
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });

    const dialog = await openMove(user, 'Jane Leaver');
    await user.click(within(dialog).getByRole('combobox', { name: PICKER }));
    await user.click(await screen.findByRole('option', { name: 'Omar Other' }));
    await user.click(within(dialog).getByRole('button', { name: 'Move mailbox' }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('names no email provider and no other vendor', async () => {
    serve([HEIR, WITH_HEIR, IN_MAIN]);
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: EDITOR });
    const dialog = await openMove(user, 'Jane Leaver');
    const vendors = /resend|supabase|ctm|calltracking|render|twilio|stripe/i;
    expect(dialog.textContent ?? '').not.toMatch(vendors);
    expect((await rowOf('Ian Merged')).textContent ?? '').not.toMatch(vendors);
  });
});
