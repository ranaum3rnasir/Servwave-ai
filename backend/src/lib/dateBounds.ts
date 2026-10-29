import { z } from 'zod';

/**
 * Inclusive UPPER date bound for report / ledger queries.
 *
 * A date-only string ("2026-07-21") names a whole day, so an upper bound of that
 * day must mean "through the END of it". `z.coerce.date()` maps it to
 * 00:00:00.000Z, which makes the bound exclusive of the very day it names —
 * every report preset sends a date-only `to` of TODAY, so that silently hid the
 * entire current day from every report in the app.
 *
 * An explicit timestamp passes through untouched: a caller who names an instant
 * means that instant.
 *
 * DELIBERATELY ASYMMETRIC — the LOWER bound keeps plain `z.coerce.date()`,
 * because a date-only `from` coercing to 00:00:00.000Z is already the correct
 * inclusive start of that day. Do not "fix" this into symmetry.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const inclusiveEndOfDay = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    if (value instanceof Date) return value;
    if (DATE_ONLY.test(value)) {
      const endOfDay = new Date(`${value}T23:59:59.999Z`);
      // DATE_ONLY only checks digit shape ("2026-13-45" matches), and JS silently
      // rolls a calendar-invalid day/month over into the next one ("2026-02-31" ->
      // March 3) instead of producing NaN. Round-trip through the ISO date to catch
      // both: an out-of-range component (NaN) and a rolled-over one (mismatch).
      if (Number.isNaN(endOfDay.getTime()) || endOfDay.toISOString().slice(0, 10) !== value) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
        return z.NEVER;
      }
      return endOfDay;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return parsed;
  })
  .optional();
