/**
 * job-door-visit-mismatch.test.ts - the job-level milestone doors stamp one trip and describe it.
 *
 * Found 2026-09-12 while building per-visit visit locations (#2059, #2061, #2080, #2082).
 *
 * `POST /api/jobs/:id/en-route` stamps the job's CURRENT visit through
 * `stampCurrentJobVisitMilestone` - `resolveCurrentJobVisit`, whose rule is "a trip that has
 * already BEGUN beats one that has not". The automation it dispatches carried no `visitId` and no
 * merge-field override, so `context.ts`'s job arm resolved the customer's email per ENTITY -
 * `resolveNextJobVisit`, "the earliest still-upcoming live trip".
 *
 * Those two resolvers part company the moment a crew runs past their slot, which is the ordinary
 * case this door exists for. Below: visit 1 booked 09:00-11:30 today, visit 2 next week at the
 * showroom, the tech presses En route at 11:45. `resolveCurrentJobVisit` answers visit 1 (begun),
 * `resolveNextJobVisit` answers visit 2 (visit 1 has elapsed). The stamp landed on visit 1 and the
 * email described visit 2 - and since #2082 put `{{job.visit_location}}` on that same resolution,
 * the customer was told the wrong ADDRESS as well as the wrong time: "we're on our way" to the
 * showroom, for a trip happening at their house.
 *
 * #2082 closed the same class at the five VISIT-scoped dispatch sites, which pass a `visitId`; a
 * structural test in job-visit-location.test.ts holds those. It could not flag these doors,
 * because they pass no `visitId` at all - which is exactly what this file pins.
 *
 * THE TEST RENDERS THE EMAIL, it does not read the dispatch shape. Asserting "the event carries a
 * visitId" would pass against a dispatch that named the visit and still rendered the job's fields
 * - the precise mismatch under test. So the captured event is fed through `loadExecutionBundle`
 * the way `enrollment.ts` feeds it on every step load (entity + persisted event_payload), and the
 * assertion is on the merge context an email body would interpolate.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { loadExecutionBundle } from '../services/automations/context';

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as unknown as ReturnType<typeof vi.fn>;

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as any;
const TECH = TEST_USERS.technician;

/**
 * 11:45 on the day of trip 1, fifteen minutes after its window closed - the crew running late
 * that `resolveCurrentJobVisit`'s docstring is written about.
 *
 * PINNED AT MODULE SCOPE, not in `beforeAll`: both resolvers filter on `new Date()` with no
 * injectable clock, and the fixtures below are absolute literals, so a wall-clock run would drift
 * trip 1 from "begun" to "long past" and trip 2 from "upcoming" to "elapsed" - at which point the
 * two resolvers AGREE and this file goes quietly green against unfixed code.
 */
const PINNED_NOW = new Date('2026-09-05T11:45:00.000Z');
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(PINNED_NOW);
beforeAll(() => { vi.setSystemTime(PINNED_NOW); });
afterAll(() => { vi.useRealTimers(); });

const VISIT_TODAY = 'v0000000-0000-0000-0000-0000000000a1';
const VISIT_NEXT_WEEK = 'v0000000-0000-0000-0000-0000000000a2';
const SHOWROOM_ID = 'aa000000-0000-0000-0000-0000000000a1';

const SERVICE_LOCATION = { address_line1: '123 Main St', city: 'Austin', state: 'TX' };
/** The same three fields joined the way `{{job.address}}` joins them. */
const SERVICE_ADDRESS = '123 Main St, Austin, TX';
const SHOWROOM_RENDERED = 'Showroom, 12 Harbor St, Asheville, NC';

const CREW_MEMBER = {
  id: TECH.id,
  email: TECH.email,
  first_name: 'Dana',
  last_name: 'Reyes',
  phone: '+15550100142',
  phone_ext: null,
};

/** The trip the crew is standing at: started 09:00, window closed 11:30, nobody has actioned it. */
function visitToday(over: Record<string, unknown> = {}) {
  return {
    id: VISIT_TODAY,
    organization_id: ALPHA_ORG_ID,
    job_id: JOB_FIXTURE.id,
    lead_id: null,
    purpose: 'WORK',
    visit_seq: 1,
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T09:00:00.000Z'),
    scheduled_end: new Date('2026-09-05T11:30:00.000Z'),
    is_all_day: false,
    en_route_at: null,
    on_site_at: null,
    started_at: null,
    completed_at: null,
    // At the customer's own address - both location column families null.
    location_id: null,
    location_address_line1: null,
    location_city: null,
    location_state: null,
    location: null,
    created_at: new Date('2026-08-20T10:00:00.000Z'),
    assignees: [{ user_id: TECH.id, user: CREW_MEMBER }],
    ...over,
  };
}

