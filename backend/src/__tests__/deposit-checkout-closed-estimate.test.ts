/**
 * Payments go-live slice 27 (slice 15 review) - a deposit takes no money once its estimate is
 * closed. A cancelled or declined estimate used to leave a PARTIAL (or a bank-pending) deposit
 * payable from its own link. A won estimate is NOT closed: under "pay later", and after a bank
 * debit failed, the deposit stays open on a WON estimate.
 */
import { describe, it, expect } from 'vitest';
import { depositCheckoutRefusal, DEPOSIT_VOIDED_CODE } from '../controllers/invoice.controller';

const org = { deposit_default_type: 'PERCENTAGE' as const, deposit_default_percentage: 50, deposit_default_fixed_amount: null };

const deposit = (invoiceStatus: string, estimateStatus: string) => ({
  kind: 'DEPOSIT',
  status: invoiceStatus,
  total_amount: 500,
  estimate: { status: estimateStatus, modified_after_send: false, deposit_type: 'PERCENTAGE' as const, deposit_value: 50, total_amount: 1000 },
});

describe('depositCheckoutRefusal - the estimate behind the deposit', () => {
  it.each(['DECLINED', 'ARCHIVED', 'EXPIRED'])('refuses a part-paid deposit on a %s estimate', (estimateStatus) => {
    const refusal = depositCheckoutRefusal(deposit('PARTIAL', estimateStatus), org);
    expect(refusal?.code).toBe(DEPOSIT_VOIDED_CODE);
  });

  it.each(['DECLINED', 'ARCHIVED', 'EXPIRED'])('refuses an unpaid deposit on a %s estimate', (estimateStatus) => {
    expect(depositCheckoutRefusal(deposit('SENT', estimateStatus), org)?.code).toBe(DEPOSIT_VOIDED_CODE);
  });

  it.each(['SENT', 'PENDING', 'WON'])('still opens an unpaid deposit on a %s estimate', (estimateStatus) => {
    expect(depositCheckoutRefusal(deposit('SENT', estimateStatus), org)).toBeNull();
  });

  it('a paid deposit still answers "already paid" first, whatever happened to the estimate', () => {
    expect(depositCheckoutRefusal(deposit('PAID', 'ARCHIVED'), org)?.code).toBe('DEPOSIT_ALREADY_PAID');
  });
});
