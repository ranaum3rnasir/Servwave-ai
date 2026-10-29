/**
 * geofence.ts — pure haversine distance + zone evaluation.
 *
 * The haversine math is ported VERBATIM from the frontend
 * (`frontend/src/lib/timeclock/geofence.ts`) so the client and server agree on
 * distances to the millimeter. `evaluate` mirrors the frontend `evaluateLocation`
 * semantics exactly (UPPERCASE backend types).
 */
import type { LatLng, Zone, GeofenceVerdict } from './types';

const EARTH_R = 6371000; // meters
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Find the nearest zone and decide whether `pos` falls inside the geofence.
 *
 * - `nearest`   = closest zone by haversine distance (null if `zones` is empty,
 *                 or if every distance is NaN and never beats the Infinity seed).
 * - `distanceM` = distance to `nearest` (Infinity when no zone wins the seed).
 * - `matched`   = `nearest` IF its distance <= radiusM, else null.
 * - `inZone`    = matched !== null.
 *
 * NaN coordinates never satisfy `d < best`, so they yield no nearest, no match,
 * and `inZone: false` — the function never throws.
 */
export function evaluate(pos: LatLng, zones: Zone[], radiusM: number): GeofenceVerdict {
  let nearest: Zone | null = null;
  let best = Infinity;
  for (const zone of zones) {
    const d = haversineMeters(pos, zone);
    if (d < best) {
      best = d;
      nearest = zone;
    }
  }
  const inZone = nearest !== null && best <= radiusM;
  return { inZone, matched: inZone ? nearest : null, nearest, distanceM: best };
}
