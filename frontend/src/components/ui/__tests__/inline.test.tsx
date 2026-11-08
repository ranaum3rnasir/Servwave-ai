/**
 * Inline - phase 9 rendered-class contract.
 *
 * Inline is Stack's horizontal-axis twin (see inline.tsx's header), so these
 * tests pin the same two things stack.test.tsx pins: the bare default is
 * geometrically inert, and every 4px-grid step renders the literal `gap-*`
 * class Tailwind can actually see. A computed `gap-${n}` would type-check,
 * pass a naive test and emit nothing at build time; the exhaustive step
 * assertion below is what catches that.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Inline, type InlineGap } from '@/components/ui/inline';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const box = () => screen.getByTestId('inline');

describe('Inline - the bare default is inert', () => {
  it('renders <div class="flex flex-row gap-0"> with no props', () => {
    render(<Inline data-testid="inline">child</Inline>);
    expect(box().tagName).toBe('DIV');
    expect(cls(box())).toBe('flex flex-row gap-0');
  });

  it('emits no alignment class when align and justify are omitted', () => {
    render(<Inline data-testid="inline">child</Inline>);
    expect(cls(box())).not.toMatch(/items-|justify-/);
  });

  it('renders its children', () => {
    render(
      <Inline data-testid="inline">
        <span>a</span>
        <span>b</span>
      </Inline>
    );
    expect(box().children).toHaveLength(2);
  });
});

describe('Inline - gap is the same 4px-grid step Stack uses, not a size word', () => {
  const STEPS: Array<[InlineGap, string]> = [
    [0, 'gap-0'],
    [0.5, 'gap-0.5'],
    [1, 'gap-1'],
    [1.5, 'gap-1.5'],
    [2, 'gap-2'],
    [2.5, 'gap-2.5'],
    [3, 'gap-3'],
    [4, 'gap-4'],
    [5, 'gap-5'],
    [6, 'gap-6'],
    [8, 'gap-8'],
    [12, 'gap-12'],
  ];

  it.each(STEPS)('gap={%s} renders %s', (gap, expected) => {
    render(
      <Inline data-testid="inline" gap={gap}>
        c
      </Inline>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it('gap={0} survives the falsy trap and still emits gap-0', () => {
    render(
      <Inline data-testid="inline" gap={0}>
        c
      </Inline>
    );
    expect(cls(box())).toBe('flex flex-row gap-0');
  });

  it('gap={6} is the 24px step', () => {
    render(
      <Inline data-testid="inline" gap={6}>
        c
      </Inline>
    );
    expect(cls(box())).toBe('flex flex-row gap-6');
  });

  it('covers every step with a literal class string, never a computed one', () => {
    const emitted = new Set<string>();
    for (const [gap] of STEPS) {
      const { unmount } = render(
        <Inline data-testid="inline" gap={gap}>
          c
        </Inline>
      );
      for (const c of cls(box()).split(' ')) if (c.startsWith('gap-')) emitted.add(c);
      unmount();
    }
    expect([...emitted].sort()).toEqual(STEPS.map(([, c]) => c).sort());
  });
});

describe('Inline - align, justify, wrap', () => {
  it('has no direction prop - it is always a row', () => {
    render(<Inline data-testid="inline">c</Inline>);
    expect(cls(box()).split(' ')).toContain('flex-row');
    expect(cls(box()).split(' ')).not.toContain('flex-col');
  });

  it.each([
    ['start', 'items-start'],
    ['center', 'items-center'],
    ['end', 'items-end'],
    ['stretch', 'items-stretch'],
    ['baseline', 'items-baseline'],
  ] as const)('align=%s renders %s', (align, expected) => {
    render(
      <Inline data-testid="inline" align={align}>
        c
      </Inline>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it.each([
    ['start', 'justify-start'],
    ['center', 'justify-center'],
    ['end', 'justify-end'],
    ['between', 'justify-between'],
    ['around', 'justify-around'],
    ['evenly', 'justify-evenly'],
  ] as const)('justify=%s renders %s', (justify, expected) => {
    render(
      <Inline data-testid="inline" justify={justify}>
        c
      </Inline>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it('wrap renders flex-wrap, and its absence renders nothing', () => {
    const { unmount } = render(
      <Inline data-testid="inline" wrap>
        c
      </Inline>
    );
    expect(cls(box()).split(' ')).toContain('flex-wrap');
    unmount();
    render(
      <Inline data-testid="inline" wrap={false}>
        c
      </Inline>
    );
    expect(cls(box())).not.toMatch(/flex-wrap/);
  });
});

describe('Inline - reproduces real call-site rows (verified against the live tree, not carried forward from stack.tsx unchecked)', () => {
  // The citations this file originally copied from stack.tsx -
  // InvoicesPage.tsx:525 and InvoiceDetailPage.tsx:778 - do not exist:
  // neither file contains `flex-wrap` anywhere. The shapes below are real,
  // confirmed sites for the same row types.

  it('matches EstimatesPage.tsx:539 / JobsPage.tsx:442 / CustomersPage.tsx:549, the applied-filter chip row', () => {
    // <div className="flex items-center gap-2 flex-wrap"> wrapping <AppliedChips>
    render(
      <Inline data-testid="inline" align="center" gap={2} wrap>
        c
      </Inline>
    );
    expect(cls(box()).split(' ').sort()).toEqual(
      'flex flex-row flex-wrap gap-2 items-center'.split(' ').sort()
    );
  });

  it('matches JobDetailPage.tsx:1044, the "Right: action cluster" toolbar', () => {
    // <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
    // (shrink-0 is a call-site utility layered on via className, not part of
    // what Inline itself renders, so it is not asserted here.)
    render(
      <Inline data-testid="inline" align="center" justify="end" gap={2} wrap>
        c
      </Inline>
    );
    expect(cls(box()).split(' ').sort()).toEqual(
      'flex flex-row flex-wrap gap-2 items-center justify-end'.split(' ').sort()
    );
  });
});

describe('Inline - hygiene', () => {
  it('every class it can emit is a stock Tailwind layout key', () => {
    const emitted = new Set<string>();
    for (const wrap of [true, false]) {
      for (const align of ['start', 'center', 'end', 'stretch', 'baseline'] as const) {
        for (const justify of ['start', 'center', 'end', 'between', 'around', 'evenly'] as const) {
          const { unmount } = render(
            <Inline data-testid="inline" wrap={wrap} align={align} justify={justify} gap={2}>
              c
            </Inline>
          );
          for (const c of cls(box()).split(' ')) emitted.add(c);
          unmount();
        }
      }
    }
    expect([...emitted].sort()).toEqual([
      'flex',
      'flex-row',
      'flex-wrap',
      'gap-2',
      'items-baseline',
      'items-center',
      'items-end',
      'items-start',
      'items-stretch',
      'justify-around',
      'justify-between',
      'justify-center',
      'justify-end',
      'justify-evenly',
      'justify-start',
    ]);
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
    }
  });

  it('a call site className wins over the variant class', () => {
    render(
      <Inline data-testid="inline" gap={2} className="gap-8">
        c
      </Inline>
    );
    const rendered = cls(box()).split(' ');
    expect(rendered).toContain('gap-8');
    expect(rendered).not.toContain('gap-2');
  });

  it('forwards a ref to the div', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <Inline ref={ref} data-testid="inline">
        c
      </Inline>
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('passes through arbitrary div attributes', () => {
    render(
      <Inline data-testid="inline" role="group" aria-label="filters">
        c
      </Inline>
    );
    expect(box().getAttribute('aria-label')).toBe('filters');
  });
});
