/* =============================================================================
   V7 sweep: things the payments build removed must not come back (backend).

   - No code writes an OVERPAYMENT_FLAGGED timeline row: an invoice can no longer be overpaid by a hand-recorded
     payment. Rows written before V7 still exist in the database; if a reader of them is ever added, list its file in
     READERS below with the reason.
   - "Mark settled" / "Marked settled" are not words the payments API or the alerts say. (The stored SETTLED value for
     an old failed-refund resolution stays; it is worded as "Marked resolved".)
   - No notification or email says to retry a bank payment; the customer pays again from the link they were sent.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

function shipped(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'scripts') continue;
      shipped(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Files allowed to mention OVERPAYMENT_FLAGGED (readers of old rows), each with the reason. Empty today. */
const READERS: Array<{ file: string; reason: string }> = [];

const all = shipped(SRC);
const containing = (files: string[], needle: string): string[] =>
  files.filter((f) => fs.readFileSync(f, 'utf8').toLowerCase().includes(needle.toLowerCase())).map((f) => path.relative(SRC, f));

describe('V7 removals stay removed (backend)', () => {
  it('scans a real set of files', () => {
    expect(all.length).toBeGreaterThan(150);
  });

  it('nothing writes OVERPAYMENT_FLAGGED', () => {
    const allowed = new Set(READERS.map((r) => r.file));
    expect(containing(all, 'OVERPAYMENT_FLAGGED').filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('the payments API and alerts never say "Mark settled" or "Marked settled"', () => {
    const files = all.filter((f) => {
      const rel = path.relative(SRC, f);
      return rel.startsWith('services/payment-attention/') || rel.includes('payments-attention') || rel.includes('payment-attention')
        || rel === 'services/notifications/templates.ts' || rel === 'lib/email.ts';
    });
    expect(files.length).toBeGreaterThan(5);
    expect(containing(files, 'mark settled')).toEqual([]);
    expect(containing(files, 'marked settled')).toEqual([]);
    expect(containing(files, "'mark_settled'")).toEqual([]);
  });

  it('no notification or email tells the office to retry a bank payment', () => {
    const files = all.filter((f) => ['services/notifications/templates.ts', 'lib/email.ts', 'lib/bank-payment-failed-text.ts'].includes(path.relative(SRC, f)));
    expect(files.length).toBe(3);
    for (const phrase of ['retry payment', 'retry the payment', 'retry bank payment', 'retry this payment']) {
      expect(containing(files, phrase)).toEqual([]);
    }
  });
});

describe('V7 copy typography (backend)', () => {
  it('attach refusals write contractions with the curly apostrophe', () => {
    // Not the shared bank-payment sentence (lib/bank-payment-failed-text.ts): the customer email and the compose prefill
    // keep its straight apostrophe on purpose, and both must read the same.
    for (const rel of ['services/payment-attention/attach.ts']) {
      const offenders = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
        .filter(({ line }) => /[A-Za-z]n't\b/.test(line) && /['"`][^'"`]*[A-Za-z]n't[^'"`]*['"`]/.test(line.replace(/\\'/g, '')))
        .map(({ n }) => `${rel}:${n}`);
      expect(offenders).toEqual([]);
    }
  });
});
