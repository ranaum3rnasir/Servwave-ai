/* =============================================================================
   ServWave Design System — no stock avatar guard (regression fence)
   -----------------------------------------------------------------------------
   Enforces the 2026-08-04 avatar decision (md_files/plans/frontend/
   2026-08-04-user-avatars-initials-and-upload.md, decisions 1-3): no staff
   avatar may ever be a stranger's stock photo. A generated-avatar service
   seeded off a user's id/name renders a photo of someone who is not that
   person — the exact bug this guard exists to catch (TeamCard.tsx and
   AssignTeamPopover.tsx both did this via i.pravatar.cc until this PR).

   Matches on the service hostname/package name, not on "avatar" generally —
   a false positive here would be noisy (the upload feature legitimately says
   "avatar" everywhere) and a false negative would defeat the point, so the
   list is the known generated-avatar services rather than a broad heuristic.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const THIS_FILE = fileURLToPath(import.meta.url);

// Known third-party generated/stock-avatar services. Never allowlist a hit —
// per decision 1, staff avatars render only a real upload or the initials tile.
const FORBIDDEN: RegExp[] = [
  /pravatar\.cc/i,
  /ui-avatars\.com/i,
  /dicebear/i,
  /gravatar\.com/i,
  /randomuser\.me/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|js|jsx)$/.test(p) ? [p] : [];
  });
}

describe('no stock/generated avatar service anywhere in the app (2026-08-04 decision)', () => {
  it('never references a stranger-photo avatar service', () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      if (file === THIS_FILE) continue;
      const code = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(code)) violations.push(`${relative(SRC, file)}: matches ${re}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
