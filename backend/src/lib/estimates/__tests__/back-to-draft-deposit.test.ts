/**
 * #2031 slice 4 — sending an estimate back to draft unlocks its deposit.
 *
 * Back to draft cleared the public link, the signature, the T&C acceptance and the
 * changed-since-sent flag, but left `send_config` standing. Deposit editability is gated on that
 * configuration existing (EstimateReceiptCard's `deposit.editable`), so a sent estimate's deposit
 * stayed locked for ever and a salesperson who noticed a mismatch could not correct it.
 */
import { describe, it, expect } from 'vitest';
import { buildStatusChangeData, clearsSendConfig } from '../status-transitions';
import { ESTIMATE_STATUS } from '../../../constants/estimateStatus';

describe('moving an estimate back to draft', () => {
  const backToDraft = () => buildStatusChangeData(ESTIMATE_STATUS.SENT, ESTIMATE_STATUS.DRAFT);

  it('clears the frozen send configuration, so the deposit is the salesperson\'s again', () => {
    expect(clearsSendConfig(ESTIMATE_STATUS.DRAFT)).toBe(true);
  });

  it('still clears everything it cleared before', () => {
    expect(backToDraft()).toMatchObject({
      status: ESTIMATE_STATUS.DRAFT,
      public_token: null,
      signature_data: null,
      signature_ip: null,
      signature_at: null,
      terms_accepted: false,
      terms_accepted_at: null,
      modified_after_send: false,
    });
  });

  it("leaves the estimate's own deposit override alone, so the value is edited rather than lost", () => {
    const data = backToDraft();
    expect(data).not.toHaveProperty('deposit_type');
    expect(data).not.toHaveProperty('deposit_value');
  });

  it('does not touch the send configuration on any other move', () => {
    for (const to of [ESTIMATE_STATUS.SENT, ESTIMATE_STATUS.PENDING, ESTIMATE_STATUS.WON, ESTIMATE_STATUS.DECLINED, ESTIMATE_STATUS.ARCHIVED]) {
      expect(clearsSendConfig(to)).toBe(false);
      expect(buildStatusChangeData(ESTIMATE_STATUS.SENT, to)).not.toHaveProperty('send_config');
    }
  });
});
