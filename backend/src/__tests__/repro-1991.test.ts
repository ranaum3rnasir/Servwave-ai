/**
 * REPRODUCTION for issue #1991 — "Markup % is capped at 100".
 *
 * Reported on prod (commit ee41aaf5f, Servwave Demo org): entering a markup above 100 on an
 * estimate, job or invoice line item is rejected. Pass A captured the API evidence:
 *
 *   POST https://api.servwave.com/api/estimates/<id>/line-items  {"markup_percent":108,...}
 *   -> HTTP 400
 *      {"error":"Validation failed",
 *       "details":[{"field":"markup_percent","message":"Number must be less than or equal to 100"}]}
 *
 * ...identically on the job and invoice line endpoints, on add AND update, and on the two
 * whole-document estimate paths (they share `lineItemSchema`).
 *
 * Decided fix (Ran, 2026-09-18 — superseding the interim 100000 bound): markup is NOT capped.
 * The bound becomes `.min(0).finite()` on every site: no upper limit at all, only a refusal of a
 * value that is not a real number. 0 and negative handling is UNCHANGED — a negative markup must
 * stay rejected. `.finite()` is not a ceiling; it exists because `JSON.parse('1e999')` yields
 * Infinity, `z.number()` accepts Infinity, and no numeric column can store it — without it the
 * removal of `.max()` would trade one 400 for a 500.
 *
 * This file asserts the UNCAPPED behaviour at the five declarations that carried the ceiling:
 *   backend/src/controllers/estimate.controller.ts     lineItemObjectSchema (backs all 4 estimate paths)
 *   backend/src/controllers/job-lines.controller.ts    addLineSchema, updateLineSchema
 *   backend/src/controllers/invoice-lines.controller.ts addLineSchema, updateLineSchema
 *
 * The schemas are exercised directly (the same objects `validate()` calls `.parse()` on) and any
 * rejection is rendered through the REAL `zodValidationFailure()`, so a failure prints the exact
 * 400 body prod returned rather than an opaque Zod dump.
 *
 * The last describe block covers the half a mocked-Prisma suite cannot see: the markup_percent
 * COLUMNS are the bound that actually refuses the write. They were `Decimal(5, 2)` when #1991 was
 * filed and `Decimal(8, 2)` (max 999,999.99) after it, so relaxing Zod alone would still
 * 22003-overflow for anything >= 1,000,000 — a clean 400 turned into a failed write on a surface
 * that just told the operator their number was fine. Uncapping therefore needs a widening
 * migration as well as the Zod change; that block asserts the column can hold every value the
 * uncapped schemas now accept.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ZodTypeAny } from 'zod';
import { zodValidationFailure } from '../middleware/validate';
import { createEstimateSchema, updateEstimateSchema } from '../controllers/estimate.controller';
import {
  addLineSchema as estimateAddLineSchema,
  updateLineSchema as estimateUpdateLineSchema,
} from '../controllers/estimate-lines.controller';
import {
  addLineSchema as jobAddLineSchema,
  updateLineSchema as jobUpdateLineSchema,
} from '../controllers/job-lines.controller';
import {
  addLineSchema as invoiceAddLineSchema,
  updateLineSchema as invoiceUpdateLineSchema,
} from '../controllers/invoice-lines.controller';
import { createPunchSchema } from '../controllers/timeclock.controller';

/** The ceiling that was retired on 2026-09-18. Kept only as a value that must now be EXCEEDED. */
const RETIRED_CEILING = 100_000;
/**
 * Values a user must be able to save. 108 is the reporter's own number; the last three sit far
 * above the retired ceiling, and 1e308 is the largest finite value any JSON body can carry.
 */
const ACCEPTED = [108, 1000, RETIRED_CEILING, RETIRED_CEILING + 1, 5_000_000, 1e308];
const CUSTOMER_ID = '79d92fe5-c5fd-4d5b-9c0e-fbbf893a8dd2'; // qa-1991-markup-cap (prod demo org)

function line(markup: number) {
  return {
    description: 'qa-1991 markup line',
    quantity: 1,
    unit_price: 34164.43,
    markup_percent: markup,
    item_type: 'MATERIAL' as const,
    is_taxable: true,
  };
}

