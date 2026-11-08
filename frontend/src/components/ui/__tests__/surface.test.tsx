/* =============================================================================
   Surface - rendered-class contract and context verifier (W2 primitive
   vocabulary, phase 9).

   Prop rename note: this file originally pinned a `tone="light"|"dark"`
   prop. VOCAB_V3 reserves `tone` for semantic colour, so surface.tsx renamed
   the axis to `backdrop` and kept `tone` alive as a deprecated alias (see
   surface.tsx's own header note, "WHY THIS PROP IS `backdrop`, NOT `tone`").
   This file follows suit: the primary suites below pin `backdrop`, and a
   dedicated "deprecated `tone` alias" suite pins that the old prop and hook
   still render/read identically to their `backdrop` equivalents.

   Three things pinned here, matching the risk this primitive was flagged
   with in the W2 plan ("replaces a variant with a context provider; needs a
   dedicated verifier that renders a child inside <Surface backdrop="dark">
   and confirms it reads the context correctly"):

     1. RENDERED CLASSES. `light` (the default) is a geometrically inert
        no-op; `dark` paints exactly the two DARK-SURFACE CHROME roles
        surface.tsx documents (`bg-surface-dark`, `text-on-dark`), and the
        shared padding axis from design-system/spacing.ts composes with it
        exactly the way it composes on Box and Tabs.

     2. THE CONTEXT ITSELF. `useSurfaceBackdrop()` is the whole reason this
        is a context provider and not just a div with a dark background - a
        descendant has to be able to ASK what surface it is on. These tests
        render a real child component that calls the hook (never reads
        the DOM/class string as a proxy for context propagation), covering:
        the "light" default with no Surface at all, "light" inside an
        explicit `backdrop="light"` Surface, "dark" inside `backdrop="dark"`,
        that a NESTED Surface overrides its ancestor for everything below it
        (and that the ancestor's own sibling content is unaffected), and that
        unmounting/remounting does not leak state between renders.

     3. THE DEPRECATED `tone` ALIAS. `tone` must keep rendering identically
        to `backdrop` and `useSurfaceTone()` must keep reading identically to
        `useSurfaceBackdrop()`, so nothing that already called this file
        under the old name breaks.
   ============================================================================= */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PAD_STEPS } from '@/design-system/spacing'
import {
  Surface,
  useSurfaceBackdrop,
  useSurfaceTone,
  type SurfaceBackdrop,
  type SurfaceTone,
} from '../surface'

const cls = (el: HTMLElement) => el.getAttribute('class') ?? ''
const surface = () => screen.getByTestId('surface')

