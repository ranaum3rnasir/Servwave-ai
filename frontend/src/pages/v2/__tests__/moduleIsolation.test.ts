import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const V2 = join(__dirname, '..');

/**
 * A v2 module may not import from another v2 module's folder.
 *
 * The fifteen modules were built in parallel under a rule that forbade editing
 * shared files, which kept every merge clean but left nowhere to put a shared
 * piece. So modules reached into `leads/` instead: at the end of the build, 43
 * import statements across 30 files pointed there, and every one of them came
 * from a module that was not leads. Leads had become a library by accident, and
 * a change to the leads page could have broken Schedule.
 *
 * Those pieces now live in `_shared/`. This keeps them there. Without it the
 * next module to need a tab strip reaches for the nearest one that exists, and
 * the structure quietly rebuilds itself.
 *
 * `_shared/` is the exception by definition, and tests are exempt: a
 * cross-module spec is exactly what should be reading several modules.
 */

const MODULE_DIRS = readdirSync(V2)
  .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
  .filter((name) => statSync(join(V2, name)).isDirectory())
  .filter((name) => name !== '__tests__');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every module name that `code` imports from, other than `self`. */
function foreignModuleImports(code: string, self: string): string[] {
  const hits = new Set<string>();

  for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    // `noUncheckedIndexedAccess` is on, so a capture group is string|undefined
    // even when the pattern guarantees it. Narrow rather than assert.
    const spec = match[1];
    if (!spec) continue;

    // Alias form: @/pages/v2/<module>/...
    const alias = spec.match(/^@\/pages\/v2\/([^/]+)\//);
    // Relative form: ../<module>/... - a sibling, since a module's own files
    // reach each other with './' or stay inside components/.
    const rel = spec.match(/^\.\.\/([^./][^/]*)\//);

    const target = alias?.[1] ?? rel?.[1];
    if (!target) continue;
    if (target === self || target === '_shared' || target === 'routes') continue;
    if (!MODULE_DIRS.includes(target)) continue;

    hits.add(target);
  }

  return [...hits];
}

describe('v2 module isolation', () => {
  it('finds the module directories, so an empty sweep cannot pass vacuously', () => {
    expect(MODULE_DIRS.length).toBeGreaterThan(10);
  });

  it('no module imports from another module - shared code belongs in _shared/', () => {
    const violations: string[] = [];

    for (const moduleName of MODULE_DIRS) {
      for (const file of sourceFiles(join(V2, moduleName))) {
        const foreign = foreignModuleImports(readFileSync(file, 'utf8'), moduleName);
        for (const target of foreign) {
          violations.push(`${relative(V2, file).replace(/\\/g, '/')} imports from ${target}/`);
        }
      }
    }

    expect(
      violations,
      `Move the shared piece into pages/v2/_shared/ instead:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
