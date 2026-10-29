/* =============================================================================
   Pattern story coverage guard - phase 12.

   THE GAP THIS CLOSES. Phase 10 built the composition layer
   (`components/patterns/`) and phase 11.6 replaced DetailPageShell with
   TabStrip - and through all of it, not one of the five patterns had a
   Storybook story, while `.storybook/main.ts` globbed only
   `components/ui/**` so nothing under patterns/ would have been picked up
   even if a story had been written. The whole layer a designer is supposed
   to compose pages from was undiscoverable in the one tool built for
   discovering it. That is corollary 2 of the program's own end goal
   ("if a variant exists in code but not in Storybook, the designer cannot
   discover it, so it does not exist") failing silently, with nothing
   watching.

   WHY THIS IS A SEPARATE FILE FROM storybook-completeness.test.ts. That
   guard answers a DIFFERENT question - "does every cva variant VALUE have a
   story that renders it" - and it is scoped to `components/ui` because it
   walks cva() blocks and `Record<Key, string>` class lookups. The patterns
   have neither: they author no classes at all, they forward props to
   primitives. Pointing that parser at this directory would find nothing to
   check and report a comfortable green. The question worth asking about a
   pattern is the cruder one this file asks - does a story FILE exist at all,
   and is the directory actually wired into Storybook's glob.

   TWO ASSERTIONS, AND THE SECOND ONE IS THE ONE THAT WOULD HAVE CAUGHT THE
   ORIGINAL BUG. A per-file story check alone would still pass in a world
   where every story exists but `main.ts` does not glob the directory - the
   files would sit on disk, fully written, and render nowhere. So the glob
   itself is asserted too.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATTERNS_DIR = resolve(HERE, '..', '..', 'components', 'patterns');
const STORYBOOK_MAIN = resolve(HERE, '..', '..', '..', '.storybook', 'main.ts');

/**
 * Every shipped pattern component: a `.tsx` directly under
 * components/patterns, excluding story files themselves. Enumerated from
 * disk rather than hand-listed - a hand-maintained list would drift the
 * moment someone adds a pattern, which is precisely the failure mode.
 */
export function patternComponents(dir = PATTERNS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.tsx'))
    .filter((name) => !name.endsWith('.stories.tsx'))
    .filter((name) => !name.includes('.test.'))
    .sort();
}

/** The co-located story files present on disk. */
export function patternStories(dir = PATTERNS_DIR): Set<string> {
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.stories.tsx')),
  );
}

describe('pattern story coverage (every composition pattern is discoverable in Storybook)', () => {
  it('resolves to a real, non-empty pattern set', () => {
    // Guards the guard: a rename of components/patterns, or a bad path here,
    // would otherwise make this file pass forever by checking nothing.
    expect(patternComponents().length).toBeGreaterThan(0);
  });

  it('every pattern component has a co-located .stories.tsx', () => {
    const stories = patternStories();
    const missing = patternComponents().filter(
      (name) => !stories.has(name.replace(/\.tsx$/, '.stories.tsx')),
    );
    expect(
      missing,
      `These patterns have no Storybook story, so a designer cannot discover them:\n` +
        missing.map((m) => `  - components/patterns/${m}`).join('\n'),
    ).toEqual([]);
  });

  it('.storybook/main.ts globs components/patterns', () => {
    // A story file that exists but is not globbed renders nowhere. This is
    // the assertion that would have caught the original defect: during
    // phases 10 and 11.6 the glob covered components/ui only, by an explicit
    // comment, so patterns could never have appeared regardless.
    const main = readFileSync(STORYBOOK_MAIN, 'utf8');
    expect(main).toMatch(/components\/patterns\/\*\*\/\*\.stories\./);
  });
});
