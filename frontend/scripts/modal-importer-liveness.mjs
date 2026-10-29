#!/usr/bin/env node
/* =============================================================================
   Which importers of a component does a route actually render? (mobile slice 53)

   Walks the static import graph (`import ... from`, `import('...')`, `lazy(() => import(...))`)
   from the app's entry points and reports each importer of the target file as LIVE (reachable) or
   dead (no route reaches it; old v1 screens that only tests import). The route table is built with
   `import.meta.glob('./*.routes.tsx')`, so those files are entry points too.

   Usage, from frontend/:
     node scripts/modal-importer-liveness.mjs                       # importers of components/ui/modal.tsx
     node scripts/modal-importer-liveness.mjs components/ui/foo.tsx # any file, path relative to src/

   Test, story and spec files are listed but marked TEST: they are not screens.
   ============================================================================= */
import fs from 'node:fs';
import path from 'node:path';

const src = path.join(process.cwd(), 'src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
  }
})(src);

const SUFFIXES = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'];
function resolveImport(from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(src, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const s of SUFFIXES) if (fs.existsSync(base + s)) return base + s;
  return null;
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;
const deps = new Map();
const importers = new Map();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Set();
  let match;
  while ((match = IMPORT.exec(text))) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) found.add(resolved);
  }
  deps.set(file, found);
  for (const r of found) {
    if (!importers.has(r)) importers.set(r, new Set());
    importers.get(r).add(file);
  }
}

const isTest = (f) => /__tests__|\.test\.|\.stories\.|\.spec\./.test(f);
const entries = [
  path.join(src, 'main.tsx'),
  path.join(src, 'public-main.tsx'),
  ...files.filter((f) => /pages\/v2\/routes\/[^/]+\.(routes|paths)\./.test(f)),
].filter((f) => fs.existsSync(f));

const live = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop();
  if (live.has(file)) continue;
  live.add(file);
  for (const d of deps.get(file) ?? []) queue.push(d);
}

const target = path.join(src, process.argv[2] ?? 'components/ui/modal.tsx');
const list = [...(importers.get(target) ?? [])].sort();
for (const file of list) {
  const via = [...(importers.get(file) ?? [])].filter((f) => !isTest(f)).map((f) => path.relative(src, f));
  console.log(
    live.has(file) ? 'LIVE' : 'dead',
    isTest(file) ? 'TEST' : 'src ',
    path.relative(src, file),
    via.length ? `<= ${via.slice(0, 2).join(', ')}` : '',
  );
}
const screens = list.filter((f) => !isTest(f));
console.log(
  `\n${list.length} importers: ${screens.filter((f) => live.has(f)).length} live, ${screens.filter((f) => !live.has(f)).length} dead, ${list.length - screens.length} test/story`,
);
