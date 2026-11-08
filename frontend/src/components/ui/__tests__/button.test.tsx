/* =============================================================================
   Button - rendered-class contract
   -----------------------------------------------------------------------------
   This file does two things:

     1. FROZEN BASELINE. Pins the rendered `class` attribute of all 13 minted
        cells x all 4 original `size` values - 52 strings - to the exact bytes
        the component has always emitted for those pairs, reached through the
        current variant x tone API. If any of these 52 change, real shipped
        call sites changed with them, and the change is a regression unless it
        was deliberate.

        The sweep is driven by PRE_7A_SIZES, a hand-written list of exactly
        those four names - NOT by the keys of BASELINE_SIZE. 7b added rungs to
        the component, and letting a new rung widen this sweep would silently
        change what the frozen contract means. New rungs get NEW tests (see
        the 7b block), never a widened old one.

     2. GRID INTEGRITY. Asserts the minted cells are exactly the ones the W1
        vocabulary settled on, that unminted pairs degrade safely, and that the
        traps the vocabulary called out (ghost/neutral has no idle colour,
        outline/neutral carries a white fill, revealOnHover is a modifier not a
        tone) still hold.

   PHASE 12C. Through phase 11, this file also pinned nine DEPRECATED ALIASES
   (`destructive`, `ghostDestructiveReveal`, and seven others) as byte-
   identical to the variant+tone pair each one aliased, and asked the
   TypeScript language service to prove a call site writing one of those names
   got a real `reportsDeprecated` diagnostic - the mechanism that let phase 11
   convert ~2,000 call sites in bulk with a compiler-verified safety net. Phase
   12c deleted the alias table from button.tsx once every real call site was
   converted, so both of those test classes are gone: there is nothing left to
   prove equivalent, and `ButtonVariant` no longer HAS a deprecated member for
   the language service to flag. What survives from that era is a single,
   much lighter compile-time check at the bottom of this file, in the
   `// @ts-expect-error` idiom this codebase already uses elsewhere (see
   chip.test.tsx) - proving a deleted alias name is now a hard type error,
   without the language-service probe that used to be needed to detect a
   `@deprecated` suggestion diagnostic instead of a compile error.

   Baseline provenance, stated precisely because a reviewer will rely on it:
   the fragments in BASE, BASELINE_VARIANT and BASELINE_SIZE were transcribed
   from the pre-7a `button.tsx` source at `f5a8b182c`, minus the `dark:` tokens
   deleted by 7c (a rendered no-op - nothing ever applied the `dark` class).
   The 52 expected strings are COMPOSED from those fragments at test time, not
   stored one by one; the concatenation order is pinned separately by two rows
   spelled out in full (`solid/brand` and `ghost/danger#reveal`), since cva
   emits one fixed key order for every row. BASELINE_VARIANT is keyed by CELL
   name (`solid/brand`, not the pre-7a flat name `default`) so it stays
   readable against the current API, but the class-string VALUES are the same
   untouched transcription phase 7a's version of this file used - nothing
   about the rendered CSS changed when the aliases were deleted, only the
   names that could reach it.

   Consequence for review: the baseline matches the post-dark-strip state, not
   f5a8b182c byte for byte, and both edits landed in `button.tsx`, so git
   cannot attribute the two apart. Read the dark-strip and the recomposition as
   one change.

   Do NOT regenerate these strings from the current component - that would make
   the test assert that the code equals itself.
   ============================================================================= */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import {
  Button,
  buttonVariants,
  resolveButtonCell,
  BUTTON_CELL_CLASSES,
  DEFAULT_TONE,
  type ButtonProps,
  type ButtonVariant,
  type ButtonTone,
  type ButtonSize,
  type ButtonCell,
} from '../button';

// Assembled by concatenation rather than written as one literal, following the
// precedent in component-api-guard.test.ts. check-unresolved-classes.mjs
// tokenises raw SOURCE TEXT on a "word + hyphen" shape with no awareness that
// it is reading a matcher rather than a className, so spelling the font-size
// prefix out in the assertions below makes it the guard's own false positive.
// That applies to this comment too - hence the circumlocution.
const H = '-';
const TEXT_ = 'text' + H;
const FONT_SIZE_RE = new RegExp('^' + TEXT_ + '(xs|sm|base|lg|xl|\\d)');

