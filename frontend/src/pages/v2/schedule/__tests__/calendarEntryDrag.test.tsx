/**
 * SchedulePage — dragging a calendar entry (slice 08, calendar-entries spec §3/§4/§5).
 *
 * THE MANDATORY GAP THIS CLOSES (carried forward from slice 03's QA): `isDragInert` was
 * unit-tested in isolation, and `draggableAccessor`/`resizableAccessor` in SchedulePage.tsx both
 * called it first — but that WIRING was verified only by reading. Slice 08 deletes that call
 * site and wires `ce-` into `parseBoardDragId` at the same time (dragChannels.ts), on the theory
 * that both halves flip together. If a future change removed the calendar-entry branch from
 * `handleMemberBoardDrop`/`handleEventDrop`/`handleEventResize` (or the ability gate that guards
 * it) while leaving `parseBoardDragId`'s `ce-` case in place, the failure mode is silent: a
 * dragged entry would fall into the job-shaped mutation logic those handlers already contain and
 * issue `PATCH /api/jobs/<entry-uuid>/assign` — nothing throws, nothing type-errors, the network
 * tab is the only witness.
 *
 * This file drives that failure mode for REAL, not through a source-scan: it renders the actual
 * `SchedulePage` component (react-query, CASL ability, the works — same harness as
 * `notifyOutcome.test.tsx`), fires a genuine HTML5 `drop` event carrying a `ce-`-prefixed board
 * id through the member grid's `GRID_EVENT_ID` channel, and asserts on the mocked axios client
 * that a real drop through `handleMemberBoardDrop` → `parseBoardDragId` produces exactly one
 * `PATCH /api/calendar-entries/:id` and NO request to `/api/jobs/*` or `/api/leads/*`.
 *
 * WHAT THIS PROVES: the full round-trip through `parseBoardDragId` and `handleMemberBoardDrop`
 * for the member/technician grid's own native drag-and-drop is safe, end to end, with no mocking
 * of either function.
 *
 * WHAT THIS DOES NOT PROVE: it does not exercise react-big-calendar's OWN internal drag
 * machinery for the standard (non-grouped) calendar view — `onEventDrop`/`onEventResize` fire
 * from RBC's own pointer-event sequence, which is impractical to synthesize reliably in a DOM
 * test (the plan doc's own "if a full react-big-calendar harness is too expensive" clause). That
 * half — `draggableAccessor`/`resizableAccessor`'s `ability.can('update', 'CalendarEntry')` gate,
 * and `handleEventDrop`/`handleEventResize`'s calendar-entry branch — is covered instead by the
 * source-scanning guard in `SchedulePage.dragWiringGuard.test.ts`, which is honest about reading
 * source text rather than exercising behavior. Between the two: the grid-view path is proven by
 * running code, the standard-view path is proven by asserting the guard clauses are present in
 * the source and in the right order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';

import SchedulePage from '../SchedulePage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: vi.fn(),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Everything, including the CalendarEntry grant this slice gates drag on (spec §4).
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
// Reads everything (so the board renders normally) but explicitly withholds `update` on
// `CalendarEntry` — the exact SALES shape the acceptance criteria name: "a SALES user (no
// CalendarEntry grant) cannot drag an entry".
const NO_CALENDAR_ENTRY_GRANT = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'create', subject: 'Job' },
]);

const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14, minute = 0): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0)).toISOString();
}

const ENTRY_ID = 'ce-fixture-1';
const ENTRY_TITLE = 'Dave is off Thursday';

/** A 2-hour timed entry with one USER participant on Alice's lane — duration preservation
 *  (spec: "a 14:00-16:00 entry dropped on 09:00 becomes 09:00-11:00, not 09:00 + a default")
 *  is checked against this exact 2-hour span below. */
const ENTRY = {
  id: ENTRY_ID,
  title: ENTRY_TITLE,
  description: '',
  start: dayAt(1, 14, 0),
  end: dayAt(1, 16, 0),
  is_all_day: false,
  participants: [
    { kind: 'USER', user_id: 'm-alice', first_name: 'Alice', last_name: 'Ng', notified_at: null },
  ],
};

/** A CUSTOMER-only entry - the shape the notify-moved fix cares about: `notifyMoved`
 *  (calendar-entry.controller.ts) only ever emails CUSTOMER participants, so this is the ONE
 *  kind of participant that can make the "Notify" toast action honest. */