describe('Surface - rendered classes', () => {
  it('renders <div class=""> with no props (light is a no-op)', () => {
    render(<Surface data-testid="surface">child</Surface>)
    expect(surface().tagName).toBe('DIV')
    expect(cls(surface())).toBe('')
  })

  it('backdrop="light" (explicit) renders identically to omitting backdrop', () => {
    render(
      <Surface data-testid="surface" backdrop="light">
        child
      </Surface>
    )
    expect(cls(surface())).toBe('')
  })

  it('backdrop="dark" paints the dark-surface background and text roles', () => {
    render(
      <Surface data-testid="surface" backdrop="dark">
        child
      </Surface>
    )
    const tokens = cls(surface()).split(' ').filter(Boolean)
    expect(tokens).toContain('bg-surface-dark')
    expect(tokens).toContain('text-on-dark')
  })

  it('renders its children', () => {
    render(
      <Surface data-testid="surface">
        <span>a</span>
        <span>b</span>
      </Surface>
    )
    expect(surface().children).toHaveLength(2)
  })

  it('forwards a ref to the div', () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <Surface ref={ref} data-testid="surface">
        c
      </Surface>
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('passes through arbitrary div attributes', () => {
    render(
      <Surface data-testid="surface" role="region" aria-label="copilot">
        c
      </Surface>
    )
    expect(surface().getAttribute('aria-label')).toBe('copilot')
  })

  it('a call site className wins over the backdrop classes', () => {
    render(
      <Surface data-testid="surface" backdrop="dark" className="bg-surface-light">
        c
      </Surface>
    )
    const tokens = cls(surface()).split(' ')
    expect(tokens).toContain('bg-surface-light')
    expect(tokens).not.toContain('bg-surface-dark')
  })
})

describe('Surface - deprecated `tone` alias', () => {
  it('tone="dark" (deprecated) renders identically to backdrop="dark"', () => {
    render(
      <Surface data-testid="surface" tone="dark">
        c
      </Surface>
    )
    const tokens = cls(surface()).split(' ').filter(Boolean)
    expect(tokens).toEqual(['bg-surface-dark', 'text-on-dark'])
  })

  it('tone="light" (deprecated) renders identically to omitting backdrop', () => {
    render(
      <Surface data-testid="surface" tone="light">
        c
      </Surface>
    )
    expect(cls(surface())).toBe('')
  })

  it('backdrop wins when both backdrop and the deprecated tone are passed', () => {
    render(
      <Surface data-testid="surface" backdrop="light" tone="dark">
        c
      </Surface>
    )
    expect(cls(surface())).toBe('')
  })

  it('useSurfaceTone() (deprecated) reads the same value as useSurfaceBackdrop()', () => {
    function BothReadout() {
      const backdrop = useSurfaceBackdrop()
      const tone = useSurfaceTone()
      return <span data-testid="both">{`${backdrop}/${tone}`}</span>
    }
    render(
      <Surface backdrop="dark">
        <BothReadout />
      </Surface>
    )
    expect(screen.getByTestId('both').textContent).toBe('dark/dark')
  })
})

describe('Surface - pad composes with backdrop via the shared spacing module', () => {
  it.each(PAD_STEPS.map((s) => [s, `p-${s}`] as const))('pad={%s} renders %s', (pad, expected) => {
    render(
      <Surface data-testid="surface" pad={pad}>
        c
      </Surface>
    )
    expect(cls(surface())).toBe(expected)
  })

  it('pad={0} survives the falsy trap and still emits p-0', () => {
    render(
      <Surface data-testid="surface" pad={0}>
        c
      </Surface>
    )
    expect(cls(surface())).toBe('p-0')
  })

  it('dark backdrop plus pad emits both, backdrop classes first', () => {
    render(
      <Surface data-testid="surface" backdrop="dark" pad={6}>
        c
      </Surface>
    )
    const tokens = cls(surface()).split(' ').filter(Boolean)
    expect(tokens).toEqual(['bg-surface-dark', 'text-on-dark', 'p-6'])
  })

  it('padX / padY decompose deterministically, same precedence rule as Box/Tabs', () => {
    render(
      <Surface data-testid="surface" pad={6} padX={3}>
        c
      </Surface>
    )
    expect(cls(surface()).split(' ').filter(Boolean)).toEqual(['px-3', 'py-6'])
  })

  it('a single side wins on its own side, the rest fall back to pad', () => {
    render(
      <Surface data-testid="surface" pad={4} padTop={2}>
        c
      </Surface>
    )
    expect(cls(surface())).toBe('pt-2 pr-4 pb-4 pl-4')
  })
})

/** Renders the current surface backdrop as plain text, so assertions read
 *  the React context directly rather than inferring it from painted classes. */
function BackdropReadout({ testId = 'backdrop-readout' }: { testId?: string }) {
  const backdrop = useSurfaceBackdrop()
  return <span data-testid={testId}>{backdrop}</span>
}

function readBackdrop(testId = 'backdrop-readout'): SurfaceBackdrop {
  return screen.getByTestId(testId).textContent as SurfaceBackdrop
}

describe('Surface - useSurfaceBackdrop() context propagation (the dedicated verifier)', () => {
  it('defaults to "light" for a component with no ancestor Surface at all', () => {
    render(<BackdropReadout />)
    expect(readBackdrop()).toBe('light')
  })

  it('a child nested inside <Surface backdrop="light"> reads "light"', () => {
    render(
      <Surface>
        <BackdropReadout />
      </Surface>
    )
    expect(readBackdrop()).toBe('light')
  })

  it('a child nested inside <Surface backdrop="dark"> reads "dark"', () => {
    render(
      <Surface backdrop="dark">
        <BackdropReadout />
      </Surface>
    )
    expect(readBackdrop()).toBe('dark')
  })

  it('reads "dark" through an intermediate plain element, not just a direct child', () => {
    render(
      <Surface backdrop="dark">
        <div>
          <section>
            <BackdropReadout />
          </section>
        </div>
      </Surface>
    )
    expect(readBackdrop()).toBe('dark')
  })

  it('a nested Surface overrides its ancestor for everything below it', () => {
    render(
      <Surface backdrop="dark">
        <BackdropReadout testId="outer" />
        <Surface backdrop="light">
          <BackdropReadout testId="inner" />
        </Surface>
      </Surface>
    )
    expect(readBackdrop('outer')).toBe('dark')
    expect(readBackdrop('inner')).toBe('light')
  })

  it('two sibling Surfaces with different backdrops do not leak into each other', () => {
    render(
      <div>
        <Surface backdrop="dark">
          <BackdropReadout testId="a" />
        </Surface>
        <Surface backdrop="light">
          <BackdropReadout testId="b" />
        </Surface>
      </div>
    )
    expect(readBackdrop('a')).toBe('dark')
    expect(readBackdrop('b')).toBe('light')
  })

  it('unmounting a dark Surface and mounting a fresh light one does not leak state', () => {
    const { unmount } = render(
      <Surface backdrop="dark">
        <BackdropReadout />
      </Surface>
    )
    expect(readBackdrop()).toBe('dark')
    unmount()

    render(
      <Surface>
        <BackdropReadout />
      </Surface>
    )
    expect(readBackdrop()).toBe('light')
  })

  it('a Surface nested via the deprecated `tone` prop still propagates through the context', () => {
    render(
      <Surface tone="dark">
        <BackdropReadout />
      </Surface>
    )
    expect(readBackdrop()).toBe('dark')
  })
})

// Exercises the deprecated `SurfaceTone` type alias so it stays a valid
// substitute for `SurfaceBackdrop` at the type level, not just at runtime.
const _typeAliasStillAssignable: SurfaceTone = 'dark' satisfies SurfaceBackdrop
void _typeAliasStillAssignable
