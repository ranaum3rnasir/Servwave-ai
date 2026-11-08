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
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const WALKTHROUGH_AT = new Date('2026-08-01T15:00:00.000Z');

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// Walkthrough-as-entity redesign, PR-B2: merge fields lead.walkthrough_date/_time/
// performer_names, plus the leadWalkthroughScheduledAt staleness-check state, now resolve
// against the lead's CURRENT visit (D15: next upcoming SCHEDULED; else most recent that
// happened) via the `walkthroughs` relation instead of the legacy flat columns.
function currentVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w0000000-0000-0000-0000-000000000001',
    status: 'SCHEDULED',
    scheduled_at: WALKTHROUGH_AT,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-07-01'),
    assignees: [
      {
        user: {
          id: 't0000000-0000-0000-0000-000000000001',
          email: 'mike@example.com',
          first_name: 'Mike',
          last_name: 'Torres',
          phone: '+15557770001',
        },
      },
    ],
    ...overrides,
  };
}

function leadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD_ID,
    lead_number: 'L00042',
    status: 'CONTACTED',
    service_request: 'Leaking kitchen faucet',
    job_type: 'Water heater replacement',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    visits: [currentVisit()],
    commission_owner: null,
    service_location: {
      address_line1: '88 Cedar Lane',
      city: 'Asheville',
      state: 'NC',
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
});

