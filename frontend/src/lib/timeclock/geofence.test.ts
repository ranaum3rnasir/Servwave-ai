import { describe, it, expect } from 'vitest';
import { haversineMeters, evaluateLocation } from './geofence';
import type { Zone } from './types';

const STORE: Zone = { id: 'store', kind: 'store', label: 'Main office', lat: 40, lng: -75 };

describe('haversineMeters', () => {
  it('is ~0 for identical points', () => {
    expect(haversineMeters({ lat: 40, lng: -75 }, { lat: 40, lng: -75 })).toBeCloseTo(0, 5);
  });
  it('matches a known distance (~111.2 km per degree of latitude)', () => {
    const d = haversineMeters({ lat: 40, lng: -75 }, { lat: 41, lng: -75 });
    expect(d).toBeGreaterThan(111000);
    expect(d).toBeLessThan(111400);
  });
});

describe('evaluateLocation', () => {
  it('is in zone at the center', () => {
    const v = evaluateLocation({ lat: 40, lng: -75 }, [STORE], 150);
    expect(v.inZone).toBe(true);
    expect(v.matched?.id).toBe('store');
    expect(v.distanceM).toBeCloseTo(0, 1);
  });
  it('is out of zone beyond the radius', () => {
    const v = evaluateLocation({ lat: 40.01, lng: -75 }, [STORE], 150);
    expect(v.inZone).toBe(false);
    expect(v.matched).toBeNull();
    expect(v.nearest?.id).toBe('store');
    expect(v.distanceM).toBeGreaterThan(1000);
  });
  it('picks the nearest of several zones and is in zone when close', () => {
    const job: Zone = { id: 'j1', kind: 'job', label: 'Job J1', lat: 40.02, lng: -75, jobNumber: 'J00001' };
    const v = evaluateLocation({ lat: 40.0199, lng: -75 }, [STORE, job], 150);
    expect(v.nearest?.id).toBe('j1');
    expect(v.inZone).toBe(true);
  });
  it('handles an empty zone list without crashing', () => {
    const v = evaluateLocation({ lat: 40, lng: -75 }, [], 150);
    expect(v.inZone).toBe(false);
    expect(v.nearest).toBeNull();
    expect(v.distanceM).toBe(Infinity);
  });
});
