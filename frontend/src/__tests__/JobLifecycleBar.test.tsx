import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobLifecycleBar } from '@/components/jobs/JobLifecycleBar';

// S5 (D11): the job row's scheduled_start / on_site_at mirror is gone from the bar's input - a
// trip's own node carries its own state now. A job with no visits draws the Schedule placeholder,
// which is what these job-node cases exercise.
const baseJob = {
  created_at: '2026-03-01T09:00:00Z',
  completed_at: null,
  status: 'SCHEDULED',
  cancelled_at: null,
};
const allCan = { scheduled: true, started: true, completed: true };

describe('JobLifecycleBar interactivity', () => {
  it('renders job nodes as buttons when the user holds the capability', async () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /schedule/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /completed/i })).toBeInTheDocument();
  });

  it('renders a node inert — not a disabled button — when the capability is absent', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={{ scheduled: false }} onNodeClick={vi.fn()} />);
    // No disabled-looking affordance for a permission they will never have.
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument();
  });

  it('makes the invoice nodes interactive when the capability is held', async () => {
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined}
      can={{ ...allCan, invoice_sent: true, payment_received: true }} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /invoice sent/i }));
    expect(onNodeClick).toHaveBeenCalledWith('invoice_sent');
  });

  it('leaves the invoice nodes inert without the capability', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined}
      can={{ ...allCan, invoice_sent: false, payment_received: false }} onNodeClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /invoice sent/i })).not.toBeInTheDocument();
  });

  it('keeps Invoice Sent clickable when it IS the current stage — clicking opens the invoice', async () => {
    // B1's `!stage.current` rule is right for job nodes (re-stamping completed_at is a no-op) but
    // wrong here: State 1's whole behaviour is "open the invoice", which is only reachable from
    // the node the job is currently at.
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar
      job={{ ...baseJob, status: 'COMPLETED', completed_at: '2026-03-02T16:00:00Z' }}
      financials={{ final_invoice: { id: 'i1', invoice_number: 'I00001', status: 'SENT', sent_at: '2026-03-10T12:00:00Z', paid_at: null }, first_sent_at: '2026-03-10T12:00:00Z' } as never}
      can={{ ...allCan, invoice_sent: true }} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /invoice sent/i }));
    expect(onNodeClick).toHaveBeenCalledWith('invoice_sent');
  });

  it('fires onNodeClick with the stage key', async () => {
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(onNodeClick).toHaveBeenCalledWith('scheduled');
  });

  it('does not fire for the node the job is already at', async () => {
    const onNodeClick = vi.fn();
    const doneJob = { ...baseJob, completed_at: '2026-03-02T14:00:00Z', status: 'COMPLETED' };
    render(<JobLifecycleBar job={doneJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    // Clicking the current milestone is a no-op: it would re-stamp the timestamp for nothing,
    // and on Completed it would re-arm the AFTER_JOB_COMPLETED follow-up automation.
    const node = screen.queryByRole('button', { name: /completed/i });
    if (node) { await userEvent.click(node); }
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('leaves Completed inert on a completed job that still holds a live trip', async () => {
    // The same no-op guard as the case above, on the shape D11 introduced: a job marked complete
    // that then had a follow-up trip booked (job status is UNORDERED - Spec B1). `current` moves
    // to the live VISIT node there, so a rule reading `current` un-inerts the Completed tick and
    // every click re-stamps completed_at, re-emits the job.completed notification and re-fires
    // the JOB_COMPLETED automation - the follow-up the customer already received.
    const onNodeClick = vi.fn();
    const doneJob = { ...baseJob, completed_at: '2026-03-02T14:00:00Z', status: 'COMPLETED' };
    const followUp = {
      id: 'v-9', visit_seq: 2, status: 'SCHEDULED',
      scheduled_at: '2026-03-09T09:00:00Z', scheduled_end: null, is_all_day: false,
      created_at: '2026-03-03T00:00:00Z',
    };
    render(<JobLifecycleBar job={doneJob} financials={undefined} visits={[followUp]}
      can={allCan} onNodeClick={onNodeClick} />);

    const node = screen.queryByRole('button', { name: /completed/i });
    expect(node).not.toBeInTheDocument();
    if (node) { await userEvent.click(node); }
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('allows a BACKWARD click to an earlier milestone', async () => {
    const onNodeClick = vi.fn();
    const doneJob = { ...baseJob, completed_at: '2026-03-02T14:00:00Z', status: 'COMPLETED' };
    render(<JobLifecycleBar job={doneJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(onNodeClick).toHaveBeenCalledWith('scheduled');
  });

  it('shows Start while started_at and completed_at are both null', async () => {
    const onStartClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onStartClick={onStartClick} />);
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));
    expect(onStartClick).toHaveBeenCalled();
  });

  it('keeps every control clickable on a CANCELLED job — cancellation is not terminal', async () => {
    const onNodeClick = vi.fn();
    const cancelled = { ...baseJob, status: 'CANCELLED', cancelled_at: '2026-03-02T11:00:00Z' };
    render(<JobLifecycleBar job={cancelled} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument(); // the badge still shows
    await userEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(onNodeClick).toHaveBeenCalledWith('scheduled');
  });

  it('disables every control while busy', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: /schedule/i })).toBeDisabled();
  });
});

