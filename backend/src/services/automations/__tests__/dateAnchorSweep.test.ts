import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { anchorWindow, AFTER_GRACE_MS, candidatesForAnchor } from '../dateAnchorSweep';

const mockPrisma = prisma as any;

const now = new Date('2026-07-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('anchorWindow', () => {
  it('before: selects anchors from now through now+offset', () => {
    const w = anchorWindow('before', DAY, now);
    expect(w.gte.toISOString()).toBe(now.toISOString());
    expect(w.lte.toISOString()).toBe(new Date(now.getTime() + DAY).toISOString());
  });

  it('before: a still-upcoming anchor inside the lead time IS in the window (late but useful)', () => {
    const w = anchorWindow('before', DAY, now);
    const inTwelveHours = new Date(now.getTime() + DAY / 2);
    expect(inTwelveHours >= w.gte && inTwelveHours <= w.lte).toBe(true);
  });

  it('before: an already-past anchor is NOT in the window (no stale reminder)', () => {
    const w = anchorWindow('before', DAY, now);
    const yesterday = new Date(now.getTime() - DAY);
    expect(yesterday >= w.gte).toBe(false);
  });

  it('after: selects anchors whose fire moment (anchor+offset) has just arrived', () => {
    const w = anchorWindow('after', DAY, now);
    expect(w.lte.toISOString()).toBe(new Date(now.getTime() - DAY).toISOString());
    expect(w.gte.toISOString()).toBe(new Date(now.getTime() - DAY - AFTER_GRACE_MS).toISOString());
  });

  it('after: bounded below so enabling a workflow never blasts history', () => {
    const w = anchorWindow('after', DAY, now);
    const ancient = new Date(now.getTime() - 365 * DAY);
    expect(ancient >= w.gte).toBe(false);
  });
});

