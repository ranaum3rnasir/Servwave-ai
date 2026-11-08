#!/usr/bin/env node
/**
 * Unresolved-class gate.
 *
 * Tailwind does NOT error on a class that does not exist - it exits 0 and emits
 * nothing, so the element silently renders unstyled. That is the single most
 * common silent failure in this tree: `rounded-control`, `bg-accent`,
 * `ring-dashed` and the `ui/toast.tsx` destructive family are all live in real
 * className strings today, with tsc at 0 and every test green.
 *
 * This script extracts every colour/radius-shaped utility from src/, feeds them
 * through Tailwind with the REAL config, and reports any that produce no CSS
 * rule. Compared against a committed baseline so the stable prose false
 * positives ("to-do", "from-member", "text-anchor") cost nothing to maintain.
 *
 *   node scripts/check-unresolved-classes.mjs            # check against baseline
 *   node scripts/check-unresolved-classes.mjs --write    # re-baseline
 *   node scripts/check-unresolved-classes.mjs --json     # machine-readable
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const SRC = join(FRONTEND, 'src');
const BASELINE = join(HERE, 'unresolved-classes-baseline.json');

/** Utility families whose value comes from the theme - i.e. can go unresolved. */
const PREFIX =
  /^(bg|text|border|ring|ring-offset|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow|rounded)-/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__snapshots__']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** class -> sorted list of repo-relative files that mention it. */