/**
 * S5 B2 (D11, D7a): the risk this whole slice turns on. The job-level verbs
 * (POST /api/jobs/:id/{arrive,en-route,start}) take no visit id - the server resolves one - so a
 * per-visit node left wired to them compiles, renders right, returns 200 and stamps the WRONG
 * trip. Same class as #1550. The control must name the row it belongs to.
 */
describe('a visit node acts on its OWN visit', () => {
  const V1 = {
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
    created_at: '2026-03-01T00:00:00Z',
  };
  const V2 = { ...V1, id: 'v-2', visit_seq: 2, scheduled_at: '2026-03-06T09:00:00Z', created_at: '2026-03-01T01:00:00Z' };

  it('fires the action with the row id of the node that was clicked', async () => {
    const onVisitAction = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[V1, V2]}
      visitAbilities={{ en_route: true, arrive: true, start: true }} onVisitAction={onVisitAction} />);

    const node = within(screen.getByRole('group', { name: 'Visit 2' }));
    await userEvent.click(node.getByRole('button'));

    expect(onVisitAction).toHaveBeenCalledWith('v-2', 'en-route');
  });
});

/**
 * S5 (D11, D7a): a visit node's control is the next step in THAT TRIP's lifecycle, derived from
 * that row's own status - not a fixed verb the rail assumes. Every other rail case renders only
 * SCHEDULED trips, so nothing there could tell a per-status derivation from a hardcoded one: a
 * finished trip would get an "En route" button whose POST the backend's source-status guard
 * rejects, and a trip already en route would be offered the step it has taken rather than the one
 * it has not.
 *
 * "source-status" rather than the obvious hyphenation: the unresolved-class guard scans prose as
 * well as markup, and a hyphenated gradient-prefix word in a comment reads to it as a real
 * Tailwind class and reddens the guard.
 */
describe('a visit node offers the next step for ITS OWN status', () => {
  const DONE_VISIT = {
    id: 'v-1', visit_seq: 1, status: 'COMPLETED',
    scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
    completed_at: '2026-03-02T15:00:00Z',
    created_at: '2026-03-01T00:00:00Z',
  };
  const EN_ROUTE_VISIT = {
    id: 'v-2', visit_seq: 2, status: 'EN_ROUTE',
    scheduled_at: '2026-03-06T09:00:00Z', scheduled_end: null, is_all_day: false,
    en_route_at: '2026-03-06T08:30:00Z',
    created_at: '2026-03-01T01:00:00Z',
  };
  const allVerbs = { en_route: true, arrive: true, start: true };

  it('offers a finished trip nothing at all - it is history', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[DONE_VISIT, EN_ROUTE_VISIT]}
      visitAbilities={allVerbs} onVisitAction={vi.fn()} />);

    const node = within(screen.getByRole('group', { name: 'Visit 1' }));
    expect(node.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers a trip already on the way Mark on site, not the step it has taken', async () => {
    const onVisitAction = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[DONE_VISIT, EN_ROUTE_VISIT]}
      visitAbilities={allVerbs} onVisitAction={onVisitAction} />);

    const node = within(screen.getByRole('group', { name: 'Visit 2' }));
    await userEvent.click(node.getByRole('button', { name: 'Mark on site' }));

    expect(onVisitAction).toHaveBeenCalledWith('v-2', 'arrive');
  });
});

