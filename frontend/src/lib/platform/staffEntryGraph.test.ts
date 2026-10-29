/**
 * Mobile slice 61 (PRD module 7, PERF-01): what the staff entry may import STATICALLY.
 *
 * `src/main.tsx` is the staff app's entry. Everything it imports with a plain `import` ships in the
 * first download, on a phone, before the first paint; only `import()` / `lazy()` is deferred. The
 * staff layout (`V2AppLayout`) is the hub: a single import there once pulled the whole softphone
 * workspace, the call-control SDK wrapper, the inventory API with its mock data and the date
 * picker into the entry, for a header button that only opens a new tab. This test walks the same
 * static graph the bundler walks and names the modules that must stay out of it, so a later edit
 * that drags one back in fails here in a second rather than as a 100 KB surprise in the build
 * (the build also enforces the byte budget: scripts/check-public-bundle-budget.mjs).
 *
 * The copilot is deliberately NOT listed: it is out of scope for the programme and stays as it is.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// `import x from 'y'`, `import 'y'`, `export * from 'y'`, `export { a } from 'y'`; never `import type`,
// never `import('y')` (that is the lazy form).
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

/** Which of our files imports each package, for the files the entry reaches (filled by staticGraph). */
const packageUsers = new Map<string, Set<string>>();

/** Every module the entry reaches through static imports, with who imported it first. */
function staticGraph(entry: string): Map<string, string | null> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.tsx?$/.test(file)) continue;
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(STATIC_IMPORT)) {
      const spec = m[1] ?? '';
      const next = resolveSpec(file, spec);
      if (!spec.startsWith('.') && !spec.startsWith('@/')) {
        if (!packageUsers.has(spec)) packageUsers.set(spec, new Set());
        packageUsers.get(spec)!.add(relative(SRC, file));
      }
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return parent;
}

function chainTo(parent: Map<string, string | null>, file: string): string {
  const chain: string[] = [];
  for (let c: string | null | undefined = file; c; c = parent.get(c)) chain.push(relative(SRC, c));
  return chain.reverse().join(' -> ');
}

const graph = staticGraph(join(SRC, 'main.tsx'));
const reached = (needle: string) => [...graph.keys()].filter((f) => relative(SRC, f).includes(needle));

describe('the staff entry graph', () => {
  it('finds the staff layout through the walk (the walker works)', () => {
    expect(reached('pages/v2/V2AppLayout.tsx')).toHaveLength(1);
  });

  // Each of these is opened on demand (a button, a route), so none belongs in the first download.
  it.each([
    ['the softphone workspace (the header dialer button is its own tiny module)', 'communication/phone/Dialer.tsx'],
    ['the softphone itself', 'communication/phone/Softphone.tsx'],
    ['the call-control SDK wrapper', 'lib/communication/ctmSoftphone.ts'],
    ['the inventory API and its mock data', 'lib/api/inventory.ts'],
    ['the date picker', 'ui-kit/components/form/dateField.tsx'],
    ['the agent catalog modal (opened from a sidebar button)', 'components/ai-center/AiCenterModal.tsx'],
    ['the agent catalog data', 'lib/ai-center/agents.ts'],
  ])('does not statically import %s', (_what, needle) => {
    const hits = reached(needle);
    expect(hits.map((h) => chainTo(graph, h))).toEqual([]);
  });

  // Packages that are heavy for what the first screen needs of them. Each has a lazy home already.
  it.each([
    ['date-fns (the formatter and the English locale tables; the two helpers that used it are plain Date code now)', 'date-fns'],
    ['the Radix toast (every toast goes through the one toaster; its action is read as a label and a handler)', '@radix-ui/react-toast'],
    ['the table engine (only the lazy list pages use it; about 138 KB of source with its core)', '@tanstack/react-table'],
    ['the virtual-list engine (only the lazy pages with long lists use it)', '@tanstack/react-virtual'],
  ])('does not statically import %s', (_what, pkg) => {
    expect([...(packageUsers.get(pkg) ?? [])]).toEqual([]);
  });
});
