/**
 * A FIELD THE CATALOG OFFERS FOR A TRIGGER MUST BE PRESENT IN THAT TRIGGER'S EXECUTION CONTEXT.
 *
 * The customer-visible failure is a raw token: `renderMergeFields` deliberately leaves an UNKNOWN
 * field literal so a typo'd {{customer.frist_name}} stays visible in the preview and in the send,
 * which means a DECLARED field that no entity arm sets prints `{{job.scheduled_date}}` verbatim in
 * somebody's inbox. Nothing upstream catches it: `workflowValidation` checks the body against
 * `TRIGGERS[t].mergeFields` - the ADVERTISEMENT - and never against what the loader actually
 * resolves, so a workflow using the field publishes clean, enables clean, sends, and is wrong.
 *
 * ── WHY A SECOND SWEEP, NEXT TO `context.emptyMergeFields.test.ts` ───────────────────────────
 *
 * That file's sweep (D7, #2087) is the closest guard there is, and it has a hole this one exists
 * to close. Its loop reads:
 *
 *     if (NO_NOUN_PHRASE.has(field)) continue;
 *     expect(ctx).toHaveProperty(field);          // presence
 *     if (!(ctx[field] ?? '').trim()) holes.push(field);   // non-emptiness
 *
 * One `continue` serves BOTH assertions, so the eleven fields exempted from non-emptiness -
 * every date, every time, every link, `job.sub_status` and `task.linked_record` - are exempted
 * from the PRESENCE check too. Those exemptions are right for emptiness and wrong for presence:
 * '' is the correct rendering of a date an automation body must suppress with a conditional
 * section, but there is no field anywhere for which `{{job.scheduled_date}}` in a customer's
 * email is the correct rendering. Delete `'job.scheduled_date'` from the job arm today and the
 * whole backend suite stays green.
 *
 * ABSENT AND EMPTY ARE DIFFERENT FAILURES WITH DIFFERENT FIXES, which is why they are asserted by
 * two different files rather than folded together here: an absent key is a loader that forgot a
 * field, an empty one is a fallback decision (D7). Keeping them apart is what lets a mutation tell
 * you which of the two you just broke.
 *
 * PER TRIGGER, not per entity. The D7 sweep groups by entity and takes the UNION of every
 * trigger's fields, which is a sound superset today but cannot name the trigger that is wrong -
 * and the failure an engineer meets is always "this workflow's email has braces in it", which is
 * a trigger, not an entity. A trigger-shaped assertion also survives the next per-trigger field
 * group (WALKTHROUGH_FIELDS and JOB_SUB_STATUS_FIELD are already two of them): a group attached to
 * a trigger whose entity arm does not resolve it fails here on the day it is added.
 *
 * The last test closes the loop at the boundary the customer actually reads - the poller's
 * enrolment and the dispatcher's enrolment, each walked end to end, rendering the same subject.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AutomationTriggerType } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle, type EventPayload } from '../context';
import { renderMergeFields } from '../renderMergeFields';
import { TRIGGERS } from '../catalog';
import { TASK_TRANSITIONS, taskTransitionEvent } from '../taskTransitions';

// The engine's send step is stubbed: this file is about the CONTEXT handed to the executor, and
// the real one would need a mail provider to say anything at all. `enrollment.ts` imports exactly
// one runtime symbol from the module, so the stub is the whole of it.
vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'x@y.test', detail: 'ok' }),
}));
import { executeAction } from '../executors';
import { runAutomationTick } from '../cron';
import { enrollOnEvent } from '../enrollment';

const mockPrisma = prisma as any;
const mockExecute = executeAction as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const JOB_ID = 'a0000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = 'e0000000-0000-0000-0000-000000000001';
const INVOICE_ID = 'f0000000-0000-0000-0000-000000000001';
const TASK_ID = 'b0000000-0000-0000-0000-000000000001';

const NOW = new Date('2026-09-14T15:00:00.000Z'); // 11:00 America/New_York — inside every send window
// Both trips sit far enough ahead of the REAL wall clock that `resolveNextJobVisit` — which takes
// no injectable clock and defaults to `new Date()` — deterministically calls the FIRST one "next"
// for years. A fixture dated within days of the day it was written decides that question by what
// time the suite happens to run, and this file's whole point below is which of two trips resolved.
const VISIT_AT = new Date('2027-03-02T15:00:00.000Z');
/** The SECOND trip on the same parent: another day, another place, another crew. */
const SECOND_VISIT_AT = new Date('2027-03-04T19:30:00.000Z');

