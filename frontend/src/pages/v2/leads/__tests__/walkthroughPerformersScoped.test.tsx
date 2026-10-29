// THE REPORTED BUG, ON THE SURFACE IT WAS REPORTED ON.
//
// A salesperson opens their own lead's Walkthrough tab. They hold no `assign User`, so the scoped
// roster (`GET /api/users/assignable`) answers with exactly one row — themselves — and the picker's
// dropdown is correctly empty of anyone else. What must NOT happen is the two strings the bug was
// filed for: a technician a dispatcher already put on this walkthrough rendering `Unknown`, and the
// trigger reading `No more members` as though the roster had run out rather than as a rule.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `MultiAssigneeSelect.test.tsx`. That suite proves the
// COMPONENT resolves a name from `knownPeople` and words the placeholder off the grant. It cannot
// prove this TAB passes either one. Both call-site props were removed and the `purpose` swapped to
// `task` as a mutation, and all 654 frontend suites stayed green — the wiring was untested. This is
// the test that reddens for that.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };

// The SCOPED roster: a self-only requester is answered with their own row and nobody else's.
// This is what the endpoint returns for a SALES user, so it is what the picker gets.
vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: [{ ...SALES, role: 'SALES', department: null }] }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

/** A rep's own lead, already booked, with a technician the DISPATCHER put on it. */
const LEAD = {
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_duration_minutes: 60,
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_notes: '',
  walkthrough_performers: [{ user: TECH }, { user: SALES }],
};

/** SALES: may schedule the walkthrough on a lead they own, may NOT name people other than
 *  themselves. `assign User` is deliberately absent — that grant is the whole switch. */
const salesAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);

async function openRescheduleForm(ability = salesAbility) {
  const user = userEvent.setup();
  renderWithProviders(
    <WalkthroughTabContent
      lead={LEAD}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough
    />,
    { ability },
  );
  await user.click(screen.getByRole('button', { name: /Reschedule/i }));
}

describe('walkthrough Performers field for a rep who may not name others', () => {
  it('names the technician the record already carries instead of rendering "Unknown"', async () => {
    await openRescheduleForm();

    // Both chips read a name. The technician is NOT in this viewer's roster — the only thing that
    // can name them is the lead payload the tab already holds.
    expect(screen.getByText('Terry Tech')).toBeInTheDocument();
    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('states the rule rather than reporting an empty roster', async () => {
    await openRescheduleForm();

    // `No more members` is what an exhausted roster says. A rep who never had one must not be
    // told the team ran out — that is the string the bug was filed under.
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  // PINS THE PURPOSE THIS FIELD IS DRAWN FOR. `assign Task` is a different switch from
  // `assign User`, and a holder of the former still may not name a walkthrough performer. If this
  // call site passed `purpose="task"` the field would read the wrong grant, decide this user MAY
  // add others, and go back to reporting an empty roster.
  it('reads the walkthrough grant, not the task grant', async () => {
    await openRescheduleForm(buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'schedule_walkthrough', subject: 'Lead' },
      { action: 'assign', subject: 'Task' },
    ]));

    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
  });
});
