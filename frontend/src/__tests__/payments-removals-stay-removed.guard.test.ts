/* =============================================================================
   V7 sweep: things the payments build removed must not come back.

   Plain-text reads of the shipped sources (no regex literals, so the unresolved-class guard does not mistake them for
   class names). Each check names the V7 decision behind it.
   - "Mark settled" is gone from the payments screens: a person marks an item resolved, with a reason (the stored
     SETTLED value for an old failed-refund row stays in the backend only).
   - "Record anyway" (the overpayment tick-box) is gone: a hand-recorded payment can never exceed the balance.
   - The Contact customer action opens Call / Text / Email; it no longer sends an email from a confirm dialog.
   - There is no Retry on a failed bank payment (the customer pays again from their link). A data-load Retry
     (LoadError) is a different, allowed control.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

function shipped(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      shipped(full, out);
    } else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.includes('.test.') && !entry.name.includes('.stories.')) {
      out.push(full);
    }
  }
  return out;
}

const paymentSources = [
  ...shipped(path.join(SRC, 'pages/v2/payments')),
  path.join(SRC, 'lib/api/paymentsPage.ts'),
  path.join(SRC, 'components/invoices/RecordPaymentDialog.tsx'),
];

/** Source files whose text contains `needle` (case-insensitive), as paths relative to src. */
function containing(files: string[], needle: string): string[] {
  const n = needle.toLowerCase();
  return files.filter((f) => fs.readFileSync(f, 'utf8').toLowerCase().includes(n)).map((f) => path.relative(SRC, f));
}

describe('V7 removals stay removed (frontend)', () => {
  it('scans the payments screens', () => {
    expect(paymentSources.length).toBeGreaterThan(30);
  });

  it('no "Mark settled" / "Marked settled" copy and no mark_settled action id', () => {
    expect(containing(paymentSources, 'mark settled')).toEqual([]);
    expect(containing(paymentSources, 'marked settled')).toEqual([]);
    expect(containing(paymentSources, 'mark_settled')).toEqual([]);
  });

  it('no "Record anyway" overpayment tick-box or its state', () => {
    expect(containing(paymentSources, 'record anyway')).toEqual([]);
    expect(containing(paymentSources, 'overpayacknowledged')).toEqual([]);
  });

  it('the attention actions no longer send an email from a confirm dialog', () => {
    const file = path.join(SRC, 'pages/v2/payments/components/attentionActions.tsx');
    expect(containing([file], 'send email')).toEqual([]);
    expect(containing([file], 'email sent')).toEqual([]);
  });

  it('no payment-retry copy on a failed bank payment', () => {
    for (const phrase of ['retry payment', 'retry the payment', 'retry bank payment', 'try the payment again', 'retry charge', 'retry this payment']) {
      expect(containing(paymentSources, phrase)).toEqual([]);
    }
  });
});
