// Slice E6 — the shared CommRow renderer behind the Job/Customer/Lead
// Communication tabs. Contract under test:
//   • Standard line: direction word · who · "answered by X" (calls) · meta.
//   • Job chip navigates to /jobs/:id — EXCEPT the hosting job page's own rows
//     (plain pill, no self-link).
//   • NEW lead chip (LeadBadge) navigates to /leads/:id — EXCEPT the hosting
//     lead page's own rows.
//   • Unattributed rows keep the muted "no job" pill (badge it, don't hide it).
// Gate-off rendering (static/navigable chips) is the default here: no
// `ability` is passed to renderWithProviders, so the default empty CASL
// ability denies update:Communication regardless of useFeature('phone') —
// the interactive reassign menu never renders. The gated menu behavior lives
// in comm-row-job-control.test.tsx.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { CommRow } from '@/components/communication/shared/CommRow';
import type { CommItem } from '@/lib/api/jobCommunications';

const JOB_ID = 'b0000000-0000-0000-0000-000000000042';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000007';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const CALL_ITEM: CommItem = {
  id: 'ca000000-0000-0000-0000-000000000001',
  channel: 'call',
  direction: 'in',
  who: 'Doe HVAC',
  title: 'Inbound call · 4m 07s',
  preview: 'Confirmed Thursday 8am.',
  at: '2026-06-01T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
  leadId: LEAD_ID,
  leadLabel: 'L00007',
  answeredBy: 'Dana Reyes',
  meta: 'Booked',
};

const fmt = (at: string) => new Date(at).toISOString();

function renderRow(item: CommItem, props: Partial<Parameters<typeof CommRow>[0]> = {}) {
  return renderWithProviders(
    <ol>
      <CommRow
        item={item}
        formatTimestamp={fmt}
        tz="America/New_York"
        customerId={CUSTOMER_ID}
        {...props}
      />
    </ol>
  );
}

describe('CommRow — standard line', () => {
  it('renders direction word, who, answered-by and meta', () => {
    renderRow(CALL_ITEM);

    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getByText(/· Doe HVAC/)).toBeInTheDocument();
    expect(screen.getByText('· answered by Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('· Booked')).toBeInTheDocument();
    expect(screen.getByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Confirmed Thursday 8am.')).toBeInTheDocument();
  });

  it('omits the answered-by fragment when the item has none', () => {
    renderRow({ ...CALL_ITEM, answeredBy: undefined });

    expect(screen.queryByText(/answered by/)).not.toBeInTheDocument();
  });
});

describe('CommRow — chip navigation', () => {
  it('links the job pill to /jobs/:id and the lead chip to /leads/:id', () => {
    renderRow(CALL_ITEM);

    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
    expect(screen.getByText('L00007').closest('a')).toHaveAttribute('href', `/leads/${LEAD_ID}`);
  });

  it('suppresses the job self-link on the job page (plain pill, lead chip still navigates)', () => {
    renderRow(CALL_ITEM, { currentJobId: JOB_ID });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.getByText('J00042').closest('a')).toBeNull();
    expect(screen.getByText('L00007').closest('a')).toHaveAttribute('href', `/leads/${LEAD_ID}`);
  });

  it('suppresses the lead self-link on the lead page (plain chip, job pill still navigates)', () => {
    renderRow(CALL_ITEM, { currentLeadId: LEAD_ID });

    expect(screen.getByText('L00007')).toBeInTheDocument();
    expect(screen.getByText('L00007').closest('a')).toBeNull();
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
  });

  it('keeps the muted "no job" pill (unlinked) and no lead chip for an unattributed row', () => {
    renderRow({
      ...CALL_ITEM,
      jobId: undefined,
      jobLabel: undefined,
      leadId: undefined,
      leadLabel: undefined,
    });

    const noJob = screen.getByText('no job');
    expect(noJob).toBeInTheDocument();
    expect(noJob.closest('a')).toBeNull();
    expect(screen.queryByText('L00007')).not.toBeInTheDocument();
  });

  it('renders a legacy labelled-but-id-less job pill as plain text (no link target)', () => {
    renderRow({ ...CALL_ITEM, jobId: undefined });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.getByText('J00042').closest('a')).toBeNull();
  });
});

