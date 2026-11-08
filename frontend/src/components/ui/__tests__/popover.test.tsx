/**
 * PopoverContent `width` (max-width) / `pad` - W2 primitive vocabulary.
 *
 * The hard constraint: the no-props render must stay byte-identical to what
 * shipped before this file existed (`w-72` / `p-4`, unchanged). The first
 * block below pins that literal string by rendering the real component
 * through Radix (not just the cva function), so a regression anywhere in the
 * merge path - not only inside `popoverContentVariants` - would fail it.
 *
 * `width="md"` and `pad={4}` both resolve to an empty variant string on
 * purpose (see popover.tsx's header note): the base string already carries
 * `w-72` / `p-4`, so nothing needs to override the default rung. Non-default
 * values are asserted as a token SET, not a literal string - they win their
 * conflict group through `cn`'s tailwind-merge pass rather than by sitting in
 * the base string's original position, so their exact byte order is not a
 * frozen contract the way the default's is. `width` controls max-width on
 * this primitive, not `size` - program plan section 2a rule 3: `size` always
 * means control height, and PopoverContent has no separate control height to
 * scale, so its geometry axis is named `width` instead. `pad` is the 4px-grid
 * step scale (program plan section 2a.8), the same numeric scheme
 * Dialog/Stack/Box/Card's `pad`/`gap` already use.
 */
import type { ReactElement } from 'react';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  popoverContentVariants,
} from '@/components/ui/popover';

/**
 * The exact string PopoverContent renders for a call site passing neither prop.
 *
 * CHANGED ONCE, DELIBERATELY: the leading rung went `z-50` -> `z-floating` (2026-08-30).
 * This popover sat a full layer below the kit's own, so any legacy select or popover
 * opened from inside a kit popover rendered BEHIND it - the scheduler's creation popover
 * showed neither its crew list nor its customer picker. `floating` is the rung the token
 * scale already reserves for "menus, selects, popovers, tooltips", which is where the
 * kit's equivalents have always been; this is the legacy pair catching up, not a new
 * value. Everything else in the string is still frozen, which is what this guard is for.
 */
const BASELINE =
  'z-floating w-72 rounded-card border border-border bg-surface-light p-4 text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]';

function renderOpenContent(ui: ReactElement) {
  render(
    <Popover defaultOpen>
      <PopoverTrigger>open</PopoverTrigger>
      {ui}
    </Popover>
  );
  return screen.getByTestId('popover-content');
}

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

describe('PopoverContent - existing default is unchanged (hard constraint)', () => {
  it('renders the pre-W2 baseline string when neither width nor pad is passed', () => {
    const el = renderOpenContent(<PopoverContent data-testid="popover-content">body</PopoverContent>);
    expect(el.className).toBe(BASELINE);
  });

  it('renders the same baseline string when width="md" and pad={4} are passed explicitly', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" width="md" pad={4}>
        body
      </PopoverContent>
    );
    expect(el.className).toBe(BASELINE);
  });
});

describe('PopoverContent - width', () => {
  it('width="sm" renders w-64 and drops w-72', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" width="sm">
        body
      </PopoverContent>
    );
    const t = tokens(el.className);
    expect(t).toContain('w-64');
    expect(t).not.toContain('w-72');
  });

  it('width="lg" renders w-80 and drops w-72', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" width="lg">
        body
      </PopoverContent>
    );
    const t = tokens(el.className);
    expect(t).toContain('w-80');
    expect(t).not.toContain('w-72');
  });
});

describe('PopoverContent - pad', () => {
  it('pad={0} renders p-0 and drops p-4', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" pad={0}>
        body
      </PopoverContent>
    );
    const t = tokens(el.className);
    expect(t).toContain('p-0');
    expect(t).not.toContain('p-4');
  });

  it('pad={1} renders p-1 and drops p-4', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" pad={1}>
        body
      </PopoverContent>
    );
    const t = tokens(el.className);
    expect(t).toContain('p-1');
    expect(t).not.toContain('p-4');
  });

  it('pad={2} renders p-2 and drops p-4', () => {
    const el = renderOpenContent(
      <PopoverContent data-testid="popover-content" pad={2}>
        body
      </PopoverContent>
    );
    const t = tokens(el.className);
    expect(t).toContain('p-2');
    expect(t).not.toContain('p-4');
  });
});

it('a caller className still wins over both axes, same as before this change', () => {
  const el = renderOpenContent(
    <PopoverContent data-testid="popover-content" width="sm" pad={0} className="w-56">
      body
    </PopoverContent>
  );
  const t = tokens(el.className);
  expect(t).toContain('w-56');
  expect(t).not.toContain('w-64');
  expect(t).not.toContain('w-72');
  expect(t).toContain('p-0');
});

/**
 * Direct unit coverage of the cva function itself, over the full 3 x 4
 * matrix, independent of Radix's render path. Belt-and-suspenders with the
 * DOM-rendered assertions above.
 */
describe('popoverContentVariants - full width x pad matrix', () => {
  const widthClass = { sm: 'w-64', md: '', lg: 'w-80' } as const;
  const padClass = { 0: 'p-0', 1: 'p-1', 2: 'p-2', 4: '' } as const;

  for (const width of ['sm', 'md', 'lg'] as const) {
    for (const pad of [0, 1, 2, 4] as const) {
      it(`width="${width}" pad={${pad}}`, () => {
        const out = tokens(popoverContentVariants({ width, pad }));
        if (widthClass[width]) expect(out).toContain(widthClass[width]);
        if (padClass[pad]) expect(out).toContain(padClass[pad]);
        // md/4 is the no-override case: neither axis appends anything beyond base.
        if (width === 'md') expect(out).not.toContain('w-64');
        if (width === 'md') expect(out).not.toContain('w-80');
        if (pad === 4) expect(out).not.toContain('p-0');
        if (pad === 4) expect(out).not.toContain('p-1');
        if (pad === 4) expect(out).not.toContain('p-2');
      });
    }
  }

  it('the no-argument call (both defaults) matches the frozen baseline', () => {
    expect(popoverContentVariants({})).toBe(BASELINE);
  });
});
