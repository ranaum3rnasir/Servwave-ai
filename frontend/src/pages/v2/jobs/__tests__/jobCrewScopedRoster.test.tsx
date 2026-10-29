// THE OTHER HALF OF RAN'S RULING, ON THE JOB SURFACES IT LANDS ON.
//
// `pages/v2/leads/__tests__/walkthroughPerformersScoped.test.tsx` pins the walkthrough call
// site. The two JOB CREW pickers were the untested half: a reviewer deleted a call site's
// payload name source and swapped its `purpose`, ran all 654 frontend suites, and got green.
// Nothing anywhere pinned any call site's wiring. This file is that pin for:
//
//   pages/v2/jobs/components/visitScheduleDialog.tsx  - the per-visit Crew field
//   components/jobs/AssignJobDialog.tsx               - the job crew assign/schedule dialog
//                                                       (mounted by pages/v2/jobs/JobDetailPage)
//
// THE RULE. A rep who owns the lead owns the job and SEES everything about it, including who
// is assigned, by name. What is withheld is the ability to CHANGE them. So two different
// questions must stay separated:
//   - who you may ADD  -> `GET /api/users/assignable`, scoped by the `assign User` grant
//   - who is already ON the record -> the record's own payload, never gated
//
// THE REAL COMPONENT RENDERS HERE, DELIBERATELY. Several existing suites stub
// `MultiAssigneeSelect` (assign-job-dialog-schedule.test.tsx, walkthroughSchedule.test.tsx),
// which is precisely why none of them could see this defect. A stub renders whatever the
// stub was written to render.
//
// AND THE ROSTER IS SERVED THROUGH THE REAL HOOK, off the mocked axios, keyed on the
// `purpose` query param the hook actually sends - the same thing the server scopes by
// (`resolveAssigneePool`). A hook-level mock that ignores `purpose` would let a call site
// ask for the wrong pool and still be handed the right one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule, type AppAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import type { AssignableUser, AssigneePurpose } from '@/lib/api/users';
import type { JobVisitRow } from '@/lib/visits';

import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };
/** On the job already, put there by a dispatcher. NEVER in the rep's scoped roster. */
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };
/** Not on the job - the roster row that proves a grant-holder gets a real list to add from. */
const OFFICE = { id: 'u-office', first_name: 'Olive', last_name: 'Office' };

const asRow = (p: typeof SALES, role: string): AssignableUser =>
  ({ ...p, role, department: null }) as AssignableUser;

/** What `/api/users/assignable` answers a requester who holds no `assign` grant: themselves. */
const SELF_ONLY = [asRow(SALES, 'SALES')];
/** ...and what it answers one who does. */
const WHOLE_ORG = [asRow(SALES, 'SALES'), asRow(TECH, 'TECHNICIAN'), asRow(OFFICE, 'DISPATCHER')];

const get = api.get as ReturnType<typeof vi.fn>;

/**
 * The roster the fake endpoint serves, PER PURPOSE - because the real one is scoped per
 * purpose too. Each test sets both entries to what the server would really answer that
 * viewer, so asking with the wrong purpose gets the wrong pool here exactly as it would in
 * production.
 */
let roster: Record<AssigneePurpose, AssignableUser[]>;

beforeEach(() => {
  // `directory` is seeded to the WHOLE ORG on purpose: it is the family gated on `read User`,
  // which these viewers hold, so a crew picker that asked with the wrong purpose would get a
  // list it must not have - and the 'locked' assertions below would go red rather than pass.
  // `taskWatcher` is seeded to the WHOLE ORG for the same reason as `directory`: it is a pool no
  // crew grant narrows (#1956), so a crew picker reaching for it would get a list it must not
  // have, and the 'locked' assertions below would go red rather than quietly pass.
  roster = {
    jobCrew: SELF_ONLY,
    walkthroughPerformer: SELF_ONLY,
    task: SELF_ONLY,
    directory: WHOLE_ORG,
    taskWatcher: WHOLE_ORG,
  };
  get.mockReset();
  get.mockImplementation((url: string, config?: { params?: { purpose?: AssigneePurpose } }) => {
    if (url === '/api/users/assignable') {
      const purpose = config?.params?.purpose;
      return Promise.resolve({ data: purpose ? (roster[purpose] ?? []) : [] });
    }
    // Everything else this dialog pair touches (the org query behind useScheduleTimezone).
    return Promise.resolve({ data: {} });
  });
});

