// Caller ID slice 04 - Settings > Caller ID can be searched, filtered, counted
// and paged, so an org with 30+ numbers stays usable.
//
// Driven through the routed page with only the HTTP client mocked, as the
// slice 03 test is: the caller-ID hooks are real, and a tiny stateful stand-in
// for the assignment endpoint means a refetch returns what the server holds.
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
  { id: 'u-maya', name: 'Maya Cohen' },
  { id: 'u-sam', name: 'Sam Reyes' },
];
const nameOf = (id: string) => USERS.find((u) => u.id === id)!.name;
const person = (id: string, isDefault = false): Assignment => ({
  user_id: id, user_name: nameOf(id), is_default: isDefault,
});

/**
 * 32 numbers, (555) 201-4400 to (555) 201-4431, listed in that order.
 *  - 4400 "Office line" is the org default, with nobody assigned.
 *  - People: 4403 Dana (default) + Sam, 4409 Jo, 4417 Dana, 4420 Sam, 4429 Dana + Maya.
 *    So 26 numbers have nobody assigned (32 - the org default - 5 with people).
 *  - Calls only (active, cannot text): 4405, 4412, 4420, 4427.
 *  - 4408 is paused and 4431 is still being set up; neither can text, and
 *    neither is tagged "Calls only".
 *  - 4407 is "Paid search", 4411 is "NYC line", the rest "Line N".
 */
function buildNumbers(): Row[] {
  const people: Record<number, Assignment[]> = {
    3: [person('u-dana', true), person('u-sam')],
    9: [person('u-jo')],
    17: [person('u-dana')],
    20: [person('u-sam')],
    29: [person('u-dana'), person('u-maya')],
  };
  const labels: Record<number, string> = { 0: 'Office line', 7: 'Paid search', 11: 'NYC line' };
  const callsOnly = new Set([5, 12, 20, 27]);
  return Array.from({ length: 32 }, (_, i) => ({
    id: `num-${i}`,
    e164: `+1555201${4400 + i}`,
    label: labels[i] ?? `Line ${i}`,
    is_org_default: i === 0,
    sms_enabled: !callsOnly.has(i) && i !== 8 && i !== 31,
    status: i === 8 ? 'paused' : i === 31 ? 'pending' : 'active',
    type: 'local',
    assignments: people[i] ?? [],
  }));
}

let server: Row[] = [];
function serve(rows: Row[]) {
  server = structuredClone(rows);
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

beforeEach(() => {
  vi.clearAllMocks();
  mockCommAdmin();
  serve(buildNumbers());
  mockApi.get.mockImplementation((url: string) =>
    url === LIST_URL
      ? Promise.resolve({ data: { numbers: structuredClone(server), users: USERS } })
      : Promise.resolve({ data: {} }),
  );
  mockApi.put.mockImplementation((url: string, body?: unknown) => {
    const m = url.match(/^\/api\/communication\/numbers\/([^/]+)\/assignments$/);
    if (m) {
      const ids = (body as { user_ids: string[] }).user_ids;
      server = server.map((n) =>
        n.id === m[1] ? { ...n, assignments: ids.map((uid) => person(uid)) } : n,
      );
    }
    return Promise.resolve({ data: { ok: true } });
  });
});

afterEach(() => {
  toast.dismiss();
});

function renderPage() {
  return renderWithProviders(
    <>
      <PhoneNumbersSettingsPage />
      <KitToaster />
    </>,
    { ability: ADMIN },
  );
}

const table = () => screen.getByRole('table', { name: 'Phone numbers and who can use them' });
/** The numbers on the current page, in order, as their row headers show them. */
const shownNumbers = () =>
  within(table())
    .queryAllByRole('rowheader')
    .map((h) => h.querySelector('.font-mono')!.textContent);
const search = () => screen.getByRole('searchbox', { name: 'Search numbers' });
const filters = () => screen.getByRole('group', { name: 'Filter numbers' });
const filterButton = (name: string) => within(filters()).getByRole('button', { name });
const count = () => screen.getByTestId('caller-id-count');
const pager = () => screen.queryByRole('navigation', { name: 'Pages of numbers' });
const nextButton = () => within(pager()!).getByRole('button', { name: 'Next page' });
const prevButton = () => within(pager()!).getByRole('button', { name: 'Previous page' });

async function ready() {
  renderPage();
  await screen.findByRole('table', { name: 'Phone numbers and who can use them' });
}

describe('Caller ID search', () => {
  it("searching a person's name lists every number assigned to that person, across pages", async () => {
    const user = userEvent.setup();
    await ready();
    // Dana's third number sits on page 2 of the full list.
    expect(shownNumbers()).not.toContain('(555) 201-4429');

    await user.type(search(), 'dana');

    expect(shownNumbers()).toEqual(['(555) 201-4403', '(555) 201-4417', '(555) 201-4429']);
  });

  it('a person search ignores case and matches part of a name', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(search(), 'MAYA C');

    expect(shownNumbers()).toEqual(['(555) 201-4429']);
  });

  it('a digits-only search finds the formatted number', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(search(), '5552014426');

    expect(shownNumbers()).toEqual(['(555) 201-4426']);
  });

  it('a digits search with a leading 1 or +1, or only part of the number, still finds it', async () => {
    const user = userEvent.setup();
    await ready();

    for (const typed of ['15552014426', '+1 555 201 4426', '4426']) {
      await user.clear(search());
      await user.type(search(), typed);
      expect(shownNumbers()).toEqual(['(555) 201-4426']);
    }
  });

  it('searching the formatted number, or the number\'s name, both work', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(search(), '(555) 201-4411');
    expect(shownNumbers()).toEqual(['(555) 201-4411']);

    await user.clear(search());
    await user.type(search(), 'paid SEARCH');
    expect(shownNumbers()).toEqual(['(555) 201-4407']);
  });
});

