import { describe, it, expect } from 'vitest';
import { completeJobSchema } from '../controllers/job.controller';
import {
  createPunchSchema,
  createStoreSchema,
  updateStoreSchema,
} from '../controllers/timeclock.controller';

// F-48 — completeJobSchema.signature_data must be length-capped for parity with the
// estimate approve signature (estimate.controller.ts caps at 500_000). Bounds the
// storage / PDF-render amplification a 5MB JSON body would otherwise allow.
describe('F-48 completeJobSchema.signature_data length cap', () => {
  const base = { completion_notes: 'done' };

  it('rejects a signature_data string over 500KB', () => {
    const big = 'a'.repeat(500001);
    expect(completeJobSchema.safeParse({ ...base, signature_data: big }).success).toBe(false);
  });

  it('accepts a signature_data string at/under 500KB', () => {
    const ok = 'a'.repeat(500000);
    expect(completeJobSchema.safeParse({ ...base, signature_data: ok }).success).toBe(true);
  });
});

// F-49 — timeclock coordinate fields must be bounded to valid WGS84 ranges. Defense in
// depth: the geofence already fails closed on bad coords, but unbounded numbers should
// never reach it.
describe('F-49 timeclock coordinate range bounds', () => {
  it('createPunchSchema rejects out-of-range lat/lng', () => {
    expect(createPunchSchema.safeParse({ type: 'IN', lat: 9999, lng: 0 }).success).toBe(false);
    expect(createPunchSchema.safeParse({ type: 'IN', lat: 0, lng: 9999 }).success).toBe(false);
  });

  it('createPunchSchema rejects negative accuracy_m', () => {
    expect(
      createPunchSchema.safeParse({ type: 'IN', lat: 30, lng: -97, accuracy_m: -1 }).success,
    ).toBe(false);
  });

  it('createPunchSchema accepts an in-range punch', () => {
    expect(
      createPunchSchema.safeParse({ type: 'IN', lat: 30.2672, lng: -97.7431, accuracy_m: 12 })
        .success,
    ).toBe(true);
  });

  it('createStoreSchema rejects out-of-range coordinates', () => {
    expect(createStoreSchema.safeParse({ label: 'HQ', lat: 200, lng: 0 }).success).toBe(false);
  });

  it('createStoreSchema accepts valid coordinates', () => {
    expect(
      createStoreSchema.safeParse({ label: 'HQ', lat: 30.2672, lng: -97.7431 }).success,
    ).toBe(true);
  });

  it('updateStoreSchema rejects out-of-range coordinates when present', () => {
    expect(updateStoreSchema.safeParse({ lat: -91 }).success).toBe(false);
    expect(updateStoreSchema.safeParse({ lng: 181 }).success).toBe(false);
  });
});
