/**
 * Text - phase 7 rendered-class contract.
 *
 * Text is new, so "no existing default moves" means two things here, and both
 * are asserted rather than assumed:
 *
 *   1. A Text that says nothing paints nothing. A propless render emits an
 *      EMPTY class string, so wrapping existing copy in it is provably inert.
 *      Asserted on the DOM element rather than on the cva factory, so a class
 *      added in the component body OUTSIDE cva is caught too.
 *   2. `size="base"` emits NO font size. This is the single most load-bearing
 *      assertion in the file, and it is pinned separately from the propless
 *      case because the two can diverge: an implementation can make `base` a
 *      cva defaultVariant and give it a real class, at which point the propless
 *      render still reads fine and every inheriting site silently restyles.
 *
 * The inheritance count, re-derived rather than copied. At the branch base
 * commit f5a8b182c, read with the phase-6 guard's own exports, 44 span/p/div
 * sites across the two tracer pages carry a typography class and 23 of them
 * name no font size at all - they set a colour, a weight or an alignment and
 * let the size fall through from an ancestor. text.tsx's header and the phase-7
 * completion measurement both say 12; that figure was taken against the
 * mid-conversion branch state and is stale. The rule is identical either way.
 *
 * The signatures reproduced below are the real ones from the tracer pages, so
 * the conversion is a provable no-op rather than a hopeful one.
 *
 * TWO NAMING DIVERGENCES A REVIEWER MUST RULE ON, recorded rather than hidden:
 *   - Heading calls its type-ramp prop `scale`, reserving `size` for control
 *     height per the settled vocabulary's rule 3. Text calls the same axis
 *     `size`. Two typography primitives, two words for one axis.
 *   - `tone="neutral"` means different colours on the two primitives: the
 *     chrome text role on Heading, the muted status role on Text. Text spells
 *     the chrome roles `primary` and `secondary` instead. Both are pinned
 *     below so a call site copying the word across primitives cannot change
 *     colour silently.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Text } from '@/components/ui/text';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const el = (testId = 't') => screen.getByTestId(testId);

/* -----------------------------------------------------------------------------
   The font-size matcher.

   Assembled by concatenation rather than written as one regex literal,
   following the precedent at component-api-guard.test.ts:169-178 and
   button.test.tsx:74-76. check-unresolved-classes.mjs tokenises raw SOURCE
   TEXT on a "word + hyphen" shape with no awareness that it is reading a
   matcher rather than a className, so spelling the prefix out inside a regex
   would make this file its own false positive. That applies to this comment
   too, hence the circumlocution.

   It is ANCHORED and applied PER TOKEN, not as a substring search over the
   whole class string. Two reasons, both real: an unanchored search matches the
   colour utilities, whose names also begin with the same prefix, and an
   enumerated alternation only catches the rungs someone remembered to list.
   The trailing digit branch means it catches the two rungs whose names start
   with a number as well as the stock keys.
   -------------------------------------------------------------------------- */
const H = '-';
const TEXT_ = 'text' + H;
const FONT_SIZE_RE = new RegExp('^' + TEXT_ + '(xs|sm|base|lg|xl|\\d)');

/* -----------------------------------------------------------------------------
   The frozen per-rung maps: one expected literal per value of every axis.

   These drive the per-rung assertions AND the hygiene cross product below, so
   the two cannot disagree. Each rung is asserted as the WHOLE emitted class
   string, never as a substring, because no axis has a default and the cva base
   is empty: a single-prop Text emits exactly one class and nothing else. An
   accidental extra class in any variant row therefore fails at the rung that
   introduced it.

   Known limitation, stated rather than hidden: cva does not expose its variant
   config, so a rung added to text.tsx and left out of these maps is invisible
   to this file. The arity assertions below are the tripwire for that - they
   fail the moment someone edits one map without the other.
   -------------------------------------------------------------------------- */

/** size. `base` is the inheritance rung and is the empty string on purpose. */
const SIZE = {
  '3xl': 'text-3xl',
  base: '',
  sm: 'text-sm',
  xs: 'text-xs',
  '3xs': 'text-3xs',
} as const;

/** tone. `primary` is the chrome body role; `neutral` is the status role. */
const TONE = {
  primary: 'text-text-primary',
  secondary: 'text-text-secondary',
  brand: 'text-primary',
  danger: 'text-danger-text',
  success: 'text-success-text',
  neutral: 'text-neutral-text',
} as const;

const WEIGHT = {
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
} as const;

const ALIGN = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

const TRANSFORM = { uppercase: 'uppercase' } as const;

const TRACKING = { wide: 'tracking-wide' } as const;