/** Render a Button and return the class attribute the DOM actually receives. */
function renderedClass(props: Record<string, unknown>): string {
  const { container, unmount } = render(<Button {...props}>x</Button>);
  const cls = (container.firstElementChild as HTMLElement).className;
  unmount();
  return cls;
}

/* -----------------------------------------------------------------------------
   The frozen baseline.

   BASE is the shared cva base string. Each row below is
   `cell -> colour classes`, and each size is `base + colour + size`, in
   that order. Writing it as a composition rather than 52 literal blobs keeps
   the file readable while still pinning every byte: the composition is
   asserted against the literal full string for one row (`solid/brand`) so the
   helper itself cannot drift.
   -------------------------------------------------------------------------- */

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button ' +
  'text-sm font-semibold ring-offset-surface-light transition-colors duration-200 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ' +
  '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

/** Pre-7a size classes, verbatim. Note `rounded-button` really is repeated on
 *  sm/lg: it is also in BASE, and twMerge does not treat the project's custom
 *  radius key as a conflict group, so both survive into the DOM. Deleting the
 *  duplicate would be a rendered no-op but NOT a byte-identical one. */
const BASELINE_SIZE: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-button px-3',
  lg: 'h-11 rounded-button px-8',
  icon: 'h-10 w-10',

  /* --- added by 7b. ADDITIVE ONLY: these are here so the map stays total over
     ButtonSize and so the new tests have something to assert against. They are
     deliberately NOT part of the 52-string sweep above. --- */

  // `md` is the settled vocabulary's name for today's default geometry, and is
  // the same cva string, so it is a true synonym rather than a lookalike.
  md: 'h-10 px-4 py-2',
  // The 24px rung. 5 shipped call sites write these exact three classes as a
  // className override on top of `size="sm"`.
  '3xs': 'h-6 px-2 text-xs',
};

/** Cell -> colour classes, verbatim, captured from the frozen pre-7a cva. */
const BASELINE_VARIANT: Record<ButtonCell, string> = {
  'solid/brand': 'bg-primary text-on-fill hover:bg-primary-dark',
  'solid/business': 'bg-sage-700 text-on-fill hover:bg-sage-700/90',
  'solid/ai': 'bg-gradient-to-br from-ai-600 to-ai-500 text-on-fill hover:opacity-90',
  'solid/danger': 'bg-danger text-on-fill hover:bg-danger/90',
  'solid/neutral': 'bg-border-soft text-text-primary hover:bg-border',
  'outline/neutral':
    'border border-border bg-surface-light hover:bg-background-light hover:text-text-primary',
  'outline/danger':
    'border border-danger/40 text-danger hover:bg-danger/10 hover:text-danger',
  'ghost/neutral': 'hover:bg-background-light hover:text-text-primary',
  'ghost/subtle': 'text-text-secondary hover:bg-background-light hover:text-text-primary',
  'ghost/danger': 'text-danger hover:bg-danger/10 hover:text-danger',
  'ghost/danger#reveal': 'text-text-secondary hover:bg-danger/10 hover:text-danger',
  'link/brand': 'text-primary underline-offset-4 hover:underline',
  onDark: 'text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill',
};

/**
 * The 13 minted cells, and the (variant, tone, revealOnHover) that reaches
 * each one - the single source both the frozen-baseline sweep and the grid-
 * integrity block below iterate, so there is exactly one place that claims to
 * enumerate "the whole grid".
 */