describe('loadExecutionBundle — lead', () => {
  it('populates walkthrough state + merge fields from the current visit', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result).not.toBeNull();
    expect(result!.state.leadStatus).toBe('CONTACTED');
    expect(result!.state.leadWalkthroughScheduledAt).toEqual(WALKTHROUGH_AT);
    // org-tz formatted — assert non-empty rather than an exact string (timezone-fragile)
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).toEqual(expect.any(String));
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).not.toBe('');
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).toEqual(expect.any(String));
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).not.toBe('');
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres');
  });

  // D1/D15: a lead with a REQUESTED-only visit (never scheduled, nothing has happened) has NO
  // current visit — the date/time merge fields and the state must resolve to empty/null, not throw.
  // `lead.performer_names` is the exception and D7 is why: a date has no noun phrase that can
  // stand in "on {{lead.walkthrough_date}}", but "nobody" does have one, so the team field names
  // the group rather than rendering the hole the seeded copy sent as " will be there."
  it('resolves to empty dates and null state when the lead has no current visit', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [currentVisit({ status: 'REQUESTED', scheduled_at: null })],
    }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-none',
    });

    expect(result!.state.leadWalkthroughScheduledAt).toBeNull();
    expect(result!.bundle.mergeCtx['lead.walkthrough_date']).toBe('');
    expect(result!.bundle.mergeCtx['lead.walkthrough_time']).toBe('');
    // '' since the 2026-09-13 scheduling-notifications spec: the team wording is the step's own
    // seeded "If empty, fill with" (mergeFieldFallbacks.ts), never injected here.
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('');
    expect(result!.bundle.assignees).toEqual([]);
  });

  // D1: a lead with TWO visits — an earlier COMPLETED one and a later SCHEDULED one — must
  // resolve to the SCHEDULED one (the upcoming visit always wins over a past one).
  it('resolves to the upcoming SCHEDULED visit over an older COMPLETED one', async () => {
    const completed = currentVisit({
      id: 'w-old', status: 'COMPLETED', scheduled_at: new Date('2026-06-01T10:00:00Z'),
      completed_at: new Date('2026-06-01T11:00:00Z'),
      assignees: [{ user: { id: 'u-old', email: 'old@example.com', first_name: 'Old', last_name: 'Tech' } }],
    });
    const scheduled = currentVisit();
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ visits: [completed, scheduled] }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-two-visits',
    });

    expect(result!.state.leadWalkthroughScheduledAt).toEqual(WALKTHROUGH_AT);
    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres');
  });

  // Walkthrough automations replace built-in emails that told the customer WHERE
  // to be. Without these two the automation can only name the lead, which is the
  // one thing the customer already knows.
  it('exposes the lead’s service address and lead number as merge fields', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result!.bundle.mergeCtx['lead.address']).toBe('88 Cedar Lane, Asheville, NC');
    expect(result!.bundle.mergeCtx['lead.number']).toBe('L00042');
  });

  // D7. `Lead.service_location_id` is NULLABLE, so this is a real record rather than a degenerate
  // one, and until this was fixed the seeded walkthrough copy sent it "Please meet us at ."
  // Asserted AGAINST {{lead.walkthrough_location}} rather than against a literal: the two answer
  // the same question for the same lead, and the point of the phrase is that one email cannot
  // offer two different ones.
  it('falls back to the same phrase walkthrough_location uses when the lead has no service location', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ service_location: null }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

  // 2026-09-15 (Ran): the phrase is no longer injected by the formatter - it is the SEEDED
  // fallback for this field (mergeFieldFallbacks.ts) and the renderer applies it, so that the
  // step's "If empty, fill with" box is a control an author can use instead of one the builder
  // had already pre-empted. D7 is unchanged in what a customer reads; the assertion moves one
  // layer out, to the rendered string, which is where the guarantee now lives.
    const ctx = result!.bundle.mergeCtx;
    expect(ctx).toHaveProperty('lead.address');
    expect(ctx['lead.address']).toBe('');

    const address = seeded('lead.address', ctx);
    expect(address.trim()).not.toBe('');
    expect(address).not.toContain('{{');
    expect(address).toBe(seeded('lead.walkthrough_location', ctx));
  });

  // A lead carries the same job_type the job it converts into will carry, so the
  // walkthrough emails can name the work. Declared in LEAD_FIELDS (catalog.ts).
  it('exposes the lead’s job type as a merge field', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    expect(result!.bundle.mergeCtx['lead.job_type']).toBe('Water heater replacement');
  });

  // Same convention as lead.address directly above. Non-undefined was only half of it:
  // renderMergeFields leaves an *unknown* field literal on purpose, so a declared-but-undefined
  // field prints {{lead.job_type}} verbatim in a customer-facing email - and `?? ''` then printed
  // "Job type: ." instead, which is what the 2026-09-12 staging send actually carried (D7).
  it('resolves a clean empty, never undefined, when the lead has no job type', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ job_type: null }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    });

    // The half of the trap that still binds: PRESENT, so the token never prints itself. The
    // other half — what a reader sees in its place — is the step's own fallback to word.
    expect(result!.bundle.mergeCtx).toHaveProperty('lead.job_type');
    expect(result!.bundle.mergeCtx['lead.job_type']).toBe('');
  });

  it('joins multiple current-visit performer names with a comma, and resolves empty when none are assigned', async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce(
      leadRow({
        visits: [currentVisit({
          assignees: [
            { user: { first_name: 'Mike', last_name: 'Torres' } },
            { user: { first_name: 'Ana', last_name: 'Lee' } },
          ],
        })],
      }),
    );
    const withTwo = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });
    expect(withTwo!.bundle.mergeCtx['lead.performer_names']).toBe('Mike Torres, Ana Lee');

    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow({ visits: [currentVisit({ assignees: [] })] }));
    const withNone = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k2',
    });
    // D7, and the lead-side twin of {{technician.names}}: the seeded walkthrough confirmation says
    // "{{lead.performer_names}} will be there.", which an unassigned visit sent as " will be there."
    // ...and now resolves '' here: the seeded per-step fallback ("Our team") fills that sentence.
    expect(withNone!.bundle.mergeCtx['lead.performer_names']).toBe('');
  });

  it('maps the current visit’s performers into assignees (RecipientUser[])', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k3',
    });

    // The phone number is part of the shape now (Spec C): a text step addressed to the
    // walkthrough team has no second lookup, so a performer who loses their number
    // between here and the executor is a performer nobody can text.
    expect(result!.bundle.assignees).toEqual([
      {
        id: 't0000000-0000-0000-0000-000000000001',
        email: 'mike@example.com',
        first_name: 'Mike',
        last_name: 'Torres',
        phone: '+15557770001',
      },
    ]);
    expect(
      mockPrisma.lead.findFirst.mock.calls[0][0].include.visits.select.assignees.include.user.select.phone,
    ).toBe(true);
  });

  it('sets salesperson from the commission owner, and null when the lead has none', async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce(
      leadRow({
        commission_owner: {
          id: 'o0000000-0000-0000-0000-000000000001',
          email: 'owen@example.com',
          first_name: 'Owen',
          last_name: 'Ortiz',
        },
      }),
    );
    const withOwner = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k4',
    });
    expect(withOwner!.bundle.salesperson).toEqual({
      id: 'o0000000-0000-0000-0000-000000000001',
      email: 'owen@example.com',
      first_name: 'Owen',
      last_name: 'Ortiz',
    });

    const withoutOwner = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k5',
    });
    expect(withoutOwner!.bundle.salesperson).toBeNull();
  });
});

