/**
 * BOOKING A WALKTHROUGH SOMEWHERE OTHER THAN THE SERVICE ADDRESS — the lead-side door.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 *
 * The dialog that already asks WHEN and WHO now asks WHERE, because that is where the office
 * already decides everything else that varies per trip.
 *
 * THE ONE THING THAT IS EASY TO GET WRONG, and the reason this suite exists rather than a smoke
 * test: the control defaults to the service address, and the form states its location on EVERY
 * save. So a Reschedule opened on a showroom booking to move the time by an hour would post
 * "service address" and send the customer to their own house after they had been told to come to
 * the showroom. The API's omitted-means-unchanged rule cannot save it - only the SEED can. That
 * is what `stored/seed` covers below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };
const SHOWROOM = { id: 'loc-1', name: 'Showroom' };

const rosterState = vi.hoisted(() => ({
  users: [] as { id: string; first_name: string; last_name: string; role: string; department: null }[],
}));
const locationState = vi.hoisted(() => ({ list: [] as { id: string; name: string }[] }));

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: rosterState.users }),
}));

vi.mock('@/lib/api/locations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/locations')>()),
  useLocations: () => ({ data: locationState.list }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: [] }) },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * Deliberately WITHOUT `assign User`, so `seedPerformers` puts the actor in the Performers field
 * on its own. These cases are about WHERE, and a performer field left empty would block the
 * submit for a reason that has nothing to do with the location.
 */
const ability = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);

function signedInAs(id: string) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...SALES, id, email: 'sam@test.com', role: 'SALES' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
}

/** A lead with nothing booked - the first-booking form is on screen from mount. */
const UNBOOKED = {
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: null,
  walkthrough_notes: '',
  walkthrough_performers: [],
  walkthrough_location: null,
};

/** A LIVE walkthrough already booked AT THE SHOWROOM - the row a plain reschedule must not move. */
const BOOKED_AT_SHOWROOM = {
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: 60,
  walkthrough_notes: '',
  walkthrough_performers: [{ user: SALES }],
  walkthrough_location: {
    location_id: SHOWROOM.id,
    address_line1: null, address_line2: null, city: null, state: null, zip: null,
  },
};

function renderTab(lead: Record<string, unknown>) {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={lead}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough
    />,
    { ability },
  );
}

/** The booking body this door actually posted. */
function scheduleBody(): Record<string, unknown> {
  const call = vi.mocked(api.post).mock.calls.find(([url]) =>
    String(url).endsWith('/walkthrough/schedule'),
  );
  if (!call) throw new Error('the form posted nothing to /walkthrough/schedule');
  return call[1] as Record<string, unknown>;
}

/** The booking body the ADDITIONAL-visit door actually posted. */
function visitsBody(): Record<string, unknown> {
  const call = vi.mocked(api.post).mock.calls.find(([url]) => String(url).endsWith('/visits'));
  if (!call) throw new Error('the form posted nothing to /visits');
  return call[1] as Record<string, unknown>;
}

function visibleTextboxes(scope: HTMLElement): [HTMLElement, HTMLElement] {
  const [date, time] = within(scope)
    .getAllByRole('textbox')
    .filter((el) => (el as HTMLInputElement).type !== 'hidden');
  if (!date || !time) throw new Error('expected a start date and a start time field in this form');
  return [date, time];
}

beforeEach(() => {
  vi.clearAllMocks();
  rosterState.users = [{ ...SALES, role: 'SALES', department: null }];
  locationState.list = [SHOWROOM];
  signedInAs(SALES.id);
});

describe('the walkthrough dialog asks where', () => {
  it('offers the control at all, defaulting to the service address', () => {
    renderTab(UNBOOKED);
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('books at the showroom, sending the id and no copy of its address', async () => {
    renderTab(UNBOOKED);
    const user = userEvent.setup();

    const [startDate, startTime] = visibleTextboxes(document.body);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');

    await user.click(screen.getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: SHOWROOM.name }));

    await user.click(screen.getByRole('button', { name: /Schedule Walkthrough/i }));

    // A pointer, so a corrected showroom address flows into an unsent reminder (D2).
    expect(scheduleBody().location).toEqual({ location_id: SHOWROOM.id });
  });

  it('sends explicit null when the service address is chosen — clear, not "unchanged"', async () => {
    renderTab(UNBOOKED);
    const user = userEvent.setup();

    const [startDate, startTime] = visibleTextboxes(document.body);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');
    await user.click(screen.getByRole('button', { name: /Schedule Walkthrough/i }));

    expect(scheduleBody().location).toBeNull();
  });
});

describe('rescheduling a booking that is NOT at the service address', () => {
  it('seeds the control from the stored location', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    // Not "Service address". A control that defaulted here would move the meeting on the next
    // save, and nothing on screen would say so.
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(SHOWROOM.name);
  });

  it('moving only the time leaves the meeting at the showroom', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    const [, startTime] = visibleTextboxes(document.body);
    await user.clear(startTime);
    await user.type(startTime, '02:00 PM');
    await user.click(screen.getByRole('button', { name: /Save|Reschedule Walkthrough/i }));

    expect(scheduleBody().location).toEqual({ location_id: SHOWROOM.id });
  });
});

// ── SLICE 3: the ADDITIONAL-visit form asks where as well ────────────────────
//
// Slice: md_files/issues/scheduling/03-book-an-additional-visit-at-its-own-location.md
//
// Slice 1 deliberately HID this control on the additional-visit form, because `POST
// /leads/:id/visits` did not take a location and Zod strips unknown keys - offering it would have
// let somebody pick the showroom, watch the visit book, and have the choice silently dropped. The
// door takes one now, so the gate comes off.
//
// This form is the one the feature was written for. A lead's second trip is exactly the trip that
// is somewhere else: the first meeting at the showroom, the measure at the customer's house, a
// design review back at the showroom.

