/**
 * Mobile slice 61 (PERF-03): the scheduler is the technician's landing page and its first download
 * is the largest paint on a phone. Six dialogs the board mounts once (and drives with `open`) are
 * fetched when first opened instead (`../scheduleDialogs.ts`). This walks the SAME static graph the
 * bundler walks from `SchedulePage.tsx` and names the modules that must stay out of it, so an edit
 * that imports one back (here, or in anything the page imports) fails in a second rather than as a
 * 50 KB surprise on a phone.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../../..');
const PAGE = join(SRC, 'pages/v2/schedule/SchedulePage.tsx');

const LAZY_DIALOGS = [
  'components/jobs/AssignJobDialog.tsx',
  'components/jobs/CancelJobDialog.tsx',
  'pages/v2/schedule/creation/scheduleCreatePopover.tsx',
  'pages/v2/schedule/components/eventEditor.tsx',
  'pages/v2/schedule/components/eventEntryDialog.tsx',
  'pages/v2/schedule/components/unifiedDropModal.tsx',
];

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

function staticGraph(entry: string): Map<string, string | null> {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.tsx?$/.test(file)) continue;
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(STATIC_IMPORT)) {
      const next = resolveSpec(file, m[1] ?? '');
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return parent;
}

function chain(parent: Map<string, string | null>, file: string): string {
  const out: string[] = [];
  for (let f: string | null | undefined = file; f; f = parent.get(f)) out.unshift(relative(SRC, f));
  return out.join(' -> ');
}

describe('the scheduler\'s dialogs are not in its first download', () => {
  const graph = staticGraph(PAGE);

  it('walks a real graph (the page itself and a board module are in it)', () => {
    expect(graph.has(PAGE)).toBe(true);
    expect(graph.has(join(SRC, 'components/schedule/scheduleModel.ts'))).toBe(true);
  });

  it.each(LAZY_DIALOGS)('%s is reached only through a dynamic import()', (rel) => {
    const file = join(SRC, rel);
    expect(existsSync(file), `${rel} moved: update this list`).toBe(true);
    expect(graph.has(file), graph.has(file) ? `statically imported: ${chain(graph, file)}` : '').toBe(false);
  });

  it('each one is still imported lazily by scheduleDialogs.ts (so the list above cannot go stale quietly)', () => {
    const code = readFileSync(join(SRC, 'pages/v2/schedule/scheduleDialogs.ts'), 'utf8');
    for (const spec of [
      '@/components/jobs/AssignJobDialog',
      '@/components/jobs/CancelJobDialog',
      './creation/scheduleCreatePopover',
      './components/eventEditor',
      './components/eventEntryDialog',
      './components/unifiedDropModal',
    ]) {
      expect(code).toContain(`import('${spec}')`);
    }
  });
});