type Site = {
  /** The user-facing request this schema validates. */
  name: string;
  schema: ZodTypeAny;
  /** Request body carrying the given markup. */
  body: (markup: number) => unknown;
  /** The `field` the 400 details entry carries for this body shape. */
  field: string;
};

const SITES: Site[] = [
  {
    name: 'POST /api/estimates (whole-document create)',
    schema: createEstimateSchema,
    body: (m) => ({ customer_id: CUSTOMER_ID, line_items: [line(m)] }),
    field: 'line_items.0.markup_percent',
  },
  {
    name: 'PATCH /api/estimates/:id (whole-document update)',
    schema: updateEstimateSchema,
    body: (m) => ({ line_items: [line(m)] }),
    field: 'line_items.0.markup_percent',
  },
  {
    name: 'POST /api/estimates/:id/line-items',
    schema: estimateAddLineSchema,
    body: (m) => line(m),
    field: 'markup_percent',
  },
  {
    name: 'PATCH /api/estimates/:id/line-items/:lineId',
    schema: estimateUpdateLineSchema,
    body: (m) => ({ markup_percent: m }),
    field: 'markup_percent',
  },
  {
    name: 'POST /api/jobs/:id/line-items',
    schema: jobAddLineSchema,
    body: (m) => line(m),
    field: 'markup_percent',
  },
  {
    name: 'PATCH /api/jobs/:id/line-items/:lineId',
    schema: jobUpdateLineSchema,
    body: (m) => ({ markup_percent: m }),
    field: 'markup_percent',
  },
  {
    name: 'POST /api/invoices/:id/line-items',
    schema: invoiceAddLineSchema,
    body: (m) => line(m),
    field: 'markup_percent',
  },
  {
    name: 'PATCH /api/invoices/:id/line-items/:lineId',
    schema: invoiceUpdateLineSchema,
    body: (m) => ({ markup_percent: m }),
    field: 'markup_percent',
  },
];

/** Runs the schema exactly as `validate()` does, returning the 400 body it would have sent. */
function reject(site: Site, markup: number): { error: string; details: { field: string; message: string }[] } | null {
  const parsed = site.schema.safeParse(site.body(markup));
  return parsed.success ? null : zodValidationFailure(parsed.error);
}

describe('markup_percent is not capped on any line-item surface', () => {
  for (const site of SITES) {
    for (const markup of ACCEPTED) {
      it(`${site.name} accepts markup_percent ${markup}`, () => {
        const failure = reject(site, markup);
        // Printing the 400 body makes the failure the SAME text prod returned:
        // {"error":"Validation failed","details":[{"field":"markup_percent",
        //  "message":"Number must be less than or equal to 100"}]}
        expect(failure && JSON.stringify(failure)).toBeNull();
      });
    }
  }
});

describe('the guardrails uncapping must NOT relax', () => {
  for (const site of SITES) {
    it(`${site.name} still rejects a negative markup_percent`, () => {
      const failure = reject(site, -1);
      expect(failure).not.toBeNull();
      expect(failure!.details).toContainEqual({
        field: site.field,
        message: 'Number must be greater than or equal to 0',
      });
    });

    // Not a ceiling: Infinity is what `JSON.parse('{"markup_percent":1e999}')` produces, and it is
    // the one "number" no column can store. Refusing it at the edge is what keeps the removal of
    // the ceiling from converting a 400 into a 500.
    it(`${site.name} still rejects a non-finite markup_percent`, () => {
      const failure = reject(site, Infinity);
      expect(failure).not.toBeNull();
      expect(failure!.details.map((d) => d.field)).toContain(site.field);
    });
  }
});