// ── customer extra_emails[] — opted-in secondary recipients ──────────────────
//
// The opt-out is enforced in the QUERY, not downstream: an address with
// receives_emails:false must never be loaded into the bundle at all. These assert
// the where-filter, because that filter is the whole guarantee.

describe('loadExecutionBundle — lead customer extra emails', () => {
  it('loads only the opted-in extra emails onto the bundle customer', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        customer: {
          id: 'c0000000-0000-0000-0000-000000000001',
          first_name: 'Sarah',
          last_name: 'Mitchell',
          email: 'sarah@example.com',
          phone: '+15551234567',
          extra_emails: [{ email: 'ops@example.com' }],
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-extra-emails',
    });

    expect(result!.bundle.customer!.extra_emails).toEqual([{ email: 'ops@example.com' }]);
  });

  it('narrows the customer include to receives_emails:true', async () => {
    await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-extra-emails-filter',
    });

    const arg = mockPrisma.lead.findFirst.mock.calls[0][0];
    expect(arg.include.customer.include.extra_emails).toEqual({
      where: { receives_emails: true },
      select: { email: true },
    });
  });
});

// ── lead.walkthrough_location — where the customer is actually meant to go ───
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D2/D5/D7).
//
// This is the field that lands in the customer's inbox, so the failure modes are all
// customer-visible: the wrong address, a different FORMAT from the service address it sits beside
// in the same email body, a stale snapshot of a corrected address, or a hole where an address
// should be. Every one of them is a shipping defect, so every one of them is pinned.

/** A saved company location, as the relation loads it. */
const SHOWROOM = {
  name: 'Showroom',
  address_line1: '12 Harbor St',
  city: 'Asheville',
  state: 'NC',
};

