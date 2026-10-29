/**
 * Table cluster - phase 7 rendered-class contract.
 *
 * WHAT THIS FILE IS DEFENDING. 504 Button, 236 Input and 190 Label call sites
 * are not the only shipped output this session must not move: Table, TableRow,
 * TableHead and TableCell are live at 6 / 18 / 32 / 36 tags today, and this
 * edit adds seven axes to them. So the first block below freezes every default
 * as a BYTE-FOR-BYTE string, copied once from the file as it stood at the
 * branch base commit f5a8b182c and never restated anywhere else. A propless
 * render of each export must equal its frozen string exactly. Class order is
 * part of the assertion on purpose: it is the cheapest possible proof that the
 * new axes slot in without disturbing what was there.
 *
 * THE SECOND BLOCK reconstructs the two tracer tables out of props and requires
 * the result to be the EXACT SET the page ships today, derived by subtraction
 * from the literal page strings rather than hand-copied. Every token the page
 * currently writes is accounted for: it is either emitted by the primitive, or
 * it is named in an explicit "moves elsewhere" list with the reason. If a
 * primitive ever paints one class more or one class fewer than the shipped
 * markup, a subtraction stops balancing and this file fails.
 *
 * WHAT IT DELIBERATELY DOES NOT PIN. No arity assertions on the variant maps.
 * The Table cluster is expected to grow more header signatures and more row
 * tones - the app-wide raw-table population is 2,647 appearance tokens across
 * 46 files - and an arity check would turn every additive rung into a failure.
 * A rung that goes MISSING still fails, which is the direction that matters.
 *
 * WHAT IT CANNOT PROVE. Three claims in table.tsx are about the browser, not
 * about strings, and only the visual gate can settle them: that a header row's
 * inherited typography renders the same when it is moved onto each header cell,
 * that the shipped both-axis scroll wrapper differs from a horizontal-only one,
 * and that a body-drawn rule and a section-drawn one do not both paint. This
 * file pins the class strings those claims are made of, which is what makes a
 * visual diff interpretable when it appears.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';

const cls = (el: Element) => el.getAttribute('class') ?? '';
const set = (s: string) => s.split(' ').filter(Boolean).sort();

/** Render a fragment inside a real table so the DOM nesting is legal. */
function inTable(children: React.ReactNode) {
  return render(<table>{children}</table>);
}

/**
 * The class string of the one probed element in a FRESH render.
 *
 * Scoped to that render's own container, not to the document: a helper called
 * several times inside one `it` leaves every earlier tree mounted, and a
 * document-wide query then matches all of them at once.
 */
function probe(children: React.ReactNode): string {
  const { container } = render(<table>{children}</table>);
  return container.querySelector('[data-testid="x"]')?.getAttribute('class') ?? '';
}

/* =============================================================================
   BLOCK 1 - the frozen defaults.

   Verbatim from components/data/table.tsx at f5a8b182c. Nothing else in this
   file is allowed to restate them.
   ========================================================================== */

const SHIPPED = {
  table: 'w-full caption-bottom text-sm',
  wrapper: 'relative w-full overflow-auto',
  header: '[&_tr]:border-b [&_tr]:border-border',
  body: '[&_tr:last-child]:border-0',
  footer: 'border-t border-border bg-background-light font-medium [&>tr]:last:border-b-0',
  row: 'border-b border-border transition-colors data-[state=selected]:bg-background-light',
  head: 'h-10 px-4 text-left align-middle text-[10.5px] font-bold uppercase tracking-wide text-text-secondary [&:has([role=checkbox])]:pr-0',
  cell: 'p-4 text-sm align-middle [&:has([role=checkbox])]:pr-0',
  caption: 'mt-4 text-sm text-text-secondary',
} as const;

