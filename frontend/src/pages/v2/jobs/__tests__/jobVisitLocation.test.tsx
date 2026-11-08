/**
 * BOOKING A JOB VISIT SOMEWHERE OTHER THAN THE SERVICE ADDRESS — the job-side dialog.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 * Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
 *
 * `VisitScheduleDialog` already asks when and who; it now asks where, through the SAME control the
 * lead side uses (`_shared/visitLocationField`) rather than a job-shaped copy of it.
 *
 * THE ONE THING THAT IS EASY TO GET WRONG, and the reason this suite exists rather than a smoke
 * test: the control defaults to the service address and this form states its location on EVERY
 * save. So a Reschedule opened on a yard booking, to move the time by an hour, would post "service
 * address" and send the crew to the customer's house after the customer had been told otherwise.
 * The API's omitted-means-unchanged rule cannot save a form that always states one - only the SEED
 * can, and the seed is what `visit_location` on the row exists for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { JobVisitRow } from '@/lib/visits';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const YARD = { id: 'loc-yard', name: 'North Yard' };
const locationState = vi.hoisted(() => ({ list: [] as { id: string; name: string }[] }));

vi.mock('@/lib/api/locations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/locations')>()),
  useLocations: () => ({ data: locationState.list }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const post = api.post as ReturnType<typeof vi.fn>;
const patch = api.patch as ReturnType<typeof vi.fn>;

/** A booked trip, at the YARD - the row a plain reschedule must not move. */
const VISIT_AT_YARD = {
  id: 'v-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-09-05T13:00:00.000Z',
  scheduled_end: '2026-09-05T15:30:00.000Z',
  is_all_day: false,
  created_at: '2026-08-20T10:00:00.000Z',
  assignees: [],
  visit_location: {
    location_id: YARD.id,
    address_line1: null, address_line2: null, city: null, state: null, zip: null,
  },
} as unknown as JobVisitRow;

/** The same trip at the job's service address - both column families empty. */
const VISIT_AT_SERVICE_ADDRESS = { ...VISIT_AT_YARD, visit_location: null } as JobVisitRow;

function renderDialog(visit?: JobVisitRow) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisitScheduleDialog
        open
        onOpenChange={() => {}}
        jobId="job-1"
        canAssignCrew={false}
        visit={visit}
      />
    </QueryClientProvider>,
  );
}

/** Fills the four window fields so the Book button is enabled. */
async function fillWindow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Start date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('Start time'), '9:00 AM');
  await user.tab();
  await user.type(screen.getByLabelText('End date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('End time'), '11:00 AM');
  await user.tab();
}

/** The body this dialog actually sent, whichever verb it used. */
function sentBody(): Record<string, unknown> {
  const call = post.mock.calls[0] ?? patch.mock.calls[0];
  if (!call) throw new Error('the dialog sent nothing at all');
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
  locationState.list = [YARD];
});

describe('the job visit dialog asks where', () => {
  it('offers the control at all, defaulting to the service address', () => {
    renderDialog();

    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('books at one of the organisation’s locations, sending the id and no copy of its address', async () => {
    const user = userEvent.setup();
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: YARD.name }));
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    // A pointer, so correcting the yard's address in Settings flows into an unsent reminder (D2).
    expect(sentBody().location).toEqual({ location_id: YARD.id });
  });

  it('sends explicit null when the service address is chosen — a clear, not "unchanged"', async () => {
    const user = userEvent.setup();
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    // The control is on screen and the person just looked at it, so "Service address" is a choice
    // that clears a previous one rather than silence. Omitting is the API's "I am not talking
    // about the location" and belongs to callers that genuinely are not - the board's drag.
    expect(sentBody()).toHaveProperty('location');
    expect(sentBody().location).toBeNull();
  });

  it('sends a one-off address as its structured fields, never one blob in line 1', async () => {
    const user = userEvent.setup();
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: 'Other…' }));

    await user.type(screen.getByLabelText('Address'), '400 Supplier Rd');
    await user.type(screen.getByLabelText('City'), 'Charlotte');
    await user.type(screen.getByLabelText('State'), 'NC');
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(sentBody().location).toEqual({
      address_line1: '400 Supplier Rd',
      city: 'Charlotte',
      state: 'NC',
    });
  });

  it('will not let a half-typed one-off address be booked', async () => {
    const user = userEvent.setup();
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: 'Other…' }));
    await user.type(screen.getByLabelText('Address'), '400 Supplier Rd');

    // The same rule the API's schema applies (line 1, city and state together), restated here so
    // Book is disabled rather than answering 400 into a toast. A one-off missing its city renders
    // "400 Supplier Rd, , NC" in the customer's email.
    expect(screen.getByRole('button', { name: 'Book visit' })).toBeDisabled();
    await user.type(screen.getByLabelText('City'), 'Charlotte');
    await user.type(screen.getByLabelText('State'), 'NC');
    expect(screen.getByRole('button', { name: 'Book visit' })).toBeEnabled();
  });
});

describe('rescheduling a job visit that is NOT at the service address', () => {
  it('seeds the control from the stored location', () => {
    renderDialog(VISIT_AT_YARD);

    // Not "Service address". A control that defaulted there would move the trip on the next save,
    // and nothing on screen would say so.
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(YARD.name);
  });

  it('moving only the time leaves the trip at the yard', async () => {
    const user = userEvent.setup();
    renderDialog(VISIT_AT_YARD);

    await user.clear(screen.getByLabelText('Start time'));
    await user.type(screen.getByLabelText('Start time'), '10:00 AM');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    // The headline, from the client's side: this form states a location on every save, so what it
    // restates has to be the one the trip is already at.
    expect(sentBody().location).toEqual({ location_id: YARD.id });
  });

  it('a trip at the service address restates the service address, not a stale location', () => {
    renderDialog(VISIT_AT_SERVICE_ADDRESS);

    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('moves the trip when the picker is actually changed', async () => {
    const user = userEvent.setup();
    renderDialog(VISIT_AT_SERVICE_ADDRESS);

    await user.click(screen.getByRole('combobox', { name: /location/i }));
    await user.click(await screen.findByRole('option', { name: YARD.name }));
    await user.click(screen.getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(sentBody().location).toEqual({ location_id: YARD.id });
  });
});
