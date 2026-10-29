// Caller ID slice 03 - Settings > Caller ID shows the numbers as one compact
// table instead of a stack of cards, and editing who can use a number happens
// in a side panel that applies nothing until Save.
//
// Driven through the routed page with only the HTTP client mocked: the
// caller-ID hooks are real, so the requests, the one outcome toast and the
// refetch are the ones the app makes. A tiny stateful stand-in for the write
// endpoints means a refetch returns what the server holds, as the real API does.
// The kit's real sonner Toaster is mounted, so toast copy is read off the page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import PhoneNumbersSettingsPage from '@/pages/v2/settings/PhoneNumbersSettingsPage';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const READ_ONLY = buildAbility([{ action: 'read', subject: 'Organization' }]);
const LIST_URL = '/api/communication/number-assignments';

type Assignment = { user_id: string; user_name: string; is_default: boolean };
type Row = {
  id: string;
  e164: string;
  label: string | null;
  is_org_default: boolean;
  sms_enabled: boolean;
  status: string;
  type: string | null;
  assignments: Assignment[];
};

const USERS = [
  { id: 'u-ari', name: 'Ari Levin' },
  { id: 'u-dana', name: 'Dana Okafor' },
  { id: 'u-jo', name: 'Jo Park' },
  { id: 'u-leo', name: 'Leo Brandt' },
  { id: 'u-maya', name: 'Maya Cohen' },
  { id: 'u-sam', name: 'Sam Reyes' },
];
const nameOf = (id: string) => USERS.find((u) => u.id === id)!.name;
const person = (id: string, isDefault = false): Assignment => ({
  user_id: id, user_name: nameOf(id), is_default: isDefault,
});

// The org default, with nobody assigned: everyone uses it.
const OFFICE: Row = {
  id: 'num-office', e164: '+15552014410', label: 'Office line', is_org_default: true,
  sms_enabled: true, status: 'active', type: 'local', assignments: [],
};
// Five people: three names then "+2". Dana has it as her default.
const SALES: Row = {
  id: 'num-sales', e164: '+15552014411', label: 'Sales line', is_org_default: false,
  sms_enabled: true, status: 'active', type: 'local',
  assignments: [person('u-ari'), person('u-dana', true), person('u-jo'), person('u-leo'), person('u-maya')],
};
// Can call but not text.
const PAID: Row = {
  id: 'num-paid', e164: '+15552014412', label: 'Paid search', is_org_default: false,
  sms_enabled: false, status: 'active', type: 'local', assignments: [],
};
// Texts, nobody assigned, Dana is assigned with no default yet.
const NYC: Row = {
  id: 'num-nyc', e164: '+15552014413', label: 'NYC line', is_org_default: false,
  sms_enabled: true, status: 'active', type: 'local', assignments: [person('u-dana')],
};
const OLD: Row = {
  id: 'num-old', e164: '+18005550199', label: 'Old toll-free', is_org_default: false,
  sms_enabled: true, status: 'paused', type: 'tollfree', assignments: [],
};
// A purchase still being set up.
const NEW: Row = {
  id: 'num-new', e164: '+15552014414', label: null, is_org_default: false,
  sms_enabled: false, status: 'pending', type: 'local', assignments: [],
};

let server: Row[] = [];
function serve(rows: Row[]) {
  server = structuredClone(rows);
}

/** Applies a successful PUT the way the real endpoints do. */
function applyPut(url: string, body: Record<string, unknown>) {
  let m = url.match(/^\/api\/communication\/numbers\/([^/]+)\/assignments$/);
  if (m) {
    const id = m[1];
    const ids = body.user_ids as string[];
    server = server.map((n) =>
      n.id !== id
        ? n
        : {
            ...n,
            assignments: ids.map((uid) => ({
              user_id: uid,
              user_name: nameOf(uid),
              is_default: n.assignments.find((a) => a.user_id === uid)?.is_default ?? false,
            })),
          },
    );
    return;
  }
  m = url.match(/^\/api\/communication\/users\/([^/]+)\/default-number$/);
  if (m) {
    const uid = m[1];
    server = server.map((n) => ({
      ...n,
      assignments: n.assignments.map((a) =>
        a.user_id === uid ? { ...a, is_default: n.id === body.phone_number_id } : a,
      ),
    }));
  }
}