describe('Table cluster - shipped defaults are byte-identical', () => {
  it('Table emits the shipped table string inside the shipped wrapper', () => {
    const { container } = render(<Table data-testid="t" />);
    const table = screen.getByTestId('t');
    expect(cls(table)).toBe(SHIPPED.table);
    expect(cls(container.firstElementChild!)).toBe(SHIPPED.wrapper);
    expect(container.firstElementChild!.tagName).toBe('DIV');
  });

  it('TableHeader is untouched', () => {
    inTable(<TableHeader data-testid="x" />);
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.header);
  });

  it('TableBody default adds nothing', () => {
    inTable(<TableBody data-testid="x" />);
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.body);
  });

  it('TableFooter default adds nothing', () => {
    inTable(<TableFooter data-testid="x" />);
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.footer);
  });

  it('TableRow default adds nothing', () => {
    inTable(
      <tbody>
        <TableRow data-testid="x" />
      </tbody>,
    );
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.row);
  });

  it('TableHead default adds nothing, padding included', () => {
    inTable(
      <thead>
        <tr>
          <TableHead data-testid="x" />
        </tr>
      </thead>,
    );
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.head);
  });

  it('TableCell default adds nothing, padding included', () => {
    inTable(
      <tbody>
        <tr>
          <TableCell data-testid="x" />
        </tr>
      </tbody>,
    );
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.cell);
  });

  it('TableCaption is untouched', () => {
    inTable(<TableCaption data-testid="x" />);
    expect(cls(screen.getByTestId('x'))).toBe(SHIPPED.caption);
  });

  it('the two pre-existing TableCell axes still emit exactly what they did', () => {
    inTable(
      <tbody>
        <tr>
          <TableCell data-testid="a" tone="muted" />
          <TableCell data-testid="b" tone="highlight" />
          <TableCell data-testid="c" align="right" weight="medium" divider />
        </tr>
      </tbody>,
    );
    expect(cls(screen.getByTestId('a'))).toBe(`${SHIPPED.cell} text-text-secondary`);
    expect(cls(screen.getByTestId('b'))).toBe(`${SHIPPED.cell} text-danger font-medium`);
    expect(cls(screen.getByTestId('c'))).toBe(
      `${SHIPPED.cell} text-right font-medium border-r border-r-border last:border-r-0`,
    );
  });
});

/* =============================================================================
   BLOCK 2 - the new axes, each asserted as a DELTA on its frozen default.
   ========================================================================== */

describe('Table wrapper axis', () => {
  it('wrapper="x" scrolls one axis only and is not the shipped wrapper', () => {
    const { container } = render(<Table wrapper="x" data-testid="t" />);
    expect(cls(container.firstElementChild!)).toBe('overflow-x-auto');
    // The point of the axis: the shipped wrapper also clips vertically.
    expect(cls(container.firstElementChild!)).not.toBe(SHIPPED.wrapper);
    expect(cls(screen.getByTestId('t'))).toBe(SHIPPED.table);
  });

  it('wrapper="none" renders the bare table with no element around it', () => {
    const { container } = render(<Table wrapper="none" data-testid="t" />);
    expect(container.firstElementChild!.tagName).toBe('TABLE');
    expect(container.querySelector('div')).toBeNull();
    expect(cls(screen.getByTestId('t'))).toBe(SHIPPED.table);
  });
});

describe('TableBody divider axis', () => {
  it('hairline adds the half-strength section rules and keeps the shipped rule', () => {
    inTable(<TableBody data-testid="x" divider="hairline" />);
    expect(cls(screen.getByTestId('x'))).toBe(`${SHIPPED.body} divide-y divide-border/50`);
  });
});

describe('TableFooter variant axis', () => {
  it('bare paints nothing at all', () => {
    inTable(<TableFooter data-testid="x" variant="bare" />);
    expect(cls(screen.getByTestId('x'))).toBe('');
  });
});

describe('TableRow axes', () => {
  const row = (props: Record<string, unknown>) =>
    probe(
      <tbody>
        <TableRow data-testid="x" {...props} />
      </tbody>,
    );

  it('divider="none" removes the row-drawn rule and nothing else', () => {
    expect(row({ divider: 'none' })).toBe(
      'transition-colors data-[state=selected]:bg-background-light',
    );
  });

  it('tone, muted and interactive are each purely additive', () => {
    expect(row({ tone: 'danger' })).toBe(`${SHIPPED.row} bg-danger-surface/40`);
    expect(row({ muted: true })).toBe(`${SHIPPED.row} opacity-60`);
    expect(row({ interactive: true })).toBe(`${SHIPPED.row} hover:bg-background-light/30`);
  });

  it('an unset boolean emits nothing, so a bare row stays bare', () => {
    expect(row({ muted: false, interactive: false, tone: 'default' })).toBe(SHIPPED.row);
  });
});