describe('candidatesForAnchor', () => {
  const ORG = 'org-1';
  const WINDOW = { gte: now, lte: new Date(now.getTime() + DAY) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.visit.findMany.mockResolvedValue([]);
    mockPrisma.invoice.findMany.mockResolvedValue([]);
    mockPrisma.estimate.findMany.mockResolvedValue([]);
  });

  // S8 §2 (A4, RATIFIED): repointed onto `visits` and made PER-VISIT — the same shape as the
  // LEAD arm just below. A single-visit job still yields exactly one candidate, so this proves
  // the query shape without yet proving the multi-visit fan-out (see the dedicated test below).
  it('job.scheduled_start: selects LIVE visits by scheduled_at and keys the occurrence on it (entity = the JOB)', async () => {
    const start = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-1', scheduled_at: start, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      organization_id: ORG,
      job_id: { not: null },
      status: { in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] },
      scheduled_at: WINDOW,
    });
    expect(out).toEqual([
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: start.toISOString(), visitId: 'visit-1' },
    ]);
  });

  // ── Per-visit automation enrollment (spec 2026-09-14, D8 / criteria 3-5) ─────────────────────
  //
  // The whole data change is `id: true` on a select this query already makes. Until it shipped the
  // sweep emitted one candidate PER VISIT and then threw the visit row away, naming only the
  // parent - so the enrollment had no way to record which trip it was about and the send rendered
  // whichever visit the per-ENTITY resolver happened to pick (the earliest upcoming one).
  it('job.scheduled_start: asks Postgres for the visit id, so a candidate can name its own trip', async () => {
    await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);
    expect(mockPrisma.visit.findMany.mock.calls[0][0].select).toMatchObject({ id: true });
  });

  // TWO visits, not one. With a single visit "the triggering trip" and "the parent's only trip"
  // are the same row, so an assertion on either passes whether the id is carried or not - the
  // exact flaw that made the pre-existing parity sweep look like coverage for this. Distinct ids
  // are the only thing that can tell the two apart.
  it('job.scheduled_start: two trips on one job carry their OWN visit ids, and the occurrence stays a bare date', async () => {
    const tuesday = new Date('2026-07-19T09:00:00.000Z');
    const thursday = new Date('2026-07-21T14:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-tue', scheduled_at: tuesday, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-thu', scheduled_at: thursday, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    expect(out.map((c) => c.visitId)).toEqual(['visit-tue', 'visit-thu']);
    // D5: the ENTITY stays the parent job on both - the anchored WAIT's dedupe scope, the
    // dashboard's entity index and every persisted ledger row hang off it.
    expect(out.map((c) => c.entityId)).toEqual(['job-1', 'job-1']);
    // D3: the visit id never enters the occurrence key, which stays a bare ISO date. stopIf.ts and
    // terminalStale.ts compare that key against someDate.toISOString() and, on a mismatch, return
    // a stale REASON rather than erroring - so widening it kills every anchored wait in silence.
    expect(out.map((c) => c.occurrence)).toEqual([tuesday.toISOString(), thursday.toISOString()]);
    for (const c of out) expect(c.occurrence).not.toContain('visit-');
  });

  // Contract A4's headline behaviour change: a rule anchored on job.scheduled_start now fires
  // once PER VISIT rather than once per job (spec user story 43 — "fires on all three
  // mornings"). Three distinct visit times on the SAME job must yield three candidates sharing
  // one entityId but carrying three distinct occurrence strings.
  it('job.scheduled_start: a 3-visit job yields THREE candidates with distinct occurrence strings (1 fire becomes 3)', async () => {
    const v1 = new Date('2026-07-19T09:00:00.000Z');
    const v2 = new Date('2026-07-20T09:00:00.000Z');
    const v3 = new Date('2026-07-21T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-1', scheduled_at: v1, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-2', scheduled_at: v2, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-3', scheduled_at: v3, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);

    expect(out).toEqual([
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v1.toISOString(), visitId: 'visit-1' },
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v2.toISOString(), visitId: 'visit-2' },
      { entityType: 'job', entityId: 'job-1', entityLabel: 'J00042', occurrence: v3.toISOString(), visitId: 'visit-3' },
    ]);
    // Every candidate shares the parent job id but carries its OWN occurrence, so
    // buildDedupeKey (JOB_DATE_ANCHORED is occurrence-scoped) mints three distinct keys —
    // the mechanism that lets all three actually enroll instead of colliding.
    const occurrences = new Set(out.map((c) => c.occurrence));
    expect(occurrences.size).toBe(3);
  });

  // The where-clause's LIVE_VISIT_STATUSES filter is what makes this true against a real
  // Postgres — CANCELLED (and COMPLETED) are not in the set, so such rows never reach the
  // window comparison in the first place.
  it('job.scheduled_start: the status filter excludes CANCELLED — a cancelled visit is never a candidate', async () => {
    await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);
    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where.status.in).not.toContain('CANCELLED');
    expect(q.where.status.in).not.toContain('COMPLETED');
  });

  it('job.scheduled_start: a job with every visit cancelled yields no candidates', async () => {
    // A real DB query with the LIVE_VISIT_STATUSES filter above would simply return nothing for
    // an all-cancelled job — modelled here as the mocked resolver finding no rows.
    mockPrisma.visit.findMany.mockResolvedValueOnce([]);
    const out = await candidatesForAnchor('job.scheduled_start', ORG, WINDOW);
    expect(out).toEqual([]);
  });

  // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough table directly
  // (scanning visit rows, not a single flat column per lead), still with no status filter —
  // terminalStale's LEAD_DATE_ANCHORED case re-checks the visit's own status at execution time.
  it('lead.walkthrough_scheduled_at: selects walkthrough rows by scheduled_at with no status filter and keys the occurrence on it (entity = the LEAD)', async () => {
    const walkthrough = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'wt-1', scheduled_at: walkthrough, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, lead_id: { not: null }, scheduled_at: WINDOW });
    expect(out).toEqual([
      { entityType: 'lead', entityId: 'lead-1', entityLabel: 'L00007', occurrence: walkthrough.toISOString(), visitId: 'wt-1' },
    ]);
  });

  // Per-visit automation enrollment (spec 2026-09-14, criteria 3-5). The lead half matters more
  // than the job half, not less: there is no lead-side visitMergeFields anywhere in the codebase,
  // so before this the lead's five visit-derived fields were resolved per ENTITY on EVERY path,
  // event-driven dispatch included. The showroom-then-site pair is the shape it breaks on.
  it('lead.walkthrough_scheduled_at: asks Postgres for the visit id', async () => {
    await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);
    expect(mockPrisma.visit.findMany.mock.calls[0][0].select).toMatchObject({ id: true });
  });

  it('lead.walkthrough_scheduled_at: a showroom meeting and a site visit carry their OWN visit ids', async () => {
    const showroom = new Date('2026-07-19T09:00:00.000Z');
    const site = new Date('2026-07-21T14:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'wt-showroom', scheduled_at: showroom, lead: { id: 'lead-1', lead_number: 'L00007' } },
      { id: 'wt-site', scheduled_at: site, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

    expect(out.map((c) => c.visitId)).toEqual(['wt-showroom', 'wt-site']);
    expect(out.map((c) => c.entityId)).toEqual(['lead-1', 'lead-1']); // D5
    expect(out.map((c) => c.occurrence)).toEqual([showroom.toISOString(), site.toISOString()]);
    for (const c of out) expect(c.occurrence).not.toContain('wt-'); // D3
  });

  // Multi-visit S2 puts a JOB's trips in the same `visits` table (D5: exactly one parent, so a job
  // visit carries no lead), and the migration backfills one per already-scheduled job. A sweep that
  // reads every visit in the window therefore meets a lead-less row roughly whenever a job is
  // booked 24h out - and the throw is swallowed by cron.ts's per-workflow catch, so the org's
  // walkthrough reminders silently stop enrolling instead of reporting an error.
  it('lead.walkthrough_scheduled_at: ignores a JOB visit sharing the window instead of throwing on its missing lead', async () => {
    const walkthrough = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'job-visit', scheduled_at: new Date('2026-07-19T08:00:00.000Z'), lead: null },
      { id: 'wt-1', scheduled_at: walkthrough, lead: { id: 'lead-1', lead_number: 'L00007' } },
    ]);

    const out = await candidatesForAnchor('lead.walkthrough_scheduled_at', ORG, WINDOW);

    expect(out).toEqual([
      { entityType: 'lead', entityId: 'lead-1', entityLabel: 'L00007', occurrence: walkthrough.toISOString(), visitId: 'wt-1' },
    ]);
  });

  it('invoice.due_date: selects open invoices by due date and keys the occurrence on the due date', async () => {
    const due = new Date('2026-08-01T12:00:00.000Z');
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00001', due_date: due },
    ]);
    const window = { gte: new Date('2026-07-18T12:00:00.000Z'), lte: due };

    const out = await candidatesForAnchor('invoice.due_date', ORG, window);

    expect(mockPrisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id: ORG,
          status: { in: ['SENT', 'PARTIAL'] },
          amount_due: { gt: 0 },
          due_date: window,
        }),
      }),
    );
    expect(out).toEqual([
      { entityType: 'invoice', entityId: 'inv-1', entityLabel: 'I00001', occurrence: due.toISOString() },
    ]);
  });

  // SENT only: a PENDING estimate is already accepted and signed (D6) and no longer expires, so
  // anchoring an automation to its validity date would fire against a closed decision.
  it('estimate.valid_until: selects SENT estimates by expiration and keys the occurrence on it', async () => {
    const validUntil = new Date('2026-08-05T12:00:00.000Z');
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00099', valid_until: validUntil },
    ]);

    const out = await candidatesForAnchor('estimate.valid_until', ORG, WINDOW);

    const q = mockPrisma.estimate.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ organization_id: ORG, status: 'SENT', valid_until: WINDOW });
    expect(out).toEqual([
      { entityType: 'estimate', entityId: 'est-1', entityLabel: 'E00099', occurrence: validUntil.toISOString() },
    ]);
  });

  /**
   * Per-visit automation enrollment (spec 2026-09-14, D7 / criterion 5): every OTHER arm emits NO
   * visit id.
   *
   * The field is optional because most anchors genuinely have no answer - a lead stage clock, an
   * invoice due date, an estimate's expiry and a task's due date are per-ENTITY questions by
   * nature, and there is no trip they could name. Optional means a wrong answer here is silent, so
   * it is asserted rather than assumed: a stray visit id on one of these would make the loader
   * refuse to resolve the entity at all the day that visit is deleted (D4 stops, never falls back).
   */
  it('the per-entity anchors emit no visit id at all', async () => {
    const at = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.lead.findMany.mockResolvedValue([
      { id: 'lead-1', lead_number: 'L00007', created_at: at, contacted_at: at, last_visit_completed_at: at },
    ]);
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1', invoice_number: 'I00001', due_date: at }]);
    mockPrisma.estimate.findMany.mockResolvedValue([{ id: 'est-1', estimate_number: 'E00099', valid_until: at }]);
    mockPrisma.task.findMany.mockResolvedValue([{ id: 'task-1', title: 'Chase the permit office', due_at: at }]);

    const perEntityAnchors = [
      'lead.created_at',
      'lead.contacted_at',
      'lead.last_visit_completed_at',
      'invoice.due_date',
      'estimate.valid_until',
      'task.due_at',
    ] as const;

    for (const anchor of perEntityAnchors) {
      const out = await candidatesForAnchor(anchor, ORG, WINDOW);
      expect(out.length, `${anchor} produced no candidate, so the assertion below proves nothing`).toBeGreaterThan(0);
      for (const c of out) {
        expect(c.visitId, `${anchor} named a visit it has no business naming`).toBeUndefined();
      }
    }
  });
});

