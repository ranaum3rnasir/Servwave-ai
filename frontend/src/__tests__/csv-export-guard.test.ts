import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL('.', import.meta.url)` throws under this repo's jsdom test
// environment (jsdom shadows the global URL constructor, and Node's
// fileURLToPath rejects the resulting non-Node URL instance with "The URL
// must be of scheme file"). Resolve via fileURLToPath(string) + dirname
// instead — the same pattern already proven by csp-pdf-preview.test.ts and
// design-system/__tests__/tokens-guard.test.ts under the same config.
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

// Four exports shipped broken because each hand-rolled its own serialization and
// the backend formats customer names "Last, First". Everything that produces a
// CSV goes through @/lib/csv, which escapes correctly.
describe('CSV exports', () => {
  const files = walk(SRC).map((p) => ({ rel: p.slice(SRC.length + 1), src: readFileSync(p, 'utf8') }));

  it('only lib/csv.ts constructs a CSV Blob', () => {
    const offenders = files
      // Match the `type: 'text/csv'` Blob-options property specifically, not
      // any occurrence of the string "text/csv" — a blind substring match
      // false-positives on unrelated MIME-type checks/attributes, e.g.
      // ImportCSVDialog.tsx's `file.type !== "text/csv"` upload validation
      // and its `accept=".csv,text/csv"` file-input attribute (an inventory
      // CSV *import* feature, never a CSV Blob construction). Verified this
      // still matches `new Blob([...], { type: 'text/csv' })` in lib/csv.ts.
      // Still a universal rule — zero named file-exceptions here.
      .filter((f) => /type:\s*['"]text\/csv/.test(f.src))
      .map((f) => f.rel)
      .filter((rel) => rel !== join('lib', 'csv.ts'));
    expect(offenders).toEqual([]);
  });

  it('every exporter imports the shared writer', () => {
    const offenders = files
      .filter((f) => /function exportCsv|function downloadCsv\b/.test(f.src))
      .filter((f) => !/from ['"]@\/lib\/csv['"]/.test(f.src))
      .map((f) => f.rel)
      // lib/csv.ts defines `exportCsvFile`, which matches the `function
      // exportCsv` detector above (no word-boundary on that alternative) —
      // but it's the shared writer itself and can't import from itself.
      // Sibling of check 1's identical self-exclusion.
      .filter((rel) => rel !== join('lib', 'csv.ts'))
      // CallsView.tsx's `exportCsv` is a UI-only toast stub (onToast(...)) — it
      // never constructs a CSV, uses Blob, or does any file work at all. It's
      // one of several unwired placeholder actions in that component. Verified
      // by inspection (2026-07-19): not a CSV exporter, so there is nothing to
      // migrate onto @/lib/csv. Narrow, named exception — do not broaden.
      .filter((rel) => rel !== join('components', 'communication', 'phone', 'CallsView.tsx'));
    expect(offenders).toEqual([]);
  });
});
