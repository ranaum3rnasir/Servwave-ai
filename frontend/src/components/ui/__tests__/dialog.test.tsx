/**
 * DialogContent `width` / `pad` / `gap` - phase 8.
 *
 * The hard constraint on this file is that no EXISTING call site moves a
 * pixel: DialogContent has 66 in-scope call sites and every one of them must
 * keep rendering exactly what it renders today when it passes no `width`,
 * `pad` or `gap` prop. The first block below therefore asserts the literal
 * class string rather than a loose `toContain`.
 *
 * `width` (max-width) and the `pad` / `gap` 4px-grid steps are spliced into
 * the base class list at the exact position each class held before this
 * change - not appended after it, the way a plain cva() variant would - so
 * the pre-phase-8 string comes out byte-identical. See dialog.tsx's own
 * comment on `DialogContent`'s className for the full reasoning. Named
 * `width`, not `size` - program plan section 2a rule 3 reserves `size` for
 * control height; a max-width scale is a different axis.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  Dialog,
  DialogContent,
  type DialogWidth,
  type DialogSpacingStep,
} from '@/components/ui/dialog'

/**
 * The exact string DialogContent renders for a call site passing nothing.
 *
 * The guard this baseline enforces is that `width`/`pad`/`gap` never move the
 * rendered string - NOT that the primitive can never be fixed. A change here
 * has to be an intended change to the primitive itself. Two have been made:
 *
 *  1. phase 8's `grid-cols-[minmax(0,1fr)]`, which stops a nowrap child sizing
 *     the single `auto` track past the panel's max width;
 *  2. the v2 repaint - the kit's scrim, radius, elevation, surface and close
 *     cell, plus the height cap and scroll that stop a tall dialog spilling off
 *     both edges of the viewport at once. See dialog.tsx's own header for why
 *     that repaint lives in this file rather than in sixty call sites.
 *
 * The box model is deliberately untouched by both: `w-*` aside, the width,
 * padding and gap defaults are still `max-w-lg` / `p-6` / `gap-4`.
 */
const BASELINE =
  'fixed left-[50%] top-[50%] z-50 grid w-[calc(100%-2.5rem)] max-w-lg grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 max-h-[calc(100dvh-2.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain border bg-kit-card p-6 shadow-modal duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] rounded-xl'

/**
 * DialogContent renders through a Radix Portal, so it lands on
 * `document.body` rather than inside the `render()` container - `screen`
 * (bound to the whole document) is what finds it, not the container.
 */
function renderContent(props: Partial<React.ComponentProps<typeof DialogContent>> = {}) {
  render(
    <Dialog open>
      <DialogContent data-testid="dialog-content" {...props}>
        body
      </DialogContent>
    </Dialog>
  )
  return screen.getByTestId('dialog-content')
}

function classOf(props: Partial<React.ComponentProps<typeof DialogContent>> = {}): string {
  return renderContent(props).className
}

function tokens(props: Partial<React.ComponentProps<typeof DialogContent>> = {}): string[] {
  return classOf(props).split(/\s+/).filter(Boolean)
}

describe('DialogContent - existing default is unchanged (hard constraint)', () => {
  it('renders the pre-phase-8 baseline string when no width/pad/gap prop is passed', () => {
    expect(classOf()).toBe(BASELINE)
  });

  it('width="md" pad={6} gap={4} is byte-identical to the implicit default', () => {
    expect(classOf({ width: 'md', pad: 6, gap: 4 })).toBe(BASELINE)
  });

  it('keeps overlayClassName and className behaving exactly as before', () => {
    const t = tokens({ className: 'mt-4' })
    expect(t).toContain('mt-4')
    // className is applied last, so a call site can still win where it must.
    expect(t[t.length - 1]).toBe('mt-4')
  });
});

describe('DialogContent - the single column can shrink below its content', () => {
  // An `auto` grid track is floored by its items' min-content contribution, so one nowrap
  // child (`truncate`, a long unbroken string) sizes the track past max-w-* and paints
  // outside the panel. The explicit minmax(0,1fr) track is what stops that.
  it.each<DialogWidth>(['xs', 'sm', 'md', 'lg'])(
    'constrains the column at width="%s"',
    (width) => {
      expect(tokens({ width })).toContain('grid-cols-[minmax(0,1fr)]')
    }
  );
});

