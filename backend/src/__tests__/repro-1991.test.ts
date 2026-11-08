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
 * Decided fix (Ran): the bound becomes `.min(0).max(100000)` on every site. 0 and negative
 * handling is UNCHANGED — a negative markup must stay rejected.
 *
 * This file asserts the FIXED behaviour, so it fails on the base commit at the five
 * `markup_percent: z.number().min(0).max(100)` declarations and passes once they are widened:
 *   backend/src/controllers/estimate.controller.ts:510     (backs all 4 estimate paths)
 *   backend/src/controllers/job-lines.controller.ts:78, :90
 *   backend/src/controllers/invoice-lines.controller.ts:72, :83
 *
 * The schemas are exercised directly (the same objects `validate()` calls `.parse()` on) and any
 * rejection is rendered through the REAL `zodValidationFailure()`, so a failure prints the exact
 * 400 body prod returned rather than an opaque Zod dump.
 *
 * The last describe block covers the half a mocked-Prisma suite cannot see: all three
 * markup_percent COLUMNS are `Decimal(5, 2)` (max representable 999.99), so relaxing Zod alone
 * still 22003-overflows on the write for anything >= 1000. The reported value 108 fits; 1000 and
 * 100000 do not. The fix therefore needs a widening migration as well as the Zod change.
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

/** The new upper bound Ran decided on. */
const MARKUP_MAX = 100_000;
/** Values a user must be able to save (108 is the reporter's own number). */
const ACCEPTED = [108, 1000, MARKUP_MAX];
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

describe('#1991 — markup_percent above 100 must be accepted on every line-item surface', () => {
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

describe('#1991 — the guardrails the fix must NOT relax', () => {
  for (const site of SITES) {
    it(`${site.name} still rejects a negative markup_percent`, () => {
      const failure = reject(site, -1);
      expect(failure).not.toBeNull();
      expect(failure!.details).toContainEqual({
        field: site.field,
        message: 'Number must be greater than or equal to 0',
      });
    });

    it(`${site.name} still rejects markup_percent above ${MARKUP_MAX}`, () => {
      const failure = reject(site, MARKUP_MAX + 1);
      expect(failure).not.toBeNull();
      expect(failure!.details.map((d) => d.field)).toContain(site.field);
    });
  }
});

// ── The storage half: Zod is not the only 100-shaped bound in the path ────────────────────
// Prisma is fully mocked in this suite (setup.ts), so no schema-level test can catch a column
// that is too narrow for the value the API now accepts. Assert the declared precision instead:
// Decimal(p, s) stores at most (p - s) integer digits, and MARKUP_MAX needs 6.
describe('#1991 — the markup_percent columns must hold what the API accepts', () => {
  const schemaPrisma = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const INTEGER_DIGITS_NEEDED = String(MARKUP_MAX).length; // 100000 -> 6

  const columns = schemaPrisma
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /^\s*markup_percent\s/.test(text));

  it('finds the three markup_percent columns (EstimateLineItem, InvoiceLineItem, JobLineItem)', () => {
    expect(columns).toHaveLength(3);
  });

  for (const { text, line: lineNo } of columns) {
    const match = /@db\.Decimal\((\d+),\s*(\d+)\)/.exec(text);
    it(`schema.prisma:${lineNo} can store ${MARKUP_MAX} (${text.trim()})`, () => {
      expect(match).not.toBeNull();
      const [precision, scale] = [Number(match![1]), Number(match![2])];
      expect(precision - scale).toBeGreaterThanOrEqual(INTEGER_DIGITS_NEEDED);
    });
  }
});
