// TG12 — the event editor: the ONLY per-person crew path (drags = whole-lane swaps;
// the D5 modal = initial scheduling). PURE controlled dialog — it stages crew/time
// drafts locally and emits onSaveCrew / onSaveTime / onUnschedule / onClose; the PAGE
// owns mutations, confirms, and toasts. Owner is OFF-BOARD: display-only here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import api from '@/lib/axios';
import { EventEditor } from '@/components/schedule/EventEditor';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';
import { asWallClock } from '@/lib/schedule-tz';

// Navigation spy: Open-full-page icon + View details must navigate via useNavigate.
const navSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig() as object),
  useNavigate: () => navSpy,
}));

// The picker roster carries no contact fields - see the v2 twin's fixture note. Crew phone
// numbers come off the event payload below.
const MEMBERS: AssignableUser[] = [
  { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', department: null },
  { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', role: 'TECHNICIAN', department: null },
];

const OWNER = { id: 'u-olivia', first_name: 'Olivia', last_name: 'Owner' };

/** State-2 job: crew ≥1 + timed, SCHEDULED; owner reached via estimate.lead. */
const scheduledJob: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme Corp',
  crew: ['u-alice', 'u-bob'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {
    status: 'SCHEDULED',
    customer: { phone: '555-0199' },
    assignees: [
      { user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: '555-0101' } },
      { user: { id: 'u-bob', first_name: 'Bob', last_name: 'Ortiz', phone: null } },
    ],
    estimate: { lead: { commission_owner: OWNER } },
  },
};

/** Timed walkthrough — owner read straight off lead.commission_owner. */
const walkthrough: SchedulableEvent = {
  boardId: 'wt-lead-1',
  parentId: 'lead-1',
  type: 'walkthrough',
  number: 'L00012',
  title: 'Initial site visit',
  customer: 'Acme Corp',
  crew: ['u-alice'],
  ownerId: 'u-olivia',
  start: asWallClock(new Date(2026, 5, 11, 14, 0)),
  end: asWallClock(new Date(2026, 5, 11, 15, 0)),
  raw: {
    id: 'lead-1',
    status: 'CONTACTED',
    walkthrough_performers: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: '555-0101' } }],
    commission_owner: OWNER,
  },
};

/** State-3 job: keeps its crew, no time. */
const unscheduledJob: SchedulableEvent = {
  ...scheduledJob,
  boardId: 'job-2',
  parentId: 'job-2',
  number: 'J00044',
  start: null,
  end: null,
};

function renderEditor(over: Partial<ComponentProps<typeof EventEditor>> = {}) {
  const onSaveCrew = vi.fn();
  const onSaveTime = vi.fn();
  const onUnschedule = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <EventEditor
      open
      event={scheduledJob}
      members={MEMBERS}
      canUnschedule
      onSaveCrew={onSaveCrew}
      onSaveTime={onSaveTime}
      onUnschedule={onUnschedule}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSaveCrew, onSaveTime, onUnschedule, onClose };
}

beforeEach(() => {
  // MultiAssigneeSelect self-fetches the org-wide assignable roster for chip labels.
  // GET /api/users/assignable answers with a BARE array - no `{ users }` wrapper.
  vi.mocked(api.get).mockResolvedValue({ data: MEMBERS });
  vi.mocked(api.post).mockClear();
  navSpy.mockClear();
});

