/**
 * servwave-phone.test.ts - the organisation's own number for the person coming (slice 7).
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D7)
 * Slice: md_files/issues/scheduling/07-let-the-author-choose-the-servwave-number-instead-of-the-personal-one.md
 *
 * Slice 5 gave a confirmation email the performer's OWN number. This is its sibling, and the
 * whole point of it being a sibling rather than a change is that an organisation which will not
 * publish mobiles should not have to give up the capability to decline. So the author picks: two
 * fields, same group, and the template says which number this organisation is willing to print.
 *
 * WHAT THIS FILE HAS TO PROVE, beyond "it renders a number":
 *
 *  1. The fallback chain, all four rungs, in order - and that rung 1 never falls through to the
 *     PERSONAL number. An author who chose this field over `performer_phones` chose not to
 *     publish mobiles; substituting one quietly would hand the customer exactly the number the
 *     choice was meant to withhold.
 *  2. The two fields stay independent in both directions, because a resolver that read the wrong
 *     column would still render a plausible, correctly-formatted number.
 *  3. An inactive number, and another organisation's number, are never rendered.
 *
 * THE MOCKS HONOUR THEIR OWN ARGUMENTS - `userPhoneNumber.findMany` and `phoneNumber.findFirst`
 * answer against fixture tables with the where-clause applied, exactly as `mockLocationTable` does
 * in job-visit-location.test.ts. That is what gives (3) teeth: against a mock that answered a
 * fixed row, a resolver with no tenant clause and no status filter in it at all would pass every
 * case below. It is also why this file does not assert the read's ARGUMENTS the way
 * performer-phone.test.ts has to - there the mock fabricates whatever the fixture holds whatever
 * the select says, so only the arguments could fail; here the filter is exercised for real.
 *
 * Every number below is invented in the 555 range and reaches nobody.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { loadExecutionBundle, visitMergeFields } from '../services/automations/context';
import { MAIN_LINE_FALLBACK, resolveServWavePhones } from '../services/performerPhone';
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
/** Somebody else's organisation. Nothing it owns may ever reach this organisation's email. */
const OTHER_ORG = '00000000-0000-0000-0000-0000000000ff';

const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const WALKTHROUGH_AT = new Date('2026-08-01T15:00:00.000Z');

/** The organisation's main line, spelled exactly as `{{org.phone}}` renders it - rung 3. */
const MAIN_LINE = '(555) 204-7788';

/** The people. Ids are stable so the link table below can key off them. */
const MIKE = 't0000000-0000-0000-0000-000000000001';
const ANA = 't0000000-0000-0000-0000-000000000002';
const SAM = 't0000000-0000-0000-0000-000000000003';
const KIT = 't0000000-0000-0000-0000-000000000004';
const DREW = 't0000000-0000-0000-0000-000000000005';
/** In ANOTHER organisation, and holding a live default on one of THIS one's numbers. */
const OUTSIDER = 't0000000-0000-0000-0000-0000000000ff';

/**
 * The personal numbers slice 5 renders. Present on every fixture person ON PURPOSE: a resolver
 * that fell through to them, or read them by mistake, has to be able to fail here.
 */
const MIKE_PERSONAL_STORED = '+15550100142';
const MIKE_PERSONAL_SHOWN = '(555) 010-0142';
const ANA_PERSONAL_STORED = '+15550100177';

/** The organisation's own numbers. `formatted` is what the product stores for display. */
const SW_MIKE = { id: 'p1', e164: '+15552040701', formatted: '(555) 204-0701' };
/** Ana's carries NO `formatted`, so the E.164 has to be run through the display formatter. */
const SW_ANA = { id: 'p2', e164: '+15552040702', formatted: null };
const SW_ANA_SHOWN = '(555) 204-0702';
/** A number the organisation has released. A live link row can still point at it. */
const SW_RETIRED = { id: 'p3', e164: '+15552040703', formatted: '(555) 204-0703' };
/** The organisation's fallback caller ID - rung 2. */
const SW_ORG_DEFAULT = { id: 'p4', e164: '+15552040700', formatted: '(555) 204-0700' };
/** Another organisation's number, with a live link row pointing at it from one of OUR people. */
const SW_FOREIGN = { id: 'p5', e164: '+15552049001', formatted: '(555) 204-9001' };
/**
 * Stored with a different grouping from the one `formatPhoneDisplay` derives, which is what makes
 * "prefer `formatted`" an assertion that can fail at all: for an ordinary NANP number the two
 * columns render identically, so a resolver reading them in either order looks correct.
 */
