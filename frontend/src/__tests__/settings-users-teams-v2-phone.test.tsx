/**
 * Phone capture on the ROUTED Users & Teams screen (Spec C slice 2).
 *
 * This file imports `@/pages/v2/settings/UsersTeamsPage`, which is what
 * `pages/v2/routes/settings.routes.tsx` mounts at /settings/users. The older
 * suite `users-teams-page.test.tsx` imports `@/pages/settings/UsersTeamsPage`,
 * a dead v1 fork nothing routes - a gate written there is green against a page
 * no admin ever opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/v2/settings/UsersTeamsPage';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const USER = {
  id: 'u1',
  email: 'tess@test.com',
  first_name: 'Tess',
  last_name: 'Tech',
  role: 'TECHNICIAN',
  is_active: true,
  has_login: true,
  phone: '+15551112222',
  phone_ext: null,
  department_id: null,
  department: null,
  enforce_clock_in_location: true,
  can_approve_clock_overrides: false,
  created_at: '',
  updated_at: '',
};

function mockUsers(users: unknown[]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUsers([USER]);
  mockApi.patch.mockResolvedValue({ data: { user: USER } });
  mockApi.post.mockResolvedValue({ data: { user: USER, email_sent: true, invite_url: 'x' } });
});

/** Type into a controlled (masked) input the way a paste would - one change event
 *  rather than one re-render of the whole users table per keystroke. */
function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

async function openInvite(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Invite User/i }));
  await screen.findByPlaceholderText('First name *');
  fill('First name *', 'Pat');
  fill('Last name *', 'Hall');
  fill('Email *', 'pat@test.com');
}