/**
 * Scheduling-notifications slice 09: the rail's per-visit control is the PRIMARY next step only
 * - the first milestone in lifecycle order that THIS viewer may perform, labelled as a command.
 * No Skip to here; the Visits card carries it.
 */
describe('a visit node offers the primary next step this viewer may perform (slice 09)', () => {
  const BOOKED_VISIT = {
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
    created_at: '2026-03-01T00:00:00Z',
  };

  it('labels the step as a command for a viewer with every verb', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[BOOKED_VISIT]}
      visitAbilities={{ en_route: true, arrive: true, start: true }} onVisitAction={vi.fn()} />);

    const node = within(screen.getByRole('group', { name: 'Visit 1' }));
    expect(node.getByRole('button', { name: 'Mark on the way' })).toBeInTheDocument();
    expect(node.getAllByRole('button')).toHaveLength(1);
  });

  it('makes Mark on site the ONLY control for a viewer without the on-the-way verb', async () => {
    const onVisitAction = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[BOOKED_VISIT]}
      visitAbilities={{ arrive: true, start: true }} onVisitAction={onVisitAction} />);

    const node = within(screen.getByRole('group', { name: 'Visit 1' }));
    expect(node.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(node.getByRole('button', { name: 'Mark on site' }));

    expect(onVisitAction).toHaveBeenCalledWith('v-1', 'arrive');
  });
});

/**
 * S5 B6 (D11, story 30): each node carries ITS OWN state and ITS OWN date. Asia/Manila is passed
 * explicitly because no plausible runner shares it, so a browser-local render cannot pass here by
 * coincidence.
 */
describe('a visit node shows its own state and date', () => {
  const ON_SITE_VISIT = {
    id: 'v-1', visit_seq: 1, status: 'ON_SITE',
    scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
    // 16:30Z is Mar 3 in Manila and Mar 2 in both UTC and New York.
    on_site_at: '2026-03-02T16:30:00Z',
    created_at: '2026-03-01T00:00:00Z',
  };
  const BOOKED_VISIT = {
    id: 'v-2', visit_seq: 2, status: 'SCHEDULED',
    scheduled_at: '2026-03-05T02:00:00Z', scheduled_end: null, is_all_day: false,
    created_at: '2026-03-01T01:00:00Z',
  };

  it('reads the visit status word and the ORG-clock date inside that node', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined}
      visits={[ON_SITE_VISIT, BOOKED_VISIT]} tz="Asia/Manila" />);

    const node = within(screen.getByRole('group', { name: 'Visit 1' }));
    expect(node.getByText('On Site')).toBeInTheDocument();
    expect(node.getByText('Mar 3')).toBeInTheDocument();
    expect(node.queryByText('Mar 2')).not.toBeInTheDocument();
  });
});

/**
 * S5 B9: D11 deletes the fixed Scheduled node, and a brand-new job with no visits is the single
 * most common state on this page - dropping the entry point would leave it with no way to book
 * anything from the rail, and would silently take the job-level Start with it (it was anchored to
 * the On Site node). Once any trip exists, Start belongs to the trip.
 */
describe('a job with no visits can still be scheduled and started from the rail', () => {
  const BOOKED_VISIT = {
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: '2026-03-05T02:00:00Z', scheduled_end: null, is_all_day: false,
    created_at: '2026-03-01T01:00:00Z',
  };

  it('draws a Schedule placeholder and the job-level Start when there are no visits', async () => {
    const onNodeClick = vi.fn();
    const onStartClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[]}
      can={{ scheduled: true, started: true }} onNodeClick={onNodeClick} onStartClick={onStartClick} />);

    await userEvent.click(screen.getByRole('button', { name: /schedule/i }));
    expect(onNodeClick).toHaveBeenCalledWith('scheduled');

    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));
    expect(onStartClick).toHaveBeenCalled();
  });

  it('drops both the moment a visit exists - the trip owns its own controls', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} visits={[BOOKED_VISIT]}
      can={{ scheduled: true, started: true }} onNodeClick={vi.fn()} onStartClick={vi.fn()} />);

    expect(screen.queryByRole('group', { name: 'Scheduled' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
  });
});
