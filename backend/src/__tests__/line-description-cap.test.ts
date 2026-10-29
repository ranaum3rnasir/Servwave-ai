/**
 * One description cap across every line-item surface (#1604).
 *
 * A line's `description` carries the item name AND its detail text in a single column
 * (AddLineDialog concatenates `${name}\n${detail}` before POSTing), and the orgs using this
 * paste whole scope-of-work documents into it - prod's longest live description is 4,917
 * characters against the old 5,000 cap, and one row literally begins "-- 2 of 12 --" because a
 * user had started splitting a document across line items by hand.
 *
 * The cap therefore lives in ONE exported constant that the estimate, job and invoice schemas
 * all import. They previously carried three independent `.max(5000)` literals, which is exactly
 * how the estimate surface had drifted to 5,000 while Job and Invoice sat at 500 before the v12
 * unification. The column itself is unbounded Postgres `text`, so the cap is a product choice,
 * not a storage limit.
 */
import { describe, it, expect } from 'vitest';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';
import { addLineSchema as estimateAddLine, updateLineSchema as estimateUpdateLine } from '../controllers/estimate-lines.controller';
import { addLineSchema as jobAddLine, updateLineSchema as jobUpdateLine } from '../controllers/job-lines.controller';
import { addLineSchema as invoiceAddLine, updateLineSchema as invoiceUpdateLine } from '../controllers/invoice-lines.controller';

const atCap = 'x'.repeat(LINE_DESCRIPTION_MAX);
const overCap = 'x'.repeat(LINE_DESCRIPTION_MAX + 1);

const ADD_SURFACES = [
  ['estimate', estimateAddLine, { quantity: 1, unit_price: 10 }],
  ['job', jobAddLine, { quantity: 1, unit_price: 10 }],
  ['invoice', invoiceAddLine, { quantity: 1, unit_price: 10 }],
] as const;

const UPDATE_SURFACES = [
  ['estimate', estimateUpdateLine],
  ['job', jobUpdateLine],
  ['invoice', invoiceUpdateLine],
] as const;

describe('line-item description cap', () => {
  it('is 50,000 characters', () => {
    expect(LINE_DESCRIPTION_MAX).toBe(50_000);
  });

  it.each(ADD_SURFACES)('%s add accepts a description at the cap', (_name, schema, rest) => {
    expect(schema.safeParse({ description: atCap, ...rest }).success).toBe(true);
  });

  it.each(ADD_SURFACES)('%s add rejects one character over the cap', (_name, schema, rest) => {
    expect(schema.safeParse({ description: overCap, ...rest }).success).toBe(false);
  });

  it.each(UPDATE_SURFACES)('%s update accepts a description at the cap', (_name, schema) => {
    expect(schema.safeParse({ description: atCap }).success).toBe(true);
  });

  it.each(UPDATE_SURFACES)('%s update rejects one character over the cap', (_name, schema) => {
    expect(schema.safeParse({ description: overCap }).success).toBe(false);
  });
});
