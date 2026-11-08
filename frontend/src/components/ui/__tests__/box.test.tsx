/**
 * Box - phase 9 rendered-class contract.
 *
 * Box is a thin shell over design-system/spacing.ts's padClasses, so these
 * tests pin the same two things tabs.test.tsx and card.test.tsx pin for their
 * own pad axis: the bare default is geometrically inert, and every prop
 * combination resolves through the shared precedence rule rather than a
 * locally reinvented one.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Box } from '@/components/ui/box'
import { PAD_STEPS, type PadStep } from '@/design-system/spacing'

const cls = (el: HTMLElement) => el.getAttribute('class') ?? ''
const box = () => screen.getByTestId('box')

describe('Box - the bare default is inert', () => {
  it('renders <div class=""> with no props', () => {
    render(<Box data-testid="box">child</Box>)
    expect(box().tagName).toBe('DIV')
    expect(cls(box())).toBe('')
  })

  it('renders its children', () => {
    render(
      <Box data-testid="box">
        <span>a</span>
        <span>b</span>
      </Box>
    )
    expect(box().children).toHaveLength(2)
  })

  it('forwards a ref to the div', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <Box ref={ref} data-testid="box">
        c
      </Box>
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('passes through arbitrary div attributes', () => {
    render(
      <Box data-testid="box" role="group" aria-label="filters">
        c
      </Box>
    )
    expect(box().getAttribute('aria-label')).toBe('filters')
  })
})

describe('Box - pad is the 4px-grid step, not a size word', () => {
  it.each(PAD_STEPS.map((s) => [s, `p-${s}`] as const))('pad={%s} renders %s', (pad, expected) => {
    render(
      <Box data-testid="box" pad={pad}>
        c
      </Box>
    )
    expect(cls(box())).toBe(expected)
  })

  it('pad={0} survives the falsy trap and still emits p-0', () => {
    render(
      <Box data-testid="box" pad={0}>
        c
      </Box>
    )
    expect(cls(box())).toBe('p-0')
  })

  it('covers every step with a literal class string, never a computed one', () => {
    const emitted = new Set<string>()
    for (const pad of PAD_STEPS) {
      const { unmount } = render(
        <Box data-testid="box" pad={pad}>
          c
        </Box>
      )
      for (const c of cls(box()).split(' ')) if (c) emitted.add(c)
      unmount()
    }
    expect([...emitted].sort()).toEqual(PAD_STEPS.map((s) => `p-${s}`).sort())
  })
})

describe('Box - padX / padY decompose deterministically', () => {
  it('never leaks the shorthand next to an axis override', () => {
    render(
      <Box data-testid="box" pad={6} padX={3}>
        c
      </Box>
    )
    const tokens = cls(box()).split(' ').filter(Boolean)
    expect(tokens).toEqual(['px-3', 'py-6'])
  })

  it('padX alone takes pad for the other axis', () => {
    render(
      <Box data-testid="box" pad={6} padX={2}>
        c
      </Box>
    )
    expect(cls(box())).toBe('px-2 py-6')
  })

  it('padX / padY with no uniform pad names only the axis given', () => {
    render(
      <Box data-testid="box" padX={4} padY={2.5}>
        c
      </Box>
    )
    expect(cls(box())).toBe('px-4 py-2.5')
  })
})

describe('Box - per-side overrides', () => {
  it('a single side wins on its own side, the rest fall back to pad', () => {
    render(
      <Box data-testid="box" pad={4} padTop={2}>
        c
      </Box>
    )
    expect(cls(box())).toBe('pt-2 pr-4 pb-4 pl-4')
  })

  it('all four sides named individually, top/right/bottom/left order', () => {
    render(
      <Box data-testid="box" padTop={1} padRight={2} padBottom={3} padLeft={4}>
        c
      </Box>
    )
    expect(cls(box())).toBe('pt-1 pr-2 pb-3 pl-4')
  })

  it.each([
    ['padTop', 'pt'],
    ['padRight', 'pr'],
    ['padBottom', 'pb'],
    ['padLeft', 'pl'],
  ] as const)('%s alone renders only %s-N', (prop, prefix) => {
    render(<Box data-testid="box" {...{ [prop]: 3 as PadStep }}>c</Box>)
    expect(cls(box())).toBe(`${prefix}-3`)
  })
})

describe('Box - hygiene', () => {
  it('a call site className wins over the pad class', () => {
    render(
      <Box data-testid="box" pad={2} className="p-8">
        c
      </Box>
    )
    const rendered = cls(box()).split(' ')
    expect(rendered).toContain('p-8')
    expect(rendered).not.toContain('p-2')
  })

  it('every class it can emit is a plain p-prefixed Tailwind utility, never an arbitrary bracket value', () => {
    const emitted = new Set<string>()
    for (const pad of PAD_STEPS) {
      const { unmount } = render(
        <Box data-testid="box" pad={pad} padX={pad} padY={pad}>
          c
        </Box>
      )
      for (const c of cls(box()).split(' ')) if (c) emitted.add(c)
      unmount()
    }
    for (const c of emitted) {
      expect(c, `${c} must be a padding utility`).toMatch(/^p[xy]?-/)
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/)
    }
  })
})
