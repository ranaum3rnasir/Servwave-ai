/**
 * The mobile gate: six checks on every key route and open overlay, on six device projects.
 * How to run it, and how a slice flips its routes to enforce: ./README.md.
 */
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { CHECKS } from './checks';
import { recordConsole } from './console-lines';
import { gateDevice } from './devices';
import { decide, loadAllowlist, loadKnownBroken, RECORDS_DIR, type Verdict } from './allowlist';
import { measure, settle } from './measure';
import { openOverlay } from './openers';
import { exemptLine } from './schedule-double-booked';
import { selectStates, type GateFixtures } from './routes';
import { FIXTURES_FILE } from './paths';
import { keepSession, signIn, test } from './session';

function loadFixtures(): GateFixtures {
  return JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
}

const allowlist = loadAllowlist();
const knownBroken = loadKnownBroken();
// The Schedule's accepted exception (schedule-double-booked.ts) applies on the Schedule page and its overlays,
// and only while allowlist.json records it (acceptedExceptions.scheduleDoubleBooked).
const scheduleDoubleBookedAccepted = !!allowlist.acceptedExceptions?.scheduleDoubleBooked;
const isSchedule = (id: string) => id === 'schedule' || id.startsWith('schedule~');

for (const state of selectStates()) {
  test(`${state.id} ${state.overlay ? `(overlay: ${state.overlay})` : ''}`.trim(), async ({ page, session }, testInfo) => {
    const device = gateDevice(testInfo.project.name);
    const fixtures = loadFixtures();
    const target = state.path(fixtures);
    const notes: string[] = [];

    // Every test gets a fresh browser context, so public pages and login open cold (no storage);
    // signed-in states get this worker's session put in localStorage before the app boots.
    const p = page;
    if (!state.anon) await signIn(p, session, notes);
    // Our own document's console lines are judged (vendorConsole is enforced); lines from the vendors'
    // embedded frames (phone dialer, payment form) are the documented exception, only listed below.
    const consoleRecord = recordConsole(p);

    try {
      await state.prepare?.(p);
      const resp = await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(p, notes);
      const finalPath = new URL(p.url()).pathname;

      // A page that did not render cannot be measured; fail rather than pass on an empty screen.
      expect(resp?.status() ?? 200, `document status for ${target}`).toBeLessThan(400);
      if (!state.anon) expect(finalPath, `${target} sent the signed-in admin to /login (session lost?)`).not.toBe('/login');
      const crashed = (await p.getByTestId('error-boundary-fallback').count()) > 0;
      const known = knownBroken[state.id];
      if (crashed && known) {
        // A page the sweep found crashing, listed in known-broken.json: reported in every sweep
        // report, not measured. Whoever fixes the page deletes the entry (README, "The full sweep").
        testInfo.annotations.push({ type: 'known broken', description: known.reason });
        console.log(`[mobile-gate] ${device.id} ${state.id}: KNOWN BROKEN - ${known.reason}`);
        test.skip(true, `known broken: ${known.reason}`);
        return;
      }
      if (!crashed && known) {
        testInfo.annotations.push({ type: 'stale known-broken entry', description: `${state.id} renders now: delete it from known-broken.json` });
        console.log(`[mobile-gate] ${device.id} ${state.id}: renders now, so its known-broken.json entry is stale`);
      }
      expect(crashed, `${target} rendered the error screen`).toBe(false);
      expect(await p.evaluate(() => document.body.innerText.trim().length), `${target} rendered no text`).toBeGreaterThan(0);

      if (state.overlay) {
        const opened = await openOverlay(p, state.overlay, device.touch);
        if (!opened.opened && 'notHere' in opened) {
          testInfo.annotations.push({ type: 'not applicable', description: opened.notHere });
          test.skip(true, opened.notHere);
          return;
        }
        if (!opened.opened) throw new Error(`${state.id}: could not open the overlay: ${opened.error}`);
        notes.push(`opened ${opened.label}`);
      }

      const m = await measure(p, { touch: device.touch, onlyInOverlays: !!state.overlay, consoleLines: consoleRecord.lines, withMeasuredOnly: !state.overlay, scheduleDoubleBooked: scheduleDoubleBookedAccepted && isSchedule(state.id) });

      const verdicts: Record<string, Verdict> = {};
      for (const check of CHECKS) verdicts[check] = decide(allowlist, state.id, check, device.id, m[check].offenders);

      // Record for build-allowlist.mjs and the run summary.
      const record = { state: state.id, device: device.id, path: target.replace(/token=[^&]+/, 'token=<redacted>'), finalPath, notes, checks: m, verdicts };
      fs.mkdirSync(path.join(RECORDS_DIR, device.id), { recursive: true });
      fs.writeFileSync(path.join(RECORDS_DIR, device.id, `${state.id}.json`), JSON.stringify(record, null, 1));
      await testInfo.attach('mobile-gate-record.json', { body: JSON.stringify(record, null, 1), contentType: 'application/json' });

      const lines: string[] = [];
      for (const check of CHECKS) {
        const v = verdicts[check]!;
        const offenders = m[check].offenders;
        if (v.status === 'allowed') {
          lines.push(`  REPORT ${check}: ${offenders.length} known offender(s) - ${v.reason}`);
          testInfo.annotations.push({ type: `report ${check}`, description: offenders.slice(0, 5).join(' | ') });
        } else if (v.status === 'pass') {
          const entry = allowlist.entries[state.id]?.[check];
          if (entry?.mode === 'report' && entry.devices.includes(device.id)) {
            lines.push(`  CLEAN  ${check}: listed in allowlist.json but clean here - the owning slice can enforce it`);
          }
        }
      }
      for (const check of CHECKS) {
        const exempt = m[check].exempt;
        if (exempt?.length) lines.push(exemptLine(check, exempt));
      }
      if (consoleRecord.frameLines.length) {
        const origins = [...new Set(consoleRecord.frameLines.map((l) => l.origin))].join(', ');
        lines.push(`  EXEMPT vendorConsole: ${consoleRecord.frameLines.length} line(s) from embedded vendor frame(s) [${origins}] - accepted exception (allowlist.json acceptedExceptions)`);
      }
      if (consoleRecord.dialerWarnings.length) {
        lines.push(`  EXEMPT vendorConsole: ${consoleRecord.dialerWarnings.length} Firefox Feature Policy warning(s) (clipboard-read / clipboard-write) from the phone dialer's own embed script - accepted exception (allowlist.json acceptedExceptions)`);
      }
      const failures = CHECKS.filter((c) => verdicts[c]!.status === 'fail');
      if (lines.length) console.log(`[mobile-gate] ${device.id} ${state.id}\n${lines.join('\n')}`);
      expect(
        failures.map((c) => ({ check: c, reason: (verdicts[c] as { reason: string }).reason, offenders: m[c].offenders.slice(0, 12) })),
        `mobile gate: new or enforced offenders on ${state.id} (${device.id})`,
      ).toEqual([]);
    } finally {
      if (!state.anon) await keepSession(p, session);
    }
  });
}
