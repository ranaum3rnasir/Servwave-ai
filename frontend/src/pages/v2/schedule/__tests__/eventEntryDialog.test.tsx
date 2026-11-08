/**
 * The Event dialog (calendar-entries spec §2/§4/§7, slice 04): create, edit, hard delete,
 * one participants field. Driven through the public interface - render, fill fields, click
 * buttons - never by reaching into component internals.
 *
 * `renderWithProviders` from `@/__tests__/helpers` supplies the QueryClient + AbilityProvider
 * this dialog and the components it composes (`CustomerPickerWithCreate`,
 * `ParticipantsField`'s `Combobox`) actually read from context, so a real CASL ability with
 * real `CalendarEntry`/`Customer` grants exercises the same gating the app runs, rather than
 * a stubbed `{ can: () => true }`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { asWallClock, toWallClock } from '@/lib/schedule-tz';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';

import { EventEntryDialog, roundUpToQuarterHour } from '../components/eventEntryDialog';

const mockApi = vi.mocked(api);

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
// A SALES-shaped grant: can see the entry (read) but not write or delete it (spec §4 - "gets
// it through UserPermissionOverride, not by role" implies read without the other three is a
// real, reachable state).
const READ_ONLY = buildAbility([{ action: 'read', subject: 'CalendarEntry' }]);

const TZ = 'America/New_York';

/** Routes every `api.get` call this suite makes by URL, defaulting to an empty payload so an
 *  unmocked endpoint (e.g. a stray fetch) fails loudly on shape rather than hanging forever. */
function mockGets(byUrl: Record<string, unknown>) {
  mockApi.get.mockImplementation((url: string) => {
    // The pickers moved to the scoped roster endpoint. The fixtures below still key on
    // the directory path, so alias it rather than restate the roster at 24 call sites.
    const key = url === '/api/users/assignable' ? '/api/users' : url;
    return Promise.resolve({ data: byUrl[key] ?? {} });
  });
}

function makeEntryEvent(overrides: Partial<SchedulableEvent> = {}): SchedulableEvent {
  const start = asWallClock(new Date(2026, 7, 24, 14, 0));
  const end = asWallClock(new Date(2026, 7, 24, 15, 0));
  return {
    boardId: 'ce-entry-1',
    parentId: 'entry-1',
    type: 'calendar-entry',
    number: '',
    title: 'Dave is off Thursday',
    customer: '',
    crew: [],
    ownerId: null,
    isAllDay: false,
    start,
    end,
    tags: [],
    raw: {
      id: 'entry-1',
      title: 'Dave is off Thursday',
      description: 'Team notice',
      start: start.toISOString(),
      end: end.toISOString(),
      is_all_day: false,
      participants: [],
    },
    ...overrides,
  };
}

/** The Start/End time inputs display 'h:mm a' (e.g. '5:30 AM') — see `formatTimeForInput`
 *  in `lib/date-input.ts`. Minutes-since-midnight, for the boundary/duration assertions below. */
