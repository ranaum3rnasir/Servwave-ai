import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALWAYS_ENFORCED, REPORT_ONLY, type CheckName } from './checks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ALLOWLIST_FILE = path.join(__dirname, 'allowlist.json');
/** Pages that crash for the throwaway org today (slice 62): see loadKnownBroken. */
export const KNOWN_BROKEN_FILE = path.join(__dirname, 'known-broken.json');
/** Where each gate test writes what it measured; build-allowlist.mjs reads it. */
export const RECORDS_DIR = path.resolve(__dirname, '..', 'test-results-mobile', 'records');

/**
 * One route/check pair on the allow-list.
 * - `report`: today's known offenders. They are reported, not failed, on the listed devices.
 * - `enforce`: any offender fails. A slice that fixes the pair flips it here (or deletes it).
 */
export interface AllowEntry {
  mode: 'report' | 'enforce';
  /** Devices the offenders were seen on. An offender on any other device is new, and fails. */
  devices: string[];
  /**
   * The slice that owns the fix, or `unowned` when none does (a finding of the slice 62 sweep).
   * Required on every `report` entry since slice 75 (`src/__tests__/mobile-gate-allowlist.test.ts`).
   */
  slice?: string;
  /** Why the pair is still allowed to offend: what fails, and what has to happen to fix it. */
  reason?: string;
  /**
   * Optional, per-rule checks only (`a11y`): the rule ids known on this route. An offender whose
   * rule is not listed is new and fails, even on a listed device.
   */
  rules?: string[];
}

/** The rule id an offender starts with (`a11y` offenders: `<rule id> (<impact>): ...`). */
export const offenderRule = (offender: string) => offender.split(' ')[0] ?? '';

/** A check the gate prints but never fails (REPORT_ONLY in checks.ts): who owns it, and why it is not enforced. */
export interface ReportOnlyCheck {
  slice: string;
  reason: string;
}

/**
 * A documented, owner-approved exception applied BEFORE a check judges (not a per-route allowance):
 * who accepted it and what it covers. Two exist:
 * - `vendorConsole`: console lines from the vendors' embedded frames (console-lines.ts);
 * - `scheduleDoubleBooked`: the Schedule's double-booked event cards, narrower than the 24 px floor and
 *   covering each other (Ran, 2026-10-08, Option A; schedule-double-booked.ts). The gate applies it only
 *   while this record exists.
 */
export type AcceptedExceptionName = 'vendorConsole' | 'scheduleDoubleBooked';

export interface AcceptedException {
  owner: string;
  reason: string;
}

export interface Allowlist {
  entries: Record<string, Partial<Record<CheckName, AllowEntry>>>;
  /** Documented per check, not per route: `src/__tests__/mobile-gate-allowlist.test.ts` requires one for every REPORT_ONLY check. */
  reportOnlyChecks?: Partial<Record<CheckName, ReportOnlyCheck>>;
  acceptedExceptions?: Partial<Record<AcceptedExceptionName, AcceptedException>>;
}

export function loadAllowlist(file = ALLOWLIST_FILE): Allowlist {
  if (!fs.existsSync(file)) return { entries: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { entries: raw.entries ?? {}, reportOnlyChecks: raw.reportOnlyChecks ?? {}, acceptedExceptions: raw.acceptedExceptions ?? {} };
}

export type Verdict =
  | { status: 'pass' }
  | { status: 'allowed'; reason: string }
  | { status: 'fail'; reason: string };

/**
 * Decide one check on one state on one device.
 * A new offender - a route/check pair not on the list, or a listed pair on a device it was not
 * seen on - fails. So does any offender on a pair switched to `enforce`, and any vendor term in
 * the page's copy (ALWAYS_ENFORCED).
 * MOBILE_GATE_ENFORCE_ALL=1 treats every pair as `enforce` (the final sweep).
 */
export function decide(
  list: Allowlist,
  stateId: string,
  check: CheckName,
  device: string,
  offenders: string[],
  enforceAll = process.env.MOBILE_GATE_ENFORCE_ALL === '1',
): Verdict {
  if (offenders.length === 0) return { status: 'pass' };
  const entry = list.entries[stateId]?.[check];
  if (enforceAll) return { status: 'fail', reason: 'MOBILE_GATE_ENFORCE_ALL=1: every pair is enforced' };
  if (ALWAYS_ENFORCED.includes(check)) return { status: 'fail', reason: `${check} is enforced from day one; it cannot be allow-listed` };
  if (REPORT_ONLY.includes(check) && entry?.mode !== 'enforce') return { status: 'allowed', reason: `${check} is report-only until a slice enforces it` };
  if (!entry) return { status: 'fail', reason: `new offender: ${stateId}/${check} is not on the allow-list` };
  if (entry.mode === 'enforce') return { status: 'fail', reason: `${stateId}/${check} is switched to enforce` };
  if (!entry.devices.includes(device)) {
    return { status: 'fail', reason: `new offender: ${stateId}/${check} is allowed on [${entry.devices.join(', ')}], not on ${device}` };
  }
  if (entry.rules) {
    const fresh = [...new Set(offenders.map(offenderRule).filter((r) => !entry.rules!.includes(r)))];
    if (fresh.length) return { status: 'fail', reason: `new offender: ${stateId}/${check} lists [${entry.rules.join(', ')}], not ${fresh.join(', ')}` };
  }
  return { status: 'allowed', reason: `known offender (report mode${entry.slice ? `, slice ${entry.slice}` : ''}${entry.reason ? `: ${entry.reason}` : ''})` };
}

/**
 * A page that renders the app's error screen today, found by the full sweep (slice 62). Listing it
 * here keeps one product defect from blocking every promotion forever, WITHOUT hiding it: the gate
 * skips the page's checks, marks it `known broken` in every report, and the entry is deleted by
 * whoever fixes the page. An unlisted page that crashes still fails the run.
 */
export interface KnownBroken {
  /** What breaks, in the words of the error, so the fixer can find it. */
  reason: string;
  /** The slice or area expected to fix it. */
  owner?: string;
}

export function loadKnownBroken(file = KNOWN_BROKEN_FILE): Record<string, KnownBroken> {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw.entries ?? {};
}
