/* =============================================================================
   The Dependabot staging mirror still exists.

   WHY THIS IS A TEST AND NOT A CI JOB

   GitHub reads `.github/dependabot.yml` ONLY from the default branch, so the
   entries that point dependency PRs at `staging` can only ever live on `main`.
   Nothing on staging reads them, nothing on staging tests them, and the repo
   promotes staging -> main by selective cherry-pick. That combination deleted
   the mirror once already:

     - #614 + #648 (2026-07-09) added the mirror and 13 major-version ignores,
       to `main` only - which was correct, because only main's copy is read.
     - staging never received them, so staging's copy stayed at the 2026-07-07
       blob 7413a916b.
     - The 2026-08-05 promotion (e516c139b, #1259) took staging's copy wholesale
       and reset main to that blob BYTE-IDENTICALLY, inside a ~200-file release
       diff. 5 `target-branch` refs -> 0, 26 ignore entries -> 0.
     - Dependabot stopped opening PRs against staging that same day. Six weeks
       later staging was ~40 packages behind and carrying a HIGH multer advisory
       that production had already fixed. No check anywhere went red.

   A config revert is invisible to CI: no job asserts what a YAML file contains.
   A test is not - this runs on EVERY PR against BOTH branches, so a promotion
   that reverts the mirror reddens its own PR before it can merge. That is the
   same reasoning that moved the override check into security-overrides.test.ts
   (#1048): a deterministic file check is a test, not a CI concern.

   Keeping the file IDENTICAL on both branches is the other half of the fix. It
   is inert on staging - Dependabot never reads it there - but its presence means
   no promotion can revert it from either direction.

   LIMITATION, stated honestly: a promotion that reverts the config AND deletes
   this file still slips through. Deleting a test is far more conspicuous in a
   diff than editing YAML, which is the whole point, but it is not airtight.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

// backend/src/__tests__ -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONFIG = join(REPO_ROOT, '.github', 'dependabot.yml');

/**
 * Split the `updates:` list into one text block per `- package-ecosystem:` entry.
 *
 * Deliberately not a YAML parse: `yaml`/`js-yaml` are not declared dependencies
 * here (js-yaml is only transitively present, so it can vanish on any lockfile
 * change), and adding one would make this PR touch a manifest. The file's shape
 * is a flat list of entries, which splits reliably on the entry marker.
 *
 * If dependabot.yml is ever restructured so this no longer holds, the
 * "finds the entries at all" test below fails loudly rather than letting the
 * assertions pass over an empty list.
 */
function ecosystemBlocks(src: string): string[] {
  return src
    .split(/^\s*- package-ecosystem:/m)
    .slice(1)
    .map((b) => `- package-ecosystem:${b}`);
}

const targets = (block: string) =>
  /^\s*target-branch:\s*["']?staging["']?\s*$/m.test(block) ? 'staging' : 'main';

const ecosystemOf = (block: string) =>
  block.match(/- package-ecosystem:\s*["']?([\w-]+)["']?/)?.[1] ?? '(unparsed)';

describe('dependabot config', () => {
  it('has the config file where this test expects it', () => {
    expect(
      existsSync(CONFIG),
      `.github/dependabot.yml not found at ${CONFIG}. If it moved, fix CONFIG ` +
        `here - otherwise this suite would pass while verifying nothing.`,
    ).toBe(true);
  });

  it('finds the ecosystem entries at all', () => {
    const blocks = ecosystemBlocks(readFileSync(CONFIG, 'utf8'));
    expect(
      blocks.length,
      'Parsed 0 `- package-ecosystem:` entries out of dependabot.yml. The file ' +
        'was restructured - update ecosystemBlocks() rather than deleting these ' +
        'assertions, which would otherwise all vacuously pass.',
    ).toBeGreaterThan(0);
  });

  it.each(['npm', 'github-actions'])(
    'still opens %s PRs against staging',
    (ecosystem) => {
      const blocks = ecosystemBlocks(readFileSync(CONFIG, 'utf8'));
      const mirrored = blocks.filter(
        (b) => ecosystemOf(b) === ecosystem && targets(b) === 'staging',
      );
      expect(
        mirrored.length,
        `No \`${ecosystem}\` entry with \`target-branch: "staging"\` in ` +
          `.github/dependabot.yml.\n\n` +
          `If you are resolving a promotion conflict: main's copy is the correct ` +
          `one. Taking staging's copy wholesale is exactly what deleted this in ` +
          `e516c139b (#1259) and cost six weeks of dependency updates on staging. ` +
          `See the header of this file.`,
      ).toBe(1);
    },
  );

  it('keeps main\'s npm entry from opening CI-breaking major bumps', () => {
    const blocks = ecosystemBlocks(readFileSync(CONFIG, 'utf8'));
    const mainNpm = blocks.find(
      (b) => ecosystemOf(b) === 'npm' && targets(b) === 'main',
    );
    expect(mainNpm, 'No default-branch npm entry in dependabot.yml.').toBeDefined();
    expect(
      /update-types:\s*\["version-update:semver-major"\]/.test(mainNpm ?? ''),
      `main's npm entry has no major-version \`ignore\` list. #648 added one ` +
        `because each of those packages broke CI on its major bump; the same ` +
        `promotion that removed the staging mirror removed this too.`,
    ).toBe(true);
  });
});
