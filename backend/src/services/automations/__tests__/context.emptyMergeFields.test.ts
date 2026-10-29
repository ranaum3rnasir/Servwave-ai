/**
 * D7 — a declared merge field must never resolve to an empty string.
 * (md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md)
 *
 * THE SEND THIS FILE EXISTS FOR, captured on staging 2026-09-12 during the per-visit-location QA
 * pass. A real rendered subject, on a lead whose customer is a COMPANY and which has no service
 * location:
 *
 *     QA0912-B Please meet us at . Job type: . Call .
 *
 * Every hole in it came from a field guarded with `?? ''`. `undefined` is the other half of the
 * same trap and is why `?? ''` was reached for in the first place: renderMergeFields deliberately
 * leaves an UNKNOWN field literal so a typo'd {{customer.frist_name}} stays visible, so a DECLARED
 * field resolving to undefined prints its own token in a customer's inbox.
 *
 * ── HOW THESE ARE WRITTEN, AND WHY NOT AS A LIST OF LITERALS ────────────────────────────────
 *
 * The sweep assertion at the bottom is the guarantee: EVERY field a trigger advertises, over every
 * entity, non-empty on a row where nothing is set. It is written against catalog.ts's own
 * declarations rather than a hand-kept list, so a field added to the catalog without a fallback
 * fails here rather than in somebody's inbox.
 *
 * The per-field tests above it pin the WORDING, because "non-empty" is satisfied by a string that
 * reads as broken copy. Where one field's answer is required to equal another's - lead.address and
 * lead.walkthrough_location, org.phone and lead.performer_phones - they are asserted against each
 * other rather than against two literals: the defect those pairs exist to prevent is one email
 * offering two different answers for one absent thing, and two literals can drift apart silently.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle, visitMergeFields } from '../context';
import { renderMergeFields } from '../renderMergeFields';
import { TRIGGERS } from '../catalog';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../mergeFieldFallbacks';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { TASK_TRANSITIONS } from '../taskTransitions';

/**
 * 2026-09-13 amendment (customer scheduling notifications spec, story 10): the crew fields and
 * the customer greeting no longer carry a builder-injected word. They resolve '' and the SEEDED
 * per-step fallback (mergeFieldFallbacks.ts) is what fills the sentence, so the guarantee this
 * file holds is now "no hole in a seeded send", asserted through the renderer with the default
 * fallback set rather than off the raw context.
 */
function seeded(field: string, ctx: Record<string, string>): string {
  return renderMergeFields(`{{${field}}}`, ctx, { html: false, fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS } });
}

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const JOB_ID = 'a0000000-0000-0000-0000-000000000001';
const ESTIMATE_ID = 'e0000000-0000-0000-0000-000000000001';
const INVOICE_ID = 'f0000000-0000-0000-0000-000000000001';
const TASK_ID = 'b0000000-0000-0000-0000-000000000001';

/** An organisation that has never filled its main line in — the state every org starts in. */
const ORG_NO_PHONE = {
  name: 'ServWave Test',
  phone: null,
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

/** A COMPANY customer: `company_name` carries the name, first/last are null. Not a degenerate
 *  row — it is every B2B customer in the product. */
const COMPANY_CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  kind: 'COMPANY',
  customer_number: 'C00019',
  company_name: 'Harbor Cabinet Co',
  first_name: null,
  last_name: null,
  email: 'ops@example.com',
  phone: null,
};

/** The lead from the staging capture: company customer, no service location, no job type. */
function bareLeadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    lead_number: 'L00277',
    status: 'CONTACTED',
    service_request: 'QA0912-B no address lead',
    job_type: null,
    customer: COMPANY_CUSTOMER,
    visits: [
      {
        id: 'w1',
        status: 'SCHEDULED',
        scheduled_at: new Date('2026-09-30T02:34:00.000Z'),
        completed_at: null,
        cancelled_at: null,
        created_at: new Date('2026-09-01'),
        location_id: null,
        location_address_line1: null,
        location_city: null,
        location_state: null,
        location: null,
        assignees: [],
      },
    ],
    commission_owner: null,
    service_location: null,
    created_at: new Date('2026-09-01'),
    contacted_at: null,
    walkthrough_first_booked_at: null,
    last_visit_completed_at: null,
    first_estimate_sent_at: null,
    ...overrides,
  } as any;
}

