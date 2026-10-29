#!/usr/bin/env node
/* =============================================================================
   Lint ONLY the lines a PR actually changed.

   WHY THIS EXISTS. The first version of the CI lint gate ran eslint over every
   file the PR touched. That sounds equivalent, but it is not: `staging` carries
   239 pre-existing errors spread over 139 of its 1013 frontend files, so
   roughly one file in seven is already dirty. Touching any of them - even to
   change one unrelated line - inherited every error already in that file and
   failed the build. Two real PRs (#1041, #1036) were blocked by two
   `react-hooks` errors in PaymentsReport.tsx that neither of them wrote.

   So: run eslint over the changed files (it needs whole-file context to resolve
   types and hook rules), then report only the ERRORS that land on lines this
   PR added or modified. New code has to be clean; the backlog is somebody
   else's problem until somebody actually edits those lines.

   Warnings never fail the build, exactly as before.

   Usage: node scripts/lint-changed-lines.mjs <base-ref>
     e.g. node scripts/lint-changed-lines.mjs origin/staging
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseRef = process.argv[2];
if (!baseRef) {
  console.error('usage: node scripts/lint-changed-lines.mjs <base-ref>');
  process.exit(2);
}

// fileURLToPath rather than import.meta.dirname: the latter landed in Node
// 20.11 and the workflow pins only `node-version: '20'`.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = resolve(REPO_ROOT, 'frontend');

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/* --- which files ---------------------------------------------------------- */

// Three-dot diff: compare against the merge base, so commits that landed on the
// base branch after this PR branched are not attributed to this PR.
// --diff-filter=ACMR - added/copied/modified/renamed. Deleted files cannot be linted.
const changedFiles = git(['diff', '--name-only', '--diff-filter=ACMR', `${baseRef}...HEAD`])
  .split('\n')
  .filter((f) => /^frontend\/.*\.(ts|tsx)$/.test(f));

if (changedFiles.length === 0) {
  console.log('No lintable frontend files changed in this PR.');
  process.exit(0);
}

/* --- which lines ---------------------------------------------------------- */

/**
 * Added/modified line numbers per file, from the unified diff with zero context
 * lines (-U0) so each hunk header describes exactly the touched range.
 *
 * A hunk header looks like `@@ -12,3 +14,5 @@`, where `+14,5` means five lines
 * starting at new-file line 14. The count is omitted when it is 1 (`+14`), and
 * is 0 for a pure deletion - which touches no new lines, so it contributes
 * nothing to lint.
 *
 * @returns {Map<string, Set<number>>} repo-relative path -> touched line numbers
 */
function changedLinesByFile(files) {
  const out = new Map();
  const diff = git(['diff', '-U0', `${baseRef}...HEAD`, '--', ...files]);

  let current = null;
  for (const line of diff.split('\n')) {
    // `+++ b/path` opens each file section. `/dev/null` appears for deletions,
    // which --diff-filter already excluded, but guard anyway.
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '');
      current = path === '/dev/null' ? null : path;
      if (current && !out.has(current)) out.set(current, new Set());
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;

    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const set = out.get(current);
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return out;
}

const touched = changedLinesByFile(changedFiles);

/* --- lint ----------------------------------------------------------------- */

// eslint is run from frontend/ with paths relative to it, matching how the repo
// is configured. It exits non-zero whenever it reports an error, so a non-zero
// exit is expected here and the JSON on stdout is what we actually want.
// --no-warn-ignored: a changed file eslint's config ignores (e.g. vitest.config.ts)
// would otherwise emit a "File ignored" warning that reads like a problem.
const relToFrontend = changedFiles.map((f) => f.replace(/^frontend\//, ''));

console.log(`Linting ${changedFiles.length} changed file(s), reporting errors on changed lines only:`);
for (const f of changedFiles) console.log(`  ${f}`);

let raw;
try {
  raw = execFileSync('npx', ['eslint', '--no-warn-ignored', '-f', 'json', ...relToFrontend], {
    cwd: FRONTEND,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // Non-zero exit with parseable stdout = eslint found problems. Anything else
  // (crash, bad config, OOM) has no usable stdout and must fail loudly rather
  // than be mistaken for "no errors".
  raw = err.stdout;
  if (!raw || !raw.trim().startsWith('[')) {
    console.error('eslint failed to run:');
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

const results = JSON.parse(raw);

/* --- report --------------------------------------------------------------- */

let onChangedLines = 0;
let preExisting = 0;

for (const result of results) {
  const repoPath = relative(REPO_ROOT, result.filePath);
  const lines = touched.get(repoPath);

  for (const msg of result.messages) {
    if (msg.severity !== 2) continue; // warnings never fail the build

    // A message with no line (parse error, config-level failure) cannot be
    // attributed to a hunk. Fail on it - it is never pre-existing noise, and
    // silently dropping it would let a genuinely broken file through.
    const attributable = typeof msg.line === 'number';
    if (attributable && !(lines && lines.has(msg.line))) {
      preExisting++;
      continue;
    }

    onChangedLines++;
    const loc = attributable ? `${msg.line}:${msg.column ?? 0}` : 'file';
    console.log(`\n${repoPath}:${loc}  error  ${msg.message}  ${msg.ruleId ?? ''}`);
  }
}

console.log(
  `\n${onChangedLines} error(s) on lines this PR changed. ` +
    `${preExisting} pre-existing error(s) in these files ignored.`,
);

if (onChangedLines > 0) {
  console.log('\nFix the errors above - they are on lines this PR added or modified.');
  process.exit(1);
}
console.log('No new errors introduced.');