const CUSTOMER_ONLY_ENTRY = {
  id: 'customer-only-1',
  title: 'Customer check-in',
  description: '',
  start: dayAt(1, 14, 0),
  end: dayAt(1, 16, 0),
  is_all_day: false,
  participants: [
    { kind: 'CUSTOMER', customer_id: 'cust-1', first_name: 'Jane', last_name: 'Doe', notified_at: null },
  ],
};

function mockBoard(entries: Array<Record<string, unknown>> = [ENTRY]) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    // The board's roster moved to the scoped endpoint; serve it the same fixture.
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({
        data: { users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] },
      });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: entries } });
    return Promise.resolve({ data: {} });
  });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

async function mountBoard(
  ability = ADMIN,
  entries: Array<Record<string, unknown>> = [ENTRY],
  waitForText: string | RegExp = ENTRY_TITLE,
) {
  mockBoard(entries);
  renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability },
  );
  await screen.findAllByText(waitForText);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
}

/** Fires a genuine HTML5 `drop` carrying the SAME channels MemberWeekBoard's own BoardCard
 *  writes on dragStart (dragChannels.ts's GRID_EVENT_ID/GRID_EVENT_TYPE/FROM_MEMBER) — this is
 *  not a call into a mocked handler, it is the real drop-target listener SchedulePage wires up. */