const ORG_ROW = {
  name: 'ServWave Test',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
  // createEnrollment's entitlement gate reads the same row through its own narrower select; a
  // mocked client ignores the select, so the three columns ride along here.
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: null,
};

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  kind: 'RESIDENTIAL',
  customer_number: 'C00019',
  company_name: null,
  first_name: 'Rowan',
  last_name: 'Pike',
  email: 'rowan@example.test',
  phone: '+15550100101',
};

/** The one person on the trip. `phone_ext` is selected as one thing with `phone` everywhere this
 *  feature reads a crew, so the fixture carries the pair. */
const CREW_MEMBER = {
  id: 'u0000000-0000-0000-0000-000000000001',
  email: 'lena@emanuel-demo.local',
  first_name: 'Lena',
  last_name: 'Ortiz',
  phone: '+15550100142',
  phone_ext: '214',
};

/** The crew on the SECOND trip — a different person, on a different number, with no extension. */
const SECOND_CREW_MEMBER = {
  id: 'u0000000-0000-0000-0000-000000000002',
  email: 'marcus@emanuel-demo.local',
  first_name: 'Marcus',
  last_name: 'Webb',
  phone: '+15550100199',
  phone_ext: null,
};

const FIRST_VISIT_ID = 'v0000000-0000-0000-0000-000000000001';
const SECOND_VISIT_ID = 'v0000000-0000-0000-0000-000000000002';

/** A visit at a saved company location — the state the per-visit-location feature exists for, and
 *  the one where a lost merge field is worst: the customer drives to the wrong address. */
function visitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FIRST_VISIT_ID,
    status: 'SCHEDULED',
    scheduled_at: VISIT_AT,
    duration_minutes: 60,
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
    customer_email_sent_at: null,
    notes: null,
    created_at: new Date('2026-09-01'),
    location_id: 'loc-1',
    location_address_line1: null,
    location_city: null,
    location_state: null,
    location: { name: 'North Yard', address_line1: '40 Depot Rd', city: 'Asheville', state: 'NC' },
    assignees: [{ user: CREW_MEMBER }],
    ...overrides,
  };
}

/**
 * The SECOND trip on the same parent — a later day, a one-off address rather than a saved
 * location, and a different person going.
 *
 * Per-visit automation enrollment (spec 2026-09-14). This file's own note explains why the
 * single-visit fixture it used to carry could not tell "the poller resolved the right trip" from
 * "there was only one trip to resolve": `resolveCurrentWalkthrough` / `resolveNextJobVisit` and
 * "the visit that triggered enrolment" are the same row when a parent has one, so every assertion
 * passed whether the enrollment recorded a visit id or not. Three things differ here — the time,
 * the place and the crew — so a resolution that lands on the wrong trip is visible in three
 * independent strings rather than inferred from one.
 */
function secondVisitRow(overrides: Record<string, unknown> = {}) {
  return visitRow({
    id: SECOND_VISIT_ID,
    scheduled_at: SECOND_VISIT_AT,
    created_at: new Date('2026-09-02'),
    location_id: null,
    location: null,
    location_address_line1: '402 Ridge Top Rd',
    location_city: 'Weaverville',
    location_state: 'NC',
    assignees: [{ user: SECOND_CREW_MEMBER }],
    ...overrides,
  });
}

function leadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    lead_number: 'L00277',
    status: 'CONTACTED',
    service_request: 'replace the shop doors',
    job_type: 'door replacement',
    customer: CUSTOMER,
    visits: [visitRow(), secondVisitRow()],
    commission_owner: null,
    service_location: { address_line1: '11 Cedar Lane', city: 'Asheville', state: 'NC' },
    created_at: new Date('2026-09-01'),
    contacted_at: new Date('2026-09-02'),
    walkthrough_first_booked_at: null,
    last_visit_completed_at: null,
    first_estimate_sent_at: null,
    ...overrides,
  } as any;
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    job_type: 'door replacement',
    scope_notes: 'two leaves, north entrance',
    sub_status: { label: 'Parts on order' },
    completed_at: null,
    customer: CUSTOMER,
    service_location: { address_line1: '11 Cedar Lane', city: 'Asheville', state: 'NC' },
    visits: [visitRow(), secondVisitRow()],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...overrides,
  } as any;
}

const ESTIMATE_ROW = {
  id: ESTIMATE_ID,
  estimate_number: 'E00108',
  status: 'SENT',
  total_amount: 1200,
  valid_until: new Date('2026-09-30T00:00:00.000Z'),
  public_token: 'tok-est',
  customer: CUSTOMER,
  lead: null,
  creator: null,
};

const INVOICE_ROW = {
  id: INVOICE_ID,
  invoice_number: 'I00073',
  status: 'SENT',
  total_amount: 1200,
  amount_due: 1200,
  due_date: new Date('2026-09-30T00:00:00.000Z'),
  public_token: 'tok-inv',
  customer: CUSTOMER,
  job: null,
};

const TASK_ROW = {
  id: TASK_ID,
  task_number: 'T00042',
  title: 'Order the replacement thermostat',
  status: 'TODO',
  priority: 'LOW',
  due_at: new Date('2026-09-30T00:00:00.000Z'),
  assignee_ids: [],
  watcher_ids: [],
  linked_entity_type: null,
  linked_entity_id: null,
  creator: null,
};

/**
 * The one field no entity load can resolve, with the site that does resolve it.
 *
 * NOT an exemption in the D7 sense - it is asserted, just not here: `event.reason` is
 * request-time text the dispatching controller persists into event_payload. An entity load that
 * started answering for it would be the defect, not the fix.
 *
 * This set held a second member, `recipient.first_name`, which the executor wrote per addressee.
 * That field was removed outright on 2026-09-15 (see `BASE` in catalog.ts), so every advertised
 * field except this one now comes from the entity load - which is what makes the parity check
 * below stronger than it was, not weaker.
 */
const RESOLVED_OUTSIDE_THE_ENTITY_LOAD = new Set(['event.reason']);

/**
 * What the TASK_DELETED dispatch persists, replayed here verbatim.
 *
 * Its two advertised task fields are the ONLY ones in the catalogue that a live entity read can
 * never answer - the row is hard-deleted before the send - so this trigger is exercised the way
 * it actually runs: no task row, the snapshot on the enrollment, and the identity strings merged
 * over the context by `loadExecutionBundle`. Skipping it instead would leave the one trigger whose
 * fields come from somewhere else entirely as the one trigger nothing checks.
 */
const TASK_DELETED_PAYLOAD: EventPayload = {
  mergeFields: { 'task.number': TASK_ROW.task_number, 'task.title': TASK_ROW.title },
  taskSnapshot: { assigneeIds: [], watcherIds: [], creatorId: null },
};

/**
 * What a task status-TRANSITION dispatch ("Task is done") persists, built by the SAME function the
 * task controller calls. Who made the change and when are facts about the event - a task has no
 * "finished by" column - so, like TASK_DELETED's identity, they ride event_payload.mergeFields and
 * are replayed here the way the trigger actually runs rather than exempted.
 */