describe('TableHead variants', () => {
  const head = (props: Record<string, unknown>) =>
    probe(
      <thead>
        <tr>
          <TableHead data-testid="x" {...props} />
        </tr>
      </thead>,
    );

  it('plain is the 14px medium-weight signature, with no height and no letter casing change', () => {
    const s = set(head({ variant: 'plain' }));
    expect(s).toEqual(set('py-2 font-medium text-left text-text-secondary'));
    expect(s).not.toContain('h-10');
    expect(s).not.toContain('uppercase');
    expect(s).not.toContain('font-bold');
  });

  it('compact is the 12px tracked signature, bottom padding only', () => {
    const s = set(head({ variant: 'compact' }));
    expect(s).toEqual(set('pb-2 text-left text-xs uppercase tracking-wide text-text-secondary'));
    expect(s).not.toContain('h-10');
    expect(s).not.toContain('font-bold');
  });

  it('align="right" replaces the variant alignment rather than sitting beside it', () => {
    for (const variant of ['default', 'plain', 'compact'] as const) {
      const s = set(head({ variant, align: 'right' }));
      expect(s).toContain('text-right');
      expect(s).not.toContain('text-left');
    }
  });

  it('a caller padding prop REPLACES the variant default, it does not merge with it', () => {
    // compact pads the bottom. Asking for a right pad as well must be spelled
    // out in full, and must not silently keep a side the caller did not name.
    expect(set(head({ variant: 'compact', padRight: 3 }))).toContain('pr-3');
    expect(set(head({ variant: 'compact', padRight: 3 }))).not.toContain('pb-2');
    expect(set(head({ variant: 'compact', padBottom: 2, padRight: 3 }))).toEqual(
      set('pb-2 pr-3 text-left text-xs uppercase tracking-wide text-text-secondary'),
    );
  });

  it('className still passes through', () => {
    expect(set(head({ className: 'whitespace-nowrap' }))).toContain('whitespace-nowrap');
  });
});

describe('TableCell new axes', () => {
  const cell = (props: Record<string, unknown>) =>
    probe(
      <tbody>
        <tr>
          <TableCell data-testid="x" {...props} />
        </tr>
      </tbody>,
    );

  it('scale="xs" replaces the table body size and adds nothing', () => {
    const s = set(cell({ scale: 'xs' }));
    expect(s).toContain('text-xs');
    expect(s).not.toContain('text-sm');
  });

  it('weight="semibold" is additive and the pre-existing rungs are unmoved', () => {
    expect(cell({ weight: 'semibold' })).toBe(`${SHIPPED.cell} font-semibold`);
    expect(cell({ weight: 'medium' })).toBe(`${SHIPPED.cell} font-medium`);
    expect(cell({ weight: 'normal' })).toBe(SHIPPED.cell);
  });

  it('a caller padding prop REPLACES the shipped uniform padding', () => {
    // The ledger pads three sides and leaves the fourth at the user-agent
    // value. A merge would re-add a left pad the page never wrote.
    const s = set(cell({ padY: 2.5, padRight: 3 }));
    expect(s).toContain('pt-2.5');
    expect(s).toContain('pb-2.5');
    expect(s).toContain('pr-3');
    expect(s).not.toContain('p-4');
    expect(s).not.toContain('pl-4');
    expect(s).not.toContain('pl-0');
  });

  it('a single-side pad names that side and no other', () => {
    const s = set(cell({ padTop: 3 }));
    expect(s).toContain('pt-3');
    for (const other of ['p-4', 'pr-0', 'pb-0', 'pl-0', 'pr-3', 'pb-3', 'pl-3']) {
      expect(s).not.toContain(other);
    }
  });
});

/* =============================================================================
   BLOCK 3 - the two tracer tables, reconstructed and balanced by subtraction.
   ========================================================================== */