/** Next week's trip, at the organisation's showroom - a place the customer has never been sent. */
function visitNextWeek(over: Record<string, unknown> = {}) {
  return visitToday({
    id: VISIT_NEXT_WEEK,
    visit_seq: 2,
    scheduled_at: new Date('2026-09-12T13:00:00.000Z'),
    scheduled_end: new Date('2026-09-12T15:30:00.000Z'),
    location_id: SHOWROOM_ID,
    location: { name: 'Showroom', address_line1: '12 Harbor St', city: 'Asheville', state: 'NC' },
    created_at: new Date('2026-08-20T10:05:00.000Z'),
    ...over,
  });
}

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'UTC',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: null,
};

/** The job row the controller's two `findUnique`s and `presentJobDetail` all read. */
function jobRow() {
  return {
    ...JOB_FIXTURE,
    status: 'SCHEDULED',
    visits: [visitToday(), visitNextWeek()],
    service_location: { ...JOB_FIXTURE.service_location, ...SERVICE_LOCATION },
    customer: { ...JOB_FIXTURE.customer, first_name: 'Sarah', company_name: null },
  };
}

/** The same job as `loadExecutionBundle`'s job arm reads it, relations included. */
function jobRowForContext() {
  return {
    ...jobRow(),
    job_type: 'Repair',
    sub_status: null,
    dispatcher: null,
    salesperson: null,
    estimate: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(PINNED_NOW);
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((args: { where: { role: string } }) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findUnique.mockResolvedValue(jobRow());
  mockPrisma.job.findFirst.mockResolvedValue(jobRowForContext());
  mockPrisma.job.findMany.mockResolvedValue([]);
  // What `stampCurrentJobVisitMilestone` resolves its current trip from: the job's LIVE visits.
  mockPrisma.visit.findMany.mockResolvedValue([visitToday(), visitNextWeek()]);
  mockPrisma.visit.findFirst.mockImplementation((args: { where: { id?: string } }) =>
    Promise.resolve(
      [visitToday(), visitNextWeek()].find((v) => v.id === args.where?.id) ?? null,
    ),
  );
  mockPrisma.visit.update.mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve([visitToday(), visitNextWeek()].find((v) => v.id === args.where.id)),
  );
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
});

/** Every `prisma.visit.update` this request made - the milestone stamp is one of them. */
function stampedVisitIds(): string[] {
  return mockPrisma.visit.update.mock.calls
    .filter((c: [{ data?: Record<string, unknown> }]) => c[0]?.data?.en_route_at !== undefined)
    .map((c: [{ where: { id: string } }]) => c[0].where.id);
}

function dispatchedOfType(type: string) {
  return mockDispatch.mock.calls.filter((c: any[]) => c[0].type === type).map((c: any[]) => c[0]);
}

/**
 * The merge context an email body would interpolate for this event, resolved the way
 * `enrollment.ts` resolves it on every step load: the live entity, with the enrollment's persisted
 * `event_payload` merged over it.
 */
async function renderedFor(event: any) {
  const loaded = await loadExecutionBundle({
    entityType: event.entity.type,
    entityId: event.entity.id,
    entityLabel: event.entity.label,
    organizationId: event.organizationId,
    dedupeKey: 'irrelevant-to-rendering',
    eventPayload: event.eventPayload ?? null,
  });
  return loaded!.bundle.mergeCtx;
}

