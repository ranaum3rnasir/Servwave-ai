import type { GeofenceConfig, StoreLocation } from './types';

/** Default "Main office" — seeded with a real address so the list reads as a street, not coords. */
const MAIN_OFFICE: StoreLocation = {
  id: 'store-1',
  label: 'Main office',
  address: '350 5th Ave, New York, NY 10118',
  lat: 40.7484,
  lng: -73.9857,
};

export const DEFAULT_GEOFENCE_CONFIG: GeofenceConfig = {
  stores: [MAIN_OFFICE],
  radiusM: 150,
};

/**
 * persist() migrate:
 *  - v0/v1: convert old `{ config: { store, radiusM } }` to `{ config: { stores[], radiusM } }`.
 *  - v2→v3: backfill an empty store address (lone default "Main office") with the seed address.
 */
export function migratePersistedTimeclock(persisted: unknown, _version: number): { config: GeofenceConfig; [k: string]: unknown } {
  const state = (persisted ?? {}) as { config?: unknown; [k: string]: unknown };
  const config = state.config as
    | { store?: { lat: number; lng: number; label?: string }; stores?: StoreLocation[]; radiusM?: number }
    | undefined;

  if (!config) {
    return { ...state, config: DEFAULT_GEOFENCE_CONFIG };
  }
  if (Array.isArray(config.stores)) {
    return { ...state, config: { ...config, stores: backfillAddresses(config.stores) } as GeofenceConfig };
  }
  if (config.store) {
    const { store, radiusM } = config;
    return {
      ...state,
      config: {
        // Preserve the user's real coords from the old single-store config.
        // Do NOT backfillAddresses here — that is only for the lone seeded
        // default (the stores-array branch); keying on id 'store-1' + empty
        // address would otherwise clobber a real store's lat/lng with the default.
        stores: [
          { id: 'store-1', label: store.label ?? 'Main office', address: '', lat: store.lat, lng: store.lng },
        ],
        radiusM: radiusM ?? 150,
      },
    };
  }
  return { ...state, config: DEFAULT_GEOFENCE_CONFIG };
}

/** Give the lone default "Main office" a real address if it was persisted without one. */
function backfillAddresses(stores: StoreLocation[]): StoreLocation[] {
  return stores.map((s) =>
    s.id === 'store-1' && (!s.address || s.address.trim() === '')
      ? { ...s, address: MAIN_OFFICE.address, lat: MAIN_OFFICE.lat, lng: MAIN_OFFICE.lng }
      : s,
  );
}