describe('InvoicesPage "to be invoiced" dialog table reconstructs exactly', () => {
  // Verbatim from pages/InvoicesPage.tsx at f5a8b182c.
  const PAGE_TABLE = 'w-full text-sm';
  const PAGE_HEAD_ROW = 'border-b border-border text-left text-text-secondary';
  const PAGE_HEAD = 'py-2 font-medium';
  const PAGE_ROW = 'border-b border-border last:border-0';
  const PAGE_CELL = 'py-2';

  it('the table has no wrapper and keeps every class it ships', () => {
    const { container } = render(<Table wrapper="none" data-testid="t" />);
    expect(container.querySelector('div')).toBeNull();
    // caption-bottom is the one class the primitive adds. It is inert with no
    // caption element, which is the whole reason this table can adopt it.
    const added = set(cls(screen.getByTestId('t'))).filter((c) => !set(PAGE_TABLE).includes(c));
    expect(added).toEqual(['caption-bottom']);
  });

  it('the header row typography lands on the cells, the rule stays on the section', () => {
    render(
      <Table wrapper="none">
        <TableHeader data-testid="thead">
          <TableRow data-testid="tr">
            <TableHead data-testid="th" variant="plain" />
          </TableRow>
        </TableHeader>
      </Table>,
    );
    // Everything the page writes on its header ROW, split by where it goes.
    const rowRule = ['border-b', 'border-border'];
    const inherited = ['text-left', 'text-text-secondary'];
    expect(set(PAGE_HEAD_ROW)).toEqual([...rowRule, ...inherited].sort());
    // The rule is drawn twice over, once by the section and once by the row -
    // same token, same pixels, which is what makes the swap safe.
    for (const c of rowRule) expect(set(cls(screen.getByTestId('tr')))).toContain(c);
    expect(cls(screen.getByTestId('thead'))).toBe(SHIPPED.header);
    // The inherited half is now on the cell, together with the cell's own two.
    expect(set(cls(screen.getByTestId('th')))).toEqual(
      [...inherited, ...set(PAGE_HEAD)].sort(),
    );
  });

  it('the body row and its cells emit exactly what the page ships', () => {
    render(
      <Table wrapper="none">
        <TableBody data-testid="tbody">
          <TableRow data-testid="tr">
            <TableCell data-testid="td" padY={2} />
          </TableRow>
        </TableBody>
      </Table>,
    );
    // The page's `last:border-0` and the section's last-child rule are the same
    // rule written in two places; both zero the last row's border.
    expect(cls(screen.getByTestId('tbody'))).toBe(SHIPPED.body);
    const rowAdded = set(cls(screen.getByTestId('tr'))).filter(
      (c) => !set(PAGE_ROW).includes(c) && c !== 'last:border-0',
    );
    expect(rowAdded).toEqual(['data-[state=selected]:bg-background-light', 'transition-colors']);
    const cellAdded = set(cls(screen.getByTestId('td'))).filter(
      (c) => !set(PAGE_CELL).includes(c),
    );
    // text-sm the table already inherits, align-middle is the table-cell
    // default, and the checkbox rule is inert without a checkbox.
    expect(cellAdded).toEqual(
      ['[&:has([role=checkbox])]:pr-0', 'align-middle', 'text-sm'].sort(),
    );
  });
});