describe('loadExecutionBundle — lead.walkthrough_location', () => {
  it('renders the company location’s name and address, not the customer’s', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        visits: [currentVisit({ location_id: 'loc-1', location: SHOWROOM })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-company',
    });

    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe(
      'Showroom, 12 Harbor St, Asheville, NC',
    );
    // ...and the customer's own address is still available under its own field, unchanged. The
    // two must not have been conflated.
    expect(result!.bundle.mergeCtx['lead.address']).toBe('88 Cedar Lane, Asheville, NC');
  });

  it('follows the RELATION, so correcting the address in Settings changes an unsent reminder', async () => {
    // D2: a pointer, not a copy. Same visit row, same stored location_id - only the location's
    // own columns changed, which is exactly what an admin fixing a typo does.
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        visits: [currentVisit({
          location_id: 'loc-1',
          location: { ...SHOWROOM, address_line1: '14 Harbor St' },
        })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-corrected',
    });

    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe(
      'Showroom, 14 Harbor St, Asheville, NC',
    );
  });

  // Slice 2, and the direction the filter must NOT be applied in. Archiving takes a location out
  // of the pickers where a NEW visit is booked; it does not take the address off the trips already
  // booked there. A `where: { is_active: true }` added to this relation - the symmetric mistake to
  // forgetting it on the write path - would make the customer's confirmation fall through to their
  // own house for a meeting they were told is at the yard.
  it('still renders a location that has since been ARCHIVED, with no fall back to the service address', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        visits: [currentVisit({
          location_id: 'loc-closed',
          location: { name: 'North Yard', address_line1: '9 Depot Rd', city: 'Asheville', state: 'NC' },
        })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-archived',
    });

    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe(
      'North Yard, 9 Depot Rd, Asheville, NC',
    );
    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).not.toBe(
      result!.bundle.mergeCtx['lead.address'],
    );
  });

  // The mechanism behind the assertion above, pinned directly. That test would go on passing if
  // somebody added an is_active filter to this relation, because the mock hands the row back
  // regardless of the where clause - only reading the select itself catches it.
  it('loads the location relation with no is_active filter on it', async () => {
    await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-select',
    });

    const visits = (mockPrisma.lead.findFirst as any).mock.calls[0][0].include.visits;
    expect(visits.select.location).toBeDefined();
    expect(visits.select.location).not.toHaveProperty('where');
  });

  it('renders a one-off address in exactly the format a service address renders in', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        visits: [currentVisit({
          location_address_line1: '400 Supplier Rd',
          location_city: 'Charlotte',
          location_state: 'NC',
        })],
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-oneoff',
    });

    const oneOff = result!.bundle.mergeCtx['lead.walkthrough_location'];
    const service = result!.bundle.mergeCtx['lead.address'];
    expect(oneOff).toBe('400 Supplier Rd, Charlotte, NC');
    // Same field order, same separators - indistinguishable in an email body. Compared
    // STRUCTURALLY rather than by eyeballing the literal above, so a change to how a service
    // address formats drags this one with it instead of silently forking.
    expect(oneOff.split(', ')).toHaveLength(service.split(', ').length);
  });

  it('falls back to exactly the service address when the visit names no location', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-default',
    });

    // Adopting the field cannot make an existing automation worse (story 10): with nothing set,
    // it renders what {{lead.address}} renders, character for character.
    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe(
      result!.bundle.mergeCtx['lead.address'],
    );
    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe('88 Cedar Lane, Asheville, NC');
  });

  it('falls back to the service address when the lead has no current visit at all', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ visits: [] }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-novisit',
    });

    expect(result!.bundle.mergeCtx['lead.walkthrough_location']).toBe('88 Cedar Lane, Asheville, NC');
  });

  // D7, and the reason this field cannot use either of the usual guards. `undefined` prints
  // {{lead.walkthrough_location}} verbatim in the customer's inbox, because renderMergeFields
  // leaves an UNKNOWN field literal so typos stay visible; '' gives "Please meet us at ." Both
  // have already been sent by the time anyone notices.
  it('never resolves to undefined and never to an empty string', async () => {
    // The genuinely degenerate record: Lead.service_location_id is nullable, so a lead with no
    // service location at all is a real row, and {{lead.address}} resolves to '' for it today.
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ service_location: null, visits: [] }));

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-nothing',
    });

  // 2026-09-15 (Ran): the phrase is no longer injected by the formatter - it is the SEEDED
  // fallback for this field (mergeFieldFallbacks.ts) and the renderer applies it, so that the
  // step's "If empty, fill with" box is a control an author can use instead of one the builder
  // had already pre-empted. D7 is unchanged in what a customer reads; the assertion moves one
  // layer out, to the rendered string, which is where the guarantee now lives.
    const ctx = result!.bundle.mergeCtx;
    // Declared, so the renderer will consult a fallback for it at all, and empty, so it will.
    expect(ctx).toHaveProperty('lead.walkthrough_location');
    expect(ctx['lead.walkthrough_location']).toBe('');

    const value = seeded('lead.walkthrough_location', ctx);
    expect(value.trim()).not.toBe('');
    // A phrase, not a token: whatever it says, it must not be the raw merge field leaking through.
    expect(value).not.toContain('{{');
  });

  it('selects the location relation, or the pointer could never be followed', async () => {
    await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-loc-select',
    });

    const select = mockPrisma.lead.findFirst.mock.calls[0][0].include.visits.select;
    expect(select.location_id).toBe(true);
    expect(select.location_address_line1).toBe(true);
    expect(select.location).toBeTruthy();
  });
});

// ── TWO visits, two locations: which one does the email describe? ────────────
//
// Slice: md_files/issues/scheduling/03-book-an-additional-visit-at-its-own-location.md
//
// A lead can hold more than one live visit, and slice 3 is the slice that lets the second one sit
// somewhere else. So an automation already enrolled against this lead will, once a second visit is
// booked, start rendering the NEWER trip's address - a behaviour inherited from the date and the
// time rather than introduced here, and one the spec accepts (its "Constraints and known
// behaviours" says so in as many words). It is pinned anyway, because this is the slice that first
// makes it reachable and an unpinned inherited behaviour is discovered in a customer's inbox.
//
// WHAT IS PINNED IS THE AGREEMENT, NOT A WINNER. Naming the visit that wins would hard-code
// `resolveCurrentWalkthrough`'s rule into a second place and start lying the day that rule changes
// - a lead whose only live visit is later than a completed one, a rule that learns about all-day
// trips. The invariant that must hold for ever is narrower and is the one a customer feels: the
// date, the time and the address in one email all describe the SAME trip. An email naming Tuesday
// beside the showroom, when the showroom meeting is on Thursday, is the actual defect.
//
// The method: resolve each visit ALONE to learn what it renders, then resolve them together and
// require the triple to match one of those two exactly. Nothing here restates the resolution rule,
// so it holds whichever visit wins.

