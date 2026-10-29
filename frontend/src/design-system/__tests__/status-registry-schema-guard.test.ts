/* =============================================================================
   Status registry <-> schema.prisma bijection guard.

   The registry (design-system/status-registry.ts) is the single source of truth
   for "what does this domain state look like". Its KEYS are Prisma enum values.
   Nothing in the type system connects the two: the registry maps are
   `Record<string, StatusEntry>`, so a new enum value, a renamed one, or a
   deleted one is a silent, green, runtime-only hole. That hole is the bug this
   work package exists to close, so it gets a guard rather than a convention.

   PARSES schema.prisma AT TEST TIME. It deliberately does not carry a copy of
   the enums: a hardcoded copy drifts the moment the schema moves, which is the
   exact failure mode being fenced. If the schema file cannot be read, this file
   fails loudly rather than skipping.

   --- what is asserted -------------------------------------------------------
   1. Every enum declared in schema.prisma is CLASSIFIED - claimed by a registry
      domain, or listed in EXCLUDED_ENUMS with a written reason. A brand new
      enum therefore fails the build until someone decides which it is.
   2. Every enum name this file names actually EXISTS in schema.prisma. A
      renamed or deleted enum fails.
   3. Both directions, per in-scope domain:
        forward  every schema enum value has a registry entry
        reverse  every registry key is a schema enum value, or is declared
                 client-derived and proven genuinely absent from the enum
   4. Every registry domain is either enum-sourced or on the synthetic
      allowlist, and never both.
   5. The four status vocabularies copilot/tools/toolRegistry.ts advertises to
      the model are exactly their Prisma enums, in declaration order. That guard
      lives HERE because this is the file that already parses schema.prisma.
   6. Neither classification map is empty. Every assertion above iterates one of
      them, so a half-deleted map would pass vacuously over nothing; the counts
      are asserted so that failure mode is loud rather than green.

   --- where the classification map lives -------------------------------------
   DOMAIN_ENUM_SOURCE, SYNTHETIC_DOMAINS and parseSchemaEnums are NOT declared
   here. They live in the shared non-test module ./schema-enum-sources.ts and are
   imported by BOTH guards (this one and src/__tests__/status-registry.test.ts),
   because two hand-maintained copies of a "one place" work package's own
   classification map is the exact defect this work package exists to remove.
   They are re-exported at the bottom of this file for callers that reach for the
   guard by name; new importers should take the shared module directly.

   --- what is IN SCOPE (13 enums, 12 domains) --------------------------------
   LeadStatus, EstimateStatus, JobStatus, InvoiceStatus, TaskStatus,
   TaskPriority, ServicePlanStatus, LogisticOrderStatus, AssetStatus,
   PunchReview, EmailDeliveryStatus, and the pair WorkflowStepRunStatus +
   AutomationRunStatus which together back the single `workflowStep` domain
   (the workflow activity feed is a union of both row types).

   --- what is DELIBERATELY EXCLUDED (54 enums) -------------------------------
   Every one is listed by name in EXCLUDED_ENUMS below with its reason, so the
   exclusion is reviewable rather than implied by absence. The reasons fall into
   five groups: entity-type / polymorphic-owner discriminators, reason and
   provenance taxonomies, units and calculation modes, lifecycles with zero UI,
   and two special cases (WorkflowStatus is DERIVED, OtReviewState is a subset
   of a vocabulary already covered).

   --- what this guard CANNOT prove -------------------------------------------
   Five registry domains (deposit, approval, purchaseOrder, stage,
   estimateReservation) have no Prisma enum at all, and `workflow`
   is derived. A plain schema bijection passes vacuously over exactly those -
   including `purchaseOrder` and `stage`, the two most-duplicated domains in the
   app. They are allowlisted here, not silently skipped, and their key sets are
   unfenced by this file. Do not read a green run as proof they are right.
   ============================================================================= */
import { sep } from 'node:path';