async function dropOnDay(boardId: string, toOffset: number) {
  const cell = await screen.findByTestId(cellFor(toOffset));
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? 'calendar-entry' : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

describe('dragging a calendar entry on the board (slice 08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('issues exactly one PATCH /api/calendar-entries/:id and ZERO requests to /api/jobs/* or /api/leads/*', async () => {
    await mountBoard();
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/calendar-entries/${ENTRY_ID}`,
      expect.objectContaining({ start: expect.any(String), end: expect.any(String) }),
    );

    // The failure mode this whole slice exists to prevent: a misroute to the job-assign door.
    const everyCall = [...mockApi.patch.mock.calls, ...mockApi.post.mock.calls].map((c) => String(c[0]));
    expect(everyCall.some((url) => url.includes('/api/jobs/'))).toBe(false);
    expect(everyCall.some((url) => url.includes('/api/leads/'))).toBe(false);
  });

  it('preserves duration across the drag - the 2-hour span survives the move unchanged', async () => {
    await mountBoard();
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    const [, body] = mockApi.patch.mock.calls[0] as [string, { start: string; end: string }];
    const durationMs = new Date(body.end).getTime() - new Date(body.start).getTime();
    expect(durationMs).toBe(2 * 60 * 60_000);
  });

  it('opens no dialog (no RescheduleConfirmDialog, no UnifiedDropModal) and shows a non-blocking notify toast', async () => {
    await mountBoard();
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    // Non-blocking is the point: nothing with role="dialog" ever mounts for this gesture.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(String(mockToast.mock.calls.at(-1)?.[0])).toMatch(/moved/i);
  });

  it('the move persists before the toast is answered - dismissing/ignoring it never rolls the PATCH back or calls notify-moved', async () => {
    await mountBoard();
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    // Never clicked the toast's action - "declining, or ignoring it" (spec).
    expect(mockApi.patch).toHaveBeenCalledTimes(1); // still just the one save, no compensating call
    expect(mockApi.post.mock.calls.some(([url]) => String(url).includes('notify-moved'))).toBe(false);
  });

  it('choosing "Notify" on the toast hits the moved path: POST /api/calendar-entries/:id/notify-moved', async () => {
    // Needs a CUSTOMER participant - notify-moved only ever emails CUSTOMER participants
    // (calendar-entry.controller.ts), so that is the only entry shape the toast offers "Notify"
    // on at all (see the CUSTOMER-gating describe block further down this file).
    await mountBoard(ADMIN, [CUSTOMER_ONLY_ENTRY], CUSTOMER_ONLY_ENTRY.title);
    await dropOnDay(`ce-${CUSTOMER_ONLY_ENTRY.id}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const toastCall = mockToast.mock.calls.find(
      (c) => (c[1] as { action?: { onClick?: () => void } } | undefined)?.action,
    );
    const onClick = (toastCall?.[1] as { action?: { onClick?: () => void } } | undefined)?.action?.onClick;
    expect(typeof onClick).toBe('function');

    onClick?.();

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(`/api/calendar-entries/${CUSTOMER_ONLY_ENTRY.id}/notify-moved`),
    );
  });

  it('a SALES-shaped ability (no CalendarEntry update grant) cannot drag an entry - the drop no-ops', async () => {
    await mountBoard(NO_CALENDAR_ENTRY_GRANT);
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    // Give any errant mutation a tick to fire, then assert nothing did - handleMemberBoardDrop's
    // own `if (!ability.can('update', 'CalendarEntry')) return;` is what should stop this.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post.mock.calls.some(([url]) => String(url).includes('notify-moved'))).toBe(false);
  });

  // Plan Mode exclusion (spec §3) — carried forward from slice 03's QA as something to ASSERT,
  // not merely rely on being structurally true. setup.ts's default mocked auth user is ADMIN, so
  // Plan Mode's toggle renders without any extra auth wiring here.
  it('with Plan Mode active, dragging an entry creates no ghost and issues no live PATCH', async () => {
    await mountBoard();
    fireEvent.click(screen.getByRole('button', { name: /Plan Mode/i }));
    await screen.findByText(/0 drafts/);

    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    // Give any errant ghost-creation / mutation a tick to fire, then assert neither happened.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.getByText(/0 drafts/)).toBeInTheDocument();
  });
});

/**
 * PO-reported defect (2026-08-25): an Event with NO participants at all was still offered
 * "Notify" on the "Event moved" toast, and clicking it claimed "Participants notified" - nobody
 * was, because there was nobody to notify.
 *
 * The gate is `hasParticipants` (eventAdapters.ts) - ANY participant, either kind. It was
 * briefly customer-only, on the reasoning that a teammate had already been told; that held for
 * the in-app notice the drag's own PATCH emits and not for email, which that PATCH never sends.
 * Since the product-owner change of 2026-08-25 notifyMoved emails both kinds and passes
 * `suppressInAppNotice`, so a user-only entry has a real recipient AND the teammate's board
 * notice still fires exactly once.
 */
describe('the "Notify" toast action is offered only when the entry has someone to notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
    // The last test in the describe block above ("with Plan Mode active...") leaves Plan Mode ON
    // in localStorage (usePlanMode.ts persists `isActive` under a tab-stable key and this file
    // never runs in a fresh jsdom window between tests) — a fresh SchedulePage mount here would
    // silently rehydrate Plan Mode active and no-op every drop in handleMemberBoardDrop's
    // `if (planMode.isActive) { ...; if (!ev) return; }` branch before it ever reaches the
    // calendar-entry case below it. Cleared so every mount in this block starts Plan-Mode-off.
    localStorage.clear();
  });

  const NO_PARTICIPANTS_ENTRY = {
    id: 'no-participants-1',
    title: 'QA — all day',
    description: '',
    start: dayAt(1, 14, 0),
    end: dayAt(1, 16, 0),
    is_all_day: true,
    participants: [],
  };

  /** Pulls the toast call's options object (2nd arg), for whichever call carries a description
   *  matching "moved" - the same call the existing "opens no dialog" test above keys off. */
  function findMovedToastOptions() {
    const call = mockToast.mock.calls.find((c) => /moved/i.test(String(c[0])));
    return call?.[1] as { action?: { label?: string; onClick?: () => void }; description?: string } | undefined;
  }

  it('an entry with ZERO participants: "Event moved" renders with no action button', async () => {
    await mountBoard(ADMIN, [NO_PARTICIPANTS_ENTRY], NO_PARTICIPANTS_ENTRY.title);
    await dropOnDay(`ce-${NO_PARTICIPANTS_ENTRY.id}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const opts = findMovedToastOptions();
    expect(opts?.action).toBeUndefined();
  });

  it('an entry with only a USER participant: the toast DOES offer the Notify action - that teammate is emailed too now', async () => {
    await mountBoard(ADMIN, [ENTRY]); // ENTRY (module fixture) carries one USER participant, no customer
    await dropOnDay(`ce-${ENTRY_ID}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    // The teammate's in-app "moved" notice fired on the PATCH above and notifyMoved suppresses
    // a second one - but the EMAIL is this action's whole job, and nothing has sent it yet.
    const opts = findMovedToastOptions();
    expect(typeof opts?.action?.onClick).toBe('function');
  });

  it('an entry with only a CUSTOMER participant: the toast STILL offers the Notify action', async () => {
    await mountBoard(ADMIN, [CUSTOMER_ONLY_ENTRY], CUSTOMER_ONLY_ENTRY.title);
    await dropOnDay(`ce-${CUSTOMER_ONLY_ENTRY.id}`, 3);

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const opts = findMovedToastOptions();
    expect(typeof opts?.action?.onClick).toBe('function');
  });
});

