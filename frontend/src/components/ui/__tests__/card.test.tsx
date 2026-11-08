/**
 * Card `pad` / `padX` / `padY` - phase 7d.
 *
 * The hard constraint on this whole phase is that no EXISTING default moves a
 * pixel. Card has 97 in-scope call sites: 42 pass no padding at all, 39 pass
 * `padding="sm"`, 9 pass `"none"`, 7 pass `"lg"` (measured 2026-07-28 with the
 * phase-6 guard exports). Every one of them must render exactly what it
 * rendered before this file existed, so the first two blocks below assert the
 * literal class string rather than a loose `toContain`.
 *
 * The new scale is the 4px-grid STEP number from program-plan section 2a.8,
 * not a size word. It exists to reach the hand-rolled Card-shaped surfaces
 * that the old four-value word scale could not name: 312 such surfaces across
 * 163 files, whose three largest explicit clusters are `p-3` (56 sites, 50 of
 * them with no shadow), `p-6` (23, 17 with `shadow-card`) and `px-3 py-2`
 * (22, 19 with no shadow). The last block below proves each of those three is
 * now expressible as props.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { ReactElement } from 'react';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, PAD_STEPS } from '@/components/ui/card';

/** The exact string Card has rendered since 6a, for a call site passing nothing. */
const BASELINE =
  'rounded-card border border-border bg-surface-light text-text-primary shadow-card p-6';

/**
 * Reads the class off `render`'s own container rather than a shared
 * `screen` query, so a test may render two Cards and compare them without the
 * second lookup finding both.
 */
function classOf(ui: ReactElement): string {
  const { container } = render(ui);
  return (container.firstElementChild as HTMLElement).className;
}

function tokens(ui: ReactElement): string[] {
  return classOf(ui).split(/\s+/).filter(Boolean);
}

describe('Card - existing defaults are unchanged (hard constraint)', () => {
  it('renders the pre-phase-7 baseline string when no padding prop is passed', () => {
    expect(classOf(<Card />)).toBe(BASELINE);
  });

  it('pad={6} is byte-identical to the implicit default', () => {
    expect(classOf(<Card pad={6} />)).toBe(BASELINE);
  });

  it('padding="md" is byte-identical to the implicit default', () => {
    expect(classOf(<Card padding="md" />)).toBe(BASELINE);
  });

  it.each([
    ['none', 'p-0', 0],
    ['sm', 'p-4', 4],
    ['md', 'p-6', 6],
    ['lg', 'p-8', 8],
  ] as const)(
    'padding="%s" still renders %s, and equals the step it maps to',
    (word, cls, step) => {
      const legacy = classOf(<Card padding={word} />);
      expect(legacy).toContain(cls);
      expect(legacy).toBe(classOf(<Card pad={step} />));
    },
  );

  it('keeps tone, flat and className behaving exactly as before', () => {
    const t = tokens(<Card tone="danger" flat className="mt-4" />);
    expect(t).toContain('bg-danger-surface');
    expect(t).toContain('border-danger-border');
    expect(t).toContain('shadow-none');
    expect(t).toContain('mt-4');
    // className is applied last, so a call site can still win where it must.
    expect(t[t.length - 1]).toBe('mt-4');
  });
});

describe('Card - the pad scale', () => {
  it.each(PAD_STEPS.map((s) => [s] as const))('pad={%s} emits the matching p-N', (step) => {
    expect(tokens(<Card pad={step} />)).toContain(`p-${step}`);
  });

  it('emits exactly one padding class for a uniform pad', () => {
    const pads = tokens(<Card pad={3} />).filter((c) => /^p[trblxy]?-/.test(c));
    expect(pads).toEqual(['p-3']);
  });

  it('pad wins over the deprecated padding alias', () => {
    expect(classOf(<Card pad={3} padding="lg" />)).toBe(classOf(<Card pad={3} />));
  });
});

describe('Card - padX / padY decompose deterministically', () => {
  /**
   * Not a style preference. `cn('p-6', 'px-3')` keeps BOTH classes under
   * tailwind-merge 3.6, which would hand the decision to utility order inside
   * the compiled stylesheet instead of to this component. Card therefore never
   * emits a `p-N` alongside an axis class.
   */
  it('never leaks a uniform p-N next to an axis override', () => {
    const pads = tokens(<Card pad={6} padX={3} />).filter((c) => /^p[trblxy]?-/.test(c));
    expect(pads).toEqual(['px-3', 'py-6']);
  });

  it('padX alone takes pad for the other axis', () => {
    const pads = tokens(<Card padX={2} />).filter((c) => /^p[trblxy]?-/.test(c));
    expect(pads).toEqual(['px-2', 'py-6']);
  });

  it('padY alone takes pad for the other axis', () => {
    const pads = tokens(<Card padY={2} />).filter((c) => /^p[trblxy]?-/.test(c));
    expect(pads).toEqual(['px-6', 'py-2']);
  });

  it('padX + padY ignores pad entirely', () => {
    const pads = tokens(<Card pad={8} padX={3} padY={2} />).filter((c) =>
      /^p[trblxy]?-/.test(c),
    );
    expect(pads).toEqual(['px-3', 'py-2']);
  });
});

describe('Card - the measured clusters are expressible', () => {
  it('p-6 + shadow-card (23 sites) is the default', () => {
    const t = tokens(<Card />);
    expect(t).toContain('p-6');
    expect(t).toContain('shadow-card');
    expect(t).not.toContain('shadow-none');
  });

  it('p-3, no shadow (50 of 56 sites) is pad={3} flat', () => {
    const t = tokens(<Card pad={3} flat />);
    expect(t).toContain('p-3');
    expect(t).toContain('shadow-none');
  });

  it('px-3 py-2, no shadow (19 of 22 sites) is padX={3} padY={2} flat', () => {
    const t = tokens(<Card padX={3} padY={2} flat />);
    expect(t).toEqual(expect.arrayContaining(['px-3', 'py-2', 'shadow-none']));
    expect(t).not.toContain('p-6');
  });
});

describe('Card - the scale stays scannable by Tailwind', () => {
  /**
   * Tailwind reads source TEXT. A templated `p-${step}` would type-check, pass
   * every assertion above, and generate no CSS at all - the class would exist
   * in the DOM and paint nothing. This is the guard against that regression.
   */
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'card.tsx'),
    'utf8',
  );

  it.each(PAD_STEPS.map((s) => [s] as const))(
    'p-%s / px / py appear as literal strings in card.tsx',
    (step) => {
      for (const prefix of ['p', 'px', 'py']) {
        expect(src).toContain(`"${prefix}-${step}"`);
      }
    },
  );

  it('builds no class name by interpolation', () => {
    expect(src).not.toMatch(/["'`]p[xy]?-\$\{/);
  });
});
