// Caller ID slice 02 - Settings > Caller ID (the routed v2 page): the org
// default moves from a star on each card to one labelled select at the top,
// a calls-only pick warns that texts go out from a different number, a paused
// number cannot be picked, and every one of the three caller-ID saves reports
// success or failure in a toast. On failure the list refetches so the page shows
// what the server actually holds.
//
// Driven through the page with only the HTTP client mocked: the caller-ID
// mutation hooks are real, so the toasts and the refetch come from the shared
// hooks. Slice 03 replaced the cards with a table and a side panel; the
// assignment and personal-default saves are covered through that panel in
// caller-id-table.test.tsx. The kit's real sonner Toaster is
// mounted, so toast copy is read off the page as a user would see it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import PhoneNumbersSettingsPage from '@/pages/v2/settings/PhoneNumbersSettingsPage';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const LIST_URL = '/api/communication/number-assignments';
/** Every Caller ID save opts out of the app-wide error toasts (it shows its own). */
const SAVE_OPTS = { silentErrors: true };

type Row = {
  id: string;
  e164: string;
  label: string | null;
  is_org_default: boolean;
  sms_enabled: boolean;
  status: string;
  type: string | null;
  assignments: Array<{ user_id: string; user_name: string; is_default: boolean }>;
};

const OFFICE: Row = {
  id: 'num-office', e164: '+15552014410', label: 'Office line', is_org_default: true,
  sms_enabled: true, status: 'active', type: 'local',
  assignments: [{ user_id: 'u-dana', user_name: 'Dana Okafor', is_default: true }],
};
const PAID: Row = {
  id: 'num-paid', e164: '+15552014411', label: 'Paid search', is_org_default: false,
  sms_enabled: false, status: 'active', type: 'local', assignments: [],
};
const NYC: Row = {
  id: 'num-nyc', e164: '+15552014412', label: 'NYC line', is_org_default: false,
  sms_enabled: true, status: 'active', type: 'local', assignments: [],
};
const OLD: Row = {
  id: 'num-old', e164: '+18005550199', label: 'Old toll-free', is_org_default: false,
  sms_enabled: true, status: 'paused', type: 'tollfree', assignments: [],
};

// A purchase still being set up: listed, but not active, so never a default.
const NEW: Row = {
  id: 'num-new', e164: '+15552014414', label: 'New line', is_org_default: false,
  sms_enabled: false, status: 'pending', type: 'local', assignments: [],
};

/** Unnamed filler numbers, so the org-default control can be exercised on both
 *  sides of the kit's 10-option rule (plain select below ten, searchable
 *  combobox at ten or more - the pilot org has 30). */
function filler(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `num-fill-${i}`, e164: `+1555300${String(1000 + i)}`, label: null, is_org_default: false,
    sms_enabled: true, status: 'active', type: 'local', assignments: [],
  }));
}

const USERS = [
  { id: 'u-dana', name: 'Dana Okafor' },
  { id: 'u-sam', name: 'Sam Reyes' },
];

function listOf(numbers: Row[]) {
  return { data: { numbers, users: USERS } };
}

function mockCommAdmin() {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-dana', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never,
  );
}

/** A rejected axios call carrying the server's JSON error body. */
function serverError(status: number, error: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error } },
  });
}

function renderPage() {
  return renderWithProviders(
    <>
      <PhoneNumbersSettingsPage />
      <KitToaster />
    </>,
    { ability: ADMIN },
  );
}

const orgDefaultControl = () => screen.getByRole('combobox', { name: 'Organization default' });
const listFetches = () => mockApi.get.mock.calls.filter(([url]) => url === LIST_URL).length;