const SW_DASHED = { id: 'p6', e164: '+15552040704', formatted: '555-204-0704' };
const SW_DASHED_FROM_E164 = '(555) 204-0704';
/** THIS organisation's number, held as a default by somebody in ANOTHER organisation. */
const SW_SHARED_DESK = { id: 'p7', e164: '+15552040705', formatted: '(555) 204-0705' };

type NumberRow = {
  id: string; e164: string; formatted: string | null;
  organization_id: string; status: string; is_org_default: boolean;
};

/** `phone_numbers`, as Postgres holds it for these two organisations. */
const NUMBERS: Record<string, NumberRow> = {
  [SW_MIKE.id]: { ...SW_MIKE, organization_id: ORG, status: 'active', is_org_default: false },
  [SW_ANA.id]: { ...SW_ANA, organization_id: ORG, status: 'active', is_org_default: false },
  [SW_RETIRED.id]: { ...SW_RETIRED, organization_id: ORG, status: 'released', is_org_default: false },
  [SW_ORG_DEFAULT.id]: { ...SW_ORG_DEFAULT, organization_id: ORG, status: 'active', is_org_default: true },
  [SW_FOREIGN.id]: { ...SW_FOREIGN, organization_id: OTHER_ORG, status: 'active', is_org_default: false },
  [SW_DASHED.id]: { ...SW_DASHED, organization_id: ORG, status: 'active', is_org_default: false },
  [SW_SHARED_DESK.id]: { ...SW_SHARED_DESK, organization_id: ORG, status: 'active', is_org_default: false },
};

/** `users`, reduced to the one column the tenant clause on the link read compares. */
const USERS: Record<string, { organization_id: string }> = {
  [MIKE]: { organization_id: ORG },
  [ANA]: { organization_id: ORG },
  [SAM]: { organization_id: ORG },
  [KIT]: { organization_id: ORG },
  [DREW]: { organization_id: ORG },
  [OUTSIDER]: { organization_id: OTHER_ORG },
};

type LinkRow = { user_id: string; phone_number_id: string; is_default: boolean };

/**
 * `user_phone_numbers`, holding one live row for each way the read can go wrong.
 *
 * SAM's only default points at a RELEASED number. KIT's points at ANOTHER ORGANISATION'S number -
 * a stale row after a number changed hands, or a crafted write. The OUTSIDER is in another
 * organisation and holds a default on one of OURS, which is what makes the tenant clause on the
 * PERSON load-bearing rather than merely redundant with the one on the number: without it, an
 * out-of-org crew member would pull a number of ours into an email about their trip.
 *
 * Mike carries a NON-default link as well: `is_default` is what says "this is the number that
 * presents as their caller ID", and a resolver that dropped the flag would render a second number
 * the organisation never chose to publish.
 */
let LINKS: LinkRow[] = [];

function defaultLinks(): LinkRow[] {
  return [
    { user_id: MIKE, phone_number_id: SW_MIKE.id, is_default: true },
    { user_id: MIKE, phone_number_id: SW_ORG_DEFAULT.id, is_default: false },
    { user_id: ANA, phone_number_id: SW_ANA.id, is_default: true },
    { user_id: SAM, phone_number_id: SW_RETIRED.id, is_default: true },
    { user_id: KIT, phone_number_id: SW_FOREIGN.id, is_default: true },
    { user_id: DREW, phone_number_id: SW_DASHED.id, is_default: true },
    { user_id: OUTSIDER, phone_number_id: SW_SHARED_DESK.id, is_default: true },
  ];
}

