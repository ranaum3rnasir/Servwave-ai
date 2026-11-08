/**
 * Manual Communication Log — the drawer records something that ALREADY HAPPENED, so it refuses
 * an occurred-at in the future and says so inline.
 *
 * WHY A CLIENT GUARD AT ALL, when the API refuses the same value. Same reason the duration guard
 * next to it exists: without one the user meets a raw 400 for a field they can see, phrased as a
 * server response. The rule is the server's; this is the explanation.
 *
 * WHY IT IS SO EASY TO HIT. DateTimePicker defaults an unset time to 09:00 when a DATE is chosen,
 * so a date alone is enough to produce a future timestamp — which is exactly what these tests
 * drive, and exactly how the QA report happened (a call stamped 09:00 and saved at 08:47). That
 * default is shared with tasks, service plans, inventory and payments and is deliberately not
 * changed.
 *
 * THE ORG'S CLOCK, AND ONLY ONCE IT IS KNOWN. The picker emits a ZONELESS wall clock, so "is this
 * in the future?" cannot be answered without the organisation's zone — and answering it with the
 * Eastern GUESS `useScheduleTimezone()` returns while the org query is in flight would block a
 * user in another zone from saving a conversation that plainly already happened. The last test
 * pins that the guard stands down instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatInTimeZone } from 'date-fns-tz';
import { renderWithProviders } from './helpers';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import api from '@/lib/axios';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: { entry: { id: 'entry-1' } } })),
    put: vi.fn(),
    get: vi.fn(() => Promise.resolve({ data: { users: [] } })),
    delete: vi.fn(),
  },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

const ORG_TZ = 'America/New_York';
const DAY = 86_400_000;

/** A calendar day relative to today ON THE ORG'S CLOCK, as the DatePicker's typed MM/DD/YYYY. */
function orgDay(offsetDays: number): string {
  return formatInTimeZone(new Date(Date.now() + offsetDays * DAY), ORG_TZ, 'M/d/yyyy');
}

const FUTURE_MESSAGE = /choose a time that has passed/i;

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false });
  vi.mocked(api.post).mockResolvedValue({ data: { entry: { id: 'entry-1' } } });
  vi.mocked(api.get).mockResolvedValue({ data: { users: [] } });
});

/** Open the drawer on a lead and fill in everything except the date. */
async function openAndFill(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(
    <LogCommunicationDrawer anchor={{ kind: 'lead', id: 'lead-1' }} onClose={vi.fn()} />,
  );
  await user.click(await screen.findByRole('radio', { name: /outbound/i }));
  await user.type(screen.getByPlaceholderText(/what was discussed/i), 'He rang about the quote.');
}

/** Type a day into the picker. The time is left unset, so DateTimePicker supplies 09:00. */
async function pickDay(user: ReturnType<typeof userEvent.setup>, day: string) {
  const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
  await user.clear(dateInput);
  await user.type(dateInput, day);
  await user.tab();
}

