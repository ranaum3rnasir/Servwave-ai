/* =============================================================================
   Unresolved-class gate - wired into the suite (phase 5d).

   `scripts/check-unresolved-classes.mjs` already does the real work: it
   extracts every colour/radius-shaped utility from src/, compiles them
   against the REAL tailwind.config.js, and reports any that produce no CSS
   rule. It existed before this phase but ran in no test and no CI job - the
   one thing that catches a class Tailwind silently drops was itself
   silently unenforced. This file is the thinnest possible wrapper that puts
   its existing exports behind a vitest assertion, so `npm test` (CI's
   frontend job already runs this) fails the moment a real class goes dark.

   Never re-baseline (--write) here to make a red run green - a rising count
   means a real class stopped resolving; fix the source, the same rule as
   every ratchet in tokens-guard.test.ts.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractCandidates,
  findUnresolved,
  loadBaseline,
  newPairs,
} from '../../../scripts/check-unresolved-classes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..', '..', '..');
const BASELINE = join(FRONTEND, 'scripts', 'unresolved-classes-baseline.json');
const FIXTURES = join(FRONTEND, 'scripts', '__fixtures__');

describe('unresolved-class guard (real Tailwind config, committed baseline)', () => {
  it('has a baseline file to compare against', () => {
    expect(existsSync(BASELINE)).toBe(true);
  });

  it('introduces no unresolved class in a file the baseline does not cover', () => {
    const candidates = extractCandidates();
    expect(candidates.size).toBeGreaterThan(0);

    const unresolved = findUnresolved(candidates);
    const baseline = loadBaseline(BASELINE);
    const violations = newPairs(unresolved, baseline);
    const violated = Object.keys(violations).sort();

    const pairs = Object.values(baseline).reduce((n, files) => n + files.length, 0);

    // process.stdout, not console: vitest's console interception swallows
    // these under jsdom, matching every other guard in this suite.
    process.stdout.write(
      `  guard    unresolved classes         ${String(Object.keys(unresolved).length).padStart(5)} / baseline ${
        Object.keys(baseline).length
      } classes, ${pairs} pinned files\n`,
    );
    if (violated.length) {
      process.stdout.write(`  new: ${violated.map((n) => `${n} (${violations[n]?.join(', ')})`).join('; ')}\n`);
    }

    expect(violated).toEqual([]);
    // 180s, not 30s. This case shells out to the Tailwind CLI to compile every
    // candidate class in src/ against the real config - 22-42s on its own, but
    // the suite runs 21 files in parallel and it timed out at 30s there while
    // passing standalone. A timeout reads as a red guard, which is exactly the
    // signal this file exists to make trustworthy, so the cap has to clear the
    // contended case rather than the quiet one.
  }, 180000);

  it('flags a baselined class that appears in a file the baseline does not list', () => {
    // The hole this format closes. The probe class is a real dead class that is
    // legitimately exempt in one guard fixture; under the old name-only baseline
    // that single exemption covered the entire tree, so the same dead class
    // written into a live component would have inherited it and shipped an
    // unstyled element. Its name is read from scripts/__fixtures__ rather than
    // spelled here - see the note in that file.
    const probe = JSON.parse(readFileSync(join(FIXTURES, 'dead-class-probe.json'), 'utf8'));
    const baseline = loadBaseline(BASELINE);

    expect(baseline[probe.class]).toEqual([probe.baselinedIn]);

    // Same class, a file the baseline does not cover -> caught.
    expect(newPairs({ [probe.class]: [probe.leakFile] }, baseline)).toEqual({
      [probe.class]: [probe.leakFile],
    });

    // Same class, the file it is genuinely baselined in -> silent.
    expect(newPairs({ [probe.class]: [probe.baselinedIn] }, baseline)).toEqual({});
  });

  it('refuses the legacy name-only baseline format', () => {
    expect(() => loadBaseline(join(FIXTURES, 'legacy-name-only-baseline.json'))).toThrow(/legacy name-only format/);
  });
});