describe('InvoiceDetailPage payments ledger reconstructs exactly', () => {
  // Verbatim from pages/InvoiceDetailPage.tsx at f5a8b182c.
  const PAGE_WRAPPER = 'overflow-x-auto';
  const PAGE_TABLE = 'w-full text-sm';
  const PAGE_HEAD_ROW = 'border-b text-left text-xs uppercase tracking-wide text-text-secondary';
  const PAGE_HEAD = 'pb-2 pr-3';
  const PAGE_HEAD_LAST = 'pb-2';
  const PAGE_BODY = 'divide-y divide-border/50';
  const PAGE_ROW_HOVER = 'hover:bg-background-light/30';
  const PAGE_ROW_REFUND = 'bg-danger-surface/40';
  const PAGE_ROW_VOIDED = 'opacity-60';
  const PAGE_CELL = 'py-2.5 pr-3';
  const PAGE_FOOT_CELL = 'pt-3 text-xs text-text-secondary text-right';

  it('the wrapper scrolls horizontally only, as the page does', () => {
    const { container } = render(<Table wrapper="x" data-testid="t" />);
    expect(cls(container.firstElementChild!)).toBe(PAGE_WRAPPER);
    const added = set(cls(screen.getByTestId('t'))).filter((c) => !set(PAGE_TABLE).includes(c));
    expect(added).toEqual(['caption-bottom']);
  });

  it('the header row typography lands on the cells; the bare rule is the same token', () => {
    render(
      <Table wrapper="x">
        <TableHeader data-testid="thead">
          <TableRow>
            <TableHead data-testid="th" variant="compact" padBottom={2} padRight={3} />
            <TableHead data-testid="amount" variant="compact" padBottom={2} padRight={3} align="right" />
            <TableHead data-testid="last" variant="compact" padBottom={2} />
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const inherited = ['text-left', 'text-xs', 'uppercase', 'tracking-wide', 'text-text-secondary'];
    expect(set(PAGE_HEAD_ROW)).toEqual([...inherited, 'border-b'].sort());
    // The page writes the rule with no colour token, so it takes preflight's
    // inherited border colour. Both that and the `border` colour key resolve to
    // the same custom property, so naming it here is the same pixels.
    expect(set(cls(screen.getByTestId('thead')))).toEqual(set(SHIPPED.header));

    expect(set(cls(screen.getByTestId('th')))).toEqual([...inherited, ...set(PAGE_HEAD)].sort());
    expect(set(cls(screen.getByTestId('last')))).toEqual(
      [...inherited, ...set(PAGE_HEAD_LAST)].sort(),
    );
    // The right-aligned Amount header: alignment swapped, nothing else moved.
    const amount = set(cls(screen.getByTestId('amount')));
    expect(amount).toEqual(
      [...inherited.filter((c) => c !== 'text-left'), 'text-right', ...set(PAGE_HEAD)].sort(),
    );
  });

  it('the section draws the rules and the rows draw none, so no hairline doubles up', () => {
    render(
      <Table wrapper="x">
        <TableBody data-testid="tbody" divider="hairline">
          <TableRow data-testid="plain" divider="none" interactive />
          <TableRow data-testid="refund" divider="none" interactive tone="danger" />
          <TableRow data-testid="voided" divider="none" interactive muted className="line-through" />
        </TableBody>
      </Table>,
    );
    const body = set(cls(screen.getByTestId('tbody')));
    expect(body).toContain('divide-y');
    expect(body).toContain('divide-border/50');
    expect(set(PAGE_BODY).every((c) => body.includes(c))).toBe(true);

    for (const id of ['plain', 'refund', 'voided']) {
      const row = set(cls(screen.getByTestId(id)));
      // The single fact this axis exists for.
      expect(row).not.toContain('border-b');
      expect(row).toContain(PAGE_ROW_HOVER);
    }
    expect(set(cls(screen.getByTestId('refund')))).toContain(PAGE_ROW_REFUND);
    expect(set(cls(screen.getByTestId('voided')))).toContain(PAGE_ROW_VOIDED);
    // line-through is not an appearance token by the guard's classifier, so it
    // stays a className rather than earning an axis of its own.
    expect(set(cls(screen.getByTestId('voided')))).toContain('line-through');
  });

  it('a body cell emits the page pad plus only inert additions', () => {
    render(
      <Table wrapper="x">
        <TableBody>
          <TableRow divider="none">
            <TableCell data-testid="td" padY={2.5} padRight={3} />
          </TableRow>
        </TableBody>
      </Table>,
    );
    const s = set(cls(screen.getByTestId('td')));
    // The page's two-sided shorthand expands to the two named sides.
    expect(s).toContain('pt-2.5');
    expect(s).toContain('pb-2.5');
    expect(s).toContain('pr-3');
    const nonPad = s.filter((c) => !c.startsWith('pt-') && !c.startsWith('pb-') && !c.startsWith('pr-'));
    expect(nonPad).toEqual(['[&:has([role=checkbox])]:pr-0', 'align-middle', 'text-sm'].sort());
    // The left side is never named, so the user-agent value survives. A step-0
    // class there would be a rendered change, not a no-op.
    expect(s.some((c) => c.startsWith('pl-') || c === 'p-4' || c.startsWith('px-'))).toBe(false);
    // Sanity: the page's own string carries no left pad either.
    expect(set(PAGE_CELL).some((c) => c.startsWith('pl-') || c.startsWith('px-'))).toBe(false);
  });

  it('the bare footer and its summary cell reconstruct exactly', () => {
    render(
      <Table wrapper="x">
        <TableFooter data-testid="tfoot" variant="bare">
          <tr>
            <TableCell data-testid="td" padTop={3} scale="xs" tone="muted" align="right" />
          </tr>
        </TableFooter>
      </Table>,
    );
    // The page's tfoot carries no className at all.
    expect(cls(screen.getByTestId('tfoot'))).toBe('');
    const s = set(cls(screen.getByTestId('td')));
    const added = s.filter((c) => !set(PAGE_FOOT_CELL).includes(c));
    expect(added).toEqual(['[&:has([role=checkbox])]:pr-0', 'align-middle'].sort());
    // And nothing the page writes went missing.
    expect(set(PAGE_FOOT_CELL).every((c) => s.includes(c))).toBe(true);
  });
});

/* =============================================================================
   BLOCK 4 - the whole 6c cell grid, not a sample of it.

   Phase 6c turned align, weight and divider into props so three call sites
   could stop drawing them by hand, and TableCell has been ratcheted at its
   floor ever since. That means every future adoption of a cell has to go
   through this grid, and until now three of its 36 combinations were pinned
   and 33 were not. A combination nobody asserts is a combination phase 7 can
   move without anything noticing.

   The expectation is COMPOSED from the frozen fragments in the same slot order
   the component writes them, rather than stored as 36 literals, so the
   composition order is itself one testable claim instead of 36 opportunities
   to transcribe a string wrong. The fragments come from f5a8b182c; only the
   ORDER is a claim about the current file.

   THE ONE DOCUMENTED MERGE. tone="highlight" and weight="medium" both ask for
   the same font weight. tailwind-merge keeps the LAST of two same-group tokens
   and drops the earlier one, so the token survives at the weight slot and
   disappears from the tone slot. That is a rendered no-op and the only place
   in the grid where the output is not a plain concatenation.
   ========================================================================== */

type GridTone = 'default' | 'muted' | 'highlight';
type GridAlign = 'left' | 'center' | 'right';
type GridWeight = 'normal' | 'medium';

/** Verbatim from components/data/table.tsx at f5a8b182c. */
const GRID_TONE: Record<GridTone, string> = {
  default: '',
  muted: 'text-text-secondary',
  highlight: 'text-danger font-medium',
};
const GRID_ALIGN: Record<GridAlign, string> = {
  left: '',
  center: 'text-center',
  right: 'text-right',
};
const GRID_WEIGHT: Record<GridWeight, string> = {
  normal: '',
  medium: 'font-medium',
};
const GRID_DIVIDER = 'border-r border-r-border last:border-r-0';

const GRID_TONES: GridTone[] = ['default', 'muted', 'highlight'];
const GRID_ALIGNS: GridAlign[] = ['left', 'center', 'right'];
const GRID_WEIGHTS: GridWeight[] = ['normal', 'medium'];

/** Slot order: base, tone, align, weight, divider. */
function composeCell(
  tone: GridTone,
  align: GridAlign,
  weight: GridWeight,
  divider: boolean,
): string {
  const weightStr = GRID_WEIGHT[weight];
  const toneStr =
    weightStr !== '' && GRID_TONE[tone].split(' ').includes(weightStr)
      ? GRID_TONE[tone]
          .split(' ')
          .filter((t) => t !== weightStr)
          .join(' ')
      : GRID_TONE[tone];
  return [SHIPPED.cell, toneStr, GRID_ALIGN[align], weightStr, divider ? GRID_DIVIDER : '']
    .filter((s) => s !== '')
    .join(' ');
}

describe('TableCell - the full tone x align x weight x divider grid', () => {
  it('all 36 combinations are byte-identical to the frozen composition', () => {
    for (const tone of GRID_TONES) {
      for (const align of GRID_ALIGNS) {
        for (const weight of GRID_WEIGHTS) {
          for (const divider of [false, true]) {
            const label = [tone, align, weight, String(divider)].join('/');
            const emitted = probe(
              <tbody>
                <tr>
                  <TableCell
                    data-testid="x"
                    tone={tone}
                    align={align}
                    weight={weight}
                    divider={divider}
                  />
                </tr>
              </tbody>,
            );
            // The label rides along so a failure names the combination.
            expect(`${label} ${emitted}`).toBe(`${label} ${composeCell(tone, align, weight, divider)}`);
          }
        }
      }
    }
  });

  it('the sweep really was 36 combinations', () => {
    expect(GRID_TONES.length * GRID_ALIGNS.length * GRID_WEIGHTS.length * 2).toBe(36);
  });

  it('scale="sm" is the default rung and changes nothing', () => {
    expect(
      probe(
        <tbody>
          <tr>
            <TableCell data-testid="x" scale="sm" />
          </tr>
        </tbody>,
      ),
    ).toBe(SHIPPED.cell);
  });

  it('every step the spacing vocabulary publishes is reachable on a cell', () => {
    const H = '-';
    const steps = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12] as const;
    for (const step of steps) {
      const emitted = set(
        probe(
          <tbody>
            <tr>
              <TableCell data-testid="x" padTop={step} />
            </tr>
          </tbody>,
        ),
      );
      expect(emitted).toContain('pt' + H + String(step));
    }
  });
});