import { describe, it, expect } from 'vitest';
import { STATUS_REGISTRY, type StatusDomain } from '@/design-system/status-registry';
import { TOOL_SPECS, statusVocabulary } from '@/components/copilot/tools/toolRegistry';
import {
  DOMAIN_ENUM_SOURCE,
  SYNTHETIC_DOMAINS,
  SCHEMA_ENUMS,
  SCHEMA_PATH,
  enumValues,
  parseSchemaEnums,
  EXPECTED_ENUM_SOURCED_DOMAINS,
  EXPECTED_CLAIMED_ENUMS,
  EXPECTED_SYNTHETIC_DOMAINS,
} from './schema-enum-sources';

// --- declarations -------------------------------------------------------------

/**
 * Every Prisma enum that must NOT gain a registry domain, with the reason.
 *
 * The registry's inclusion rule: a domain belongs there iff its values are a
 * lifecycle-state or graded-severity vocabulary for one entity, at least one
 * live UI surface maps it to appearance, AND real duplication exists. Each
 * reason below says which clause fails.
 */
const EXCLUDED_ENUMS: Record<string, string> = {
  // Entity type / polymorphic owner discriminators - a "which kind", not a state.
  MfaChallengePurpose: 'purpose discriminator (LOGIN|ENROLL), not a state',
  CreatedBySource: 'actor-kind discriminator on an audit column (USER|CLIENT|SYSTEM|IMPORT|UNKNOWN), never rendered as a status',
  CustomerKind: 'entity type (PERSON|COMPANY), not a state',
  CustomerSegment: 'segmentation taxonomy (RESIDENTIAL|COMMERCIAL), not a state',
  InvoiceKind: 'kind taxonomy (DEPOSIT|STANDARD|PLAN), named in the registry inclusion rule',
  PriceBookItemType: 'item type (SERVICE|MATERIAL), not a state',
  EstimateContainerKind: 'which parent shaped an estimate number (LEAD|CUSTOMER|JOB), not a state',
  AttachmentEntity: 'polymorphic owner discriminator for attachments',
  NoteEntity: 'polymorphic owner discriminator for notes',
  TagEntity: 'polymorphic owner discriminator for tags',
  TaskEntity: 'polymorphic owner discriminator for tasks',
  CopilotRole: 'speaker discriminator (USER|ASSISTANT), not a state',
  CopilotModality: 'channel discriminator (TEXT|VOICE), not a state',
  PunchType: 'direction discriminator (IN|OUT), not a state',
  PunchZoneKind: 'geofence kind (STORE|JOB), not a state',
  EmailBounceKind: 'bounce kind (HARD|SOFT) annotating EmailDeliveryStatus.BOUNCED, not a state',
  // Its sibling InboundAuthVerdict IS registry-claimed (domain `inboundSender`).
  // This one is not: it records a routing outcome - whether we attached the
  // message to a thread - which the UI expresses as membership of the unmatched
  // queue rather than as a badge. Two of its three values are the same "not
  // attached" fact with different causes, so a severity mapping would invent a
  // gradient the data does not have.
  InboundMatchState: 'inbound routing outcome (attached / not attached), rendered as queue membership rather than a badge',
  Role: 'identity and permission taxonomy, not an entity lifecycle',
  Plan: 'entitlement tier (STARTER|PRO|SCALE|ENTERPRISE), not a state',
  CustomFieldType: 'field-type taxonomy (TEXT|NUMBER|DATE|SELECT|CHECKBOX) on a definition, not a lifecycle state',
  CustomFieldEntity: 'polymorphic owner discriminator (LEAD|JOB|CUSTOMER|PRICE_BOOK_ITEM) for custom field definitions',
  CalendarParticipantKind:
    'which-party discriminator (USER|CUSTOMER) on a CalendarEntry participant row (Slice 02) - says whether the attached party is a staff user or a customer, not a lifecycle state. The API returns it as a plain `kind` field; no UI surface maps it to appearance or renders it as a status chip.',
  ManualCommChannel:
    'channel discriminator (CALL|SMS|EMAIL) on a manually logged communication - which medium the conversation happened over, not a state of anything. The timeline renders it through the shared ChannelIcon, the same way it renders a real call/text/email row.',
  ManualCommDirection:
    'direction discriminator (IN|OUT) on a manually logged communication, exactly like PunchType above - who called whom, not a lifecycle. The timeline renders it as the words Inbound/Outbound, with no appearance mapping.',
  CallTrackingProvider:
    'vendor discriminator (callrail|whatconverts) on an external call-tracking integration row and on the call rows it enriched - which vendor pushed the marketing session, not a state. Backend-only: no UI surface renders it, and vendor names never reach user-visible copy.',
  WebFormProvider:
    'vendor discriminator (forminator) on a website-form integration row and on the submissions it received - which form plugin posted the lead, not a state. Exactly the CallTrackingProvider case above, on the other half of the funnel: backend-only, no UI surface renders it, and vendor names never reach user-visible copy.',

  // Reason / provenance taxonomies - they annotate a state, they are not one.
  LostReason: 'reason taxonomy on a lost estimate; the state is EstimateStatus.DECLINED',
  VoidPaymentReason: 'reason taxonomy on a voided payment, not a lifecycle',
  RefundCategory: 'reason taxonomy on a refund, not a lifecycle',
  TaskSource: 'provenance taxonomy (MANUAL|AI_*), not a state',
  AssetEventType: 'event-type taxonomy, named in the registry inclusion rule',
  NotificationCategory: 'category taxonomy, named in the registry inclusion rule',
  WorkflowStepType: 'step-type taxonomy, named in the registry inclusion rule',
  AutomationTriggerType: 'trigger taxonomy, not a state of anything',
  AutomationActionType: 'action taxonomy, not a state of anything',

  // Units, cadences and calculation modes - no appearance to map.
  VisitCadence: 'schedule frequency, not a state',
  IntervalUnit: 'unit of measure (DAY|WEEK|MONTH|YEAR)',
  DiscountType: 'calculation mode (PERCENTAGE|FIXED_AMOUNT)',
  DepositDefaultType: 'calculation mode (PERCENTAGE|FIXED)',
  AutomationSendWindow: 'scheduling window (ANYTIME|BUSINESS_HOURS), not a state',
  PaymentMethod: 'label-only vocabulary, named in the registry inclusion rule',
  NotificationPriority:
    'INTERRUPT|FEED selects a delivery route (toast vs feed, lib/notifications/useInterruptToasts.ts), not an appearance',

  // Real lifecycles, but clause (b) fails: no UI surface maps them to appearance.
  PlanVisitStatus: 'lifecycle with zero UI, named in the registry inclusion rule',
  StockSyncStatus: 'lifecycle with zero UI, named in the registry inclusion rule',
  CopilotMsgStatus: 'lifecycle with zero UI, named in the registry inclusion rule',
  WorkflowEnrollmentStatus: 'lifecycle with zero UI, named in the registry inclusion rule',
  PunchStatus: 'IN_ZONE|OVERRIDE has zero frontend references; nothing renders it',
  // Multi-visit S1 renamed WalkthroughStatus -> VisitStatus; the exclusion reason is unchanged.
  VisitStatus:
    'lifecycle with UI (LeadDetailPage WalkthroughDot/WalkthroughTabContent, the schedule board) but no UI surface maps ITS VALUES to appearance - they derive appearance from the current visit\'s timestamps (scheduled_at/completed_at/cancelled_at) instead, by design; see the divergence note on WalkthroughDot',
  VisitPurpose:
    'not a lifecycle at all - WORK|WALKTHROUGH says which parent a visit hangs off, and nothing renders it as a status',
  // Scheduling-notifications slice 08: the append-only visit milestone log.
  VisitMilestoneName:
    'which-milestone discriminator (en_route|on_site|started|completed) on a visit milestone log row; the visit\'s state stays in its timestamp columns and VisitStatus, and nothing renders the name as a status chip',
  VisitMilestoneLogKind:
    'provenance taxonomy (tapped|skipped|reverted) on an append-only log row, not a state of anything; no UI surface maps it to appearance',

  // Special cases.
  WorkflowStatus:
    'DERIVED: collapsed with is_enabled into the `workflow` domain (DRAFT|LIVE|PAUSED); the raw PUBLISHED value is never rendered',
  OtReviewState:
    'two-value subset of the PunchReview vocabulary the `timeclockReview` domain already covers; a domain of its own would re-fork the map this work package consolidated',
};

