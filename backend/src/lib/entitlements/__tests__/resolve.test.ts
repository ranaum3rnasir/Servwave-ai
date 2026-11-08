import { describe, it, expect } from 'vitest';
import { effectivePlan, orgFeatures, hasFeature, isKnownFeature } from '../resolve';

const base = (
  plan: string,
  trial_ends_at: Date | null = null,
  feature_overrides: Record<string, unknown> = {},
) => ({ plan, trial_ends_at, feature_overrides }) as Parameters<typeof orgFeatures>[0];

describe('effectivePlan', () => {
  it('returns the stored plan when no trial', () => {
    expect(effectivePlan(base('STARTER'))).toBe('STARTER');
    expect(effectivePlan(base('PRO'))).toBe('PRO');
  });

  it('returns SCALE when trial is active', () => {
    expect(effectivePlan(base('STARTER', new Date(Date.now() + 86_400_000)))).toBe('SCALE');
  });

  it('returns the stored plan when trial has expired', () => {
    expect(effectivePlan(base('STARTER', new Date(Date.now() - 86_400_000)))).toBe('STARTER');
  });

  it('falls back to STARTER on an unrecognized plan string (never throws)', () => {
    expect(effectivePlan(base('starter'))).toBe('STARTER');
    expect(effectivePlan(base('GOLD'))).toBe('STARTER');
  });
});

describe('orgFeatures — plan tiers', () => {
  it('STARTER includes core, excludes leads/phone/inventory', () => {
    const f = orgFeatures(base('STARTER'));
    expect(f).toContain('customers');
    expect(f).toContain('jobs');
    expect(f).toContain('estimates');
    expect(f).not.toContain('leads');
    expect(f).not.toContain('phone');
    expect(f).not.toContain('inventory');
  });

  it('PRO includes leads/phone/service_plans/automations, excludes inventory', () => {
    const f = orgFeatures(base('PRO'));
    expect(f).toContain('leads');
    expect(f).toContain('phone');
    expect(f).toContain('service_plans');
    expect(f).toContain('automations');
    expect(f).not.toContain('inventory');
  });

  it('SCALE includes inventory', () => {
    expect(orgFeatures(base('SCALE'))).toContain('inventory');
  });

  it('ENTERPRISE includes every built feature and no unbuilt one', () => {
    const f = orgFeatures(base('ENTERPRISE'));
    expect(f).toContain('multi_location');
    expect(f).not.toContain('sso');
    expect(f).not.toContain('quickbooks');
  });

  it('never throws on an unrecognized plan — degrades to STARTER features', () => {
    expect(() => orgFeatures(base('GOLD'))).not.toThrow();
    expect(orgFeatures(base('GOLD'))).toContain('customers');
    expect(orgFeatures(base('GOLD'))).not.toContain('inventory');
  });
});

describe('orgFeatures — overrides', () => {
  it('true adds a feature below plan tier', () => {
    expect(orgFeatures(base('STARTER', null, { phone: true }))).toContain('phone');
  });

  it('false removes a feature above plan tier', () => {
    expect(orgFeatures(base('SCALE', null, { inventory: false }))).not.toContain('inventory');
  });

  it('preserves the deploy-day contract: SCALE + {phone:false} has no phone', () => {
    const f = orgFeatures(base('SCALE', null, { phone: false }));
    expect(f).not.toContain('phone');
    expect(f).toContain('inventory'); // everything else intact
  });

  it('IGNORES an unknown key — a typo must not enter the feature list', () => {
    const f = orgFeatures(base('STARTER', null, { phonee: true }));
    expect(f).not.toContain('phonee');
    expect(f).not.toContain('phone');
  });

  it('IGNORES a built:false key even when explicitly enabled', () => {
    expect(orgFeatures(base('ENTERPRISE', null, { quickbooks: true }))).not.toContain('quickbooks');
  });

  it('IGNORES non-boolean values (JSONB can hold anything)', () => {
    expect(orgFeatures(base('STARTER', null, { phone: 'true' }))).not.toContain('phone');
    expect(orgFeatures(base('STARTER', null, { phone: 1 }))).not.toContain('phone');
  });

  it('tolerates null / undefined feature_overrides (JSONB null is reachable)', () => {
    expect(() => orgFeatures(base('PRO', null, null as never))).not.toThrow();
    expect(orgFeatures(base('PRO', null, null as never))).toContain('leads');
  });
});

describe('hasFeature / isKnownFeature', () => {
  it('hasFeature reflects the resolved list', () => {
    expect(hasFeature(base('PRO'), 'leads')).toBe(true);
    expect(hasFeature(base('STARTER'), 'leads')).toBe(false);
  });

  it('isKnownFeature gates operator input', () => {
    expect(isKnownFeature('phone')).toBe(true);
    expect(isKnownFeature('phonee')).toBe(false);
    expect(isKnownFeature('quickbooks')).toBe(true); // in catalog, but built:false
  });
});