/** A job whose ServiceLocation carries nothing renderable — `service_location_id` is NOT NULL on
 *  `model Job`, so this, not a job without a location, is the state {{job.address}} empties on. */
function bareJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    job_type: null,
    scope_notes: null,
    sub_status: null,
    completed_at: null,
    customer: COMPANY_CUSTOMER,
    service_location: { address_line1: '', city: '', state: '' },
    visits: [],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_NO_PHONE);
  mockPrisma.lead.findFirst.mockResolvedValue(bareLeadRow());
  mockPrisma.job.findFirst.mockResolvedValue(bareJobRow());
});

async function leadCtx(dedupeKey = 'k') {
  const r = await loadExecutionBundle({ entityType: 'lead', entityId: LEAD_ID, organizationId: ORG, dedupeKey });
  return r!.bundle.mergeCtx;
}
async function jobCtx(dedupeKey = 'k') {
  const r = await loadExecutionBundle({ entityType: 'job', entityId: JOB_ID, organizationId: ORG, dedupeKey });
  return r!.bundle.mergeCtx;
}

// ── the captured send ───────────────────────────────────────────────────────

describe('D7 — the 2026-09-12 staging send', () => {
  /**
   * Of the four defects in that capture, TWO are value defects and are fixed for good here: the
   * company customer had no name under any field, and {{lead.name}} shipped its separator without
   * a left operand. Both are answered with real data off the record, so they read correctly in
   * any sentence.
   *
   * The other three — address, job type, main line — are ABSENT DATA, and the builders no longer
   * invent words for any of them (Ran, 2026-09-14; the address and phone families followed on
   * 2026-09-15). The standby wording is the step's "If empty, fill with" instead, so the sentence
   * is whole only when RENDERED THE WAY A SEEDED STEP RENDERS IT — asserting off the raw context
   * would assert against something that was never sent to anybody.
   *
   * {{lead.job_type}} is the one of the three with no seeded default yet — the deliberate interim
   * state, not an oversight — so it is also the field that shows an author's own box closing a
   * hole the shipped defaults do not.
   */
  it('fixes the two NAME defects in that subject, and fills the absent three from the step', async () => {
    const ctx = await leadCtx();

    // Fixed, by value substitution — never by a phrase.
    expect(ctx['customer.full_name']).toBe('Harbor Cabinet Co');
    expect(ctx['lead.name']).toBe('Harbor Cabinet Co — QA0912-B no address lead');

    // Absent data stays absent. '' and not undefined: a field this module skipped would print
    // `{{lead.address}}` verbatim in the inbox, which is the worse half of the trap.
    for (const field of ['lead.address', 'lead.job_type', 'org.phone']) {
      expect(ctx, `${field} must be written even when it has no value`).toHaveProperty(field);
      expect(ctx[field]).toBe('');
    }

    // The two that DO carry a seeded default are already whole with nothing typed by anybody,
    // which is what every organisation that never opened the step editor reads.
    expect(seeded('lead.address', ctx).trim()).not.toBe('');
    expect(seeded('org.phone', ctx).trim()).not.toBe('');

    // And every one of the three is REACHABLE by the author's own map — the whole point of
    // resolving to '' rather than to a phrase, and the author's text beats the seeded default.
    const subject = renderMergeFields(
      'Please meet us at {{lead.address}}. Job type: {{lead.job_type}}. Call {{org.phone}}.',
      ctx,
      { html: false, fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS, 'lead.address': 'the address we have for you', 'lead.job_type': 'your appointment', 'org.phone': 'the number in your confirmation' } },
    );
    expect(subject).toBe('Please meet us at the address we have for you. Job type: your appointment. Call the number in your confirmation.');
    expect(subject).not.toContain('{{');
  });
});

