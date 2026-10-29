#!/usr/bin/env node
/**
 * Build or extend allowlist.json from the last gate run's records, or summarise that run.
 *
 *   node e2e/mobile/build-allowlist.mjs            # merge the last run's offenders into allowlist.json
 *   node e2e/mobile/build-allowlist.mjs --summary  # print what the last run found; write nothing
 *   node e2e/mobile/build-allowlist.mjs --only=a11y # merge only the named check(s), comma-separated
 *   node e2e/mobile/build-allowlist.mjs --devices=firefox,pixel-7   # merge only these devices' offenders
 *   node e2e/mobile/build-allowlist.mjs --states=report-jobs,phone-tab   # merge only these states' offenders
 *
 * `--devices` and `--states` (slice 62) record the first sweep's baseline for a NEW device or a NEW
 * route without also widening entries for pairs it did not mean to touch.
 *
 * Merge rules (so it can only ever record today's offenders, never loosen a fixed pair):
 * - a route/check pair with offenders gets a `report` entry, its devices unioned with any
 *   existing entry's;
 * - an entry already switched to `enforce` is never touched;
 * - `vendorTerms` is never written: the copy rule is enforced from day one (ALWAYS_ENFORCED in
 *   checks.ts); nor is `vendorConsole`, which is enforced too (its one documented exception is
 *   `acceptedExceptions` in the file, kept by hand);
 * - nothing is ever removed: deleting an entry is the owning slice's decision;
 * - per-rule checks (`a11y`) also record the rule ids seen, unioned with the entry's `rules`, so a
 *   new rule on a listed route still fails.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDS = path.resolve(here, '..', 'test-results-mobile', 'records');
const ALLOWLIST = path.join(here, 'allowlist.json');
const ALWAYS_ENFORCED = new Set(['vendorTerms', 'vendorConsole']); // keep in step with checks.ts
const REPORT_ONLY = new Set([]); // keep in step with checks.ts: never listed, never failed
const PER_RULE = new Set(['a11y']); // keep in step with a11y.ts: offenders start with the rule id
const summaryOnly = process.argv.includes('--summary');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').filter(Boolean)) : null;
const listArg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? new Set(a.slice(name.length + 3).split(',').filter(Boolean)) : null;
};
const onlyDevices = listArg('devices');
const onlyStates = listArg('states');

if (!fs.existsSync(RECORDS)) {
  console.error(`No records at ${RECORDS}. Run the gate first (see e2e/mobile/README.md).`);
  process.exit(1);
}

const records = [];
for (const device of fs.readdirSync(RECORDS)) {
  for (const f of fs.readdirSync(path.join(RECORDS, device))) {
    records.push(JSON.parse(fs.readFileSync(path.join(RECORDS, device, f), 'utf8')));
  }
}

const raw = fs.existsSync(ALLOWLIST) ? JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) : {};
const entries = raw.entries ?? {};

const found = {}; // state -> check -> Set(devices)
const rulesFound = {}; // state -> check -> Set(rule ids), per-rule checks only
const counts = {}; // check -> device -> offender total
for (const r of records) {
  if (onlyDevices && !onlyDevices.has(r.device)) continue;
  if (onlyStates && !onlyStates.has(r.state)) continue;
  for (const [check, result] of Object.entries(r.checks)) {
    if (check === 'measured' || !result?.offenders?.length) continue;
    ((found[r.state] ??= {})[check] ??= new Set()).add(r.device);
    if (PER_RULE.has(check)) for (const o of result.offenders) ((rulesFound[r.state] ??= {})[check] ??= new Set()).add(o.split(' ')[0]);
    (counts[check] ??= {})[r.device] = ((counts[check] ??= {})[r.device] ?? 0) + result.offenders.length;
  }
}

if (summaryOnly) {
  const devices = [...new Set(records.map((r) => r.device))].sort();
  console.log(`${records.length} records, ${devices.length} devices, ${new Set(records.map((r) => r.state)).size} states\n`);
  console.log(['check'.padEnd(14), ...devices.map((d) => d.padStart(16))].join(''));
  for (const [check, byDevice] of Object.entries(counts)) {
    console.log([check.padEnd(14), ...devices.map((d) => String(byDevice[d] ?? 0).padStart(16))].join(''));
  }
  const failing = records.filter((r) => Object.values(r.verdicts).some((v) => v.status === 'fail'));
  console.log(`\nstates with a failing check: ${failing.length}`);
  for (const r of failing) {
    const bad = Object.entries(r.verdicts).filter(([, v]) => v.status === 'fail').map(([c]) => c);
    console.log(`  ${r.device.padEnd(16)} ${r.state.padEnd(32)} ${bad.join(', ')}`);
  }
  const clean = [];
  for (const [state, checks] of Object.entries(entries)) {
    for (const [check, e] of Object.entries(checks)) {
      if (e.mode !== 'report') continue;
      const seen = records.filter((r) => r.state === state && e.devices.includes(r.device));
      if (seen.length && seen.every((r) => !r.checks[check]?.offenders?.length)) clean.push(`${state}/${check}`);
    }
  }
  console.log(`\nlisted report-mode pairs that were clean on every device measured (can be enforced): ${clean.length}`);
  for (const c of clean) console.log(`  ${c}`);
  process.exit(0);
}

let added = 0, widened = 0, skippedEnforced = 0;
for (const [state, checks] of Object.entries(found)) {
  for (const [check, devs] of Object.entries(checks)) {
    if (ALWAYS_ENFORCED.has(check) || REPORT_ONLY.has(check)) continue;
    if (only && !only.has(check)) continue;
    const cur = entries[state]?.[check];
    if (cur?.mode === 'enforce') { skippedEnforced++; continue; }
    const rules = PER_RULE.has(check) ? [...(rulesFound[state]?.[check] ?? [])] : null;
    if (!cur) {
      (entries[state] ??= {})[check] = { mode: 'report', devices: [...devs].sort(), ...(rules ? { rules: rules.sort() } : {}) };
      added++;
    } else {
      const before = cur.devices.length + (cur.rules?.length ?? 0);
      cur.devices = [...new Set([...cur.devices, ...devs])].sort();
      if (rules) cur.rules = [...new Set([...(cur.rules ?? []), ...rules])].sort();
      if (cur.devices.length + (cur.rules?.length ?? 0) > before) widened++;
    }
  }
}

const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, Object.fromEntries(Object.keys(entries[k]).sort().map((c) => [c, entries[k][c]]))]));
const out = {
  _readme: raw._readme ?? [
    'Mobile gate allow-list: the known offenders per route state and check (see README.md).',
    'mode "report": offenders on the listed devices are reported, not failed. Anything else fails.',
    'A slice that fixes a pair sets its mode to "enforce" (or deletes it). Generated by build-allowlist.mjs.',
  ],
  ...(raw.reportOnlyChecks ? { reportOnlyChecks: raw.reportOnlyChecks } : {}), // documented by hand; never regenerated
  ...(raw.acceptedExceptions ? { acceptedExceptions: raw.acceptedExceptions } : {}), // documented by hand; never regenerated
  entries: sorted,
};
fs.writeFileSync(ALLOWLIST, `${JSON.stringify(out, null, 2)}\n`);
const pairs = Object.values(sorted).reduce((n, c) => n + Object.keys(c).length, 0);
const desktopPairs = Object.values(sorted).reduce((n, c) => n + Object.values(c).filter((e) => e.devices.includes('desktop')).length, 0);
console.log(`allowlist.json: ${pairs} pairs (${added} added, ${widened} widened, ${skippedEnforced} enforce entries left alone); ${desktopPairs} include the desktop control.`);
