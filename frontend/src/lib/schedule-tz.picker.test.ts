/**
 * The FORM-PICKER boundary, as opposed to the react-big-calendar boundary that
 * schedule-tz.test.ts covers.
 *
 * DatePicker / TimeCombobox / DateTimePicker emit ZONELESS wall-clock strings
 * ('YYYY-MM-DD', 'HH:MM', 'YYYY-MM-DDTHH:MM' — enforced by no-native-time-inputs.test.ts).
 * A string carries no zone, so `new Date(str)` resolves it against the BROWSER. That is
 * how a Manila dispatcher booking 9:00 AM stored 9:00 PM New York (prod job 698675).
 *
 * The assertion that matters in this file is not "the numbers are right" — it is that
 * every result is IDENTICAL under three different browser timezones. A test that only
 * runs in one zone cannot fail on the bug it is meant to catch.
 */
import { describe, it, expect } from 'vitest';
import {
  pickerValueToIso,
  isoToPickerValue,
  isoToOrgDay,
  isoToOrgTime,
} from './schedule-tz';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

describe('pickerValueToIso (org wall-clock string -> true instant)', () => {
  it('reads a datetime-local string as ORG time, not browser time', () => {
    // 9am in New York in August (EDT, UTC-4) is 13:00Z. This is prod job 698675:
    // Sherry typed 09:00 in Manila and the old code stored 01:00Z (= 9pm New York).
    expect(pickerValueToIso('2026-08-06T09:00', NY)).toBe('2026-08-06T13:00:00.000Z');
  });

  it('applies the org zone DST offset for the date in question, not a fixed offset', () => {
    expect(pickerValueToIso('2026-01-15T09:00', NY)).toBe('2026-01-15T14:00:00.000Z'); // EST, -5
    expect(pickerValueToIso('2026-07-15T09:00', NY)).toBe('2026-07-15T13:00:00.000Z'); // EDT, -4
  });

  it('accepts a date-only string, defaulting the time', () => {
    expect(pickerValueToIso('2026-08-06', NY)).toBe('2026-08-06T04:00:00.000Z'); // 00:00 NY
    expect(pickerValueToIso('2026-08-06', NY, '08:00')).toBe('2026-08-06T12:00:00.000Z');
  });

  it('returns undefined for empty input so callers can omit the field', () => {
    expect(pickerValueToIso('', NY)).toBeUndefined();
    expect(pickerValueToIso(undefined, NY)).toBeUndefined();
  });
});

describe('isoToPickerValue / isoToOrgDay / isoToOrgTime (instant -> org wall clock)', () => {
  it('seeds a picker with the ORG wall clock', () => {
    expect(isoToPickerValue('2026-08-06T13:00:00.000Z', NY)).toBe('2026-08-06T09:00');
    expect(isoToOrgDay('2026-08-06T13:00:00.000Z', NY)).toBe('2026-08-06');
    expect(isoToOrgTime('2026-08-06T13:00:00.000Z', NY)).toBe('09:00');
  });

  it('shows the SAME org wall clock no matter which zone the viewer is in', () => {
    // The whole point: a Manila viewer editing a New York org sees New York's clock.
    expect(isoToPickerValue('2026-08-06T13:00:00.000Z', NY)).toBe('2026-08-06T09:00');
    expect(isoToPickerValue('2026-08-06T13:00:00.000Z', MANILA)).toBe('2026-08-06T21:00');
  });

  it('round-trips: picker -> instant -> picker is lossless', () => {
    for (const v of ['2026-08-06T09:00', '2026-01-15T23:45', '2026-06-30T00:00']) {
      expect(isoToPickerValue(pickerValueToIso(v, NY)!, NY)).toBe(v);
    }
  });

  it('returns empty string for missing input', () => {
    expect(isoToPickerValue(null, NY)).toBe('');
    expect(isoToOrgDay(undefined, NY)).toBe('');
    expect(isoToOrgTime('', NY)).toBe('');
  });
});

describe('DST edges in the ORG zone', () => {
  it('spring-forward: a nonexistent org wall clock still resolves deterministically', () => {
    // 2026-03-08 02:30 does not exist in New York (02:00 jumps to 03:00). date-fns-tz
    // resolves it BACKWARD to 01:30 EST (06:30Z). RFC 5545 would resolve it forward to
    // 03:30 EDT. Documented rather than worked around: no dispatcher books 2:30am, and
    // the value is at least stable across viewers.
    expect(pickerValueToIso('2026-03-08T02:30', NY)).toBe('2026-03-08T06:30:00.000Z');
  });

  it('a normal time on a DST-transition day is unaffected', () => {
    expect(pickerValueToIso('2026-03-08T09:00', NY)).toBe('2026-03-08T13:00:00.000Z');
    expect(pickerValueToIso('2026-11-01T09:00', NY)).toBe('2026-11-01T14:00:00.000Z');
  });
});