describe('DialogContent - the width scale', () => {
  const WIDTHS: Array<[DialogWidth, string]> = [
    ['xs', 'max-w-sm'],
    ['sm', 'max-w-md'],
    ['md', 'max-w-lg'],
    ['lg', 'max-w-2xl'],
  ]

  it.each(WIDTHS)('width="%s" renders %s', (width, expected) => {
    expect(tokens({ width })).toContain(expected)
  });

  it('emits exactly one max-w-* class per render', () => {
    const widths = tokens({ width: 'lg' }).filter((c) => /^max-w-/.test(c))
    expect(widths).toEqual(['max-w-2xl'])
  });

  it('a call site className still wins over the width class (tailwind-merge)', () => {
    const t = tokens({ width: 'lg', className: 'max-w-xl' })
    expect(t).toContain('max-w-xl')
    expect(t).not.toContain('max-w-2xl')
  });
});

describe('DialogContent - pad is the 4px-grid step, not a size word', () => {
  const STEPS: Array<[DialogSpacingStep, string]> = [
    [0, 'p-0'],
    [0.5, 'p-0.5'],
    [1, 'p-1'],
    [1.5, 'p-1.5'],
    [2, 'p-2'],
    [2.5, 'p-2.5'],
    [3, 'p-3'],
    [4, 'p-4'],
    [5, 'p-5'],
    [6, 'p-6'],
    [8, 'p-8'],
    [12, 'p-12'],
  ]

  it.each(STEPS)('pad={%s} renders %s', (pad, expected) => {
    expect(tokens({ pad })).toContain(expected)
  });

  it('pad={0} survives the falsy trap and still emits p-0 (8 real sites use this)', () => {
    expect(tokens({ pad: 0 })).toContain('p-0')
  });

  it('emits exactly one p-N class per render', () => {
    const pads = tokens({ pad: 3 }).filter((c) => /^p-/.test(c))
    expect(pads).toEqual(['p-3'])
  });
});

describe('DialogContent - gap is the 4px-grid step, not a size word', () => {
  const STEPS: Array<[DialogSpacingStep, string]> = [
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
  ]

  it.each(STEPS)('gap={%s} renders %s', (gap, expected) => {
    expect(tokens({ gap })).toContain(expected)
  });

  it('gap={0} survives the falsy trap and still emits gap-0 (7 real sites use this)', () => {
    expect(tokens({ gap: 0 })).toContain('gap-0')
  });
});

describe('DialogContent - pad and gap vary independently', () => {
  it('gap-0 with the default pad (PdfPreviewDialog.tsx:99 zeroes only gap, not pad)', () => {
    const t = tokens({ gap: 0 })
    expect(t).toContain('gap-0')
    expect(t).toContain('p-6')
  });

  it('p-0 and gap-0 together (the other 7 zero-both sites)', () => {
    const t = tokens({ pad: 0, gap: 0 })
    expect(t).toContain('p-0')
    expect(t).toContain('gap-0')
  });
});

describe('DialogContent - the measured clusters are expressible', () => {
  it('width="xs" (max-w-sm, 15 sites)', () => {
    expect(tokens({ width: 'xs' })).toContain('max-w-sm')
  });

  it('width="sm" (max-w-md, 21 sites)', () => {
    expect(tokens({ width: 'sm' })).toContain('max-w-md')
  });

  it('width="lg" (max-w-2xl, 6 sites)', () => {
    expect(tokens({ width: 'lg' })).toContain('max-w-2xl')
  });

  it('pad={0} gap={0} (AgentDetailModal.tsx / AiCenterModal.tsx / BookingModal.tsx shape)', () => {
    const t = tokens({ pad: 0, gap: 0 })
    expect(t).toEqual(expect.arrayContaining(['p-0', 'gap-0']))
    expect(t).not.toContain('p-6')
    expect(t).not.toContain('gap-4')
  });
});

describe('DialogContent - the scale stays scannable by Tailwind', () => {
  /**
   * Tailwind reads source TEXT. A templated `p-${step}` would type-check,
   * pass every assertion above, and generate no CSS at all - the class
   * would exist in the DOM and paint nothing. This is the guard against
   * that regression, mirroring card.test.tsx's own version of this check.
   */
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dialog.tsx'),
    'utf8'
  )

  const STEPS: DialogSpacingStep[] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12]

  it.each(STEPS.map((s) => [s] as const))('p-%s and gap-%s appear as literal strings in dialog.tsx', (step) => {
    expect(src).toContain(`"p-${step}"`)
    expect(src).toContain(`"gap-${step}"`)
  });

  it.each((['max-w-sm', 'max-w-md', 'max-w-lg', 'max-w-2xl'] as const).map((c) => [c] as const))(
    '%s appears as a literal string in dialog.tsx',
    (cls) => {
      expect(src).toContain(`"${cls}"`)
    }
  );

  it('builds no class name by interpolation', () => {
    expect(src).not.toMatch(/["'`](p|gap|max-w)-\$\{/)
  });
});