function transitionPayload(trigger: string): EventPayload | undefined {
  const transition = TASK_TRANSITIONS.find((t) => t.trigger === trigger);
  if (!transition) return undefined;
  return taskTransitionEvent({
    transition,
    organizationId: ORG,
    task: { id: TASK_ID, title: TASK_ROW.title },
    actorId: 'u-actor',
    actorName: 'Dana Whitfield',
    at: NOW,
    timeZone: 'America/New_York',
  }).eventPayload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique = vi.fn().mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst = vi.fn().mockResolvedValue(leadRow());
  mockPrisma.job.findFirst = vi.fn().mockResolvedValue(jobRow());
  mockPrisma.estimate.findFirst = vi.fn().mockResolvedValue(ESTIMATE_ROW);
  mockPrisma.invoice.findFirst = vi.fn().mockResolvedValue(INVOICE_ROW);
  mockPrisma.task = { findFirst: vi.fn().mockResolvedValue(TASK_ROW) };
  mockPrisma.user = { findMany: vi.fn().mockResolvedValue([]) };
});

const ENTITY_ID: Record<string, string> = {
  lead: LEAD_ID, job: JOB_ID, estimate: ESTIMATE_ID, invoice: INVOICE_ID, task: TASK_ID,
};

/** The execution context an enrollment on `trigger` would render against. */
async function contextFor(trigger: string): Promise<Record<string, string>> {
  const def = TRIGGERS[trigger as AutomationTriggerType];
  // Set BOTH ways round, every call: TASK_DELETED is the one trigger that must meet a missing row,
  // and leaving that mock behind would hand the task trigger declared after it a deleted task -
  // a fixture leak that reads as a real failure and sends you looking in the loader.
  mockPrisma.task.findFirst.mockResolvedValue(trigger === 'TASK_DELETED' ? null : TASK_ROW);
  const loaded = await loadExecutionBundle({
    entityType: def.entity,
    entityId: ENTITY_ID[def.entity],
    entityLabel: 'label',
    organizationId: ORG,
    dedupeKey: `parity:${trigger}`,
    trigger: trigger as AutomationTriggerType,
    ...(trigger === 'TASK_DELETED' ? { eventPayload: TASK_DELETED_PAYLOAD } : {}),
    ...(transitionPayload(trigger) ? { eventPayload: transitionPayload(trigger) } : {}),
  });
  expect(loaded, `${trigger} loaded no execution bundle at all`).not.toBeNull();
  return loaded!.bundle.mergeCtx;
}

describe('every trigger resolves every field it advertises', () => {
  /**
   * Read off `TRIGGERS` rather than a list kept here, so the next trigger is covered by existing
   * code rather than by somebody remembering to extend a fixture. The count assertion is what
   * stops the loop from passing vacuously if the catalogue is ever handed in empty.
   */
  const ALL_TRIGGERS = Object.keys(TRIGGERS);

  it('covers the whole catalogue', () => {
    expect(ALL_TRIGGERS.length).toBeGreaterThan(20);
  });

  it('leaves no advertised field absent from its trigger context', async () => {
    const absent: string[] = [];
    for (const trigger of ALL_TRIGGERS) {
      const ctx = await contextFor(trigger);
      for (const field of TRIGGERS[trigger as AutomationTriggerType].mergeFields) {
        if (RESOLVED_OUTSIDE_THE_ENTITY_LOAD.has(field)) continue;
        // hasOwnProperty, exactly as renderMergeFields decides the same question. `in` would
        // answer true for an inherited key and `ctx[field] !== undefined` would answer false for
        // a field resolved to '' - which is a DIFFERENT defect, held by context.emptyMergeFields.
        if (!Object.prototype.hasOwnProperty.call(ctx, field)) absent.push(`${trigger} → {{${field}}}`);
      }
    }
    expect(absent, 'fields a trigger advertises that its execution context never sets').toEqual([]);
  });

  /**
   * The same invariant stated at the boundary the customer reads, because "the key is present" is
   * a claim about an object and "no braces reached the inbox" is the claim that matters. It is not
   * redundant: it also pins that the field NAMES the catalogue advertises are spelled the way
   * `renderMergeFields`' own regex reads them - a field named with a capital or a digit would
   * satisfy the presence check above and still render as its own token here.
   */
  it('renders a body of every advertised field with no raw token left behind', async () => {
    const leftLiteral: string[] = [];
    for (const trigger of Object.keys(TRIGGERS)) {
      const fields = TRIGGERS[trigger as AutomationTriggerType].mergeFields;
      const ctx = {
        ...(await contextFor(trigger)),
        // The one the dispatcher supplies, at its real call site's value, so this test fails
        // for a missing ENTITY field and never for that one.
        'event.reason': 'Customer asked',
      };
      const body = fields.map((f) => `${f}=[{{${f}}}]`).join(' ');
      const rendered = renderMergeFields(body, ctx, { html: false });
      if (rendered.includes('{{')) leftLiteral.push(`${trigger}: ${rendered}`);
    }
    expect(leftLiteral, 'triggers whose own advertised copy renders a raw {{token}}').toEqual([]);
  });
});

