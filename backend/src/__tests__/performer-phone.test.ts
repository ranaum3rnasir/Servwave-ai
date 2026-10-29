/**
 * performer-phone.test.ts - the number that reaches the person coming (slice 5).
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D7)
 * Slice: md_files/issues/scheduling/05-give-the-customer-a-number-that-reaches-the-person-coming.md
 *
 * Two merge fields, one per side, and the whole of the slice is what they resolve to when the
 * obvious answer is missing. D7 forbids both usual guards: `?? ''` puts "Call us on ." in a
 * customer's inbox, and `undefined` prints `{{lead.performer_phones}}` verbatim, because
 * `renderMergeFields` deliberately leaves an UNKNOWN field literal so typos stay visible.
 *
 * THREE LAYERS, because no one of them can carry the claim alone:
 *
 *  1. `formatPerformerPhones` at its own seam - every rule about what a contact looks like and
 *     which fallback applies, with no database in the way.
 *  2. `loadExecutionBundle`'s two arms - that the right PEOPLE reach the formatter (the lead's
 *     current visit, the job's crew) and that the org's main line is the one `{{org.phone}}`
 *     renders in the same email.
 *  3. The SELECT each arm issues. Prisma is mocked suite-wide and the mock fabricates whatever
 *     the fixture holds, so a loader that never asked Postgres for `phone_ext` would still
 *     render an extension here and drop it in production. Asserting the read's arguments is the
 *     only thing at this seam that can tell those two apart - the same argument
 *     job-visit-location.test.ts's `expectResolvesLocationUnderTenant` makes for the location
 *     relation.
 *
 * Every number below is invented in the 555 range and reaches nobody.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { loadExecutionBundle, visitMergeFields } from '../services/automations/context';
import { formatPerformerPhones, MAIN_LINE_FALLBACK } from '../services/performerPhone';
import { renderMergeFields } from '../services/automations/renderMergeFields';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../services/automations/mergeFieldFallbacks';

/** What a customer actually reads for `field`, rendered the way a seeded step renders it. */
function seeded(field: string, value: string): string {
  return renderMergeFields(`{{${field}}}`, { [field]: value }, {
    html: false,
    fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS },
  });
}

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const WALKTHROUGH_AT = new Date('2026-08-01T15:00:00.000Z');

/** The organisation's main line, spelled exactly as `{{org.phone}}` renders it. */
const MAIN_LINE = '(555) 204-7788';

/** Storage is E.164 (lib/user-phone.ts normalises at every write door); display is the product's. */
const MIKE_STORED = '+15550100142';
const MIKE_SHOWN = '(555) 010-0142';
const ANA_STORED = '+15550100177';
const ANA_SHOWN = '(555) 010-0177';

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: MAIN_LINE,
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function performer(over: Record<string, unknown> = {}) {
  return {
    user: {
      id: 't0000000-0000-0000-0000-000000000001',
      email: 'mike@example.com',
      first_name: 'Mike',
      last_name: 'Torres',
      phone: MIKE_STORED,
      phone_ext: null,
      ...over,
    },
  };
}

function leadVisit(over: Record<string, unknown> = {}) {
  return {
    id: 'w0000000-0000-0000-0000-000000000001',
    status: 'SCHEDULED',
    scheduled_at: WALKTHROUGH_AT,
    completed_at: null,
    cancelled_at: null,
    created_at: new Date('2026-07-01'),
    location_id: null,
    location_address_line1: null,
    location_city: null,
    location_state: null,
    location: null,
    assignees: [performer()],
    ...over,
  };
}

function leadRow(over: Record<string, unknown> = {}) {
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
    visits: [leadVisit()],
    commission_owner: null,
    service_location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' },
    ...over,
  } as any;
}

function jobVisit(over: Record<string, unknown> = {}) {
  return {
    id: 'v0000000-0000-0000-0000-000000000001',
    status: 'SCHEDULED',
    scheduled_at: new Date('2026-09-05T13:00:00.000Z'),
    scheduled_end: new Date('2026-09-05T15:00:00.000Z'),
    is_all_day: false,
    created_at: new Date('2026-08-20'),
    location_id: null,
    location_address_line1: null,
    location_city: null,
    location_state: null,
    location: null,
    assignees: [performer()],
    ...over,
  };
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    job_type: 'Water heater replacement',
    scope_notes: '',
    sub_status: null,
    completed_at: null,
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    service_location: { address_line1: '18 Maple Ave', city: 'Richmond', state: 'VA' },
    visits: [jobVisit()],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
  mockPrisma.job.findFirst.mockResolvedValue(jobRow());
});

