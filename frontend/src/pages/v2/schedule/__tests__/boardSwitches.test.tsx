/**
 * Roles & Permissions, PRD 4, slice S04.11 - the routed Schedule page's controls follow switches.
 *
 * Lanes for other people, a read-only board, plan mode, the two unscheduled buckets and the job-level
 * complete used to be chosen by the signed-in person's ROLE NAME. They follow six switches now, so each
 * person here is a custom role built from switch values, never a built-in role name: the abilities are
 * compiled from the backend switch catalog (the source of truth for what a switch grants and for each
 * preset's value), and the signed-in user carries no built-in role at all.
 *
 * The page is the routed one (`pages/v2/schedule/SchedulePage`). What is asserted is what a person sees
 * and what the board sends to the server, never the shape of a grant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule, type AppAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER, JOB_ID, WALKTHROUGH_ID } from '@/components/schedule/dragChannels';
import SchedulePage from '../SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

// ─── Abilities, compiled from the switch catalog ───────────────────────────────────────────────────────

type BuiltInRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
const PRESET_ORDER: BuiltInRole[] = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];

interface CatalogSwitch {
  key: string;
  grants: Array<{ action: string; subject: string }>;
  presets: Record<BuiltInRole, boolean>;
}

/**
 * Every toggle switch in the backend catalog: the ability-layer pairs it grants and each built-in role's preset
 * value. Read from the catalog file itself (the source of truth), the way the estimate-document twins test reads
 * its backend twin, because the catalog module is not importable into the browser build.
 */
