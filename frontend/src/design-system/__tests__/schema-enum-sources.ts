/* =============================================================================
   Shared, NON-TEST module: the single owner of "which registry domain is backed
   by which Prisma enum", plus the schema.prisma parser both guards run on.

   WHY THIS FILE EXISTS. Two guards need this classification map:
     - design-system/__tests__/status-registry-schema-guard.test.ts (the bijection
       guard, plus the toolRegistry vocabulary guard)
     - src/__tests__/status-registry.test.ts (shape checks, negative controls and
       the resolution snapshot)
   They previously each declared their own byte-identical copy of
   DOMAIN_ENUM_SOURCE and SYNTHETIC_DOMAINS. A work package whose thesis is
   "one place" cannot ship two hand-maintained copies of its own classification
   map, so the map lives here and both guards import it.

   It is a plain `.ts`, not a `.test.ts`, on purpose: vitest's `include` only
   matches `.test.ts` and `.test.tsx` under src (frontend/vitest.config.ts), so
   this module is imported, never collected. Importing one test file from another
   would re-register that file's suites into the importer and double-run them.

   Nothing in the production bundle imports this file. It uses node:fs and is
   test-support only; it sits under a __tests__ directory, which the coverage
   config already excludes.
   ============================================================================= */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StatusDomain } from '@/design-system/status-registry';

// frontend/src/design-system/__tests__ -> repo root is four levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'backend',
  'prisma',
  'schema.prisma',
);

/**
 * Every `enum Name { ... }` block in a Prisma schema, name -> values.
 *
 * Line-based rather than one `\{([^}]*)\}` regex: a `//` comment inside an enum
 * body is legal Prisma and may contain a brace, which would truncate the
 * non-greedy form. InvoiceStatus and AutomationTriggerType both carry inline
 * comments in this schema today, so comment handling is load-bearing, not
 * defensive. The `[^}]` trap has its own asserted example in the guard test.
 *
 * Only the leading identifier of a value line is kept, so a value carrying a
 * trailing attribute or comment still parses to the bare value.
 */