const ALL_DOMAINS = Object.keys(STATUS_REGISTRY) as StatusDomain[];
const CLAIMED_ENUMS = new Map<string, StatusDomain>();
for (const [domain, source] of Object.entries(DOMAIN_ENUM_SOURCE)) {
  for (const name of source?.enums ?? []) CLAIMED_ENUMS.set(name, domain as StatusDomain);
}

// --- the guard ------------------------------------------------------------------

describe('status registry - schema.prisma is parsed, not copied', () => {
  it('reads the live schema and finds a plausible number of enums', () => {
    // process.stdout, not console: vitest's console interception swallows these
    // under jsdom, matching every other guard in this suite.
    process.stdout.write(
      `  status-registry  schema enums ${SCHEMA_ENUMS.size}` +
        ` (in scope ${CLAIMED_ENUMS.size}, excluded ${Object.keys(EXCLUDED_ENUMS).length})\n`,
    );
    expect(SCHEMA_ENUMS.size).toBeGreaterThan(40);
  });

  it('resolves schema.prisma to a real path outside src/', () => {
    // Cheap tripwire on the four-levels-up relative walk in the shared module:
    // if that path is ever wrong the module throws at import, but if someone
    // "fixes" it by pointing at a fixture this fails instead of going green.
    // Normalised: SCHEMA_PATH is built with join(), so it carries '\' on
    // Windows and this assertion failed there regardless of the path being
    // correct.
    expect(SCHEMA_PATH.split(sep).join('/').endsWith('backend/prisma/schema.prisma')).toBe(true);
  });

  it('parses a known enum exactly, comments and all', () => {
    // InvoiceStatus carries an inline `//` comment between two of its values.
    expect(enumValues('InvoiceStatus')).toEqual([
      'DRAFT',
      'SENT',
      'PARTIAL',
      'PAID',
      'VOIDED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DISPUTED',
    ]);
  });
});