describe('CommRow — row selection (opens the detail drawer)', () => {
  it('calls onSelect with the item when the row body is clicked', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    await userEvent.click(screen.getByText('Inbound call · 4m 07s'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(CALL_ITEM);
  });

  it('exposes the row as a button (keyboard-activatable) when selectable', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    const row = screen.getByRole('button');
    row.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does NOT open the drawer when a job/lead chip is clicked (chip navigation wins)', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    // The job pill and lead chip are navigating links inside the row — their
    // clicks must not bubble up and also open the drawer.
    await userEvent.click(screen.getByText('J00042'));
    await userEvent.click(screen.getByText('L00007'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is not interactive (no button role) without onSelect', () => {
    renderRow(CALL_ITEM);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

// Email slice 5 — the delivery-state pill CommRow renders for a sent Email
// item, feeding the Job/Customer/Lead Communication tabs (the shared
// aggregator, backend lib/job-communications.ts, is where deliveryStatus is
// actually populated; this suite only covers CommRow's own render logic).
describe('CommRow — email delivery pill (slice 5)', () => {
  const SENT_EMAIL_ITEM: CommItem = {
    id: 'em000000-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Doe HVAC',
    title: 'Estimate E00042 from ServWave',
    preview: 'Your estimate is ready.',
    at: '2026-06-01T09:12:00.000Z',
    transactional: true,
  };

  it('renders the delivery pill for a sent email with a known deliveryStatus', () => {
    renderRow({ ...SENT_EMAIL_ITEM, deliveryStatus: 'BOUNCED', deliveryStatusReason: 'mailbox unavailable' });

    expect(screen.getByText('Bounced')).toBeInTheDocument();
  });

  it('renders nothing extra when the email row has no deliveryStatus yet', () => {
    renderRow(SENT_EMAIL_ITEM);

    expect(screen.queryByText('Bounced')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('never renders the pill for an inbound email (delivery state is an outbound-only fact)', () => {
    renderRow({ ...SENT_EMAIL_ITEM, direction: 'in', deliveryStatus: 'DELIVERED' });

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('never renders the pill for a non-email channel, even if deliveryStatus were somehow set', () => {
    renderRow({ ...CALL_ITEM, deliveryStatus: 'DELIVERED' } as CommItem);

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('a BOUNCED sent email never renders through StateChip\'s sage styling', () => {
    const { container } = renderRow({ ...SENT_EMAIL_ITEM, deliveryStatus: 'BOUNCED' });

    // StateChip's one legitimate use is sage (bg-sage-50) for a genuine
    // business state (Approved/Paid) - a bounce must never share that class.
    expect(container.innerHTML).not.toContain('bg-sage-50');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual Communication Log (slice 1) — the "Logged" chip.
//
// SAFETY-CRITICAL and shipped in the tracer, not deferred: a hand-typed record must never be
// mistakable for a recorded call. It is a chip beside the existing chips, on the SAME shared row,
// in chronological position — explicitly not a different background colour and not a separate
// section, because the chronology is what makes the timeline readable.
// ─────────────────────────────────────────────────────────────────────────────
describe('CommRow — the "Logged" chip (manual communication log)', () => {
  const LOGGED_ITEM: CommItem = {
    ...CALL_ITEM,
    id: '11110000-0000-0000-0000-000000000001',
    title: 'Outbound call',
    direction: 'out',
    preview: 'Spoke to John from my mobile.',
    answeredBy: undefined,
    meta: undefined,
    manuallyLogged: true,
  };

  it('marks a manually logged entry', () => {
    renderRow(LOGGED_ITEM);

    expect(screen.getByText('Logged')).toBeInTheDocument();
  });

  it('leaves a platform-recorded row unmarked', () => {
    renderRow(CALL_ITEM);

    expect(screen.queryByText('Logged')).not.toBeInTheDocument();
  });

  it('keeps the row otherwise identical - same line, same chips, no separate section', () => {
    renderRow(LOGGED_ITEM);

    // Still the standard line, and still carrying the job and lead chips.
    expect(screen.getByText('Outbound')).toBeInTheDocument();
    expect(screen.getByText(/· Doe HVAC/)).toBeInTheDocument();
    expect(screen.getByText('Spoke to John from my mobile.')).toBeInTheDocument();
    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.getByText('L00007')).toBeInTheDocument();
  });

  it('never renders through StateChip\'s sage styling - a typed note is not a business state', () => {
    const { container } = renderRow(LOGGED_ITEM);

    expect(container.innerHTML).not.toContain('bg-sage-50');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Slice 2 — the hand-entered overlay on the channel icon.
  //
  // The chip says "logged" in words; the overlay says it at a glance, on the one element a
  // reader's eye lands on first when scanning a column of rows. It is a marker, not decoration,
  // so it carries an accessible name rather than being a purely visual flourish.
  // ───────────────────────────────────────────────────────────────────────────

  const overlay = () => screen.queryByRole('img', { name: /hand-entered/i });

  it('marks the channel icon as hand-entered', () => {
    renderRow(LOGGED_ITEM);

    expect(overlay()).toBeInTheDocument();
  });

  it('leaves a platform-recorded row\'s icon unmarked', () => {
    renderRow(CALL_ITEM);

    expect(overlay()).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 6 — the channel a logged entry was logged on.
//
// Until the picker shipped, every manual entry was a CALL, so every channel-keyed branch in this
// row was reached only by platform records. That is no longer true, and each branch has to be
// asked whether it means anything for a hand-typed record.
// ─────────────────────────────────────────────────────────────────────────────
describe('CommRow — a hand-logged text and a hand-logged email', () => {
  const LOGGED_EMAIL: CommItem = {
    id: '11110000-0000-0000-0000-000000000021',
    channel: 'email',
    direction: 'out',
    who: 'Doe HVAC',
    title: 'Outbound email · Revised scope',
    preview: 'Replied from Outlook with the revised scope.',
    at: '2026-06-01T15:00:00.000Z',
    manuallyLogged: true,
    loggedByName: 'Priya Raman',
  };
  const LOGGED_TEXT: CommItem = {
    ...LOGGED_EMAIL,
    id: '11110000-0000-0000-0000-000000000022',
    channel: 'sms',
    title: 'Outbound text',
    preview: 'Texted him the arrival window from my phone.',
  };

  // C6a - A DELIVERY STATUS IS A CLAIM ABOUT THE PLATFORM'S MAIL TRANSPORT. It is written by the
  // Resend webhook reporting on a message ServWave itself sent; a record somebody typed up about
  // an email they sent from Outlook has no such provenance, and a pill saying "Delivered" beside
  // it would assert something nothing ever observed.
  it('never renders a delivery pill on a hand-logged email, however the row arrives', async () => {
    renderRow({ ...LOGGED_EMAIL, deliveryStatus: 'DELIVERED' });

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
    // …and the row is otherwise the normal one: still marked, still readable.
    expect(screen.getByText('Logged')).toBeInTheDocument();
    expect(screen.getByText('Outbound email · Revised scope')).toBeInTheDocument();
  });

  it('still renders the pill for a PLATFORM sent email beside it', () => {
    renderRow({ ...LOGGED_EMAIL, manuallyLogged: undefined, deliveryStatus: 'DELIVERED' });

    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  const overlayFor = (name: RegExp) => screen.queryByRole('img', { name });

  // The hand-entered treatment travels with the channel: the same overlay, on the channel's own
  // icon, and named for the platform artefact this is NOT. "Not a recorded call" on an email
  // would be the same category error as the delivery pill above.
  it('marks a logged text and a logged email as hand-entered, each naming its own channel', () => {
    const { unmount } = renderRow(LOGGED_TEXT);
    expect(overlayFor(/hand-entered, not a platform text/i)).toBeInTheDocument();
    unmount();

    renderRow(LOGGED_EMAIL);
    expect(overlayFor(/hand-entered, not a platform email/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 2 — the meta line's attribution.
//
// Once the performer and the logger can differ, a reader has to be able to tell an EYEWITNESS
// record from a SECOND-HAND one: an admin onboarding an organisation is typing up conversations
// colleagues had, and a row that named only one of the two would quietly claim otherwise.
//
// When they are the same person the name is said ONCE. "Logged by Dana Reyes on behalf of Dana
// Reyes" is not a smaller mistake than omitting the attribution — it invents a distinction that
// is not there.
// ─────────────────────────────────────────────────────────────────────────────
describe('CommRow — who logged it and who had the conversation', () => {
  const SECOND_HAND: CommItem = {
    ...CALL_ITEM,
    id: '11110000-0000-0000-0000-000000000002',
    title: 'Outbound call',
    direction: 'out',
    preview: 'Rang about the quote.',
    answeredBy: undefined,
    meta: undefined,
    manuallyLogged: true,
    loggedByName: 'Priya Raman',
    performedByName: 'Dana Reyes',
  };

  it('names the logger and the performer when they differ', () => {
    renderRow(SECOND_HAND);

    expect(screen.getByText('· Logged by Priya Raman on behalf of Dana Reyes')).toBeInTheDocument();
  });

  it('names the logger once when they are the same person', () => {
    renderRow({ ...SECOND_HAND, performedByName: 'Priya Raman' });

    expect(screen.getByText('· Logged by Priya Raman')).toBeInTheDocument();
    expect(screen.queryByText(/on behalf of/)).not.toBeInTheDocument();
  });

  it('says nothing about attribution on a platform-recorded row', () => {
    renderRow(CALL_ITEM);

    expect(screen.queryByText(/logged by/i)).not.toBeInTheDocument();
  });

  it('keeps the answered-by and disposition fragments it sits beside', () => {
    renderRow({ ...SECOND_HAND, answeredBy: 'Dana Reyes', meta: 'Booked' });

    expect(screen.getByText('· answered by Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('· Booked')).toBeInTheDocument();
    expect(screen.getByText('· Logged by Priya Raman on behalf of Dana Reyes')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 3 — how long the call was, as the row reads it.
//
// The backend composes the duration into the TITLE, where a platform-recorded call already
// carries its own. No new field, and therefore no new rendering branch — which is what makes
// "unchanged for an entry that carries none" true rather than merely intended.
//
// THE OUTCOME IS RETIRED, so nothing composes `meta` for a logged entry any more. The `meta`
// slot itself is alive and still carries a PLATFORM call's disposition — asserted above with
// meta: 'Booked' — which is why there is no case for it here.
//
// The strings below are the ones lib/job-communications.ts really produces (asserted verbatim in
// backend/src/__tests__/comm-manual-log.test.ts), so this closes the path from column to pixel.
// ─────────────────────────────────────────────────────────────────────────────
describe('CommRow — how long the call was (manual communication log)', () => {
  const LOGGED: CommItem = {
    ...CALL_ITEM,
    id: '11110000-0000-0000-0000-000000000003',
    direction: 'out',
    preview: 'Walked through the whole scope.',
    answeredBy: undefined,
    title: 'Outbound call',
    meta: undefined,
    manuallyLogged: true,
  };

  it('shows how long it lasted', () => {
    renderRow({ ...LOGGED, title: 'Outbound call · 12m' });

    expect(screen.getByText('Outbound call · 12m')).toBeInTheDocument();
  });

  it('is unchanged for an entry that carries none', () => {
    renderRow(LOGGED);

    expect(screen.getByText('Outbound call')).toBeInTheDocument();
    expect(screen.getByText('Logged')).toBeInTheDocument();
    // Nothing extra on the meta line beyond the direction and the counterparty.
    expect(screen.getByText('Outbound').parentElement).toHaveTextContent(/^Outbound · Doe HVAC/);
  });
});