function mockCommAdmin(features: string[] = ['phone']) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-dana', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: features,
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

function serverError(status: number, error: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCommAdmin();
  serve([OFFICE, SALES, PAID, NYC, OLD, NEW]);
  mockApi.get.mockImplementation((url: string) =>
    url === LIST_URL
      ? Promise.resolve({ data: { numbers: structuredClone(server), users: USERS } })
      : Promise.resolve({ data: {} }),
  );
  mockApi.put.mockImplementation((url: string, body?: unknown) => {
    applyPut(url, (body ?? {}) as Record<string, unknown>);
    return Promise.resolve({ data: { ok: true } });
  });
});

// sonner replays active toasts to a newly mounted Toaster; see the slice 02 test.
afterEach(() => {
  toast.dismiss();
});

function renderPage(ability = ADMIN) {
  return renderWithProviders(
    <>
      <PhoneNumbersSettingsPage />
      <KitToaster />
    </>,
    { ability },
  );
}

const table = () => screen.getByRole('table', { name: 'Phone numbers and who can use them' });
/** The table row whose row header is this number. */
function rowFor(formatted: string) {
  const header = within(table()).getByRole('rowheader', { name: new RegExp(escapeRe(formatted)) });
  return header.closest('tr') as HTMLElement;
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const editButton = (formatted: string) => screen.getByRole('button', { name: `Edit people for ${formatted}` });
const panel = () => screen.getByRole('dialog');
const listFetches = () => mockApi.get.mock.calls.filter(([url]) => url === LIST_URL).length;
const putCalls = () => mockApi.put.mock.calls.map(([url, body]) => [url, body]);
const toastCount = () => document.querySelectorAll('[data-sonner-toast]').length;

async function openPanel(user: ReturnType<typeof userEvent.setup>, formatted: string) {
  await user.click(editButton(formatted));
  return screen.findByRole('dialog', { name: new RegExp(escapeRe(formatted)) });
}

describe('Caller ID table', () => {
  it('shows one table row per listed number, with the number as the row header, and no cards', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'Phone numbers and who can use them' });

    const headers = within(table()).getAllByRole('rowheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      expect.stringContaining('(555) 201-4410'),
      expect.stringContaining('(555) 201-4411'),
      expect.stringContaining('(555) 201-4412'),
      expect.stringContaining('(555) 201-4413'),
      expect.stringContaining('(800) 555-0199'),
      expect.stringContaining('(555) 201-4414'),
    ]);
    // The name is the row header's second line.
    expect(headers[0]).toHaveTextContent('Office line');
    // Column headers, as designed.
    expect(within(table()).getByRole('columnheader', { name: 'Number' })).toBeInTheDocument();
    expect(within(table()).getByRole('columnheader', { name: 'Who can call and text' })).toBeInTheDocument();
    expect(within(table()).getByRole('columnheader', { name: 'Texting' })).toBeInTheDocument();
    // The card stack's controls are gone.
    expect(screen.queryByRole('button', { name: /edit users/i })).toBeNull();
    expect(screen.queryByText(/can send from this number/i)).toBeNull();
  });

  it("names every Edit button with its own number", async () => {
    renderPage();
    await screen.findByRole('table');

    for (const n of ['(555) 201-4410', '(555) 201-4411', '(555) 201-4412', '(555) 201-4413', '(800) 555-0199', '(555) 201-4414']) {
      expect(within(rowFor(n)).getByRole('button', { name: `Edit people for ${n}` })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /^Edit people for / })).toHaveLength(6);
  });

  it('shows three names then "+N", and marks the person who has the number as their default', async () => {
    renderPage();
    await screen.findByRole('table');

    const who = within(rowFor('(555) 201-4411')).getByRole('cell', { name: /Ari Levin/ });
    expect(within(who).getByText('Ari Levin')).toBeInTheDocument();
    expect(within(who).getByText('Dana Okafor')).toBeInTheDocument();
    expect(within(who).getByText('Jo Park')).toBeInTheDocument();
    expect(within(who).queryByText('Leo Brandt')).toBeNull();
    expect(within(who).queryByText('Maya Cohen')).toBeNull();
    expect(within(who).getByText('+2')).toBeInTheDocument();
    // The marker sits on Dana's chip, and only there.
    const dana = within(who).getByText('Dana Okafor').closest('[data-chip]') as HTMLElement;
    expect(dana).toHaveTextContent('Dana Okafor · Default');
    expect(within(who).getAllByText(/Default/)).toHaveLength(1);
  });

  it('says everyone uses the org default when nobody is assigned to it, and "Nobody assigned" elsewhere', async () => {
    renderPage();
    await screen.findByRole('table');

    expect(within(rowFor('(555) 201-4410')).getByText('Everyone (organization default)')).toBeInTheDocument();
    expect(within(rowFor('(555) 201-4410')).queryByText('Nobody assigned')).toBeNull();
    expect(within(rowFor('(555) 201-4412')).getByText('Nobody assigned')).toBeInTheDocument();
    expect(within(rowFor('(555) 201-4412')).queryByText(/organization default/)).toBeNull();
    // A number with people shows the people, not either note.
    expect(within(rowFor('(555) 201-4413')).queryByText('Nobody assigned')).toBeNull();
  });

  it('shows the people, not the everyone note, on an org-default number that has people assigned', async () => {
    serve([{ ...OFFICE, assignments: [person('u-sam')] }, PAID]);
    renderPage();
    await screen.findByRole('table');

    const row = rowFor('(555) 201-4410');
    expect(within(row).getByText('Sam Reyes')).toBeInTheDocument();
    expect(within(row).queryByText('Everyone (organization default)')).toBeNull();
  });

  it('shows whether each number can text, and says honestly when it cannot be used', async () => {
    renderPage();
    await screen.findByRole('table');

    const texting = (n: string) => {
      const cells = within(rowFor(n)).getAllByRole('cell');
      // Number (row header) is not a cell: who, texting, action.
      return cells[1];
    };
    expect(texting('(555) 201-4410')).toHaveTextContent('Calls and texts');
    expect(texting('(555) 201-4412')).toHaveTextContent('Calls only');
    expect(texting('(800) 555-0199')).toHaveTextContent('Paused');
    expect(texting('(555) 201-4414')).toHaveTextContent('Unavailable');
  });

  it('at phone width hides the texting column and shows the same tag under the number', async () => {
    renderPage();
    await screen.findByRole('table');

    // The column header and every texting cell are hidden below the sm breakpoint.
    const header = within(table()).getByRole('columnheader', { name: 'Texting' });
    expect(header).toHaveClass('hidden', 'sm:table-cell');
    for (const [n, tag] of [
      ['(555) 201-4410', 'Calls and texts'],
      ['(555) 201-4412', 'Calls only'],
      ['(800) 555-0199', 'Paused'],
      ['(555) 201-4414', 'Unavailable'],
    ] as const) {
      const cells = within(rowFor(n)).getAllByRole('cell');
      expect(cells[1]).toHaveClass('hidden', 'sm:table-cell');
      // The row header carries the tag for phones, hidden from sm up.
      const phoneTag = within(within(rowFor(n)).getByRole('rowheader')).getByText(tag);
      expect(phoneTag.closest('.sm\\:hidden')).not.toBeNull();
    }
  });

  it('keeps every control at or above the target sizes: row actions 40px, toggles 34px, person rows 44px', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    // Button size="default" is h-10 (2.5rem = 40px), above the 36px row-action floor.
    expect(editButton('(555) 201-4411')).toHaveClass('h-10');
    // The action cell's inset is tighter below sm, so the table fits a phone.
    const actionCell = editButton('(555) 201-4411').closest('td') as HTMLElement;
    expect(actionCell.firstElementChild).toHaveClass('px-2', 'sm:px-4');

    await openPanel(user, '(555) 201-4411');
    // Button size="sm" is h-8.5 (34px), above the 24px floor.
    expect(within(panel()).getByRole('button', { name: 'Default number for Dana Okafor' })).toHaveClass('h-8.5');
    // A 16px checkbox's target is its whole person row: the label wraps it and is min-h-11 (44px).
    const box = within(panel()).getByRole('checkbox', { name: 'Dana Okafor' });
    expect(box.closest('label')).toHaveClass('min-h-11');
  });
});

