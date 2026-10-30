import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { paymentsRegistry } from '../payments';

// frontend/src/lib/filters/registries/__tests__ -> repo root is six levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', '..', '..', '..', '..', '..', 'backend', 'src');
const backendFilters = readFileSync(join(BACKEND, 'lib', 'query', 'registries', 'payment.filters.ts'), 'utf8');
const backendController = readFileSync(join(BACKEND, 'controllers', 'payments-page.controller.ts'), 'utf8');

/** The string literals inside `export const NAME = [ ... ]` of the backend registry. */
function listOf(name: string): string[] {
  const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(backendFilters);
  if (!m) throw new Error(`${name} not found in payment.filters.ts`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const facet = (key: string) => paymentsRegistry.find((f) => f.key === key)!;
const values = (key: string) => (facet(key).options ?? []).map((o) => o.value);

describe('the payments filter registry matches the backend registry', () => {
  it('status options are all slugs the backend accepts', () => {
    const slugs = listOf('PAYMENT_STATUS_SLUGS');
    expect(values('status').length).toBeGreaterThan(0);
    for (const v of values('status')) expect(slugs).toContain(v);
    expect(facet('status').param).toBe('status');
  });

  it('offers the statuses the page shows, under their display names (Charged back and Voided stay: the API sends them)', () => {
    const labels = facet('status').options!.map((o) => o.label);
    expect(labels).toEqual(['Succeeded', 'Pending', 'Failed', 'Refunded', 'Partially refunded', 'Disputed', 'Refund failed', 'Charged back', 'Voided']);
  });

  it('method options are the backend methods, labelled for people', () => {
    expect(values('method').sort()).toEqual([...listOf('PAYMENT_METHODS')].sort());
    expect(facet('method').options!.map((o) => o.label).sort()).toEqual(['Bank (ACH)', 'Credit card']);
  });

  it('labels the payout facet "Payout status"', () => {
    expect(facet('payout_status').label).toBe('Payout status');
  });

  it('payout status options are the backend keys', () => {
    expect(values('payout_status').sort()).toEqual([...listOf('PAYOUT_STATUS_KEYS')].sort());
    expect(facet('payout_status').options!.map((o) => o.label)).toEqual(['Awaiting payout', 'In transit', 'Paid out', 'Payout failed']);
  });

  it('amount is a money range whose wire params the backend reads', () => {
    const amount = facet('amount');
    expect(amount.kind).toBe('range');
    expect(amount.money).toBe(true);
    expect(backendController).toContain(`req.query.${amount.param}_min`);
    expect(backendController).toContain(`req.query.${amount.param}_max`);
  });

  it('has no date facet: time is the period picker only', () => {
    expect(paymentsRegistry.some((f) => f.kind === 'dateRange')).toBe(false);
    expect(paymentsRegistry.map((f) => f.key)).toEqual(['status', 'amount', 'method', 'payout_status']);
  });
});