// ── 1. the formatter, at its own seam ───────────────────────────────────────

describe('formatPerformerPhones - a way to reach somebody, never a hole', () => {
  it('renders the number the person has on file, in the product’s display form', () => {
    expect(formatPerformerPhones([{ phone: MIKE_STORED, phone_ext: null }], MAIN_LINE))
      .toBe(MIKE_SHOWN);
  });

  it('renders an extension attached to its number, as ONE reachable contact', () => {
    // A number and its extension are one way of reaching one person. Rendered as two
    // comma-separated values the customer reads them as two numbers and dials the second.
    expect(formatPerformerPhones([{ phone: MIKE_STORED, phone_ext: '214' }], MAIN_LINE))
      .toBe(`${MIKE_SHOWN} ext. 214`);
  });

  it('renders every person on the visit, in the order they are handed over', () => {
    expect(formatPerformerPhones(
      [{ phone: MIKE_STORED, phone_ext: '214' }, { phone: ANA_STORED, phone_ext: null }],
      MAIN_LINE,
    )).toBe(`${MIKE_SHOWN} ext. 214, ${ANA_SHOWN}`);
  });

  it('falls back to the organisation’s main line when NOBODY has a number', () => {
    expect(formatPerformerPhones([{ phone: null, phone_ext: null }], MAIN_LINE)).toBe(MAIN_LINE);
    expect(formatPerformerPhones([], MAIN_LINE)).toBe(MAIN_LINE);
  });

  it('renders the one number that exists when only SOME of the crew have one', () => {
    // The single most likely thing to get wrong here. The fallback is for nobody having a
    // number, not for anybody lacking one: falling back wholesale would send a customer to the
    // front desk when somebody on the trip is reachable directly.
    const rendered = formatPerformerPhones(
      [{ phone: null, phone_ext: null }, { phone: ANA_STORED, phone_ext: null }],
      MAIN_LINE,
    );
    expect(rendered).toBe(ANA_SHOWN);
    expect(rendered).not.toBe(MAIN_LINE);
  });

  it('drops an extension that has no number in front of it', () => {
    // An extension alone dials nothing. It is not a contact, so it does not suppress the
    // fallback either - this crew is unreachable and the main line is the honest answer.
    expect(formatPerformerPhones([{ phone: null, phone_ext: '214' }], MAIN_LINE)).toBe(MAIN_LINE);
    expect(formatPerformerPhones([{ phone: '   ', phone_ext: '214' }], MAIN_LINE)).toBe(MAIN_LINE);
  });

  it('treats a blank extension as no extension rather than as trailing punctuation', () => {
    expect(formatPerformerPhones([{ phone: MIKE_STORED, phone_ext: '  ' }], MAIN_LINE))
      .toBe(MIKE_SHOWN);
  });

  it('says one desk once when two people share a number', () => {
    expect(formatPerformerPhones(
      [{ phone: MIKE_STORED, phone_ext: null }, { phone: MIKE_STORED, phone_ext: null }],
      MAIN_LINE,
    )).toBe(MIKE_SHOWN);
    // …and two extensions behind one switchboard stay two contacts, because they are.
    expect(formatPerformerPhones(
      [{ phone: MIKE_STORED, phone_ext: '214' }, { phone: MIKE_STORED, phone_ext: '215' }],
      MAIN_LINE,
    )).toBe(`${MIKE_SHOWN} ext. 214, ${MIKE_SHOWN} ext. 215`);
  });

  // SINCE 2026-09-15 THE PHRASE IS THE STEP'S, NOT THE FORMATTER'S. `MAIN_LINE_FALLBACK` used to
  // be substituted right here, which is precisely what made the "If empty, fill with" box dead on
  // all five phone fields: `renderMergeFields` applies the author's text only when a field resolves
  // to '', and this never let it. The same words are now the seeded default for each of those
  // fields (mergeFieldFallbacks.ts), so a customer reads exactly what they read before - asserted
  // below THROUGH the renderer, which is where the guarantee now lives - and the author can change
  // them, which is asserted too and could not be written at all before this change.
  it('resolves exactly the empty string when the organisation itself has no main line', () => {
    // `Organization.phone` is nullable and free text, so '' is a reachable state, and it is the
    // state EVERY organisation is in before somebody fills the field in.
    expect(formatPerformerPhones([{ phone: null, phone_ext: null }], '')).toBe('');
    expect(formatPerformerPhones([], '   ')).toBe('');
  });

  it('still reaches the customer as the office, through the step that renders it', () => {
    const resolved = formatPerformerPhones([{ phone: null, phone_ext: null }], '');
    expect(seeded('technician.phones', resolved)).toBe(MAIN_LINE_FALLBACK);
    expect(seeded('lead.performer_phones', resolved)).toBe(MAIN_LINE_FALLBACK);
    expect(MAIN_LINE_FALLBACK.trim()).not.toBe('');
  });

  it('lets the author say something else in their own step', () => {
    const resolved = formatPerformerPhones([], '');
    const rendered = renderMergeFields('Reach us on {{technician.phones}}.', { 'technician.phones': resolved }, {
      html: false,
      fallbacks: { 'technician.phones': 'the number on your confirmation' },
    });
    expect(rendered).toBe('Reach us on the number on your confirmation.');
  });

  // The sweep the original was written for, re-pointed at the contract that replaced it. It is
  // STRICTER, not weaker: a row that joins to whitespace - "Call  ." - or to a half-joined " ext. "
  // fails `toBe('')` just as it failed `toBeTruthy()`, and now a stray phrase fails too.
  it('resolves exactly the empty string and never a token, whatever it is handed', () => {
    const cases: [{ phone: string | null; phone_ext: string | null }[], string][] = [
      [[], ''],
      [[{ phone: null, phone_ext: null }], ''],
      [[{ phone: '', phone_ext: '' }], '   '],
      [[{ phone: '   ', phone_ext: '   ' }], ''],
    ];
    for (const [crew, orgPhone] of cases) {
      const rendered = formatPerformerPhones(crew, orgPhone);
      expect(rendered, `not exactly '' for ${JSON.stringify(crew)} / ${JSON.stringify(orgPhone)}`).toBe('');
      expect(rendered).not.toContain('{{');
    }
  });
});

