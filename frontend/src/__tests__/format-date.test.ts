import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { formatExactDay, formatExactInstant } from '../lib/format-date';
import { setOrgFormattingPrefs } from '../lib/org-format';

/**
 * Two renderers, because the app stores two kinds of date that are
 * indistinguishable in TypeScript - both arrive as ISO strings.
 *
 *   formatExactDay     date-only calendar day (due_date, expectedDate), read in UTC
 *   formatExactInstant timestamp column (paid_at, created_at), read in local time
 *
 * Reading either one with the other's renderer shifts the calendar day. The old
 * single `formatExactDate` was UTC-only and every one of its 13 call sites passed
 * an instant, so it was wrong at all of them; the ambiguous name was the defect.
 */

// 01:00Z on Aug 5 is 21:00 on Aug 4 in New York - the whole bug in one value.
// As an instant it is Aug 4; read in UTC it claims to be Aug 5.
const EVENING_INSTANT = '2026-08-05T01:00:00.000Z';

describe('formatExactDay (date-only, UTC)', () => {
  afterEach(() => {
    // Reset to the unset default so cases don't leak into each other.
    setOrgFormattingPrefs({ currency: null, dateFormat: null });
  });

  it('formats a Date object correctly', () => {
    expect(formatExactDay(new Date('2026-05-14'))).toBe('May 14, 2026');
  });

  it('formats January correctly', () => {
    expect(formatExactDay(new Date('2026-01-01'))).toBe('January 1, 2026');
  });

  it('returns empty string for null', () => {
    expect(formatExactDay(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatExactDay(undefined)).toBe('');
  });

  it('accepts a string date input', () => {
    expect(formatExactDay('2026-05-14')).toBe('May 14, 2026');
  });

  // #126 - org-aware date formatting.
  it('honors an org MM/DD/YYYY date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'MM/DD/YYYY' });
    expect(formatExactDay('2026-05-14')).toBe('05/14/2026');
  });

  it('honors an org DD/MM/YYYY date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'DD/MM/YYYY' });
    expect(formatExactDay('2026-05-14')).toBe('14/05/2026');
  });

  it('honors an org YYYY-MM-DD date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'YYYY-MM-DD' });
    expect(formatExactDay('2026-05-14')).toBe('2026-05-14');
  });

  it('falls back to long-form for an unknown/long pattern', () => {
    setOrgFormattingPrefs({ dateFormat: 'MMMM D, YYYY' });
    expect(formatExactDay('2026-05-14')).toBe('May 14, 2026');
  });

  // Date-only sites that want a compact rendering need the same UTC pinning the
  // default path has, or they drift a day.
  it('forces UTC even when a caller passes its own options', () => {
    expect(formatExactDay('2026-08-05', { month: 'short', day: 'numeric' })).toBe('Aug 5');
  });
});

/**
 * The timezone is pinned rather than inherited: under an ambient TZ of UTC
 * (what CI runs) both renderers agree on every assertion below and the guard
 * would be vacuous.
 */
describe('formatExactInstant (timestamp, local)', () => {
  // vi.stubEnv, not a manual save/restore: TZ is normally unset, and assigning the
  // saved `undefined` back writes the STRING "undefined", which Node reads as an
  // invalid zone and silently falls back to UTC - poisoning the ambient timezone for
  // every later test file in the same worker. unstubAllEnvs deletes the key properly.
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/New_York');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    setOrgFormattingPrefs({ currency: null, dateFormat: null });
  });

  it('renders the local calendar day, not the UTC one', () => {
    expect(formatExactInstant(EVENING_INSTANT)).toBe('August 4, 2026');
  });

  it('disagrees with formatExactDay on exactly this value', () => {
    // Kept as a pair so the distinction stays visible if either side is edited.
    expect(formatExactDay(EVENING_INSTANT)).toBe('August 5, 2026');
  });

  it('passes a caller options bag through in local time', () => {
    expect(formatExactInstant(EVENING_INSTANT, { month: 'short', day: 'numeric' })).toBe('Aug 4');
  });

  it('honors the org numeric date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'MM/DD/YYYY' });
    expect(formatExactInstant(EVENING_INSTANT)).toBe('08/04/2026');
  });

  it('accepts a Date object', () => {
    expect(formatExactInstant(new Date(EVENING_INSTANT))).toBe('August 4, 2026');
  });

  it('returns empty string for null, undefined and an unparseable value', () => {
    expect(formatExactInstant(null)).toBe('');
    expect(formatExactInstant(undefined)).toBe('');
    expect(formatExactInstant('not a date')).toBe('');
  });
});