// ── the poller and the dispatcher must agree ─────────────────────────────────────────────────

/**
 * Enrolment is the one thing the two paths genuinely do differently - the dispatcher persists an
 * event_payload (an actor, a reason, the per-visit overrides a controller stamps) and the poller
 * persists none - so it is the seam where one path could acquire a context the other lacks. The
 * ONE shared loader downstream (`loadExecutionBundle`) is what makes them agree today; this walks
 * both ends to end so that stays true rather than being re-read off the source each time somebody
 * asks why a timed reminder differs from an event one.
 */
const SEND_STEP = (subject: string) => ({
  position: 0,
  step_type: 'SEND_EMAIL',
  config: { recipients: ['customer'], subject, body: subject },
});

function workflowRow(trigger: string, triggerConfig: unknown) {
  return {
    id: `wf-${trigger}`,
    name: `${trigger} probe`,
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: trigger,
    trigger_config: triggerConfig,
    published_version_id: 'ver-1',
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * One org's worth of engine state, wired so that whichever path is under test walks all the way
 * to the executor: the scan finds the workflow, `createEnrollment` writes a row, the poller's
 * third phase picks it up, and `advanceEnrollment` reads it back with its frozen definition.
 */
function wireEngine(
  trigger: string,
  triggerConfig: unknown,
  subject: string,
  /**
   * Which trip(s) the sweep finds. Defaults to the FIRST one alone, which is what the two parity
   * scenarios below want: they compare a poller-enrolled run against a dispatcher-enrolled one,
   * and a visit-scoped sweep beside a job-scoped event legitimately describes two different trips
   * on a multi-visit parent - a real difference, not a parity failure. The per-visit scenarios
   * pass the SECOND trip and assert it is the one that renders.
   */
  sweepVisits: { id: string; scheduled_at: Date }[] = [{ id: FIRST_VISIT_ID, scheduled_at: VISIT_AT }],
) {
  const definition = {
    trigger_type: trigger,
    trigger_config: triggerConfig,
    send_window: null,
    steps: [SEND_STEP(subject)],
  };
  mockPrisma.lead.findMany = vi.fn().mockResolvedValue([]);
  mockPrisma.job.findMany = vi.fn().mockResolvedValue([]);
  mockPrisma.invoice.findMany = vi.fn().mockResolvedValue([]);
  mockPrisma.estimate.findMany = vi.fn().mockResolvedValue([]);
  mockPrisma.task.findMany = vi.fn().mockResolvedValue([]);
  // Both per-visit sweeps read this table: the lead anchor's arm and BEFORE_JOB_START's.
  mockPrisma.visit = {
    findMany: vi.fn().mockImplementation((q: any) =>
      Promise.resolve(
        sweepVisits.map((v) =>
          q?.where?.lead_id
            ? { id: v.id, scheduled_at: v.scheduled_at, lead: { id: LEAD_ID, lead_number: 'L00277' } }
            : { id: v.id, scheduled_at: v.scheduled_at, job: { id: JOB_ID, job_number: 'J00042' } },
        ),
      ),
    ),
  };
  mockPrisma.workflow = {
    findMany: vi.fn().mockImplementation((q: any) => {
      const wanted: string[] = q?.where?.trigger_type?.in ?? [q?.where?.trigger_type];
      return Promise.resolve(wanted.includes(trigger) ? [workflowRow(trigger, triggerConfig)] : []);
    }),
    update: vi.fn().mockResolvedValue({}),
  };
  /**
   * The row the poller reads back is BUILT FROM WHAT THE ENROLMENT WROTE, not from a literal
   * pinned here. That is the only way this harness can prove anything about per-visit resolution:
   * a hand-written `occurrence_key` / `visit_id` would describe whichever trip the test author had
   * in mind rather than the one the sweep actually enrolled, and the walk from candidate to send
   * would be broken in the middle where nothing could see it.
   */
  let lastCreated: Record<string, unknown> = {};
  mockPrisma.workflowEnrollment = {
    create: vi.fn().mockImplementation((q: any) => {
      lastCreated = q?.data ?? {};
      return Promise.resolve({ id: 'enr-1' });
    }),
    findMany: vi.fn().mockResolvedValue([{ id: 'enr-1', step_cursor: 0 }]),
    findUnique: vi.fn().mockImplementation(() =>
      Promise.resolve({
        id: 'enr-1',
        workflow_id: `wf-${trigger}`,
        workflow_version_id: 'ver-1',
        status: 'ACTIVE',
        entity_type: TRIGGERS[trigger as AutomationTriggerType].entity,
        entity_id: ENTITY_ID[TRIGGERS[trigger as AutomationTriggerType].entity],
        entity_label: 'label',
        occurrence_key: (lastCreated.occurrence_key as string) ?? VISIT_AT.toISOString(),
        visit_id: (lastCreated.visit_id as string | null) ?? null,
        dedupe_key: (lastCreated.dedupe_key as string) ?? `dk-${trigger}`,
        step_cursor: 0,
        resume_at: NOW,
        organization_id: ORG,
        event_payload: (lastCreated.event_payload as unknown) ?? null,
        version: { id: 'ver-1', definition },
        workflow: workflowRow(trigger, triggerConfig),
      }),
    ),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    update: vi.fn().mockResolvedValue({}),
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'sr-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
  mockPrisma.automationRun = { findUnique: vi.fn().mockResolvedValue(null) };
}

/** The subject the step actually sent, rendered by the same call the executor makes. */
function sentSubject(subject: string): string {
  expect(mockExecute, 'the run never reached a send step').toHaveBeenCalledTimes(1);
  const bundle = mockExecute.mock.calls[0][1];
  return renderMergeFields(subject, bundle.mergeCtx, { html: false });
}

describe('a poller-enrolled run renders what a dispatcher-enrolled run renders', () => {
  const LEAD_SUBJECT =
    'wl=[{{lead.walkthrough_location}}] pp=[{{lead.performer_phones}}] pn=[{{lead.performer_names}}] ' +
    'jt=[{{lead.job_type}}] addr=[{{lead.address}}] d=[{{lead.walkthrough_date}}]';
  const JOB_SUBJECT =
    'loc=[{{job.visit_location}}] ph=[{{technician.phones}}] tn=[{{technician.names}}] ' +
    'addr=[{{job.address}}] d=[{{job.scheduled_date}}]';

  const LEAD_ANCHOR = { anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 24 * 60 };

  it('lead: the walkthrough sweep and the walkthrough event agree, field for field', async () => {
    wireEngine('LEAD_DATE_ANCHORED', LEAD_ANCHOR, LEAD_SUBJECT);
    await runAutomationTick(NOW);
    const swept = sentSubject(LEAD_SUBJECT);

    vi.clearAllMocks();
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
    wireEngine('WALKTHROUGH_SCHEDULED', null, LEAD_SUBJECT);
    await enrollOnEvent(
      {
        type: 'WALKTHROUGH_SCHEDULED',
        organizationId: ORG,
        entity: { type: 'lead', id: LEAD_ID, label: 'L00277' },
        occurrenceKey: VISIT_AT.toISOString(),
        actorId: null,
      },
      NOW,
    );
    const dispatched = sentSubject(LEAD_SUBJECT);

    // Each half stated on its own first: two identical strings full of braces would satisfy an
    // equality assertion and be exactly the defect this test is for.
    expect(swept).not.toContain('{{');
    expect(dispatched).not.toContain('{{');
    expect(swept).toBe(dispatched);
  });

  /**
   * ONE trip on this job, stated explicitly rather than taken from the default fixture.
   *
   * The two paths being compared ask different questions on a multi-visit job, and after per-visit
   * enrollment (spec 2026-09-14) they are RIGHT to answer differently: the appointment sweep is
   * about one trip and names that trip's crew, while a completion event is about the whole job and
   * names the union across its trips. Holding them to one string on a two-visit parent would be
   * asserting the defect. What this test is for - that neither path acquires a context the other
   * lacks at the ENROLMENT seam - is unchanged, and is what a single trip isolates.
   */
  it('job: the appointment sweep and the completion event agree, field for field', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits: [visitRow()] }));
    wireEngine('BEFORE_JOB_START', { offset_minutes: 24 * 60 }, JOB_SUBJECT);
    await runAutomationTick(NOW);
    const swept = sentSubject(JOB_SUBJECT);

    vi.clearAllMocks();
    mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits: [visitRow()] }));
    wireEngine('JOB_COMPLETED', null, JOB_SUBJECT);
    await enrollOnEvent(
      {
        type: 'JOB_COMPLETED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID, label: 'J00042' },
        actorId: null,
      },
      NOW,
    );
    const dispatched = sentSubject(JOB_SUBJECT);

    expect(swept).not.toContain('{{');
    expect(dispatched).not.toContain('{{');
    expect(swept).toBe(dispatched);
  });

  /**
   * The visit's own location, named rather than inferred from "the two strings match".
   *
   * A sweep that resolved the PARENT's service address instead would still agree with an event
   * path that did the same, so the pair above cannot tell "both right" from "both wrong". This is
   * the value the per-visit-location feature exists to produce, asserted once.
   */
  it('resolves the visit location the poller enrolled for, not the service address', async () => {
    wireEngine('LEAD_DATE_ANCHORED', LEAD_ANCHOR, LEAD_SUBJECT);
    await runAutomationTick(NOW);
    const swept = sentSubject(LEAD_SUBJECT);
    expect(swept).toContain('wl=[North Yard, 40 Depot Rd, Asheville, NC]');
    expect(swept).toContain('pp=[(555) 010-0142 ext. 214]');
    expect(swept).toContain('addr=[11 Cedar Lane, Asheville, NC]');
  });

  /**
   * ── Per-visit automation enrollment (spec 2026-09-14), criteria 9 and 10 ─────────────────────
   *
   * WHICH trip the poller resolved, which the assertion directly above cannot answer.
   *
   * It pins the FIRST visit's location, and on a parent with one visit that is the same row as
   * "the trip that triggered enrolment" whatever the enrollment recorded - so it passed both
   * before and after this change, and reads as coverage it is not. These two walk the same poller
   * path with the sweep landing on the SECOND trip, at a different time, in a different place,
   * with a different person going. Each field is stated on its own: they travel through different
   * code (a location formatter, two date formatters, a name join, a phone formatter), so one of
   * them silently keeping the parent's answer has to be visible as itself.
   */
  const secondTrip = [{ id: SECOND_VISIT_ID, scheduled_at: SECOND_VISIT_AT }];
  const inOrgTz = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'America/New_York' }).format(d);
  const asDate = (d: Date) => inOrgTz(d, { weekday: 'short', month: 'short', day: 'numeric' });
  const asTime = (d: Date) => inOrgTz(d, { hour: 'numeric', minute: '2-digit' });

  const LEAD_PER_VISIT_SUBJECT =
    'wl=[{{lead.walkthrough_location}}] pp=[{{lead.performer_phones}}] pn=[{{lead.performer_names}}] ' +
    'd=[{{lead.walkthrough_date}}] t=[{{lead.walkthrough_time}}]';
  const JOB_PER_VISIT_SUBJECT =
    'loc=[{{job.visit_location}}] ph=[{{technician.phones}}] tn=[{{technician.names}}] ' +
    'fn=[{{technician.first_name}}] d=[{{job.scheduled_date}}] t=[{{job.scheduled_time}}]';

  it('lead: a sweep that enrolled the SITE visit renders the site visit, not the showroom (criterion 10)', async () => {
    wireEngine('LEAD_DATE_ANCHORED', LEAD_ANCHOR, LEAD_PER_VISIT_SUBJECT, secondTrip);
    await runAutomationTick(NOW);
    const swept = sentSubject(LEAD_PER_VISIT_SUBJECT);

    expect(swept).toContain('wl=[402 Ridge Top Rd, Weaverville, NC]');
    expect(swept).toContain('pn=[Marcus Webb]');
    expect(swept).toContain('pp=[(555) 010-0199]');
    expect(swept).toContain(`d=[${asDate(SECOND_VISIT_AT)}]`);
    expect(swept).toContain(`t=[${asTime(SECOND_VISIT_AT)}]`);
    // Stated the other way round too: not one word of the FIRST trip reached the customer. An
    // equality on the five above could be satisfied by a render that also carried the showroom.
    expect(swept).not.toContain('North Yard');
    expect(swept).not.toContain('Lena');
    expect(swept).not.toContain(asDate(VISIT_AT));
  });

  it('job: a sweep that enrolled the SECOND appointment renders the second appointment (criterion 9)', async () => {
    wireEngine('BEFORE_JOB_START', { offset_minutes: 24 * 60 }, JOB_PER_VISIT_SUBJECT, secondTrip);
    await runAutomationTick(NOW);
    const swept = sentSubject(JOB_PER_VISIT_SUBJECT);

    expect(swept).toContain('loc=[402 Ridge Top Rd, Weaverville, NC]');
    expect(swept).toContain('tn=[Marcus Webb]');
    expect(swept).toContain('fn=[Marcus]');
    expect(swept).toContain('ph=[(555) 010-0199]');
    expect(swept).toContain(`d=[${asDate(SECOND_VISIT_AT)}]`);
    expect(swept).toContain(`t=[${asTime(SECOND_VISIT_AT)}]`);
    expect(swept).not.toContain('North Yard');
    expect(swept).not.toContain('Lena');
    expect(swept).not.toContain(asDate(VISIT_AT));
  });

  /**
   * The premise both of the above rest on: the two trips really do render differently, so the pair
   * cannot be passing on a fixture that makes the showroom and the site indistinguishable.
   *
   * NOT the visit-id-less path, despite an earlier title here saying so: `wireEngine`'s default
   * sweep carries FIRST_VISIT_ID, so this enrolment names a trip like any other. It passes with or
   * without the fix (both the carried first trip and the parent's own resolution pick the earliest
   * trip), which is correct for a fixture premise and useless as a regression guard - so it must
   * not be read as one. D10's "an enrolment naming no visit is unchanged" is pinned where the
   * enrolment row is actually stubbed without one: context.job.test.ts, context.lead.test.ts and
   * enrollment.test.ts, all on multi-visit fixtures.
   */
  it('the first trip renders as the first trip, so the two above are not passing on an indistinguishable fixture', async () => {
    wireEngine('LEAD_DATE_ANCHORED', LEAD_ANCHOR, LEAD_PER_VISIT_SUBJECT);
    await runAutomationTick(NOW);
    const swept = sentSubject(LEAD_PER_VISIT_SUBJECT);

    expect(swept).toContain('wl=[North Yard, 40 Depot Rd, Asheville, NC]');
    expect(swept).toContain('pn=[Lena Ortiz]');
    expect(swept).toContain(`d=[${asDate(VISIT_AT)}]`);
  });
});
