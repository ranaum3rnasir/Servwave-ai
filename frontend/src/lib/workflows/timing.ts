/**
 * timing.ts — the tiny offset math shared by the WAIT step form and the timed
 * TRIGGER form: unit→minutes conversion and the reverse split used to seed the
 * "value × unit" custom editor from a stored `duration_minutes`/`offset_minutes`.
 * Mirrors the legacy AutomationEditorPage helpers so behaviour is identical.
 */

export type OffsetUnit = 'minutes' | 'hours' | 'days';

export const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

/** Largest whole unit a minute total divides into cleanly (day → hour → minute). */
export function splitOffset(totalMinutes: number): { value: number; unit: OffsetUnit } {
  if (totalMinutes > 0 && totalMinutes % (24 * 60) === 0) return { value: totalMinutes / (24 * 60), unit: 'days' };
  if (totalMinutes > 0 && totalMinutes % 60 === 0) return { value: totalMinutes / 60, unit: 'hours' };
  return { value: totalMinutes, unit: 'minutes' };
}
