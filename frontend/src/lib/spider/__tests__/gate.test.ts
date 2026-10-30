import { describe, it, expect } from 'vitest';
import { spiderAvailableFor } from '../gate';

// SPEC-5: Spider is for demo companies plus the companies on the server's Spider pilot list. The
// browser learns "on the list" from the server (org_is_spider_pilot) and keeps no list of its own.
describe('spiderAvailableFor', () => {
  it('opens for a pilot company with the feature', () => {
    expect(spiderAvailableFor({ org_features: ['spider'], org_is_demo: false, org_is_spider_pilot: true })).toBe(true);
  });

  it('stays shut for a pilot company without the feature', () => {
    expect(spiderAvailableFor({ org_features: ['leads'], org_is_demo: false, org_is_spider_pilot: true })).toBe(false);
  });

  it('stays shut for a non-demo company that is not on the list', () => {
    expect(spiderAvailableFor({ org_features: ['spider'], org_is_demo: false, org_is_spider_pilot: false })).toBe(false);
  });

  it('stays shut for a session cached before the pilot flag existed', () => {
    expect(spiderAvailableFor({ org_features: ['spider'], org_is_demo: false })).toBe(false);
  });

  it('opens for a demo company with the feature (unchanged)', () => {
    expect(spiderAvailableFor({ org_features: ['spider'], org_is_demo: true })).toBe(true);
  });

  it('stays shut when nobody is signed in', () => {
    expect(spiderAvailableFor(null)).toBe(false);
  });
});