/**
 * `prisma.userPhoneNumber.findMany` answering the way Postgres would, and DELIBERATELY IN THE
 * WRONG ORDER.
 *
 * Rows come back reversed, because the read issues no `orderBy` and Postgres promises nothing
 * without one. A resolver that rendered the query's own order would then print a two-person crew
 * backwards from the names beside them - the customer reading "Mike and Ana" over Ana's number
 * then Mike's. Reversing here is what makes that orderable-by-crew requirement fail rather than
 * pass by luck on a single-row fixture.
 */
function mockNumberTables() {
  mockPrisma.userPhoneNumber.findMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    const pn = where.phone_number ?? {};
    const matched = LINKS.filter((link) => {
      const number = NUMBERS[link.phone_number_id];
      const user = USERS[link.user_id];
      if (!number || !user) return false;
      if (where.is_default !== undefined && link.is_default !== where.is_default) return false;
      if (where.user_id?.in !== undefined && !where.user_id.in.includes(link.user_id)) return false;
      if (where.user?.organization_id !== undefined
        && user.organization_id !== where.user.organization_id) return false;
      if (pn.organization_id !== undefined && number.organization_id !== pn.organization_id) return false;
      if (pn.status !== undefined && number.status !== pn.status) return false;
      return true;
    });
    return Promise.resolve(
      matched
        .map((link) => {
          const number = NUMBERS[link.phone_number_id];
          return {
            user_id: link.user_id,
            phone_number: { e164: number.e164, formatted: number.formatted },
          };
        })
        .reverse(),
    );
  });

  mockPrisma.phoneNumber.findFirst.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    const row = Object.values(NUMBERS).find((n) => {
      if (where.organization_id !== undefined && n.organization_id !== where.organization_id) return false;
      if (where.status !== undefined && n.status !== where.status) return false;
      if (where.is_org_default !== undefined && n.is_org_default !== where.is_org_default) return false;
      return true;
    });
    return Promise.resolve(row ? { e164: row.e164, formatted: row.formatted } : null);
  });
}

/** The organisation owns no number at all - rung 2 unreachable, so rung 3 answers. */
function theOrgOwnsNoNumbers() {
  mockPrisma.userPhoneNumber.findMany.mockResolvedValue([]);
  mockPrisma.phoneNumber.findFirst.mockResolvedValue(null);
}

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
      id: MIKE,
      email: 'mike@example.com',
      first_name: 'Mike',
      last_name: 'Torres',
      phone: MIKE_PERSONAL_STORED,
      phone_ext: null,
      ...over,
    },
  };
}

function visitFixture(over: Record<string, unknown> = {}) {
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
      first_name: 'Sarah', last_name: 'Mitchell', email: 'sarah@example.com', phone: '+15551234567',
    },
    visits: [visitFixture()],
    commission_owner: null,
    service_location: { address_line1: '88 Cedar Lane', city: 'Asheville', state: 'NC' },
    ...over,
  } as any;
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
      first_name: 'Sarah', last_name: 'Mitchell', email: 'sarah@example.com', phone: '+15551234567',
    },
    service_location: { address_line1: '18 Maple Ave', city: 'Richmond', state: 'VA' },
    visits: [visitFixture({ scheduled_end: null, is_all_day: false })],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  LINKS = defaultLinks();
  mockNumberTables();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
  mockPrisma.job.findFirst.mockResolvedValue(jobRow());
});

// ── 1. the resolver, and the four rungs of D7's chain ───────────────────────

