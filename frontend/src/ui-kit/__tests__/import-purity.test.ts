/**
 * ui-kit import purity: nothing under `src/ui-kit/` may import out of the kit.
 *
 * The app may import the kit - many v2 pages do, and `components/form/SelectField`
 * now imports `@/ui-kit/lib/selectThreshold` - but the arrow only points one way.
 * The kit is meant to be liftable out of this app whole; a single `@/components/…`
 * or `@/hooks/…` import inside it quietly ends that, and it ends it invisibly,
 * because such an import type-checks, lints and runs perfectly well.
 *
 * Exceptions live in the explicit allowlist below, each with its reason - never
 * in a loosened regex. An entry is (file, specifier) exact, so a new import into
 * an allowlisted file still fails, and an entry nothing uses any more fails too,
 * so the list cannot rot.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Static `from`, dynamic `import(…)` and re-`export … from`, single or double
// quoted. Written without a sample specifier in the comment on purpose: this
// file is inside the tree it scans, so an illustrative one would match itself.
const APP_ALIAS_IMPORT = /(?:from|import)\s*\(?\s*['"](@\/[^'"]+)['"]/g;

interface AllowlistEntry {
  /** Posix path relative to `src/ui-kit`. */
  file: string;
  specifier: string;
  reason: string;
}

// The unified date/time fields (SRVW-247) are the one place the kit reads ORG
// SETTINGS: the org's date pattern (MM/DD vs DD/MM) and timezone decide what a
// typed "3/4/2026" means and where "this week" starts. That knowledge lives in
// `@/lib/date-input` / `@/lib/date-range`, which every prior date control
// delegated to and which reach `@/lib/org-format` and `@/lib/schedule-tz`
// (react-query + axios) underneath - so lifting them into the kit would drag
// the app's data layer in with them. Documented seam, not a leak: parsing and
// presets are the app's, the field is the kit's.
const ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'components/form/dateField.tsx',
    specifier: '@/lib/date-input',
    reason: 'org date pattern parsing/formatting - the seam every legacy date control used',
  },
  {
    file: 'components/form/dateField.tsx',
    specifier: '@/lib/date-range',
    reason: 'org-timezone range presets (today / this week / this month) for mode="range"',
  },
  {
    file: 'components/form/timeField.tsx',
    specifier: '@/lib/date-input',
    reason: 'time text parsing ("3p", "15:00") and option matching - the seam every legacy time control used',
  },
  {
    file: 'components/form/__tests__/dateField.test.tsx',
    specifier: '@/lib/org-format',
    reason: 'drives the org date-pattern seam dateField.tsx reads through date-input, to pin DD/MM/YYYY rendering',
  },
];

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

describe('ui-kit import purity', () => {
  it('imports nothing from @/ outside @/ui-kit', () => {
    // Vitest's root is `frontend/`.
    const root = join(process.cwd(), 'src', 'ui-kit');
    const offenders: string[] = [];
    const used = new Set<AllowlistEntry>();

    for (const file of tsFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const rel = relative(root, file).split('\\').join('/'); // posix-normalize on Windows
      for (const match of source.matchAll(APP_ALIAS_IMPORT)) {
        const specifier = match[1]!;
        if (specifier === '@/ui-kit' || specifier.startsWith('@/ui-kit/')) continue;
        const allowed = ALLOWLIST.find((e) => e.file === rel && e.specifier === specifier);
        if (allowed) {
          used.add(allowed);
          continue;
        }
        offenders.push(`${relative(process.cwd(), file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);

    // Ratchet the other way: an allowlist entry nothing imports any more is a
    // stale exception, and stale exceptions are how a fence stops meaning anything.
    const stale = ALLOWLIST.filter((e) => !used.has(e)).map((e) => `${e.file} -> ${e.specifier}`);
    expect(stale).toEqual([]);
  });

  it('is actually reading the tree it claims to read', () => {
    // Without this the assertion above passes just as well on an empty file
    // list - a walker that silently found nothing is the failure mode a purity
    // fence cannot afford.
    const root = join(process.cwd(), 'src', 'ui-kit');
    const files = tsFiles(root);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(join('components', 'form', 'selectField.tsx')))).toBe(true);
  });
});
