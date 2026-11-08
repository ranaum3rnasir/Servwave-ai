import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';
import { renderMergeFields } from '../renderMergeFields';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../mergeFieldFallbacks';

/**
 * What a SEEDED send actually puts in front of a customer for one field.
 *
 * Since 2026-09-15 the builders inject no words of their own for the address and phone families -
 * they resolve '' and the step's "If empty, fill with" supplies the sentence, seeded from
 * `DEFAULT_MERGE_FIELD_FALLBACKS`. So "this field never renders a hole" is a claim about the
 * RENDERED string, and asserting it off the raw context would now be asserting the opposite.
 */
function seeded(field: string, ctx: Record<string, string>): string {
  return renderMergeFields(`{{${field}}}`, ctx, {
    html: false,
    fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS },
  });
}

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const SCHEDULED_AT = new Date('2026-08-01T15:00:00.000Z');

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    scheduled_start: SCHEDULED_AT,
    job_type: 'Repair',
    scope_notes: 'Replace 40gal water heater; shut-off is in the crawlspace',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    // S8 (D6): the job's crew is the union across its trips, so the fixture states it there.
    visits: [
      {
        assignees: [
          {
            user: {
              id: 't0000000-0000-0000-0000-000000000001',
              email: 'mike@example.com',
              first_name: 'Mike',
              last_name: 'Torres',
            },
          },
        ],
      },
    ],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(jobRow());
});

describe('loadExecutionBundle — job merge fields', () => {
  // The built-in crew-assignment email carries the scope notes; without this
  // token the automation that replaces it tells the tech what to do but not what
  // the work actually is.
  it('exposes the job’s scope notes, and resolves a clean empty when unset', async () => {
    const withNotes = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-scope',
    });
    expect(withNotes!.bundle.mergeCtx['job.scope_notes']).toBe(
      'Replace 40gal water heater; shut-off is in the crawlspace',
    );

    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ scope_notes: null }));
    const without = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-scope-2',
    });
    // Written but empty. PRESENT matters on its own: an absent key prints "{{job.scope_notes}}"
    // verbatim, because renderMergeFields leaves an unknown field literal on purpose. The standby
    // wording for the seeded "Scope: {{job.scope_notes}}" belongs in that step's own "If empty,
    // fill with", not here - this module does not word another author's sentence.
    expect(without!.bundle.mergeCtx).toHaveProperty('job.scope_notes');
    expect(without!.bundle.mergeCtx['job.scope_notes']).toBe('');
  });

  // SRVW-113 — JOB_SUB_STATUS_ENTERED's merge field. Most job triggers fire on
  // a job with no sub-status set at all, so the empty case is the common one.
  it('exposes the job’s sub-status label, empty rather than undefined when unset', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ sub_status: { label: 'Waiting on parts' } }));
    const withSubStatus = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-sub-status',
    });
    expect(withSubStatus!.bundle.mergeCtx['job.sub_status']).toBe('Waiting on parts');

    const without = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-sub-status-2',
    });
    expect(without!.bundle.mergeCtx['job.sub_status']).toBe('');
  });
});