// A tiny stateful stand-in for the three write endpoints, so a successful
// save's refetch returns what was saved (as the real API does).
let server: Row[] = [];
function serve(rows: Row[]) {
  server = structuredClone(rows);
}
function applyPut(url: string, body: Record<string, unknown>) {
  let m = url.match(/^\/api\/communication\/numbers\/([^/]+)\/org-default$/);
  if (m) {
    const id = m[1];
    server = server.map((n) => ({ ...n, is_org_default: body.is_org_default === false ? false : n.id === id }));
    return;
  }
  m = url.match(/^\/api\/communication\/numbers\/([^/]+)\/assignments$/);
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
              user_name: USERS.find((u) => u.id === uid)!.name,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockCommAdmin();
  serve([OFFICE, PAID, NYC, OLD, NEW]);
  mockApi.get.mockImplementation((url: string) =>
    url === LIST_URL ? Promise.resolve(listOf(server)) : Promise.resolve({ data: {} }),
  );
  mockApi.put.mockImplementation((url: string, body?: unknown) => {
    applyPut(url, (body ?? {}) as Record<string, unknown>);
    return Promise.resolve({ data: { ok: true } });
  });
});

// sonner keeps its toasts in a module-level store and replays the active ones
// to a newly mounted Toaster, so a toast from one test would otherwise show up
// in the next. Dismissing marks them all inactive, synchronously.
afterEach(() => {
  toast.dismiss();
});

/** The next save fails; meanwhile the server's state is `rows`. */
function failNextSave(err: Error, rows?: Row[]) {
  mockApi.put.mockImplementationOnce(() => {
    if (rows) serve(rows);
    return Promise.reject(err);
  });
}

describe.each([
  ['a small org (plain select)', [] as Row[], false],
  ['a large org (searchable list)', filler(8), true],
])('Caller ID org default - %s', (_name, extra, searchable) => {
  beforeEach(() => {
    serve([OFFICE, PAID, NYC, OLD, NEW, ...extra]);
  });

  it('shows the current org default by number and name in one labelled control at the top', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Organization default')).toBeInTheDocument();
    expect(orgDefaultControl()).toHaveTextContent('(555) 201-4410 · Office line');

    await user.click(orgDefaultControl());
    // Every listed number, by number and name - a released number never
    // reaches the page (the endpoint drops it), so this is the whole list.
    expect(await screen.findByRole('option', { name: /\(555\) 201-4410 · Office line/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\(555\) 201-4411 · Paid search/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\(555\) 201-4412 · NYC line/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\(800\) 555-0199 · Old toll-free/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\(555\) 201-4414 · New line/ })).toBeInTheDocument();
    // Plus "No organization default" at the top.
    expect(screen.getAllByRole('option')).toHaveLength(6 + extra.length);
    // Ten or more numbers get a search box (the pilot org has 30); fewer do not.
    if (searchable) {
      expect(screen.getByPlaceholderText('Search numbers')).toBeInTheDocument();
    } else {
      expect(screen.queryByPlaceholderText('Search numbers')).toBeNull();
    }
  });

  it('saves on change and confirms with a success toast', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /NYC line/ }));

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith('/api/communication/numbers/num-nyc/org-default', {
        is_org_default: true,
      }, SAVE_OPTS),
    );
    expect(await screen.findByText('Organization default is now (555) 201-4412')).toBeInTheDocument();
  });

  it('warns inline that texts go out from a different number when a calls-only number is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    // The current default can text: no warning.
    expect(screen.queryByText(/texts will go out from a different number/i)).toBeNull();
    // Live regions already on the page. A screen reader only announces content
    // added to a polite region that was there before the content arrived.
    const politeRegionsBefore = Array.from(document.querySelectorAll('[aria-live="polite"]'));

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /Paid search/ }));

    const warning = await screen.findByText(/texts will go out from a different number/i);
    const region = warning.closest('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(politeRegionsBefore).toContain(region);
  });

  it('shows the warning as soon as a calls-only number is chosen, while the save is still in flight', async () => {
    const user = userEvent.setup();
    mockApi.put.mockImplementationOnce(() => new Promise(() => {})); // never settles
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /Paid search/ }));

    expect(await screen.findByText(/texts will go out from a different number/i)).toBeInTheDocument();
    expect(orgDefaultControl()).toHaveTextContent('(555) 201-4411 · Paid search');
  });

  it.each([
    ['a paused number', /Old toll-free/, 'Paused'],
    // Slice 03: any status other than active, not only paused.
    ['a number still being set up', /New line/, 'Unavailable'],
    // Disconnecting the phone service leaves its numbers inactive.
    ['a number left inactive by a disconnect', /Old main line/, 'Unavailable'],
  ])('will not let %s be chosen, and says why', async (_n, name, hint) => {
    // A disabled option may be styled pointer-events:none; click it anyway.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    serve([
      OFFICE, PAID, NYC, OLD, NEW,
      {
        id: 'num-gone', e164: '+15552014415', label: 'Old main line', is_org_default: false,
        sms_enabled: true, status: 'inactive', type: 'local', assignments: [],
      },
    ]);
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    const option = await screen.findByRole('option', { name });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(option).toHaveTextContent(hint);

    await user.click(option);
    expect(mockApi.put).not.toHaveBeenCalled();
  });
});

