import { describe, it, expect } from 'vitest';
import {
  STATUS_REGISTRY,
  STATUS_INTENT_CLASSES,
  STATUS_INTENT_FILL,
  STATUS_INTENT_TEXT,
  type StatusDomain,
  type StatusIntent,
} from '@/design-system/status-registry';
// Schema access comes from the shared non-test module, never re-rolled here.
// This file used to carry its own /^enum X \{([^}]*)\}/m parser, which is unsafe:
// a `//` comment containing a brace truncates the enum body early. The guard
// suite writes a dedicated test for exactly that failure ("a brace inside a
// comment does not truncate the body, the [^}] trap"), so one file's parser was
// contradicting the other file's proof. The shared parser is line-based.
//
// It is imported from a plain `.ts`, not from the sibling `.test.ts`: importing
// one test file from another re-registers that file's suites into the importer
// and double-runs them (measured: this file reported 152 tests instead of 101).
import { enumValues as prismaEnumValues } from '@/design-system/__tests__/schema-enum-sources';

/**
 * Status registry - shape, intent role maps, and the resolution snapshot.
 *
 * THE SCHEMA BIJECTION IS NOT HERE. The domain -> Prisma-enum map, the synthetic
 * domain allowlist, the excluded-enum list and the both-directions assertions
 * have ONE home each:
 *
 *   declarations  design-system/__tests__/schema-enum-sources.ts
 *   assertions    design-system/__tests__/status-registry-schema-guard.test.ts
 *
 * They used to be duplicated here byte-for-byte, which meant a work package
 * whose whole thesis is "one place" shipped two hand-maintained copies of its
 * own classification map. Add a domain or an enum there, not here.
 *
 * What is left in this file:
 *   - the shape check over EVERY entry, synthetic domains included (the guard
 *     file has no shape check, and the synthetic domains have no schema to be
 *     checked against at all)
 *   - the negative controls that prove the both-directions assertion can fail,
 *     plus the two producer anchors a generic guard cannot discover on its own
 *   - the intent role maps: totality, no raw palette class, no raw hex
 *   - the full resolution snapshot (see the docblock above it for exactly what
 *     that snapshot does and does not cover)
 */

const ALL_DOMAINS = Object.keys(STATUS_REGISTRY) as StatusDomain[];
const INTENTS: StatusIntent[] = ['success', 'warning', 'danger', 'info', 'neutral', 'brand'];

describe('status registry - shape holds for every entry, synthetic domains included', () => {
  for (const domain of ALL_DOMAINS) {
    it.each(Object.entries(STATUS_REGISTRY[domain]))(
      `${domain}.%s has a non-empty label and a valid intent`,
      (_status, entry) => {
        expect(entry.label.trim().length).toBeGreaterThan(0);
        expect(INTENTS).toContain(entry.intent);
      },
    );
  }
});

describe('status registry - the guard actually fails', () => {
  // Proves both directions of the enum assertion, without mutating the real registry.
  const leadValues = prismaEnumValues('LeadStatus');

  it('detects a REMOVED entry (enum value with no registry entry)', () => {
    const broken = { ...STATUS_REGISTRY.lead } as Record<string, unknown>;
    delete broken.ESTIMATED;
    const missing = leadValues.filter((v) => !(v in broken));
    expect(missing).toEqual(['ESTIMATED']);
  });

  it('detects an ADDED bogus entry (registry entry that is not an enum value)', () => {
    const broken = { ...STATUS_REGISTRY.lead, ESTIMATING: { label: 'Estimating', intent: 'warning' } };
    const extra = Object.keys(broken).filter((k) => !leadValues.includes(k));
    expect(extra).toEqual(['ESTIMATING']);
  });

  /**
   * KNOWN BLIND SPOT, stated rather than papered over. The generic guard in
   * design-system/__tests__/status-registry-schema-guard.test.ts asserts the
   * registry against whatever DOMAIN_ENUM_SOURCE declares there. It cannot
   * detect a source enum being DROPPED from that declaration - delete
   * AutomationRunStatus from workflowStep and re-add clientOnly: ['PENDING'] and
   * every assertion still passes, because PENDING really is absent from
   * WorkflowStepRunStatus. That is exactly the stale fact the registry comment
   * carried before this pass.
   *
   * A guard cannot discover producers on its own, so the second producer is
   * anchored explicitly below, named to the code that creates it.
   */
  it('workflowStep covers AutomationRunStatus too (the legacy half of the activity feed)', () => {
    // workflow.controller.ts merges WorkflowStepRun rows with legacy AutomationRun
    // rows onto one `rows` array; WorkflowActivity.tsx renders both through this domain.
    for (const value of prismaEnumValues('AutomationRunStatus')) {
      expect(Object.keys(STATUS_REGISTRY.workflowStep)).toContain(value);
    }
  });

  it('timeclockReview covers PunchReview, not just the OtReviewState subset', () => {
    // timeclock.controller.ts lowercases the PunchReview column onto the wire; the
    // TimesheetsReport punch log renders all four values, `none` included.
    for (const value of prismaEnumValues('PunchReview')) {
      expect(Object.keys(STATUS_REGISTRY.timeclockReview)).toContain(value.toLowerCase());
    }
  });
});