/** Where the first meeting is - one of the organisation's own places. */
const DESIGN_STUDIO = {
  name: 'Design Studio',
  address_line1: '3 Mill St',
  city: 'Asheville',
  state: 'NC',
};

const EARLIER_AT_STUDIO = {
  id: 'w0000000-0000-0000-0000-00000000000a',
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-08-04T14:00:00.000Z'),
  completed_at: null,
  cancelled_at: null,
  created_at: new Date('2026-07-01'),
  assignees: [],
  location_id: 'loc-studio',
  location: DESIGN_STUDIO,
};

/** The measure, at a supplier's premises - a one-off address, so the two render differently. */
const LATER_ONE_OFF = {
  id: 'w0000000-0000-0000-0000-00000000000b',
  status: 'SCHEDULED',
  scheduled_at: new Date('2026-08-26T18:00:00.000Z'),
  completed_at: null,
  cancelled_at: null,
  created_at: new Date('2026-07-02'),
  assignees: [],
  location_id: null,
  location: null,
  location_address_line1: '400 Supplier Rd',
  location_city: 'Charlotte',
  location_state: 'NC',
};

describe('loadExecutionBundle — a lead holding two visits at two locations', () => {
  /** The three fields an email states about the trip, from one bundle. */
  async function tripFields(visits: unknown[], dedupeKey: string) {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ visits }));
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey,
    });
    const ctx = result!.bundle.mergeCtx;
    return {
      date: ctx['lead.walkthrough_date'],
      time: ctx['lead.walkthrough_time'],
      location: ctx['lead.walkthrough_location'],
    };
  }

  it('renders the date, the time and the location of ONE visit - the same one', async () => {
    // Each alone, to learn what each renders. Nothing here asserts which of them should win.
    const studioAlone = await tripFields([EARLIER_AT_STUDIO], 'k-two-studio-alone');
    const oneOffAlone = await tripFields([LATER_ONE_OFF], 'k-two-oneoff-alone');

    // The two are genuinely distinguishable, so the assertion below cannot pass by them being the
    // same string. Without this the whole test is vacuous.
    expect(studioAlone.location).not.toBe(oneOffAlone.location);
    expect(studioAlone.date).not.toBe(oneOffAlone.date);

    // LATER ONE FIRST in the array, deliberately: `resolveCurrentWalkthrough` sorts rather than
    // taking the head, so a reader that reached for `visits[0]` for one field and the resolution
    // for another would produce a mismatched pair here and nowhere else.
    const both = await tripFields([LATER_ONE_OFF, EARLIER_AT_STUDIO], 'k-two-both');

    const matchesStudio =
      both.location === studioAlone.location && both.date === studioAlone.date
      && both.time === studioAlone.time;
    const matchesOneOff =
      both.location === oneOffAlone.location && both.date === oneOffAlone.date
      && both.time === oneOffAlone.time;

    expect(
      matchesStudio || matchesOneOff,
      `date/time/location must describe one trip, got ${JSON.stringify(both)}`,
    ).toBe(true);
  });

  it('resolves the location against the same visit the DATE resolves against', async () => {
    // The narrower statement of the slice's acceptance criterion, asserted without naming a
    // winner: whichever visit supplies the date must be the one that supplies the address.
    const both = await tripFields([LATER_ONE_OFF, EARLIER_AT_STUDIO], 'k-two-agree');
    const alone = await tripFields(
      [both.location === 'Design Studio, 3 Mill St, Asheville, NC' ? EARLIER_AT_STUDIO : LATER_ONE_OFF],
      'k-two-agree-alone',
    );

    expect(both.date).toBe(alone.date);
    expect(both.time).toBe(alone.time);
  });

  it('never falls back to the service address while a visit names a location', async () => {
    const both = await tripFields([LATER_ONE_OFF, EARLIER_AT_STUDIO], 'k-two-notservice');

    // Whichever wins, the customer is not sent to their own house: both of these visits state
    // where they are, and the fallback is for the visit that states nothing.
    expect(both.location).not.toBe('88 Cedar Lane, Asheville, NC');
  });
});