// ── customer identity ───────────────────────────────────────────────────────

describe('D7 — customer name fields', () => {
  it('renders a COMPANY customer under full_name instead of joining two nulls', async () => {
    // The worst of the group: `[first, last].join(' ')` is '' for every B2B customer, and
    // {{customer.full_name}} is what the seeded staff automations identify the account by.
    expect((await leadCtx())['customer.full_name']).toBe('Harbor Cabinet Co');
  });

  it('greets a company by its name rather than "Hi ,"', async () => {
    const ctx = await leadCtx();
    expect(renderMergeFields('Hi {{customer.first_name}},', ctx, { html: false })).toBe('Hi Harbor Cabinet Co,');
    expect(ctx['customer.last_name']).toBe('Harbor Cabinet Co');
  });

  it('prefers a person’s own first name over the company they belong to', async () => {
    // The ladder must not shadow the common case: a named contact at a company is still greeted
    // by name. Company is the RUNG BELOW, not an override.
    mockPrisma.lead.findFirst.mockResolvedValue(
      bareLeadRow({ customer: { ...COMPANY_CUSTOMER, first_name: 'Sarah', last_name: 'Mitchell' } }),
    );
    const ctx = await leadCtx('k-person');
    expect(ctx['customer.first_name']).toBe('Sarah');
    expect(ctx['customer.last_name']).toBe('Mitchell');
    // full_name still leads with the company, which is how this product has always labelled a
    // customer (lib/tasks/enrich.ts customerLabel) — the task list and the pickers agree.
    expect(ctx['customer.full_name']).toBe('Harbor Cabinet Co');
  });

  it('falls back to the customer number for full_name, and to the seeded greeting for first_name', async () => {
    // A PERSON row with no name at all. The two fields diverge here on purpose: full_name
    // IDENTIFIES a record in staff copy, so a real number beats a phrase; first_name GREETS
    // somebody, and "Hi C00019," is not a greeting. The greeting word is the step's seeded
    // fallback, not the builder's: the raw context is '' and the rendered field says "there".
    mockPrisma.lead.findFirst.mockResolvedValue(
      bareLeadRow({
        customer: { ...COMPANY_CUSTOMER, kind: 'PERSON', company_name: null, first_name: null, last_name: null },
      }),
    );
    const ctx = await leadCtx('k-nameless');
    expect(ctx['customer.full_name']).toBe('C00019');
    expect(ctx['customer.first_name']).toBe('');
    expect(seeded('customer.first_name', ctx)).toBe('there');
  });

  it('treats a whitespace-only company name as no name at all', async () => {
    // ' ' is truthy, joins to ' ', and renders "Hi  ," — the same hole with whitespace in it.
    mockPrisma.lead.findFirst.mockResolvedValue(
      bareLeadRow({ customer: { ...COMPANY_CUSTOMER, company_name: '   ' } }),
    );
    expect((await leadCtx('k-blank'))['customer.full_name']).toBe('C00019');
  });
});

// ── lead.name ───────────────────────────────────────────────────────────────