describe('Caller ID filters', () => {
  it('"Nobody assigned" lists the numbers with nobody on them, leaving out the org default, and the count follows', async () => {
    const user = userEvent.setup();
    await ready();
    expect(count()).toHaveTextContent(/^32 numbers$/);

    await user.click(filterButton('Nobody assigned'));

    expect(count()).toHaveTextContent(/^26 of 32 numbers$/);
    const shown = shownNumbers();
    expect(shown).toHaveLength(25);
    // The org default (everyone uses it) and every number with people are out.
    for (const n of ['(555) 201-4400', '(555) 201-4403', '(555) 201-4409', '(555) 201-4417', '(555) 201-4420']) {
      expect(shown).not.toContain(n);
    }
    expect(shown.slice(0, 3)).toEqual(['(555) 201-4401', '(555) 201-4402', '(555) 201-4404']);
  });

  it('"Calls only" lists exactly the numbers tagged Calls only, and the count follows', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(filterButton('Calls only'));

    expect(shownNumbers()).toEqual(['(555) 201-4405', '(555) 201-4412', '(555) 201-4420', '(555) 201-4427']);
    expect(count()).toHaveTextContent(/^4 of 32 numbers$/);
    // Paused and not-ready numbers keep their own tags and are not listed.
    expect(within(table()).queryByText('Paused')).toBeNull();
    expect(within(table()).queryByText('Unavailable')).toBeNull();
  });

  it('marks the chosen filter with aria-pressed, one at a time', async () => {
    const user = userEvent.setup();
    await ready();
    const pressed = () =>
      within(filters()).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
    expect(pressed()).toEqual([['All', 'true'], ['Nobody assigned', 'false'], ['Calls only', 'false']]);

    await user.click(filterButton('Calls only'));
    expect(pressed()).toEqual([['All', 'false'], ['Nobody assigned', 'false'], ['Calls only', 'true']]);

    await user.click(filterButton('All'));
    expect(pressed()).toEqual([['All', 'true'], ['Nobody assigned', 'false'], ['Calls only', 'false']]);
    expect(count()).toHaveTextContent(/^32 numbers$/);
  });

  it('a search and a filter narrow together', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(search(), 'sam');
    expect(shownNumbers()).toEqual(['(555) 201-4403', '(555) 201-4420']);
    await user.click(filterButton('Calls only'));

    expect(shownNumbers()).toEqual(['(555) 201-4420']);
    expect(count()).toHaveTextContent(/^1 of 32 numbers$/);
  });
});

describe('Caller ID count', () => {
  it('is announced through a polite live region that was on the page before the count changed', async () => {
    const user = userEvent.setup();
    await ready();
    const region = count();
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent(/^32 numbers$/);

    await user.type(search(), 'dana');

    // The same element, not a new one: a screen reader only announces a change
    // inside a region that already existed.
    expect(count()).toBe(region);
    expect(region).toHaveTextContent(/^3 of 32 numbers$/);
  });
});

