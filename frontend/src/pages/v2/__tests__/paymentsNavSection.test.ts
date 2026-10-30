import { describe, expect, it } from 'vitest';

import { DEFAULT_LAYOUT_KEYS, getDestination } from '@/components/layout/nav-registry';

import { buildNavSections } from '../buildNavSections';
import { NAV_SECTIONS, sectionForKey } from '../navSections';

const everySwitchOn = new Proxy({}, { get: () => true }) as Record<string, unknown>;

function build(values: Record<string, unknown>) {
  return buildNavSections({
    keys: DEFAULT_LAYOUT_KEYS,
    sections: NAV_SECTIONS,
    getDestination,
    can: () => true,
    values,
    isLocked: () => false,
    isFeatureLocked: () => false,
  });
}

describe('the Payments sidebar row', () => {
  it('is claimed by the Billing section, between Invoices and Service Plans', () => {
    expect(sectionForKey('payments')).toBe('Billing');
    const billing = build(everySwitchOn).find((s) => s.section === 'Billing')!;
    expect(billing.items.map((i) => i.dest.label)).toEqual(['Estimates', 'Invoices', 'Payments', 'Service Plans']);
  });

  it('shows with View payments on, and not without it', () => {
    const labels = (values: Record<string, boolean>) =>
      build(values).flatMap((s) => s.items.map((i) => i.dest.label));
    expect(labels({ view_payments: true })).toContain('Payments');
    expect(labels({ view_payments: false })).not.toContain('Payments');
    expect(labels({})).not.toContain('Payments');
  });

  it('does not depend on Access Billing, and the flat Billing row stays in Operations', () => {
    const sections = build({ view_payments: true });
    const labels = sections.flatMap((s) => s.items.map((i) => i.dest.label));
    expect(labels).toContain('Payments');
    expect(labels).not.toContain('Billing');
    expect(sectionForKey('billing')).toBe('Operations');
  });
});
