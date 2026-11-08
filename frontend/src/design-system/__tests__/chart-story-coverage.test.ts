/* =============================================================================
   Chart story coverage guard - phase 12 chart-stories pass.

   THE GAP THIS CLOSES. `DesignSystemPage` was the only place any of the 10
   chart primitives, `ChartCard` or `KpiTile` rendered anywhere in the app -
   none had a Storybook story, and `.storybook/main.ts` did not even glob
   `components/charts` or `components/data`, so a chart story could not have
   rendered even if one had been written (the exact same shape of bug
   `pattern-story-coverage.test.ts` closed for `components/patterns` one PR
   earlier - re-derived independently while writing these stories, by
   building a real `storybook build` index and finding zero `Charts/*`
   entries in it despite 12 new story files existing on disk). This guard is
   what stops that specific regression from reopening silently.

   WHY THIS IS A SEPARATE FILE FROM pattern-story-coverage.test.ts, RATHER
   THAN A GENERALISATION OF IT. That guard keys coverage on FILENAME - one
   `Foo.tsx` needs one co-located `Foo.stories.tsx` - which holds for every
   pattern. It does NOT hold for `components/charts/Donut.tsx`, which
   exports TWO components (`ProgressDonut`, `SegmentedDonut`) documented by
   two separate, differently-named story files
   (`ProgressDonut.stories.tsx` / `SegmentedDonut.stories.tsx`) rather than a
   single `Donut.stories.tsx`. A filename-keyed check would either invent a
   `Donut.stories.tsx` nobody needs or permanently misreport this directory
   as missing coverage. So this guard keys on the EXPORTED COMPONENT NAME
   instead: it reads every capitalised `export function X` / `export const
   X` out of the real chart source files, reads every story file's own
   `component: X` line in its `meta` object (the canonical "this story
   documents X" declaration), and asserts every export has a story that
   claims it - a check Donut.tsx's one-file-two-components shape satisfies
   naturally, with no special case written for it.

   components/data IS DELIBERATELY NOT GIVEN THE SAME BLANKET, DIRECTORY-WIDE
   TREATMENT. That directory holds many components - KpiTile/KpiStrip is the
   only one this pass gave a story to. A blanket "every export needs a
   story" rule here would immediately fail on every pre-existing gap this PR
   did not touch, which is exactly the kind of scope-widening-by-accident a
   guard should not cause. Coverage for components/data is asserted
   narrowly: KpiTile.stories.tsx exists, and the glob covers the directory
   (so a future KpiTile-shaped addition CAN render once written) - nothing
   stronger is claimed.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHARTS_DIR = resolve(HERE, '..', '..', 'components', 'charts');
const DATA_DIR = resolve(HERE, '..', '..', 'components', 'data');
const STORYBOOK_MAIN = resolve(HERE, '..', '..', '..', '.storybook', 'main.ts');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

const EXPORT_RE = /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)/g;

/**
 * Every capitalised (component-shaped) export out of the real chart source
 * files - excludes `.stories.tsx` and `.test.tsx` themselves, and excludes
 * `chartTheme.ts`, whose exports (`axisTick`, `trackColor`, ...) are all
 * lowercase helpers, not components, so the capitalisation filter already
 * excludes them without needing a name-based exception list.
 */
export function chartComponentExports(dir = CHARTS_DIR): string[] {
  const names = new Set<string>();
  for (const file of listFiles(dir)) {
    if (!file.endsWith('.tsx') || file.endsWith('.stories.tsx') || file.includes('.test.')) continue;
    const src = readFileSync(resolve(dir, file), 'utf8');
    for (const m of src.matchAll(EXPORT_RE)) names.add(m[1]!);
  }
  return [...names].sort();
}

/** Every name a `.stories.tsx` file in `dir` declares as its `meta.component`. */
export function chartStoryComponentNames(dir = CHARTS_DIR): Set<string> {
  const names = new Set<string>();
  const COMPONENT_RE = /component:\s*([A-Z][A-Za-z0-9]*)/g;
  for (const file of listFiles(dir)) {
    if (!file.endsWith('.stories.tsx')) continue;
    const src = readFileSync(resolve(dir, file), 'utf8');
    for (const m of src.matchAll(COMPONENT_RE)) names.add(m[1]!);
  }
  return names;
}

describe('chart story coverage (every chart primitive is discoverable in Storybook)', () => {
  it('resolves to a real, non-empty chart export set', () => {
    // Guards the guard: a rename of components/charts, or a bad path here,
    // would otherwise make this file pass forever by checking nothing.
    expect(chartComponentExports().length).toBeGreaterThan(0);
  });

  it('every exported chart component has a story that declares it as meta.component', () => {
    const declared = chartStoryComponentNames();
    const missing = chartComponentExports().filter((name) => !declared.has(name));
    expect(
      missing,
      `These chart components have no Storybook story, so a designer cannot discover them:\n` +
        missing.map((m) => `  - components/charts (export ${m})`).join('\n'),
    ).toEqual([]);
  });

  it('.storybook/main.ts globs components/charts', () => {
    const main = readFileSync(STORYBOOK_MAIN, 'utf8');
    expect(main).toMatch(/components\/charts\/\*\*\/\*\.stories\./);
  });

  it('KpiTile.stories.tsx exists and .storybook/main.ts globs components/data', () => {
    // Narrow on purpose - see the header note on why this is not a
    // directory-wide rule the way the chart and pattern checks are.
    expect(listFiles(DATA_DIR)).toContain('KpiTile.stories.tsx');
    const main = readFileSync(STORYBOOK_MAIN, 'utf8');
    expect(main).toMatch(/components\/data\/\*\*\/\*\.stories\./);
  });
});