/**
 * ANTI-VACUITY. Every assertion below iterates DOMAIN_ENUM_SOURCE,
 * SYNTHETIC_DOMAINS or SCHEMA_ENUMS. If one of those were empty - a botched
 * extraction, a bad merge, an import that silently resolved to `undefined` -
 * the whole suite would pass over nothing and green-light real drift. These
 * three counts make that failure loud. They are the ONE place in this file
 * allowed to hardcode a number, and they change only with a real domain change.
 */
describe('status registry - the classification maps are actually populated', () => {
  it('DOMAIN_ENUM_SOURCE still declares every enum-sourced domain', () => {
    expect(Object.keys(DOMAIN_ENUM_SOURCE)).toHaveLength(EXPECTED_ENUM_SOURCED_DOMAINS);
  });

  it('the enum-sourced domains still claim every in-scope enum', () => {
    expect(CLAIMED_ENUMS.size).toBe(EXPECTED_CLAIMED_ENUMS);
  });

  it('SYNTHETIC_DOMAINS still declares every enum-less domain', () => {
    expect(Object.keys(SYNTHETIC_DOMAINS)).toHaveLength(EXPECTED_SYNTHETIC_DOMAINS);
  });

  it('every enum-sourced domain names at least one enum and exists in the registry', () => {
    const broken = Object.entries(DOMAIN_ENUM_SOURCE)
      .filter(([domain, source]) => !source?.enums.length || !(domain in STATUS_REGISTRY))
      .map(([domain]) => domain);
    expect(broken).toEqual([]);
  });

  it('every enum-sourced domain resolves to a non-empty registry map', () => {
    const empty = Object.keys(DOMAIN_ENUM_SOURCE).filter(
      (domain) => Object.keys(STATUS_REGISTRY[domain as StatusDomain] ?? {}).length === 0,
    );
    expect(empty).toEqual([]);
  });
});

describe('status registry - every schema enum is classified', () => {
  it('every enum in schema.prisma is either claimed by a domain or explicitly excluded', () => {
    const unclassified = [...SCHEMA_ENUMS.keys()].filter(
      (name) => !CLAIMED_ENUMS.has(name) && !(name in EXCLUDED_ENUMS),
    );
    expect(unclassified).toEqual([]);
  });

  it('no enum is both claimed and excluded', () => {
    const both = [...CLAIMED_ENUMS.keys()].filter((name) => name in EXCLUDED_ENUMS);
    expect(both).toEqual([]);
  });

  it('every enum name this guard claims still exists in schema.prisma', () => {
    const gone = [...CLAIMED_ENUMS.keys()].filter((name) => !SCHEMA_ENUMS.has(name));
    expect(gone).toEqual([]);
  });

  it('every enum name this guard excludes still exists in schema.prisma', () => {
    const gone = Object.keys(EXCLUDED_ENUMS).filter((name) => !SCHEMA_ENUMS.has(name));
    expect(gone).toEqual([]);
  });

  it('every exclusion carries a written reason', () => {
    const unreasoned = Object.entries(EXCLUDED_ENUMS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name);
    expect(unreasoned).toEqual([]);
  });
});