describe('booking an ADDITIONAL visit asks where', () => {
  const openAddVisit = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
    return user;
  };

  it('offers the control, defaulting to the service address', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    await openAddVisit();

    // A SECOND trip is a fresh decision, so it opens at the default rather than inheriting where
    // the live visit is - copying visit 1's showroom onto visit 2 is the seeded default that
    // becomes an unintended write.
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('books the second visit at the showroom, sending the id and no copy of its address', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');

    await user.click(within(form).getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: SHOWROOM.name }));
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    // The id alone - a pointer, so a corrected showroom address flows into an unsent reminder.
    expect(visitsBody().location).toEqual({ location_id: SHOWROOM.id });
  });

  it('sends explicit null when the second visit is at the service address', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    // The person looked at the control and left it where it was, so this is a statement, not
    // silence - and on a create the API reads the two the same way.
    expect(visitsBody().location).toBeNull();
  });

  it('books the second visit at a one-off address, parsed into fields rather than one blob', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');

    await user.click(within(form).getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: 'Other…' }));
    await user.type(screen.getByLabelText('Address'), '400 Supplier Rd');
    await user.type(screen.getByLabelText('City'), 'Charlotte');
    await user.type(screen.getByLabelText('State'), 'NC');

    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    expect(visitsBody().location).toEqual({
      address_line1: '400 Supplier Rd',
      city: 'Charlotte',
      state: 'NC',
    });
  });

  it('will not let a half-typed one-off address be posted at all', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');

    await user.click(within(form).getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: 'Other…' }));
    await user.type(screen.getByLabelText('Address'), '400 Supplier Rd');

    // The API refuses line-1-without-a-city on the same rule. Refusing here keeps it where the
    // person can see which field is missing, rather than posting into a 400.
    expect(within(form).getByRole('button', { name: /Book Visit/i })).toBeDisabled();
  });

  it('books the second visit WITHOUT moving the first', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');
    await user.click(within(form).getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: SHOWROOM.name }));
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    // /walkthrough/schedule REUSES the live visit row, so a post there would have moved visit 1
    // to the new slot instead of adding visit 2 - and carried this location onto it.
    const reschedules = vi
      .mocked(api.post)
      .mock.calls.filter(([url]) => String(url).includes('/walkthrough/schedule'));
    expect(reschedules).toHaveLength(0);
  });

  /**
   * THE OVERRIDE POSTS TO THE DOOR THE FORM IS STANDING IN FRONT OF.
   *
   * The conflict banner and its "Schedule anyway" button are SHARED by the reschedule form and
   * the additional-visit form, so the component picks the mutation to re-post with off
   * `isAddingVisit`. One line:
   *
   *     const activeScheduleMutation = isAddingVisit ? addVisitMutation : scheduleMutation;
   *
   * Nothing pinned it, and slice 3 is what made getting it wrong expensive. The two doors are not
   * two spellings of one write: `/walkthrough/schedule` REUSES the lead's live visit row, so an
   * override that posted there would move visit 1 to visit 2's slot AND carry visit 2's location
   * onto it - the customer who was told about visit 1 gets sent to the showroom instead, and the
   * second visit is never booked at all. And it happens on the ONE path where the person has just
   * been told there is a clash, so the wrong row is written at exactly the moment they are
   * reading a warning about a different one.
   *
   * A conflict is the only way to reach the button, so the conflict is what this raises.
   */
  it('"Schedule anyway" re-posts to the visits door, carrying the location, never to the reschedule one', async () => {
    renderTab(BOOKED_AT_SHOWROOM);
    const user = await openAddVisit();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');
    await user.click(within(form).getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: SHOWROOM.name }));

    // The API refuses the slot: a performer is already booked over it. 409 is what puts the
    // override on screen at all - by STATUS, so an empty list still shows it.
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { conflicts: [] } } });
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    await user.click(await within(form).findByRole('button', { name: /Schedule anyway/i }));

    // Nothing was posted at the reschedule door - not by the first attempt, and not by the
    // override. This is the assertion that goes red if the ternary above is ever flattened.
    const reschedules = vi
      .mocked(api.post)
      .mock.calls.filter(([url]) => String(url).includes('/walkthrough/schedule'));
    expect(reschedules).toHaveLength(0);

    // The override re-posts the IDENTICAL body past the 409 - same door, same showroom, plus
    // `force`. A second post that dropped the location would book the trip at the customer's
    // house after the person had picked the showroom and only agreed to the clash.
    const [url, body] = vi.mocked(api.post).mock.calls.at(-1)!;
    expect(String(url)).toBe('/api/leads/lead-1/visits');
    expect(body).toMatchObject({ force: true, location: { location_id: SHOWROOM.id } });
    expect(vi.mocked(api.post).mock.calls).toHaveLength(2);
  });

  it('opens at the service address even when Reschedule has just had the showroom in it', async () => {
    // Reschedule and Book Another Visit SHARE one set of fields, so the second form opens holding
    // whatever the first was left with unless the handler states every one of them. This is the
    // path that catches a location left behind: the shared value is the stored showroom by the
    // time the add form opens, so "Service address" here can only have come from `openAddVisit`
    // saying so.
    renderTab(BOOKED_AT_SHOWROOM);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(SHOWROOM.name);
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));

    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });
});
