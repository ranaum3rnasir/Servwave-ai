/**
 * Roles & Permissions, PRD 10, S10.25 - the Email column on the ROUTED Users & Teams page
 * (`pages/v2/settings/UsersTeamsPage`, what `settings.routes.tsx` mounts at /settings/users).
 *
 * The column shows each person's MAILBOX address (never the sign-in email); a holder of Edit users changes it, or sets it
 * for a person marked "Address needed"; a person whose own switches close the Email page is marked "Can't read". The
 * people list is served in the shape `GET /api/users` answers. Words come from the PRD.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';
import { CANT_READ_PERSON_MARK } from '@/lib/api/permissionSwitches';

const mockApi = vi.mocked(api);

// The Email plan feature, switched per test.
const plan = vi.hoisted(() => ({ email: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (key: string) => (key === 'email' ? plan.email : true),
}));
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
// Sees the page, cannot edit anyone.
const READER = buildAbility([{ action: 'read', subject: 'User' }]);

const SUFFIX = '.acme@mail.test.com';
const TAKEN = 'This address is already in use. Choose a different one.';

const person = (id: string, first: string, last: string, over: Record<string, unknown> = {}) => ({
  id, email: `${first.toLowerCase()}@signin.test`, first_name: first, last_name: last, role: 'TECHNICIAN',
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
  mailbox: null, email_page_closed: false, ...over,
});
const active = (address: string) => ({ status: 'active', address, address_suffix: SUFFIX });
const NEEDS = { status: 'address_needed', address: null, address_suffix: SUFFIX };

const LONG = `${'averyveryverylongname'.repeat(2)}.acme@mail.test.com`;
const USERS = [
  person('u1', 'Jane', 'Smith', { mailbox: active('jane.smith.acme@mail.test.com') }),
  person('u2', 'Second', 'Jane', { mailbox: NEEDS }),
  person('u3', 'Cleo', 'Closed', { mailbox: active('cleo.closed.acme@mail.test.com'), email_page_closed: true }),
  person('u4', 'Lou', 'Long', { mailbox: active(LONG) }),
  person('u5', 'Ina', 'Inactive', { is_active: false }),
];

function serve(users: unknown[] = USERS) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

const originalMatchMedia = window.matchMedia;
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? px <= Number(v) : px >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  windowWidth(1400);
  plan.email = true;
  serve();
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

describe('Users & Teams: the Email column', () => {
  it('names the column Email and the sign-in email column Sign-in email, and says which is which', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Jane Smith');
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Sign-in email' })).toBeInTheDocument();
    expect(screen.getByText(/Email is the address customers write to\. Sign-in email is the one a person logs in with/)).toBeInTheDocument();
  });

  it('shows each person\'s mailbox address in the Email column, apart from their sign-in email', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Jane Smith');
    const row = rowOf('Jane Smith');
    const cells = within(row).getAllByRole('cell');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const mailboxCell = cells[headers.indexOf('Email')]!;
    const signInCell = cells[headers.indexOf('Sign-in email')]!;
    expect(within(mailboxCell).getByText('jane.smith.acme@mail.test.com')).toBeInTheDocument();
    expect(mailboxCell).not.toHaveTextContent('jane@signin.test');
    expect(signInCell).toHaveTextContent('jane@signin.test');
    expect(signInCell).not.toHaveTextContent('jane.smith.acme@mail.test.com');
  });

  it('truncates a long address with the whole of it in a title, and offers Copy for it', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Lou Long');
    const address = within(rowOf('Lou Long')).getByText(LONG);
    expect(address).toHaveAttribute('title', LONG);
    expect(address).toHaveClass('truncate');

    await user.click(within(rowOf('Lou Long')).getByRole('button', { name: 'Copy address for Lou Long' }));
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it('shows "Change address" on a person who has one, only to a holder of Edit users', async () => {
    const { unmount } = renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Jane Smith');
    expect(within(rowOf('Jane Smith')).getByRole('button', { name: 'Change address' })).toBeInTheDocument();
    unmount();

    renderWithProviders(<UsersTeamsPage />, { ability: READER });
    await screen.findByText('Jane Smith');
    expect(within(rowOf('Jane Smith')).getByText('jane.smith.acme@mail.test.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change address' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set address' })).toBeNull();
  });

  it('marks a person with no address "Address needed" with "Set address" on the row, and no Change address', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Second Jane');
    const row = rowOf('Second Jane');
    expect(within(row).getByText('Address needed')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Set address' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Change address' })).toBeNull();
    // and nobody with an address is marked
    expect(within(rowOf('Jane Smith')).queryByText('Address needed')).toBeNull();
  });

  it('marks "Can\'t read: Email page is off for this person" only on a person whose switches close the Email page', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Cleo Closed');
    expect(within(rowOf('Cleo Closed')).getByText(CANT_READ_PERSON_MARK)).toBeInTheDocument();
    expect(CANT_READ_PERSON_MARK).toBe("Can't read: Email page is off for this person");
    expect(screen.getAllByText(CANT_READ_PERSON_MARK)).toHaveLength(1);
  });

  it('leaves a deactivated person with no mailbox as a dash, and no mark', async () => {
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Ina Inactive');
    expect(within(rowOf('Ina Inactive')).queryByText('Address needed')).toBeNull();
    expect(within(rowOf('Ina Inactive')).queryByText(/Can't read/)).toBeNull();
  });

  it('shows no Email column in a company without the Email plan feature', async () => {
    plan.email = false;
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Jane Smith');
    expect(screen.queryByRole('columnheader', { name: 'Email' })).toBeNull();
    expect(screen.queryByText('jane.smith.acme@mail.test.com')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change address' })).toBeNull();
  });
});

describe('Users & Teams: setting and changing an address', () => {
  const dialog = () => screen.findByRole('dialog');

  it('Set address: the company part and domain are fixed beside the one field; Save sends only the name part and closes', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { mailbox: { status: 'active', address: 'second.jane.acme@mail.test.com' } } });
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Second Jane');
    await user.click(within(rowOf('Second Jane')).getByRole('button', { name: 'Set address' }));

    const d = await dialog();
    expect(within(d).getByText(SUFFIX)).toBeInTheDocument();
    expect(within(d).getByText(/not the email Second Jane signs in with/)).toBeInTheDocument();
    const save = within(d).getByRole('button', { name: 'Set address' });
    expect(save).toBeDisabled();

    await user.type(within(d).getByLabelText('Address'), 'Second.Jane');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u2/mailbox-address', { name_part: 'second.jane' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Change address: names the current address and says the old one keeps delivering', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { mailbox: { status: 'active', address: 'jsmith.acme@mail.test.com' } } });
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Jane Smith');
    await user.click(within(rowOf('Jane Smith')).getByRole('button', { name: 'Change address' }));

    const d = await dialog();
    expect(within(d).getByText('jane.smith.acme@mail.test.com')).toBeInTheDocument();
    expect(within(d).getByText(/old address keeps delivering/)).toBeInTheDocument();
    await user.type(within(d).getByLabelText('Address'), 'jsmith');
    await user.click(within(d).getByRole('button', { name: 'Change address' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith('/api/users/u1/mailbox-address', { name_part: 'jsmith' }));
  });

  it('refuses a name part that cannot be one as it is typed, with the server\'s rule, and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Second Jane');
    await user.click(within(rowOf('Second Jane')).getByRole('button', { name: 'Set address' }));
    const d = await dialog();

    await user.type(within(d).getByLabelText('Address'), 'jane smith');
    expect(within(d).getByRole('alert')).toHaveTextContent(/Use only letters, numbers and single dots/);
    expect(within(d).getByRole('button', { name: 'Set address' })).toBeDisabled();
    fireEvent.change(within(d).getByLabelText('Address'), { target: { value: 'postmaster' } });
    expect(within(d).getByRole('alert')).toHaveTextContent('This address is reserved.');
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('shows a taken name part under the field in the PRD\'s words and stays open', async () => {
    const user = userEvent.setup();
    mockApi.put.mockRejectedValue(Object.assign(new Error('409'), { response: { status: 409, data: { error: TAKEN } } }));
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Second Jane');
    await user.click(within(rowOf('Second Jane')).getByRole('button', { name: 'Set address' }));
    const d = await dialog();
    await user.type(within(d).getByLabelText('Address'), 'jane.smith');
    await user.click(within(d).getByRole('button', { name: 'Set address' }));

    const alert = await within(d).findByRole('alert');
    expect(alert).toHaveTextContent(TAKEN);
    expect(d).toContainElement(alert);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(d).getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows any other server refusal plainly, with no vendor named', async () => {
    const user = userEvent.setup();
    mockApi.put.mockRejectedValue(Object.assign(new Error('409'), { response: { status: 409, data: { error: "Email addresses aren't set up for this company yet." } } }));
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Second Jane');
    await user.click(within(rowOf('Second Jane')).getByRole('button', { name: 'Set address' }));
    const d = await dialog();
    await user.type(within(d).getByLabelText('Address'), 'second.jane');
    await user.click(within(d).getByRole('button', { name: 'Set address' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent("Email addresses aren't set up for this company yet.");
    expect(d.textContent).not.toMatch(/ctm|calltracking|supabase|render|resend|twilio|stripe/i);
  });
});

describe('Users & Teams at phone width', () => {
  it('puts the address and its marks in the card under the name, wrapping, ahead of the sign-in email', async () => {
    windowWidth(393);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(screen.queryByRole('table')).toBeNull();
    const cards = await within(list).findAllByRole('listitem');

    const cleo = cards.find((c) => within(c).queryByText('Cleo Closed'))!;
    const line = cleo.querySelector('[data-mailbox-line]') as HTMLElement;
    expect(line).not.toBeNull();
    // under the name, before the sign-in email line
    const name = within(cleo).getByText('Cleo Closed');
    const signIn = within(cleo).getByText('cleo@signin.test');
    expect(name.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(line).getByText('cleo.closed.acme@mail.test.com')).toHaveClass('break-all');
    expect(within(line).getByText(CANT_READ_PERSON_MARK).closest('div')).toHaveClass('flex-wrap');
    expect(within(line).getByText('Email (customers write here)')).toBeInTheDocument();

    const second = cards.find((c) => within(c).queryByText('Second Jane'))!;
    expect(within(second).getByText('Address needed')).toBeInTheDocument();
    expect(within(second).getByRole('button', { name: 'Set address' })).toBeInTheDocument();
    const jane = cards.find((c) => within(c).queryByText('Jane Smith'))!;
    expect(within(jane).getByRole('button', { name: 'Change address' })).toBeInTheDocument();
  });
});
