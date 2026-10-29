import { describe, it, expect } from 'vitest';
import { orgFeatures } from '../lib/entitlements/resolve';
import { TEST_ORG } from './helpers';

// Guard: the shared test org must resolve to a full feature set, otherwise every
// gated-route test 402s. If this goes red, mockAuthAs stopped attaching the
// organization relation.
describe('test fixture entitlements', () => {
  it('TEST_ORG resolves to SCALE with the gated modules enabled', () => {
    const f = orgFeatures({
      plan: TEST_ORG.plan,
      trial_ends_at: TEST_ORG.trial_ends_at,
      feature_overrides: TEST_ORG.feature_overrides,
    });
    expect(f).toEqual(expect.arrayContaining([
      'leads', 'inventory', 'service_plans', 'automations', 'phone',
    ]));
  });
});
