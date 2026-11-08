import { describe, it, expect } from 'vitest';
import {
  CustomerKind,
  CustomerSegment,
  InvoiceKind,
  VoidPaymentReason,
  RefundCategory,
  InvoiceStatus,
} from '@prisma/client';

/**
 * Entity-redesign Phase 0 smoke test.
 *
 * Purely additive schema: asserts `prisma generate` regenerated the client with
 * the new enums and the new InvoiceStatus values. This is the cheap signal that
 * the additive migration's datamodel is in the generated client; the legacy
 * models (Deposit/JobCharge) intentionally remain until Phase D.
 *
 * See md_files/plans/entity-redesign/00-implementation-plan.md (Phase 0).
 */
describe('entity-redesign Phase 0 — additive schema shape', () => {
  it('exposes the new §2/§6/§8 enums', () => {
    expect(CustomerKind.PERSON).toBe('PERSON');
    expect(CustomerKind.COMPANY).toBe('COMPANY');
    expect(CustomerSegment.RESIDENTIAL).toBe('RESIDENTIAL');
    expect(CustomerSegment.COMMERCIAL).toBe('COMMERCIAL');
    expect(InvoiceKind.DEPOSIT).toBe('DEPOSIT');
    expect(InvoiceKind.STANDARD).toBe('STANDARD');
    expect(VoidPaymentReason.CHARGEBACK).toBe('CHARGEBACK');
    expect(RefundCategory.OVERPAYMENT).toBe('OVERPAYMENT');
  });

  it('adds PARTIALLY_REFUNDED + DISPUTED to InvoiceStatus', () => {
    expect(InvoiceStatus.PARTIALLY_REFUNDED).toBe('PARTIALLY_REFUNDED');
    expect(InvoiceStatus.DISPUTED).toBe('DISPUTED');
  });

  it('keeps the legacy InvoiceStatus values (nothing removed in Phase 0)', () => {
    expect(InvoiceStatus.DRAFT).toBe('DRAFT');
    expect(InvoiceStatus.REFUNDED).toBe('REFUNDED');
  });
});