describe('loadExecutionBundle — job people', () => {
  it('populates dispatcher + salesperson from a job that has both', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        dispatcher: {
          id: 'd0000000-0000-0000-0000-000000000001',
          email: 'dana@example.com',
          first_name: 'Dana',
          last_name: 'Chu',
        },
        salesperson: {
          id: 's0000000-0000-0000-0000-000000000001',
          email: 'sam@example.com',
          first_name: 'Sam',
          last_name: 'Lee',
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });

    expect(result!.bundle.dispatcher).toEqual({
      id: 'd0000000-0000-0000-0000-000000000001',
      email: 'dana@example.com',
      first_name: 'Dana',
      last_name: 'Chu',
    });
    expect(result!.bundle.salesperson).toEqual({
      id: 's0000000-0000-0000-0000-000000000001',
      email: 'sam@example.com',
      first_name: 'Sam',
      last_name: 'Lee',
    });
  });

  it('falls back to the linked lead owner when job.salesperson_id is null', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        salesperson: null,
        estimate: {
          lead: {
            commission_owner: {
              id: 'o0000000-0000-0000-0000-000000000001',
              email: 'owen@example.com',
              first_name: 'Owen',
              last_name: 'Ortiz',
            },
          },
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k2',
    });

    expect(result!.bundle.salesperson).toEqual({
      id: 'o0000000-0000-0000-0000-000000000001',
      email: 'owen@example.com',
      first_name: 'Owen',
      last_name: 'Ortiz',
    });
  });

  it('prefers job.salesperson_id over the lead owner when both are present', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        salesperson: {
          id: 's0000000-0000-0000-0000-000000000001',
          email: 'sam@example.com',
          first_name: 'Sam',
          last_name: 'Lee',
        },
        estimate: {
          lead: {
            commission_owner: {
              id: 'o0000000-0000-0000-0000-000000000001',
              email: 'owen@example.com',
              first_name: 'Owen',
              last_name: 'Ortiz',
            },
          },
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k3',
    });

    expect(result!.bundle.salesperson!.id).toBe('s0000000-0000-0000-0000-000000000001');
  });

  it('is null when neither job.salesperson_id nor a linked lead owner exists', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ salesperson: null, estimate: null }));

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k4',
    });

    expect(result!.bundle.salesperson).toBeNull();
  });

  it('is null when the job has no estimate/lead and no direct salesperson (dispatcher likewise null)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k5',
    });

    expect(result!.bundle.dispatcher).toBeNull();
    expect(result!.bundle.salesperson).toBeNull();
  });

  it('keeps assignees as the job crew (unaffected by the new people fields)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k6',
    });

    expect(result!.bundle.assignees).toEqual([
      {
        id: 't0000000-0000-0000-0000-000000000001',
        email: 'mike@example.com',
        first_name: 'Mike',
        last_name: 'Torres',
      },
    ]);
  });
});

// The removed-technician's identity survives every WAIT step (context.ts
// re-loads fresh every step, but the removed person is off the LIVE crew by
// then) only if it's carried through the enrollment's persisted event_payload
// and merged back in here on every load.
describe('loadExecutionBundle — event payload', () => {
  it('exposes eventPayload.recipient as bundle.eventRecipient', async () => {
    const removed = { id: 'r1', email: 'removed@example.com', first_name: 'Priya', last_name: 'Nair', phone: '+15550000011' };
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload',
      eventPayload: { recipient: removed },
    });
    expect(result!.bundle.eventRecipient).toEqual(removed);
  });

  // An enrollment created BEFORE `phone` joined RecipientUser is parked at a WAIT with a
  // recipient object that has no phone key at all. Prisma's Json column is structurally
  // `any`, so nothing downstream would have caught the difference between "no number on
  // file" and "this payload predates the field" - and `undefined` reads as the second
  // everywhere the executor looks. It is normalized to null once, here, at the JSON seam.
  it('normalizes a replayed in-flight event payload with NO phone key to a null phone, never undefined', async () => {
    const legacyPayloadRecipient = { id: 'r1', email: 'removed@example.com', first_name: 'Priya', last_name: 'Nair' };
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-legacy',
      // Exactly what JSON.parse of a pre-Spec-C enrollment's event_payload yields.
      eventPayload: { recipient: legacyPayloadRecipient } as never,
    });
    expect(result!.bundle.eventRecipient).toEqual({ ...legacyPayloadRecipient, phone: null });
    expect(result!.bundle.eventRecipient).toHaveProperty('phone', null);
  });

  it('bundle.eventRecipient is null when no eventPayload is given (every existing trigger)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-2',
    });
    expect(result!.bundle.eventRecipient).toBeNull();
  });

  it('merges eventPayload.mergeFields into mergeCtx, without clobbering entity-derived fields it does not name', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-3',
      eventPayload: { mergeFields: { 'event.reason': 'Customer requested reschedule' } },
    });
    expect(result!.bundle.mergeCtx['event.reason']).toBe('Customer requested reschedule');
    expect(result!.bundle.mergeCtx['job.number']).toBe('J00042');
  });

  // Rule 0's other survivor. The acting user is written once at enrollment and
  // re-applied on EVERY load, which is what makes the exclusion hold across a
  // multi-day WAIT - advanceEnrollment takes only an id, so nothing in memory
  // can carry it.
  it('reapplies the enrollment’s persisted actor onto the bundle on every load', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-4',
      eventPayload: { actorId: 'actor-1' },
    });
    expect(result!.bundle.actorId).toBe('actor-1');
  });

  it('bundle.actorId is null when the payload carries no actor (cron sweeps, webhooks, public doors)', async () => {
    const none = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-5',
    });
    expect(none!.bundle.actorId).toBeNull();

    // …and an enrollment created BEFORE this shipped: a payload with the other
    // keys but no actorId must load, not throw (the deploy-window gap).
    const legacy = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-6',
      eventPayload: { mergeFields: { 'event.reason': 'r' } },
    });
    expect(legacy!.bundle.actorId).toBeNull();
  });
});

