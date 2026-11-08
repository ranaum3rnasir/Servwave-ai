/**
 * Chip - rendered-class contract for the W2 `tone` / `size` axes.
 *
 * Chip is brand new (no prior shipped component to stay byte-identical
 * against), so the "propless" assertion below pins the primitive's own
 * evidence contract instead of a frozen pre-existing string: the 20-site
 * `bg-surface-light border border-border px-2.5 py-1.5 rounded-md` signature
 * from the program plan's hand-rolled-surfaces table, plus the structural
 * glue (`inline-flex items-center gap-1`) real multi-child sites already
 * carry (see chip.tsx's header note).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Chip, chipVariants, type ChipProps } from '@/components/ui/chip'

const cls = (el: HTMLElement) => el.getAttribute('class') ?? ''
const root = () => screen.getByTestId('chip')

const PROPLESS =
  'inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-xs font-medium text-text-primary'

describe('Chip - the evidenced default render', () => {
  it('propless renders exactly the 20-site signature plus its structural glue', () => {
    render(<Chip data-testid="chip">Label</Chip>)
    expect(cls(root())).toBe(PROPLESS)
  })

  it('tone="neutral" stated explicitly is byte-identical to propless', () => {
    render(
      <Chip data-testid="chip" tone="neutral">
        Label
      </Chip>
    )
    expect(cls(root())).toBe(PROPLESS)
  })

  it('size="2xs" stated explicitly is byte-identical to propless', () => {
    render(
      <Chip data-testid="chip" size="2xs">
        Label
      </Chip>
    )
    expect(cls(root())).toBe(PROPLESS)
  })

  it('renders its children', () => {
    render(<Chip data-testid="chip">Overdue</Chip>)
    expect(root()).toHaveTextContent('Overdue')
  })

  it('renders a span, not a div', () => {
    render(<Chip data-testid="chip">Label</Chip>)
    expect(root().tagName).toBe('SPAN')
  })
})

describe('Chip - tone token-backed values', () => {
  const TONE_CLASSES: Record<
    Exclude<NonNullable<ChipProps['tone']>, 'neutral'>,
    string[]
  > = {
    brand: ['bg-primary-subtle', 'border-primary/20', 'text-primary'],
    danger: ['bg-danger-surface', 'border-danger-border', 'text-danger-text'],
    success: ['bg-success-surface', 'border-success-border', 'text-success-text'],
    warning: ['bg-warning-surface', 'border-warning-border', 'text-warning-text'],
    ai: ['bg-ai-surface', 'border-ai-border', 'text-ai-text'],
  }

  it.each(Object.entries(TONE_CLASSES))(
    'tone="%s" renders its surface/border/text triad',
    (tone, expected) => {
      render(
        <Chip data-testid="chip" tone={tone as ChipProps['tone']}>
          Label
        </Chip>
      )
      const tokens = cls(root()).split(' ')
      expected.forEach((token) => expect(tokens).toContain(token))
    }
  )

  it('a non-neutral tone overrides the base surface/border/text, not just adds to it', () => {
    render(
      <Chip data-testid="chip" tone="danger">
        Label
      </Chip>
    )
    const tokens = cls(root()).split(' ')
    expect(tokens).not.toContain('bg-surface-light')
    expect(tokens).not.toContain('border-border')
    expect(tokens).not.toContain('text-text-primary')
    expect(tokens).toContain('bg-danger-surface')
  })
})

describe('Chip - size', () => {
  // The 20 evidenced sites are one signature, not a ladder, so `3xs` / `xs` /
  // `sm` / `md` / `lg` are reserved by the closed six-rung absolute-px
  // vocabulary but not implemented (see chip.tsx's header note) - the same
  // treatment Popover gives its own deferred `xs` width rung. size="2xs" is
  // covered by the propless assertion above; this pins the type surface so
  // an unevidenced rung cannot come back without deleting this compile-time
  // guard first.
  it('only "2xs" type-checks; the other scale rungs are rejected at compile time', () => {
    // @ts-expect-error - "sm" has zero measured call-site signature, not minted
    const sm: ChipProps['size'] = 'sm'
    // @ts-expect-error - "lg" has zero measured call-site signature, not minted
    const lg: ChipProps['size'] = 'lg'
    // @ts-expect-error - "xs" has zero measured call-site signature, not minted
    const xs: ChipProps['size'] = 'xs'
    // @ts-expect-error - "md" is the OLD mislabeled rung name; the measured
    // rung is "2xs" (28px), not "md" (40px) - "md" no longer type-checks
    const md: ChipProps['size'] = 'md'
    const twoXs: ChipProps['size'] = '2xs'

    expect([sm, lg, xs, md, twoXs]).toContain('2xs')
  })
})

describe('Chip - hygiene', () => {
  it('a caller className still wins, className is applied last', () => {
    render(
      <Chip data-testid="chip" tone="danger" className="bg-surface-light">
        Label
      </Chip>
    )
    const tokens = cls(root()).split(' ')
    expect(tokens).toContain('bg-surface-light')
    expect(tokens).not.toContain('bg-danger-surface')
  })

  it('tone and size never reach the DOM', () => {
    render(
      <Chip data-testid="chip" tone="success" size="2xs">
        Label
      </Chip>
    )
    expect(root().getAttribute('tone')).toBeNull()
    expect(root().getAttribute('size')).toBeNull()
  })

  it('forwards a ref', () => {
    const ref = { current: null as HTMLSpanElement | null }
    render(<Chip ref={ref}>Label</Chip>)
    expect(ref.current).toBeInstanceOf(HTMLSpanElement)
  })

  it('forwards arbitrary span attributes, e.g. onClick', () => {
    let clicked = false
    render(
      <Chip data-testid="chip" onClick={() => (clicked = true)}>
        Label
      </Chip>
    )
    root().click()
    expect(clicked).toBe(true)
  })

  it('chipVariants({}) resolves to the same propless string the component renders', () => {
    expect(chipVariants({})).toBe(PROPLESS)
  })
})
