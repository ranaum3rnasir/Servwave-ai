/**
 * enforcement.ts — pure geofence-enforcement decision.
 *
 * Decides whether a punch is allowed outright or blocked-but-override-eligible.
 * The order of the guards matters and is fail-open by design (we never want to
 * brick a crew): OUT is never blocked, admins bypass, enforcement can be off,
 * and a user with no applicable zones is always allowed.
 */
import type { PunchType, Zone, GeofenceVerdict } from './types';

export type EnforcementDecision = 'ALLOW' | 'BLOCK_OVERRIDE_ELIGIBLE';

export function resolve(
  actor: { isAdmin: boolean; enforceLocation: boolean; type: PunchType },
  applicableZones: Zone[],
  verdict: GeofenceVerdict,
): EnforcementDecision {
  // OUT is never blocked — you can always clock out.
  if (actor.type === 'OUT') return 'ALLOW';
  // Admins bypass geofencing entirely.
  if (actor.isAdmin) return 'ALLOW';
  // Enforcement disabled for this user.
  if (!actor.enforceLocation) return 'ALLOW';
  // No-zone guardrail: never brick a crew that has no configured zone.
  if (applicableZones.length === 0) return 'ALLOW';
  // Inside a zone ⇒ allow; otherwise blocked but eligible for an override.
  return verdict.inZone ? 'ALLOW' : 'BLOCK_OVERRIDE_ELIGIBLE';
}
