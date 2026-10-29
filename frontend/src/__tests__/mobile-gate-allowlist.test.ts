/**
 * Mobile slice 75: the mobile gate's allow-list holds ONLY documented exceptions.
 *
 * `e2e/mobile/allowlist.json` started (slice 1) as a list of every route/check pair that offended
 * on staging, so each slice could switch its own pairs to "enforce" as it fixed them. Slice 75
 * closes that: a pair that measures clean is deleted from the list (the gate enforces every pair
 * that is not listed), and a pair that is still allowed to offend stays in report mode ONLY with
 * the slice that owns the fix and the reason it is not fixed yet. This test holds the file to that:
 *   - every `report` entry names its owner (`slice`) and says why it is still allowed (`reason`);
 *   - an entry never carries a mode other than `report` or `enforce`;
 *   - a device or rule is never listed twice in one entry;
 *   - a check that the gate only reports, never fails (REPORT_ONLY in checks.ts), is listed under
 *     `reportOnlyChecks` with its owner and reason, so a whole check cannot go quiet unrecorded.
 * A future `npm run test:mobile:allowlist` that records a new offender writes an entry with no
 * reason, so this test fails until a person documents it or fixes the page.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALWAYS_ENFORCED, REPORT_ONLY } from '../../e2e/mobile/checks';

interface Entry {
  mode?: string;
  devices?: string[];
  rules?: string[];
  slice?: string;
  reason?: string;
}

interface ReportOnly {
  slice?: string;
  reason?: string;
}

const file = join(__dirname, '..', '..', 'e2e', 'mobile', 'allowlist.json');
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const entries = (parsed.entries ?? {}) as Record<string, Record<string, Entry>>;
const reportOnlyChecks = (parsed.reportOnlyChecks ?? {}) as Record<string, ReportOnly>;
const pairs = Object.entries(entries).flatMap(([state, checks]) =>
  Object.entries(checks).map(([check, entry]) => ({ id: `${state}/${check}`, entry })),
);

describe('mobile gate allow-list (slice 75)', () => {
  it('every report-mode entry names the slice that owns the fix and the reason it is still allowed', () => {
    const undocumented = pairs
      .filter(({ entry }) => entry.mode === 'report')
      .filter(({ entry }) => !/^(\d{1,2}|unowned)$/.test(entry.slice ?? '') || (entry.reason ?? '').trim().length < 20)
      .map(({ id }) => id);
    expect(undocumented, `Document these (a slice number or "unowned", and a reason of at least 20 characters), fix them, or delete them:\n${undocumented.join('\n')}`).toEqual([]);
  });

  // A reason copied from one entry onto another is how a contrast note ended up on pages whose axe
  // finding was a missing label. An accessibility exception must name each rule it excuses.
  it('an accessibility exception names every rule it excuses in its reason', () => {
    const vague = pairs
      .filter(({ id, entry }) => id.endsWith('/a11y') && entry.mode === 'report')
      .filter(({ entry }) => !(entry.rules ?? []).length || (entry.rules ?? []).some((rule) => !(entry.reason ?? '').includes(rule)))
      .map(({ id }) => id);
    expect(vague, `List the axe rule ids in "rules" and name each one in the reason:\n${vague.join('\n')}`).toEqual([]);
  });

  // Ran's ruling of 2026-10-08: double-booked cards stay side by side (Option A). Until the follow-up to
  // slice 75 the three Schedule pairs it excuses sat in report mode, which switched the whole check off for
  // the whole Schedule route (any new small control, any other unreachable element, would have passed). They
  // are enforced now: the Schedule has NO entry, and the ruling is an accepted exception that the gate applies
  // only to a calendar event card overlapping another card in time (e2e/mobile/schedule-double-booked.ts;
  // classifier tests: mobile-gate-schedule-double-booked.test.ts).
  it("the Schedule is enforced: no entry, and Ran's 2026-10-08 ruling is an accepted exception with an owner", () => {
    expect(entries.schedule, 'every Schedule route/check pair is enforced; only double-booked cards are excused, by acceptedExceptions').toBeUndefined();
    const accepted = (parsed.acceptedExceptions ?? {}) as Record<string, { owner?: string; reason?: string }>;
    expect(accepted.scheduleDoubleBooked?.owner).toBe('Ran');
    expect(accepted.scheduleDoubleBooked?.reason).toBe(
      'Ran decision 2026-10-08, Option A: double-booked jobs stay side by side; with four or more at the same time the cards are narrower than the 24 px touch-target floor and can cover each other. Accepted exception. Everything else on Schedule is enforced.',
    );
  });

  it('no report-mode route/check pair remains in the local gate (slice 75)', () => {
    expect(pairs.filter(({ entry }) => entry.mode === 'report').map(({ id }) => id)).toEqual([]);
  });

  // The exception is a narrow match, never a switch: the gate reads the record, so deleting it turns the
  // exemption off, and the page functions that gather the card data stay wired to the classifier.
  it('the gate applies the Schedule exception only on the Schedule, only while the record exists', () => {
    const gate = readFileSync(join(__dirname, '..', '..', 'e2e', 'mobile', 'gate.spec.ts'), 'utf8');
    expect(gate).toMatch(/acceptedExceptions\?\.scheduleDoubleBooked/);
    expect(gate).toMatch(/scheduleDoubleBooked: scheduleDoubleBookedAccepted && isSchedule\(state\.id\)/);
    expect(gate).toMatch(/const isSchedule = \(id: string\) => id === 'schedule' \|\| id\.startsWith\('schedule~'\)/);
  });

  it('the schedule overflow pair is fixed, never allow-listed', () => {
    expect(entries.schedule?.overflow, 'a sideways-scrolling week grid is fixed in the stylesheet').toBeUndefined();
  });

  it('every report-only check is documented with its owner and reason', () => {
    const undocumented = REPORT_ONLY.filter((check) => {
      const doc = reportOnlyChecks[check];
      return !doc || !/^(\d{1,2}|unowned)$/.test(doc.slice ?? '') || (doc.reason ?? '').trim().length < 20;
    });
    expect(undocumented, `List these under "reportOnlyChecks" in allowlist.json (a slice number or "unowned", and a reason), or enforce them in checks.ts:\n${undocumented.join('\n')}`).toEqual([]);
  });

  // The browser-console vendor check is enforced (notification-bell follow-up to slice 75): the realtime socket
  // that used to put the provider's address in the console is gone. The one thing it does not judge is the
  // vendors' own embedded frames (phone dialer, payment form), which Ran accepted on 2026-10-08, and the two Firefox
  // Feature Policy warnings the dialer's embed script causes (2026-10-09; classifier tests: mobile-gate-console-lines.test.ts).
  it('the vendor-console check is enforced, with one documented exception that names its owner', () => {
    expect(ALWAYS_ENFORCED).toContain('vendorConsole');
    expect(REPORT_ONLY as readonly string[]).not.toContain('vendorConsole');
    const accepted = (parsed.acceptedExceptions ?? {}) as Record<string, { owner?: string; reason?: string }>;
    // Two accepted exceptions exist: this one, and the Schedule's double-booked cards (asserted above).
    expect(Object.keys(accepted).sort()).toEqual(['scheduleDoubleBooked', 'vendorConsole']);
    expect(accepted.vendorConsole?.owner).toBe('Ran');
    expect(accepted.vendorConsole?.reason).toMatch(/2026-10-08/);
    expect(accepted.vendorConsole?.reason).toMatch(/embedded frames/);
    // Ran's 2026-10-09 extension: two Firefox Feature Policy warnings from the dialer's own embed script.
    expect(accepted.vendorConsole?.reason).toMatch(/2026-10-09/);
    expect(accepted.vendorConsole?.reason).toMatch(/Feature Policy warnings for clipboard-read\/clipboard-write/);
  });

  it('no route lists the vendor-console check: every page is held to it', () => {
    expect(pairs.filter(({ id }) => id.endsWith('/vendorConsole')).map(({ id }) => id)).toEqual([]);
  });

  it('reportOnlyChecks lists only checks that really are report-only', () => {
    const stale = Object.keys(reportOnlyChecks).filter((check) => !(REPORT_ONLY as readonly string[]).includes(check));
    expect(stale, `Delete these from "reportOnlyChecks": the gate now enforces them`).toEqual([]);
  });

  it('every entry is a report or an enforce entry with a device list', () => {
    const bad = pairs.filter(({ entry }) => !['report', 'enforce'].includes(entry.mode ?? '') || !Array.isArray(entry.devices) || entry.devices.length === 0).map(({ id }) => id);
    expect(bad).toEqual([]);
  });

  it('no device or rule is listed twice in one entry', () => {
    const dup = pairs
      .filter(({ entry }) => new Set(entry.devices).size !== (entry.devices ?? []).length || new Set(entry.rules).size !== (entry.rules ?? []).length)
      .map(({ id }) => id);
    expect(dup).toEqual([]);
  });
});