describe('resolveServWavePhones - rung 1, the person’s own assignment', () => {
  it('renders the number assigned to the person on the trip', async () => {
    expect(await resolveServWavePhones(ORG, [MIKE], MAIN_LINE)).toBe(SW_MIKE.formatted);
  });

  it('formats the E.164 when the row carries no display form', async () => {
    // `PhoneNumber.formatted` is nullable, so "+15552040702" in a customer's inbox is a leak of
    // the column rather than a phone number. `formatPhoneDisplay` is the formatter every other
    // customer-facing surface renders through.
    expect(await resolveServWavePhones(ORG, [ANA], MAIN_LINE)).toBe(SW_ANA_SHOWN);
  });

  it('prefers the stored display form when it differs from the derived one', async () => {
    // The organisation's own screens show `formatted`, so the email and the app have to agree.
    // For an ordinary NANP number the two columns render the same string and this preference is
    // unobservable - which is exactly why this fixture stores a different grouping.
    const rendered = await resolveServWavePhones(ORG, [DREW], MAIN_LINE);
    expect(rendered).toBe(SW_DASHED.formatted);
    expect(rendered).not.toBe(SW_DASHED_FROM_E164);
  });

  it('renders the crew in the order they are handed over, not the order Postgres answers in', async () => {
    // The read issues no `orderBy`; the mock reverses deliberately. The names beside these numbers
    // are built from the same crew array, so a resolver rendering the query's order prints them
    // against the wrong people.
    expect(await resolveServWavePhones(ORG, [MIKE, ANA], MAIN_LINE))
      .toBe(`${SW_MIKE.formatted}, ${SW_ANA_SHOWN}`);
  });

  it('says one departmental number once when two people share it', async () => {
    LINKS = [
      { user_id: MIKE, phone_number_id: SW_MIKE.id, is_default: true },
      { user_id: ANA, phone_number_id: SW_MIKE.id, is_default: true },
    ];
    expect(await resolveServWavePhones(ORG, [MIKE, ANA], MAIN_LINE)).toBe(SW_MIKE.formatted);
  });

  it('renders the one assignment that exists when only SOME of the crew have one', async () => {
    // The single most likely thing to get wrong, and the same rule slice 5 records: the fallback
    // is for NOBODY on the trip having a number, not for anybody lacking one. Falling back
    // wholesale would send the customer to the front desk when somebody on the trip is reachable.
    const rendered = await resolveServWavePhones(ORG, [SAM, ANA], MAIN_LINE);
    expect(rendered).toBe(SW_ANA_SHOWN);
    expect(rendered).not.toBe(SW_ORG_DEFAULT.formatted);
    expect(rendered).not.toBe(MAIN_LINE);
  });

  it('ignores an assignment that is not the person’s default', async () => {
    // `is_default` is what says "this is the number that presents as this person's caller ID".
    // Mike is also linked to the organisation's fallback line, NOT as his default; without the
    // flag on the read he renders both, one of which the organisation never chose to publish
    // for him. `toBe` rather than a containment check, so the second number cannot hide.
    const rendered = await resolveServWavePhones(ORG, [MIKE], MAIN_LINE);
    expect(rendered).toBe(SW_MIKE.formatted);
    expect(rendered).not.toContain(SW_ORG_DEFAULT.formatted!);
  });
});

