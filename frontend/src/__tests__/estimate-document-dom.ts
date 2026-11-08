/**
 * Reading a rendered estimate document back OUT of the DOM, the way a customer reads it (#2028
 * slice 3, validation round).
 *
 * Not a test file — vitest collects only files ending `.test.ts` / `.test.tsx`, so this is a plain
 * module the document specs import.
 *
 * The point of these is ARITHMETIC. Asserting that the strings "Subtotal" and "Total" appear
 * proves a label was printed, not that the document adds up: a renderer that printed the right
 * sections with the wrong figures would pass. These scrape the amounts actually on the page so a
 * spec can sum them and compare against the subtotal the document prints, which is the claim the
 * customer reads and the only one worth guarding.
 */

/** `$1,234.56` -> 1234.56. Null for a cell that prints no amount at all. */
export function parseAmount(text: string | null | undefined): number | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  // U+2212 MINUS SIGN is what the totals rows print for a subtraction, not a hyphen.
  const n = Number(trimmed.replace(/−/g, '-').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The section headings the document drew, in order. `[]` when it drew none. */
export function sectionHeadings(root: ParentNode = document.body): string[] {
  return Array.from(root.querySelectorAll('h3')).map((h) => h.textContent ?? '');
}

/**
 * The card each section was drawn into, in document order.
 *
 * Found by the ROW LIST it contains rather than by a heading, because a document with a single
 * section is drawn with no heading over it at all (Ran, 2026-09-13) — anything that located a
 * section by its `h3` would silently read zero sections there and pass a sum of nothing. A
 * section that is narrative alone has no row list and so is not a card here; `sectionHeadings`
 * is what sees that one.
 */
export function sectionRowLists(root: ParentNode = document.body): Element[] {
  return Array.from(root.querySelectorAll('.space-y-3'));
}

/**
 * The amount printed at the right-hand edge of every row card, in document order, across every
 * section that was drawn.
 *
 * A DISCOUNTED row prints its struck-through gross above its net; the net is the last figure in
 * the cell and the one the subtotal contains, so that is what this reads. An UNPRICED scope block
 * prints nothing at all, which is a null here — never a zero, because a zero would claim the work
 * is free and would also quietly satisfy a sum that should have been short.
 */
export function printedRowAmounts(root: ParentNode = document.body): Array<number | null> {
  const amounts: Array<number | null> = [];
  for (const list of sectionRowLists(root)) {
    for (const row of Array.from(list.children)) {
      const cell = row.lastElementChild;
      const figures = cell ? Array.from(cell.querySelectorAll('span')) : [];
      amounts.push(figures.length === 0 ? null : parseAmount(figures[figures.length - 1].textContent));
    }
  }
  return amounts;
}

/**
 * The figure printed beside a totals label — `printedTotal('Subtotal')`, `printedTotal(/^Tax/)`.
 * Null when the document printed no such row, which a spec should treat as a failure rather than
 * as a zero.
 */
export function printedTotal(label: string | RegExp, root: ParentNode = document.body): number | null {
  for (const el of Array.from(root.querySelectorAll('div'))) {
    if (el.children.length !== 2) continue;
    const [labelEl, amountEl] = Array.from(el.children);
    if (labelEl.tagName !== 'SPAN' || amountEl.tagName !== 'SPAN') continue;
    const text = (labelEl.textContent ?? '').trim();
    const hit = typeof label === 'string' ? text === label : label.test(text);
    if (hit) return parseAmount(amountEl.textContent);
  }
  return null;
}

/** Cents-rounded sum, skipping the rows that print no amount. Floats are not money. */
export function sumAmounts(amounts: Array<number | null>): number {
  return Math.round(amounts.reduce<number>((total, a) => total + (a ?? 0), 0) * 100) / 100;
}
