/**
 * SheetContent `width` / `pad` / `gap` - phase 8.
 *
 * The hard constraint on this file is that no EXISTING call site moves a
 * pixel: SheetContent has 17 in-scope call sites and every one of them must
 * keep rendering exactly what it renders today when it passes no `width`,
 * `pad` or `gap` prop. The first block below therefore asserts the literal
 * class string rather than a loose `toContain`, for all four `side` values.
 *
 * `width` (max-width, `left`/`right` only) and the `pad`/`gap` 4px-grid
 * steps are spliced into the base class list at the exact position each
 * class held before this change - not appended after it, the way a plain
 * cva() variant would - so the pre-phase-8 string comes out byte-identical.
 * See sheet.tsx's own comment on `SheetContent`'s className for the full
 * reasoning. Named `width`, not `size` - vocabulary rev 3 rule 3 reserves
 * `size` for control height; a max-width scale is a different axis (the
 * same rename already applied to Dialog's `DialogWidth` and
 * DropdownMenuContent's `DropdownMenuContentWidth`). `pad`/`gap` take the
 * numeric 4px-grid step (program plan section 2a.8), the same scheme
 * Dialog/Stack/Box/Card already use, not a word scale. The old `size` prop
 * is kept as a deprecated alias for `width` (same values, same pixels) -
 * see the "deprecated `size` alias" describe block below.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  Sheet,
  SheetContent,
  type SheetSide,
  type SheetPadStep,
  type SheetGapStep,
} from '@/components/ui/sheet'

/** The exact strings SheetContent has rendered since it shipped, per side, for a call site passing nothing. */
const BASELINE: Record<SheetSide, string> = {
  top: 'fixed z-50 gap-4 bg-surface-light p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
  bottom:
    'fixed z-50 gap-4 bg-surface-light p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
  left: 'fixed z-50 gap-4 bg-surface-light p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
  right:
    'fixed z-50 gap-4 bg-surface-light p-6 shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500 inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
}

/**
 * SheetContent renders through a Radix Portal, so it lands on
 * `document.body` rather than inside the `render()` container - `screen`
 * (bound to the whole document) is what finds it, not the container.
 */
function renderContent(
  props: Partial<React.ComponentProps<typeof SheetContent>> = {}
) {
  // A test that calls classOf()/tokens() more than once (comparing two
  // renders against each other) would otherwise leave the previous render's
  // portal content on document.body - RTL's auto-cleanup only runs in
  // afterEach, between tests, not between renders inside one test.
  cleanup()
  render(
    <Sheet open>
      <SheetContent data-testid="sheet-content" {...props}>
        body
      </SheetContent>
    </Sheet>
  )
  return screen.getByTestId('sheet-content')
}

function classOf(
  props: Partial<React.ComponentProps<typeof SheetContent>> = {}
): string {
  return renderContent(props).className
}

function tokens(
  props: Partial<React.ComponentProps<typeof SheetContent>> = {}
): string[] {
  return classOf(props).split(/\s+/).filter(Boolean)
}

describe('SheetContent - existing defaults are unchanged (hard constraint)', () => {
  it('renders the pre-phase-8 baseline string for the implicit default side (right)', () => {
    expect(classOf()).toBe(BASELINE.right)
  })

  it.each((['top', 'bottom', 'left', 'right'] as const).map((s) => [s] as const))(
    'side="%s" with no width/pad/gap renders the pre-phase-8 baseline for that side',
    (side) => {
      expect(classOf({ side })).toBe(BASELINE[side])
    }
  )

  it.each((['top', 'bottom', 'left', 'right'] as const).map((s) => [s] as const))(
    'side="%s" width="md" pad={6} gap={4} is byte-identical to the implicit default',
    (side) => {
      expect(classOf({ side, width: 'md', pad: 6, gap: 4 })).toBe(BASELINE[side])
    }
  )

  it('keeps className behaving exactly as before (applied last, wins via tailwind-merge)', () => {
    const t = tokens({ className: 'mt-4' })
    expect(t).toContain('mt-4')
    expect(t[t.length - 1]).toBe('mt-4')
  })
})

describe('SheetContent - the width scale (left/right only)', () => {
  it('width="md" renders sm:max-w-sm on a right sheet (today\'s unstyled default)', () => {
    expect(tokens({ side: 'right', width: 'md' })).toContain('sm:max-w-sm')
  })

  it('width="lg" renders sm:max-w-md on a right sheet', () => {
    expect(tokens({ side: 'right', width: 'lg' })).toContain('sm:max-w-md')
  })

  it('width="lg" renders sm:max-w-md on a left sheet', () => {
    expect(tokens({ side: 'left', width: 'lg' })).toContain('sm:max-w-md')
  })

  it('emits exactly one max-w-* class per render', () => {
    const widths = tokens({ side: 'right', width: 'lg' }).filter((c) =>
      /max-w-/.test(c)
    )
    expect(widths).toEqual(['sm:max-w-md'])
  })

  it('a call site className still wins over the width class (tailwind-merge)', () => {
    const t = tokens({ side: 'right', width: 'lg', className: 'sm:max-w-xl' })
    expect(t).toContain('sm:max-w-xl')
    expect(t).not.toContain('sm:max-w-md')
  })

  it('width renders no width class at all on a top sheet, regardless of value', () => {
    expect(tokens({ side: 'top', width: 'lg' }).some((c) => /max-w-/.test(c))).toBe(false)
    expect(tokens({ side: 'top', width: 'md' }).some((c) => /max-w-/.test(c))).toBe(false)
  })

  it('width renders no width class at all on a bottom sheet, regardless of value', () => {
    expect(tokens({ side: 'bottom', width: 'lg' }).some((c) => /max-w-/.test(c))).toBe(false)
  })
})