describe('resolveServWavePhones - the rungs below, in order', () => {
  it('falls to the organisation’s default number when nobody on the trip has one', async () => {
    // SAM's only default points at a released number, so rung 1 resolves to nothing for this trip.
    expect(await resolveServWavePhones(ORG, [SAM], MAIN_LINE)).toBe(SW_ORG_DEFAULT.formatted);
  });

  it('falls to the organisation’s default for a trip with nobody on it at all', async () => {
    expect(await resolveServWavePhones(ORG, [], MAIN_LINE)).toBe(SW_ORG_DEFAULT.formatted);
  });

  it('falls to the main line when the organisation has no default number', async () => {
    theOrgOwnsNoNumbers();
    expect(await resolveServWavePhones(ORG, [SAM], MAIN_LINE)).toBe(MAIN_LINE);
  });

  // SINCE 2026-09-15 THE LAST RUNG IS '', AND THE PHRASE IS THE STEP'S. A resolver that filled the
  // hole itself is what made the "If empty, fill with" box dead for this field - the renderer
  // applies the author's text only when a field resolves to '' - so the same words are now the
  // seeded default and are asserted one layer out, where the customer actually meets them.
  it('resolves empty when there is no main line either, and renders as the office', async () => {
    // `Organization.phone` is nullable free text, so '' is a reachable state - and it is the state
    // every organisation is in before somebody fills the field in.
    theOrgOwnsNoNumbers();
    const noCrewNumber = await resolveServWavePhones(ORG, [SAM], '');
    const noCrewAtAll = await resolveServWavePhones(ORG, [], '   ');

    expect(noCrewNumber).toBe('');
    expect(noCrewAtAll).toBe('');
    expect(seeded('technician.servwave_phones', noCrewNumber)).toBe(MAIN_LINE_FALLBACK);
    expect(seeded('lead.performer_servwave_phones', noCrewAtAll)).toBe(MAIN_LINE_FALLBACK);
  });

  it('does not go looking for the organisation default when the crew resolved', async () => {
    // Not an optimisation assertion. The rungs are ordered, and a resolver that read the org
    // default unconditionally is one line away from rendering it beside - or instead of - the
    // number of the person actually going.
    await resolveServWavePhones(ORG, [MIKE], MAIN_LINE);
    expect(mockPrisma.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  // Re-pointed at the contract that replaced it, and stricter for it: a rung that joins to
  // whitespace fails `toBe('')` just as it failed `toBeTruthy()`, and a stray phrase now fails too.
  // The customer-facing half is the `seeded(...)` assertion - never empty once a step renders it.
  it('resolves a real number or exactly the empty string, never whitespace and never a token', async () => {
    theOrgOwnsNoNumbers();
    for (const orgPhone of ['', '   ', MAIN_LINE]) {
      for (const crew of [[], [SAM], [MIKE, ANA]]) {
        const rendered = await resolveServWavePhones(ORG, crew, orgPhone);
        expect(rendered === '' || rendered.trim() === rendered, `whitespace-edged: ${JSON.stringify(rendered)}`).toBe(true);
        expect(rendered).not.toContain('{{');
        expect(seeded('technician.servwave_phones', rendered).trim()).not.toBe('');
      }
    }
  });
});

describe('resolveServWavePhones - the numbers that must never be rendered', () => {
  it('never renders a number the organisation has released', async () => {
    // The link row is live and `is_default`; only the number's status disqualifies it. A released
    // number in a confirmation email is a line the customer rings and nobody answers.
    const rendered = await resolveServWavePhones(ORG, [SAM], MAIN_LINE);
    expect(rendered).not.toContain(SW_RETIRED.formatted!);
    expect(rendered).not.toContain('204-0703');
  });

  it('never renders a number belonging to another organisation', async () => {
    // KIT is one of ours; the row is live and `is_default`; only the NUMBER's organisation
    // disqualifies it. Rendering it would put another tenant's line in this tenant's email.
    const rendered = await resolveServWavePhones(ORG, [MIKE, KIT], MAIN_LINE);
    expect(rendered).toBe(SW_MIKE.formatted);
    expect(rendered).not.toContain(SW_FOREIGN.formatted!);
  });

  it('renders nothing for a person outside the organisation, whatever they hold', async () => {
    // The other half of the tenant boundary, and the half a clause on the number alone does not
    // cover: the OUTSIDER's default points at one of OUR numbers. They are not this
    // organisation's person, so it is not this organisation's answer for who is coming.
    const rendered = await resolveServWavePhones(ORG, [OUTSIDER], MAIN_LINE);
    expect(rendered).toBe(SW_ORG_DEFAULT.formatted);
    expect(rendered).not.toContain(SW_SHARED_DESK.formatted!);
  });

  it('never renders another organisation’s default number as the fallback', async () => {
    LINKS = [];
    NUMBERS[SW_ORG_DEFAULT.id].organization_id = OTHER_ORG;
    try {
      expect(await resolveServWavePhones(ORG, [MIKE], MAIN_LINE)).toBe(MAIN_LINE);
    } finally {
      NUMBERS[SW_ORG_DEFAULT.id].organization_id = ORG;
    }
  });

  it('NEVER falls through to the person’s own personal number', async () => {
    // THE POINT OF THE WHOLE SLICE. An author who chose this field over `performer_phones` chose
    // not to publish mobiles. Substituting one for a person with no assignment would hand the
    // customer precisely the number that choice was meant to withhold - silently, and only for
    // the people whose assignment is missing.
    theOrgOwnsNoNumbers();
    const rendered = await resolveServWavePhones(ORG, [MIKE], MAIN_LINE);
    expect(rendered).toBe(MAIN_LINE);
    expect(rendered).not.toBe(MIKE_PERSONAL_SHOWN);
    expect(rendered).not.toContain('010-0142');
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

describe('{{lead.performer_servwave_phones}} - the walkthrough team’s organisation number', () => {
  it('renders the number assigned to the performer on the current visit', async () => {
    expect((await leadFields())['lead.performer_servwave_phones']).toBe(SW_MIKE.formatted);
  });

  it('stays independent of the personal field, in BOTH directions', async () => {
    // Two fields the author chooses between. A resolver that read the wrong column in either
    // direction still renders a plausible, correctly-formatted number, so nothing but this
    // comparison can tell the two apart.
    const fields = await leadFields();
    expect(fields['lead.performer_phones']).toBe(MIKE_PERSONAL_SHOWN);
    expect(fields['lead.performer_servwave_phones']).toBe(SW_MIKE.formatted);
    expect(fields['lead.performer_servwave_phones']).not.toBe(fields['lead.performer_phones']);
  });

  it('renders the organisation’s number for a team whose members have no assignment', async () => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [visitFixture({ assignees: [performer({ id: SAM, first_name: 'Sam', last_name: 'Doyle' })] })],
    }));
    const fields = await leadFields();
    expect(fields['lead.performer_servwave_phones']).toBe(SW_ORG_DEFAULT.formatted);
    // …while the personal field goes on answering with the personal number. The fallbacks are
    // per field, not shared.
    expect(fields['lead.performer_phones']).toBe(MIKE_PERSONAL_SHOWN);
  });

  it('falls back without ever reaching the performer’s personal number', async () => {
    // The lead-side half of the rule the whole slice exists for, and the arm where it is easiest
    // to get wrong: `lead.performer_phones` is resolved two lines away, off the same people, and
    // handing its answer in as this field's fallback would compile, read correctly, and publish
    // the mobile the author declined to publish.
    theOrgOwnsNoNumbers();
    const fields = await leadFields();
    expect(fields['lead.performer_servwave_phones']).toBe(MAIN_LINE);
    expect(fields['lead.performer_servwave_phones']).not.toBe(MIKE_PERSONAL_SHOWN);
    expect(fields['lead.performer_servwave_phones']).not.toContain('010-0142');
    // …and the personal field is unaffected beside it: the two are separate choices.
    expect(fields['lead.performer_phones']).toBe(MIKE_PERSONAL_SHOWN);
  });

  it('never resolves to an empty string or to its own token, even with no performers at all', async () => {
    theOrgOwnsNoNumbers();
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({ visits: [visitFixture({ assignees: [] })] }));
    const fields = await leadFields();
    expect(fields['lead.performer_servwave_phones']).toBeDefined();
    expect(fields['lead.performer_servwave_phones']).not.toBe('');
    expect(fields['lead.performer_servwave_phones']).not.toContain('{{');
  });

  it('resolves under THIS organisation’s tenant clause', async () => {
    // The bundle is loaded for one organisation; a resolver that read the link table unscoped
    // would answer an out-of-org performer with an out-of-org number.
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow({
      visits: [visitFixture({ assignees: [performer({ id: OUTSIDER })] })],
    }));
    const fields = await leadFields();
    expect(fields['lead.performer_servwave_phones']).not.toContain(SW_FOREIGN.formatted!);
  });
});

// ── 3. the job arm ──────────────────────────────────────────────────────────

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

describe('{{technician.servwave_phones}} - the crew’s organisation number', () => {
  it('renders the number assigned to the crew, not the main line', async () => {
    const fields = await jobFields();
    expect(fields['technician.servwave_phones']).toBe(SW_MIKE.formatted);
    expect(fields['technician.servwave_phones']).not.toBe(MAIN_LINE);
  });

  it('stays independent of the personal field, in BOTH directions', async () => {
    const fields = await jobFields();
    expect(fields['technician.phones']).toBe(MIKE_PERSONAL_SHOWN);
    expect(fields['technician.servwave_phones']).toBe(SW_MIKE.formatted);
    expect(fields['technician.servwave_phones']).not.toBe(fields['technician.phones']);
  });

  it('resolves off the same union of people the crew names are built from', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow({
      visits: [
        visitFixture(),
        visitFixture({
          id: 'v-second',
          assignees: [performer({
            id: ANA, first_name: 'Ana', last_name: 'Lee', phone: ANA_PERSONAL_STORED,
          })],
        }),
      ],
    }));
    const fields = await jobFields();
    expect(fields['technician.names']).toBe('Mike Torres, Ana Lee');
    expect(fields['technician.servwave_phones']).toBe(`${SW_MIKE.formatted}, ${SW_ANA_SHOWN}`);
  });

  it('falls back without ever reaching the crew’s personal numbers', async () => {
    theOrgOwnsNoNumbers();
    const fields = await jobFields();
    expect(fields['technician.servwave_phones']).toBe(MAIN_LINE);
    expect(fields['technician.servwave_phones']).not.toBe(MIKE_PERSONAL_SHOWN);
    // …and the same email's personal field is unaffected, because the two are separate choices.
    expect(fields['technician.phones']).toBe(MIKE_PERSONAL_SHOWN);
  });
});

