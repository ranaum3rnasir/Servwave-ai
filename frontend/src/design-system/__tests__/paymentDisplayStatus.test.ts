import { describe, expect, it } from 'vitest';

import { STATUS_REGISTRY } from '@/design-system/status-registry';

/** The Payments page words (payments go-live P6): label-only, no Prisma enum behind them. */
describe('paymentDisplay status vocabulary', () => {
  const entry = (k: string) => STATUS_REGISTRY.paymentDisplay[k]!;

  it('names every display status the payments API sends', () => {
    const apiStatuses = ['Succeeded', 'Pending', 'Failed', 'Disputed', 'Charged back', 'Voided', 'Refunded', 'Partially refunded'];
    for (const s of apiStatuses) expect(entry(s)?.label).toBe(s);
  });

  it('colours them as the mockup does', () => {
    expect(entry('Succeeded').intent).toBe('success');
    expect(entry('Pending').intent).toBe('warning');
    expect(entry('Failed').intent).toBe('danger');
    expect(entry('Refunded').intent).toBe('neutral');
    expect(entry('Partially refunded').intent).toBe('warning');
    expect(entry('Disputed').intent).toBe('danger');
    expect(entry('Charged back').intent).toBe('danger');
  });
});