const MINTED_CELL_PARAMS: Array<{
  cell: ButtonCell;
  variant: ButtonVariant;
  tone?: ButtonTone;
  revealOnHover?: true;
}> = [
  { cell: 'solid/brand', variant: 'solid', tone: 'brand' },
  { cell: 'solid/business', variant: 'solid', tone: 'business' },
  { cell: 'solid/ai', variant: 'solid', tone: 'ai' },
  { cell: 'solid/danger', variant: 'solid', tone: 'danger' },
  { cell: 'solid/neutral', variant: 'solid', tone: 'neutral' },
  { cell: 'outline/neutral', variant: 'outline', tone: 'neutral' },
  { cell: 'outline/danger', variant: 'outline', tone: 'danger' },
  { cell: 'ghost/neutral', variant: 'ghost', tone: 'neutral' },
  { cell: 'ghost/subtle', variant: 'ghost', tone: 'subtle' },
  { cell: 'ghost/danger', variant: 'ghost', tone: 'danger' },
  { cell: 'ghost/danger#reveal', variant: 'ghost', tone: 'danger', revealOnHover: true },
  { cell: 'link/brand', variant: 'link', tone: 'brand' },
  { cell: 'onDark', variant: 'onDark' },
];

const MINTED_CELLS: ButtonCell[] = MINTED_CELL_PARAMS.map((p) => p.cell);

/**
 * The four sizes that shipped before 7b, written out by hand rather than read
 * off BASELINE_SIZE. Everything below that claims to pin "the frozen bytes"
 * iterates THIS list, so adding a rung to the component can never quietly
 * enlarge - or shrink - the frozen contract.
 */
const PRE_7A_SIZES: ButtonSize[] = ['default', 'sm', 'lg', 'icon'];

/** The rungs 7b adds. Covered by their own tests, never by the sweep. */
const POST_7A_SIZES: ButtonSize[] = ['md', '3xs'];

const baseline = (cell: ButtonCell, size: ButtonSize) =>
  `${BASE} ${BASELINE_VARIANT[cell]} ${BASELINE_SIZE[size]}`;

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */

describe('Button - frozen baseline (52 cell x size combinations)', () => {
  it('the baseline composition helper matches a hand-written full literal', () => {
    // Anchors BASE + BASELINE_VARIANT + BASELINE_SIZE against one fully
    // spelled-out string, so a typo in the helper cannot silently rebase all 52.
    expect(baseline('solid/brand', 'default')).toBe(
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-semibold ring-offset-surface-light transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-on-fill hover:bg-primary-dark h-10 px-4 py-2'
    );
    expect(baseline('ghost/danger#reveal', 'sm')).toBe(
      'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-button text-sm font-semibold ring-offset-surface-light transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-text-secondary hover:bg-danger/10 hover:text-danger h-9 rounded-button px-3'
    );
  });

  it('covers all 13 minted cells x all 4 sizes (52 combinations)', () => {
    expect(MINTED_CELLS).toHaveLength(13);
    expect(PRE_7A_SIZES).toHaveLength(4);
    expect(MINTED_CELLS.length * PRE_7A_SIZES.length).toBe(52);
  });

  for (const { cell, variant, tone, revealOnHover } of MINTED_CELL_PARAMS) {
    for (const size of PRE_7A_SIZES) {
      it(`cell "${cell}" size="${size}" renders the byte-identical frozen class string`, () => {
        expect(renderedClass({ variant, tone, revealOnHover, size })).toBe(baseline(cell, size));
      });
    }
  }

  it('the implicit default (no variant, no size) is unchanged', () => {
    expect(renderedClass({})).toBe(baseline('solid/brand', 'default'));
  });

  it('a call-site className is still appended last, so twMerge overrides win', () => {
    // 47 shipped sites pass a geometry override this way (e.g. h-6 px-2 text-xs).
    const cls = renderedClass({ variant: 'ghost', size: 'sm', className: 'h-6 px-2 text-xs' });
    expect(cls.endsWith('h-6 px-2 text-xs')).toBe(true);
    expect(cls).not.toContain('h-9');
    expect(cls).not.toContain('px-3');
  });

  it('variant={null} still emits no colour classes (pre-7a cva behaviour)', () => {
    expect(renderedClass({ variant: null, size: 'default' })).toBe(
      `${BASE} ${BASELINE_SIZE.default}`
    );
  });

  it('size={null} still emits no size classes (pre-7a cva behaviour)', () => {
    expect(renderedClass({ size: null })).toBe(`${BASE} ${BASELINE_VARIANT['solid/brand']}`);
  });

  it('asChild renders the child element carrying the same class string', () => {
    const { container } = render(
      <Button asChild variant="outline" size="sm">
        <a href="/x">x</a>
      </Button>
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe('A');
    expect(el.className).toBe(baseline('outline/neutral', 'sm'));
  });

  it('buttonVariants() produces the same string the component renders', () => {
    for (const { cell, variant, tone, revealOnHover } of MINTED_CELL_PARAMS) {
      for (const size of PRE_7A_SIZES) {
        expect(buttonVariants({ variant, tone, revealOnHover, size })).toBe(baseline(cell, size));
      }
    }
  });
});

/* ========================================================================== */

describe('Button - grid integrity', () => {
  it('mints exactly the cells the W1 vocabulary settled on - no more, no fewer', () => {
    expect(Object.keys(BUTTON_CELL_CLASSES).sort()).toEqual([...MINTED_CELLS].sort());
  });

  it('every minted cell is reachable through variant x tone and renders non-empty', () => {
    for (const cell of MINTED_CELLS) {
      expect(BUTTON_CELL_CLASSES[cell].length).toBeGreaterThan(0);
    }
    for (const { cell, variant, tone, revealOnHover } of MINTED_CELL_PARAMS) {
      expect(resolveButtonCell(variant, tone, revealOnHover)).toBe(cell);
    }
  });

  it('omitting variant means solid; omitting tone means the structure default', () => {
    expect(DEFAULT_TONE).toEqual({
      solid: 'brand',
      outline: 'neutral',
      ghost: 'neutral',
      link: 'brand',
    });
    expect(resolveButtonCell(undefined, undefined)).toBe('solid/brand');
    expect(resolveButtonCell('solid')).toBe('solid/brand');
    expect(resolveButtonCell('outline')).toBe('outline/neutral');
    expect(resolveButtonCell('ghost')).toBe('ghost/neutral');
    expect(resolveButtonCell('link')).toBe('link/brand');
  });

  it('onDark is a context, not a tone - unreachable through variant x tone', () => {
    expect(resolveButtonCell('onDark')).toBe('onDark');
    // There is no `tone="onDark"` and no `solid/onDark` cell.
    expect(Object.keys(BUTTON_CELL_CLASSES).filter((k) => k.includes('/onDark'))).toEqual([]);
  });

  it('an unminted pair falls back to the structure default and shouts in dev', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // `success` is published in the vocabulary but deliberately not minted in 7a.
    expect(resolveButtonCell('solid', 'success' as ButtonTone)).toBe('solid/brand');
    expect(resolveButtonCell('outline', 'ai' as ButtonTone)).toBe('outline/neutral');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toContain('no cell is minted');
  });

  it('revealOnHover is a modifier, not a tone, and only exists where minted', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ghost + danger has a reveal cell, so the modifier applies silently.
    expect(resolveButtonCell('ghost', 'danger', true)).toBe('ghost/danger#reveal');
    // There is no `tone="reveal"`.
    expect(Object.keys(BUTTON_CELL_CLASSES)).not.toContain('ghost/reveal');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('an unminted revealOnHover pair degrades to the plain cell AND says so', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ghost + neutral has no reveal cell. The plain pair IS minted, so the
    // button still renders correctly - but the prop the caller set did
    // nothing, and a prop that does nothing has to say so rather than vanish.
    expect(resolveButtonCell('ghost', 'neutral', true)).toBe('ghost/neutral');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('revealOnHover had no effect');
    // The message names the cell that would have to be minted to honour it.
    expect(warnSpy.mock.calls[0]?.[0]).toContain('ghost/neutral#reveal');
    // Not an error: nothing rendered wrong, only the modifier was dropped.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('the dropped-modifier warning also fires through the rendered component', () => {
    // The defect this guards: `<Button variant="ghost" revealOnHover>` with no
    // tone used to render the plain ghost button in total silence.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(renderedClass({ variant: 'ghost', revealOnHover: true })).toBe(
      baseline('ghost/neutral', 'default')
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('revealOnHover had no effect');
  });

  it('a prototype-chain name is not mistaken for a minted cell', () => {
    // `key in obj` answers true for everything on Object.prototype, so an own-
    // property check guards the BUTTON_CELL_CLASSES lookup against a
    // structure/tone pair that happens to collide with an inherited name
    // (`constructor`, `toString`, `valueOf`). Unreachable through the typed
    // API today, closed anyway.
    expect(resolveButtonCell('constructor' as ButtonVariant)).toBe('solid/brand');
    expect(resolveButtonCell('toString' as ButtonVariant)).toBe('solid/brand');
    expect(resolveButtonCell('valueOf' as ButtonVariant)).toBe('solid/brand');
  });

  it('TRAP: ghost/neutral sets no idle colour (50 call sites inherit it)', () => {
    const cls = BUTTON_CELL_CLASSES['ghost/neutral'];
    expect(cls).toBe('hover:bg-background-light hover:text-text-primary');
    expect(cls.split(' ').every((t) => t.startsWith('hover:'))).toBe(true);
  });

  it('TRAP: outline/neutral carries a real white fill and no idle text colour (202 sites)', () => {
    const cls = BUTTON_CELL_CLASSES['outline/neutral'];
    expect(cls).toContain('bg-surface-light');
    expect(cls.split(' ').filter((t) => t.startsWith(TEXT_))).toEqual([]);
  });

  it('TRAP: outline/danger has no fill, so it is not outline/neutral + a colour', () => {
    expect(BUTTON_CELL_CLASSES['outline/danger']).not.toContain('bg-surface-light');
  });

  it('deferred cells are absent, not silently aliased (soft, success, warning, info)', () => {
    const keys = Object.keys(BUTTON_CELL_CLASSES);
    expect(keys.filter((k) => k.startsWith('soft/'))).toEqual([]);
    expect(keys.filter((k) => k.endsWith('/success'))).toEqual([]);
    expect(keys.filter((k) => k.endsWith('/warning'))).toEqual([]);
    expect(keys.filter((k) => k.endsWith('/info'))).toEqual([]);
  });

  it('no cell carries a size, a radius or a font size - those are other axes', () => {
    for (const [cell, classes] of Object.entries(BUTTON_CELL_CLASSES)) {
      for (const token of classes.split(' ')) {
        const bare = token.replace(/^[a-z-]+:/, '');
        expect(/^(h|w|min-h|max-h|size)-/.test(bare), `${cell}: ${token}`).toBe(false);
        expect(/^rounded/.test(bare), `${cell}: ${token}`).toBe(false);
        expect(FONT_SIZE_RE.test(bare), `${cell}: ${token}`).toBe(false);
      }
    }
  });

  it('no cell uses a raw hex, a raw Tailwind palette class, or a bracket value', () => {
    // The one deliberate exception is `sage-700` on solid/business: a Tier-1
    // primitive that survives until `--business` is minted in tokens.css.
    // It is asserted explicitly here so it cannot be forgotten.
    const PALETTE =
      /^(bg|text|border|from|to|via|ring|divide|outline)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    for (const [cell, classes] of Object.entries(BUTTON_CELL_CLASSES)) {
      expect(classes, cell).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      for (const token of classes.split(' ')) {
        const bare = token.replace(/^[a-z-]+:/, '');
        expect(PALETTE.test(bare), `${cell}: ${token}`).toBe(false);
        expect(bare.includes('['), `${cell}: ${token}`).toBe(false);
      }
    }
    expect(BUTTON_CELL_CLASSES['solid/business']).toContain('bg-sage-700');
  });

  it('sizes are untouched by 7a and "default" is still the default geometry', () => {
    // Deliberately over PRE_7A_SIZES: this is the pre-7a claim, and 7b's rungs
    // get their own version of it below.
    expect(renderedClass({ size: 'default' })).toBe(renderedClass({}));
    for (const size of PRE_7A_SIZES) {
      expect(renderedClass({ size }).endsWith(BASELINE_SIZE[size])).toBe(true);
    }
  });
});