describe('status registry - every domain is classified', () => {
  it('each domain is either enum-sourced or explicitly allowlisted as synthetic', () => {
    const unclassified = ALL_DOMAINS.filter(
      (d) => !DOMAIN_ENUM_SOURCE[d] && !(d in SYNTHETIC_DOMAINS),
    );
    expect(unclassified).toEqual([]);
  });

  it('no domain is claimed by both lists', () => {
    const both = ALL_DOMAINS.filter((d) => DOMAIN_ENUM_SOURCE[d] && d in SYNTHETIC_DOMAINS);
    expect(both).toEqual([]);
  });
});

describe('status registry - enum-sourced domains match schema.prisma in BOTH directions', () => {
  for (const [domain, source] of Object.entries(DOMAIN_ENUM_SOURCE)) {
    if (!source) continue;
    const label = source.enums.join(' + ');

    it(`${domain}: every ${label} value has a registry entry`, () => {
      const schemaValues = source.enums
        .flatMap(enumValues)
        .map((v) => (source.lowercase ? v.toLowerCase() : v));
      const entryKeys = new Set(Object.keys(STATUS_REGISTRY[domain as StatusDomain]));
      const missing = [...new Set(schemaValues)].filter((v) => !entryKeys.has(v));
      expect(missing).toEqual([]);
    });

    it(`${domain}: every registry entry is a real ${label} value or declared client-derived`, () => {
      const schemaValues = new Set(
        source.enums.flatMap(enumValues).map((v) => (source.lowercase ? v.toLowerCase() : v)),
      );
      const clientOnly = new Set(source.clientOnly ?? []);
      const extra = Object.keys(STATUS_REGISTRY[domain as StatusDomain]).filter(
        (k) => !schemaValues.has(k) && !clientOnly.has(k),
      );
      expect(extra).toEqual([]);
    });

    it(`${domain}: every declared client-derived value is genuinely absent from ${label}`, () => {
      const schemaValues = new Set(
        source.enums.flatMap(enumValues).map((v) => (source.lowercase ? v.toLowerCase() : v)),
      );
      const notActuallyClientOnly = (source.clientOnly ?? []).filter((v) => schemaValues.has(v));
      expect(notActuallyClientOnly).toEqual([]);
    });
  }
});

// --- the copilot status vocabulary is an API contract ----------------------------

/**
 * toolRegistry.ts derives the status filter vocabulary it advertises to the model
 * from the registry's key ORDER and key SET. That makes the registry load-bearing
 * for an API contract, not just for appearance: any new client-derived key (the
 * `invoice.OVERDUE` pattern) silently becomes an advertised filter value unless
 * toolRegistry's hand-maintained `exclude` array drops it - and /api/{resource}
 * validates the `status` facet against the Prisma enum, so an advertised value
 * that is not an enum value is a 400 the model cannot see coming. Nothing tested
 * that. This does.
 *
 * The guard lives in this file because this is the file that already parses
 * schema.prisma. It checks TWO things that have to be checked differently:
 *
 *   1. THE RENDERED DESCRIPTION, parsed back out of TOOL_SPECS.query_crm. This
 *      is the one that makes `exclude` self-checking, and it is the only way to
 *      do so: the exclude array is spelled at the CALL SITE, so a guard that
 *      re-spells `['OVERDUE']` and calls the generator itself would only be
 *      asserting its own copy. Parsing the rendered string reads the real call.
 *      It is also literally what the model is told.
 *   2. THE GENERATOR, called directly, to prove the vocabulary is registry-
 *      derived and preserves declaration order independently of the prose. Its
 *      enum-valued members, in order, must be the enum.
 *
 * Both directions are covered: a missing value (the SUPERSEDED bug this work
 * package fixed), an extra value, a reordering, or a forgotten `exclude` all
 * produce an inequality.
 */