describe('SheetContent - the deprecated `size` alias', () => {
  it('size="lg" renders sm:max-w-md, same as width="lg" (right sheet)', () => {
    expect(tokens({ side: 'right', size: 'lg' })).toContain('sm:max-w-md')
  })

  it('size="md" renders sm:max-w-sm, same as width="md" (today\'s default)', () => {
    expect(tokens({ side: 'right', size: 'md' })).toContain('sm:max-w-sm')
  })

  it('omitting both size and width still renders the pre-phase-8 baseline', () => {
    expect(classOf({ side: 'right' })).toBe(BASELINE.right)
  })

  it('width wins when both width and size are passed', () => {
    const t = tokens({ side: 'right', width: 'md', size: 'lg' })
    expect(t).toContain('sm:max-w-sm')
    expect(t).not.toContain('sm:max-w-md')
  })

  it('size renders no width class at all on a top sheet, regardless of value', () => {
    expect(tokens({ side: 'top', size: 'lg' }).some((c) => /max-w-/.test(c))).toBe(false)
  })
})

describe('SheetContent - pad is 0/6, not the full 4px-grid step scale', () => {
  const STEPS: Array<[SheetPadStep, string]> = [
    [0, 'p-0'],
    [6, 'p-6'],
  ]

  it.each(STEPS)('pad={%s} renders %s', (pad, expected) => {
    expect(tokens({ pad })).toContain(expected)
  })

  it('emits exactly one p-N class per render', () => {
    const pads = tokens({ pad: 0 }).filter((c) => /^p-/.test(c))
    expect(pads).toEqual(['p-0'])
  })

  it('pad={0} leaves gap at its default (varies independently)', () => {
    const t = tokens({ pad: 0 })
    expect(t).toContain('p-0')
    expect(t).toContain('gap-4')
  })
})

describe('SheetContent - gap is 0/4, not the full 4px-grid step scale', () => {
  const STEPS: Array<[SheetGapStep, string]> = [
    [0, 'gap-0'],
    [4, 'gap-4'],
  ]

  it.each(STEPS)('gap={%s} renders %s', (gap, expected) => {
    expect(tokens({ gap })).toContain(expected)
  })

  it('gap={0} leaves pad at its default (varies independently)', () => {
    const t = tokens({ gap: 0 })
    expect(t).toContain('gap-0')
    expect(t).toContain('p-6')
  })

  it('pad={0} and gap={0} together (the measured zero-both cluster)', () => {
    const t = tokens({ pad: 0, gap: 0 })
    expect(t).toEqual(expect.arrayContaining(['p-0', 'gap-0']))
    expect(t).not.toContain('p-6')
    expect(t).not.toContain('gap-4')
  })
})

describe('SheetContent - the measured clusters are expressible', () => {
  it('width="lg" pad={0} gap={0} on a right sheet (HistoryPanel.tsx / EntityCallDrawer.tsx shape)', () => {
    const t = tokens({ side: 'right', width: 'lg', pad: 0, gap: 0 })
    expect(t).toEqual(
      expect.arrayContaining(['sm:max-w-md', 'p-0', 'gap-0'])
    )
    expect(t).not.toContain('p-6')
    expect(t).not.toContain('gap-4')
    expect(t).not.toContain('sm:max-w-sm')
  })

  it('pad={0} alone, no width/gap override (AppLayout.tsx nav-rail shape)', () => {
    const t = tokens({ side: 'right', pad: 0 })
    expect(t).toContain('p-0')
    expect(t).toContain('gap-4')
    expect(t).toContain('sm:max-w-sm')
  })
})

describe('SheetContent - side keeps its own existing behaviour', () => {
  it('top/bottom carry no width axis and no side border class', () => {
    expect(tokens({ side: 'top' })).toContain('border-b')
    expect(tokens({ side: 'bottom' })).toContain('border-t')
  })

  it('left/right keep their own border side', () => {
    expect(tokens({ side: 'left' })).toContain('border-r')
    expect(tokens({ side: 'right' })).toContain('border-l')
  })
})

describe('SheetContent - the scale stays scannable by Tailwind', () => {
  /**
   * Tailwind reads source TEXT. A templated class name would type-check,
   * pass every assertion above, and generate no CSS at all - the class
   * would exist in the DOM and paint nothing. This is the guard against
   * that regression, mirroring card.test.tsx / dialog.test.tsx's own
   * version of this check.
   */
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'sheet.tsx'),
    'utf8'
  )

  it.each(
    (['sm:max-w-sm', 'sm:max-w-md', 'p-0', 'p-6', 'gap-0', 'gap-4'] as const).map(
      (c) => [c] as const
    )
  )('%s appears as a literal string in sheet.tsx', (cls) => {
    expect(src).toContain(`"${cls}"`)
  })

  it('builds no class name by interpolation', () => {
    expect(src).not.toMatch(/["'`](p|gap|sm:max-w)-?\$\{/)
  })
})
