/**
 * Mobile slice 31 (Inventory, plans and automations), the two dialog layouts the gate's page
 * states never open:
 *
 *   - the PO and item-group line tables inside dialogs scroll sideways in their own box instead of
 *     being clipped by an `overflow-hidden` wrapper (a phone could not reach the Unit $ / Ext. /
 *     Amount columns at all). Each box carries the `dialog-line-table` marker the mobile gate
 *     accepts (`ui-kit/lib/intendedScrollers.ts`), so a future overlay state measures it as an
 *     intended scroller rather than an offender;
 *   - the stock transfer's From and To pickers stack below `sm` (one column) and sit side by side
 *     with the arrow between them from `sm` up, as before.
 *
 * Static source checks, in the style of the line-item grid guard next to this file: jsdom has no
 * layout, and these dialogs need a full stock fixture to open in the browser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INTENDED_X_SCROLLERS } from '@/ui-kit/lib/intendedScrollers';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The dialogs and how many line tables each renders. */
const LINE_TABLES: Record<string, number> = {
  'components/inventory/AddGroupDialog.tsx': 1,
  'components/inventory/NewPODialog.tsx': 1,
  'components/inventory/PODetailDialog.tsx': 2,
  'components/inventory/GeneratePODialog.tsx': 1,
};

/** The element that directly wraps each `<table` (the last opening `<div ...>` before it). */
function tableWrappers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<table\b/g)) {
    const before = text.slice(0, m.index);
    const open = before.lastIndexOf('<div');
    out.push(before.slice(open, before.indexOf('>', open) + 1));
  }
  return out;
}

describe('mobile slice 31: line tables inside inventory dialogs scroll, never clip', () => {
  it('the gate accepts the dialog line-table marker', () => {
    expect(INTENDED_X_SCROLLERS as readonly string[]).toContain('dialog-line-table');
  });

  for (const [file, count] of Object.entries(LINE_TABLES)) {
    it(`${file}: every line table sits in a sideways scroll box`, () => {
      const wrappers = tableWrappers(read(file));
      expect(wrappers).toHaveLength(count);
      for (const w of wrappers) {
        expect(w, 'the wrapper is the marked scroll box').toContain('DIALOG_LINE_TABLE_SCROLL');
        expect(w, 'the wrapper scrolls sideways').toMatch(/overflow-x-auto/);
        expect(w, 'the wrapper does not clip the table').not.toMatch(/overflow-hidden/);
      }
    });
  }
});

describe('mobile slice 31: the transfer From and To stack below sm', () => {
  const text = read('components/inventory/TransferDialog.tsx');
  const fromTo = text.slice(text.indexOf('{/* From → To */}'), text.indexOf('label="From"'));

  it('one column on a phone, From | arrow | To from sm up', () => {
    expect(fromTo).toMatch(/grid-cols-1\b/);
    expect(fromTo).toMatch(/sm:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
    // No unprefixed three-track template: that is what squeezed both pickers at 320.
    expect(fromTo).not.toMatch(/(?<![a-z]:)grid-cols-\[1fr_auto_1fr\]/);
  });
});