describe('Caller ID paging', () => {
  it('shows 25 numbers per page, with Previous and Next disabled at the ends', async () => {
    const user = userEvent.setup();
    await ready();

    expect(shownNumbers()).toHaveLength(25);
    expect(shownNumbers()[24]).toBe('(555) 201-4424');
    expect(within(pager()!).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(prevButton()).toBeDisabled();
    expect(nextButton()).toBeEnabled();

    await user.click(nextButton());

    expect(shownNumbers()).toEqual([
      '(555) 201-4425', '(555) 201-4426', '(555) 201-4427', '(555) 201-4428',
      '(555) 201-4429', '(555) 201-4430', '(555) 201-4431',
    ]);
    expect(within(pager()!).getByText('Page 2 of 2')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
    expect(prevButton()).toBeEnabled();

    await user.click(prevButton());
    expect(shownNumbers()[0]).toBe('(555) 201-4400');
    expect(within(pager()!).getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('a new search goes back to page 1', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(nextButton());
    expect(within(pager()!).getByText('Page 2 of 2')).toBeInTheDocument();

    // Every number has 555 in it, so the result still spans two pages.
    await user.type(search(), '555');

    expect(within(pager()!).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(shownNumbers()).toHaveLength(25);
    expect(shownNumbers()[0]).toBe('(555) 201-4400');
  });

  it('a new filter goes back to page 1', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(nextButton());

    // 26 numbers have nobody assigned: still two pages.
    await user.click(filterButton('Nobody assigned'));

    expect(within(pager()!).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(shownNumbers()).toHaveLength(25);
    expect(shownNumbers()[0]).toBe('(555) 201-4401');
  });

  it('never lands on an empty page when a save shrinks the list under it', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(filterButton('Nobody assigned'));
    await user.click(nextButton());
    // Page 2 holds the 26th unassigned number only.
    expect(shownNumbers()).toEqual(['(555) 201-4431']);

    // Assign someone to it: after the save and refetch, 25 numbers are left
    // unassigned, which is one page.
    await user.click(screen.getByRole('button', { name: 'Edit people for (555) 201-4431' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Ari Levin' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(count()).toHaveTextContent(/^25 of 32 numbers$/));
    expect(shownNumbers()).toHaveLength(25);
    expect(shownNumbers()[0]).toBe('(555) 201-4401');
    expect(shownNumbers()).not.toContain('(555) 201-4431');
  });

  it('keeps keyboard focus on a working pager button when Next or Previous reaches the end', async () => {
    const user = userEvent.setup();
    await ready();

    nextButton().focus();
    await user.keyboard('{Enter}');
    // Next is now disabled; focus moves to Previous, not to the page body.
    expect(within(pager()!).getByText('Page 2 of 2')).toBeInTheDocument();
    expect(nextButton()).toBeDisabled();
    expect(prevButton()).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(within(pager()!).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(prevButton()).toBeDisabled();
    expect(nextButton()).toHaveFocus();
  });

  it('leaves focus on Next while there are more pages after it', async () => {
    const user = userEvent.setup();
    serve([...buildNumbers(), ...buildNumbers().map((n, i) => ({ ...n, id: `more-${i}`, e164: `+1555301${4400 + i}` }))]);
    await ready();
    expect(within(pager()!).getByText('Page 1 of 3')).toBeInTheDocument();

    nextButton().focus();
    await user.keyboard('{Enter}');

    expect(within(pager()!).getByText('Page 2 of 3')).toBeInTheDocument();
    expect(nextButton()).toHaveFocus();
  });

  it('shows no pager when everything fits on one page', async () => {
    const user = userEvent.setup();
    await ready();

    await user.type(search(), 'dana');

    expect(pager()).toBeNull();
  });
});

describe('Caller ID focus after a save', () => {
  it('returns focus to the search box when the saved number left the filtered list', async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(filterButton('Nobody assigned'));

    await user.click(screen.getByRole('button', { name: 'Edit people for (555) 201-4401' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Ari Levin' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The number now has someone on it, so its row (and Edit button) is gone.
    expect(shownNumbers()).not.toContain('(555) 201-4401');
    await waitFor(() => expect(search()).toHaveFocus());
  });

  it('still returns focus to the Edit button when the saved number stays in the list', async () => {
    const user = userEvent.setup();
    await ready();

    await user.click(screen.getByRole('button', { name: 'Edit people for (555) 201-4401' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Ari Levin' }));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit people for (555) 201-4401' })).toHaveFocus(),
    );
  });
});

describe('Caller ID empty state', () => {
  it('says no numbers match and suggests changing the search or filter', async () => {
    const user = userEvent.setup();
    await ready();
    expect(screen.queryByText('No numbers match. Try a different search or filter.')).toBeNull();

    await user.type(search(), 'nobody by this name');

    expect(within(table()).getByText('No numbers match. Try a different search or filter.')).toBeInTheDocument();
    expect(shownNumbers()).toEqual([]);
    expect(count()).toHaveTextContent(/^0 of 32 numbers$/);
    expect(pager()).toBeNull();

    // Clearing the search brings the list back.
    await user.clear(search());
    expect(shownNumbers()).toHaveLength(25);
    expect(screen.queryByText('No numbers match. Try a different search or filter.')).toBeNull();
  });

  it('shows the empty state when a filter has nothing to show', async () => {
    const user = userEvent.setup();
    serve(buildNumbers().map((n) => ({ ...n, sms_enabled: true })));
    await ready();

    await user.click(filterButton('Calls only'));

    expect(within(table()).getByText('No numbers match. Try a different search or filter.')).toBeInTheDocument();
    expect(count()).toHaveTextContent(/^0 of 32 numbers$/);
  });
});
