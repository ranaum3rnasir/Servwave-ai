/**
 * Stack - phase 7d rendered-class contract.
 *
 * Stack is the primitive that makes "give this page more breathing room" a
 * one-file change, so the tests pin two things hard: that the bare default is
 * geometrically inert (wrapping existing markup in a Stack cannot move it),
 * and that every 4px-grid step renders the literal `gap-*` class Tailwind can
 * actually see. A computed `gap-${n}` would type-check, pass a naive test and
 * emit nothing at build time; the exhaustive step assertion below is what
 * catches that.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Stack, type StackGap } from '@/components/ui/stack';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const box = () => screen.getByTestId('stack');

describe('Stack - the bare default is inert', () => {
  it('renders <div class="flex flex-col gap-0"> with no props', () => {
    render(<Stack data-testid="stack">child</Stack>);
    expect(box().tagName).toBe('DIV');
    expect(cls(box())).toBe('flex flex-col gap-0');
  });

  it('emits no alignment class when align and justify are omitted', () => {
    render(<Stack data-testid="stack">child</Stack>);
    expect(cls(box())).not.toMatch(/items-|justify-/);
  });

  it('renders its children', () => {
    render(
      <Stack data-testid="stack">
        <span>a</span>
        <span>b</span>
      </Stack>
    );
    expect(box().children).toHaveLength(2);
  });
});

describe('Stack - gap is the 4px-grid step, not a size word', () => {
  const STEPS: Array<[StackGap, string]> = [
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
      <Stack data-testid="stack" gap={gap}>
        c
      </Stack>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it('gap={0} survives the falsy trap and still emits gap-0', () => {
    render(
      <Stack data-testid="stack" gap={0}>
        c
      </Stack>
    );
    expect(cls(box())).toBe('flex flex-col gap-0');
  });

  it('gap={6} is the 24px step', () => {
    // The step list is Tailwind's own spacing scale, so gap-6 = 1.5rem = 24px.
    render(
      <Stack data-testid="stack" gap={6}>
        c
      </Stack>
    );
    expect(cls(box())).toBe('flex flex-col gap-6');
  });

  it('covers every step with a literal class string, never a computed one', () => {
    const emitted = new Set<string>();
    for (const [gap] of STEPS) {
      const { unmount } = render(
        <Stack data-testid="stack" gap={gap}>
          c
        </Stack>
      );
      for (const c of cls(box()).split(' ')) if (c.startsWith('gap-')) emitted.add(c);
      unmount();
    }
    expect([...emitted].sort()).toEqual(STEPS.map(([, c]) => c).sort());
  });
});

describe('Stack - direction, align, justify, wrap', () => {
  it.each([
    ['vertical', 'flex-col'],
    ['horizontal', 'flex-row'],
  ] as const)('direction=%s renders %s', (direction, expected) => {
    render(
      <Stack data-testid="stack" direction={direction}>
        c
      </Stack>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it.each([
    ['start', 'items-start'],
    ['center', 'items-center'],
    ['end', 'items-end'],
    ['stretch', 'items-stretch'],
    ['baseline', 'items-baseline'],
  ] as const)('align=%s renders %s', (align, expected) => {
    render(
      <Stack data-testid="stack" align={align}>
        c
      </Stack>
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
      <Stack data-testid="stack" justify={justify}>
        c
      </Stack>
    );
    expect(cls(box()).split(' ')).toContain(expected);
  });

  it('wrap renders flex-wrap, and its absence renders nothing', () => {
    const { unmount } = render(
      <Stack data-testid="stack" wrap>
        c
      </Stack>
    );
    expect(cls(box()).split(' ')).toContain('flex-wrap');
    unmount();
    render(
      <Stack data-testid="stack" wrap={false}>
        c
      </Stack>
    );
    expect(cls(box())).not.toMatch(/flex-wrap/);
  });
});

describe('Stack - reproduces the tracer pages\' own rows', () => {
  it('matches InvoicesPage.tsx:525, the applied-filter chip row', () => {
    // <div className="flex items-center gap-2 flex-wrap">
    render(
      <Stack data-testid="stack" direction="horizontal" align="center" gap={2} wrap>
        c
      </Stack>
    );
    expect(cls(box()).split(' ').sort()).toEqual(
      'flex flex-row flex-wrap gap-2 items-center'.split(' ').sort()
    );
  });

  it('matches InvoiceDetailPage.tsx:778, the invoice action toolbar', () => {
    // <div className="flex items-center flex-wrap justify-end gap-2">
    render(
      <Stack data-testid="stack" direction="horizontal" align="center" justify="end" gap={2} wrap>
        c
      </Stack>
    );
    expect(cls(box()).split(' ').sort()).toEqual(
      'flex flex-row flex-wrap gap-2 items-center justify-end'.split(' ').sort()
    );
  });

  it('matches InvoicesPage.tsx:479, the page column', () => {
    // <div className="space-y-6"> - a block column with 24px between children.
    // Stack renders it as a flex column, which is the documented conversion
    // caveat: identical for ordinary full-width children, worth a look where
    // the old container leaned on block layout.
    render(
      <Stack data-testid="stack" gap={6}>
        c
      </Stack>
    );
    expect(cls(box())).toBe('flex flex-col gap-6');
  });
});

describe('Stack - hygiene', () => {
  it('every class it can emit is a stock Tailwind layout key', () => {
    const emitted = new Set<string>();
    for (const direction of ['vertical', 'horizontal'] as const) {
      for (const wrap of [true, false]) {
        for (const align of ['start', 'center', 'end', 'stretch', 'baseline'] as const) {
          for (const justify of ['start', 'center', 'end', 'between', 'around', 'evenly'] as const) {
            const { unmount } = render(
              <Stack
                data-testid="stack"
                direction={direction}
                wrap={wrap}
                align={align}
                justify={justify}
                gap={2}
              >
                c
              </Stack>
            );
            for (const c of cls(box()).split(' ')) emitted.add(c);
            unmount();
          }
        }
      }
    }
    expect([...emitted].sort()).toEqual([
      'flex',
      'flex-col',
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
      <Stack data-testid="stack" gap={2} className="gap-8">
        c
      </Stack>
    );
    const rendered = cls(box()).split(' ');
    expect(rendered).toContain('gap-8');
    expect(rendered).not.toContain('gap-2');
  });

  it('forwards a ref to the div', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <Stack ref={ref} data-testid="stack">
        c
      </Stack>
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('passes through arbitrary div attributes', () => {
    render(
      <Stack data-testid="stack" role="group" aria-label="filters">
        c
      </Stack>
    );
    expect(box().getAttribute('aria-label')).toBe('filters');
  });
});