describe('Caller ID side panel', () => {
  it('opens for the chosen number with every active person, ticked when assigned', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');

    const sheet = await openPanel(user, '(555) 201-4413');
    expect(within(sheet).getByRole('heading', { name: '(555) 201-4413' })).toBeInTheDocument();
    expect(within(sheet).getAllByRole('checkbox')).toHaveLength(USERS.length);
    expect(within(sheet).getByRole('checkbox', { name: 'Dana Okafor' })).toBeChecked();
    expect(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' })).not.toBeChecked();
    // The panel takes focus.
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("the people search filters the people list", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    await user.type(within(sheet).getByRole('searchbox', { name: 'Search people' }), 'sa');

    expect(within(sheet).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('checkbox', { name: 'Dana Okafor' })).toBeNull();

    await user.clear(within(sheet).getByRole('searchbox', { name: 'Search people' }));
    await user.type(within(sheet).getByRole('searchbox', { name: 'Search people' }), 'zz');
    expect(within(sheet).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(sheet).getByText('No one matches.')).toBeInTheDocument();
  });

  it('disables the Default toggle for someone not assigned, with the reason, and enables it once they are ticked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    const samDefault = within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' });
    expect(samDefault).toBeDisabled();
    expect(samDefault).toHaveAccessibleDescription(
      'Only people who can use this number can have it as their default.',
    );
    expect(within(sheet).getByText('Only people who can use this number can have it as their default.')).toBeVisible();
    // Dana is assigned on a texting, active number: her toggle works.
    expect(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' })).toBeEnabled();

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    expect(within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' })).toBeEnabled();
  });

  it.each([
    ['a calls-only number', '(555) 201-4412', "This number can't send texts, so it can't be anyone's default."],
    ['a paused number', '(800) 555-0199', "This number is paused, so it can't be anyone's default."],
    ['a number that is not ready', '(555) 201-4414', "This number isn't available yet, so it can't be anyone's default."],
  ])('disables every Default toggle on %s, with the reason shown', async (_n, formatted, reason) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, formatted);

    expect(within(sheet).getByText(reason)).toBeVisible();
    // Even a ticked person cannot be made the default.
    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    const samDefault = within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' });
    expect(samDefault).toBeDisabled();
    expect(samDefault).toHaveAccessibleDescription(reason);
    for (const btn of within(sheet).getAllByRole('button', { name: /^Default number for / })) {
      expect(btn).toBeDisabled();
    }
  });

  it.each([
    ['calls-only', { sms_enabled: false, status: 'active' }],
    ['paused', { sms_enabled: true, status: 'paused' }],
    ['not-yet-available', { sms_enabled: false, status: 'pending' }],
  ])('still lets an existing default on a %s number be cleared, but not set again', async (_n, state) => {
    const user = userEvent.setup();
    serve([OFFICE, { ...PAID, ...state, assignments: [person('u-dana', true)] }]);
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4412');

    const dana = () => within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' });
    expect(dana()).toBeEnabled();
    expect(dana()).toHaveAttribute('aria-pressed', 'true');
    await user.click(dana());
    expect(dana()).toHaveAttribute('aria-pressed', 'false');
    // Once cleared, it cannot be turned back on here.
    expect(dana()).toBeDisabled();

    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. 1 person can use (555) 201-4412');
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-paid/assignments', { user_ids: ['u-dana'] }],
      ['/api/communication/users/u-dana/default-number', { phone_number_id: null }],
    ]);
  });

  it("unticking a person drops their default from the draft, so ticking them again does not bring it back", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4411');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Dana Okafor' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Dana Okafor' }));
    expect(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. 5 people can use (555) 201-4411');
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-sales/assignments', { user_ids: ['u-ari', 'u-jo', 'u-leo', 'u-maya', 'u-dana'] }],
      ['/api/communication/users/u-dana/default-number', { phone_number_id: null }],
    ]);
  });

  it('Save sends the full list, then a default call for each CHANGED default only, and shows one success toast', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4411');

    // Add Sam and make him default; clear Dana's default; remove Leo; Ari, Jo
    // and Maya are untouched.
    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' }));
    await user.click(within(sheet).getByRole('checkbox', { name: 'Leo Brandt' }));
    // Nothing is applied before Save.
    expect(mockApi.put).not.toHaveBeenCalled();

    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved. 5 people can use (555) 201-4411')).toBeInTheDocument();
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-sales/assignments', { user_ids: ['u-ari', 'u-dana', 'u-jo', 'u-maya', 'u-sam'] }],
      ['/api/communication/users/u-dana/default-number', { phone_number_id: null }],
      ['/api/communication/users/u-sam/default-number', { phone_number_id: 'num-sales' }],
    ]);
    // Exactly one outcome toast, never one per call.
    expect(toastCount()).toBe(1);
    expect(screen.queryByText(/Default number (saved|cleared)/)).toBeNull();
    // The panel closes and the list refetches to the server's state.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listFetches()).toBe(2));
    // Sam is the fifth person, but the default is listed first, never behind "+N".
    const who = () => within(rowFor('(555) 201-4411')).getAllByRole('cell')[0]!;
    await waitFor(() => expect(who()).toHaveTextContent('Sam Reyes · Default'));
    expect(who()).not.toHaveTextContent('Dana Okafor · Default');
    expect(who()).not.toHaveTextContent('Leo Brandt');
    expect(within(who()).getByText('+2')).toBeInTheDocument();
  });

  it('Save with only a default change still sends the full list, and the success toast counts the people', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved. 1 person can use (555) 201-4413')).toBeInTheDocument();
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-nyc/assignments', { user_ids: ['u-dana'] }],
      ['/api/communication/users/u-dana/default-number', { phone_number_id: 'num-nyc' }],
    ]);
  });

  it('Save with no default change makes no default call', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4412');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Jo Park' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved. 1 person can use (555) 201-4412')).toBeInTheDocument();
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-paid/assignments', { user_ids: ['u-jo'] }],
    ]);
  });

  it('Cancel discards every change: nothing is saved and reopening shows the saved state', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    let sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' }));
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(toastCount()).toBe(0);

    sheet = await openPanel(user, '(555) 201-4413');
    expect(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' })).not.toBeChecked();
    expect(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('Escape discards every change too', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    let sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockApi.put).not.toHaveBeenCalled();

    sheet = await openPanel(user, '(555) 201-4413');
    expect(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' })).not.toBeChecked();
  });

  it("a failed save shows one error toast with the server's message, and the list shows the server's state", async () => {
    const user = userEvent.setup();
    // The assignment save fails; meanwhile the server has Jo, not the Sam the
    // admin ticked.
    mockApi.put.mockImplementationOnce(() => {
      serve([OFFICE, SALES, PAID, { ...NYC, assignments: [person('u-jo')] }, OLD, NEW]);
      return Promise.reject(serverError(400, 'One or more users are not in your organization'));
    });
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText("Couldn't save who can use this number")).toBeInTheDocument();
    expect(screen.getByText('One or more users are not in your organization')).toBeInTheDocument();
    expect(toastCount()).toBe(1);
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    // No default call follows a failed assignment.
    expect(mockApi.put).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(listFetches()).toBe(2));
    // The panel stays open with the admin's draft, so they can retry.
    expect(screen.getByRole('dialog')).toBe(sheet);
    expect(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' })).toBeChecked();
    expect(within(sheet).getByRole('button', { name: 'Default number for Sam Reyes' })).toHaveAttribute('aria-pressed', 'true');
    // Behind it, the list holds the server's state.
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const who = () => within(rowFor('(555) 201-4413')).getAllByRole('cell')[0]!;
    expect(who()).toHaveTextContent('Jo Park');
    expect(who()).not.toHaveTextContent('Sam Reyes');
    expect(who()).not.toHaveTextContent('Dana Okafor');
  });

  it('a default that fails after the people saved says so in ONE error toast, keeps the panel open, and a retry sends the still-changed default', async () => {
    const user = userEvent.setup();
    mockApi.put
      .mockImplementationOnce((url: string, body?: unknown) => {
        applyPut(url, (body ?? {}) as Record<string, unknown>);
        return Promise.resolve({ data: { ok: true } });
      })
      .mockImplementationOnce(() =>
        Promise.reject(serverError(400, "A paused number can't be a default caller ID.")),
      );
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    // The title says the people saved and the default did not.
    expect(await screen.findByText('People saved, but the default number was not')).toBeInTheDocument();
    expect(screen.getByText("A paused number can't be a default caller ID.")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't save who can use this number")).toBeNull();
    expect(toastCount()).toBe(1);
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    await waitFor(() => expect(listFetches()).toBe(2));
    // The panel stays open with the draft.
    expect(screen.getByRole('dialog')).toBe(sheet);
    expect(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' })).toHaveAttribute('aria-pressed', 'true');

    // Retry: the server now has Sam but not Dana's default, so the default is
    // still a change and is sent again.
    toast.dismiss();
    mockApi.put.mockClear();
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved. 2 people can use (555) 201-4413')).toBeInTheDocument();
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-nyc/assignments', { user_ids: ['u-dana', 'u-sam'] }],
      ['/api/communication/users/u-dana/default-number', { phone_number_id: 'num-nyc' }],
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const who = () => within(rowFor('(555) 201-4413')).getAllByRole('cell')[0]!;
    await waitFor(() => expect(who()).toHaveTextContent('Dana Okafor · Default'));
  });

  it('a retry compares defaults with what the server now holds, not with what the panel opened on', async () => {
    const user = userEvent.setup();
    // Clearing Dana's default "fails", but the server did clear it.
    mockApi.put
      .mockImplementationOnce((url: string, body?: unknown) => {
        applyPut(url, (body ?? {}) as Record<string, unknown>);
        return Promise.resolve({ data: { ok: true } });
      })
      .mockImplementationOnce((url: string, body?: unknown) => {
        applyPut(url, (body ?? {}) as Record<string, unknown>);
        return Promise.reject(new Error('Network Error'));
      });
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4411');

    await user.click(within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('People saved, but the default number was not')).toBeInTheDocument();
    await waitFor(() => expect(listFetches()).toBe(2));

    toast.dismiss();
    mockApi.put.mockClear();
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved. 5 people can use (555) 201-4411')).toBeInTheDocument();
    // Dana's default is already cleared on the server: no default call.
    expect(putCalls()).toEqual([
      ['/api/communication/numbers/num-sales/assignments', { user_ids: ['u-ari', 'u-dana', 'u-jo', 'u-leo', 'u-maya'] }],
    ]);
  });

  it('a save that never reached the server shows the neutral fallback, never the raw error', async () => {
    const user = userEvent.setup();
    mockApi.put.mockImplementationOnce(() => Promise.reject(new Error('Network Error')));
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4413');

    await user.click(within(sheet).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText("Couldn't save who can use this number")).toBeInTheDocument();
    expect(screen.getByText('The change may not have saved. Check the list and try again.')).toBeInTheDocument();
    expect(screen.queryByText('Network Error')).toBeNull();
  });

  it.each([
    ['Cancel', async (user: ReturnType<typeof userEvent.setup>) => user.click(within(panel()).getByRole('button', { name: 'Cancel' }))],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}')],
    ['the close button', async (user: ReturnType<typeof userEvent.setup>) => user.click(within(panel()).getByRole('button', { name: 'Close' }))],
    ['Save', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(within(panel()).getByRole('checkbox', { name: 'Sam Reyes' }));
      await user.click(within(panel()).getByRole('button', { name: 'Save' }));
    }],
  ])('returns focus to the row\'s Edit button after closing with %s', async (_how, close) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    // Reach the button by keyboard so nothing but the panel moves focus.
    const edit = editButton('(555) 201-4413');
    edit.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('dialog');
    // The panel took focus away from the button.
    expect(edit).not.toHaveFocus();

    await close(user);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(editButton('(555) 201-4413')).toHaveFocus());
  });

  it('returns focus to the Edit button even when opening it did not focus it (as in Safari)', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    // A click that leaves focus where it was: Safari never focuses a clicked
    // button, so "focus whatever had it before" would land on the page body.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(editButton('(555) 201-4413'));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(editButton('(555) 201-4413')).toHaveFocus());
  });

  it('names no phone vendor anywhere on the page, in the panel or in its toasts', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|call tracking metrics|supabase|render\b/i);

    await openPanel(user, '(555) 201-4412');
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|call tracking metrics|supabase|render\b/i);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Sam Reyes' }));
    await user.click(within(panel()).getByRole('button', { name: 'Save' }));
    await screen.findByText(/^Saved\./);
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|call tracking metrics|supabase|render\b/i);
    // Moved from the deleted legacy page's test: assigning people changes no
    // routing, so the page narrates none.
    expect(screen.queryByText(/voicemail/i)).toBeNull();
    expect(screen.queryByText(/setup step/i)).toBeNull();
  });
});