describe('status intent role maps', () => {
  it.each([
    ['STATUS_INTENT_CLASSES', STATUS_INTENT_CLASSES],
    ['STATUS_INTENT_FILL', STATUS_INTENT_FILL],
    ['STATUS_INTENT_TEXT', STATUS_INTENT_TEXT],
  ])('%s is total over StatusIntent', (_name, map) => {
    expect(Object.keys(map).sort()).toEqual([...INTENTS].sort());
  });

  // Raw Tailwind palette families that must never appear in a role map.
  const RAW_PALETTE =
    /\b(?:bg|text|border(?:-[trblxyse])?)-(?:blue|cyan|teal|sky|orange|red|green|emerald|amber|rose|indigo|violet|purple|pink|fuchsia|lime|yellow|sage|ocean|terracotta)-\d{2,3}\b/;

  it.each([
    ['STATUS_INTENT_CLASSES', STATUS_INTENT_CLASSES],
    ['STATUS_INTENT_FILL', STATUS_INTENT_FILL],
    ['STATUS_INTENT_TEXT', STATUS_INTENT_TEXT],
  ])('%s spells no raw palette class and no raw hex', (_name, map) => {
    for (const value of Object.values(map)) {
      expect(value).not.toMatch(RAW_PALETTE);
      expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('FILL uses the -strong role (white-safe), except brand which has no -strong token', () => {
    expect(STATUS_INTENT_FILL.brand).toBe('bg-primary');
    for (const intent of INTENTS.filter((i) => i !== 'brand')) {
      expect(STATUS_INTENT_FILL[intent]).toMatch(/^bg-[a-z]+-strong$/);
    }
  });
});

/**
 * Full resolution table over STATUS_REGISTRY, snapshotted.
 *
 * WHAT IT COVERS. Total over STATUS_REGISTRY: every domain x status is resolved
 * to its intent, its label and its exact chip / fill / text class strings. It
 * therefore proves that no registry entry's intent, label or resolved class
 * string changed.
 *
 * WHAT IT PROVES NOTHING ABOUT. What any component actually renders. A call site
 * that does not read the registry, or that reads it and then overrides the label
 * or the colour locally, is invisible here. This snapshot cannot see a single
 * call-site change: it is total over the registry, not over the app, and it is
 * not a substitute for a visual check of any kind. Call-site appearance is
 * covered by the appearance table in
 * md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md, which is
 * maintained by hand.
 */
describe('status registry - full resolution table', () => {
  it('resolves every status to its intent class string', () => {
    const lines: string[] = [];
    for (const domain of ALL_DOMAINS) {
      for (const [status, entry] of Object.entries(STATUS_REGISTRY[domain])) {
        lines.push(
          `${domain}.${status} -> intent=${entry.intent} | label=${entry.label} | ` +
            `chip=${STATUS_INTENT_CLASSES[entry.intent]} | fill=${STATUS_INTENT_FILL[entry.intent]} | ` +
            `text=${STATUS_INTENT_TEXT[entry.intent]}`,
        );
      }
    }
    expect(lines.join('\n')).toMatchSnapshot();
  });
});

// Scheduling-notifications slice 07: the trip milestone is called "on the way" everywhere a
// user reads it. The enum VALUE stays EN_ROUTE (VisitStatus); only the label the Visits cards,
// the schedule board and global search resolve through this block changes.
describe('status registry - the on-the-way visit state', () => {
  it('labels job.EN_ROUTE "On the way"', () => {
    expect(STATUS_REGISTRY.job.EN_ROUTE.label).toBe('On the way');
  });

  it('never says "en route" in any label of any domain', () => {
    for (const domain of Object.keys(STATUS_REGISTRY) as StatusDomain[]) {
      for (const [status, entry] of Object.entries(STATUS_REGISTRY[domain])) {
        expect(entry.label, `${domain}.${status}`).not.toMatch(/en[ -]route/i);
      }
    }
  });
});
