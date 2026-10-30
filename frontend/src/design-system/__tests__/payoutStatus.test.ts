import { describe, expect, it } from 'vitest';

import { STATUS_REGISTRY } from '@/design-system/status-registry';

/** The Payouts tab words (payments go-live P8): label-only, no Prisma enum behind them (payouts keep a text status). */
describe('payout status vocabulary', () => {
  const entry = (k: string) => STATUS_REGISTRY.payout[k]!;

  it('words every status the payouts API sends', () => {
    expect(entry('PAID').label).toBe('Paid');
    expect(entry('IN_TRANSIT').label).toBe('In transit');
    expect(entry('PENDING').label).toBe('Scheduled');
    expect(entry('FAILED').label).toBe('Failed');
    expect(entry('CANCELED').label).toBe('Canceled');
  });

  it('colours them: paid green, failed red, in transit blue, the rest neutral', () => {
    expect(entry('PAID').intent).toBe('success');
    expect(entry('FAILED').intent).toBe('danger');
    expect(entry('IN_TRANSIT').intent).toBe('info');
    expect(entry('PENDING').intent).toBe('neutral');
    expect(entry('CANCELED').intent).toBe('neutral');
  });
});