/** Owns the job, may move it and may name its crew - and holds NO `assign User`. */
const OWNS_THE_JOB: AbilityRule[] = [
  { action: 'read', subject: 'Job' },
  { action: 'reschedule', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
];
const repAbility = buildAbility(OWNS_THE_JOB);
/**
 * The same rep plus `assign Task` - a DIFFERENT switch. Holding it must change nothing here.
 * This is the ability that pins the purpose: an assertion that only checks "locked while
 * holding nothing" passes against any purpose at all.
 */
const repWithTaskGrant = buildAbility([...OWNS_THE_JOB, { action: 'assign', subject: 'Task' }]);
/** A dispatcher: holds the grant these pickers actually read. */
const dispatcherAbility = buildAbility([...OWNS_THE_JOB, { action: 'assign', subject: 'User' }]);

/** The roster request the picker made, so its `purpose` can be read off the wire. */
const rosterCalls = () => get.mock.calls.filter((c) => c[0] === '/api/users/assignable');

/** Resolve the roster query before asserting, so no assertion passes on a still-empty list. */
async function rosterSettled() {
  await waitFor(() => expect(rosterCalls().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByRole('combobox', { name: /Crew/ })).toBeInTheDocument());
}

// ── Surface 1: the per-visit Crew field ───────────────────────────────────────────────────

/** A booked trip whose crew the DISPATCHER named. `assignees[].user` is the name source. */
const VISIT: JobVisitRow = {
  id: 'visit-1',
  visit_seq: 1,
  status: 'SCHEDULED',
  scheduled_at: '2026-09-10T15:00:00.000Z',
  scheduled_end: '2026-09-10T17:00:00.000Z',
  created_at: '2026-09-01T00:00:00.000Z',
  is_all_day: false,
  assignees: [
    { user_id: TECH.id, user: { ...TECH } },
    { user_id: SALES.id, user: { ...SALES } },
  ],
};

async function openVisitDialog(ability: AppAbility) {
  renderWithProviders(
    <VisitScheduleDialog
      open
      onOpenChange={() => {}}
      jobId="job-1"
      visit={VISIT}
    />,
    { ability },
  );
  await rosterSettled();
  return screen.getByRole('combobox', { name: /Crew/ });
}

describe('visit Crew field for a viewer who may not name others', () => {
  it('names the crew member the visit already carries instead of rendering "Unknown"', async () => {
    await openVisitDialog(repAbility);

    // Terry is NOT in this viewer's roster and never will be. The only thing that can name
    // them is `visit.assignees[].user`, which this dialog already holds.
    expect(screen.getByText('Terry Tech')).toBeInTheDocument();
    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('states the rule rather than reporting an empty roster', async () => {
    const trigger = await openVisitDialog(repAbility);

    expect(trigger).toBeDisabled();
    // `No more members` is what an exhausted roster says. A viewer who never had one must
    // not be told the team ran out.
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  it('reads the crew grant, not the task grant', async () => {
    const trigger = await openVisitDialog(repWithTaskGrant);

    // Asked the server for the CREW pool...
    expect(rosterCalls()[0]?.[1]?.params?.purpose).toBe('jobCrew');
    // ...and asked the local ability the matching question. `assign Task` is not the switch:
    // under `purpose="task"` this viewer would be judged free to add others, be handed the
    // task pool, and the field would unlock.
    expect(trigger).toBeDisabled();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
  });

  it('gives a grant holder the whole roster in an editable field', async () => {
    roster = { ...roster, jobCrew: WHOLE_ORG };
    const user = userEvent.setup();
    const trigger = await openVisitDialog(dispatcherAbility);

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(await screen.findByText('Add member...')).toBeInTheDocument();

    await user.click(trigger);
    // Everyone not already on the trip is offerable.
    expect(await screen.findByRole('option', { name: /Olive Office/ })).toBeInTheDocument();
  });
});

// ── Surface 2: the job crew assign dialog ─────────────────────────────────────────────────

async function openAssignDialog(ability: AppAbility) {
  renderWithProviders(
    <AssignJobDialog
      open
      onOpenChange={() => {}}
      jobId="job-1"
      mode="assign"
      // Exactly what pages/v2/jobs/JobDetailPage.tsx passes: the ids seed the picker, the
      // people label it.
      currentAssigneeIds={[TECH.id, SALES.id]}
      currentAssignees={[TECH, SALES]}
      isScheduled
      defaultStart="2026-09-10T15:00:00.000Z"
      defaultEnd="2026-09-10T17:00:00.000Z"
      defaultIsAllDay={false}
      defaultsAreCurrentSchedule
    />,
    { ability },
  );
  await rosterSettled();
  return screen.getByRole('combobox', { name: /Crew/ });
}

describe('AssignJobDialog Crew field for a viewer who may not name others', () => {
  it('names the crew member the job already carries instead of rendering "Unknown"', async () => {
    await openAssignDialog(repAbility);

    // From `job.assignees[].user`, forwarded as `currentAssignees`. The scoped roster holds
    // only Sam, so nothing else in this tree knows Terry's name.
    expect(screen.getByText('Terry Tech')).toBeInTheDocument();
    expect(screen.getByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('states the rule rather than reporting an empty roster', async () => {
    const trigger = await openAssignDialog(repAbility);

    expect(trigger).toBeDisabled();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
  });

  it('reads the crew grant, not the task grant', async () => {
    const trigger = await openAssignDialog(repWithTaskGrant);

    expect(rosterCalls()[0]?.[1]?.params?.purpose).toBe('jobCrew');
    expect(trigger).toBeDisabled();
    expect(screen.getByText('You cannot add others')).toBeInTheDocument();
    expect(screen.queryByText('No more members')).not.toBeInTheDocument();
  });

  it('gives a grant holder the whole roster in an editable field', async () => {
    roster = { ...roster, jobCrew: WHOLE_ORG };
    const user = userEvent.setup();
    const trigger = await openAssignDialog(dispatcherAbility);

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(await screen.findByText('Add member...')).toBeInTheDocument();

    await user.click(trigger);
    expect(await screen.findByRole('option', { name: /Olive Office/ })).toBeInTheDocument();
  });
});