/**
 * Spec B slice 5: the task arm.
 *
 * `candidatesForAnchor`'s switch ends in `default: return []`, so a MISSING task case
 * compiles, publishes, enables, validates, reads back correctly in the builder - and never
 * fires, with nothing red anywhere and nothing in the logs. These tests are the only thing
 * standing between that and a silent feature.
 */
describe('candidatesForAnchor - task.due_at (Spec B slice 5)', () => {
  const ORG = 'org-1';
  const BEFORE_WINDOW = { gte: now, lte: new Date(now.getTime() + DAY) };
  const AFTER_WINDOW = { gte: new Date(now.getTime() - DAY - AFTER_GRACE_MS), lte: new Date(now.getTime() - DAY) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.task.findMany.mockResolvedValue([]);
  });

  it('selects OPEN tasks whose due date falls in the before-window', async () => {
    const due = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-1', title: 'Order the replacement thermostat', due_at: due },
    ]);

    const out = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);

    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    expect(q.where.due_at).toEqual(BEFORE_WINDOW);
    expect(out).toEqual([
      { entityType: 'task', entityId: 'task-1', entityLabel: 'Order the replacement thermostat', occurrence: due.toISOString() },
    ]);
  });

  it('selects OPEN tasks whose due date falls in the after-window (the overdue chase)', async () => {
    const due = new Date(now.getTime() - DAY);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-2', title: 'Chase the permit office', due_at: due },
    ]);

    const out = await candidatesForAnchor('task.due_at', ORG, AFTER_WINDOW);

    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.due_at).toEqual(AFTER_WINDOW);
    expect(out).toEqual([
      { entityType: 'task', entityId: 'task-2', entityLabel: 'Chase the permit office', occurrence: due.toISOString() },
    ]);
  });

  /**
   * Filtered at SELECTION time, like every other arm that filters at all - not enrolled and
   * then suppressed later. The status fragment comes from lib/tasks/status.ts's shared helper,
   * never a hand-written ['DONE','CANCELLED'] pair: that module exists because a dozen sites
   * each spelled the terminal set out and all went wrong by one value when CANCELLED landed.
   */
  it('excludes DONE and CANCELLED tasks at selection time', async () => {
    await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);
    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.status).toEqual({ notIn: ['DONE', 'CANCELLED'] });
  });

  /**
   * BLOCKED is deliberately NOT terminal (Spec B, and lib/tasks/status.ts). Blocked work is
   * exactly the work an overdue chase is for. Pinned so nobody "fixes" it into the notIn list.
   */
  it('DOES select a BLOCKED task - blocked is not terminal', async () => {
    const due = new Date(now.getTime() - DAY);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-3', title: 'Fit the replacement panel', due_at: due },
    ]);

    const out = await candidatesForAnchor('task.due_at', ORG, AFTER_WINDOW);

    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.status.notIn).not.toContain('BLOCKED');
    expect(out.map((c) => c.entityId)).toEqual(['task-3']);
  });

  it('never enrolls a task with no due date', async () => {
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-4', title: 'Someday, maybe', due_at: null },
    ]);

    const out = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);

    expect(out).toEqual([]);
  });

  /**
   * The occurrence must be the BARE ISO due date and nothing wider. dedupe.ts's header is
   * explicit: stopIf.ts and terminalStale.ts compare occurrence_key against
   * someDate.toISOString() and go silently STALE on anything else, which would kill every
   * task reminder at the send with a confusing reason.
   */
  it('keys the occurrence on the bare ISO due date, the format the staleness comparisons expect', async () => {
    const due = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-5', title: 'Order the replacement thermostat', due_at: due },
    ]);

    const [candidate] = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);

    expect(candidate.occurrence).toBe(due.toISOString());
    expect(candidate.occurrence).toBe('2026-07-19T09:00:00.000Z');
    expect(candidate.occurrence).not.toContain('task-5');
  });

  /**
   * The DELIBERATE divergence from the other four arms, which all write a record NUMBER. The
   * task bell verbs write the TITLE, with a recorded rationale that a task's number means
   * nothing to the person being told about it - and the activity tab, where entity_label
   * renders, is the same audience. Following the sweep convention here would make two
   * adjacent surfaces disagree about how a task is named.
   */
  it('labels the candidate with the task TITLE, not its number', async () => {
    const due = new Date('2026-07-19T09:00:00.000Z');
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-6', task_number: 'T00042', title: 'Order the replacement thermostat', due_at: due },
    ]);

    const [candidate] = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);

    expect(candidate.entityLabel).toBe('Order the replacement thermostat');
    expect(candidate.entityLabel).not.toBe('T00042');
  });

  it('mints a distinct occurrence per due date, so a moved due date is a new occurrence', async () => {
    const first = new Date('2026-07-19T09:00:00.000Z');
    const second = new Date('2026-07-20T09:00:00.000Z');
    mockPrisma.task.findMany
      .mockResolvedValueOnce([{ id: 'task-7', title: 'Order the thermostat', due_at: first }])
      .mockResolvedValueOnce([{ id: 'task-7', title: 'Order the thermostat', due_at: second }]);

    const [a] = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);
    const [b] = await candidatesForAnchor('task.due_at', ORG, BEFORE_WINDOW);

    expect(a.entityId).toBe(b.entityId);
    expect(a.occurrence).not.toBe(b.occurrence);
  });
});
