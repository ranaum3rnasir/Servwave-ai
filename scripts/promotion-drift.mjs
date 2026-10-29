#!/usr/bin/env node
/* =============================================================================
   Which files would this promotion REVERT on `main`?

   WHY THIS EXISTS

   Promotions are selective cherry-picks and the `main`-is-ancestor-of-`staging`
   gate is deliberately broken, so `main` legitimately carries work that
   `staging` has never seen: direct hotfixes, Dependabot bumps, and config that
   only the default branch can read. None of it has a route back to staging.

   That makes every promotion a silent revert risk. When the promotion branch
   touches a file `main` has moved on since the fork point, taking the
   promotion's copy wholesale throws main's version away, and git reports no
   conflict because the promotion branch simply has an older-but-different file.

   Three instances, all found by accident rather than by any check:

     - `.github/dependabot.yml` - the 2026-08-05 promotion (e516c139b, #1259)
       reset it to a 2026-07-07 blob, deleting the Dependabot staging mirror.
       Six weeks of dependency updates on staging lost; nothing went red.
     - `@testing-library/jest-dom` - the SAME promotion reverted a main-only
       Dependabot bump (#1162) from ^7.0.0 back to ^6.9.1.
     - `backend/src/services/automations/cron.ts` - `main` carries the
       cross-org tenant-bypass fix 0fb17c83d (2 `runUnscoped` hits); staging has
       0 and never had it. Still true; still unguarded by anything but this.

   WHAT IT DOES NOT DO

   It does not block, and it must not. Main being ahead on a file is often
   perfectly fine - the promotion may be deliberately superseding it. Only a
   human can tell "superseded on purpose" from "reverted by accident", so this
   prints the list and stops. It also does NOT touch the ancestor gate.

   Usage:  node scripts/promotion-drift.mjs [--base origin/main] [--head HEAD]
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = arg('base', 'origin/main');
const HEAD = arg('head', 'HEAD');

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

let mergeBase;
try {
  mergeBase = git('merge-base', BASE, HEAD);
} catch {
  console.error(
    `promotion-drift: cannot find a merge base for ${BASE}..${HEAD}.\n` +
      `On CI this usually means a shallow clone - use fetch-depth: 0.`,
  );
  process.exit(0); // advisory only: never fail the build on our own plumbing
}

// Every file whose content differs between the two branch TIPS.
//
// Deliberately the two-dot tip-vs-tip diff, not `mergeBase..HEAD`. An earlier
// version scanned only files the promotion branch had changed, which silently
// skipped the most dangerous shape of all: a file the promotion never touched
// but `main` did. A cherry-pick leaves that alone, but ANY wholesale resolution
// (`git checkout staging -- <file>`, "take theirs" on a conflict, a full-tree
// promotion) reverts it. That is the `cron.ts` case this script exists for.
const differing = git('diff', '--name-only', BASE, HEAD).split('\n').filter(Boolean);

const drifted = [];
for (const file of differing) {
  // Has main moved on this file since the fork? If not, nothing of main's is at
  // risk - the promotion is simply newer.
  const mainLog = git('log', '--format=%h\t%ad\t%s', '--date=short', `${mergeBase}..${BASE}`, '--', file);
  if (!mainLog) continue;
  const headTouched = git('log', '--format=%h', `${mergeBase}..${HEAD}`, '--', file) !== '';
  drifted.push({ file, commits: mainLog.split('\n'), bothSides: headTouched });
}

// Rank before capping. The first cut of this script capped an ALPHABETICAL list
// at 60 files and buried cron.ts - the one file it was written to find - at
// position 237. A report that hides its own headline is worse than no report.
const byRisk = (a, b) => b.commits.length - a.commits.length || a.file.localeCompare(b.file);
const bothSides = drifted.filter((d) => d.bothSides).sort(byRisk);
const mainOnly = drifted.filter((d) => !d.bothSides).sort(byRisk);

const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
const DETAIL = 10; // files given full commit detail; the LIST itself is never capped

const lines = [];
if (drifted.length === 0) {
  lines.push(
    `No drift. ${BASE} has no commits on any file that differs from ${HEAD}, ` +
      `so merging this branch cannot revert anything on ${BASE}.`,
  );
} else {
  // Every drifted file is NAMED, always. Only the per-file commit DETAIL is
  // capped. Two earlier cuts of this script capped the file list itself and
  // buried cron.ts - first at position 237 of an alphabetical list, then at
  // rank 48 of a list ranked by commit count with a cap of 40. A cap on the
  // list is a cap on what the reader is allowed to find out, and the file you
  // most need to see has no reason to sort near the top.
  const section = (title, items, note) => {
    if (items.length === 0) return;
    lines.push(`### ${title} (${items.length})`, ``, note, ``);
    for (const { file, commits } of items) {
      lines.push(`  ${String(commits.length).padStart(3)} commit(s) on ${BASE}   ${file}`);
    }
    lines.push(``, `  -- most-changed ${Math.min(DETAIL, items.length)}, in detail --`, ``);
    for (const { file, commits } of items.slice(0, DETAIL)) {
      lines.push(`  ${file}`);
      for (const c of commits.slice(0, 5)) lines.push(`      ${c.replace(/\t/g, '  ')}`);
      if (commits.length > 5) lines.push(`      ... and ${commits.length - 5} more`);
      lines.push(``);
    }
  };

  lines.push(
    `${plural(drifted.length, 'file')} differ between ${HEAD} and ${BASE}, and ${BASE} ` +
      `has its own commits on ${drifted.length === 1 ? 'it' : 'them'} since ${mergeBase.slice(0, 9)}.`,
    ``,
    `This is ADVISORY. ${BASE} being ahead is often deliberate. Confirm each is ` +
      `a conscious supersede, not an accidental revert of work that has no route ` +
      `back to this branch.`,
    ``,
  );

  section(
    'Changed on BOTH sides',
    bothSides,
    'Highest risk: a real divergence. If a conflict here is resolved by taking ' +
      `the promotion's side wholesale, ${BASE}'s work is gone and git reports no error.`,
  );
  section(
    `Changed only on ${BASE}`,
    mainOnly,
    'Safe under a clean cherry-pick, which leaves these untouched. Reverted by ' +
      'any wholesale copy of the promotion branch, or by `git checkout <branch> -- <file>`.',
  );

  lines.push(`Inspect one with:  git diff ${HEAD}:<file> ${BASE}:<file>`);
}

const report = lines.join('\n');
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Promotion drift\n\n\`\`\`\n${report}\n\`\`\`\n`,
  );
}

// Advisory only - see "WHAT IT DOES NOT DO" above.
process.exit(0);