/* =============================================================================
   BLOCK 5 - negative space.

   Block 1 already proves each default equals its frozen string, which implies
   everything below. These assertions are still worth their lines: they name
   the four specific things this phase added and state, in the language of the
   axis rather than the language of a string, that a caller who asks for none
   of them gets none of them. When a future rung breaks one, the failure says
   which behaviour leaked instead of printing two long strings to diff.

   The concatenated prefixes are the documented workaround for
   check-unresolved-classes.mjs, which reads raw source text and cannot tell a
   matcher from a className (component-api-guard.test.ts:169-178).
   ========================================================================== */

describe('negative space - a propless element gains nothing', () => {
  const H = '-';

  it('a propless TableRow gains no hover state, no fill and no dimming', () => {
    const emitted = set(
      probe(
        <tbody>
          <TableRow data-testid="x" />
        </tbody>,
      ),
    );
    expect(emitted.filter((c) => c.startsWith('hover:'))).toEqual([]);
    expect(emitted.filter((c) => c.startsWith('opacity' + H))).toEqual([]);
    // The only fill on a bare row is the selected-state one that has always
    // been there, and it needs a data attribute nothing sets by default.
    expect(emitted.filter((c) => c.startsWith('bg' + H))).toEqual([]);
    expect(emitted.filter((c) => c.includes('bg' + H))).toEqual([
      'data-[state=selected]:bg-background-light',
    ]);
  });

  it('a propless TableFooter still carries its rule, its fill and its weight', () => {
    const emitted = set(probe(<TableFooter data-testid="x" />));
    expect(emitted).toContain('border-t');
    expect(emitted).toContain('border-border');
    expect(emitted).toContain('bg-background-light');
    expect(emitted).toContain('font-medium');
  });

  it('a propless TableBody draws no rules of its own', () => {
    const emitted = set(probe(<TableBody data-testid="x" />));
    expect(emitted.filter((c) => c.startsWith('divide' + H))).toEqual([]);
  });

  it('a propless TableHead keeps the whole shipped header treatment', () => {
    const emitted = set(
      probe(
        <thead>
          <tr>
            <TableHead data-testid="x" />
          </tr>
        </thead>,
      ),
    );
    for (const c of ['h-10', 'px-4', 'font-bold', 'uppercase', 'tracking-wide']) {
      expect(emitted).toContain(c);
    }
  });
});