// Moved from the deleted legacy page's test: the fail-closed gate holds on the
// routed page too.
describe('Caller ID gate', () => {
  it('a non-admin is fully gated: the admin data is never fetched and nothing renders', async () => {
    renderPage(READ_ONLY);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockApi.get).not.toHaveBeenCalledWith(LIST_URL);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit people for / })).toBeNull();
  });

  it('a comm-disabled org is gated even for a full admin', async () => {
    // org_features must be an explicit empty array: useFeature fails open when
    // it is undefined, which would defeat the test.
    mockCommAdmin([]);
    renderPage();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(mockApi.get).not.toHaveBeenCalledWith(LIST_URL);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// Disconnecting the phone service marks its numbers inactive. They stay on the
// list, tagged "Unavailable" like any other number that cannot be used, but the
// panel says why honestly: the number is no longer connected, not "not
// available yet".
describe('Caller ID - a number left inactive by a disconnect', () => {
  const GONE: Row = {
    id: 'num-gone', e164: '+15552014415', label: 'Old main line', is_org_default: false,
    sms_enabled: true, status: 'inactive', type: 'local', assignments: [person('u-dana')],
  };
  const DISCONNECTED_REASON = "This number is no longer connected, so it can't be anyone's default.";

  beforeEach(() => {
    serve([OFFICE, GONE, NEW]);
  });

  it('keeps the Unavailable tag', async () => {
    renderPage();
    await screen.findByRole('table');

    expect(within(rowFor('(555) 201-4415')).getAllByRole('cell')[1]).toHaveTextContent('Unavailable');
  });

  it('says the number is no longer connected, and disables every Default toggle', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4415');

    expect(within(sheet).getByText(DISCONNECTED_REASON)).toBeVisible();
    expect(within(sheet).queryByText(/isn.t available yet/)).toBeNull();
    const danaDefault = within(sheet).getByRole('button', { name: 'Default number for Dana Okafor' });
    expect(danaDefault).toBeDisabled();
    expect(danaDefault).toHaveAccessibleDescription(DISCONNECTED_REASON);
  });

  it('still tells a number being set up that it is not available yet', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    const sheet = await openPanel(user, '(555) 201-4414');

    expect(within(sheet).getByText("This number isn't available yet, so it can't be anyone's default.")).toBeVisible();
    expect(within(sheet).queryByText(DISCONNECTED_REASON)).toBeNull();
  });
});