/* ========================================================================== */

/* -----------------------------------------------------------------------------
   7b - the two rungs the size ladder gains.

   Both are ADDITIVE. Nothing above this line changes: `defaultVariants.size`
   is still `default`, the 52 frozen strings are still swept over exactly the
   four pre-7a sizes, and no shipped call site renders differently until it is
   converted by hand.

     md   the settled vocabulary's name for today's default geometry. Same cva
          string, so the two names are interchangeable byte for byte.
     3xs  the 24px rung. 5 shipped Button sites already render it, by writing
          the three classes as a className override on top of `size="sm"`.
   -------------------------------------------------------------------------- */

/** What the shipped call sites write today, verbatim. */
const CALL_SITE_OVERRIDE_24PX = 'h-6 px-2 text-xs';

/**
 * The two 24px sites on the tracer pages, with the tone each one asks for.
 * `no-underline` at the InvoiceDetailPage site is deliberately excluded: it is
 * a caller concern (that Button sits inside link-styled table copy), not part
 * of the rung, so the rung must not absorb it.
 */
const RUNG_24PX_CALL_SITES: Array<{ tone: ButtonTone; where: string }> = [
  { tone: 'subtle', where: 'InvoicesPage "Clear all"' },
  { tone: 'danger', where: 'InvoiceDetailPage "Void"' },
];

