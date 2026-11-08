/**
 * Separator - rendered-class contract.
 *
 * Separator had no test file before phase 7. The first block below was written
 * and run GREEN against the untouched component, before a single line of the
 * dashed branch existed, so it is a real frozen baseline rather than a
 * description of whatever the code happens to do now.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Separator } from '@/components/ui/separator';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const rule = () => screen.getByTestId('sep');

// check-unresolved-classes.mjs tokenises raw source TEXT, so a bare utility
// STEM written as a string literal reads to it as a real class that resolves
// to no CSS, and it fails the suite on a false positive. Splitting the hyphen
// out is the idiom the guard's own source documents at
// component-api-guard.test.ts:169-178. The first draft of this file hit it.
const H = '-';
const FILL_STEM = 'bg' + H;

describe('Separator - the shipped strings, frozen', () => {
  it('horizontal, propless, renders the exact string it shipped with', () => {
    render(<Separator data-testid="sep" />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-[1px] w-full');
  });

  it('vertical renders the exact string it shipped with', () => {
    render(<Separator data-testid="sep" orientation="vertical" />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-full w-[1px]');
  });

  it('horizontal, decorative explicitly true, is the same string', () => {
    render(<Separator data-testid="sep" orientation="horizontal" decorative />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-[1px] w-full');
  });

  it('horizontal, decorative false, is the same string', () => {
    render(<Separator data-testid="sep" orientation="horizontal" decorative={false} />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-[1px] w-full');
  });

  it('vertical, decorative false, is the same string', () => {
    render(<Separator data-testid="sep" orientation="vertical" decorative={false} />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-full w-[1px]');
  });

  it('reproduces every live call site verbatim', () => {
    // The seven sites on the branch tip, transcribed:
    //   settings/StaffSection.tsx:53        <Separator />
    //   layout/Header.tsx:143               orientation vertical + mx-2 h-6
    //   layout/Header.tsx:220,224           orientation vertical + mx-2 hidden h-6 sm:block
    //   data/data-table.tsx:210             my-2
    //   pages/CustomerDetailPage.tsx:997    my-5
    //   pages/CustomerDetailPage.tsx:1254   <Separator />
    const cases: Array<[React.ReactElement, string]> = [
      [<Separator data-testid="sep" />, 'shrink-0 bg-border h-[1px] w-full'],
      [
        <Separator data-testid="sep" orientation="vertical" className="mx-2 h-6" />,
        'shrink-0 bg-border w-[1px] mx-2 h-6',
      ],
      [
        <Separator
          data-testid="sep"
          orientation="vertical"
          className="mx-2 hidden h-6 sm:block"
        />,
        'shrink-0 bg-border w-[1px] mx-2 hidden h-6 sm:block',
      ],
      [
        <Separator data-testid="sep" className="my-2" />,
        'shrink-0 bg-border h-[1px] w-full my-2',
      ],
      [
        <Separator data-testid="sep" className="my-5" />,
        'shrink-0 bg-border h-[1px] w-full my-5',
      ],
    ];
    for (const [element, expected] of cases) {
      const { unmount } = render(element);
      expect(cls(rule())).toBe(expected);
      unmount();
    }
  });
});

describe('Separator - aria, unchanged by phase 7', () => {
  it('decorative defaults to true, so the rule stays out of the a11y tree', () => {
    render(<Separator data-testid="sep" />);
    expect(rule().getAttribute('role')).toBe('none');
    expect(rule().getAttribute('aria-orientation')).toBeNull();
  });

  it('decorative false publishes a separator role', () => {
    render(<Separator data-testid="sep" decorative={false} />);
    expect(rule().getAttribute('role')).toBe('separator');
  });

  it('decorative false, vertical, publishes the orientation', () => {
    render(<Separator data-testid="sep" orientation="vertical" decorative={false} />);
    expect(rule().getAttribute('aria-orientation')).toBe('vertical');
  });

  it('the dashed rule is decorative by default too', () => {
    render(<Separator data-testid="sep" variant="dashed" tone="danger" />);
    expect(rule().getAttribute('role')).toBe('none');
  });
});

describe('Separator - variant is the drawing mode, and solid never moves', () => {
  it('variant="solid" stated explicitly is byte-identical to propless', () => {
    const { unmount } = render(<Separator data-testid="sep" />);
    const bare = cls(rule());
    unmount();
    render(<Separator data-testid="sep" variant="solid" />);
    expect(cls(rule())).toBe(bare);
  });

  it('a tone passed alongside solid is inert, not a second fill', () => {
    // tone applies on the border drawn branch only. Asserting the exact
    // shipped string here is what stops a future edit from wiring tone into
    // the fill path and quietly restyling seven call sites.
    render(<Separator data-testid="sep" tone="danger" />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-[1px] w-full');
  });

  it('a tone passed alongside solid vertical is inert too', () => {
    render(<Separator data-testid="sep" orientation="vertical" tone="danger" />);
    expect(cls(rule())).toBe('shrink-0 bg-border h-full w-[1px]');
  });

  it('the solid branch never emits a border class', () => {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      for (const tone of ['default', 'danger'] as const) {
        const { unmount } = render(
          <Separator data-testid="sep" orientation={orientation} tone={tone} />
        );
        expect(cls(rule()).split(' ')).not.toContain('border-dashed');
        expect(cls(rule()).split(' ').some((c) => c.startsWith('border'))).toBe(false);
        unmount();
      }
    }
  });
});

describe('Separator - the dashed branch', () => {
  it('horizontal dashed, default tone, is border drawn with no fill', () => {
    render(<Separator data-testid="sep" variant="dashed" />);
    expect(cls(rule())).toBe('shrink-0 border-t border-dashed border-border w-full');
  });

  it('horizontal dashed, danger tone, matches the two ledger sites', () => {
    render(<Separator data-testid="sep" variant="dashed" tone="danger" />);
    expect(cls(rule())).toBe('shrink-0 border-t border-dashed border-danger-border w-full');
  });

  it('vertical dashed, default tone, draws on the left edge', () => {
    render(<Separator data-testid="sep" variant="dashed" orientation="vertical" />);
    expect(cls(rule())).toBe('shrink-0 border-l border-dashed border-border h-full');
  });

  it('vertical dashed, danger tone, draws on the left edge', () => {
    render(
      <Separator data-testid="sep" variant="dashed" orientation="vertical" tone="danger" />
    );
    expect(cls(rule())).toBe('shrink-0 border-l border-dashed border-danger-border h-full');
  });

  it('THE TRAP: a dashed rule carries no 1px sizing utility on its own axis', () => {
    // A border drawn rule already occupies 1px. Keeping the fill path's height
    // utility would stack a 1px box under a 1px border and render a 2px rule.
    // Same argument on the other axis for the width utility.
    const { unmount } = render(<Separator data-testid="sep" variant="dashed" />);
    expect(cls(rule())).not.toMatch(/h-\[1px\]/);
    expect(cls(rule()).split(' ')).toContain('w-full');
    unmount();
    render(<Separator data-testid="sep" variant="dashed" orientation="vertical" />);
    expect(cls(rule())).not.toMatch(/w-\[1px\]/);
    expect(cls(rule()).split(' ')).toContain('h-full');
  });

  it('THE OTHER HALF OF THE TRAP: a dashed rule carries no background fill', () => {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      for (const tone of ['default', 'danger'] as const) {
        const { unmount } = render(
          <Separator
            data-testid="sep"
            variant="dashed"
            orientation={orientation}
            tone={tone}
          />
        );
        expect(cls(rule()).split(' ')).not.toContain('bg-border');
        expect(cls(rule()).split(' ').some((c) => c.startsWith(FILL_STEM))).toBe(false);
        unmount();
      }
    }
  });
});

describe('Separator - reproduces the ledger Refunds rule', () => {
  it('matches InvoiceDetailPage, either side of the Refunds label', () => {
    // Today: <div className="flex-1 border-t border-dashed border-danger-border" />
    // After: flex-1 stays at the call site because it is layout, and the three
    // appearance classes come from the primitive.
    render(<Separator data-testid="sep" variant="dashed" tone="danger" className="flex-1" />);
    const emitted = cls(rule()).split(' ');
    for (const required of ['border-t', 'border-dashed', 'border-danger-border', 'flex-1']) {
      expect(emitted).toContain(required);
    }
    // The call site's flex basis is what sizes the rule, so the primitive's
    // own cross-axis span is present but inert. Both survive twMerge because
    // they are different utility families.
    expect(emitted).toContain('w-full');
    expect(emitted).not.toContain('bg-border');
  });
});

describe('Separator - hygiene', () => {
  it('variant and tone never reach the DOM', () => {
    render(<Separator data-testid="sep" variant="dashed" tone="danger" />);
    expect(rule().getAttribute('variant')).toBeNull();
    expect(rule().getAttribute('tone')).toBeNull();
  });

  it('emits no arbitrary bracket value it did not already ship', () => {
    // The two 1px sizing utilities are pre-existing and live on the solid
    // branch only. The dashed branch must add none.
    for (const orientation of ['horizontal', 'vertical'] as const) {
      for (const tone of ['default', 'danger'] as const) {
        const { unmount } = render(
          <Separator
            data-testid="sep"
            variant="dashed"
            orientation={orientation}
            tone={tone}
          />
        );
        for (const c of cls(rule()).split(' ')) {
          expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
        }
        unmount();
      }
    }
  });

  it('a call site className still wins over the primitive class', () => {
    render(<Separator data-testid="sep" variant="dashed" tone="danger" className="border-border" />);
    const emitted = cls(rule()).split(' ');
    expect(emitted).toContain('border-border');
    expect(emitted).not.toContain('border-danger-border');
  });

  it('forwards a ref', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(<Separator ref={ref} data-testid="sep" variant="dashed" />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it('passes through arbitrary attributes', () => {
    render(<Separator data-testid="sep" variant="dashed" id="refund-rule" />);
    expect(rule().getAttribute('id')).toBe('refund-rule');
  });
});
