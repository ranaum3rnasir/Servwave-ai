/**
 * ui-kit import purity: nothing under `src/ui-kit/` may import out of the kit.
 *
 * The app may import the kit - many v2 pages do, and `components/form/SelectField`
 * now imports `@/ui-kit/lib/selectThreshold` - but the arrow only points one way.
 * The kit is meant to be liftable out of this app whole; a single `@/components/…`
 * or `@/hooks/…` import inside it quietly ends that, and it ends it invisibly,
 * because such an import type-checks, lints and runs perfectly well.
 *
 * The tree currently has ZERO exceptions, which is the only reason a flat
 * assertion like this one can be written at all. If a genuine exception ever has
 * to be made, it belongs in an explicit allowlist here with a reason - not in a
 * loosened regex.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Static `from`, dynamic `import(…)` and re-`export … from`, single or double
// quoted. Written without a sample specifier in the comment on purpose: this
// file is inside the tree it scans, so an illustrative one would match itself.
const APP_ALIAS_IMPORT = /(?:from|import)\s*\(?\s*['"](@\/[^'"]+)['"]/g;

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

    for (const file of tsFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(APP_ALIAS_IMPORT)) {
        const specifier = match[1]!;
        if (specifier === '@/ui-kit' || specifier.startsWith('@/ui-kit/')) continue;
        offenders.push(`${relative(process.cwd(), file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
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