describe('D7 — lead.name', () => {
  it('does not ship the separator without its left operand', async () => {
    // The captured value was " — QA0912-B no address lead": the old ternary keyed only off the
    // request, so a customer half resolving to '' still printed the em-dash.
    const name = (await leadCtx())['lead.name'];
    expect(name).toBe('Harbor Cabinet Co — QA0912-B no address lead');
    expect(name.startsWith(' ')).toBe(false);
    expect(name.trimStart().startsWith('—')).toBe(false);
  });

  it('renders the request alone when there is no customer to name', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(bareLeadRow({ customer: null }));
    const name = (await leadCtx('k-nocust'))['lead.name'];
    expect(name).toBe('QA0912-B no address lead');
    expect(name).not.toContain('—');
  });

  it('renders the customer alone when there is no service request', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(bareLeadRow({ service_request: null }));
    const name = (await leadCtx('k-noreq'))['lead.name'];
    expect(name).toBe('Harbor Cabinet Co');
    expect(name).not.toContain('—');
  });

  it('resolves to a clean empty rather than a lone separator when it has neither half', async () => {
    // '' is the correct answer here, and the assertion that matters is that it is CLEAN: the
    // captured bug was ' — QA0912-B no address lead', a separator with no left operand, so a
    // stray '—' or an edge space is the regression to catch, not the emptiness.
    mockPrisma.lead.findFirst.mockResolvedValue(bareLeadRow({ customer: null, service_request: '   ' }));
    const name = (await leadCtx('k-neither'))['lead.name'];
    expect(name).toBe('');
    expect(name).not.toContain('—');
  });
});

// ── addresses and phones: the pairs that must agree ─────────────────────────

describe('D7 — the fields that must answer identically', () => {
  /**
   * BOTH LAYERS, and that is the point of the pair rather than belt-and-braces.
   *
   * Since 2026-09-15 these fields resolve '' and the seeded fallback supplies the words, so the
   * agreement has two halves and each can break without the other. Equal-and-empty in the context
   * is what `context.ts` guarantees - ONE resolution, used twice - and equal-and-whole after
   * rendering is what the customer reads. Assert only the second and a builder that stopped
   * sharing the resolution still passes, because the two defaults happen to match; assert only
   * the first and a missing default renders "Please meet us at ." and passes too.
   */
  it('makes lead.address say exactly what lead.walkthrough_location says', async () => {
    const ctx = await leadCtx();
    expect(ctx['lead.address']).toBe(ctx['lead.walkthrough_location']);
    expect(seeded('lead.address', ctx).trim()).not.toBe('');
    expect(seeded('lead.address', ctx)).toBe(seeded('lead.walkthrough_location', ctx));
  });

  it('makes job.address say exactly what job.visit_location says', async () => {
    const ctx = await jobCtx();
    expect(ctx['job.address']).toBe(ctx['job.visit_location']);
    expect(seeded('job.address', ctx).trim()).not.toBe('');
    expect(seeded('job.address', ctx)).toBe(seeded('job.visit_location', ctx));
  });

  it('makes org.phone say exactly what the performer phone fields say', async () => {
    // The seeded walkthrough confirmation carries BOTH in one body: "{{lead.performer_names}}
    // will be there. Questions? Call {{org.phone}}." An org with no main line was sending
    // "Questions? Call ." — and performer_phones already said "our office" in the same email.
    const lead = await leadCtx();
    expect(lead['org.phone']).toBe(lead['lead.performer_phones']);
    expect(seeded('org.phone', lead).trim()).not.toBe('');
    expect(seeded('org.phone', lead)).toBe(seeded('lead.performer_phones', lead));

    const job = await jobCtx();
    expect(job['org.phone']).toBe(job['technician.phones']);
    expect(seeded('org.phone', job)).toBe(seeded('technician.phones', job));
  });

  it('agrees character for character once the values exist', async () => {
    // The other half of the invariant, and the one that actually reaches a customer: a real
    // address and a real main line must read the same under either token in one body, with no
    // fallback involved on either side.
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_NO_PHONE, phone: '(555) 204-7788' });
    mockPrisma.lead.findFirst.mockResolvedValue(
      bareLeadRow({ service_location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' } }),
    );
    const ctx = await leadCtx('k-bothreal');
    expect(ctx['lead.address']).toBe('88 Cedar Lane, Asheville, NC');
    expect(ctx['lead.address']).toBe(ctx['lead.walkthrough_location']);
    expect(ctx['org.phone']).toBe('(555) 204-7788');
    expect(ctx['org.phone']).toBe(ctx['lead.performer_phones']);
  });

  it('still renders a real main line when the org has one', async () => {
    // The fallback must not shadow the value — a phrase where a number exists is the inverse bug.
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_NO_PHONE, phone: '(555) 204-7788' });
    expect((await leadCtx('k-realphone'))['org.phone']).toBe('(555) 204-7788');
  });

  it('still renders a real address when the lead has one', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      bareLeadRow({ service_location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' } }),
    );
    expect((await leadCtx('k-realaddr'))['lead.address']).toBe('88 Cedar Lane, Asheville, NC');
  });
});