describe('Button 7b - the 24px rung and the md synonym', () => {
  it('the new rungs are additive: the sweep still covers exactly the pre-7a four', () => {
    // If a rung is ever added to ButtonSize without being listed here, the map
    // literal stops type-checking and this equality fails - so a new rung can
    // neither slip into the frozen sweep nor slip past it unnoticed.
    expect([...PRE_7A_SIZES, ...POST_7A_SIZES].sort()).toEqual(
      Object.keys(BASELINE_SIZE).sort()
    );
    expect(PRE_7A_SIZES).toHaveLength(4);
    expect(BASELINE_SIZE['3xs']).toBe(CALL_SITE_OVERRIDE_24PX);
  });

  /* WHY SET EQUALITY AND NOT STRING EQUALITY, for the 24px pairs below.
     Today's string carries the project's custom radius class TWICE - once from
     the cva base and once from the `sm` rung, which restates it - and
     tailwind-merge does not collapse the pair, because the project's radius key
     is not a value tailwind-merge recognises as belonging to its radius
     conflict group. The `3xs` rung does not restate it, so it appears once.
     One duplicate of a class that is already applied paints nothing, so the
     rendered result is identical while the byte string is not. The next test
     pins that the duplicate is the ONLY difference, so "set equality" cannot
     quietly absorb a second, real one. */

  for (const { tone, where } of RUNG_24PX_CALL_SITES) {
    it(`size="3xs" renders the same class SET as today's override (${where})`, () => {
      const today = renderedClass({
        variant: 'ghost',
        tone,
        size: 'sm',
        className: CALL_SITE_OVERRIDE_24PX,
      });
      const proposed = renderedClass({ variant: 'ghost', tone, size: '3xs' });
      expect(new Set(proposed.split(' '))).toEqual(new Set(today.split(' ')));
    });
  }

  it('the ONLY difference is the one duplicated radius class', () => {
    const today = renderedClass({
      variant: 'ghost',
      tone: 'subtle',
      size: 'sm',
      className: CALL_SITE_OVERRIDE_24PX,
    });
    const proposed = renderedClass({ variant: 'ghost', tone: 'subtle', size: '3xs' });
    expect(today).not.toBe(proposed);

    const RADIUS = 'rounded' + H + 'button';
    const tokens = today.split(' ');
    expect(tokens.filter((t) => t === RADIUS)).toHaveLength(2);
    expect(proposed.split(' ').filter((t) => t === RADIUS)).toHaveLength(1);

    // Drop the second copy and the two strings are byte-identical, token order
    // included. That is a much stronger statement than set equality alone.
    const last = tokens.lastIndexOf(RADIUS);
    expect([...tokens.slice(0, last), ...tokens.slice(last + 1)].join(' ')).toBe(proposed);
  });

  it('the base font size loses to the rung font size, in both spellings', () => {
    // The rung carries its own font size, so tailwind-merge deletes the base
    // one. It deletes it from the MIDDLE of the string, which is why the
    // endsWith invariant below still holds.
    const SM = TEXT_ + 'sm';
    const XS = TEXT_ + 'xs';
    for (const cls of [
      renderedClass({ variant: 'ghost', tone: 'subtle', size: '3xs' }),
      renderedClass({
        variant: 'ghost',
        tone: 'subtle',
        size: 'sm',
        className: CALL_SITE_OVERRIDE_24PX,
      }),
    ]) {
      expect(cls.split(' ')).not.toContain(SM);
      expect(cls.split(' ')).toContain(XS);
    }
  });

  it('the new rungs also end with their own size classes', () => {
    // The 7a invariant, restated for the rungs it deliberately excludes. `3xs`
    // does satisfy it - measured, not assumed: the class the rung overrides
    // sits in the base, not at the tail.
    for (const size of POST_7A_SIZES) {
      expect(renderedClass({ size }).endsWith(BASELINE_SIZE[size]), size).toBe(true);
    }
  });

  it('size="md" is a true synonym of size="default" - byte-identical', () => {
    // Byte equality is the right assertion here, unlike the 24px pair: both
    // names resolve to the identical cva string, so there is nothing for
    // tailwind-merge to reconcile.
    expect(renderedClass({ size: 'md' })).toBe(renderedClass({ size: 'default' }));
    expect(renderedClass({ size: 'md' })).toBe(baseline('solid/brand', 'default'));
    expect(buttonVariants({ size: 'md' })).toBe(buttonVariants({ size: 'default' }));
  });

  it('adding the rungs did not move the default - it is still "default"', () => {
    // The one way this change could touch all 504 sites at once.
    expect(renderedClass({})).toBe(baseline('solid/brand', 'default'));
    expect(renderedClass({}).endsWith(BASELINE_SIZE.default)).toBe(true);
  });

  it('the rungs are reachable through buttonVariants too, not just the component', () => {
    for (const size of POST_7A_SIZES) {
      expect(buttonVariants({ size })).toContain(BASELINE_SIZE[size]);
    }
  });
});