// ── 2. the lead arm ─────────────────────────────────────────────────────────

async function leadFields(): Promise<Record<string, string>> {
  const result = await loadExecutionBundle({
    entityType: 'lead',
    entityId: LEAD_ID,
    organizationId: ORG,
    dedupeKey: `LEAD_WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
  });
  expect(result).not.toBeNull();
  return result!.bundle.mergeCtx;
}

describe('{{lead.performer_phones}} - the walkthrough team’s own numbers', () => {
  it('renders the performer’s number, not the main line', async () => {
    const fields = await leadFields();
    expect(fields['lead.performer_phones']).toBe(MIKE_SHOWN);
    expect(fields['lead.performer_phones']).not.toBe(MAIN_LINE);
  });

  it('renders an extension attached to its number', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [leadVisit({ assignees: [performer({ phone_ext: '214' })] })],
    }));
    expect((await leadFields())['lead.performer_phones']).toBe(`${MIKE_SHOWN} ext. 214`);
  });

  it('falls back to the organisation’s main line when no performer has a number', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [leadVisit({ assignees: [performer({ phone: null, phone_ext: null })] })],
    }));
    const fields = await leadFields();
    expect(fields['lead.performer_phones']).toBe(MAIN_LINE);
    // The SAME string {{org.phone}} renders in the same email - not a second reading of the
    // column, which would be free to drift from it.
    expect(fields['lead.performer_phones']).toBe(fields['org.phone']);
  });

  it('renders the one number that exists on a two-person walkthrough', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [leadVisit({
        assignees: [
          performer({ phone: null, phone_ext: null }),
          performer({ id: 'u-ana', first_name: 'Ana', last_name: 'Lee', phone: ANA_STORED }),
        ],
      })],
    }));
    const fields = await leadFields();
    expect(fields['lead.performer_names']).toBe('Mike Torres, Ana Lee');
    expect(fields['lead.performer_phones']).toBe(ANA_SHOWN);
    expect(fields['lead.performer_phones']).not.toBe(MAIN_LINE);
  });

  it('resolves against the SAME visit the date and the team resolve against', async () => {
    // D15: the lead's current visit is the earliest live one. A phone field resolved against
    // some other visit would put one trip's date beside another trip's crew's number.
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [
        leadVisit({
          id: 'w-later',
          scheduled_at: new Date('2026-09-01T15:00:00.000Z'),
          assignees: [performer({ id: 'u-ana', first_name: 'Ana', last_name: 'Lee', phone: ANA_STORED })],
        }),
        leadVisit(),
      ],
    }));
    const fields = await leadFields();
    expect(fields['lead.performer_names']).toBe('Mike Torres');
    expect(fields['lead.performer_phones']).toBe(MIKE_SHOWN);
    expect(fields['lead.performer_phones']).not.toContain(ANA_SHOWN);
  });

  it('renders the generic office when neither the team nor the organisation has a number', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_ROW, phone: null });
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [leadVisit({ assignees: [performer({ phone: null, phone_ext: null })] })],
    }));
    const fields = await leadFields();
    // Present and empty in the context; the words are the step's. Absent would be the real defect -
    // renderMergeFields leaves an UNKNOWN field literal, so a missing key prints the token itself.
    expect(fields).toHaveProperty('lead.performer_phones');
    expect(fields['lead.performer_phones']).toBe('');
    expect(seeded('lead.performer_phones', fields['lead.performer_phones'])).toBe(MAIN_LINE_FALLBACK);
  });

  it('never resolves to an empty string or to its own token, even with no performers at all', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ visits: [leadVisit({ assignees: [] })] }));
    const fields = await leadFields();
    expect(fields['lead.performer_phones']).toBeDefined();
    expect(fields['lead.performer_phones']).not.toBe('');
    expect(fields['lead.performer_phones']).not.toContain('{{');
  });

  it('ASKS Postgres for the number and the extension', async () => {
    // The mock answers with the fixture whatever the select says, so every assertion above
    // passes just as happily against a loader that never asked for `phone_ext` - and that
    // loader drops every extension in production. This is the only assertion here that can
    // tell the two apart.
    await leadFields();
    const call = mockPrisma.lead.findFirst.mock.calls.at(-1)![0];
    const userSelect = call.include.visits.select.assignees.include.user.select;
    expect(userSelect.phone).toBe(true);
    expect(userSelect.phone_ext).toBe(true);
  });
});

// ── 3. the job arm, and why it is not the whole answer ──────────────────────

async function jobFields(): Promise<Record<string, string>> {
  const result = await loadExecutionBundle({
    entityType: 'job',
    entityId: JOB_ID,
    organizationId: ORG,
    dedupeKey: `JOB_SCHEDULED:${JOB_ID}`,
  });
  expect(result).not.toBeNull();
  return result!.bundle.mergeCtx;
}

describe('{{technician.phones}} - the crew’s own numbers', () => {
  it('renders the crew’s number, not the main line', async () => {
    const fields = await jobFields();
    expect(fields['technician.phones']).toBe(MIKE_SHOWN);
    expect(fields['technician.phones']).not.toBe(MAIN_LINE);
  });

  it('falls back to the main line for a crew with no numbers, and to the office with no main line', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({
      visits: [jobVisit({ assignees: [performer({ phone: null, phone_ext: null })] })],
    }));
    expect((await jobFields())['technician.phones']).toBe(MAIN_LINE);

    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_ROW, phone: '' });
    const fields = await jobFields();
    expect(fields).toHaveProperty('technician.phones');
    expect(fields['technician.phones']).toBe('');
    expect(seeded('technician.phones', fields['technician.phones'])).toBe(MAIN_LINE_FALLBACK);
  });

  it('never renders an empty string or its own token for a job with no crew at all', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({ visits: [jobVisit({ assignees: [] })] }));
    const fields = await jobFields();
    // The crew NAMES resolve '' by design since the 2026-09-13 scheduling-notifications spec (the
    // words are the step's "If empty, fill with"); the PHONES still fall back here, because a
    // number is not a phrase an author writes.
    expect(fields['technician.names']).toBe('');
    expect(fields['technician.phones']).not.toBe('');
    expect(fields['technician.phones']).not.toContain('{{');
  });

  it('ASKS Postgres for the number and the extension', async () => {
    await jobFields();
    const call = mockPrisma.job.findFirst.mock.calls.at(-1)![0];
    const userSelect = call.include.visits.include.assignees.include.user.select;
    expect(userSelect.phone).toBe(true);
    expect(userSelect.phone_ext).toBe(true);
  });

  /**
   * WHY THE JOB SIDE NEEDS THE PER-VISIT OVERRIDE, stated as a comparison rather than asserted
   * twice over.
   *
   * context.ts's job arm resolves ONE set of assignees: the deduped union across every trip on
   * the job. `technician.names` is built from it and IS overridden per visit by
   * `visitMergeFields` (D18), because an enrollment keyed to visit 3 that renders the union
   * names people who are not going. A phone field left OUT of that override inherits the union
   * through the plain spread in loadExecutionBundle - so the email would name this trip's crew
   * beside another trip's crew's number, which is worse than the names mismatch it sits next to:
   * the customer dials it.
   */
  it('resolves per ENTITY to the union across every trip - which is why the override exists', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({
      visits: [
        jobVisit(),
        jobVisit({
          id: 'v-second',
          assignees: [performer({ id: 'u-ana', first_name: 'Ana', last_name: 'Lee', phone: ANA_STORED })],
        }),
      ],
    }));
    const fields = await jobFields();
    expect(fields['technician.names']).toBe('Mike Torres, Ana Lee');
    expect(fields['technician.phones']).toBe(`${MIKE_SHOWN}, ${ANA_SHOWN}`);
  });
});

describe('visitMergeFields - the override an occurrence keyed to one trip carries', () => {
  const VISIT = { scheduled_at: new Date('2026-09-05T13:00:00.000Z') };
  const TZ = 'America/New_York';
  const WHERE = 'North Yard, 9 Depot Rd, Raleigh, NC';
  /**
   * The ORGANISATION'S number for this trip - a REQUIRED sixth argument since slice 7, resolved by
   * the dispatch site because it takes a database read this function cannot make.
   *
   * Deliberately a value nothing in this file expects, because what this file asserts is still the
   * PERSONAL field: every case below states it and then goes on proving that
   * {{technician.phones}} answers with the crew's own numbers regardless. A resolver that started
   * reading the wrong one would fail here on the value, not merely on the arity.
   */
  const SERVWAVE = '(555) 204-0701';

  it('renders the numbers of the crew on THIS trip, beside the names of the same crew', () => {
    const fields = visitMergeFields(
      VISIT,
      [{ first_name: 'Ana', last_name: 'Lee', phone: ANA_STORED, phone_ext: '12' }],
      TZ,
      WHERE,
      MAIN_LINE,
      SERVWAVE,
    );
    expect(fields['technician.names']).toBe('Ana Lee');
    expect(fields['technician.phones']).toBe(`${ANA_SHOWN} ext. 12`);
    // The override is a partial spread over the per-entity context, so a key that is not here
    // silently keeps the job-level union's answer. Both have to travel, in one object.
    expect(Object.keys(fields)).toContain('technician.phones');
  });

  it('falls back to the main line for a crewless trip, never to a hole', () => {
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, SERVWAVE);
    expect(fields['technician.names']).toBe('');
    expect(fields['technician.phones']).toBe(MAIN_LINE);
  });

  it('resolves empty when the organisation has no main line either, and renders as the office', () => {
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, '', SERVWAVE);
    expect(fields).toHaveProperty('technician.phones');
    expect(fields['technician.phones']).toBe('');
    expect(fields['technician.phones']).not.toContain('{{');
    expect(seeded('technician.phones', fields['technician.phones'])).toBe(MAIN_LINE_FALLBACK);
  });

  it('renders the one number that exists on a two-person crew', () => {
    const fields = visitMergeFields(
      VISIT,
      [
        { first_name: 'Mike', last_name: 'Torres', phone: null, phone_ext: null },
        { first_name: 'Ana', last_name: 'Lee', phone: ANA_STORED, phone_ext: null },
      ],
      TZ,
      WHERE,
      MAIN_LINE,
      SERVWAVE,
    );
    expect(fields['technician.names']).toBe('Mike Torres, Ana Lee');
    expect(fields['technician.phones']).toBe(ANA_SHOWN);
    expect(fields['technician.phones']).not.toBe(MAIN_LINE);
  });
});