function displayTimeToMinutes(display: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(display.trim());
  if (!m) throw new Error(`unparseable rendered time: "${display}"`);
  const [, hh, mm, ampm] = m as unknown as [string, string, string, string];
  let hours = Number(hh) % 12;
  if (ampm.toUpperCase() === 'PM') hours += 12;
  return hours * 60 + Number(mm);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Product-owner finding, reproduced on staging: "New Event" from the plain toolbar button
// seeded the dialog from the clock to the minute (5:16 AM), so every single create started
// with the user correcting two fields. `roundUpToQuarterHour` is the pure helper that fixes
// it — tested directly here so the boundary/rollover/timezone behaviour doesn't need a
// mounted dialog to verify.
describe('roundUpToQuarterHour', () => {
  it('rounds a mid-quarter time up to the next boundary', () => {
    const rounded = roundUpToQuarterHour(asWallClock(new Date(2026, 7, 24, 5, 16)));
    expect(rounded.getHours()).toBe(5);
    expect(rounded.getMinutes()).toBe(30);
  });

  it('rounds 5:31 up to 5:45, not all the way to 6:00', () => {
    const rounded = roundUpToQuarterHour(asWallClock(new Date(2026, 7, 24, 5, 31)));
    expect(rounded.getHours()).toBe(5);
    expect(rounded.getMinutes()).toBe(45);
  });

  it.each([0, 15, 30, 45])('leaves a time already on a :%i boundary unchanged', (minute) => {
    const input = asWallClock(new Date(2026, 7, 24, 5, minute));
    const rounded = roundUpToQuarterHour(input);
    expect(rounded.getTime()).toBe(input.getTime());
  });

  it('rolls the date forward when the round-up crosses midnight', () => {
    const rounded = roundUpToQuarterHour(asWallClock(new Date(2026, 7, 24, 23, 52)));
    expect(rounded.getFullYear()).toBe(2026);
    expect(rounded.getMonth()).toBe(7); // August (0-indexed)
    expect(rounded.getDate()).toBe(25);
    expect(rounded.getHours()).toBe(0);
    expect(rounded.getMinutes()).toBe(0);
  });

  it('rounds in the ORG timezone, not the browser zone', () => {
    // 2026-08-24T09:16:00Z is 05:16 in America/New_York (EDT, UTC-4) — the exact PO
    // scenario. A wrong implementation that rounded the raw UTC instant instead of the
    // NY wall clock would land on 09:30, not 05:30.
    const instant = new Date('2026-08-24T09:16:00.000Z');
    const wallClock = toWallClock(instant, 'America/New_York');
    const rounded = roundUpToQuarterHour(wallClock);
    expect(rounded.getHours()).toBe(5);
    expect(rounded.getMinutes()).toBe(30);
  });
});

describe('EventEntryDialog — create', () => {
  it('saves with a title and the seeded time and no participants — POST fires with participants: []', async () => {
    // A real assignable user is on the roster but never picked - this is also the "creator
    // not auto-attached" proof (spec §2): nothing in the payload names anyone unless a chip
    // for them was actually added.
    mockGets({ '/api/users': { users: [
      { id: 'u-me', first_name: 'Casey', last_name: 'Diaz', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
    ] } });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });
    const onClose = vi.fn();

    const { queryClient } = renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={onClose} />,
      { ability: ADMIN },
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    expect(await screen.findByText('New Event')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Team lunch' } });
    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [url, body] = mockApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/calendar-entries');
    expect(body.title).toBe('Team lunch');
    expect(body.participants).toEqual([]);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['schedule-calendar-entries'] });
    // The customer page's Schedule tab (slice 10, merged after this dialog was first
    // written) reads `['customer-calendar-entries', id]` - every write here must refresh
    // it too, or an edited/deleted Event reads stale on that page until a full reload
    // (the #1718/#1725 class).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-calendar-entries'] });
    expect(onClose).toHaveBeenCalled();
  });

  // Product-owner finding: the plain toolbar "New Event" button (no `createSeed`) must seed
  // a 15-minute-aligned start, with the end exactly DEFAULT_EVENT_DURATION_MIN (60) after it —
  // not whatever minute the clock happened to read. Checked as an invariant on the real "now"
  // rather than a frozen clock (this suite has no clock-injection convention to follow), so the
  // assertion holds no matter which minute the test happens to run in.
  it('CREATE mode (no createSeed) seeds a 15-minute-aligned start and an end 60 minutes later', async () => {
    mockGets({ '/api/users': { users: [] } });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    const startTime = await screen.findByLabelText('Start time');
    const endTime = screen.getByLabelText('End time');
    const startMinutes = displayTimeToMinutes((startTime as HTMLInputElement).value);
    const endMinutes = displayTimeToMinutes((endTime as HTMLInputElement).value);

    expect(startMinutes % 15).toBe(0);
    // Modulo 1440 so a seed near midnight (end wraps to the next day) still reads correctly.
    expect((endMinutes - startMinutes + 1440) % 1440).toBe(60);
  });

  // QA finding 3 (slice 05): the all-day slot popover's "New Event" seeds the dialog from
  // where the user clicked, rather than always defaulting to "now, one hour, timed".
  it('createSeed pre-fills an all-day create from the clicked slot', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });
    const onClose = vi.fn();
    const seedStart = asWallClock(new Date(2026, 7, 26, 0, 0));
    const seedEnd = asWallClock(new Date(2026, 7, 27, 0, 0));

    renderWithProviders(
      <EventEntryDialog
        mode="create" open event={null} tz={TZ} onClose={onClose}
        createSeed={{ start: seedStart, end: seedEnd, isAllDay: true }}
      />,
      { ability: ADMIN },
    );

    // Pre-ticked, and the timed fields are already gone - not something the user has to
    // notice and flip themselves after clicking "New Event" from the all-day strip.
    expect(await screen.findByRole('checkbox', { name: /all day/i })).toBeChecked();
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Dave is off Thursday' } });
    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [, body] = mockApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.is_all_day).toBe(true);
    const start = new Date(body.start as string);
    const end = new Date(body.end as string);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('adding a user and an existing customer produces one participants array with both kinds', async () => {
    mockGets({
      '/api/users': { users: [
        { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', is_active: true, has_login: true, department: null },
      ] },
      '/api/customers': { customers: [
        { id: 'c-bob', first_name: 'Bob', last_name: 'Vance', company_name: null, customer_number: 'C0001' },
      ] },
    });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });
    const onClose = vi.fn();

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={onClose} />,
      { ability: ADMIN },
    );

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Client kickoff' } });

    // Add the user via the roster combobox.
    fireEvent.click(screen.getByRole('combobox', { name: /add team member/i }));
    fireEvent.click(await screen.findByText('Alice Ng'));
    expect(await screen.findByLabelText('Remove Alice Ng')).toBeInTheDocument();

    // Add the customer via the reused CustomerPickerWithCreate search.
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'bob' } });
    fireEvent.click(await screen.findByText(/Bob Vance/));
    expect(await screen.findByLabelText('Remove Bob Vance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(
      '/api/calendar-entries',
      expect.objectContaining({
        participants: expect.arrayContaining([
          { kind: 'USER', user_id: 'u-alice' },
          { kind: 'CUSTOMER', customer_id: 'c-bob' },
        ]),
      }),
    ));
    const [, body] = mockApi.post.mock.calls[0] as [string, { participants: unknown[] }];
    expect(body.participants).toHaveLength(2);
  });

  // Product-owner override after manual QA (not a regression - see participantsField.tsx's
  // doc comment and this branch's commit message): the participants field's customer picker
  // must offer existing customers only, with no inline "create new customer" affordance, even
  // though spec §7 originally asked for one.
  it('offers no inline "create new customer" affordance from the participants field', async () => {
    mockGets({
      '/api/users': { users: [] },
      '/api/customers': { customers: [] },
    });
    const onClose = vi.fn();

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={onClose} />,
      { ability: ADMIN },
    );

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'Zed' } });

    // No results for "Zed" and no "Create ..." row - unlike every other customer picker in
    // the app, this one never drops into the create form.
    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create "zed"/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create new customer/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();
  });
});