/* ========================================================================== */

describe('Button 12c - the deleted alias names are hard type errors now', () => {
  it('a deleted alias name no longer type-checks', () => {
    // @ts-expect-error - "destructive" was the deprecated alias for
    // variant="solid" tone="danger"; phase 12c deleted it from ButtonVariant
    const destructive: ButtonProps['variant'] = 'destructive';
    // @ts-expect-error - "ghostDestructiveReveal" was the deprecated alias for
    // variant="ghost" tone="danger" revealOnHover; deleted in phase 12c
    const ghostDestructiveReveal: ButtonProps['variant'] = 'ghostDestructiveReveal';
    // @ts-expect-error - "default" was the deprecated alias for the bare-Button
    // default (solid/brand); omit the prop entirely instead
    const defaultAlias: ButtonProps['variant'] = 'default';

    expect([destructive, ghostDestructiveReveal, defaultAlias]).toEqual([
      'destructive',
      'ghostDestructiveReveal',
      'default',
    ]);
  });

  it('an arbitrary unknown string is still rejected, not just the old alias names', () => {
    // @ts-expect-error - never a valid variant, old or new
    const notAVariant: ButtonProps['variant'] = 'notAVariant';
    expect(notAVariant).toBe('notAVariant');
  });

  it('the four surviving structures still type-check cleanly', () => {
    const solid: ButtonProps['variant'] = 'solid';
    const outline: ButtonProps['variant'] = 'outline';
    const ghost: ButtonProps['variant'] = 'ghost';
    const link: ButtonProps['variant'] = 'link';
    const onDark: ButtonProps['variant'] = 'onDark';
    expect([solid, outline, ghost, link, onDark]).toEqual([
      'solid',
      'outline',
      'ghost',
      'link',
      'onDark',
    ]);
  });
});