export function extractCandidates() {
  const found = new Map();
  for (const file of walk(SRC)) {
    const code = readFileSync(file, 'utf8');
    for (const raw of code.split(/[^\w:/[\].\-%#(),]+/)) {
      if (!raw) continue;
      // Strip variant chain (hover:, dark:, data-[state=on]:, group-[.x]:, ...).
      // Bracketed variants can contain ':' so take the segment after the last
      // ':' that is NOT inside brackets.
      const base = stripVariants(raw).replace(/[,.)]+$/, '');
      if (!base || !PREFIX.test(base)) continue;
      if (!/^[a-z0-9\-/[\].#%(),_]+$/i.test(base)) continue;
      // Arbitrary values (bg-[#fff], shadow-[0_2px_4px_rgba(0,0,0,.1)]) are
      // generated from the value itself, so they cannot be "unresolved" in the
      // sense this gate cares about. Skip them: Tailwind escapes commas as
      // `\2c ` in the emitted selector, which selector-matching cannot round-trip.
      if (base.includes('[')) continue;
      if (!found.has(base)) found.set(base, new Set());
      // Forward slashes always: the committed baseline is '/'-separated, and
      // relative() yields '\' on Windows, so without this every baselined pair
      // read as a brand-new violation and the gate failed with 130+ phantom
      // entries there.
      found.get(base).add(relative(FRONTEND, file).split(sep).join('/'));
    }
  }
  return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
}

function stripVariants(token) {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return token.slice(lastColon + 1);
}

/** Tailwind's selector escaping for the characters that appear in utilities. */
function escapeClass(cls) {
  return cls.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

export function findUnresolved(candidates) {
  const tmp = mkdtempSync(join(tmpdir(), 'tw-resolve-'));
  const contentFile = join(tmp, 'content.html');
  const inFile = join(tmp, 'in.css');
  const outFile = join(tmp, 'out.css');
  const cfgFile = join(tmp, 'tw.config.cjs');

  writeFileSync(contentFile, `<div class="${[...candidates.keys()].join(' ')}"></div>`);
  writeFileSync(inFile, '@tailwind utilities;\n');
  // Reuse the REAL theme; only the content source is swapped.
  //
  // `.default ?? mod` is load-bearing, not defensive. tailwind.config.js is ESM,
  // and Node's require(esm) hands back the module namespace - `{ __esModule,
  // default }` - not the config. Spreading that yields an object with no
  // `theme` at all, so Tailwind falls back to its stock palette and every
  // token-derived class in the tree reads as unresolved: 55 phantom violations
  // across 80 files, most of them legacy files nobody had touched. Tailwind's
  // own loadConfig unwraps the same way (lib/lib/load-config.js), which is why
  // the app kept building correctly while this harness went blind.
  writeFileSync(
    cfgFile,
    `const mod = require(${JSON.stringify(join(FRONTEND, 'tailwind.config.js'))});\n` +
      `const real = mod.default ?? mod;\n` +
      `if (!real.theme) throw new Error('tailwind config loaded without a theme - check the ESM interop above');\n` +
      `module.exports = { ...real, content: [${JSON.stringify(contentFile)}], safelist: [] };\n`,
  );

  // shell:true so this resolves npx.cmd on Windows; without it execFileSync
  // throws ENOENT and the guard fails for reasons unrelated to any class.
  execFileSync('npx', ['tailwindcss', '-c', cfgFile, '-i', inFile, '-o', outFile], {
    shell: process.platform === 'win32',
    cwd: FRONTEND,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const css = readFileSync(outFile, 'utf8');
  const present = new Set();
  for (const m of css.matchAll(/\.((?:[\w-]|\\.)+)(?=[\s,:{>~+.[])/g)) present.add(m[1]);

  const unresolved = {};
  for (const [cls, files] of candidates) {
    if (!present.has(escapeClass(cls))) unresolved[cls] = files;
  }
  return unresolved;
}

/**
 * Baseline shape: `{ "<class>": ["<file>", ...] }` - an exemption is scoped to
 * the exact files it was observed in, never to the class name tree-wide.
 *
 * This matters because most entries here are extraction noise ("to-do",
 * "text-to-speech", "from-scratch" - prose and regex source, not classes), but
 * a minority are real palette classes that only survive because they sit in a
 * guard fixture or a test string. A name-only baseline could not tell those
 * apart, so writing `bg-emerald-500` into a live component tomorrow would have
 * inherited the fixture's exemption and shipped an unstyled element.
 */
export function loadBaseline(path = BASELINE) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(raw)) {
    throw new Error(
      `${path} is in the legacy name-only format. Regenerate it with --write: ` +
        'a name-only baseline exempts a class in every file, which is exactly the hole this gate exists to close.',
    );
  }
  return raw;
}

/** class -> files where it is unresolved AND not covered by the baseline. */
export function newPairs(unresolved, baseline) {
  const out = {};
  for (const [cls, files] of Object.entries(unresolved)) {
    const allowed = new Set(baseline[cls] ?? []);
    const fresh = files.filter((f) => !allowed.has(f));
    if (fresh.length) out[cls] = fresh;
  }
  return out;
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const candidates = extractCandidates();
  const unresolved = findUnresolved(candidates);
  const names = Object.keys(unresolved).sort();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(unresolved, null, 2));
    process.exit(0);
  }

  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(names.map((n) => [n, unresolved[n]])), null, 2) + '\n');
    console.log(`baselined ${names.length} unresolved classes -> ${relative(FRONTEND, BASELINE)}`);
    process.exit(0);
  }

  const baseline = existsSync(BASELINE) ? loadBaseline() : {};
  const violations = newPairs(unresolved, baseline);
  const fixed = Object.keys(baseline).filter((n) => !unresolved[n]);

  console.log(
    `candidates: ${candidates.size}   unresolved: ${names.length}   baseline: ${Object.keys(baseline).length}`,
  );
  for (const cls of names) {
    const files = unresolved[cls];
    const mark = violations[cls] ? '+' : ' ';
    console.log(`${mark} ${String(files.length).padStart(3)}  ${cls}   <- ${files.slice(0, 2).join(', ')}`);
  }
  if (fixed.length) console.log(`\nresolved since baseline (safe to re-baseline): ${fixed.join(', ')}`);
  const violated = Object.keys(violations).sort();
  if (violated.length) {
    console.error(`\nFAIL: ${violated.length} unresolved class(es) in a file the baseline does not cover:`);
    for (const cls of violated) console.error(`  ${cls}   <- ${violations[cls].join(', ')}`);
    process.exit(1);
  }
  console.log('\nOK: no new unresolved classes.');
}
