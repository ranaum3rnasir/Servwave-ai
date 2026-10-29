/**
 * Skeleton - rendered-class contract (phase 8f).
 *
 * Skeleton had no test file before this pass. It carries no `size` prop:
 * VOCAB_V3's six-rung absolute-px ladder (24-44px) does not fit Skeleton's
 * measured call-site heights (12/16/32/64px, three of the four outside that
 * range - see skeleton.tsx's own header comment), so height stays fully
 * caller-owned via `className`, exactly as it was before this pass. `shape`
 * already defaulted to 'block' before this session (a plain JS destructuring
 * default on the function signature); this session's cva conversion moved
 * that default into cva's `defaultVariants`, and the rendered output is
 * byte-identical either way - the baseline below pins that unchanged
 * behaviour.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton } from '@/components/ui/skeleton';

/** Renders a Skeleton and returns the class attribute the DOM actually receives. */
function renderedClass(props: Record<string, unknown> = {}): string {
  const { container, unmount } = render(<Skeleton {...props} />);
  const cls = (container.firstElementChild as HTMLElement).className;
  unmount();
  return cls;
}

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

describe('Skeleton - baseline (shape default)', () => {
  it('a propless render emits only the base + default-shape classes, no height class', () => {
    const got = tokens(renderedClass());
    expect(got).toEqual(['animate-pulse', 'bg-background-light', 'rounded-card']);
    expect(got).not.toContain('h-3');
    expect(got).not.toContain('h-4');
    expect(got).not.toContain('h-8');
    expect(got).not.toContain('h-16');
  });

  it('shape="block" stated explicitly is byte-identical to propless', () => {
    expect(renderedClass({ shape: 'block' })).toBe(renderedClass());
  });

  it('shape="circle" swaps rounded-card for rounded-full and still has no height class', () => {
    const got = tokens(renderedClass({ shape: 'circle' }));
    expect(got).toEqual(['animate-pulse', 'bg-background-light', 'rounded-full']);
  });
});

describe('Skeleton - hygiene', () => {
  it('a call site className composes with the base classes, the shipped call-site pattern', () => {
    const got = tokens(renderedClass({ className: 'h-4 w-64' }));
    expect(got).toEqual(['animate-pulse', 'bg-background-light', 'rounded-card', 'h-4', 'w-64']);
  });

  it('a call site className still wins over any conflicting utility (tailwind-merge, className applied last)', () => {
    const got = tokens(renderedClass({ shape: 'circle', className: 'rounded-md h-20' }));
    expect(got).not.toContain('rounded-full');
    expect(got).toContain('rounded-md');
    expect(got).toContain('h-20');
  });

  it('shape does not reach the DOM as an attribute', () => {
    const { container, unmount } = render(<Skeleton shape="circle" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('shape')).toBeNull();
    unmount();
  });

  it('forwards arbitrary DOM props (data-testid) alongside the computed class', () => {
    const { getByTestId, unmount } = render(<Skeleton data-testid="probe" className="h-4" />);
    const el = getByTestId('probe');
    expect(el.className).toBe('animate-pulse bg-background-light rounded-card h-4');
    unmount();
  });
});