describe('EventEntryDialog — edit', () => {
  it('seeds start/end from the entry and a description-only save omits them from the PATCH body', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const onClose = vi.fn();
    const event = makeEntryEvent();

    const { queryClient } = renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={onClose} />,
      { ability: ADMIN },
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    expect(await screen.findByText('Edit Event')).toBeInTheDocument();
    // The seeded fields round-trip onto the form untouched.
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Dave is off Thursday');
    expect(screen.getByLabelText(/^description/i)).toHaveValue('Team notice');

    fireEvent.change(screen.getByLabelText(/^description/i), { target: { value: 'Team notice — back Friday' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [url, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/calendar-entries/entry-1');
    expect(body.description).toBe('Team notice — back Friday');
    // The seeded-defaults hazard (#1535): a field nobody touched must not be re-derived and
    // resent, so it is simply absent rather than merely "unchanged but present".
    expect(body).not.toHaveProperty('start');
    expect(body).not.toHaveProperty('end');
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('participants');

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['schedule-calendar-entries'] });
    // The customer page's Schedule tab (slice 10, merged after this dialog was first
    // written) reads `['customer-calendar-entries', id]` - every write here must refresh
    // it too, or an edited/deleted Event reads stale on that page until a full reload
    // (the #1718/#1725 class).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-calendar-entries'] });
    expect(onClose).toHaveBeenCalled();
  });

  // Product-owner finding, guarded the other direction: rounding is a CREATE-only fallback.
  // An entry stored at a deliberately off-grid minute (2:16 PM — not a 15-minute boundary)
  // must reopen showing exactly that, not silently rounded to 2:30. This is the #1535-class
  // check this file already runs elsewhere: EDIT mode's seed is the entry's OWN stored time,
  // never re-derived or "corrected".
  it('EDIT mode seeds the entry\'s own stored time exactly, never rounded to a 15-minute boundary', async () => {
    mockGets({ '/api/users': { users: [] } });
    const offGridStart = asWallClock(new Date(2026, 7, 24, 14, 16));
    const offGridEnd = asWallClock(new Date(2026, 7, 24, 15, 16));
    const event = makeEntryEvent({
      start: offGridStart,
      end: offGridEnd,
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: offGridStart.toISOString(), end: offGridEnd.toISOString(), is_all_day: false, participants: [],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    expect(await screen.findByLabelText('Start time')).toHaveValue('2:16 PM');
    expect(screen.getByLabelText('End time')).toHaveValue('3:16 PM');
  });

  it('a time edit sends the new start/end', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const event = makeEntryEvent();

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(await screen.findByLabelText('Start time'), { target: { value: '3:00 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toHaveProperty('start');
    expect(body).toHaveProperty('end');
  });

  it('delete shows the warning first, and only the confirm issues the DELETE', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.delete.mockResolvedValue({ data: {} });
    const onClose = vi.fn();
    const event = makeEntryEvent();

    const { queryClient } = renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={onClose} />,
      { ability: ADMIN },
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    // The warning is up; nothing has been sent yet.
    expect(await screen.findByText('Delete this event?')).toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/calendar-entries/entry-1'));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['schedule-calendar-entries'] });
    // The customer page's Schedule tab (slice 10, merged after this dialog was first
    // written) reads `['customer-calendar-entries', id]` - every write here must refresh
    // it too, or an edited/deleted Event reads stale on that page until a full reload
    // (the #1718/#1725 class).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-calendar-entries'] });
    expect(onClose).toHaveBeenCalled();
  });

  it('checking All Day writes is_all_day: true and an end covering the whole final day', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const event = makeEntryEvent(); // seeded 2026-08-24 14:00 -> 15:00, is_all_day: false

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.click(await screen.findByRole('checkbox', { name: /all day/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.is_all_day).toBe(true);
    // Whole-day coverage: exactly 24h, from the seeded day's midnight to the next day's
    // midnight (org tz) - not the timed 14:00-15:00 span the entry started with.
    const start = new Date(body.start as string);
    const end = new Date(body.end as string);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('toggling All Day on and back off before saving restores the real times, not midnight-to-midnight', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const event = makeEntryEvent(); // seeded 2026-08-24 14:00 -> 15:00, is_all_day: false

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    const allDayBox = await screen.findByRole('checkbox', { name: /all day/i });
    fireEvent.click(allDayBox); // on: collapses to date-only, snaps to midnight-midnight
    expect(await screen.findByLabelText('Start date')).toBeInTheDocument();
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();

    fireEvent.click(allDayBox); // off: real time fields must come back...
    expect(await screen.findByLabelText('Start time')).toHaveValue('2:00 PM');
    expect(screen.getByLabelText('End time')).toHaveValue('3:00 PM');

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // ...and nothing net changed, so the PATCH must not resend start/end/is_all_day at all
    // (the #1535 seeded-defaults class this file already guards elsewhere) - if the toggle
    // had left the draft at midnight-to-midnight, start/end WOULD be present here and wrong.
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('is_all_day');
    expect(body).not.toHaveProperty('start');
    expect(body).not.toHaveProperty('end');
  });

  // QA FINDING 2 — unticking All Day on an entry that was ALREADY all-day when the dialog
  // opened (never toggled on this session, so there is no pre-toggle draft to bring back).
  // The literal underlying span is still 00:00->00:00 - showing that through the now-visible
  // timed fields would read as a genuine one-instant "midnight to midnight" event, which is
  // not a real time anybody meant. Falls back to a sensible business-hours default instead.
  it('unticking All Day on an entry that opened already all-day falls back to a sensible default, not midnight-to-midnight', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const dayStart = asWallClock(new Date(2026, 7, 24, 0, 0));
    const dayEnd = asWallClock(new Date(2026, 7, 25, 0, 0));
    const event = makeEntryEvent({
      isAllDay: true,
      start: dayStart,
      end: dayEnd,
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: dayStart.toISOString(), end: dayEnd.toISOString(), is_all_day: true, participants: [],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    expect(await screen.findByLabelText('Start date')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /all day/i })); // off

    const startTime = await screen.findByLabelText('Start time');
    const endTime = screen.getByLabelText('End time');
    expect(startTime).not.toHaveValue('12:00 AM');
    expect(endTime).not.toHaveValue('12:00 AM');
    // Not asserting the exact default hour by name - just that it is a real, non-zero window.

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.is_all_day).toBe(false);
    expect(body).toHaveProperty('start');
    expect(body).toHaveProperty('end');
    const start = new Date(body.start as string);
    const end = new Date(body.end as string);
    // A real, non-degenerate window - not the literal 00:00->00:00 the entry's stored all-day
    // span would read as if piped straight into the timed fields unmodified.
    expect(end.getTime() - start.getTime()).toBeGreaterThan(0);
    expect(end.getTime() - start.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('a read-only viewer (no update/delete grant) gets no Save and no Delete', async () => {
    const event = makeEntryEvent();

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: READ_ONLY },
    );

    expect(await screen.findByText('Dave is off Thursday')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    // Two "Close" buttons in a read-only dialog: the kit Dialog's own X, and this
    // component's footer button (which reads "Cancel" only when writes are allowed).
    expect(screen.getAllByRole('button', { name: /^close$/i })).toHaveLength(2);
    expect(screen.getByLabelText(/^title/i)).toBeDisabled();
  });
});

/**
 * Notifications (slice 07, spec §5). Address is always Customer.email (never editable here),
 * so this is a purpose-built block rather than a reuse of the job/walkthrough doors'
 * NotifyComposeFields (one overridable recipient) - see the implementer's own report for why.
 */
describe('EventEntryDialog — notifications', () => {
  it('create: with a customer participant, the notify box is pre-ticked and POSTs notify_customer + a seeded message', async () => {
    mockGets({
      '/api/users': { users: [] },
      '/api/customers': { customers: [
        { id: 'c-bob', first_name: 'Bob', last_name: 'Vance', company_name: null, customer_number: 'C0001', email: 'bob@example.com' },
      ] },
    });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Client kickoff' } });
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'bob' } });
    fireEvent.click(await screen.findByText(/Bob Vance/));
    expect(await screen.findByLabelText('Remove Bob Vance')).toBeInTheDocument();

    // Defaults ON (create has no "before" - notify.ts's classifyOutcome always resolves
    // 'scheduled' for a brand-new participant), and the message field is seeded from the title.
    expect(await screen.findByLabelText('Notify participants')).toBeChecked();
    expect(screen.getByLabelText('Message')).toHaveValue('Client kickoff');

    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [, body] = mockApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notify_customer).toBe(true);
    expect(body.notify_message).toBe('Client kickoff');
  });

  // ─── Product-owner change, 2026-08-25 ────────────────────────────────────
  // "I actually wanted all participants to be notified." The whole notify block used to be
  // hidden unless a CUSTOMER was on the entry, so a team-only Event offered no way to tell
  // anyone by email at all.

  it('create: a TEAM-ONLY entry gets the notify block too, and POSTs notify_customer', async () => {
    mockGets({
      '/api/users': { users: [{ id: 'u-alice', first_name: 'Alice', last_name: 'Ng', email: 'alice@acme.test' }] },
      '/api/customers': { customers: [] },
    });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Depot handover' } });

    // No participants yet — the block must not be offered when there is nobody to reach. That
    // is the ORIGINAL PO-reported defect ("participants notified" on an entry with none), and
    // widening the gate to both kinds must not reopen it.
    expect(screen.queryByLabelText('Notify participants')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /add team member/i }));
    fireEvent.click(await screen.findByText('Alice Ng'));

    expect(await screen.findByLabelText('Notify participants')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [, body] = mockApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notify_customer).toBe(true);
    expect(body.notify_message).toBe('Depot handover');
  });

  it('the notify block carries no explanatory copy, and Title carries no example hint', async () => {
    mockGets({
      '/api/users': { users: [{ id: 'u-alice', first_name: 'Alice', last_name: 'Ng', email: 'alice@acme.test' }] },
      '/api/customers': { customers: [] },
    });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    // PO, 2026-08-25: "No hints" — the Title field used to suggest "Dave is off Thursday".
    expect(screen.getByLabelText(/^title/i)).not.toHaveAttribute('placeholder');

    fireEvent.click(screen.getByRole('combobox', { name: /add team member/i }));
    fireEvent.click(await screen.findByText('Alice Ng'));
    expect(await screen.findByLabelText('Notify participants')).toBeInTheDocument();

    // The three removed sentences, by their most distinctive fragment. Asserted as absent rather
    // than by counting nodes so a future re-wording of the same explanation still trips this.
    expect(screen.queryByText(/emails everyone below/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be emailed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sent as-is/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fixed wording/i)).not.toBeInTheDocument();
  });

  it('create: unticking the box drops notify_customer/notify_message from the POST entirely', async () => {
    mockGets({
      '/api/users': { users: [] },
      '/api/customers': { customers: [
        { id: 'c-bob', first_name: 'Bob', last_name: 'Vance', company_name: null, customer_number: 'C0001', email: 'bob@example.com' },
      ] },
    });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Client kickoff' } });
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'bob' } });
    fireEvent.click(await screen.findByText(/Bob Vance/));

    fireEvent.click(await screen.findByLabelText('Notify participants'));
    fireEvent.click(screen.getByRole('button', { name: /create event/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [, body] = mockApi.post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('notify_customer');
    expect(body).not.toHaveProperty('notify_message');
  });

  it('create: a customer with no email on file never blocks the save, and the block stays one control', async () => {
    mockGets({
      '/api/users': { users: [] },
      '/api/customers': { customers: [
        { id: 'c-noemail', first_name: 'No', last_name: 'Email', company_name: null, customer_number: 'C0002', email: null },
      ] },
    });
    mockApi.post.mockResolvedValue({ data: { calendar_entry: { id: 'new-entry' } } });

    renderWithProviders(
      <EventEntryDialog mode="create" open event={null} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Client kickoff' } });
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'No Email' } });
    // The customer picker's own "Create ..." fallback also contains the string "No Email" (as
    // the quoted search term), so anchor on the search-result row's own "#C0002 " prefix.
    fireEvent.click(await screen.findByText(/#C0002 No Email/));

    // Product-owner change, 2026-08-25: the "Will be emailed:" recipient manifest that used to
    // spell out "No Email — no email on file" is GONE ("this is redundant… you can remove the
    // will be emailed section" — it restated the participant chips a few pixels above it). What
    // must still hold is that the missing address costs the participant the email and NOTHING
    // else: the entry saves, and the block is still exactly one control.
    expect(await screen.findByLabelText('Notify participants')).toBeInTheDocument();
    expect(screen.queryByText(/no email on file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be emailed/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /notify/i })).toHaveLength(1);
  });

  it('edit: pre-ticked when the draft time changed AND the customer participant was previously notified', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.patch.mockResolvedValue({ data: { calendar_entry: {} } });
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: '2026-08-01T00:00:00.000Z',
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    // Time unchanged yet: the box must NOT be pre-ticked (spec §5 - "time unchanged - the
    // checkbox appears but is unticked regardless").
    expect(await screen.findByLabelText('Notify participants')).not.toBeChecked();

    fireEvent.change(await screen.findByLabelText('Start time'), { target: { value: '3:00 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));

    // Now that the time actually changed, and Bob was previously notified, it pre-ticks.
    expect(await screen.findByLabelText('Notify participants')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [, body] = mockApi.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notify_customer).toBe(true);
  });

  // Post-review fix (the real defect the reviewer found, not the reported one): a customer who
  // has NEVER been notified pre-ticks unconditionally — they would get SCHEDULED, the
  // first-notice email, which notify.ts sends regardless of whether the time also changed. The
  // OLD `timeDirty && ...` rule had no branch for this and defaulted the box OFF, silently
  // under-notifying spec §1's own primary use case (a single pre-lead customer). This is the
  // regression test for that defect, not a restatement of it.
  it('edit: a customer participant who was never notified before pre-ticks even with NO time change (the primary use case)', async () => {
    mockGets({ '/api/users': { users: [] } });
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: null,
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    // No time edit at all in this test — attaching-and-never-changing-anything-else is exactly
    // the scenario the reviewer flagged: Bob is attached, shows on his customer page, and under
    // the old rule was silently never told.
    expect(await screen.findByLabelText('Notify participants')).toBeChecked();
  });

  it('edit: a customer participant who was never notified before ALSO pre-ticks on a time change (same outcome, SCHEDULED either way)', async () => {
    mockGets({ '/api/users': { users: [] } });
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: null,
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(await screen.findByLabelText('Start time'), { target: { value: '3:00 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));

    expect(await screen.findByLabelText('Notify participants')).toBeChecked();
  });

  it('edit: a PREVIOUSLY-notified customer participant does NOT pre-tick on a description-only save', async () => {
    mockGets({ '/api/users': { users: [] } });
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: '2026-08-01T00:00:00.000Z',
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.change(await screen.findByLabelText(/^description/i), { target: { value: 'Team notice — updated' } });

    expect(await screen.findByLabelText('Notify participants')).not.toBeChecked();
  });

  it('delete: pre-ticked by default and DELETEs the bare URL (byte-identical to before this slice)', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.delete.mockResolvedValue({ data: {} });
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: null,
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={vi.fn()} />,
      { ability: ADMIN },
    );

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(await screen.findByLabelText('Notify participants')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/calendar-entries/entry-1'));
  });

  it('delete: unticking sends ?notify=false, and the delete still proceeds', async () => {
    mockGets({ '/api/users': { users: [] } });
    mockApi.delete.mockResolvedValue({ data: {} });
    const onDeleted = vi.fn();
    const event = makeEntryEvent({
      raw: {
        id: 'entry-1', title: 'Dave is off Thursday', description: 'Team notice',
        start: asWallClock(new Date(2026, 7, 24, 14, 0)).toISOString(),
        end: asWallClock(new Date(2026, 7, 24, 15, 0)).toISOString(),
        is_all_day: false,
        participants: [{
          kind: 'CUSTOMER', user_id: null, customer_id: 'c-bob', name: 'Bob Vance',
          email: 'bob@example.com', notified_at: null,
        }],
      },
    });

    renderWithProviders(
      <EventEntryDialog mode="edit" open event={event} tz={TZ} onClose={onDeleted} />,
      { ability: ADMIN },
    );

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByLabelText('Notify participants'));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/calendar-entries/entry-1?notify=false'));
    // The prompt governs the email, not the delete (spec §5) - it still proceeds.
    expect(onDeleted).toHaveBeenCalled();
  });
});