/**
 * ── Per-visit automation enrollment (spec 2026-09-14): the loader resolves the CARRIED trip ────
 *
 * Criteria 10, 12, 13 and 14 for the lead arm - the showroom-then-site shape the whole spec is
 * written around: the first meeting at the showroom, the second at the customer's house, and a
 * reminder for the second that sends them to the showroom.
 *
 * The lead half matters more than the job half, not less. There is no lead-side `visitMergeFields`
 * anywhere in the codebase, so these five fields were resolved per ENTITY on EVERY path - the
 * event-driven one included - and persisting the visit id is what fixes both at once.
 *
 * Both trips are LIVE and the carried one is the LATER: `resolveCurrentWalkthrough` takes the
 * earliest live visit, so a fixture whose carried trip is also the earliest proves nothing.
 */
describe('loadExecutionBundle — lead, per-visit resolution', () => {
  const SHOWROOM_AT = new Date('2026-08-03T13:00:00.000Z');
  const SITE_AT = new Date('2026-08-05T18:00:00.000Z');
  const SHOWROOM_VISIT = 'w0000000-0000-0000-0000-0000000000s1';
  const SITE_VISIT = 'w0000000-0000-0000-0000-0000000000s2';

  const DANA = {
    id: 't0000000-0000-0000-0000-0000000000b1',
    email: 'dana@emanuel-demo.local',
    first_name: 'Dana',
    last_name: 'Kaur',
    phone: '+15550100171',
    phone_ext: null,
  };
  const REUBEN = {
    id: 't0000000-0000-0000-0000-0000000000b2',
    email: 'reuben@emanuel-demo.local',
    first_name: 'Reuben',
    last_name: 'Falk',
    phone: '+15550100188',
    phone_ext: null,
  };

  function twoVisitLead() {
    return leadRow({
      visits: [
        currentVisit({
          id: SHOWROOM_VISIT,
          scheduled_at: SHOWROOM_AT,
          location_id: 'loc-showroom',
          location: { name: 'Design Studio', address_line1: '3 Mill St', city: 'Asheville', state: 'NC' },
          assignees: [{ user: DANA }],
        }),
        currentVisit({
          id: SITE_VISIT,
          scheduled_at: SITE_AT,
          location_id: null,
          location: null,
          location_address_line1: '402 Ridge Top Rd',
          location_city: 'Weaverville',
          location_state: 'NC',
          assignees: [{ user: REUBEN }],
        }),
      ],
    });
  }

  const load = (visitId?: string, key = 'k-lead-pervisit') =>
    loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: key,
      ...(visitId ? { visitId } : {}),
    });

  beforeEach(() => {
    mockPrisma.lead.findFirst.mockResolvedValue(twoVisitLead());
  });

  it('the two trips are genuinely distinguishable, so the assertions below can fail', async () => {
    const showroom = await load(SHOWROOM_VISIT, 'k-lead-premise-1');
    const site = await load(SITE_VISIT, 'k-lead-premise-2');

    expect(showroom!.bundle.mergeCtx['lead.walkthrough_location'])
      .not.toBe(site!.bundle.mergeCtx['lead.walkthrough_location']);
    expect(showroom!.bundle.mergeCtx['lead.walkthrough_date'])
      .not.toBe(site!.bundle.mergeCtx['lead.walkthrough_date']);
    expect(showroom!.bundle.mergeCtx['lead.performer_names'])
      .not.toBe(site!.bundle.mergeCtx['lead.performer_names']);
  });

  // Criterion 10, each of the five asserted on its own: they travel through different code, so one
  // of them silently keeping the per-entity answer is exactly what has to be catchable.
  it('renders the SITE visit for all five visit-derived fields when the enrollment carries it (criterion 10)', async () => {
    const inOrgTz = (d: Date, opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'America/New_York' }).format(d);
    const asDate = (d: Date) => inOrgTz(d, { weekday: 'short', month: 'short', day: 'numeric' });
    const asTime = (d: Date) => inOrgTz(d, { hour: 'numeric', minute: '2-digit' });

    const ctx = (await load(SITE_VISIT, 'k-lead-site'))!.bundle.mergeCtx;

    expect(ctx['lead.walkthrough_date']).toBe(asDate(SITE_AT));
    expect(ctx['lead.walkthrough_date']).not.toBe(asDate(SHOWROOM_AT));
    expect(ctx['lead.walkthrough_time']).toBe(asTime(SITE_AT));
    expect(ctx['lead.walkthrough_location']).toBe('402 Ridge Top Rd, Weaverville, NC');
    expect(ctx['lead.performer_names']).toBe('Reuben Falk');
    expect(ctx['lead.performer_phones']).toBe('(555) 010-0188');
  });

  // Criterion 12. EntityState is what anchorDateFor, stopIf and terminalStale read, and it travels
  // separately from the strings above - a test pinning the merge fields cannot see it.
  it('takes leadWalkthroughScheduledAt and leadVisitStatus from the carried trip (criterion 12)', async () => {
    const r = await load(SITE_VISIT, 'k-lead-state');

    expect(r!.state.leadWalkthroughScheduledAt).toEqual(SITE_AT);
    expect(r!.state.leadWalkthroughScheduledAt).not.toEqual(SHOWROOM_AT);
    expect(r!.state.leadVisitStatus).toBe('SCHEDULED');
  });

  it('reads the carried trip’s OWN status, even when the parent’s current visit is a different one', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(
      leadRow({
        visits: [
          currentVisit({ id: SHOWROOM_VISIT, scheduled_at: SHOWROOM_AT, assignees: [{ user: DANA }] }),
          currentVisit({ id: SITE_VISIT, status: 'CANCELLED', scheduled_at: SITE_AT, cancelled_at: SITE_AT, assignees: [{ user: REUBEN }] }),
        ],
      }),
    );

    const carried = await load(SITE_VISIT, 'k-lead-status-carried');
    const perEntity = await load(undefined, 'k-lead-status-entity');

    expect(carried!.state.leadVisitStatus).toBe('CANCELLED');
    expect(perEntity!.state.leadVisitStatus).toBe('SCHEDULED');
  });

  // Criterion 13, on the SAME two-visit fixture so it can fail.
  it('with no visit id, resolves the current walkthrough exactly as today (criterion 13)', async () => {
    const r = await load(undefined, 'k-lead-none');

    expect(r!.state.leadWalkthroughScheduledAt).toEqual(SHOWROOM_AT);
    expect(r!.bundle.mergeCtx['lead.walkthrough_location']).toBe('Design Studio, 3 Mill St, Asheville, NC');
    expect(r!.bundle.mergeCtx['lead.performer_names']).toBe('Dana Kaur');
  });

  // Criterion 14 / D4. Never a fallback: a deleted showroom trip must not make the reminder
  // quietly describe the site visit instead.
  it('returns null when the carried visit is not on the lead (criterion 14)', async () => {
    const r = await load('w0000000-0000-0000-0000-0000000000ff', 'k-lead-gone');
    expect(r).toBeNull();
  });

  it('treats a visit belonging to another organisation as gone, off a tenant-scoped read', async () => {
    const r = await load('w0000000-0000-0000-0000-0000000000ee', 'k-lead-crosstenant');
    expect(r).toBeNull();
    expect(mockPrisma.lead.findFirst.mock.calls[0][0].where).toMatchObject({ organization_id: ORG });
  });
});

