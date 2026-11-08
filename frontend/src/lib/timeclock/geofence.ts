import type { LatLng, Zone } from './types';

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

export type LocationVerdict = {
  inZone: boolean;
  matched: Zone | null;
  nearest: Zone | null;
  distanceM: number;
};

export function evaluateLocation(pos: LatLng, zones: Zone[], radiusM: number): LocationVerdict {
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