describe('Caller ID rows', () => {
  it('no row carries an org-default control: the select is the only one', async () => {
    renderPage();
    await screen.findByRole('table');

    expect(screen.queryByRole('button', { name: /organization default/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /org default/i })).toBeNull();
    // The select is the one control that names the org default.
    expect(screen.getAllByRole('combobox', { name: /organization default/i })).toHaveLength(1);
  });
});

describe('Caller ID saves report success or failure', () => {
  it('a failed org-default save shows an error toast and the page then shows the server state', async () => {
    const user = userEvent.setup();
    // The save is refused, and meanwhile the server's default is a different
    // number: the refetch, not the user's pick, decides what the control shows.
    // (Every failure status is covered in caller-id-save-single-toast.test.tsx.)
    failNextSave(serverError(409, 'That number is no longer available'), [
      { ...OFFICE, is_org_default: false }, PAID, { ...NYC, is_org_default: true }, OLD,
    ]);

    renderPage();
    await screen.findByText('Organization default');
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /Paid search/ }));

    expect(await screen.findByText("Couldn't change the organization default")).toBeInTheDocument();
    expect(screen.getByText('That number is no longer available')).toBeInTheDocument();
    await waitFor(() => expect(listFetches()).toBe(2));
    await waitFor(() => expect(orgDefaultControl()).toHaveTextContent('(555) 201-4412 · NYC line'));
    expect(screen.queryByText(/Organization default is now/)).toBeNull();
  });

  it.each([
    ['a network error (no response)', () => new Error('Network Error'), 'Network Error'],
    [
      'a gateway error with no message from the server',
      () =>
        Object.assign(new Error('Request failed with status code 502'), {
          response: { status: 502, data: '<html>Bad Gateway</html>' },
        }),
      'Request failed with status code 502',
    ],
  ])('a save that fails with %s shows the neutral fallback, never the raw error', async (_n, makeErr, raw) => {
    const user = userEvent.setup();
    failNextSave(makeErr());
    renderPage();
    await screen.findByText('Organization default');
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /NYC line/ }));

    expect(await screen.findByText("Couldn't change the organization default")).toBeInTheDocument();
    expect(screen.getByText('The change may not have saved. Check the list and try again.')).toBeInTheDocument();
    expect(screen.queryByText(raw)).toBeNull();
  });

  it("a save the server refuses shows the server's own message", async () => {
    const user = userEvent.setup();
    failNextSave(serverError(400, "A paused number can't be a default caller ID."));
    renderPage();
    await screen.findByText('Organization default');
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /NYC line/ }));

    expect(await screen.findByText("Couldn't change the organization default")).toBeInTheDocument();
    expect(screen.getByText("A paused number can't be a default caller ID.")).toBeInTheDocument();
    expect(screen.queryByText(/may not have saved/)).toBeNull();
  });

  it('names no phone vendor anywhere on the page, in its warning or in its toasts', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    // A calls-only default: the warning and the success toast are both on screen.
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /Paid search/ }));
    await screen.findByText('Organization default is now (555) 201-4411');
    expect(screen.getByText(/texts will go out from a different number/i)).toBeInTheDocument();

    // A save that never reached the server: the error toast too.
    failNextSave(new Error('Network Error'));
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /NYC line/ }));
    await screen.findByText("Couldn't change the organization default");

    expect(document.body.textContent).not.toMatch(/ctm|calltracking|call tracking metrics|supabase|render\b/i);
  });
});