describe('POST /api/jobs/:id/en-route - the trip it stamps is the trip its email describes', () => {
  it('does not tell the customer next week’s date and the showroom’s address', async () => {
    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);

    // 1 - WHICH TRIP WAS STAMPED. `resolveCurrentJobVisit`: today's trip has begun, so it wins.
    expect(stampedVisitIds()).toEqual([VISIT_TODAY]);

    // 2 - WHAT THE CUSTOMER IS TOLD. The same trip, or the crew is announced to the wrong place.
    const [event] = dispatchedOfType('JOB_EN_ROUTE');
    expect(event).toBeDefined();
    const rendered = await renderedFor(event);
    expect(rendered['job.visit_location']).toBe(SERVICE_ADDRESS);
    expect(rendered['job.scheduled_date']).toBe('Sat, Sep 5');
    expect(rendered['job.scheduled_time']).toBe('9:00 AM');
  });

  // The showroom is the wrong place ONLY because the crew is somewhere else. This pins that the
  // fixture is actually the disagreement it claims to be: swap which trip has begun and the
  // door must follow, rather than having been hard-wired to "the earliest".
  it('follows the crew to the showroom when the showroom is the trip they are on', async () => {
    const atShowroomNow = visitNextWeek({
      scheduled_at: new Date('2026-09-05T09:00:00.000Z'),
      scheduled_end: new Date('2026-09-05T11:30:00.000Z'),
    });
    const houseNextWeek = visitToday({
      scheduled_at: new Date('2026-09-12T13:00:00.000Z'),
      scheduled_end: new Date('2026-09-12T15:30:00.000Z'),
    });
    mockPrisma.visit.findMany.mockResolvedValue([atShowroomNow, houseNextWeek]);
    mockPrisma.visit.findFirst.mockImplementation((args: { where: { id?: string } }) =>
      Promise.resolve([atShowroomNow, houseNextWeek].find((v) => v.id === args.where?.id) ?? null),
    );
    mockPrisma.visit.update.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve([atShowroomNow, houseNextWeek].find((v) => v.id === args.where.id)),
    );
    mockPrisma.job.findFirst.mockResolvedValue({
      ...jobRowForContext(),
      visits: [atShowroomNow, houseNextWeek],
    });

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/en-route`)
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(200);

    expect(stampedVisitIds()).toEqual([VISIT_NEXT_WEEK]);
    const rendered = await renderedFor(dispatchedOfType('JOB_EN_ROUTE')[0]);
    expect(rendered['job.visit_location']).toBe(SHOWROOM_RENDERED);
    expect(rendered['job.scheduled_date']).toBe('Sat, Sep 5');
  });
});

// ── the enumeration, so the NEXT job-level door cannot repeat this ───────────
//
// `job-visit-location.test.ts` holds the FORWARD direction - a dispatch that names a visit must
// state that visit's merge fields. It cannot hold this one, because the defect above was a
// dispatch naming NO visit: it passed that test by being invisible to it.
//
// This is the inverse. A handler that stamps one trip and then dispatches an automation about the
// job is describing whichever trip `context.ts` picks, which is a DIFFERENT resolution
// (`resolveNextJobVisit` vs `resolveCurrentJobVisit`) and disagrees whenever a crew runs late.
//
// It is also what makes `/start` and `/arrive` safe to leave alone. Both stamp a trip and describe
// nothing today - there is no JOB_STARTED or JOB_ON_SITE value in AutomationTriggerType at all -
// so they hold vacuously. The day either grows a dispatch without naming the trip it stamped, this
// goes red.

describe('a door that stamps one visit does not dispatch about another', () => {
  /** Every backend source file (tests excluded). */
  function backendSources(): string[] {
    const root = join(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
      }
    };
    walk(root);
    return found;
  }

  /**
   * Walk a file in source order, tracking which TOP-LEVEL declaration each line belongs to.
   *
   * A declaration boundary is a line starting at COLUMN ZERO, which is what this codebase's
   * formatting makes a top-level one. Deliberately not brace-balancing: a handler body here holds
   * template literals, regexes and prose comments carrying `{{job.visit_location}}`, and a scanner
   * that miscounts one of them silently reports success - the failure mode a source-reading test
   * is actually prone to. Attributing lines to the nearest column-zero declaration needs no such
   * bookkeeping and is wrong only in a file nobody here formats.
   */
  function stampingHandlers(source: string): { name: string; dispatches: string[] }[] {
    const out: { name: string; dispatches: string[] }[] = [];
    let current: { name: string; stamps: boolean; dispatches: string[] } | null = null;
    const flush = () => {
      if (current?.stamps) out.push({ name: current.name, dispatches: current.dispatches });
    };
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const decl = /^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/.exec(line);
      if (decl) {
        flush();
        current = { name: decl[1]!, stamps: false, dispatches: [] };
        continue;
      }
      if (!current) continue;
      if (line.includes('stampCurrentJobVisitMilestone(') && !line.trimStart().startsWith('*')) {
        current.stamps = true;
      }
      if (line.includes('dispatchAutomationEvent({')) {
        // The call's arguments run to its closing brace; the next 40 lines cover every dispatch
        // in this tree with room to spare, and over-reading only makes the visitId check LOOSER,
        // never falsely red.
        current.dispatches.push(lines.slice(i, i + 40).join('\n'));
      }
    }
    flush();
    return out;
  }

  it('every handler that stamps the job’s current visit names it in what it dispatches', () => {
    const stamping: { where: string; name: string; dispatches: string[] }[] = [];
    for (const file of backendSources()) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('stampCurrentJobVisitMilestone(')) continue;
      for (const handler of stampingHandlers(source)) {
        stamping.push({ where: file.slice(file.indexOf('/src/') + 1), ...handler });
      }
    }

    // Pinned by NAME, not by count: these three are the whole of the job-level milestone surface
    // (POST /:id/start, /:id/en-route and /:id/arrive - the doors JobLifecycleBar, POST /:id/status
    // and the bulk endpoints all press), and a scan that quietly stopped finding one of them would
    // otherwise report success - the failure a source-reading test is most prone to.
    //
    // walkthrough.service.ts IS scanned and contributes nothing, which is correct rather than a
    // miss: `stampCurrentJobVisitMilestone` is the WRITER, and the only mention of it there is its
    // own declaration line - a boundary, not a call from inside a handler.
    expect(stamping.map((s) => s.name).sort()).toEqual(['arrive', 'enRoute', 'start']);

    const unscoped = stamping
      .filter((s) => s.dispatches.some((d) => !/\bvisitId\s*:/.test(d)))
      .map((s) => `${s.where} ${s.name}`);
    expect(unscoped).toEqual([]);
  });
});