export function parseSchemaEnums(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = src.split('\n');
  const OPEN = /^enum[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{[ \t]*$/;
  const VALUE = /^([A-Za-z_][A-Za-z0-9_]*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = OPEN.exec(lines[i] ?? '');
    if (!m) continue;
    const name = m[1]!;
    if (out.has(name)) throw new Error(`duplicate enum ${name} in schema.prisma`);

    const values: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = (lines[j] ?? '').trim();
      if (line === '}') {
        closed = true;
        i = j;
        break;
      }
      if (line.length === 0 || line.startsWith('//')) continue;
      const v = VALUE.exec(line);
      if (v) values.push(v[1]!);
    }
    if (!closed) throw new Error(`enum ${name} in schema.prisma is never closed`);
    out.set(name, values);
  }
  return out;
}

if (!existsSync(SCHEMA_PATH)) {
  throw new Error(
    `status-registry guard cannot find schema.prisma at ${SCHEMA_PATH}. ` +
      'This guard parses the live schema by design; do not replace it with a hardcoded copy.',
  );
}

/** The live schema, parsed once and shared by both guards. */
export const SCHEMA_ENUMS = parseSchemaEnums(readFileSync(SCHEMA_PATH, 'utf8'));

/** Declaration-ORDER values of one schema enum. Throws if the enum is gone. */
export function enumValues(name: string): string[] {
  const values = SCHEMA_ENUMS.get(name);
  if (!values) throw new Error(`enum ${name} not found in schema.prisma`);
  return values;
}

export interface DomainEnumSource {
  enums: string[];
  clientOnly?: string[];
  lowercase?: boolean;
}

/**
 * Registry domains whose vocabulary IS a Prisma enum, or a union of them.
 *
 * `workflowStep` takes TWO enums because the workflow activity feed is a union:
 * workflow.controller.ts merges WorkflowStepRun rows with legacy AutomationRun
 * rows onto one array and WorkflowActivity.tsx renders both through this one
 * domain. PENDING is AutomationRunStatus's value, off the wire, not a
 * client invention - which is why workflowStep has no clientOnly list.
 *
 * `timeclockReview` maps to PunchReview, NOT OtReviewState. The client type
 * ReviewState (lib/timeclock/types.ts) mirrors PunchReview 4/4, lowercased on
 * the wire by timeclock.controller.ts; OtReviewState is a two-value subset used
 * by the OT-week write path only, so sourcing from it would make `none` and
 * `pending` look client-invented.
 *
 * `messageDelivery` maps to EmailDeliveryStatus (email slice 5 - the delivery-
 * state surface). Promoted out of EXCLUDED_ENUMS now that a real render site
 * exists (Inbox thread pill, Job/Customer/Lead communication timelines, the
 * Estimate hard-bounce banner) - see status-registry.ts's own comment on the
 * domain for the OPENED-is-deliberately-absent rule.
 */
export const DOMAIN_ENUM_SOURCE: Partial<Record<StatusDomain, DomainEnumSource>> = {
  lead: { enums: ['LeadStatus'] },
  estimate: { enums: ['EstimateStatus'] },
  // Multi-visit S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus and live on VisitStatus.
  // They stay KEYS of the `job` registry block on purpose - that block is what the per-visit
  // chips render through, and a visit really can be en route or on site - so they are declared
  // here rather than deleted. `clientOnly` is read by the guard as "a registry key genuinely
  // absent from THIS domain's enum", which is exactly true of both.
  //
  // Sourcing the domain from ['JobStatus', 'VisitStatus'] instead was REJECTED: the same map
  // drives the copilot's advertised job-filter vocabulary, and a union would tell the model to
  // filter JOBS by the six VisitStatus values, half of which the jobs facet 400s on.
  job: { enums: ['JobStatus'], clientOnly: ['EN_ROUTE', 'ON_SITE'] },
  // OVERDUE is computed client-side from due_date + status; it is not a column value.
  invoice: { enums: ['InvoiceStatus'], clientOnly: ['OVERDUE'] },
  task: { enums: ['TaskStatus'] },
  taskPriority: { enums: ['TaskPriority'] },
  servicePlan: { enums: ['ServicePlanStatus'] },
  logisticOrder: { enums: ['LogisticOrderStatus'] },
  asset: { enums: ['AssetStatus'] },
  workflowStep: { enums: ['WorkflowStepRunStatus', 'AutomationRunStatus'] },
  timeclockReview: { enums: ['PunchReview'], lowercase: true },
  messageDelivery: { enums: ['EmailDeliveryStatus'] },
  // Email slice 6 - the INBOUND mirror of messageDelivery. Sourced from
  // InboundAuthVerdict alone, NOT from InboundMatchState as well: the two are
  // adjacent columns on the same rows but they answer different questions, and
  // only the verdict is a graded-severity vocabulary that maps to appearance.
  // InboundMatchState is a routing outcome (attached / not attached), rendered
  // as a queue membership rather than a badge, so it is excluded rather than
  // folded in here - see EXCLUDED_ENUMS in the guard test.
  inboundSender: { enums: ['InboundAuthVerdict'] },
};

/**
 * Registry domains with no Prisma enum behind them, each with its reason.
 *
 * READ THIS BEFORE TRUSTING A GREEN RUN: for the domains below, the guards prove
 * only that each entry has a non-empty label and a valid intent. They prove
 * NOTHING about whether the key set is right, because there is no schema to
 * check against. `stage` and `purchaseOrder` - the two worst-duplicated domains
 * in the app - are both in here.
 */
export const SYNTHETIC_DOMAINS: Partial<Record<StatusDomain, string>> = {
  // 4 dead entries: no backend select emits a `deposit` relation, so both
  // domain="deposit" badges are unreachable. Kept and documented in the registry.
  deposit: 'dissolved into kind=DEPOSIT Invoice; no producer, entries currently dead',
  approval: 'inventory stock-approval workflow, lowercase, no enum',
  purchaseOrder: 'lowercase PO lifecycle, no enum',
  stage: 'lowercase job-staging lifecycle, no enum',
  estimateReservation: 'lowercase pre-PO reservation lifecycle, no enum',
  workflow: 'DERIVED: WorkflowStatus x is_enabled collapsed to DRAFT|LIVE|PAUSED',
};

/**
 * Anti-vacuity constants. Every assertion in both guards iterates one of the two
 * maps above, so an empty or half-deleted map would make the whole suite pass
 * over nothing. These counts are asserted explicitly so that failure mode is
 * loud. Update them ONLY together with a real domain change.
 */
export const EXPECTED_ENUM_SOURCED_DOMAINS = 13;
export const EXPECTED_CLAIMED_ENUMS = 14;
export const EXPECTED_SYNTHETIC_DOMAINS = 6;