// SRVW-303 - the lead owner as a merge field, so a walkthrough confirmation can be signed by
// the person the customer actually met rather than by {{org.name}}.
describe('loadExecutionBundle - lead owner merge fields', () => {
  it('renders the commission owner as owner_name and a trimmed owner_first_name', async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce(
      leadRow({
        commission_owner: {
          id: 'o0000000-0000-0000-0000-000000000001',
          email: 'dana@example.com',
          first_name: ' Dana ',
          last_name: 'Whitfield',
        },
      }),
    );
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-owner',
    });
    expect(result!.bundle.mergeCtx['lead.owner_name']).toBe('Dana Whitfield');
    expect(result!.bundle.mergeCtx['lead.owner_first_name']).toBe('Dana');
  });

  it('resolves exactly empty strings for an unowned lead, and the seeded fallback signs for the team', async () => {
    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-owner-none',
    });
    const ctx = result!.bundle.mergeCtx;
    expect(ctx).toHaveProperty('lead.owner_name');
    expect(ctx['lead.owner_name']).toBe('');
    expect(ctx['lead.owner_first_name']).toBe('');
    expect(seeded('lead.owner_name', ctx)).toBe('Our team');
    expect(seeded('lead.owner_first_name', ctx)).toBe('Our team');
  });
});
