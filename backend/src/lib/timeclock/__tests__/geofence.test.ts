import { describe, it, expect } from 'vitest';
import { haversineMeters, evaluate } from '../geofence';
import type { Zone } from '../types';

const STORE: Zone = { id: 'z1', kind: 'STORE', label: 'Main office', lat: 40.0, lng: -74.0 };

function zone(over: Partial<Zone> & Pick<Zone, 'id' | 'lat' | 'lng'>): Zone {
  return { kind: 'STORE', label: over.id, ...over };
}

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters({ lat: 40, lng: -74 }, { lat: 40, lng: -74 })).toBe(0);
  });

  it('matches a known one-degree-of-latitude distance (~111.2 km)', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    // 1° latitude ≈ 111,195 m on a 6,371,000 m sphere.
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
  });

  it('is symmetric', () => {
    const a = { lat: 40.7, lng: -74.0 };
    const b = { lat: 40.71, lng: -74.01 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('evaluate', () => {
  it('reports in-zone when within the radius', () => {
    // A point a few meters north of the store.
    const pos = { lat: 40.00002, lng: -74.0 };
    const v = evaluate(pos, [STORE], 50);
    expect(v.inZone).toBe(true);
    expect(v.matched).toBe(STORE);
    expect(v.nearest).toBe(STORE);
    expect(v.distanceM).toBeLessThanOrEqual(50);
  });

  it('treats a point exactly on the radius boundary as in-zone (<= inclusive)', () => {
    // Distance from the store to itself is 0; radius 0 means the boundary is the point itself.
    const v = evaluate({ lat: STORE.lat, lng: STORE.lng }, [STORE], 0);
    expect(v.distanceM).toBe(0);
    expect(v.inZone).toBe(true);
    expect(v.matched).toBe(STORE);
  });

  it('reports out-of-zone when beyond the radius', () => {
    const pos = { lat: 40.01, lng: -74.0 }; // ~1.1 km away
    const v = evaluate(pos, [STORE], 50);
    expect(v.inZone).toBe(false);
    expect(v.matched).toBeNull();
    expect(v.nearest).toBe(STORE); // nearest is still reported
    expect(v.distanceM).toBeGreaterThan(50);
  });

  it('returns the closest of many zones as nearest', () => {
    const near = zone({ id: 'near', lat: 40.00001, lng: -74.0 });
    const far = zone({ id: 'far', lat: 41.0, lng: -75.0 });
    const farther = zone({ id: 'farther', lat: 42.0, lng: -76.0 });
    const v = evaluate({ lat: 40.0, lng: -74.0 }, [far, farther, near], 1000);
    expect(v.nearest).toBe(near);
    expect(v.matched).toBe(near);
    expect(v.inZone).toBe(true);
  });

  it('matches only the nearest zone even when several are within radius', () => {
    const closer = zone({ id: 'closer', lat: 40.00001, lng: -74.0 });
    const alsoClose = zone({ id: 'also', lat: 40.0001, lng: -74.0 });
    const v = evaluate({ lat: 40.0, lng: -74.0 }, [alsoClose, closer], 1000);
    expect(v.nearest).toBe(closer);
    expect(v.matched).toBe(closer);
  });

  it('handles empty zones: not in zone, Infinity distance, null matched/nearest', () => {
    const v = evaluate({ lat: 40, lng: -74 }, [], 100);
    expect(v.inZone).toBe(false);
    expect(v.matched).toBeNull();
    expect(v.nearest).toBeNull();
    expect(v.distanceM).toBe(Infinity);
  });

  it('does not throw on NaN/garbage coordinates and is not in zone', () => {
    const pos = { lat: NaN, lng: NaN };
    let v: ReturnType<typeof evaluate> | undefined;
    expect(() => {
      v = evaluate(pos, [STORE], 50);
    }).not.toThrow();
    expect(v!.inZone).toBe(false);
    expect(v!.matched).toBeNull();
    // NaN distance never beats the Infinity seed (NaN < Infinity === false),
    // so nearest stays null and distance stays Infinity — verbatim frontend semantics.
    expect(v!.nearest).toBeNull();
    expect(v!.distanceM).toBe(Infinity);
  });
});