describe('LogCommunicationDrawer — an entry cannot be dated in the future', () => {
  it('blocks the save and explains why when the conversation has not happened yet', async () => {
    const user = userEvent.setup();
    await openAndFill(user);

    // Nothing is claimed yet: with no date the form is simply incomplete, and an assertion made
    // here would pass for the wrong reason.
    expect(screen.queryByText(FUTURE_MESSAGE)).not.toBeInTheDocument();

    await pickDay(user, orgDay(1));

    expect(screen.getByText(FUTURE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log communication/i })).toBeDisabled();

    // And the guard is not merely cosmetic: nothing reaches the API.
    await user.click(screen.getByRole('button', { name: /log communication/i }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('saves a conversation that already happened', async () => {
    const user = userEvent.setup();
    await openAndFill(user);
    await pickDay(user, orgDay(-1));

    expect(screen.queryByText(FUTURE_MESSAGE)).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: /log communication/i });
    expect(save).toBeEnabled();

    await user.click(save);

    expect(api.post).toHaveBeenCalledWith(
      '/api/communication/manual-log',
      expect.objectContaining({
        lead_id: 'lead-1',
        // The ZONELESS wall clock, never an instant — the server composes it against the org's
        // zone. 09:00 is DateTimePicker's default for a date picked with no time.
        occurred_at: `${formatInTimeZone(new Date(Date.now() - DAY), ORG_TZ, 'yyyy-MM-dd')}T09:00`,
      }),
    );
  });

  it('clears the refusal as soon as the date is corrected', async () => {
    const user = userEvent.setup();
    await openAndFill(user);

    await pickDay(user, orgDay(1));
    expect(screen.getByText(FUTURE_MESSAGE)).toBeInTheDocument();

    await pickDay(user, orgDay(-1));
    expect(screen.queryByText(FUTURE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log communication/i })).toBeEnabled();
  });

  // THE GUARD STANDS DOWN ON AN UNKNOWN ZONE. Answering "is this in the future?" with a guessed
  // zone would refuse a legitimate entry for anyone whose organisation is not on the guessed
  // clock — a client convenience must never be able to do that. The server still refuses.
  it('does not block while the organisation zone is still unknown', async () => {
    mockOrg.mockReturnValue({ data: undefined, isLoading: true });
    const user = userEvent.setup();
    await openAndFill(user);
    await pickDay(user, orgDay(1));

    expect(screen.queryByText(FUTURE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log communication/i })).toBeEnabled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AND THE REFUSAL MUST NOT OUTLIVE ITS OWN REASON.
//
// Time passing changes the answer just as much as re-picking does, and this is the bug report's
// own scenario continued: the entry stamped 09:00 that was saved at 08:47. If the drawer captured
// "now" once, 09:00 would still be refused at 10:00 — the person who typed it would be locked out
// of correcting their own record until they re-picked the date, by a client guard STRICTER than
// the server it exists to explain.
//
// DRIVEN IN EDIT MODE, ON NO USER INPUT AT ALL. That is the honest version of the claim ("a
// drawer left ALONE stops refusing"), and it is also what makes the test possible: the entry
// carries the date, so nothing has to be typed while the clock is held still. The fixture is the
// stuck staging row this PR exists to make correctable.
// ──────────────────────────────────────────────────────────────────────────────

/** 08:00 America/New_York (EDT, UTC-4) — before the 09:00 the entry claims, as in the report. */
const EIGHT_AM_NY = new Date('2026-08-31T12:00:00.000Z');
const TEN_AM_NY = new Date('2026-08-31T14:00:00.000Z');

/** The stuck row, as GET /api/communication/manual-log/:id returns it: 09:00 on the org's clock. */
const FUTURE_ENTRY = {
  id: 'entry-1',
  channel: 'call',
  direction: 'out',
  occurredAt: '2026-08-31T13:00:00.000Z',
  occurredAtLocal: '2026-08-31T09:00',
  notes: 'Ran QA 9 - sales lead',
  durationMinutes: null,
  outcome: null,
  subject: null,
  leadId: 'lead-1',
  jobId: null,
  performedBy: 'user-1',
  loggedBy: 'user-1',
  manuallyLogged: true,
};

describe('LogCommunicationDrawer — the refusal clears as time passes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EIGHT_AM_NY);
    vi.mocked(api.get).mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/performers') ? { data: { users: [] } } : { data: { entry: FUTURE_ENTRY } },
      ),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops refusing a time that has since passed, with nobody touching the drawer', async () => {
    renderWithProviders(
      <LogCommunicationDrawer
        anchor={{ kind: 'lead', id: 'lead-1' }}
        entryId="entry-1"
        onClose={vi.fn()}
      />,
    );
    // Let the entry fetch settle; the drawer holds a spinner until it lands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 08:00 NY: the entry claims 09:00, an hour out, and the correction is correctly blocked.
    expect(screen.getByDisplayValue('08/31/2026')).toBeInTheDocument();
    expect(screen.getByText(FUTURE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();

    // Two hours pass. Nothing is typed, nothing is re-picked, nothing is clicked.
    await act(async () => {
      vi.setSystemTime(TEN_AM_NY);
      await vi.advanceTimersByTimeAsync(20_000);
    });

    // 10:00 NY: 09:00 is an hour in the past and the entry must be saveable.
    expect(screen.queryByText(FUTURE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });
});