// ── job.visit_location — where the customer is actually meant to go ──────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D2/D5/D7).
// Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
//
// The job half of the pair, resolving against the SAME visit `job.scheduled_date` resolves
// against - a second notion of "which trip" would let one email name one visit's date beside
// another visit's address. Every failure mode here lands in a customer's inbox: the wrong address,
// a different FORMAT from the service address sitting beside it in the same body, a stale snapshot
// of an address since corrected, or a hole where an address should be.

/** A saved company location, as the relation loads it. */
const YARD = {
  name: 'North Yard',
  address_line1: '9 Depot Rd',
  city: 'Raleigh',
  state: 'NC',
};

/** A live, upcoming visit - the one `resolveNextJobVisit` picks. */
function liveVisit(over: Record<string, unknown> = {}) {
  return {
    id: 'v0000000-0000-0000-0000-000000000001',
    status: 'SCHEDULED',
    scheduled_at: SCHEDULED_AT,
    scheduled_end: new Date('2026-08-01T17:00:00.000Z'),
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-07-01'),
    assignees: [],
    location_id: null,
    location: null,
    location_address_line1: null,
    location_city: null,
    location_state: null,
    ...over,
  };
}

describe('loadExecutionBundle — job.visit_location', () => {
  it('renders the company location’s name and address, not the customer’s', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({ visits: [liveVisit({ location_id: 'loc-yard', location: YARD })] }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-company',
    });

    expect(result!.bundle.mergeCtx['job.visit_location']).toBe('North Yard, 9 Depot Rd, Raleigh, NC');
    // ...and the customer's own address is still available under its own field, unchanged. The
    // two must not have been conflated - that is the whole reason the field exists.
    expect(result!.bundle.mergeCtx['job.address']).toBe('123 Main St, Raleigh, NC');
  });

  it('follows the RELATION, so correcting the address in Settings changes an unsent reminder', async () => {
    // D2: a pointer, not a copy. Same visit row, same stored location_id - only the location's own
    // columns changed, which is exactly what an admin fixing a typo does.
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({
        visits: [liveVisit({ location_id: 'loc-yard', location: { ...YARD, address_line1: '11 Depot Rd' } })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-corrected',
    });

    expect(result!.bundle.mergeCtx['job.visit_location']).toBe('North Yard, 11 Depot Rd, Raleigh, NC');
  });

  it('still renders a location that has since been ARCHIVED', async () => {
    // Slice 2, and the direction the filter must NOT be applied in. Archiving takes a location out
    // of the pickers where a NEW visit is booked; it does not take the address off the trips
    // already booked there. An `is_active: true` on this relation - the symmetric mistake to
    // forgetting it on the write path - would send the customer to their own house for a job
    // visit they were told is at the yard.
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({ visits: [liveVisit({ location_id: 'loc-closed', location: YARD })] }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-archived',
    });

    expect(result!.bundle.mergeCtx['job.visit_location']).toBe('North Yard, 9 Depot Rd, Raleigh, NC');
    expect(result!.bundle.mergeCtx['job.visit_location']).not.toBe(result!.bundle.mergeCtx['job.address']);
  });

  it('loads the location relation, with no is_active filter on it', async () => {
    // The mechanism behind the assertion above, pinned directly: the mock hands the row back
    // regardless of any where clause, so only reading the select itself catches a filter added
    // here. And without the relation loaded at all the pointer could never be followed - the
    // formatter would fall through to the service address, which is the one wrong answer that
    // reads as correct.
    await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-select',
    });

    const visits = mockPrisma.job.findFirst.mock.calls[0][0].include.visits;
    expect(visits.include.location).toBeTruthy();
    expect(visits.include.location).not.toHaveProperty('where');
  });

  it('renders a one-off address in exactly the format a service address renders in', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({
        visits: [liveVisit({
          location_address_line1: '400 Supplier Rd',
          location_city: 'Charlotte',
          location_state: 'NC',
        })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-oneoff',
    });

    const oneOff = result!.bundle.mergeCtx['job.visit_location'];
    const service = result!.bundle.mergeCtx['job.address'];
    expect(oneOff).toBe('400 Supplier Rd, Charlotte, NC');
    // Same field order, same separators - indistinguishable in an email body. Compared
    // STRUCTURALLY rather than by eyeballing the literal above, so a change to how a service
    // address formats drags this one with it instead of silently forking.
    expect(oneOff.split(', ')).toHaveLength(service.split(', ').length);
  });

  it('falls back to exactly the service address when the visit names no location', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits: [liveVisit()] }));

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-default',
    });

    // Story 10: adopting the field cannot make an existing automation worse. With nothing set it
    // renders what {{job.address}} renders, character for character - NOT an empty string, and
    // not a second derivation of the same address free to drift from it.
    expect(result!.bundle.mergeCtx['job.visit_location']).toBe(result!.bundle.mergeCtx['job.address']);
    expect(result!.bundle.mergeCtx['job.visit_location']).toBe('123 Main St, Raleigh, NC');
  });

  it('falls back to the service address when the job holds no live visit at all', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits: [] }));

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-novisit',
    });

    expect(result!.bundle.mergeCtx['job.visit_location']).toBe('123 Main St, Raleigh, NC');
  });

  it('never resolves to undefined and never to an empty string', async () => {
    // D7, and the reason this field can use neither of the usual guards. `undefined` prints
    // {{job.visit_location}} verbatim in the customer's inbox, because renderMergeFields leaves an
    // UNKNOWN field literal so typos stay visible; `?? ''` gives "Please meet us at ." Both have
    // already been sent by somebody.
    //
    // THE DEGENERATE RECORD THIS ACTUALLY DESCRIBES is a service location whose address columns
    // are blank, NOT a job without one. `model Job` declares `service_location_id String` - NOT
    // NULL, and Postgres agrees - so a job with no service location cannot exist; that is Lead
    // and Estimate, where the column is `String?`. A ServiceLocation row CAN hold '' in
    // address_line1/city/state, and `[..].filter(Boolean).join(', ')` then makes {{job.address}}
    // resolve to '' for that job, which is the state this guarantee is about.
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({ service_location: { address_line1: '', city: '', state: '' }, visits: [] }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-jobloc-nothing',
    });

    // The premise, stated rather than assumed: this row's service location really does carry
    // nothing renderable, so {{job.address}} has no address of its own to offer.
  // 2026-09-15 (Ran): the phrase is no longer injected by the formatter - it is the SEEDED
  // fallback for this field (mergeFieldFallbacks.ts) and the renderer applies it, so that the
  // step's "If empty, fill with" box is a control an author can use instead of one the builder
  // had already pre-empted. D7 is unchanged in what a customer reads; the assertion moves one
  // layer out, to the rendered string, which is where the guarantee now lives.
    const ctx = result!.bundle.mergeCtx;

    // Resolved, not absent. `undefined` is the other half of the trap - it prints
    // {{job.visit_location}} verbatim in a customer's inbox, because renderMergeFields leaves an
    // UNKNOWN field literal so typos stay visible - and only a declared key gets a fallback.
    expect(ctx).toHaveProperty('job.address');
    expect(ctx).toHaveProperty('job.visit_location');
    expect(ctx['job.address']).toBe('');
    expect(ctx['job.visit_location']).toBe('');

    // What the customer actually reads: a phrase, the same one for both fields, never a hole and
    // never the raw token. The pair still cannot answer one absent address two ways.
    const address = seeded('job.address', ctx);
    const location = seeded('job.visit_location', ctx);
    expect(address.trim()).not.toBe('');
    expect(address).toBe(location);
    expect(address).not.toContain('{{');
  });

  it('resolves the location against the same visit the DATE resolves against', async () => {
    // A job holding two live trips in two places. Nothing here names a winner - that would
    // hard-code resolveNextJobVisit's rule into a second place and start lying the day it changes.
    // The invariant a customer actually feels is narrower: the date and the address in one email
    // describe the SAME trip.
    const earlierAtYard = liveVisit({
      id: 'v-early',
      scheduled_at: new Date('2026-08-01T15:00:00.000Z'),
      scheduled_end: new Date('2026-08-01T17:00:00.000Z'),
      location_id: 'loc-yard',
      location: YARD,
    });
    const laterOneOff = liveVisit({
      id: 'v-late',
      scheduled_at: new Date('2026-08-20T15:00:00.000Z'),
      scheduled_end: new Date('2026-08-20T17:00:00.000Z'),
      location_address_line1: '400 Supplier Rd',
      location_city: 'Charlotte',
      location_state: 'NC',
    });

    async function tripFields(visits: unknown[], key: string) {
      mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits }));
      const r = await loadExecutionBundle({
        entityType: 'job', entityId: JOB_ID, organizationId: ORG, dedupeKey: key,
      });
      return {
        date: r!.bundle.mergeCtx['job.scheduled_date'],
        time: r!.bundle.mergeCtx['job.scheduled_time'],
        location: r!.bundle.mergeCtx['job.visit_location'],
      };
    }

    const yardAlone = await tripFields([earlierAtYard], 'k-jobloc-yard-alone');
    const oneOffAlone = await tripFields([laterOneOff], 'k-jobloc-oneoff-alone');
    // The two are genuinely distinguishable, so the assertion below cannot pass by them being the
    // same string. Without this the whole test is vacuous.
    expect(yardAlone.location).not.toBe(oneOffAlone.location);
    expect(yardAlone.date).not.toBe(oneOffAlone.date);

    // LATER ONE FIRST in the array, deliberately: resolveNextJobVisit sorts rather than taking the
    // head, so a reader reaching for `visits[0]` for one field and the resolution for another
    // produces a mismatched pair here and nowhere else.
    const both = await tripFields([laterOneOff, earlierAtYard], 'k-jobloc-both');
    const matchesYard = both.location === yardAlone.location && both.date === yardAlone.date
      && both.time === yardAlone.time;
    const matchesOneOff = both.location === oneOffAlone.location && both.date === oneOffAlone.date
      && both.time === oneOffAlone.time;

    expect(
      matchesYard || matchesOneOff,
      `date/time/location must describe one trip, got ${JSON.stringify(both)}`,
    ).toBe(true);
    // And neither trip's address is the customer's own house: both state where they are.
    expect(both.location).not.toBe('123 Main St, Raleigh, NC');
  });
});