/**
 * The confirm-message honesty half of the same fix: `notify.customers` (CustomerNotifyRecord[])
 * is the ONE place the notify-moved route says how many emails actually went out, so the
 * follow-up toast is worded off that, not asserted as a flat "Participants notified".
 */
describe('the notify-moved follow-up toast is worded off the real per-customer outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    localStorage.clear(); // see the note in the describe block above
  });

  /** Two customer participants - only this describe block needs a second one, to exercise the
   *  "some sent, some didn't" wording. */
  const TWO_CUSTOMERS_ENTRY = {
    id: 'two-customers-1',
    title: 'Two-customer walkthrough',
    description: '',
    start: dayAt(1, 14, 0),
    end: dayAt(1, 16, 0),
    is_all_day: false,
    participants: [
      { kind: 'CUSTOMER', customer_id: 'cust-1', first_name: 'Jane', last_name: 'Doe', notified_at: null },
      { kind: 'CUSTOMER', customer_id: 'cust-2', first_name: 'John', last_name: 'Roe', notified_at: null },
    ],
  };

  /** Drags CUSTOMER_ONLY_ENTRY (or the supplied entry), waits for the toast, clicks its Notify
   *  action, and returns the sonner call it produced - the one place every test below reads its
   *  final message from. */
  async function moveAndClickNotify(entry: Record<string, unknown> = CUSTOMER_ONLY_ENTRY) {
    await mountBoard(ADMIN, [entry], entry.title as string);
    await dropOnDay(`ce-${entry.id as string}`, 3);
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const toastCall = mockToast.mock.calls.find(
      (c) => (c[1] as { action?: { onClick?: () => void } } | undefined)?.action,
    );
    (toastCall?.[1] as { action?: { onClick?: () => void } } | undefined)?.action?.onClick?.();

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(`/api/calendar-entries/${entry.id as string}/notify-moved`),
    );
  }

  it('all sent: reports the exact count', async () => {
    mockApi.post.mockResolvedValue({
      data: { notify: { customers: [{ participant_id: 'p1', customer_id: 'cust-1', outcome: 'moved', status: 'sent' }] } },
    });
    await moveAndClickNotify();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('1 participant notified'));
  });

  it('some sent, some not: reports the split rather than claiming full success', async () => {
    mockApi.post.mockResolvedValue({
      data: {
        notify: {
          customers: [
            { participant_id: 'p1', customer_id: 'cust-1', outcome: 'moved', status: 'sent' },
            { participant_id: 'p2', customer_id: 'cust-2', outcome: 'moved', status: 'failed' },
          ],
        },
      },
    });
    await moveAndClickNotify(TWO_CUSTOMERS_ENTRY);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('1 of 2 participants notified — the rest could not be reached.'),
    );
  });

  it('no email on file: says so, not a flat failure', async () => {
    mockApi.post.mockResolvedValue({
      data: { notify: { customers: [{ participant_id: 'p1', customer_id: 'cust-1', outcome: 'moved', status: 'no_recipient' }] } },
    });
    await moveAndClickNotify();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('No email on file — nothing was sent.'));
  });

  it('provider failure: invites a retry', async () => {
    mockApi.post.mockResolvedValue({
      data: { notify: { customers: [{ participant_id: 'p1', customer_id: 'cust-1', outcome: 'moved', status: 'failed' }] } },
    });
    await moveAndClickNotify();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('The notification could not be sent. Please try again.'),
    );
  });

  it('blocked by policy (skipped): reads as blocked, not as a transient failure', async () => {
    mockApi.post.mockResolvedValue({
      data: { notify: { customers: [{ participant_id: 'p1', customer_id: 'cust-1', outcome: 'moved', status: 'skipped' }] } },
    });
    await moveAndClickNotify();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('The notification was blocked and not sent.'));
  });

  it('idempotency guard drops every eligible customer: reads as already-done, not as a failure', async () => {
    // notify-moved's own idempotency guard (calendar-entry.controller.ts) skips a customer whose
    // notified_at is already >= the entry's updated_at - a double-click or a retry after a
    // genuine send legitimately returns an EMPTY customers array even though the entry HAS a
    // customer participant (the toast action was correctly offered).
    mockApi.post.mockResolvedValue({ data: { notify: { customers: [] } } });
    await moveAndClickNotify();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Already notified — nothing new to send.'),
    );
  });
});