// Follow-up (Ran, 2026-10-01): the select can also REMOVE the org default, which
// the old per-card star could and slice 02's select could not. With no org
// default, the outbound resolver falls back to the org's oldest active number
// (oldest active texting number for a text), so the page says so.
const NO_DEFAULT = 'No organization default';
const OLDEST_CALL_AND_TEXT =
  'Anyone without a usable default of their own will call from your oldest active number and text from the oldest one that can send texts.';
const OLDEST_CALL_ONLY = 'Anyone without a usable default of their own will call from your oldest active number.';
const CALLS_ONLY_WARNING = /texts will go out from a different number/i;
const fallbackNote = () => screen.queryByText(/Anyone without a usable default of their own/);

const noDefault = (rows: Row[]) => rows.map((r) => ({ ...r, is_org_default: false }));

describe.each([
  ['a small org (plain select)', [] as Row[], false],
  ['a large org (searchable list)', filler(8), true],
])('Caller ID no organization default - %s', (_name, extra, searchable) => {
  beforeEach(() => {
    serve([OFFICE, PAID, NYC, OLD, NEW, ...extra]);
  });

  it('offers "No organization default" as the first choice', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent(NO_DEFAULT);
    expect(options[0]).not.toHaveAttribute('aria-disabled', 'true');
    if (searchable) expect(screen.getByPlaceholderText('Search numbers')).toBeInTheDocument();
    else expect(screen.queryByPlaceholderText('Search numbers')).toBeNull();
  });

  it('choosing it removes the current default, confirms in a toast and then reads "No organization default"', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');
    expect(orgDefaultControl()).toHaveTextContent('(555) 201-4410 · Office line');

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));

    // The CURRENT default's id, unset - never a set, never another number.
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(mockApi.put).toHaveBeenCalledWith('/api/communication/numbers/num-office/org-default', {
      is_org_default: false,
    }, SAVE_OPTS);
    expect(await screen.findByText('Organization default removed')).toBeInTheDocument();
    await waitFor(() => expect(listFetches()).toBe(2));
    expect(orgDefaultControl()).toHaveTextContent(NO_DEFAULT);
    expect(server.some((n) => n.is_org_default)).toBe(false);
  });

  it('reads "No organization default" when the org has none, not a blank or a placeholder', async () => {
    serve(noDefault([OFFICE, PAID, NYC, OLD, NEW, ...extra]));
    renderPage();
    await screen.findByText('Organization default');

    expect(orgDefaultControl()).toHaveTextContent(NO_DEFAULT);
    expect(orgDefaultControl()).not.toHaveTextContent('Choose a number');
  });

  // The kit select never re-emits the value it already holds, so this pins the
  // end-to-end behaviour, not the page's own "no default, nothing to unset" guard.
  it('re-picking the current choice ("No organization default") does nothing', async () => {
    const user = userEvent.setup();
    serve(noDefault([OFFICE, PAID, NYC, OLD, NEW, ...extra]));
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));

    expect(screen.queryByRole('option')).toBeNull();
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(orgDefaultControl()).toHaveTextContent(NO_DEFAULT);
    expect(screen.queryByText('Organization default removed')).toBeNull();
  });

  it('says which number people fall back to while there is no default, and not while there is one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');
    expect(fallbackNote()).toBeNull();

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));

    const note = await screen.findByText(OLDEST_CALL_AND_TEXT);
    // Inside the live region that was already on the page, like the warning.
    expect(note.closest('[aria-live="polite"]')).not.toBeNull();

    // Setting a default again takes the note away.
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: /NYC line/ }));
    await waitFor(() => expect(fallbackNote()).toBeNull());
  });

  it('does not show the calls-only warning for "No organization default", even while the removal saves', async () => {
    const user = userEvent.setup();
    // The current default is the calls-only number.
    serve([{ ...OFFICE, is_org_default: false }, { ...PAID, is_org_default: true }, NYC, OLD, NEW, ...extra]);
    mockApi.put.mockImplementationOnce(() => new Promise(() => {})); // never settles
    renderPage();
    await screen.findByText('Organization default');
    expect(screen.getByText(CALLS_ONLY_WARNING)).toBeInTheDocument();

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));

    expect(mockApi.put).toHaveBeenCalledWith('/api/communication/numbers/num-paid/org-default', {
      is_org_default: false,
    }, SAVE_OPTS);
    await waitFor(() => expect(screen.queryByText(CALLS_ONLY_WARNING)).toBeNull());
    expect(orgDefaultControl()).toHaveTextContent(NO_DEFAULT);
  });
});