const TOOL_VOCABULARY_DOMAINS: ReadonlyArray<{ domain: StatusDomain; prose: string }> = [
  { domain: 'lead', prose: 'leads' },
  { domain: 'job', prose: 'jobs' },
  { domain: 'estimate', prose: 'estimates' },
  { domain: 'invoice', prose: 'invoices' },
];

/** The `status` parameter description query_crm advertises. Throws if its shape moved. */
function queryCrmStatusDescription(): string {
  const spec = TOOL_SPECS.query_crm;
  if (!spec) throw new Error('TOOL_SPECS.query_crm is gone; this guard needs re-pointing');
  const properties = (
    spec.parametersJsonSchema as {
      properties?: Record<string, { description?: unknown } | undefined>;
    }
  ).properties;
  const description = properties?.status?.description;
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(
      'query_crm has no `status` parameter description; the copilot vocabulary guard would ' +
        'otherwise pass over nothing',
    );
  }
  return description;
}

/**
 * The pipe-joined vocabulary advertised for one prose resource name, e.g.
 * `estimates: DRAFT|SENT|...`. Throws rather than returning [] so a prose
 * rewrite fails loudly instead of silently asserting an empty list.
 */
function vocabularyFor(prose: string): string[] {
  const description = queryCrmStatusDescription();
  const match = new RegExp(`\\b${prose}: ([A-Z][A-Z_]*(?:\\|[A-Z][A-Z_]*)*)`).exec(description);
  if (!match) {
    throw new Error(
      `query_crm's status description no longer advertises a "${prose}: A|B|C" vocabulary. ` +
        `Re-point this guard rather than deleting it. Description was: ${description}`,
    );
  }
  return match[1]!.split('|');
}

