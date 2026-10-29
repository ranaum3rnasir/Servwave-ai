import { describe, it, expect } from 'vitest';
import { createEstimateSchema, updateEstimateSchema } from '../controllers/estimate.controller';

// F-45 — a PERCENTAGE discount over 100% drives a negative estimate total. The schema must
// reject it (FIXED_AMOUNT is separately clamped to the line/subtotal in the controller, so a
// large fixed value stays valid).
const LEAD = '00000000-0000-0000-0000-000000000001';
const baseLine = { description: 'Repair', quantity: 1, unit_price: 100 };

describe('F-45 percentage discount clamp', () => {
  it('rejects a line-item PERCENTAGE discount_value > 100', () => {
    const r = createEstimateSchema.safeParse({
      lead_id: LEAD,
      line_items: [{ ...baseLine, discount_type: 'PERCENTAGE', discount_value: 500 }],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a line-item FIXED_AMOUNT discount > 100 (clamped in the controller, not rejected)', () => {
    const r = createEstimateSchema.safeParse({
      lead_id: LEAD,
      line_items: [{ ...baseLine, discount_type: 'FIXED_AMOUNT', discount_value: 500 }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an estimate-level PERCENTAGE discount_value > 100', () => {
    const r = createEstimateSchema.safeParse({
      lead_id: LEAD,
      line_items: [{ ...baseLine }],
      discount_type: 'PERCENTAGE',
      discount_value: 150,
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid percentage discount (<= 100) at both levels', () => {
    const r = createEstimateSchema.safeParse({
      lead_id: LEAD,
      line_items: [{ ...baseLine, discount_type: 'PERCENTAGE', discount_value: 50 }],
      discount_type: 'PERCENTAGE',
      discount_value: 10,
    });
    expect(r.success).toBe(true);
  });

  it('updateEstimateSchema also rejects a PERCENTAGE > 100', () => {
    const r = updateEstimateSchema.safeParse({
      line_items: [{ ...baseLine, discount_type: 'PERCENTAGE', discount_value: 200 }],
    });
    expect(r.success).toBe(false);
  });
});

// #2010 finding 2 — deposit_value had no equivalent ceiling: a PERCENTAGE deposit over 100 bills
// more than the estimate total. depositPctGuard mirrors discountPctGuard exactly.
describe('#2010 deposit percentage clamp (depositPctGuard)', () => {
  it('rejects updateEstimateSchema PERCENTAGE deposit_value > 100 with the deposit message', () => {
    const r = updateEstimateSchema.safeParse({ deposit_type: 'PERCENTAGE', deposit_value: 500 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe('Deposit percentage cannot exceed 100');
      expect(r.error.issues[0].path).toEqual(['deposit_value']);
    }
  });

  it('accepts updateEstimateSchema PERCENTAGE deposit_value === 100', () => {
    const r = updateEstimateSchema.safeParse({ deposit_type: 'PERCENTAGE', deposit_value: 100 });
    expect(r.success).toBe(true);
  });

  it('leaves a FIXED deposit_value > 100 unaffected (clamped in the controller, not rejected)', () => {
    const r = updateEstimateSchema.safeParse({ deposit_type: 'FIXED', deposit_value: 500 });
    expect(r.success).toBe(true);
  });
});