describe('Caller ID no organization default - the fallback note stays honest', () => {
  it('names only calling when no active number can send texts', async () => {
    serve(noDefault([{ ...PAID }, { ...OLD }, { ...NEW }]));
    renderPage();
    await screen.findByText('Organization default');

    expect(screen.getByText(OLDEST_CALL_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(/text from the oldest/)).toBeNull();
  });

  it('says nothing about a fallback when no number is active', async () => {
    serve(noDefault([{ ...OLD }, { ...NEW }]));
    renderPage();
    await screen.findByText('Organization default');

    expect(orgDefaultControl()).toHaveTextContent(NO_DEFAULT);
    expect(fallbackNote()).toBeNull();
  });
});

describe('Caller ID no organization default - the table follows', () => {
  const table = () => screen.getByRole('table', { name: 'Phone numbers and who can use them' });
  const filterButton = (name: string) =>
    within(screen.getByRole('group', { name: 'Filter numbers' })).getByRole('button', { name });
  const rowOf = (number: string) =>
    within(table())
      .getAllByRole('row')
      .find((r) => r.textContent?.includes(number));

  it('after removing it, no row says "Everyone (organization default)" and "Nobody assigned" lists the former default', async () => {
    const user = userEvent.setup();
    // The default is a number nobody is assigned to.
    serve([{ ...OFFICE, is_org_default: false }, PAID, { ...NYC, is_org_default: true }, OLD, NEW]);
    renderPage();
    await screen.findByRole('table');
    expect(within(rowOf('(555) 201-4412')!).getByText('Everyone (organization default)')).toBeInTheDocument();

    await user.click(filterButton('Nobody assigned'));
    expect(rowOf('(555) 201-4412')).toBeUndefined();
    await user.click(filterButton('All'));

    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));
    await screen.findByText('Organization default removed');

    await waitFor(() => expect(screen.queryByText('Everyone (organization default)')).toBeNull());
    expect(within(rowOf('(555) 201-4412')!).getByText('Nobody assigned')).toBeInTheDocument();

    await user.click(filterButton('Nobody assigned'));
    expect(rowOf('(555) 201-4412')).toBeDefined();
  });
});