describe('copilot toolRegistry - the advertised status vocabulary IS the Prisma enum', () => {
  for (const { domain, prose } of TOOL_VOCABULARY_DOMAINS) {
    const source = DOMAIN_ENUM_SOURCE[domain];
    const label = source?.enums.join(' + ') ?? '(undeclared)';

    it(`${prose}: advertises exactly ${label}, in declaration order`, () => {
      // Fails loudly if the domain ever drops out of DOMAIN_ENUM_SOURCE, rather
      // than comparing against an empty expectation.
      expect(source, `${domain} is not enum-sourced`).toBeDefined();
      const expected = source!.enums.flatMap(enumValues);
      expect(expected.length).toBeGreaterThan(0);
      expect(vocabularyFor(prose)).toEqual(expected);
    });
  }

  it('invoices: OVERDUE is in the registry but is NOT advertised as a filter value', () => {
    // The one client-derived key in these four domains. It has its own `overdue`
    // boolean parameter; advertising it as a status would produce a 400.
    expect(Object.keys(STATUS_REGISTRY.invoice)).toContain('OVERDUE');
    expect(enumValues('InvoiceStatus')).not.toContain('OVERDUE');
    expect(vocabularyFor('invoices')).not.toContain('OVERDUE');
  });

  it('every client-derived key of an advertised domain is excluded from its vocabulary', () => {
    // Generalises the OVERDUE case: add a client-derived key to lead/job/estimate/
    // invoice and forget toolRegistry's `exclude`, and this goes red.
    const leaked: string[] = [];
    for (const { domain, prose } of TOOL_VOCABULARY_DOMAINS) {
      const advertised = new Set(vocabularyFor(prose));
      for (const value of DOMAIN_ENUM_SOURCE[domain]?.clientOnly ?? []) {
        if (advertised.has(value)) leaked.push(`${domain}.${value}`);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('the description still tells the model OVERDUE is not a status', () => {
    // The prose half of the same contract, held so a reword cannot quietly drop it.
    expect(queryCrmStatusDescription()).toContain('OVERDUE is NOT a status');
  });

  // --- the generator itself, independent of the prose ---------------------------

  for (const { domain, prose } of TOOL_VOCABULARY_DOMAINS) {
    const source = DOMAIN_ENUM_SOURCE[domain];
    const label = source?.enums.join(' + ') ?? '(undeclared)';

    it(`${domain}: statusVocabulary is registry-derived and keeps ${label} declaration order`, () => {
      expect(source, `${domain} is not enum-sourced`).toBeDefined();
      const expected = source!.enums.flatMap(enumValues);
      expect(expected.length).toBeGreaterThan(0);

      // Called with NO exclude, so this is the full registry vocabulary. Drop the
      // declared client-derived keys and what is left must be the enum, in order.
      const clientOnly = new Set(source!.clientOnly ?? []);
      const produced = statusVocabulary(domain as 'lead' | 'job' | 'estimate' | 'invoice')
        .split('|')
        .filter((value) => !clientOnly.has(value));
      expect(produced).toEqual(expected);
    });

    it(`${prose}: the rendered description matches what the generator produces`, () => {
      // Wiring check. Without it, a hand-edited description string could drift
      // away from the generator and both halves above would still pass.
      const advertised = vocabularyFor(prose).join('|');
      const clientOnly = DOMAIN_ENUM_SOURCE[domain]?.clientOnly ?? [];
      expect(advertised).toBe(
        statusVocabulary(domain as 'lead' | 'job' | 'estimate' | 'invoice', clientOnly),
      );
    });
  }
});

// --- asserted examples (lock the parser itself) ----------------------------------

describe('status-registry guard parser (asserted examples)', () => {
  it('parses a plain enum', () => {
    const parsed = parseSchemaEnums('enum Foo {\n  A\n  B\n}\n');
    expect([...parsed.keys()]).toEqual(['Foo']);
    expect(parsed.get('Foo')).toEqual(['A', 'B']);
  });

  it('skips comment and blank lines inside a body', () => {
    const parsed = parseSchemaEnums('enum Foo {\n  A\n\n  // note: B was added later\n  B\n}\n');
    expect(parsed.get('Foo')).toEqual(['A', 'B']);
  });

  it('a brace inside a comment does not truncate the body, the [^}] trap', () => {
    const parsed = parseSchemaEnums('enum Foo {\n  A\n  // shape is { x: 1 }\n  B\n}\n');
    expect(parsed.get('Foo')).toEqual(['A', 'B']);
  });

  it('does not read a model as an enum', () => {
    const parsed = parseSchemaEnums('model Foo {\n  id String\n}\n\nenum Bar {\n  X\n}\n');
    expect([...parsed.keys()]).toEqual(['Bar']);
  });

  it('does not read a doc comment above an enum as a value', () => {
    const parsed = parseSchemaEnums('/// Why this exists.\nenum Foo {\n  A\n}\n');
    expect(parsed.get('Foo')).toEqual(['A']);
  });

  it('parses several enums in one file without bleeding across blocks', () => {
    const parsed = parseSchemaEnums('enum Foo {\n  A\n}\n\nenum Bar {\n  B\n  C\n}\n');
    expect(parsed.get('Foo')).toEqual(['A']);
    expect(parsed.get('Bar')).toEqual(['B', 'C']);
  });

  it('throws on an unterminated enum rather than silently returning a short list', () => {
    expect(() => parseSchemaEnums('enum Foo {\n  A\n')).toThrow(/never closed/);
  });

  it('throws on a duplicate enum name rather than letting the later one win', () => {
    expect(() => parseSchemaEnums('enum Foo {\n  A\n}\nenum Foo {\n  B\n}\n')).toThrow(/duplicate/);
  });

  it('enumValues throws on a name that is not in the schema', () => {
    expect(() => enumValues('NoSuchEnumStatus')).toThrow(/not found in schema.prisma/);
  });
});

/* -----------------------------------------------------------------------------
   Compatibility re-exports.

   The classification map and the parser are owned by ./schema-enum-sources.ts.
   They are re-exported here only so a caller that reaches for the guard by name
   still resolves. PREFER IMPORTING THE SHARED MODULE DIRECTLY: importing one
   test file from another re-registers this file's suites into the importer and
   double-runs them.
   ----------------------------------------------------------------------------- */
export {
  DOMAIN_ENUM_SOURCE,
  SYNTHETIC_DOMAINS,
  parseSchemaEnums,
  enumValues,
  SCHEMA_ENUMS,
  SCHEMA_PATH,
};
export { EXCLUDED_ENUMS };