/* =============================================================================
   BLOCK 6 - the tokens the cluster CANNOT retire, recorded rather than left
   silent.

   Two colours on the two tracer pages have no owner in TableCell's tone axis,
   and TableCell is ratcheted at its floor so a className is not a route
   either. Neither can be dropped without a claim about what colour the cell
   inherits, which is a claim only the visual gate can settle. Pinning them
   here means the gap fails loudly if someone later assumes it closed.
   ========================================================================== */

describe('unowned colours - recorded gaps in the tone axis', () => {
  const H = '-';
  const anyTextColour = new RegExp('^text' + H + '(?![0-9])');

  it('no tone emits the primary text colour, which InvoicesPage:653 ships', () => {
    for (const tone of GRID_TONES) {
      const emitted = set(
        probe(
          <tbody>
            <tr>
              <TableCell data-testid="x" tone={tone} />
            </tr>
          </tbody>,
        ),
      );
      expect(emitted).not.toContain('text-text-primary');
    }
  });

  it('tone="default" paints no colour at all, so a bare cell inherits', () => {
    const emitted = set(
      probe(
        <tbody>
          <tr>
            <TableCell data-testid="x" tone="default" />
          </tr>
        </tbody>,
      ),
    );
    expect(emitted.filter((c) => anyTextColour.test(c) && c !== 'text-sm')).toEqual([]);
  });

  it('highlight is the danger colour at fill strength, not the two status text ones', () => {
    // InvoiceDetailPage:1110 paints its amount cell in the success or the
    // danger TEXT colour. Those are separate tokens with different channel
    // values from the one highlight emits, so highlight is not a substitute.
    const emitted = set(
      probe(
        <tbody>
          <tr>
            <TableCell data-testid="x" tone="highlight" />
          </tr>
        </tbody>,
      ),
    );
    expect(emitted).toContain('text-danger');
    expect(emitted).not.toContain('text-danger-text');
    expect(emitted).not.toContain('text-success-text');
  });
});
