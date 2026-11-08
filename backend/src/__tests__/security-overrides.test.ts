/* =============================================================================
   Security override floors are actually enforced in the resolved tree.

   PREVIOUSLY A CI STEP (`npm run verify:overrides` in the dependency-audit job).
   It did 0 seconds of work but cost a full runner slot behind a ~46s `npm ci`.
   The check reads only package.json + package-lock.json, so it is fully
   deterministic - which makes it a test, not a CI concern.

   Moving it here also WIDENS coverage: the dependency-audit job now runs only
   when dependency manifests change (and nightly), whereas this runs on every
   PR and locally before you push.

   Note the sibling check that deliberately did NOT move: `audit-ci` queries the
   LIVE npm advisory database, so its result changes without any commit. As a
   test it would go red because someone published a CVE overnight, which is not
   a code defect. That one stays in CI, on a schedule.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

// backend/src/__tests__ -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-overrides.js');

describe('security override floors', () => {
  it('has the verifier script where this test expects it', () => {
    expect(
      existsSync(SCRIPT),
      `verify-overrides.js not found at ${SCRIPT}. If scripts/ moved, fix SCRIPT ` +
        `here - otherwise this suite would pass while verifying nothing.`,
    ).toBe(true);
  });

  it('resolves every declared override floor in the real dependency tree', () => {
    // The script exits non-zero and prints the drifting package(s) on failure.
    // Surface its own output as the assertion message rather than a bare
    // "exit code 1", which would send the reader hunting through CI logs.
    let output = '';
    let failed = false;
    try {
      output = execFileSync('node', [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      output = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || 'unknown failure';
      failed = true;
    }

    expect(
      failed,
      `A declared security override floor is not met by the resolved tree.\n` +
        `npm does not re-resolve an already-satisfying subtree when \`overrides\`\n` +
        `changes, so the floor and reality drifted apart.\n\n${output}`,
    ).toBe(false);
  });
});