// ── The bounds a careless sweep WILL cross ───────────────────────────────────────────────────
// 100000 was never only the markup ceiling. The same literal caps line QUANTITY on both job-line
// schemas and `accuracy_m` on the time-clock punch, and those three are unrelated limits that
// Ran's "nothing is capped" ruling did not touch. The next person to widen or retire a markup
// bound will grep for the NUMBER, find these, and take them out with it. Match on the FIELD.
//
// Deliberately behavioural: a source-text assertion would pass against a schema that had been
// rewritten to `.max(100_000)` or `.lte(100000)` while still being a cap, and would fail against
// a harmless reformat. What has to survive is the refusal.
describe('the 100000 bounds this change must NOT touch', () => {
  const OVER = 100_001;

  it('POST /api/jobs/:id/line-items still refuses a quantity over 100000', () => {
    const failure = reject({ ...SITES.find((s) => s.schema === jobAddLineSchema)!, body: () => ({ ...line(1), quantity: OVER }) }, 1);
    expect(failure).not.toBeNull();
    expect(failure!.details.map((d) => d.field)).toContain('quantity');
  });

  it('PATCH /api/jobs/:id/line-items/:lineId still refuses a quantity over 100000', () => {
    const parsed = jobUpdateLineSchema.safeParse({ quantity: OVER });
    expect(parsed.success).toBe(false);
    expect(zodValidationFailure(parsed.success ? ({ issues: [] } as never) : parsed.error).details.map((d) => d.field)).toContain('quantity');
  });

  it('POST /api/timeclock/punches still refuses an accuracy_m over 100000', () => {
    const parsed = createPunchSchema.safeParse({ type: 'IN', lat: 30, lng: -97, accuracy_m: OVER });
    expect(parsed.success).toBe(false);
    expect(zodValidationFailure(parsed.success ? ({ issues: [] } as never) : parsed.error).details.map((d) => d.field)).toContain('accuracy_m');
  });

  it('each of those three still ACCEPTS the value at its boundary', () => {
    expect(jobAddLineSchema.safeParse({ ...line(1), quantity: 100_000 }).success).toBe(true);
    expect(jobUpdateLineSchema.safeParse({ quantity: 100_000 }).success).toBe(true);
    expect(createPunchSchema.safeParse({ type: 'IN', lat: 30, lng: -97, accuracy_m: 100_000 }).success).toBe(true);
  });
});

// ── The storage half: Zod is no longer the binding bound — the column is ──────────────────
// Prisma is fully mocked in this suite (setup.ts), so no schema-level test can catch a column
// that is too narrow for the value the API now accepts. Assert the declared precision instead:
// Decimal(p, s) stores at most (p - s) integer digits, and the uncapped schemas above accept any
// FINITE double, the largest of which (Number.MAX_VALUE, 1.797...e308) has 309 integer digits.
// That is what makes the column beyond reach rather than merely wider: there is no value the API
// can accept that it cannot hold.
describe('the markup_percent columns must hold everything the uncapped schemas accept', () => {
  const schemaPrisma = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  /** 1.7976931348623157e308 -> 309 integer digits. */
  const INTEGER_DIGITS_NEEDED = BigInt(Math.trunc(Number.MAX_VALUE).toLocaleString('fullwide', { useGrouping: false })).toString().length;

  const columns = schemaPrisma
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /^\s*markup_percent\s/.test(text));

  it('finds the three markup_percent columns (EstimateLineItem, InvoiceLineItem, JobLineItem)', () => {
    expect(columns).toHaveLength(3);
  });

  it('needs 309 integer digits to hold the largest finite double', () => {
    expect(INTEGER_DIGITS_NEEDED).toBe(309);
  });

  for (const { text, line: lineNo } of columns) {
    const match = /@db\.Decimal\((\d+),\s*(\d+)\)/.exec(text);
    it(`schema.prisma:${lineNo} can store any finite markup (${text.trim()})`, () => {
      expect(match).not.toBeNull();
      const [precision, scale] = [Number(match![1]), Number(match![2])];
      expect(precision - scale).toBeGreaterThanOrEqual(INTEGER_DIGITS_NEEDED);
      // Scale stays 2. The column is uncapped in reach, NOT unconstrained in shape: every reader,
      // every total and the previous instance during a deploy overlap all assume markup is stored
      // rounded to 2 decimals. See the migration for the full reasoning.
      expect(scale).toBe(2);
    });
  }
});