// ── crew ────────────────────────────────────────────────────────────────────

describe('D7 — crew fields', () => {
  it('resolves empty for a visit nobody is booked on, and the seeded fallback names the team', async () => {
    const lead = await leadCtx();
    expect(lead['lead.performer_names']).toBe('');
    expect(seeded('lead.performer_names', lead)).toBe('Our team');
    const job = await jobCtx();
    expect(job['technician.names']).toBe('');
    expect(seeded('technician.names', job)).toBe('Our team');
    expect(job['technician.first_name']).toBe('');
    expect(seeded('technician.first_name', job)).toBe('Our technician');
  });

  it('gives the same answer through the per-visit override', async () => {
    // visitMergeFields is written by the dispatch sites and spread OVER the entity context, so a
    // hole here reaches the customer even when the arm above is correct.
    // The sixth argument is {{technician.servwave_phones}} (slice 7), required so every dispatch
    // site states its answer rather than inheriting one. '' here for the same reason the main line
    // above is '': this suite's subject is what a field resolves to when there is NOTHING on file,
    // and the words a customer reads come from the step's seeded fallback, asserted through
    // `seeded` below.
    const fields = visitMergeFields({ scheduled_at: null }, [], 'America/New_York', 'somewhere', '', '');
    expect(fields['technician.names']).toBe('');
    expect(seeded('technician.names', fields)).toBe('Our team');
    expect(fields['technician.first_name']).toBe('');
    expect(seeded('technician.first_name', fields)).toBe('Our technician');
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

describe('D7 — every advertised merge field, over every entity', () => {
  /**
   * What this sweep asserts is that a field resolves to something a sentence can carry ONCE the
   * step's seeded "If empty, fill with" has been applied. A field listed below is one that
   * neither the builder nor the seeded default fills, so it reaches a real body as a hole.
   *
   * Every entry is a KNOWN, ACCEPTED hole with a named owner. Adding to this list is a decision;
   * a field that lands here by accident is the defect this file exists to catch.
   */
  /**
   * Written by a dispatch site into `event_payload` rather than by an entity load — so the load
   * legitimately does not write it, and only this is exempt from the presence assertion. It is
   * pinned at the site that does supply it.
   *
   * {{recipient.first_name}} used to sit here too. It was removed from the product outright on
   * 2026-09-15 (the builder offers one field list per TRIGGER and a trigger has no audience), so
   * there is nothing left to exempt.
   */
  const RESOLVED_ELSEWHERE = new Set([
    'event.reason',
    // Who changed a task's status and when: facts about the EVENT (a task has no "finished by"
    // column), carried by the transition dispatch's payload and pinned where it is built -
    // mergeFieldParity replays that payload, and the dispatch test asserts it.
    ...TASK_TRANSITIONS.flatMap((t) => [t.byField, t.atField]),
  ]);

  /**
   * ABSENT DATA. The builders no longer invent words for any of these (Ran, 2026-09-14, and the
   * address and phone families on 2026-09-15): the standby text belongs in the step's own "If
   * empty, fill with", where an author can word it for THEIR sentence and clear it if they want
   * the hole. `org.phone` is Ran's explicit call: an org that never entered a main line has no
   * main line, and "Acme · our office" reads worse than "Acme ·".
   *
   * THIS SET IS NOT AN EXEMPTION. The loop below asserts every member resolves to EXACTLY '', so
   * re-introducing a phrase in context.ts fails this file — an exemption that only excuses is how
   * the last hole hid. What is exempt from the emptiness sweep is the SUBSET below, and only for
   * as long as it has no seeded default.
   */
  const ABSENT_DATA = new Set([
    'org.phone',
    'lead.address', 'job.address',
    'lead.job_type', 'job.type',
    'job.scope_notes', 'task.assignee_names',
  ]);

  /**
   * The members of ABSENT_DATA that `mergeFieldFallbacks.ts` does not yet seed a default for, and
   * so the only ones a seeded send still renders as a hole. DERIVED rather than listed, so that
   * adding a default for one of them puts it straight back under the sweep instead of leaving a
   * second list to remember. The address and phone families are already out of it.
   */
  const ABSENT_DATA_WITHOUT_A_DEFAULT = [...ABSENT_DATA].filter(
    (f) => !Object.prototype.hasOwnProperty.call(DEFAULT_MERGE_FIELD_FALLBACKS, f),
  );

  const KNOWN_HOLES = new Set([
    // (a) GRAMMATICAL — no standby wording exists. "on {{job.scheduled_date}} at
    // {{job.scheduled_time}}" needs the whole clause suppressed rather than a noun dropped into
    // it, and prose in a URL slot is a dead link the customer clicks. Conditional template
    // sections close these; until then a template author must not put them in a bare sentence.
    'job.scheduled_date', 'job.scheduled_time',
    'lead.walkthrough_date', 'lead.walkthrough_time',
    'invoice.due_date', 'task.due_date',
    'estimate.link', 'invoice.link', 'task.link',

    // (b) NAMES AN EVENT, so absence means the event did not happen and there is no noun for it.
    // catalog.ts gates each to the trigger where it always resolves.
    'job.sub_status',

    // (c) ABSENT DATA WITH NO SEEDED DEFAULT YET — see ABSENT_DATA below, which also ASSERTS
    // every one of its members rather than only excusing them. The members that DO carry a
    // default are deliberately NOT exempt: they are whole in a seeded send, so the sweep goes on
    // guarding them, and the day a default is added for one of these it starts guarding that too.
    ...ABSENT_DATA_WITHOUT_A_DEFAULT,

    // (d) NOT RESOLVED BY AN ENTITY LOAD AT ALL — see RESOLVED_ELSEWHERE below.
    ...RESOLVED_ELSEWHERE,

    // (e) A task attached to nothing is the normal state; author-only, no seeded consumer.
    'task.linked_record',
  ]);

  /**
   * THE EXEMPTION, NAMED OUT LOUD AND JUSTIFIED, rather than left to whatever the filter happens
   * to yield. Two assertions, because they answer different questions and either can rot alone.
   *
   * The FIRST is the decision gate: exempting a field from the hole sweep is a choice somebody
   * has to make, so a field arriving in or leaving this set fails here and has to be looked at.
   * Seeding a default for `lead.job_type` is exactly the change that should trip it.
   *
   * The SECOND is why the exemption is safe TODAY: neither field appears in a single seeded body,
   * so no message this product ships can render the hole. That is the property that would silently
   * stop holding if somebody put {{job.type}} into seeded copy - at which point the exemption
   * would be hiding a live defect rather than recording an accepted one.
   */
  it('exempts only the two fields with no seeded default, and neither is in any seeded body', () => {
    expect(ABSENT_DATA_WITHOUT_A_DEFAULT.sort()).toEqual(['job.type', 'lead.job_type']);

    const seededCopy = DEFAULT_AUTOMATIONS.map((a) => `${a.subject ?? ''} ${a.body ?? ''}`).join(' ');
    for (const field of ABSENT_DATA_WITHOUT_A_DEFAULT) {
      expect(seededCopy, `{{${field}}} is exempt from the sweep but ships in seeded copy`)
        .not.toContain(`{{${field}}}`);
    }
  });

  const ENTITY_LOADS: Record<string, () => Promise<Record<string, string>>> = {
    lead: () => leadCtx('sweep-lead'),
    job: () => jobCtx('sweep-job'),
    estimate: async () => {
      mockPrisma.estimate.findFirst.mockResolvedValue({
        id: ESTIMATE_ID, estimate_number: 'E00108', status: 'SENT', total_amount: 0,
        valid_until: null, public_token: null, customer: COMPANY_CUSTOMER, lead: null, creator: null,
      });
      const r = await loadExecutionBundle({ entityType: 'estimate', entityId: ESTIMATE_ID, organizationId: ORG, dedupeKey: 'sweep-est' });
      return r!.bundle.mergeCtx;
    },
    invoice: async () => {
      mockPrisma.invoice.findFirst.mockResolvedValue({
        id: INVOICE_ID, invoice_number: 'I00073', status: 'SENT', total_amount: 0, amount_due: 0,
        due_date: null, public_token: null, customer: COMPANY_CUSTOMER, job: null,
      });
      const r = await loadExecutionBundle({ entityType: 'invoice', entityId: INVOICE_ID, organizationId: ORG, dedupeKey: 'sweep-inv' });
      return r!.bundle.mergeCtx;
    },
    task: async () => {
      mockPrisma.task.findFirst.mockResolvedValue({
        id: TASK_ID, task_number: 'T00042', title: 'Order the replacement thermostat',
        status: 'TODO', priority: 'LOW', due_at: null, assignee_ids: [], watcher_ids: [],
        linked_entity_type: null, linked_entity_id: null, creator: null,
      });
      mockPrisma.user.findMany.mockResolvedValue([]);
      const r = await loadExecutionBundle({ entityType: 'task', entityId: TASK_ID, organizationId: ORG, dedupeKey: 'sweep-task' });
      return r!.bundle.mergeCtx;
    },
  };

  for (const [entity, load] of Object.entries(ENTITY_LOADS)) {
    it(`resolves every ${entity} field to something a sentence can carry, on a row with nothing set`, async () => {
      const ctx = await load();
      // Read off catalog.ts's own declarations rather than a list kept here: a field advertised
      // without a fallback must fail HERE, not in somebody's inbox.
      const advertised = new Set(
        Object.values(TRIGGERS)
          .filter((t) => t.entity === entity)
          .flatMap((t) => t.mergeFields),
      );
      expect(advertised.size).toBeGreaterThan(0);

      const holes: string[] = [];
      for (const field of advertised) {
        // PRESENCE FIRST, AND OUTSIDE THE EXEMPTION. These are two different questions and an
        // exemption written for one must not silently answer the other: '' is a legitimate value
        // for an accepted hole, but a field the load never writes prints `{{lead.address}}`
        // verbatim in a customer's inbox, and that is never legitimate. Only group (d) — the
        // fields another site resolves — is exempt from presence, and it is pinned there instead.
        if (!RESOLVED_ELSEWHERE.has(field)) {
          expect(ctx, `${field} is advertised on ${entity} but never written by its load`).toHaveProperty(field);
        }
        if (KNOWN_HOLES.has(field)) continue;
        // Rendered with the seeded fallbacks: a field the builders leave '' on purpose is whole
        // only if the default set fills it, and this is where a new one without a default fails.
        if (!seeded(field, ctx).trim()) holes.push(field);
      }
      expect(holes, `${entity} fields resolving to an empty string`).toEqual([]);

      // And the inverse guarantee: a field we deliberately leave empty must actually BE empty, or
      // the author's "If empty, fill with" can never reach it. A phrase re-added upstream would
      // silently shadow every author's setting for that field — invisible without this.
      const shadowed = [...advertised]
        .filter((f) => ABSENT_DATA.has(f))
        .filter((f) => ctx[f] !== '');
      expect(shadowed, `${entity} fields carrying a phrase that shadows the author's fallback`).toEqual([]);
    });
  }
});
