import { describe, it, expect } from 'vitest';
import { resolve } from '../enforcement';
import type { Zone, GeofenceVerdict } from '../types';

const ZONE: Zone = { id: 'z1', kind: 'STORE', label: 'Main', lat: 40, lng: -74 };

const IN_ZONE: GeofenceVerdict = { inZone: true, matched: ZONE, nearest: ZONE, distanceM: 5 };
const OUT_OF_ZONE: GeofenceVerdict = { inZone: false, matched: null, nearest: ZONE, distanceM: 500 };
const NO_VERDICT: GeofenceVerdict = { inZone: false, matched: null, nearest: null, distanceM: Infinity };

describe('resolve', () => {
  it('OUT is always ALLOW even when out of zone, enforced, and non-admin', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: true, type: 'OUT' }, [ZONE], OUT_OF_ZONE),
    ).toBe('ALLOW');
  });

  it('admin clocking IN out of zone ⇒ ALLOW (admin bypass)', () => {
    expect(
      resolve({ isAdmin: true, enforceLocation: true, type: 'IN' }, [ZONE], OUT_OF_ZONE),
    ).toBe('ALLOW');
  });

  it('enforcement off, IN out of zone ⇒ ALLOW', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: false, type: 'IN' }, [ZONE], OUT_OF_ZONE),
    ).toBe('ALLOW');
  });

  it('no applicable zones ⇒ ALLOW (never brick a crew with no configured zone)', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: true, type: 'IN' }, [], NO_VERDICT),
    ).toBe('ALLOW');
  });

  it('enforced, in zone, IN ⇒ ALLOW', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: true, type: 'IN' }, [ZONE], IN_ZONE),
    ).toBe('ALLOW');
  });

  it('enforced, out of zone, IN, non-admin ⇒ BLOCK_OVERRIDE_ELIGIBLE', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: true, type: 'IN' }, [ZONE], OUT_OF_ZONE),
    ).toBe('BLOCK_OVERRIDE_ELIGIBLE');
  });

  it('OUT short-circuits before the admin check (OUT wins even for non-admin enforced out-of-zone)', () => {
    expect(
      resolve({ isAdmin: false, enforceLocation: true, type: 'OUT' }, [ZONE], OUT_OF_ZONE),
    ).toBe('ALLOW');
  });

  it('admin check precedes enforceLocation: admin + enforce on + out of zone ⇒ ALLOW', () => {
    expect(
      resolve({ isAdmin: true, enforceLocation: true, type: 'IN' }, [ZONE], OUT_OF_ZONE),
    ).toBe('ALLOW');
  });
});
