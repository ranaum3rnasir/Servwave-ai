import { describe, it, expect } from 'vitest';
import { DEFAULT_GEOFENCE_CONFIG, migratePersistedTimeclock } from './geofenceConfig';

describe('DEFAULT_GEOFENCE_CONFIG', () => {
  it('has exactly one default store and a 150 m radius', () => {
    expect(DEFAULT_GEOFENCE_CONFIG.stores).toHaveLength(1);
    expect(DEFAULT_GEOFENCE_CONFIG.radiusM).toBe(150);
    // MAIN_OFFICE is intentionally seeded with a real street address (see geofenceConfig.ts)
    // so the geofence list reads as a street, not raw coords.
    expect(DEFAULT_GEOFENCE_CONFIG.stores[0]).toMatchObject({
      label: 'Main office',
      address: '350 5th Ave, New York, NY 10118',
    });
  });
});

describe('migratePersistedTimeclock', () => {
  it('converts an old single-store config into a stores array', () => {
    const old = { config: { store: { lat: 1, lng: 2, label: 'HQ' }, radiusM: 200 }, punches: [] };
    const next = migratePersistedTimeclock(old, 1);
    expect(next.config.stores).toEqual([
      { id: 'store-1', label: 'HQ', address: '', lat: 1, lng: 2 },
    ]);
    expect(next.config.radiusM).toBe(200);
    expect('store' in next.config).toBe(false);
  });

  it('leaves an already-migrated stores config untouched', () => {
    const cur = { config: { stores: [{ id: 'a', label: 'A', address: '', lat: 1, lng: 2 }], radiusM: 150 }, punches: [] };
    const next = migratePersistedTimeclock(cur, 2);
    expect(next.config.stores).toHaveLength(1);
    expect(next.config.stores[0]?.id).toBe('a');
  });

  it('falls back to defaults when config is missing', () => {
    const next = migratePersistedTimeclock({ punches: [] }, 1);
    expect(next.config.stores).toHaveLength(1);
    expect(next.config.radiusM).toBe(150);
  });
});
