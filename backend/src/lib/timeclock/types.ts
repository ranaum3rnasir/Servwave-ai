/**
 * Canonical backend types for the timeclock feature.
 *
 * Shared by the three pure modules (geofence / enforcement / aggregate) and,
 * later, the controller. These mirror the frontend timeclock types but use the
 * backend's UPPERCASE enum convention (`'STORE'`/`'JOB'`, `'IN_ZONE'`/`'OVERRIDE'`).
 * Pure value types only — no prisma/express imports.
 */

export type PunchType = 'IN' | 'OUT';
export type ZoneKind = 'STORE' | 'JOB';
export type PunchStatus = 'IN_ZONE' | 'OVERRIDE';
export type PunchReview = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Zone extends LatLng {
  id: string;
  kind: ZoneKind;
  label: string;
  jobNumber?: string | null;
}

export interface GeofenceVerdict {
  inZone: boolean;
  matched: Zone | null;
  nearest: Zone | null;
  distanceM: number;
}

/** Minimal shape the aggregator needs from a punch. `ts` = epoch ms. */
export interface PunchLike {
  userId: string;
  type: PunchType;
  ts: number;
}