describe('v2 Users & Teams - the invite card refuses an unusable phone at entry', () => {
  it('disables Send invite and explains why, sending nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openInvite(user);

    fill('Phone', '555');

    expect(
      await screen.findByText(/10-digit US or Canadian phone number/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeDisabled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('sends a usable number in E.164 form, with the extension the card now asks for', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openInvite(user);

    fill('Phone', '5551112222');
    fill('Extension', '12');
    // The box still SHOWS the mask - only what leaves the page is normalized.
    expect(screen.getByPlaceholderText('Phone')).toHaveValue('(555) 111-2222');
    expect(screen.queryByText(/10-digit US or Canadian phone number/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [url, payload] = mockApi.post.mock.calls[0];
    expect(url).toBe('/api/users/invite');
    expect(payload).toMatchObject({ phone: '+15551112222', phone_ext: '12' });
  });

  it('invites a user with no phone at all - the field stays optional', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openInvite(user);

    expect(screen.queryByText(/10-digit US or Canadian phone number/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send invite' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ phone: null, phone_ext: null });
  });
});

// The stored column predates normalization and really does hold numbers the API
// now refuses. Those rows must not become uneditable.
const LEGACY = { ...USER, id: 'u2', first_name: 'Lee', last_name: 'Gacy', phone: '555-0188', phone_ext: null };

describe('v2 Users & Teams - the edit dialog cannot lock an admin out of a legacy row', () => {
  async function openEdit(user: ReturnType<typeof userEvent.setup>) {
    await user.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    await screen.findByText('Edit details');
  }

  it('sends NO phone key when only the name was changed on a user whose stored number is unusable', async () => {
    const user = userEvent.setup();
    mockUsers([LEGACY]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openEdit(user);

    // The dialog seeds from the stored value, so it shows the legacy spelling.
    expect(screen.getByPlaceholderText('Phone')).toHaveValue('555-0188');

    fill('Last name *', 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const [url, payload] = mockApi.patch.mock.calls[0];
    expect(url).toBe('/api/users/u2');
    expect(payload).toMatchObject({ last_name: 'Renamed' });
    // Unconditionally re-sending the seeded phone is what would 400 the whole
    // save and make the NAME unfixable until the phone was fixed too.
    expect(payload).not.toHaveProperty('phone');
    expect(payload).not.toHaveProperty('phone_ext');
  });

  it('blocks the save and explains itself once the admin actually types an unusable number', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openEdit(user);

    fill('Phone', '555');

    expect(await screen.findByText(/10-digit US or Canadian phone number/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('sends the edited number in E.164 form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openEdit(user);

    fill('Phone', '5559998888');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch.mock.calls[0][1]).toMatchObject({ phone: '+15559998888' });
  });

  it('reopens on a stored E.164 number showing it human-readable, not raw', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await openEdit(user);
    expect(screen.getByPlaceholderText('Phone')).toHaveValue('(555) 111-2222');
  });
});

describe('v2 Users & Teams - the roster still reads as a phone book', () => {
  it('renders a stored E.164 number formatted, with the extension appended', async () => {
    mockUsers([{ ...USER, phone_ext: '12' }]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    expect(await screen.findByText('(555) 111-2222 x12')).toBeInTheDocument();
  });
});

/**
 * Spec C slice 4 - the roster is where an admin finds out who cannot be texted.
 *
 * A bare dash reads as "nothing to say here". The table already owns a
 * missing-data idiom two cells to the left ("No login"), so the gap is stated
 * in the same words rather than in a new visual language.
 */
const NO_PHONE = { ...USER, id: 'u3', first_name: 'Nora', last_name: 'Nonumber', phone: null, phone_ext: null };
const INACTIVE_NO_PHONE = { ...USER, id: 'u4', first_name: 'Ira', last_name: 'Inactive', is_active: false, phone: null, phone_ext: null };

/** The Phone column is the third cell; scoping to it keeps the assertions off
 *  the Team cell, which prints its own bare dash for an unteamed user. */
async function phoneCell(name: string) {
  const row = (await screen.findByText(name)).closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row.querySelectorAll('td')[2];
}

describe('v2 Users & Teams - a person with no number is stated, not dashed', () => {
  it('badges the gap instead of printing a bare dash', async () => {
    mockUsers([NO_PHONE]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });

    const cell = await phoneCell('Nora Nonumber');
    expect(cell).toHaveTextContent('No phone');
    expect(cell.textContent).not.toContain('-');
  });

  it('leaves a user who HAS a number showing the number, with no badge', async () => {
    mockUsers([{ ...USER, phone_ext: '12' }]);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });

    const cell = await phoneCell('Tess Tech');
    expect(cell).toHaveTextContent('(555) 111-2222 x12');
    expect(cell.textContent).not.toContain('No phone');
  });
});

/**
 * The chase list. Deliberately a control ORTHOGONAL to the all/active/inactive
 * pills rather than a fourth pill: a fourth value would make "missing phone"
 * mutually exclusive with "active", so an admin collecting numbers would get
 * deactivated leavers mixed in - and the automation audience resolver only ever
 * returns active users, so those rows are noise by construction.
 */
const ROSTER = [USER, NO_PHONE, INACTIVE_NO_PHONE];

const missingPhoneToggle = () => screen.getByRole('switch', { name: /missing phone/i });
const statusPill = (label: string) => screen.getByRole('button', { name: label });
const namesOnScreen = () =>
  [USER, NO_PHONE, INACTIVE_NO_PHONE]
    .filter((u) => screen.queryByText(`${u.first_name} ${u.last_name}`))
    .map((u) => `${u.first_name} ${u.last_name}`);

describe('v2 Users & Teams - the missing-phone toggle composes with the status pills', () => {
  it('narrows Active to exactly the active people with no number, leaving deactivated ones out', async () => {
    const user = userEvent.setup();
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    await user.click(statusPill('active'));
    await user.click(missingPhoneToggle());

    expect(namesOnScreen()).toEqual(['Nora Nonumber']);
    // The deactivated leaver has no number either; she is not the admin's problem.
    expect(screen.queryByText('Ira Inactive')).toBeNull();
  });

  it('re-filters when the status pill changes underneath it, and restores the list when switched off', async () => {
    const user = userEvent.setup();
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    await user.click(missingPhoneToggle());
    expect(namesOnScreen()).toEqual(['Nora Nonumber', 'Ira Inactive']);

    await user.click(statusPill('inactive'));
    expect(namesOnScreen()).toEqual(['Ira Inactive']);

    await user.click(statusPill('all'));
    await user.click(missingPhoneToggle());
    expect(namesOnScreen()).toEqual(['Tess Tech', 'Nora Nonumber', 'Ira Inactive']);
  });

  it('leaves the status pills behaving exactly as they did on their own', async () => {
    const user = userEvent.setup();
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    await user.click(statusPill('active'));
    expect(namesOnScreen()).toEqual(['Tess Tech', 'Nora Nonumber']);

    await user.click(statusPill('inactive'));
    expect(namesOnScreen()).toEqual(['Ira Inactive']);
  });
});

describe('v2 Users & Teams - the chase list costs the server nothing', () => {
  it('filters client-side: toggling issues no request, because the list already carries phone', async () => {
    const user = userEvent.setup();
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    const urlsBefore = mockApi.get.mock.calls.map(([url]) => url);
    expect(new Set(urlsBefore)).toEqual(new Set(['/api/users', '/api/departments']));

    await user.click(missingPhoneToggle());
    await user.click(statusPill('active'));

    expect(mockApi.get.mock.calls.map(([url]) => url)).toEqual(urlsBefore);
    expect(namesOnScreen()).toEqual(['Nora Nonumber']);
  });
});

/**
 * The words are the click target a sighted mouse user actually aims at - the
 * track is only about 36px wide. A `<label>` forwards a click to its labeled
 * control, so the words work only while a real label association exists.
 *
 * HONEST LIMIT, so nobody reads more into this suite than it earns: jsdom
 * implements label activation faithfully, and it forwards to a Radix Switch
 * (a `button role="switch"`) under BOTH the explicit htmlFor pairing and the
 * older implicit `<Label><Switch/>text</Label>` nesting. Chrome 151 does the
 * same. So the CLICK assertion below is a regression guard against the
 * association being dropped altogether - a bare <span>, or an id/htmlFor pair
 * that drifts apart - and it does not by itself distinguish the two shapes.
 * What pins the shape is the structural assertion: the clicked element holds
 * no control, which is what proves the click landed on the words and not on
 * the track.
 */
describe('v2 Users & Teams - the missing-phone toggle is driven by its words, not just its track', () => {
  it('filters when the label text is clicked, and the text is provably not the track', async () => {
    const user = userEvent.setup();
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    const label = screen.getByText('Missing phone');
    expect(label.tagName).toBe('LABEL');
    // If the switch were INSIDE the label, clicking it would prove nothing:
    // the hit could have landed on the track.
    expect(label.querySelector('[role="switch"]')).toBeNull();

    await user.click(label);

    expect(namesOnScreen()).toEqual(['Nora Nonumber', 'Ira Inactive']);

    await user.click(label);
    expect(namesOnScreen()).toEqual(['Tess Tech', 'Nora Nonumber', 'Ira Inactive']);
  });

  it('binds the label to the switch by id rather than by adjacency', async () => {
    mockUsers(ROSTER);
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    const label = screen.getByText('Missing phone') as HTMLLabelElement;
    const control = missingPhoneToggle();

    expect(label.htmlFor).toBeTruthy();
    expect(label.htmlFor).toBe(control.id);
  });
});