/**
 * ── Per-visit automation enrollment (spec 2026-09-14): the loader resolves the CARRIED trip ────
 *
 * Criteria 9, 11, 13 and 14 for the job arm.
 *
 * Every fixture below holds TWO live trips at two times, in two places, with two different crews,
 * and the carried trip is the LATER one - the one `resolveNextJobVisit` would never pick. That is
 * not decoration: with a single visit "the triggering trip" and "the parent's next trip" are the
 * same row, every assertion passes on unfixed code, and the test proves nothing. The pre-existing
 * parity sweep had exactly that flaw.
 */
describe('loadExecutionBundle — job, per-visit resolution', () => {
  const DAY_ONE = new Date('2026-08-03T13:00:00.000Z');
  const DAY_THREE = new Date('2026-08-05T18:00:00.000Z');
  const SHOWROOM = { name: 'North Yard', address_line1: '9 Depot Rd', city: 'Raleigh', state: 'NC' };
  const DEPOT = { name: 'South Shop', address_line1: '88 Granite Way', city: 'Durham', state: 'NC' };

  const LENA = {
    id: 't0000000-0000-0000-0000-0000000000a1',
    email: 'lena@emanuel-demo.local',
    first_name: 'Lena',
    last_name: 'Ortiz',
    phone: '+15550100142',
    phone_ext: '214',
  };
  const MARCUS = {
    id: 't0000000-0000-0000-0000-0000000000a2',
    email: 'marcus@emanuel-demo.local',
    first_name: 'Marcus',
    last_name: 'Webb',
    phone: '+15550100199',
    phone_ext: null,
  };

  const VISIT_DAY_ONE = 'v0000000-0000-0000-0000-0000000000d1';
  const VISIT_DAY_THREE = 'v0000000-0000-0000-0000-0000000000d3';

  function twoTripJob() {
    return jobRow({
      visits: [
        liveVisit({
          id: VISIT_DAY_ONE,
          scheduled_at: DAY_ONE,
          scheduled_end: new Date('2026-08-03T15:00:00.000Z'),
          location_id: 'loc-yard',
          location: SHOWROOM,
          assignees: [{ user: LENA }],
        }),
        liveVisit({
          id: VISIT_DAY_THREE,
          scheduled_at: DAY_THREE,
          scheduled_end: new Date('2026-08-05T20:00:00.000Z'),
          location_id: 'loc-shop',
          location: DEPOT,
          assignees: [{ user: MARCUS }],
        }),
      ],
    });
  }

  const load = (visitId?: string, key = 'k-pervisit') =>
    loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: key,
      ...(visitId ? { visitId } : {}),
    });

  beforeEach(() => {
    mockPrisma.job.findFirst.mockResolvedValue(twoTripJob());
  });

  /**
   * The premise, stated before anything is asserted on top of it: the two trips really do render
   * differently. Without this the six assertions below could all pass because the fixture makes
   * day 1 and day 3 indistinguishable.
   */
  it('the two trips are genuinely distinguishable, so the assertions below can fail', async () => {
    const dayOne = await load(VISIT_DAY_ONE, 'k-pervisit-premise-1');
    const dayThree = await load(VISIT_DAY_THREE, 'k-pervisit-premise-3');

    expect(dayOne!.bundle.mergeCtx['job.scheduled_date']).not.toBe(dayThree!.bundle.mergeCtx['job.scheduled_date']);
    expect(dayOne!.bundle.mergeCtx['job.visit_location']).not.toBe(dayThree!.bundle.mergeCtx['job.visit_location']);
    expect(dayOne!.bundle.mergeCtx['technician.names']).not.toBe(dayThree!.bundle.mergeCtx['technician.names']);
  });

  // Criterion 9, each field asserted individually rather than as a bundle: they travel through
  // different code (a formatter, a join, a phone formatter with an extension), so one of them
  // silently keeping the per-entity answer is exactly the shape this has to catch.
  it('renders day 3 for every visit-derived merge field when the enrollment carries day 3 (criterion 9)', async () => {
    // Built with the same formatter the loader uses rather than a hard-coded literal: the existing
    // suites in this file call exact date strings timezone-fragile, and they are right.
    const inOrgTz = (d: Date, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'America/New_York' }).format(d);
    const asDate = (d: Date) => inOrgTz(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const asTime = (d: Date) => inOrgTz(d, { hour: 'numeric', minute: '2-digit' });

    const ctx = (await load(VISIT_DAY_THREE, 'k-pervisit-day3'))!.bundle.mergeCtx;

    expect(ctx['job.scheduled_date']).toBe(asDate(DAY_THREE));
    expect(ctx['job.scheduled_date']).not.toBe(asDate(DAY_ONE));
    expect(ctx['job.scheduled_time']).toBe(asTime(DAY_THREE));
    expect(ctx['job.scheduled_time']).not.toBe(asTime(DAY_ONE));
    expect(ctx['job.visit_location']).toBe('South Shop, 88 Granite Way, Durham, NC');
    expect(ctx['technician.first_name']).toBe('Marcus');
    expect(ctx['technician.names']).toBe('Marcus Webb');
    expect(ctx['technician.phones']).toBe('(555) 010-0199');
  });

  // Criterion 11. EntityState travels separately from the merge fields - it feeds anchorDateFor
  // (the anchored WAIT's fire moment), stopIf and terminalStale - so a test that pins the strings
  // above cannot see it and this one is not redundant.
  it('sets EntityState.jobScheduledStart to the carried trip, not the next upcoming one (criterion 11)', async () => {
    const r = await load(VISIT_DAY_THREE, 'k-pervisit-state');
    expect(r!.state.jobScheduledStart).toEqual(DAY_THREE);
    expect(r!.state.jobScheduledStart).not.toEqual(DAY_ONE);
  });

  // Criterion 13, on the SAME two-trip fixture so the assertion can fail. Every row written before
  // this shipped has no visit id and cannot get one (D10); those keep today's behaviour exactly.
  it('with no visit id, resolves the next upcoming live trip exactly as today (criterion 13)', async () => {
    const r = await load(undefined, 'k-pervisit-none');

    expect(r!.state.jobScheduledStart).toEqual(DAY_ONE);
    expect(r!.bundle.mergeCtx['job.visit_location']).toBe('North Yard, 9 Depot Rd, Raleigh, NC');
    // The job-level UNION of both trips' crews, unchanged: this is the per-entity answer.
    expect(r!.bundle.mergeCtx['technician.names']).toBe('Lena Ortiz, Marcus Webb');
  });

  // Criterion 14 / D2 / D4. No foreign key means a deleted visit leaves the id dangling, which is
  // deliberate: it makes "the trip is gone" a legible terminal state instead of the silent revert
  // to per-entity resolution that an ON DELETE SET NULL would perform - and that revert IS the
  // defect. The customer hearing nothing beats the customer hearing about a different trip.
  it('returns null when the carried visit is not on the parent, and never falls back to it (criterion 14)', async () => {
    const r = await load('v0000000-0000-0000-0000-0000000000ff', 'k-pervisit-gone');
    expect(r).toBeNull();
  });

  /**
   * A visit in ANOTHER organisation resolves to the same null by the same mechanism: the parent is
   * read with its tenant clause and the trip is then looked up among THAT job's own visits, so a
   * foreign id is simply absent. Modelled here as the tenant-scoped read finding it absent, which
   * is what a real Postgres would return.
   */
  it('treats a visit belonging to another organisation as gone, not as a reason to render the parent', async () => {
    const r = await load('v0000000-0000-0000-0000-0000000000ee', 'k-pervisit-crosstenant');
    expect(r).toBeNull();
    // And the read really was tenant-scoped, so "absent" above is the honest answer rather than a
    // fixture accident.
    expect(mockPrisma.job.findFirst.mock.calls[0][0].where).toMatchObject({ organization_id: ORG });
  });

  /**
   * A CANCELLED carried trip resolves no anchor, exactly as a job with no live trips does today.
   * The alternative - resolving it because the row still exists - would let the reminder for a
   * called-off trip sail past terminalStale's "Job is no longer scheduled" floor and reach the
   * customer, which is a regression this change must not introduce while fixing a different one.
   */
  it('a carried trip that has been CANCELLED resolves no anchor, exactly as no live trip does today', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(
      jobRow({
        visits: [
          liveVisit({ id: VISIT_DAY_ONE, scheduled_at: DAY_ONE, location_id: 'loc-yard', location: SHOWROOM, assignees: [{ user: LENA }] }),
          liveVisit({ id: VISIT_DAY_THREE, status: 'CANCELLED', scheduled_at: DAY_THREE, assignees: [{ user: MARCUS }] }),
        ],
      }),
    );

    const r = await load(VISIT_DAY_THREE, 'k-pervisit-cancelled');

    expect(r).not.toBeNull();
    expect(r!.state.jobScheduledStart).toBeNull();
    // And emphatically NOT day one's: a cancelled trip must not borrow a live one's details.
    expect(r!.state.jobScheduledStart).not.toEqual(DAY_ONE);
  });
});

