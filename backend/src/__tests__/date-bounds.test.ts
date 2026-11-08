/**
 * date-bounds.test.ts — the inclusive upper date bound.
 *
 * A date-only `to` names a whole DAY, so it must include that day. z.coerce.date()
 * mapped it to 00:00:00.000Z, which silently excluded everything that happened on
 * the named day — hiding the entire current day from every report in the app.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { inclusiveEndOfDay } from '../lib/dateBounds';

const schema = z.object({ to: inclusiveEndOfDay });

describe('inclusiveEndOfDay', () => {
  it('maps a date-only string to the LAST millisecond of that day', () => {
    const parsed = schema.parse({ to: '2026-07-21' });
    expect(parsed.to?.toISOString()).toBe('2026-07-21T23:59:59.999Z');
  });

  it('passes an explicit timestamp through untouched', () => {
    const parsed = schema.parse({ to: '2026-07-21T14:30:00.000Z' });
    expect(parsed.to?.toISOString()).toBe('2026-07-21T14:30:00.000Z');
  });

  it('leaves an absent bound undefined', () => {
    expect(schema.parse({}).to).toBeUndefined();
  });

  it('rejects an unparseable string', () => {
    expect(schema.safeParse({ to: 'not-a-date' }).success).toBe(false);
  });

  it('includes a movement that occurred during the named day', () => {
    // The exact QA failure: an LO consume at 03:36Z on the 21st, `to=2026-07-21`.
    const to = schema.parse({ to: '2026-07-21' }).to!;
    expect(new Date('2026-07-21T03:36:15.065Z') <= to).toBe(true);
  });

  it('rejects a structurally-valid but impossible date-only string (month 13, day 45)', () => {
    // DATE_ONLY only checks digit shape, so this matches the date-only branch and
    // used to reach `new Date('2026-13-45T23:59:59.999Z')` with no NaN check —
    // Invalid Date, no validation error, 500 downstream at Prisma.
    expect(schema.safeParse({ to: '2026-13-45' }).success).toBe(false);
  });

  it('rejects a calendar-invalid date-only string that JS would roll over (Feb 31)', () => {
    // `new Date('2026-02-31...')` doesn't NaN — it rolls over to March 3. Reject it
    // rather than silently resolving to the wrong day.
    expect(schema.safeParse({ to: '2026-02-31' }).success).toBe(false);
  });

  it('still accepts a genuinely valid date-only string', () => {
    const parsed = schema.parse({ to: '2026-07-21' });
    expect(parsed.to?.toISOString()).toBe('2026-07-21T23:59:59.999Z');
  });

  it('still accepts a leap-day date-only string', () => {
    const parsed = schema.parse({ to: '2028-02-29' });
    expect(parsed.to?.toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });
});