// The resolver only reads an ACTIVE org default, so a default that is paused,
// disconnected or still being set up is skipped and people fall back to the
// oldest active number. The select would otherwise imply the default is in use.
describe('Caller ID org default that cannot be used right now', () => {
  const UNUSABLE = /can't be used right now/;
  const UNUSABLE_CALL_AND_TEXT =
    "This number can't be used right now, so anyone without a usable default of their own will call from your oldest active number and text from the oldest one that can send texts.";
  const UNUSABLE_CALL_ONLY =
    "This number can't be used right now, so anyone without a usable default of their own will call from your oldest active number.";
  const asDefault = (row: Row, status: string): Row => ({ ...row, status, is_org_default: true });

  it.each([['paused'], ['inactive'], ['pending']])(
    'a %s default says it is skipped and who people fall back to',
    async (status) => {
      serve([{ ...OFFICE, is_org_default: false }, PAID, NYC, asDefault(OLD, status)]);
      renderPage();
      await screen.findByText('Organization default');

      expect(orgDefaultControl()).toHaveTextContent('(800) 555-0199 · Old toll-free');
      const note = screen.getByText(UNUSABLE_CALL_AND_TEXT);
      expect(note.closest('[aria-live="polite"]')).not.toBeNull();
      // Not the no-default note, and not the calls-only warning.
      expect(screen.queryByText(/^Anyone without a usable default/)).toBeNull();
      expect(screen.queryByText(CALLS_ONLY_WARNING)).toBeNull();
    },
  );

  it('names only calling when no active number can send texts', async () => {
    serve([PAID, asDefault(OLD, 'paused')]);
    renderPage();
    await screen.findByText('Organization default');

    expect(screen.getByText(UNUSABLE_CALL_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(/text from the oldest/)).toBeNull();
  });

  it('names no fallback when no number is active', async () => {
    serve([asDefault(OLD, 'paused'), NEW]);
    renderPage();
    await screen.findByText('Organization default');

    expect(screen.getByText("This number can't be used right now.")).toBeInTheDocument();
    expect(screen.queryByText(/oldest active number/)).toBeNull();
  });

  it('says nothing of the kind for an active default', async () => {
    serve([OFFICE, PAID, NYC, OLD, NEW]);
    renderPage();
    await screen.findByText('Organization default');
    expect(screen.queryByText(UNUSABLE)).toBeNull();
  });

  it('an active calls-only default shows the calls-only warning and no unusable note', async () => {
    serve([{ ...OFFICE, is_org_default: false }, { ...PAID, is_org_default: true }, NYC, OLD, NEW]);
    renderPage();
    await screen.findByText('Organization default');

    expect(screen.getByText(CALLS_ONLY_WARNING)).toBeInTheDocument();
    expect(screen.queryByText(UNUSABLE)).toBeNull();
  });
});

// Review follow-ups: the control is disabled while a change saves, which drops
// keyboard focus to the page body; focus must be back on the control once the
// save settles, on both sides of the 10-option rule.
describe.each([
  ['a small org (plain select)', [] as Row[], false],
  ['a large org (searchable list)', filler(8), true],
])('Caller ID org default keeps keyboard focus - %s', (_name, extra, searchable) => {
  beforeEach(() => {
    serve([OFFICE, PAID, NYC, OLD, NEW, ...extra]);
    // A save takes a moment, as over a network, so the panel closes and hands
    // focus back while the control is still disabled. A disabled control cannot
    // take focus (in jsdom as in a browser), so that focus lands on the body.
    mockApi.put.mockImplementation(
      (url: string, body?: unknown) =>
        new Promise((resolve) =>
          setTimeout(() => {
            applyPut(url, (body ?? {}) as Record<string, unknown>);
            resolve({ data: { ok: true } });
          }, 100),
        ),
    );
  });

  /** Opens the control from the keyboard and picks `target` without a pointer. */
  async function pickWithKeyboard(user: ReturnType<typeof userEvent.setup>, target: 'nyc' | 'none') {
    orgDefaultControl().focus();
    await user.keyboard('{Enter}');
    if (searchable) {
      await screen.findByPlaceholderText('Search numbers');
      await user.keyboard(target === 'nyc' ? 'NYC line' : NO_DEFAULT);
      await user.keyboard('{Enter}');
    } else {
      await screen.findAllByRole('option');
      // The open list starts on the current default (Office, second): None is
      // one up, NYC two down past Paid search.
      await user.keyboard(target === 'nyc' ? '{ArrowDown}{ArrowDown}{Enter}' : '{ArrowUp}{Enter}');
    }
  }

  it.each([
    ['choosing a number', 'nyc' as const, 'Organization default is now (555) 201-4412', '/numbers/num-nyc/', true],
    ['removing the default', 'none' as const, 'Organization default removed', '/numbers/num-office/', false],
  ])('%s from the keyboard leaves focus on the control once the save settles', async (_n, target, toastText, path, isDefault) => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    await pickWithKeyboard(user, target);

    await waitFor(() =>
      expect(mockApi.put).toHaveBeenCalledWith(`/api/communication${path}org-default`, { is_org_default: isDefault }, SAVE_OPTS),
    );
    expect(await screen.findByText(toastText)).toBeInTheDocument();
    await waitFor(() => expect(orgDefaultControl()).not.toBeDisabled());
    await waitFor(() => expect(orgDefaultControl()).toHaveFocus());
  });

  it('does not pull focus back when the person has moved on while the save runs', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Organization default');

    await pickWithKeyboard(user, 'nyc');
    await waitFor(() => expect(orgDefaultControl()).toBeDisabled());
    // Still saving: the person tabs on to the numbers search.
    const search = screen.getByRole('searchbox', { name: 'Search numbers' });
    search.focus();
    expect(search).toHaveFocus();

    expect(await screen.findByText('Organization default is now (555) 201-4412')).toBeInTheDocument();
    await waitFor(() => expect(orgDefaultControl()).not.toBeDisabled());
    // Let the settle effect run, then check focus stayed where they put it.
    await new Promise((r) => setTimeout(r, 50));
    expect(search).toHaveFocus();
  });
});