// SRVW-303 - the person who sold the job, as a merge field a template can sign with. "Owner"
// is the word the lead form, the assign popover and the leads table already use; the bundle's
// `salesperson` is the same person, resolved the same way, but it only ever reached the
// audience resolver - no body could render it.
describe('loadExecutionBundle - job owner merge fields', () => {
  const OWNER = {
    id: 'o0000000-0000-0000-0000-000000000001',
    email: 'dana@example.com',
    first_name: ' Dana ',
    last_name: 'Whitfield',
    phone: null,
  };

  async function ownerFields(overrides: Record<string, unknown>, key: string) {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(overrides));
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: key,
    });
    const ctx = result!.bundle.mergeCtx;
    return { name: ctx['job.owner_name'], first: ctx['job.owner_first_name'], bundle: result!.bundle };
  }

  it('renders the job’s own salesperson, full name and trimmed first name', async () => {
    const { name, first } = await ownerFields({ salesperson: OWNER }, 'k-owner-direct');
    expect(name).toBe('Dana Whitfield');
    expect(first).toBe('Dana');
  });

  it('falls back to the lead owner through the estimate when the job carries no salesperson', async () => {
    const { name, first } = await ownerFields(
      { salesperson: null, estimate: { lead: { commission_owner: OWNER } } },
      'k-owner-estimate',
    );
    expect(name).toBe('Dana Whitfield');
    expect(first).toBe('Dana');
  });

  // A multi-estimate conversion writes `estimate_id: null` and `lead_id` on the job
  // (job.controller.ts), so the estimate rung finds nothing for exactly the jobs a cabinet
  // business converts most. The lead is on the job directly; read it there too.
  it('falls back to the job’s own lead owner when there is no estimate to walk through', async () => {
    const { name, first, bundle } = await ownerFields(
      { salesperson: null, estimate: null, lead: { commission_owner: OWNER } },
      'k-owner-lead',
    );
    expect(name).toBe('Dana Whitfield');
    expect(first).toBe('Dana');
    // The audience resolver reads the SAME person, so a "salesperson" audience on such a job
    // now reaches somebody rather than nobody.
    expect(bundle.salesperson).toEqual(OWNER);
  });

  it('resolves exactly empty strings when nobody owns the job, so the step fallback can fire', async () => {
    const { name, first } = await ownerFields(
      { salesperson: null, estimate: null, lead: null },
      'k-owner-none',
    );
    expect(name).toBe('');
    expect(first).toBe('');
    // An unsigned email is worse than one signed by the team: the seeded default carries it.
    expect(seeded('job.owner_name', { 'job.owner_name': '' })).toBe('Our team');
    expect(seeded('job.owner_first_name', { 'job.owner_first_name': '' })).toBe('Our team');
  });
});
