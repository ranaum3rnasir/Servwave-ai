import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// ServWave does not categorise anything automatically. Nothing in the product -
// client or server - reads an item's name and picks a category for it.
//
// The claim that it does shipped THREE times on the same feature, and each
// removal missed the next one because it targeted a control rather than the
// vocabulary:
//   1. ImportCSVDialog's checked-by-default "AI auto-categorize" toggle, wired
//      to nothing (removed in #1994);
//   2. the same dialog's modal subtitle, "AI categorization runs after import",
//      two lines above it (removed in #2006, found by opening the dialog);
//   3. ScanDialog's "AI auto-categorize runs on save", on a parked surface
//      nobody could reach (removed here, found by grep).
//
// So this guard is on the WORDS, across the whole tree, rather than on any one
// component. Comments are stripped first, so a note explaining a removal - like
// the ones left at all three sites - is allowed to name the thing it removed.
//
// Path resolution via fileURLToPath(string) + dirname, the pattern
// csv-export-guard.test.ts documents for this repo's jsdom environment.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Drop `{/* … *\/}`, `/* … *\/` and `// …` so explanatory notes do not trip the guard. */
function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

// Deliberately narrow: it targets the automatic-categorisation claim, not the
// word "AI". ServWave has real AI surfaces (the copilot, the Agentic Farm nav)
// and they must stay sayable.
const FORBIDDEN = /auto-?\s?categoriz|categoriz\w*\s+(?:runs|happens)\s+(?:on|after)/i;

describe('no unbacked automatic-categorisation claims', () => {
  const files = walk(SRC);

  it('scans a realistic number of source files', () => {
    // Guards the guard: a broken walk() that returns nothing would pass silently.
    expect(files.length).toBeGreaterThan(300);
  });

  it('no shipped copy promises that categories are assigned for the user', () => {
    const offenders = files
      .map((file) => ({ file, hit: stripComments(readFileSync(file, 'utf8')).match(FORBIDDEN) }))
      .filter((r) => r.hit)
      .map((r) => `${relative(SRC, r.file)} — ${r.hit![0]}`);

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