describe('Caller ID org default review follow-ups', () => {
  it('a paused or pending default that is calls-only shows the "can\'t be used" note, not the calls-only warning', async () => {
    for (const status of ['paused', 'pending']) {
      serve([OFFICE, NYC, { ...OLD, status, sms_enabled: false, is_org_default: true }].map((r) =>
        r.id === 'num-office' ? { ...r, is_org_default: false } : r,
      ));
      const { unmount } = renderPage();
      await screen.findByText('Organization default');

      expect(screen.getByText(/This number can't be used right now, so anyone/)).toBeInTheDocument();
      expect(screen.queryByText(CALLS_ONLY_WARNING)).toBeNull();
      unmount();
    }
  });

  it.each([
    ['a small org (plain select)', [] as Row[], '[data-slot="select-separator"]'],
    ['a large org (searchable list)', filler(8), '[data-slot="command-separator"]'],
  ])('a divider follows "No organization default" in %s', async (_n, extra, separator) => {
    const user = userEvent.setup();
    serve([OFFICE, PAID, NYC, OLD, NEW, ...extra]);
    renderPage();
    await screen.findByText('Organization default');

    await user.click(orgDefaultControl());
    const [none, firstNumber] = await screen.findAllByRole('option');
    const rule = document.querySelector(separator);
    expect(rule).not.toBeNull();
    // After None, before the first number.
    expect(none!.compareDocumentPosition(rule!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rule!.compareDocumentPosition(firstNumber!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll(separator)).toHaveLength(1);
  });

  it("the notes under the select never widen its box: they take the box's width and add none of their own", async () => {
    serve(noDefault([OFFICE, PAID, NYC, OLD, NEW]));
    renderPage();
    const note = await screen.findByText(/^Anyone without a usable default of their own/);
    const region = note.closest('[aria-live="polite"]')!;
    // jsdom has no layout, so this pins the mechanism: zero intrinsic width,
    // stretched to the box. Measured in a real browser in the review report.
    expect(region).toHaveClass('w-0', 'min-w-full');
  });
});

describe('Caller ID wording follows whether the org default can be used', () => {
  const table = () => screen.getByRole('table', { name: 'Phone numbers and who can use them' });
  const rowOf = (number: string) =>
    within(table())
      .getAllByRole('row')
      .find((r) => r.textContent?.includes(number))!;
  const INTRO_FIRST = 'Choose who can call and text from each number.';
  const INTRO_DEFAULT = /Anyone without a number of their own uses the organization default\./;

  it('an active default with nobody on it reads "Everyone (organization default)"', async () => {
    serve([{ ...OFFICE, is_org_default: false }, PAID, { ...NYC, is_org_default: true }, OLD, NEW]);
    renderPage();
    await screen.findByRole('table');

    expect(within(rowOf('(555) 201-4412')).getByText('Everyone (organization default)')).toBeInTheDocument();
    expect(screen.queryByText(/Organization default \(can't be used right now\)/)).toBeNull();
  });

  it.each([['paused'], ['inactive'], ['pending']])(
    'a %s default with nobody on it says it cannot be used, not that everyone uses it',
    async (status) => {
      serve([{ ...OFFICE, is_org_default: false }, PAID, NYC, { ...OLD, status, is_org_default: true }, NEW]);
      renderPage();
      await screen.findByRole('table');

      expect(
        within(rowOf('(800) 555-0199')).getByText("Organization default (can't be used right now)"),
      ).toBeInTheDocument();
      expect(screen.queryByText('Everyone (organization default)')).toBeNull();
    },
  );

  it('the intro names the organization default only while there is a usable one', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    expect(screen.getByText(INTRO_DEFAULT)).toHaveTextContent(INTRO_FIRST);

    // Removing it: the intro no longer promises an organization default.
    await user.click(orgDefaultControl());
    await user.click(await screen.findByRole('option', { name: new RegExp(NO_DEFAULT) }));
    await screen.findByText('Organization default removed');
    await waitFor(() => expect(screen.queryByText(INTRO_DEFAULT)).toBeNull());
    expect(screen.getByText(INTRO_FIRST)).toBeInTheDocument();
  });

  it('the intro does not promise a default that cannot be used', async () => {
    serve([{ ...OFFICE, is_org_default: false }, PAID, NYC, { ...OLD, is_org_default: true }, NEW]);
    renderPage();
    await screen.findByRole('table');

    expect(screen.getByText(INTRO_FIRST)).toBeInTheDocument();
    expect(screen.queryByText(INTRO_DEFAULT)).toBeNull();
  });
});

describe('Caller ID "Nobody assigned" and an org default that cannot be used', () => {
  const table = () => screen.getByRole('table', { name: 'Phone numbers and who can use them' });
  const filterButton = (name: string) =>
    within(screen.getByRole('group', { name: 'Filter numbers' })).getByRole('button', { name });
  const listed = (number: string) =>
    within(table())
      .queryAllByRole('row')
      .some((r) => r.textContent?.includes(number));

  it('lists a paused org default with nobody on it, and still leaves out an active one', async () => {
    const user = userEvent.setup();
    // Paused default with nobody on it; NYC (active, nobody) is not the default.
    serve([{ ...OFFICE, is_org_default: false }, PAID, NYC, { ...OLD, is_org_default: true }, NEW]);
    const { unmount } = renderPage();
    await screen.findByRole('table');
    await user.click(filterButton('Nobody assigned'));
    expect(listed('(800) 555-0199')).toBe(true);
    unmount();

    // The same number as an ACTIVE default is used by everyone: left out.
    serve([{ ...OFFICE, is_org_default: false }, PAID, NYC, { ...OLD, status: 'active', is_org_default: true }, NEW]);
    renderPage();
    await screen.findByRole('table');
    await user.click(filterButton('Nobody assigned'));
    expect(listed('(800) 555-0199')).toBe(false);
    expect(listed('(555) 201-4412')).toBe(true);
  });
});
