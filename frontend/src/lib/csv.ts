// The one CSV writer for the whole app. RFC-4180: any field containing a comma,
// double quote, CR or LF is wrapped in quotes, and embedded quotes are doubled.
//
// Exists because thirteen call sites each hand-rolled their own serialization and
// four shipped broken exports — the backend formats customer names "Last, First",
// so an unescaped join silently splits every row. Do not build a CSV Blob anywhere
// else; src/__tests__/csv-export-guard.test.ts enforces this.

/** Escape one field. null/undefined render as an empty field, not "null". */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Ordered header + row matrix → RFC-4180 text. The header is escaped too. */
export function toCSVRows(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n');
}

/** Array-of-objects → CSV. Headers are the union of all keys, in first-seen order. */
export function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Array.from(
    rows.reduce<Set<string>>((acc, r) => {
      Object.keys(r).forEach((k) => acc.add(k));
      return acc;
    }, new Set()),
  );
  return toCSVRows(headers, rows.map((row) => headers.map((h) => row[h])));
}

/** Trigger a browser download. The BOM makes Excel read the file as UTF-8, which
 *  keeps the "—" placeholder and non-ASCII customer names from mojibaking. */
export function downloadCSV(csv: string, filename: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build + download in one call. This is what every export uses. */
export function exportCsvFile(
  filename: string,
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
) {
  downloadCSV(toCSVRows(header, rows), filename);
}
