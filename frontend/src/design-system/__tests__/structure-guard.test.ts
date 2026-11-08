/* =============================================================================
   ServWave component library — structure guard (regression fence)
   -----------------------------------------------------------------------------
   Phase 7.3 of the shared-component-library refactor. Asserts two invariants
   that must hold forever after the consolidation:

     1. components/common and components/shared stay deleted. Phase 1 folded
        their contents into the top-level buckets (ui/form/data/crm/layout/
        charts/filters/brand); nothing should ever recreate a catch-all dir.

     2. No file becomes a "shim" - a file whose entire body is just import/
        re-export statements that reach into a DIFFERENT top-level bucket
        under src/components/. Cross-bucket shims are exactly the pattern the
        refactor removed: a component living in one bucket but re-exported
        from another so old import paths keep working. If that pattern comes
        back, callers should update their import instead of a new shim
        papering over it.

   A file that reaches into the SAME bucket (e.g. a barrel-style
   `components/ui/index.ts`) is fine and not flagged.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-root-relative anchor: this file lives at
// frontend/src/design-system/__tests__/, so frontend/src is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const COMPONENTS = join(SRC, 'components');
const BUCKETS = ['ui', 'form', 'data', 'crm', 'layout', 'charts', 'filters', 'brand'];

/** Recursively list .ts/.tsx files under a dir, skipping tests/__tests__. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === '__tests__') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    if (/\.(test|spec)\.(ts|tsx)$/.test(p)) return [];
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

describe('component library structure guard', () => {
  it('components/common and components/shared no longer exist (I1)', () => {
    expect(existsSync(join(COMPONENTS, 'common'))).toBe(false);
    expect(existsSync(join(COMPONENTS, 'shared'))).toBe(false);
  });

  it('no file re-exports a component from a different top-level bucket (no shim files)', () => {
    const offenders: string[] = [];
    for (const bucket of BUCKETS) {
      const dir = join(COMPONENTS, bucket);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const code = readFileSync(file, 'utf8');
        const body = code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .trim();
        const nonEmptyLines = body
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const isShimLike =
          nonEmptyLines.length > 0 &&
          nonEmptyLines.every((l) =>
            /^(import\s.+from\s+['"].+['"];?|export\s+\{[^}]*\}\s+from\s+['"].+['"];?|export\s+\*\s+from\s+['"].+['"];?)$/.test(
              l,
            ),
          );
        if (!isShimLike) continue;
        const fromMatches = [...body.matchAll(/from\s+['"](.+?)['"]/g)]
          .map((m) => m[1])
          .filter((spec): spec is string => spec !== undefined);
        for (const spec of fromMatches) {
          if (!spec.startsWith('.') && !spec.startsWith('@/components/')) continue;
          const resolved = spec.startsWith('@/components/')
            ? join(SRC, spec.replace('@/', ''))
            : resolve(dirname(file), spec);
          const relFromComponents = relative(COMPONENTS, resolved);
          const targetBucket = relFromComponents.split('/')[0] ?? '';
          if (BUCKETS.includes(targetBucket) && targetBucket !== bucket) {
            offenders.push(
              `${relative(SRC, file)} shims ${spec} (bucket '${bucket}' re-exporting from '${targetBucket}')`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