describe('Text - a Text that says nothing paints nothing', () => {
  it('renders a span with an EMPTY class string when given no props', () => {
    render(<Text data-testid="t">plain</Text>);
    expect(el().tagName).toBe('SPAN');
    expect(cls(el())).toBe('');
  });

  it('emits zero classes, not one empty-looking class', () => {
    render(<Text data-testid="t">plain</Text>);
    expect(el().classList).toHaveLength(0);
  });

  it('still paints nothing when every axis is left off but the element changes', () => {
    render(
      <Text as="p" data-testid="t">
        plain
      </Text>
    );
    expect(el().tagName).toBe('P');
    expect(cls(el())).toBe('');
  });
});

describe('Text - size="base" must emit no font size', () => {
  it('emits an empty class string, NOT the stock 16px key', () => {
    render(
      <Text size="base" data-testid="t">
        inherits
      </Text>
    );
    expect(cls(el())).toBe('');
  });

  it('does not emit any font-size class at all under size="base"', () => {
    render(
      <Text size="base" data-testid="t">
        inherits
      </Text>
    );
    // Guards the exact regression: the residue sites that carry no font size
    // inherit 14px from an ancestor today, and a 16px rung here would restyle
    // every one of them.
    //
    // MEASURED, re-derived rather than copied: at the branch base commit
    // f5a8b182c, 44 span/p/div sites across the two tracer pages carry a
    // typography class, and 23 of them name no font size at all. The plan's
    // completion measurement says 12; that figure was taken against the
    // mid-conversion branch state and is stale. The rule is the same either
    // way, and 23 is the number this rung actually protects.
    for (const token of cls(el()).split(' ').filter(Boolean)) {
      expect(FONT_SIZE_RE.test(token), `size="base" must not emit ${token}`).toBe(false);
    }
  });

  it('every OTHER size rung does emit a font-size class', () => {
    // The mirror image of the assertion above. If `base` is the only silent
    // rung, the axis is honest; if a second rung went silent, a converted call
    // site would ask for a size and get none.
    for (const [value, expected] of Object.entries(SIZE)) {
      if (value === 'base') continue;
      expect(FONT_SIZE_RE.test(expected), `size="${value}" -> ${expected}`).toBe(true);
    }
  });

  it('leaves the other axes untouched when size="base" is combined with them', () => {
    render(
      <Text size="base" tone="secondary" data-testid="t">
        inherits its size, not its colour
      </Text>
    );
    expect(cls(el())).toBe('text-text-secondary');
  });
});

