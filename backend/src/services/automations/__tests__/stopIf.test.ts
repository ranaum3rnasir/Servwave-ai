import { describe, it, expect } from 'vitest';
import { stopIfHolds, stopIfReason } from '../stopIf';
import { STOP_IF_CONDITIONS } from '../workflowValidation';
import type { EntityState } from '../context';

describe('stopIfHolds', () => {
  describe('invoice_paid', () => {
    it('is false when status is SENT and amountDue is undefined', () => {
      const state: EntityState = { invoiceStatus: 'SENT' };
      expect(stopIfHolds('invoice_paid', state)).toBe(false);
    });

    it('is true when amountDue is 0 even if status is PARTIAL (credit zeroed the balance)', () => {
      const state: EntityState = { invoiceStatus: 'PARTIAL', invoiceAmountDue: 0 };
      expect(stopIfHolds('invoice_paid', state)).toBe(true);
    });

    it('is true when status is PAID even if amountDue is still positive', () => {
      const state: EntityState = { invoiceStatus: 'PAID', invoiceAmountDue: 50 };
      expect(stopIfHolds('invoice_paid', state)).toBe(true);
    });
  });

  describe('invoice_not_open', () => {
    it('is false when invoiceStatus is undefined', () => {
      expect(stopIfHolds('invoice_not_open', {})).toBe(false);
    });

    it('is false when status is SENT', () => {
      expect(stopIfHolds('invoice_not_open', { invoiceStatus: 'SENT' })).toBe(false);
    });

    it('is false when status is PARTIAL', () => {
      expect(stopIfHolds('invoice_not_open', { invoiceStatus: 'PARTIAL' })).toBe(false);
    });

    it('is true when status is PAID', () => {
      expect(stopIfHolds('invoice_not_open', { invoiceStatus: 'PAID' })).toBe(true);
    });

    it('is true when status is VOIDED', () => {
      expect(stopIfHolds('invoice_not_open', { invoiceStatus: 'VOIDED' })).toBe(true);
    });
  });

  describe('estimate_answered', () => {
    it('is false when estimateStatus is undefined (empty state)', () => {
      expect(stopIfHolds('estimate_answered', {})).toBe(false);
    });

    it('is false when status is SENT', () => {
      expect(stopIfHolds('estimate_answered', { estimateStatus: 'SENT' })).toBe(false);
    });

    // D6 (2026-07-21): PENDING means the customer approved and signed and only the deposit is
    // outstanding — that IS an answer, so a chase-for-a-decision sequence must stop here.
    it('is true when status is PENDING (customer approved; deposit outstanding)', () => {
      expect(stopIfHolds('estimate_answered', { estimateStatus: 'PENDING' })).toBe(true);
    });

    it('is true when status is WON', () => {
      expect(stopIfHolds('estimate_answered', { estimateStatus: 'WON' })).toBe(true);
    });

    it('is true when status is DECLINED', () => {
      expect(stopIfHolds('estimate_answered', { estimateStatus: 'DECLINED' })).toBe(true);
    });
  });

  describe('estimate_approved', () => {
    it('is false when status is SENT', () => {
      expect(stopIfHolds('estimate_approved', { estimateStatus: 'SENT' })).toBe(false);
    });

    it('is true when status is WON', () => {
      expect(stopIfHolds('estimate_approved', { estimateStatus: 'WON' })).toBe(true);
    });
  });

  describe('estimate_declined', () => {
    it('is false when status is WON', () => {
      expect(stopIfHolds('estimate_declined', { estimateStatus: 'WON' })).toBe(false);
    });

    it('is true when status is DECLINED', () => {
      expect(stopIfHolds('estimate_declined', { estimateStatus: 'DECLINED' })).toBe(true);
    });
  });

  describe('job_cancelled', () => {
    it('is false when status is SCHEDULED', () => {
      expect(stopIfHolds('job_cancelled', { jobStatus: 'SCHEDULED' })).toBe(false);
    });

    it('is true when status is CANCELLED', () => {
      expect(stopIfHolds('job_cancelled', { jobStatus: 'CANCELLED' })).toBe(true);
    });
  });

  describe('job_completed', () => {
    it('is false when status is IN_PROGRESS', () => {
      expect(stopIfHolds('job_completed', { jobStatus: 'IN_PROGRESS' })).toBe(false);
    });

    it('is true when status is COMPLETED', () => {
      expect(stopIfHolds('job_completed', { jobStatus: 'COMPLETED' })).toBe(true);
    });
  });

  describe('job_rescheduled', () => {
    const ISO = '2026-07-14T13:00:00.000Z';

    it('is false with no occurrenceKey', () => {
      const state: EntityState = { jobScheduledStart: new Date(ISO) };
      expect(stopIfHolds('job_rescheduled', state)).toBe(false);
    });

    it('is false with an occurrenceKey but jobScheduledStart null', () => {
      const state: EntityState = { jobScheduledStart: null };
      expect(stopIfHolds('job_rescheduled', state, ISO)).toBe(false);
    });

    it('is false when jobScheduledStart matches the occurrenceKey', () => {
      const state: EntityState = { jobScheduledStart: new Date(ISO) };
      expect(stopIfHolds('job_rescheduled', state, ISO)).toBe(false);
    });

    it('is true when jobScheduledStart differs from the occurrenceKey', () => {
      const state: EntityState = { jobScheduledStart: new Date('2026-07-15T13:00:00.000Z') };
      expect(stopIfHolds('job_rescheduled', state, ISO)).toBe(true);
    });
  });

  it('returns false for an empty state {} (lead entity) across every known condition', () => {
    const state: EntityState = {};
    const allConditions = Object.values(STOP_IF_CONDITIONS).flat();
    for (const condition of allConditions) {
      expect(stopIfHolds(condition, state)).toBe(false);
    }
  });

  it('returns false for an unknown/illegal condition', () => {
    expect(stopIfHolds('not_a_real_condition', { invoiceStatus: 'PAID' })).toBe(false);
  });
});

describe('stopIfReason', () => {
  const allConditions = Object.values(STOP_IF_CONDITIONS).flat();

  it('returns a human sentence for every condition in STOP_IF_CONDITIONS', () => {
    for (const condition of allConditions) {
      const reason = stopIfReason(condition);
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('returns a generic fallback for an unknown condition', () => {
    const reason = stopIfReason('not_a_real_condition');
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
    expect(allConditions.map((c) => stopIfReason(c))).not.toContain(reason);
  });
});
