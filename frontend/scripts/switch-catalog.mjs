// Generator for the frontend's own copy of the backend permission-switch catalog.
//
// The backend catalog module cannot be imported into the browser build, and the test harness used to read its source
// file from disk at import time in ~940 test files. The harness now reads the committed copy instead
// (src/__tests__/support/switchCatalog.generated.json); one guard test
// (src/__tests__/switch-catalog-copy.test.ts) fails when the copy and the backend source differ.
//
// Regenerate with:  npm --prefix frontend run gen:switch-catalog
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_SOURCE_PATH = join(HERE, '../../backend/src/lib/permissions/switches/catalog.ts');
export const CATALOG_COPY_PATH = join(HERE, '../src/__tests__/support/switchCatalog.generated.json');
export const REGENERATE_COMMAND = 'npm --prefix frontend run gen:switch-catalog';
const ROLE_ORDER = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];

const keyList = (text) => [...(text ?? '').matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
const grantsIn = (block) =>
  [...(/grants: \[([\s\S]*?)\],\n\s+(?:serverChecks|pending|presets)/.exec(block)?.[1] ?? '').matchAll(
    /action: '(\w+)', subject: '(\w+)'/g,
  )].map((m) => ({ action: m[1], subject: m[2] }));

/** The entries the test harness needs from the catalog source: key, label, requirements, grants, role presets. */
export function parseCatalog(source) {
  const out = [];
  for (const block of source.split(/\n {2}entry\(\{/).slice(1)) {
    const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
    const label = /label: '((?:[^'\\]|\\.)*)'/.exec(block)?.[1];
    if (!key || !label) continue;
    const args = /presets: presets\(([^)]*)\)/.exec(block)?.[1];
    const values = args?.split(',').map((v) => v.trim());
    const isToggle = values && values.every((v) => v === 'true' || v === 'false');
    out.push({
      key,
      label: label.replace(/\\'/g, "'"),
      requires: keyList(/\brequires: \[([^\]]*)\]/.exec(block)?.[1]),
      requiresAny: keyList(/\brequiresAny: \[([^\]]*)\]/.exec(block)?.[1]),
      grants: grantsIn(block),
      presets: isToggle ? Object.fromEntries(ROLE_ORDER.map((r, i) => [r, values[i] === 'true'])) : null,
    });
  }
  return out;
}

export const renderCopy = (source) => JSON.stringify(parseCatalog(source), null, 2) + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(CATALOG_COPY_PATH, renderCopy(readFileSync(CATALOG_SOURCE_PATH, 'utf8')));
  console.log(`wrote ${CATALOG_COPY_PATH}`);
}
