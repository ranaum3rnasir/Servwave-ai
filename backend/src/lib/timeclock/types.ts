/**
 * Canonical backend types for the timeclock feature.
 *
 * Pure value types only - no prisma/express imports. They use the backend's UPPERCASE enum convention.
 */

export type PunchType = 'IN' | 'OUT';

/** Minimal shape the aggregator needs from a punch. `ts` = epoch ms. */
export interface PunchLike {
  userId: string;
  type: PunchType;
  ts: number;
}