const CATALOG: CatalogSwitch[] = (() => {
  const source = readFileSync(
    join(__dirname, '../../../../../../backend/src/lib/permissions/switches/catalog.ts'),
    'utf8',
  );
  const out: CatalogSwitch[] = [];
  for (const block of source.split(/\n {2}entry\(\{/).slice(1)) {
    const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
    const presetArgs = /presets: presets\(([^)]*)\)/.exec(block)?.[1];
    if (!key || !presetArgs) continue;
    const values = presetArgs.split(',').map((v) => v.trim());
    if (values.some((v) => v !== 'true' && v !== 'false')) continue; // a choice or list switch, not a toggle
    const grantsText = /grants: \[([\s\S]*?)\],\n\s+(?:serverChecks|pending|presets)/.exec(block)?.[1] ?? '';
    const grants = [...grantsText.matchAll(/action: '(\w+)', subject: '(\w+)'/g)].map((m) => ({
      action: m[1]!,
      subject: m[2]!,
    }));
    out.push({
      key,
      grants,
      presets: Object.fromEntries(PRESET_ORDER.map((r, i) => [r, values[i] === 'true'])) as Record<BuiltInRole, boolean>,
    });
  }
  return out;
})();

/** The ability a person holds with exactly these switches on (class-level: the scope conditions are the server's). */
function abilityFromSwitches(on: ReadonlySet<string>): AppAbility {
  const rules: AbilityRule[] = [];
  for (const entry of CATALOG) {
    if (!on.has(entry.key)) continue;
    for (const g of entry.grants) rules.push({ action: g.action, subject: g.subject } as AbilityRule);
  }
  return buildAbility(rules);
}

/** The switches a built-in role's preset turns on - the starting point of a custom role "copied from" it. */
function presetOn(role: BuiltInRole): Set<string> {
  return new Set(CATALOG.filter((e) => e.presets[role]).map((e) => e.key));
}

/** Everything the board needs to render at all, and nothing that decides one of the six board controls. */
const VIEW_ONLY = ['view_jobs', 'view_leads', 'view_events'];

/** A custom role: the base switches plus exactly these. */
function customRole(...on: string[]): AppAbility {
  return abilityFromSwitches(new Set([...VIEW_ONLY, ...on]));
}

/** A custom role copied from a preset, with a few switches flipped. */
function copiedFrom(role: BuiltInRole, flip: { on?: string[]; off?: string[] } = {}): AppAbility {
  const keys = presetOn(role);
  for (const k of flip.on ?? []) keys.add(k);
  for (const k of flip.off ?? []) keys.delete(k);
  return abilityFromSwitches(keys);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}
const dayKey = (offset: number) => format(addDays(WEEK_START, offset), 'yyyy-MM-dd');

const ALICE = { id: 'm-alice', first_name: 'Alice', last_name: 'Ng', phone: null };
const BOB = { id: 'm-bob', first_name: 'Bob', last_name: 'Ode', phone: null };
const CARA = { id: 'm-cara', first_name: 'Cara', last_name: 'Diaz', phone: null };
const STAFF = [ALICE, BOB, CARA];
const onVisit = (...people: (typeof ALICE)[]) => people.map((u) => ({ user_id: u.id, user: u }));
const CUSTOMER = { first_name: 'Pat', last_name: 'Sample', company_name: 'Sample Co', email: 'pat@example.test' };

/** A scheduled job on Bob's lane. */
const SCHEDULED_JOB = {
  id: 'job-1',
  job_number: 'J00044',
  status: 'SCHEDULED',
  scope_notes: 'Gate operator swap',
  customer: CUSTOMER,
  assignees: [{ user: BOB }],
  tags: [],
  scheduled_start: dayAt(3),
  scheduled_end: dayAt(3, 16),
  visits: [
    { id: 'v2', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(3), scheduled_end: dayAt(3, 16), is_all_day: false, assignees: onVisit(BOB) },
  ],
};

/** A job waiting to be scheduled: it lives in the unscheduled jobs bucket. */
const BUCKET_JOB = {
  id: 'job-bucket-1',
  job_number: 'J00043',
  title: 'Rooftop Unit Swap',
  status: 'UNSCHEDULED',
  customer: CUSTOMER,
  scheduled_start: null,
  scheduled_end: null,
  assignees: [],
  visits: [],
};

/** A scheduled walkthrough on Bob's lane. */
const WALKTHROUGH_LEAD = {
  id: 'lead-wt', lead_number: 'L00501', status: 'WALKTHROUGH_SCHEDULED', customer: CUSTOMER, tags: [],
  walkthrough_scheduled_at: dayAt(2), walkthrough_duration_minutes: 60, walkthrough_to_be_scheduled: false,
  walkthrough_performers: onVisit(BOB),
  walkthrough_visits: [
    { id: 'wt-v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(2), scheduled_end: dayAt(2, 15), is_all_day: false, assignees: onVisit(BOB) },
  ],
};

/** A walkthrough with no time yet: it lives in the unscheduled walkthroughs bucket. */
const BUCKET_LEAD = {
  id: 'lead-bucket', lead_number: 'L00502', status: 'NEW', customer: CUSTOMER, tags: [],
  walkthrough_scheduled_at: null, walkthrough_duration_minutes: null, walkthrough_to_be_scheduled: true,
  walkthrough_performers: [],
  walkthrough_visits: [],
};

function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as Record<string, unknown>;
    if (url === '/api/jobs') {
      const status = params.status;
      const wantsBucket = status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [BUCKET_JOB] : [SCHEDULED_JOB] } });
    }
    if (url === '/api/leads') {
      const wantsBucket = params.walkthrough_status === 'needs_scheduling';
      return Promise.resolve({ data: { leads: wantsBucket ? [BUCKET_LEAD] : [WALKTHROUGH_LEAD] } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') {
      return Promise.resolve({ data: { users: STAFF.map((u) => ({ ...u, is_active: true, role: 'TECHNICIAN' })) } });
    }
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
}

/** Renders the board as a person who carries NO built-in role name, holding `ability`. */
async function mountBoard(ability: AppAbility) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: 'u-viewer', email: 'viewer@test.com', first_name: 'Vic', last_name: 'Viewer', role: 'CUSTOM_ROLE' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
  mockBoard();
  const view = renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability, initialEntries: ['/schedule'] },
  );
  await screen.findAllByText(/J00044/);
  await waitFor(() => expect(view.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return view;
}

/** Clicks a card on the standard board: its peek card opens, and "Open" in it opens the editor. */
async function openEditorFor(label: RegExp): Promise<HTMLElement> {
  fireEvent.click(screen.getAllByText(label)[0]!);
  const peek = await screen.findByRole('dialog');
  fireEvent.click(within(peek).getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(within(document.body).queryByRole('button', { name: 'Open' })).toBeNull());
  return screen.findByRole('dialog');
}

/** Long enough for a lazily-loaded dialog or a request to have shown up, so a negative assertion can fail. */
const settle = () => new Promise((r) => setTimeout(r, 400));

const buckets = () => screen.getByTestId('unassigned-buckets');
const hasBucket = (label: 'Jobs' | 'Walkthroughs') =>
  within(buckets()).queryByRole('button', { name: new RegExp(`^${label}`) }) !== null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

// A catalog read that quietly found nothing would make every ability below empty and the tests above meaningless.
describe('the fixture\'s reading of the switch catalog', () => {
  it('finds the nine switches the board follows, each with the grant it compiles into', () => {
    const grantOf = (key: string) => CATALOG.find((e) => e.key === key)?.grants.map((g) => `${g.action} ${g.subject}`);
    expect(grantOf('assign_work_to_others')).toEqual(['assign User']);
    expect(grantOf('schedule_visits')).toEqual(['reschedule Job']);
    expect(grantOf('assign_people_to_jobs')).toEqual(['assign Job', 'unassign Job']);
    expect(grantOf('book_walkthroughs')).toEqual(['schedule_walkthrough Lead']);
    expect(grantOf('edit_events')).toEqual(['update CalendarEntry']);
    expect(grantOf('complete_jobs')).toEqual(['complete Job']);
  });

  it('knows each preset: the Technician moves nothing on the board, the Dispatcher everything', () => {
    for (const key of ['assign_work_to_others', 'schedule_visits', 'assign_people_to_jobs', 'book_walkthroughs', 'edit_events', 'complete_jobs']) {
      expect(presetOn('TECHNICIAN').has(key), key).toBe(false);
      expect(presetOn('DISPATCHER').has(key), key).toBe(true);
    }
  });
});

// ─── The built-in presets' values ─────────────────────────────────────────────────────────────────────

describe('the board with the Technician preset\'s values', () => {
  it('has one lane, is read-only, shows no buckets and no job-level complete', async () => {
    await mountBoard(copiedFrom('TECHNICIAN'));

    // One lane: no Standard / Member switch.
    expect(screen.queryByRole('button', { name: 'Member' })).toBeNull();
    // Read-only: nothing to create, no plan mode.
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan Mode' })).toBeNull();
    // No buckets.
    expect(hasBucket('Jobs')).toBe(false);
    expect(hasBucket('Walkthroughs')).toBe(false);
    expect(within(buckets()).queryByText('J00043')).toBeNull();
    expect(within(buckets()).queryByText('L00502')).toBeNull();
    // No job-level complete on the visit card.
    await openEditorFor(/J00044/);
    expect(screen.queryByRole('button', { name: /Complete job/ })).toBeNull();
  });
});

describe('the board with the Sales preset\'s values', () => {
  it('has one lane, moves walkthroughs, shows the walkthroughs bucket only, and has no job-level complete', async () => {
    await mountBoard(copiedFrom('SALES'));

    expect(screen.queryByRole('button', { name: 'Member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan Mode' })).toBeNull();
    // Editable: the creation control is there.
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    // Buckets: walkthroughs yes, jobs no.
    expect(hasBucket('Walkthroughs')).toBe(true);
    expect(within(buckets()).getByText('L00502')).toBeInTheDocument();
    expect(hasBucket('Jobs')).toBe(false);
    expect(within(buckets()).queryByText('J00043')).toBeNull();
    // A job's visit card: no job-level complete.
    await openEditorFor(/J00044/);
    expect(screen.queryByRole('button', { name: /Complete job/ })).toBeNull();
  });

  it('can open a walkthrough\'s editor to change it, but a job\'s editor is read-only', async () => {
    await mountBoard(copiedFrom('SALES'));

    const walkthroughEditor = await openEditorFor(/L00501/);
    // Editable: it offers to take the walkthrough off the board.
    expect(within(walkthroughEditor).getByRole('button', { name: /Move to Unscheduled/ })).toBeInTheDocument();
    fireEvent.keyDown(walkthroughEditor, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const jobEditor = await openEditorFor(/J00044/);
    expect(within(jobEditor).getAllByText(/Bob Ode/).length).toBeGreaterThan(0);
    expect(within(jobEditor).queryByRole('button', { name: /Move to Unscheduled/ })).toBeNull();
  });
});

describe.each<BuiltInRole>(['ADMIN', 'DISPATCHER'])('the board with the %s preset\'s values', (role) => {
  it('is unchanged from today: member lanes, create, plan mode, both buckets, job-level complete', async () => {
    await mountBoard(copiedFrom(role));

    expect(screen.getByRole('button', { name: 'Member' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan Mode' })).toBeInTheDocument();
    expect(hasBucket('Jobs')).toBe(true);
    expect(hasBucket('Walkthroughs')).toBe(true);
    expect(within(buckets()).getByText('J00043')).toBeInTheDocument();
    expect(within(buckets()).getByText('L00502')).toBeInTheDocument();
    await openEditorFor(/J00044/);
    expect(screen.getByRole('button', { name: /Complete job/ })).toBeInTheDocument();
  });
});

// ─── One switch at a time, on custom roles ────────────────────────────────────────────────────────────

describe('a custom role: each control follows its own switch', () => {
  it('Book walkthroughs on with Assign work to other people off keeps the own lane and the walkthrough bucket', async () => {
    await mountBoard(customRole('book_walkthroughs'));

    expect(screen.queryByRole('button', { name: 'Member' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    expect(hasBucket('Walkthroughs')).toBe(true);
    expect(hasBucket('Jobs')).toBe(false);
  });

  it('Assign work to other people gives the lanes for other people, and nothing else by itself', async () => {
    await mountBoard(customRole('assign_work_to_others'));

    expect(screen.getByRole('button', { name: 'Member' })).toBeInTheDocument();
    // None of the four moving switches: still a read-only board.
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(hasBucket('Jobs')).toBe(false);
    expect(hasBucket('Walkthroughs')).toBe(false);
  });

  it('Schedule visits gives the unscheduled jobs bucket and an editable board, but no walkthrough bucket', async () => {
    await mountBoard(customRole('schedule_visits'));

    expect(hasBucket('Jobs')).toBe(true);
    expect(within(buckets()).getByText('J00043')).toBeInTheDocument();
    expect(hasBucket('Walkthroughs')).toBe(false);
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('Edit events alone makes the board editable, with no buckets and nothing to create', async () => {
    await mountBoard(customRole('edit_events'));

    // Editing an entry is not creating one, and the other two creation doors are closed: no Create button.
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(hasBucket('Jobs')).toBe(false);
    expect(hasBucket('Walkthroughs')).toBe(false);
  });

  it('plan mode needs Schedule visits AND Assign work to other people', async () => {
    const onlyVisits = await mountBoard(customRole('schedule_visits'));
    expect(screen.queryByRole('button', { name: 'Plan Mode' })).toBeNull();
    onlyVisits.unmount();

    const onlyAssign = await mountBoard(customRole('assign_work_to_others', 'edit_events'));
    expect(screen.queryByRole('button', { name: 'Plan Mode' })).toBeNull();
    onlyAssign.unmount();

    await mountBoard(customRole('schedule_visits', 'assign_work_to_others'));
    expect(screen.getByRole('button', { name: 'Plan Mode' })).toBeInTheDocument();
  });

  it('the job-level complete on a visit card needs Complete jobs', async () => {
    const without = await mountBoard(customRole('schedule_visits', 'assign_work_to_others'));
    await openEditorFor(/J00044/);
    expect(screen.queryByRole('button', { name: /Complete job/ })).toBeNull();
    without.unmount();

    await mountBoard(customRole('schedule_visits', 'assign_work_to_others', 'complete_jobs'));
    await openEditorFor(/J00044/);
    expect(screen.getByRole('button', { name: /Complete job/ })).toBeInTheDocument();
  });
});

// ─── The Create popover offers only the doors this person can use ─────────────────────────────────────

/** Opens the Create popover and returns the names of the tabs it offers. */
async function createTabs(): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  // The popover is lazy-loaded on first open.
  return (await screen.findAllByRole('tab')).map((t) => t.textContent ?? '');
}

describe('the Create popover offers only the doors this person can use', () => {
  it('the Sales preset is not offered job scheduling', async () => {
    await mountBoard(copiedFrom('SALES'));
    const tabs = await createTabs();
    expect(tabs).not.toContain('Job');
    expect(tabs).toContain('Walkthrough');
  });

  it('Schedule visits alone offers the Job door and neither of the others', async () => {
    await mountBoard(customRole('schedule_visits'));
    expect(await createTabs()).toEqual(['Job']);
  });

  it('Book walkthroughs alone offers the Walkthrough door, and it is the one open', async () => {
    await mountBoard(customRole('book_walkthroughs'));
    expect(await createTabs()).toEqual(['Walkthrough']);
    expect(screen.getByRole('tab', { name: 'Walkthrough' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Create events alone offers the Event door, and it is the one open', async () => {
    await mountBoard(customRole('create_events', 'edit_events'));
    expect(await createTabs()).toEqual(['Event']);
    expect(screen.getByRole('tab', { name: 'Event' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a read-only board and an Edit-events-only board have no Create button at all', async () => {
    const readOnly = await mountBoard(customRole('assign_work_to_others'));
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    readOnly.unmount();

    await mountBoard(customRole('edit_events'));
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it.each<BuiltInRole>(['ADMIN', 'DISPATCHER'])('the %s preset still gets all three doors', async (role) => {
    await mountBoard(copiedFrom(role));
    expect(await createTabs()).toEqual(['Job', 'Walkthrough', 'Event']);
  });
});

// ─── Dragging in the lanes ────────────────────────────────────────────────────────────────────────────

function laneDrop(boardId: string, fromMember: string, toMember: string, offset: number) {
  const cell = screen.getByTestId(`week-cell-${toMember}-${dayKey(offset)}`);
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? fromMember : k === GRID_EVENT_TYPE ? 'job' : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

async function openMemberView() {
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
  await screen.findByTestId(`week-cell-${BOB.id}-${dayKey(3)}`);
}

describe('dragging a visit in the lanes', () => {
  it('between lanes needs Assign people to jobs and Assign work to other people', async () => {
    const crewed = await mountBoard(customRole('assign_work_to_others', 'assign_people_to_jobs'));
    await openMemberView();
    laneDrop('jv-v2', BOB.id, CARA.id, 3);
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/visits/v2/assignees', { assignee_ids: [CARA.id] }),
    );
    crewed.unmount();

    vi.clearAllMocks();
    // Schedule visits and Assign work, but not Assign people to jobs: the same drag does nothing.
    await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    await openMemberView();
    laneDrop('jv-v2', BOB.id, CARA.id, 3);
    await settle();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('to a new time in the same lane needs Schedule visits', async () => {
    const cannotMove = await mountBoard(customRole('assign_work_to_others', 'assign_people_to_jobs'));
    await openMemberView();
    laneDrop('jv-v2', BOB.id, BOB.id, 4);
    await settle();
    expect(screen.queryByRole('button', { name: /Confirm reschedule/i })).toBeNull();
    cannotMove.unmount();

    await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    await openMemberView();
    laneDrop('jv-v2', BOB.id, BOB.id, 4);
    expect(await screen.findByRole('button', { name: /Confirm reschedule/i })).toBeInTheDocument();
  });
});

/** A card dragged out of a bucket and dropped on Bob's lane. */
function bucketDrop(channel: typeof JOB_ID | typeof WALKTHROUGH_ID, id: string, offset: number) {
  const cell = screen.getByTestId(`week-cell-${BOB.id}-${dayKey(offset)}`);
  fireEvent.drop(cell, {
    dataTransfer: { getData: (k: string) => (k === channel ? id : ''), types: [channel] },
  });
}

describe('dropping an unscheduled card on a lane', () => {
  it('a job needs Schedule visits', async () => {
    const without = await mountBoard(customRole('assign_work_to_others', 'book_walkthroughs'));
    await openMemberView();
    bucketDrop(JOB_ID, 'job-bucket-1', 4);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    without.unmount();

    await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    await openMemberView();
    bucketDrop(JOB_ID, 'job-bucket-1', 4);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a walkthrough needs Book walkthroughs', async () => {
    const without = await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    await openMemberView();
    bucketDrop(WALKTHROUGH_ID, 'lead-bucket', 4);
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    without.unmount();

    await mountBoard(customRole('assign_work_to_others', 'book_walkthroughs'));
    await openMemberView();
    bucketDrop(WALKTHROUGH_ID, 'lead-bucket', 4);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

// ─── The event editor, switch by switch ───────────────────────────────────────────────────────────────

describe('the visit editor follows the switch behind each control', () => {
  it('without Schedule visits it offers no time fields, no Save time and no Move to Unscheduled', async () => {
    // Assign people to jobs + Assign work to other people, but not Schedule visits.
    await mountBoard(customRole('assign_work_to_others', 'assign_people_to_jobs'));
    const editor = await openEditorFor(/J00044/);

    expect(within(editor).queryByLabelText('Start time')).toBeNull();
    expect(within(editor).queryByLabelText('Start date')).toBeNull();
    expect(within(editor).queryByRole('button', { name: 'Save time' })).toBeNull();
    expect(within(editor).queryByRole('button', { name: /Move to Unscheduled/ })).toBeNull();
    // The crew is still theirs to change.
    expect(within(editor).getAllByText(/Bob Ode/).length).toBeGreaterThan(0);
    expect(within(editor).getByRole('combobox')).toBeInTheDocument();
  });

  it('with Schedule visits it offers the time fields and Move to Unscheduled', async () => {
    await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    const editor = await openEditorFor(/J00044/);

    expect(within(editor).getByLabelText('Start time')).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: /Move to Unscheduled/ })).toBeInTheDocument();
  });

  it('without Assign people to jobs the crew is plain text and there is no Save crew', async () => {
    // Schedule visits + Assign work to other people, but not Assign people to jobs.
    await mountBoard(customRole('assign_work_to_others', 'schedule_visits'));
    const editor = await openEditorFor(/J00044/);

    expect(within(editor).getAllByText(/Bob Ode/).length).toBeGreaterThan(0);
    expect(within(editor).queryByRole('combobox')).toBeNull();
    expect(within(editor).queryByRole('button', { name: 'Save crew' })).toBeNull();
  });
});