describe('EventEditor (TG12)', () => {
  it('renders a state-2 job: type pill, state chip, owner row, crew chips, time inputs', async () => {
    renderEditor();
    // Header: type pill + number + title + customer
    expect(screen.getByText('Job')).toBeInTheDocument();
    expect(screen.getByText('J00043')).toBeInTheDocument();
    expect(screen.getByText(/Rooftop Unit Swap/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Corp/)).toBeInTheDocument();
    // State chip — label + hint from STATE_META
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText(/crew ≥1 · timed/)).toBeInTheDocument();
    // Owner row — off-board, read-only
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
    // Current crew as chips (labels resolve from the roster query). Alice also has a
    // contact row (#370, the payload gives her a phone) so her name can appear more than once.
    expect((await screen.findAllByText('Alice Ng')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Bob Ortiz')).length).toBeGreaterThan(0);
    // Timed → schedule inputs pre-filled from the event. Date is a DatePicker now -
    // displays MM/DD/YYYY (typeable text), not the native input's raw 'yyyy-MM-dd'.
    expect(screen.getByLabelText('Start date')).toHaveValue('06/10/2026');
    // TimeCombobox renders 12-hour text; the native input showed a 24-hour clock
    // in any non-US browser locale, and this is a US-only product.
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    // Both ends are stated. The popover used to stop at date + start + a Duration
    // dropdown, never showing when the job actually ends; there is no duration control
    // on any surface now.
    expect(screen.getByLabelText('End date')).toHaveValue('06/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
    // Nothing is dirty yet → no save buttons
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
  });

  it('crew edit + Save crew emits the full REPLACE array — and the component never POSTs', async () => {
    const { onSaveCrew } = renderEditor();
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));
    // Draft ≠ event crew → the explicit save button appears
    fireEvent.click(screen.getByRole('button', { name: 'Save crew' }));
    expect(onSaveCrew).toHaveBeenCalledWith(['u-bob']);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('time edit + Save time emits (start, durationMin) — page owns the POST', () => {
    const { onSaveTime } = renderEditor();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '1:30 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));
    expect(onSaveTime).toHaveBeenCalledWith(new Date(2026, 5, 10, 13, 30), 120);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('end-time edit + Save time emits the SAME (start, durationMin) contract', () => {
    const { onSaveTime } = renderEditor();
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '12:00 PM' } });
    fireEvent.blur(screen.getByLabelText('End time'));
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }));
    // Start unchanged, duration re-derived from the new end — the page's mutation never
    // learns that the field the user typed into was an end time.
    expect(onSaveTime).toHaveBeenCalledWith(new Date(2026, 5, 10, 9, 0), 180);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('Move to Unscheduled fires onUnschedule (page owns confirm + POST)', () => {
    const { onUnschedule } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Move to Unscheduled/ }));
    expect(onUnschedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('canUnschedule=false disables the button and renders the reason', () => {
    renderEditor({
      canUnschedule: false,
      unscheduleDisabledReason: "In-progress jobs can't be unscheduled.",
    });
    expect(screen.getByRole('button', { name: /Move to Unscheduled/ })).toBeDisabled();
    expect(screen.getByText("In-progress jobs can't be unscheduled.")).toBeInTheDocument();
  });

  it('a walkthrough renders its type pill and owner', () => {
    renderEditor({ event: walkthrough });
    expect(screen.getByText('Walkthrough')).toBeInTheDocument();
    expect(screen.getByText('L00012')).toBeInTheDocument();
    expect(screen.getByText('Owner (off-board)')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner')).toBeInTheDocument();
  });

  it('readOnly renders crew as plain text with no editing affordances', () => {
    renderEditor({ readOnly: true });
    // #370: joined names became per-member rows — both names still queryable.
    expect(screen.getByText('Alice Ng')).toBeInTheDocument();
    expect(screen.getByText('Bob Ortiz')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Alice Ng')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save crew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save time' })).not.toBeInTheDocument();
    // The unschedule action is hidden entirely when readOnly
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
    // Time renders as text, not inputs
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
  });

  it('an unscheduled event shows "Unscheduled" — no time inputs, no unschedule button', () => {
    renderEditor({ event: unscheduledJob });
    expect(screen.getByText(/Unscheduled —/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();
    // Move to Unscheduled is for TIMED events only
    expect(screen.queryByRole('button', { name: /Move to Unscheduled/ })).not.toBeInTheDocument();
  });

  // ─── Open-full-page icon, "View details", tel:/sms: contact links are the only nav triggers ──

  it('clicking a non-interactive body area does NOT close or navigate', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByText('Scheduled')); // state-chip text — not a control
    expect(onClose).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('clicking interactive elements does NOT close or navigate', async () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByLabelText('Start date'));                        // input
    fireEvent.click(await screen.findByLabelText('Remove Alice Ng'));      // crew chip button
    fireEvent.click(screen.getByLabelText('Call Alice Ng'));               // tel: link
    expect(onClose).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
  });

  it('an "Open full page" header button closes and navigates to the job page', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('"Open full page" on a walkthrough navigates to the lead walkthrough tab', () => {
    renderEditor({ event: walkthrough });
    fireEvent.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(navSpy).toHaveBeenCalledWith('/leads/lead-1?tab=walkthrough');
  });

  it('renders tel:/sms: links next to the customer name from the payload phone', () => {
    renderEditor();
    expect(screen.getByLabelText('Call Acme Corp')).toHaveAttribute('href', 'tel:555-0199');
    expect(screen.getByLabelText('Text Acme Corp')).toHaveAttribute('href', 'sms:555-0199');
  });

  it('crew contact links: crew member with a PAYLOAD phone gets tel:/sms:, phoneless member gets none (edit mode)', () => {
    renderEditor();
    expect(screen.getByLabelText('Call Alice Ng')).toHaveAttribute('href', 'tel:555-0101');
    expect(screen.getByLabelText('Text Alice Ng')).toHaveAttribute('href', 'sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Text Bob Ortiz')).not.toBeInTheDocument();
  });

  it('crew contact links render in readOnly mode too', () => {
    renderEditor({ readOnly: true });
    expect(screen.getByLabelText('Call Alice Ng')).toHaveAttribute('href', 'tel:555-0101');
    expect(screen.getByLabelText('Text Alice Ng')).toHaveAttribute('href', 'sms:555-0101');
    expect(screen.queryByLabelText('Call Bob Ortiz')).not.toBeInTheDocument();
  });

  it('the View details → button still navigates', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /View details/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navSpy).toHaveBeenCalledWith('/jobs/job-1');
  });
});