// ── 4. the per-visit override, which is where this field can go silently wrong ─
//
// `loadExecutionBundle` applies a visit-scoped occurrence's override as a PARTIAL SPREAD over the
// per-entity context, so a key the dispatch site leaves out keeps the job-level union's answer -
// no error, no red test, a wrong number in a customer's inbox. The five dispatch sites are pinned
// in job-visit-location.test.ts, where the controller wiring already lives; what belongs here is
// the shape of the object those sites build.

describe('visitMergeFields - the override an occurrence keyed to one trip carries', () => {
  const VISIT = { scheduled_at: new Date('2026-09-05T13:00:00.000Z') };
  const TZ = 'America/New_York';
  const WHERE = 'North Yard, 9 Depot Rd, Raleigh, NC';
  const THIS_TRIPS_SERVWAVE = '(555) 204-0709';

  it('carries the ServWave number as a key of its own, beside the personal one', () => {
    const fields = visitMergeFields(
      VISIT,
      [{ first_name: 'Ana', last_name: 'Lee', phone: ANA_PERSONAL_STORED, phone_ext: '12' }],
      TZ,
      WHERE,
      MAIN_LINE,
      THIS_TRIPS_SERVWAVE,
    );
    expect(fields['technician.servwave_phones']).toBe(THIS_TRIPS_SERVWAVE);
    // The key has to be PRESENT, not merely correct: absent, the spread keeps the job-level
    // union's number and nothing anywhere says so.
    expect(Object.keys(fields)).toContain('technician.servwave_phones');
    // …and it does not disturb its sibling, which is resolved from different columns entirely.
    expect(fields['technician.phones']).toBe('(555) 010-0177 ext. 12');
  });

  it('overrides every job-side field whose value varies per trip', () => {
    // THE INVARIANT BEHIND THE WHOLE OVERRIDE, stated once. Anything the job arm of context.ts
    // resolves from the job's NEXT upcoming visit is wrong for an occurrence keyed to a different
    // trip, so every one of these has to travel in this object. A field added to the job arm and
    // not to this list is the defect this test exists to catch.
    const perVisit = [
      'job.scheduled_date', 'job.scheduled_time', 'job.visit_location',
      'technician.first_name', 'technician.names',
      'technician.phones', 'technician.servwave_phones',
    ];
    const keys = Object.keys(visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, THIS_TRIPS_SERVWAVE));
    expect(perVisit.filter((f) => !keys.includes(f))).toEqual([]);
  });

  it('states what it was handed, including the fallback the dispatch site resolved', () => {
    // The string is resolved by the caller - `resolveServWavePhones` needs a database and this
    // function has no client - so what the override carries is exactly what the site stated. A
    // site that stated '' would put a hole in a customer's inbox, which is what the dispatch-site
    // cases in job-visit-location.test.ts refuse.
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, MAIN_LINE_FALLBACK);
    expect(fields['technician.servwave_phones']).toBe(MAIN_LINE_FALLBACK);
    expect(fields['technician.servwave_phones']).not.toBe('');
  });
});