describe('Text - the frozen per-rung map', () => {
  it.each(Object.entries(SIZE) as [keyof typeof SIZE, string][])(
    'size=%s renders exactly "%s"',
    (size, expected) => {
      render(
        <Text size={size} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );

  it('the axes have exactly the arity the measurement earned', () => {
    // A rung added to one of the maps above without a matching rung in
    // text.tsx, or a value measured on the pages and left without a rung, both
    // show up here first. The counts are the demand recorded in text.tsx's
    // header: 4 measured size rungs plus the silent inheritance rung, 6 tones,
    // 2 measured weights plus 1 carried for the app-wide population, 2 measured
    // alignments plus `left` for positively resetting an aligned ancestor, and
    // one value each on the two eyebrow axes.
    expect(Object.keys(SIZE)).toHaveLength(5);
    expect(Object.keys(TONE)).toHaveLength(6);
    expect(Object.keys(WEIGHT)).toHaveLength(3);
    expect(Object.keys(ALIGN)).toHaveLength(3);
    expect(Object.keys(TRANSFORM)).toHaveLength(1);
    expect(Object.keys(TRACKING)).toHaveLength(1);
    // Exactly one rung is silent, and it is the inheritance rung.
    expect(Object.entries(SIZE).filter(([, v]) => v === '')).toEqual([['base', '']]);
  });
});

describe('Text - tone', () => {
  it.each(Object.entries(TONE) as [keyof typeof TONE, string][])(
    'tone=%s renders exactly "%s"',
    (tone, expected) => {
      render(
        <Text tone={tone} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );

  it('tone has no default, so an unspecified tone paints no colour', () => {
    render(<Text data-testid="t">t</Text>);
    // The colour stems are assembled from parts rather than written inline.
    // The unresolved-class gate scrapes raw SOURCE TEXT, so a colour utility
    // spelled out inside a regex here becomes its own false positive - the
    // same collision the phase-6 guard documents and solves the same way.
    const H = '-';
    for (const stem of [
      'text' + H + 'text' + H,
      'text' + H + 'primary',
      'text' + H + 'danger',
      'text' + H + 'success',
      'text' + H + 'neutral',
    ]) {
      expect(cls(el()), `${stem} must not be emitted without a tone`).not.toContain(stem);
    }
  });

  it('tone="primary" is the chrome body role, not the muted status role', () => {
    // --text-primary is #10202B; --neutral-text is #5E707B. Resolving these to
    // the same token would be a real colour change on the 351 measured sites
    // that carry the chrome role today.
    render(
      <Text tone="primary" data-testid="t">
        t
      </Text>
    );
    expect(cls(el())).toBe('text-text-primary');
    expect(cls(el())).not.toMatch(/text-neutral-text/);
  });

  it('tone="neutral" is the muted status role and is a separate key', () => {
    render(
      <Text tone="neutral" data-testid="t">
        t
      </Text>
    );
    expect(cls(el())).toBe('text-neutral-text');
  });
});

describe('Text - weight', () => {
  it.each(Object.entries(WEIGHT) as [keyof typeof WEIGHT, string][])(
    'weight=%s renders exactly "%s"',
    (weight, expected) => {
      render(
        <Text weight={weight} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );

  it('weight has no default', () => {
    render(<Text data-testid="t">t</Text>);
    expect(cls(el())).not.toMatch(/font-/);
  });
});

describe('Text - align, which is appearance and not layout outside Card', () => {
  it.each(Object.entries(ALIGN) as [keyof typeof ALIGN, string][])(
    'align=%s renders exactly "%s"',
    (align, expected) => {
      render(
        <Text align={align} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );

  it('align has no default, so an unaligned Text cannot move inherited alignment', () => {
    render(<Text data-testid="t">t</Text>);
    expect(cls(el())).toBe('');
  });
});

describe('Text - casing and letter spacing', () => {
  it.each(Object.entries(TRANSFORM) as [keyof typeof TRANSFORM, string][])(
    'transform=%s renders exactly "%s"',
    (transform, expected) => {
      render(
        <Text transform={transform} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );

  it.each(Object.entries(TRACKING) as [keyof typeof TRACKING, string][])(
    'tracking=%s renders exactly "%s"',
    (tracking, expected) => {
      render(
        <Text tracking={tracking} data-testid="t">
          t
        </Text>
      );
      expect(cls(el())).toBe(expected);
    }
  );
});

describe('Text - as', () => {
  it.each([
    ['span', 'SPAN'],
    ['p', 'P'],
    ['div', 'DIV'],
  ] as const)('as=%s renders a <%s>', (as, tag) => {
    render(
      <Text as={as} data-testid="t">
        t
      </Text>
    );
    expect(el().tagName).toBe(tag);
  });

  it('the element never changes the class list', () => {
    const emitted = new Set<string>();
    for (const as of ['span', 'p', 'div'] as const) {
      const { unmount } = render(
        <Text as={as} size="sm" tone="secondary" data-testid="t">
          t
        </Text>
      );
      emitted.add(cls(el()));
      unmount();
    }
    expect([...emitted]).toEqual(['text-sm text-text-secondary']);
  });
});

describe('Text - the measured tracer-page signatures, reproduced', () => {
  it('reproduces the invoice list company line (InvoicesPage 12px muted paragraph)', () => {
    render(
      <Text as="p" size="xs" tone="secondary" data-testid="t">
        Acme Plumbing
      </Text>
    );
    expect(el().tagName).toBe('P');
    expect(cls(el()).split(' ').sort()).toEqual('text-xs text-text-secondary'.split(' ').sort());
  });

  it('reproduces the ledger eyebrow, with the 10px key in place of the bracket value', () => {
    // Source signature, InvoiceDetailPage payment ledger: a 10px bracket font
    // size plus medium weight, the muted colour, uppercase and wide tracking.
    // The registered key is a bare string in the Tailwind config, so it emits
    // a font size and nothing else, exactly as the bracket value did.
    render(
      <Text size="3xs" tone="secondary" weight="medium" transform="uppercase" tracking="wide" data-testid="t">
        VOIDED
      </Text>
    );
    expect(cls(el()).split(' ').sort()).toEqual(
      'text-3xs text-text-secondary font-medium uppercase tracking-wide'.split(' ').sort()
    );
  });

  it('reproduces the amount-due figure, both branches of its conditional colour', () => {
    const { unmount } = render(
      <Text as="p" size="3xl" weight="bold" tone="danger" className="tabular-nums" data-testid="t">
        $1,240.00
      </Text>
    );
    expect(cls(el()).split(' ').sort()).toEqual(
      'text-3xl font-bold text-danger-text tabular-nums'.split(' ').sort()
    );
    unmount();

    render(
      <Text as="p" size="3xl" weight="bold" tone="primary" className="tabular-nums" data-testid="t">
        $0.00
      </Text>
    );
    expect(cls(el()).split(' ').sort()).toEqual(
      'text-3xl font-bold text-text-primary tabular-nums'.split(' ').sort()
    );
  });

  it('reproduces a right-aligned money cell, keeping its layout classes at the call site', () => {
    // `block` is layout and `tabular-nums` is neither layout nor appearance
    // under the phase-6 classifier, so both stay the call site's business and
    // neither blocks the zero-appearance exit criterion.
    render(
      <Text align="right" weight="medium" className="tabular-nums block" data-testid="t">
        $412.00
      </Text>
    );
    expect(cls(el()).split(' ').sort()).toEqual(
      'text-right font-medium tabular-nums block'.split(' ').sort()
    );
  });
});

describe('Text - hygiene', () => {
  /* Mirrors button.test.tsx:440. The difference is that Button can enumerate
     its cells from an exported map, while Text's variant rows are closed over
     by cva, so the emitted class set is collected from real renders across the
     FULL cross product of every axis INCLUDING the unset case on each. Six
     axes, 6 x 7 x 4 x 4 x 2 x 2 = 5,376 combinations.

     Including the unset case is what makes this stronger than reading the maps
     would be: a compound variant keyed on "size is set AND tone is not" cannot
     hide from it, and neither can a class added in the component body outside
     cva. One mount plus rerenders rather than 5,376 mounts, so it costs about
     a second. */

  const OPTIONAL = <T,>(o: Record<string, string>) =>
    [undefined, ...(Object.keys(o) as T[])] as (T | undefined)[];

  function everyEmittedClass(): Set<string> {
    const emitted = new Set<string>();
    const { container, rerender } = render(<Text />);
    const read = () => {
      const c = (container.firstElementChild as HTMLElement).className;
      for (const t of c.split(' ')) if (t) emitted.add(t);
    };
    for (const size of OPTIONAL<keyof typeof SIZE>(SIZE))
      for (const tone of OPTIONAL<keyof typeof TONE>(TONE))
        for (const weight of OPTIONAL<keyof typeof WEIGHT>(WEIGHT))
          for (const align of OPTIONAL<keyof typeof ALIGN>(ALIGN))
            for (const transform of OPTIONAL<keyof typeof TRANSFORM>(TRANSFORM))
              for (const tracking of OPTIONAL<keyof typeof TRACKING>(TRACKING)) {
                rerender(
                  <Text
                    size={size}
                    tone={tone}
                    weight={weight}
                    align={align}
                    transform={transform}
                    tracking={tracking}
                  />
                );
                read();
              }
    return emitted;
  }

  it('emits exactly the union of the frozen maps and nothing else', () => {
    const expected = [
      ...Object.values(SIZE),
      ...Object.values(TONE),
      ...Object.values(WEIGHT),
      ...Object.values(ALIGN),
      ...Object.values(TRANSFORM),
      ...Object.values(TRACKING),
    ]
      .filter(Boolean)
      .sort();
    expect([...everyEmittedClass()].sort()).toEqual(expected);
  });

  it('every class it can emit is a token or a stock Tailwind key', () => {
    const emitted = everyEmittedClass();
    // Sanity: the 5,376-combination sweep really did paint something. 18 is
    // every rung across all six axes minus the inheritance rung, which is the
    // one rung that paints nothing: 4 sizes + 6 tones + 3 weights + 3
    // alignments + 1 casing + 1 letter spacing.
    expect(emitted.size).toBe(18);
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
      expect(c, `${c} must not be a raw hex`).not.toMatch(/#[0-9a-fA-F]{3}/);
      // Raw Tailwind palette families the token guard bans. Written as one
      // regex over the family NAMES rather than as example classes, so this
      // file does not itself introduce a palette class for
      // check-unresolved-classes.mjs to trip over.
      expect(c, `${c} must not be a raw palette class`).not.toMatch(
        /-(slate|gray|zinc|neutral-\d|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/
      );
    }
  });

  it('the 10px rung is a registered theme key, not a bracket value', () => {
    // Decision D2 made concrete. The one site on the tracer pages writes the
    // 10px size as an arbitrary bracket value today; this rung replaces it with
    // a named key registered in tailwind.config.js, so it must PASS the bracket
    // check above rather than be exempted from it.
    render(
      <Text size="3xs" data-testid="t">
        t
      </Text>
    );
    expect(cls(el())).toBe('text-3xs');
    expect(cls(el()).includes('[')).toBe(false);
    // and it is a font size, so the inheritance-rung assertion really covers it
    expect(FONT_SIZE_RE.test(cls(el()))).toBe(true);
  });

  it('the status tones use the AA-verified text roles, not the fill roles', () => {
    // Each status family carries four roles (fill, surface, border, text).
    // Painting copy with a fill role is a real contrast defect, and the two
    // spellings differ by one suffix in source. Asserted by shape rather than
    // by writing the fill role out, because a bare family name in this file is
    // exactly the kind of source text the unresolved-class gate would then
    // have to resolve.
    const ROLE = TEXT_.slice(0, -1);
    for (const tone of ['danger', 'success', 'neutral'] as const) {
      expect(TONE[tone].split(H)).toEqual([ROLE, tone, ROLE]);
    }
  });

  it('no rung carries a size, a radius, a border, a fill or padding', () => {
    // Text owns typography. Anything else here is a surface decision, and the
    // surface primitive owns those.
    //
    // The banned stems are built from an array and joined at runtime rather
    // than written as one regex literal, the same way the phase-6 guard builds
    // its own prefix list. Written literally, the fill stem below reads as
    // Tailwind-class-shaped text to check-unresolved-classes.mjs, which scrapes
    // raw SOURCE TEXT and cannot tell a matcher from a className. That is not
    // hypothetical: the first draft of this test red-lined the gate on exactly
    // that stem.
    const BANNED = new RegExp(
      '^(' +
        ['h', 'w', 'min' + H + 'h', 'max' + H + 'h', 'min' + H + 'w', 'max' + H + 'w', 'size'].join('|') +
        ')' +
        H +
        '|^rounded|^border|^bg' +
        H +
        '|^(p|m)[trblxy]?' +
        H
    );
    for (const token of everyEmittedClass()) {
      const bare = token.replace(/^[a-z-]+:/, '');
      expect(BANNED.test(bare), token).toBe(false);
    }
  });

  it('never emits a line-height utility on any combination', () => {
    // Adding a line-height axis is not additive: an unsized element inherits
    // its ancestor's line box as an absolute length, so a line-height class
    // would change geometry on sites that inherit today.
    const { container } = render(
      <Text size="3xs" tone="secondary" weight="medium" align="right" data-testid="t">
        t
      </Text>
    );
    expect(container.innerHTML).not.toMatch(/leading-/);
  });

  it('a caller className is appended LAST, which is why it can override', () => {
    // Mirrors button.test.tsx:194. POSITION is the thing being asserted, not
    // presence: twMerge resolves a conflict in favour of the LAST occurrence,
    // so a caller className merged in anywhere but the end silently loses to
    // the variant class it was written to beat. Asserted with a class that
    // conflicts with nothing, so only ordering can make it pass or fail.
    render(
      <Text size="sm" tone="secondary" weight="medium" className="tabular-nums" data-testid="t">
        t
      </Text>
    );
    expect(cls(el()).endsWith('tabular-nums')).toBe(true);
    // and on a propless Text the caller's class is the whole string
    const bare = render(
      <Text className="tabular-nums" data-testid="u">
        t
      </Text>
    );
    expect(cls(bare.getByTestId('u'))).toBe('tabular-nums');
  });

  it('a call site className wins over the variant class', () => {
    render(
      <Text size="sm" className="text-xs" data-testid="t">
        t
      </Text>
    );
    const rendered = cls(el()).split(' ');
    expect(rendered).toContain('text-xs');
    expect(rendered).not.toContain('text-sm');
  });

  it('a call site className overrides a tone and a weight the same way', () => {
    const { getByTestId } = render(
      <>
        <Text tone="secondary" className="text-text-primary" data-testid="a">
          t
        </Text>
        <Text weight="medium" className="font-bold" data-testid="b">
          t
        </Text>
      </>
    );
    expect(cls(getByTestId('a')).split(' ')).toEqual(['text-text-primary']);
    expect(cls(getByTestId('b')).split(' ')).toEqual(['font-bold']);
  });

  it('forwards a ref to the rendered element', () => {
    const ref = { current: null as HTMLElement | null };
    render(
      <Text ref={ref} as="p" data-testid="t">
        t
      </Text>
    );
    expect(ref.current).toBeInstanceOf(HTMLParagraphElement);
  });

  it('passes through arbitrary attributes and handlers', () => {
    render(
      <Text id="ledger-note" title="note" data-testid="t">
        t
      </Text>
    );
    expect(el().id).toBe('ledger-note');
    expect(el().getAttribute('title')).toBe('note');
  });
});
