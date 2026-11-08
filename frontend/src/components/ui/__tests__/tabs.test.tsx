/**
 * Tabs - phase 7 rendered-class contract.
 *
 * Tabs shipped four exports and three variant axes (2 surfaces, 2 list
 * variants, 4 trigger variants) with no test at all, so nothing in the tree
 * held them still. This file freezes every one of those strings BEFORE the
 * spacing axis is added, because the hard constraint on this phase is that a
 * call site passing no new prop renders exactly what it rendered before.
 * That is why the first three blocks assert the literal class string rather
 * than a loose containment check: a containment check cannot see a class that
 * was added, and "added a class" is precisely the failure mode being guarded.
 *
 * WHY THE HARNESS. Radix Tabs is a controlled compound. TabsContent renders
 * nothing unless the root carries a matching value, so a harness mistake
 * yields an empty tree and every assertion below it passes vacuously. Every
 * block therefore asserts the element EXISTS, and asserts its tag name, before
 * it asserts anything about its class.
 *
 * WHY THE SPACING MAPS ARE IMPORTED RATHER THAN RETYPED. Tailwind's scanner
 * reads source text, so a padding class assembled at runtime from a prefix and
 * a step number emits no CSS and the element silently renders flat. Asserting
 * against the literal held in design-system/spacing.ts, which spacing.test.ts
 * separately proves is physically present in that file's source, is what keeps
 * this test honest about that.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  PAD,
  PAD_BOTTOM,
  PAD_LEFT,
  PAD_RIGHT,
  PAD_STEPS,
  PAD_TOP,
  PAD_X,
  PAD_Y,
  type PadProps,
  type PadStep,
} from '@/design-system/spacing';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type TabsListVariant,
  type TabsSurface,
  type TabsTriggerVariant,
} from '@/components/ui/tabs';

// --- helpers -----------------------------------------------------------------

/** The raw class attribute, never `.className`, so an absent attribute is visible. */
const cls = (el: Element): string => el.getAttribute('class') ?? '';

const tokensOf = (el: Element): string[] => cls(el).split(/\s+/).filter(Boolean);

/** Order-independent comparison. `cn` composes in slot order, which is not a contract. */
const tokenSet = (el: Element): Set<string> => new Set(tokensOf(el));

/** Any padding utility, on any of the seven shapes the vocabulary can emit. */
const PADDING_RE = /^p[xytrbl]?-/;

const get = (id: string): HTMLElement => {
  const el = screen.getByTestId(id);
  expect(el).toBeTruthy();
  return el;
};

// --- the frozen baseline -----------------------------------------------------
//
// Copied by hand out of tabs.tsx at the phase-7 base commit. Deliberately NOT
// imported from the component: a baseline that reads its expectation out of the
// thing it is testing can never fail.

const TRIGGER_BASE =
  'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';

const SURFACE_BASELINE: Record<TabsSurface, string> = {
  plain: '',
  card: 'rounded-card border border-border bg-surface-light shadow-card',
};

const LIST_BASELINE: Record<TabsListVariant, string> = {
  line: 'flex items-center gap-[26px] border-b border-border',
  pill: 'flex items-center gap-[26px] bg-background-light',
};

const TRIGGER_BASELINE: Record<TabsTriggerVariant, string> = {
  line:
    TRIGGER_BASE +
    ' -mb-px border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary' +
    ' data-[state=active]:border-primary data-[state=active]:text-text-primary',
  underline:
    TRIGGER_BASE +
    ' relative border-b-[3px] border-transparent text-sm font-medium text-text-secondary' +
    ' hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary' +
    ' data-[state=active]:font-semibold',
  'underline-fill':
    TRIGGER_BASE +
    ' group text-sm text-text-secondary font-medium hover:text-text-primary' +
    ' hover:bg-background-light/50 data-[state=active]:text-primary' +
    ' data-[state=active]:font-semibold',
  pill:
    TRIGGER_BASE +
    ' rounded text-xs font-bold text-text-secondary' +
    ' data-[state=active]:bg-primary-subtle data-[state=active]:text-primary',
};

const CONTENT_BASELINE =
  'mt-2 ring-offset-surface-light focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-primary focus-visible:ring-offset-2';

/** The bar span that `variant="underline-fill"` wraps its children in. */
const UNDERLINE_FILL_BAR_BASELINE =
  'relative inline-flex flex-col items-center py-3 after:absolute after:bottom-0 ' +
  'after:inset-x-0 after:h-0.5 after:rounded-full after:bg-transparent ' +
  'after:transition-colors group-data-[state=active]:after:bg-primary';

/**
 * The four per-side props, each with the single literal it must emit. Written
 * as whole PadProps objects rather than a computed key so the compiler checks
 * every entry - a typo in a prop name would otherwise land silently in an
 * index signature and the test would assert nothing.
 */
const SIDES: Array<[string, PadProps, string]> = [
  ['padTop', { padTop: 2 }, PAD_TOP[2]],
  ['padRight', { padRight: 2 }, PAD_RIGHT[2]],
  ['padBottom', { padBottom: 2 }, PAD_BOTTOM[2]],
  ['padLeft', { padLeft: 2 }, PAD_LEFT[2]],
];

const SURFACES: TabsSurface[] = ['plain', 'card'];
const LIST_VARIANTS: TabsListVariant[] = ['line', 'pill'];
const TRIGGER_VARIANTS: TabsTriggerVariant[] = ['line', 'underline', 'underline-fill', 'pill'];

/**
 * TabsTrigger padX/padY - W2, corrected 2026-07-30. A prior pass on this file
 * shipped this axis as a `size` prop on a bespoke xs/sm/md/lg scale, which
 * mislabelled a padding shape as control height (see tabs.tsx's own header
 * comment for the full correction). The fix reuses padX/padY instead - the
 * three measured pairs below are copied by hand out of tabs.tsx, same
 * reasoning as the rest of this file's frozen baseline: a baseline that reads
 * its expectation out of the thing it is testing can never fail.
 */
const TRIGGER_PAD_BASELINE: Record<'xs' | 'sm' | 'lg', { padX: PadStep; padY: PadStep; classes: string }> = {
  xs: { padX: 3, padY: 1.5, classes: 'px-3 py-1.5' },
  sm: { padX: 3, padY: 2, classes: 'px-3 py-2' },
  lg: { padX: 5, padY: 3, classes: 'px-5 py-3' },
};

const TRIGGER_PAD_RUNGS: Array<'xs' | 'sm' | 'lg'> = ['xs', 'sm', 'lg'];

// --- harness -----------------------------------------------------------------

type ListExtras = PadProps;
type ContentExtras = PadProps;

/**
 * A complete, valid Tabs tree with a value that matches, so TabsContent is
 * actually mounted. `defaultValue` and the trigger/content value are the same
 * literal on purpose - the risk this harness exists to defuse is a mismatch
 * that renders nothing and makes every assertion vacuous.
 */
function Harness({
  surface,
  listVariant,
  triggerVariant,
  triggerPadX,
  triggerPadY,
  listProps,
  contentProps,
  listClassName,
  contentClassName,
}: {
  surface?: TabsSurface;
  listVariant?: TabsListVariant;
  triggerVariant?: TabsTriggerVariant;
  triggerPadX?: PadStep;
  triggerPadY?: PadStep;
  listProps?: ListExtras;
  contentProps?: ContentExtras;
  listClassName?: string;
  contentClassName?: string;
}) {
  return (
    <Tabs defaultValue="alpha" surface={surface} data-testid="root">
      <TabsList
        data-testid="list"
        variant={listVariant}
        className={listClassName}
        {...(listProps as object)}
      >
        <TabsTrigger
          data-testid="trigger"
          value="alpha"
          variant={triggerVariant}
          padX={triggerPadX}
          padY={triggerPadY}
        >
          <b data-testid="label">Alpha</b>
        </TabsTrigger>
      </TabsList>
      <TabsContent
        data-testid="content"
        value="alpha"
        className={contentClassName}
        {...(contentProps as object)}
      >
        <i data-testid="body">Body</i>
      </TabsContent>
    </Tabs>
  );
}

// =============================================================================
// 1. THE HARNESS ITSELF
// =============================================================================

describe('Tabs - the harness renders a real tree', () => {
  it('mounts all four exports, so no assertion below is vacuous', () => {
    render(<Harness />);
    expect(screen.queryByTestId('root')).not.toBeNull();
    expect(screen.queryByTestId('list')).not.toBeNull();
    expect(screen.queryByTestId('trigger')).not.toBeNull();
    expect(screen.queryByTestId('content')).not.toBeNull();
  });

  it('mounts the content body, which Radix omits entirely on a value mismatch', () => {
    render(<Harness />);
    expect(screen.queryByTestId('body')).not.toBeNull();
    expect(screen.getByTestId('body').textContent).toBe('Body');
  });

  it('renders the trigger as a button and marks it active', () => {
    render(<Harness />);
    expect(get('trigger').tagName).toBe('BUTTON');
    expect(get('trigger').getAttribute('data-state')).toBe('active');
  });
});

// =============================================================================
// 2. FROZEN BASELINE - every export, every shipped variant, propless included
// =============================================================================

describe('Tabs root - frozen surface baseline', () => {
  it('renders no class at all when no surface prop is passed', () => {
    render(<Harness />);
    expect(get('root').tagName).toBe('DIV');
    expect(cls(get('root'))).toBe(SURFACE_BASELINE.plain);
  });

  it.each(SURFACES)('surface=%s renders its frozen string', (surface) => {
    render(<Harness surface={surface} />);
    expect(screen.queryByTestId('root')).not.toBeNull();
    expect(cls(get('root'))).toBe(SURFACE_BASELINE[surface]);
  });

  it('propless is byte-identical to the explicit plain surface', () => {
    const { container: implicit } = render(<Harness />);
    const { container: explicit } = render(<Harness surface="plain" />);
    expect(cls(implicit.querySelector('[data-testid="root"]')!)).toBe(
      cls(explicit.querySelector('[data-testid="root"]')!)
    );
  });
});

describe('TabsList - frozen variant baseline', () => {
  it('renders the line variant when no variant prop is passed', () => {
    render(<Harness />);
    expect(screen.queryByTestId('list')).not.toBeNull();
    expect(cls(get('list'))).toBe(LIST_BASELINE.line);
  });

  it.each(LIST_VARIANTS)('variant=%s renders its frozen string', (variant) => {
    render(<Harness listVariant={variant} />);
    expect(screen.queryByTestId('list')).not.toBeNull();
    expect(cls(get('list'))).toBe(LIST_BASELINE[variant]);
  });

  it('carries no padding utility of any kind by default', () => {
    render(<Harness />);
    expect(tokensOf(get('list')).filter((t) => PADDING_RE.test(t))).toEqual([]);
  });
});

describe('TabsTrigger - frozen variant baseline', () => {
  it('renders the line variant when no variant prop is passed', () => {
    render(<Harness />);
    expect(screen.queryByTestId('trigger')).not.toBeNull();
    expect(cls(get('trigger'))).toBe(TRIGGER_BASELINE.line);
  });

  it.each(TRIGGER_VARIANTS)('variant=%s renders its frozen string', (variant) => {
    render(<Harness triggerVariant={variant} />);
    expect(screen.queryByTestId('trigger')).not.toBeNull();
    expect(cls(get('trigger'))).toBe(TRIGGER_BASELINE[variant]);
  });

  it.each(TRIGGER_VARIANTS)('variant=%s keeps the shared base string intact', (variant) => {
    render(<Harness triggerVariant={variant} />);
    const set = tokenSet(get('trigger'));
    for (const token of TRIGGER_BASE.split(/\s+/)) {
      expect(set.has(token)).toBe(true);
    }
  });
});

// =============================================================================
// 2b. TABSTRIGGER `padX` / `padY` AXIS (W2, corrected 2026-07-30)
//
// A prior pass shipped this axis as a `size` prop on a bespoke xs/sm/md/lg
// scale - wrong per the settled vocabulary (rule 1: size means control
// height, pad/gap means spacing, never a second word for either; rule 3:
// size never means anything but control height). This is a padding shape,
// so it is tested here as padX/padY, the same PadProps vocabulary
// TabsList/TabsContent already carry - see tabs.tsx's own header comment for
// the full correction.
//
// UNPADDED HAS TO EMIT NOTHING: TabsTrigger bakes in zero component-level
// padding today, across every TRIGGER_VARIANT, so a padding class emitted
// with no padX/padY passed would restyle every one of the 37 real call
// sites at once. The first block below is what pins that down as a
// contract rather than an accident - a propless trigger and an explicit
// padX={undefined} padY={undefined} trigger have to render the exact same
// bytes, for every variant, not just "line".
//
// THE ONE TRAP IN THIS SECTION, written down so a reviewer does not "fix" it.
// `variant="line"` (the default) bakes its OWN padding-bottom class, pb-2.5,
// used as an underline offset, not as content padding - unrelated to this
// axis and pre-dating this session. It is real-world dead weight for
// padX/padY: none of the 37 measured call sites use variant="line" with a
// pad (the evidence table above ties every measured pair to "underline" or
// "pill", and neither of those variants carries any padding class of its
// own). padX/padY combined with variant="line" therefore has
// tailwind-merge's own conflict rule take pb-2.5 out in favour of the py-*
// value passed - expected engine behaviour, not a regression, and out of
// scope to prevent since no measured site does this combination. The blocks
// below test padX/padY against the variants the evidence actually ties them
// to.
// =============================================================================

describe('TabsTrigger - pad axis, unpadded is a render-neutral default', () => {
  it('a propless trigger renders byte-identical to one with padX/padY explicitly undefined', () => {
    const { container: propless } = render(<Harness />);
    const { container: explicitUndefined } = render(
      <Harness triggerPadX={undefined} triggerPadY={undefined} />
    );
    expect(cls(propless.querySelector('[data-testid="trigger"]')!)).toBe(
      cls(explicitUndefined.querySelector('[data-testid="trigger"]')!)
    );
  });

  it.each(TRIGGER_VARIANTS)(
    'variant=%s with no padX/padY still renders its frozen string',
    (variant) => {
      render(<Harness triggerVariant={variant} />);
      expect(screen.queryByTestId('trigger')).not.toBeNull();
      expect(cls(get('trigger'))).toBe(TRIGGER_BASELINE[variant]);
    }
  );

  it('adds no padding utility of its own when unpadded on a padding-clean variant', () => {
    render(<Harness triggerVariant="underline" />);
    expect(tokensOf(get('trigger')).filter((t) => PADDING_RE.test(t))).toEqual([]);
  });
});

describe('TabsTrigger - pad axis, each measured pair emits its padding set', () => {
  // The variant each pair's measured evidence actually pairs with (see the
  // header comment's cluster table) - both are padding-clean, so padX/padY's
  // tokens are the only padding-shaped tokens either can produce.
  const EVIDENCE_VARIANT: Record<'xs' | 'sm' | 'lg', TabsTriggerVariant> = {
    xs: 'pill',
    sm: 'underline',
    lg: 'underline',
  };

  it.each(TRIGGER_PAD_RUNGS)('the %s pair emits exactly its frozen padding tokens', (rung) => {
    const { padX, padY } = TRIGGER_PAD_BASELINE[rung];
    render(<Harness triggerVariant={EVIDENCE_VARIANT[rung]} triggerPadX={padX} triggerPadY={padY} />);
    expect(screen.queryByTestId('trigger')).not.toBeNull();
    const expected = TRIGGER_PAD_BASELINE[rung].classes.split(/\s+/).filter(Boolean);
    expect(tokensOf(get('trigger')).filter((t) => PADDING_RE.test(t))).toEqual(expected);
  });

  it.each(TRIGGER_PAD_RUNGS)('the %s pair keeps the shared base string intact', (rung) => {
    const { padX, padY } = TRIGGER_PAD_BASELINE[rung];
    render(<Harness triggerPadX={padX} triggerPadY={padY} />);
    const set = tokenSet(get('trigger'));
    for (const token of TRIGGER_BASE.split(/\s+/)) {
      expect(set.has(token)).toBe(true);
    }
  });

  it.each(TRIGGER_PAD_RUNGS)('the %s pair keeps every token of its evidence variant baseline', (rung) => {
    const variant = EVIDENCE_VARIANT[rung];
    const { padX, padY } = TRIGGER_PAD_BASELINE[rung];
    render(<Harness triggerVariant={variant} triggerPadX={padX} triggerPadY={padY} />);
    const set = tokenSet(get('trigger'));
    for (const token of TRIGGER_BASELINE[variant].split(/\s+/)) {
      expect(set.has(token)).toBe(true);
    }
  });

  it('padX={5} padY={3} reproduces what JobDetailPage/LeadDetailPage render today', () => {
    render(<Harness triggerVariant="underline" triggerPadX={5} triggerPadY={3} />);
    const set = tokenSet(get('trigger'));
    expect(set.has('px-5')).toBe(true);
    expect(set.has('py-3')).toBe(true);
  });

  it('padX={3} padY={2} reproduces what PriceBookPage/VendorsPage render today', () => {
    render(<Harness triggerVariant="underline" triggerPadX={3} triggerPadY={2} />);
    const set = tokenSet(get('trigger'));
    expect(set.has('px-3')).toBe(true);
    expect(set.has('py-2')).toBe(true);
  });

  it('padX={3} padY={1.5} reproduces what PriceBookPicker renders today', () => {
    render(<Harness triggerVariant="pill" triggerPadX={3} triggerPadY={1.5} />);
    const set = tokenSet(get('trigger'));
    expect(set.has('px-3')).toBe(true);
    expect(set.has('py-1.5')).toBe(true);
  });
});

describe('TabsContent - frozen baseline', () => {
  it('renders its one frozen string', () => {
    render(<Harness />);
    expect(screen.queryByTestId('content')).not.toBeNull();
    expect(cls(get('content'))).toBe(CONTENT_BASELINE);
  });

  it('carries no padding utility of any kind by default', () => {
    render(<Harness />);
    expect(tokensOf(get('content')).filter((t) => PADDING_RE.test(t))).toEqual([]);
  });
});

// =============================================================================
// 3. THE UNDERLINE-FILL WRAPPER SPAN
//
// One of the four trigger variants wraps its children in an extra span that
// paints the active bar. Nothing pinned that today, so deleting the wrapper, or
// growing it onto a second variant, was a silent change. Both directions are
// asserted here.
// =============================================================================

describe('TabsTrigger - the underline-fill wrapper span', () => {
  const wrapperOf = (): Element | null => {
    const label = screen.queryByTestId('label');
    return label ? label.parentElement : null;
  };

  it('variant="underline-fill" wraps children in the bar span', () => {
    render(<Harness triggerVariant="underline-fill" />);
    const wrapper = wrapperOf();
    expect(wrapper).not.toBeNull();
    expect(wrapper!.tagName).toBe('SPAN');
    expect(cls(wrapper!)).toBe(UNDERLINE_FILL_BAR_BASELINE);
  });

  it('variant="underline-fill" keeps the children inside that span', () => {
    render(<Harness triggerVariant="underline-fill" />);
    expect(get('label').textContent).toBe('Alpha');
    expect(wrapperOf()!.parentElement).toBe(get('trigger'));
  });

  const BARE: TabsTriggerVariant[] = ['line', 'underline', 'pill'];

  it.each(BARE)('variant=%s does NOT wrap its children', (variant) => {
    render(<Harness triggerVariant={variant} />);
    expect(screen.queryByTestId('label')).not.toBeNull();
    expect(wrapperOf()).toBe(get('trigger'));
  });

  it('the propless trigger does NOT wrap its children', () => {
    render(<Harness />);
    expect(screen.queryByTestId('label')).not.toBeNull();
    expect(wrapperOf()).toBe(get('trigger'));
  });

  it('only one of the four variants renders the bar span', () => {
    let wrapped = 0;
    for (const variant of TRIGGER_VARIANTS) {
      const { container, unmount } = render(<Harness triggerVariant={variant} />);
      const label = container.querySelector('[data-testid="label"]');
      expect(label).not.toBeNull();
      if (label!.parentElement!.tagName === 'SPAN') wrapped += 1;
      unmount();
    }
    expect(wrapped).toBe(1);
  });
});

// =============================================================================
// 4. THE PAD AXES
//
// Each prop emits the literal held in design-system/spacing.ts, and only that
// literal. A propless export emits nothing, which is what keeps the 57 shipped
// TabsContent and 18 shipped TabsList call sites rendering what they render.
// =============================================================================

describe('TabsContent - pad axes emit the spacing literals', () => {
  it.each(PAD_STEPS as readonly PadStep[])('pad={%s} emits the shorthand literal', (step) => {
    render(<Harness contentProps={{ pad: step }} />);
    expect(screen.queryByTestId('content')).not.toBeNull();
    expect(tokensOf(get('content')).filter((t) => PADDING_RE.test(t))).toEqual([PAD[step]]);
  });

  it('pad={0} survives the falsy trap', () => {
    render(<Harness contentProps={{ pad: 0 }} />);
    expect(tokenSet(get('content')).has(PAD[0])).toBe(true);
  });

  it('padX and padY name both axes', () => {
    render(<Harness contentProps={{ padX: 3, padY: 6 }} />);
    const set = tokenSet(get('content'));
    expect(set.has(PAD_X[3])).toBe(true);
    expect(set.has(PAD_Y[6])).toBe(true);
  });

  it.each(SIDES)('%s={2} emits one side literal and nothing else', (_name, props, expected) => {
    render(<Harness contentProps={props} />);
    expect(screen.queryByTestId('content')).not.toBeNull();
    expect(tokensOf(get('content')).filter((t) => PADDING_RE.test(t))).toEqual([expected]);
  });

  it('pad={4} reproduces what InvoiceDetailPage renders on its four tab panels today', () => {
    render(<Harness contentProps={{ pad: 4 }} />);
    const viaProp = tokenSet(get('content'));
    expect(viaProp.has('p-4')).toBe(true);
    expect(viaProp.has(PAD[4])).toBe(true);
  });

  it('the padded panel keeps every token of the frozen baseline', () => {
    render(<Harness contentProps={{ pad: 4 }} />);
    const set = tokenSet(get('content'));
    for (const token of CONTENT_BASELINE.split(/\s+/)) {
      expect(set.has(token)).toBe(true);
    }
  });
});

describe('TabsList - pad axes emit the spacing literals', () => {
  it.each(PAD_STEPS as readonly PadStep[])('pad={%s} emits the shorthand literal', (step) => {
    render(<Harness listProps={{ pad: step }} />);
    expect(screen.queryByTestId('list')).not.toBeNull();
    expect(tokensOf(get('list')).filter((t) => PADDING_RE.test(t))).toEqual([PAD[step]]);
  });

  it.each(SIDES)('%s={2} emits one side literal and nothing else', (_name, props, expected) => {
    render(<Harness listProps={props} />);
    expect(screen.queryByTestId('list')).not.toBeNull();
    expect(tokensOf(get('list')).filter((t) => PADDING_RE.test(t))).toEqual([expected]);
  });

  it('a padded list keeps its variant tokens', () => {
    render(<Harness listVariant="pill" listProps={{ pad: 1 }} />);
    const set = tokenSet(get('list'));
    for (const token of LIST_BASELINE.pill.split(/\s+/)) {
      expect(set.has(token)).toBe(true);
    }
  });
});

// =============================================================================
// 5. THE INVOICEDETAILPAGE:905 RECONSTRUCTION
//
// This one call site is the whole reason the spacing vocabulary grew a per-side
// step. The rail is padded on its top side alone, sitting inside a padless
// Card. Expressed with the published pad/padX/padY vocabulary the nearest
// reachable form is padY, which also pads the BOTTOM by 8px - a rendered
// change, which this phase forbids outright. The absence assertions below are
// therefore the point of the block, not decoration.
//
// ONE MEASURED CORRECTION TO THE BRIEF, recorded here because it changes what
// the assertions say. The brief predicted the emitted set would be the base
// plus the variant plus the horizontal-axis literal and the top-side literal.
// It is not. spacing.ts branch 3 is deliberate: as soon as ANY per-side prop is
// set, every resolvable side is named individually, so the horizontal axis
// expands into its left and right halves. The reason is written out in that
// file - tailwind-merge 3.6 does not treat an axis class as overriding an
// earlier shorthand, so mixing the two spellings hands the outcome to utility
// order inside the compiled stylesheet instead of to the component.
//
// The expansion is a rendered no-op: the horizontal-axis utility is DEFINED as
// exactly its two side utilities, same property, same value, and neither side
// is also named by a shorthand here for order to matter. The phase constraint
// is on rendered geometry, not on the literal class string, so the constraint
// holds. The block below asserts the true expanded form, and separately
// asserts the two halves resolve to the same step as the axis they replace.
// =============================================================================

describe('TabsList - InvoiceDetailPage:905, the per-side proof', () => {
  const LAYOUT = 'w-full justify-start';
  const SITE: PadProps = { padX: 4, padTop: 2 };

  /** Just the padding utilities, in emission order. */
  const paddingOf = (el: Element): string[] =>
    tokensOf(el).filter((t) => PADDING_RE.test(t));

  it('padX={4} padTop={2} emits base plus variant plus the per-side expansion', () => {
    render(<Harness listProps={SITE} />);
    expect(screen.queryByTestId('list')).not.toBeNull();
    const expected = new Set([
      ...LIST_BASELINE.line.split(/\s+/),
      PAD_TOP[2],
      PAD_RIGHT[4],
      PAD_LEFT[4],
    ]);
    expect(tokenSet(get('list'))).toEqual(expected);
  });

  it('the two horizontal halves carry the same step as the axis they replace', () => {
    // The axis literal and its two side literals are the same property and the
    // same value, which is why the expansion paints nothing new.
    expect(PAD_X[4]).toBe('px-4');
    expect(PAD_LEFT[4]).toBe('pl-4');
    expect(PAD_RIGHT[4]).toBe('pr-4');
  });

  it('emits NO bottom padding - the reason the vocabulary was amended', () => {
    render(<Harness listProps={SITE} />);
    expect(paddingOf(get('list')).filter((t) => /^pb-/.test(t))).toEqual([]);
  });

  it('emits NO vertical-axis shorthand, which would have padded both sides', () => {
    render(<Harness listProps={SITE} />);
    expect(paddingOf(get('list')).filter((t) => /^py-/.test(t))).toEqual([]);
  });

  it('emits NO uniform shorthand either', () => {
    render(<Harness listProps={SITE} />);
    expect(paddingOf(get('list')).filter((t) => /^p-/.test(t))).toEqual([]);
  });

  it('emits exactly three padding utilities, no more', () => {
    render(<Harness listProps={SITE} />);
    expect(paddingOf(get('list')).slice().sort()).toEqual(
      [PAD_TOP[2], PAD_RIGHT[4], PAD_LEFT[4]].slice().sort()
    );
  });

  it('padY={2} would have padded the bottom, which is what the per-side prop avoids', () => {
    // The counter-example, asserted rather than asserted-about. This is the
    // rendered change the amendment exists to prevent.
    render(<Harness listProps={{ padX: 4, padY: 2 }} />);
    expect(tokenSet(get('list')).has(PAD_Y[2])).toBe(true);
  });

  it('the converted call site changes nothing outside the padding utilities', () => {
    // Today the className carries layout AND padding together. Converted, the
    // padding moves to props and only layout stays in className. Everything
    // that is not a padding utility has to be the identical set.
    const { container: today, unmount } = render(
      <Harness listClassName={`${LAYOUT} px-4 pt-2`} />
    );
    const listToday = today.querySelector('[data-testid="list"]')!;
    const beforePadding = paddingOf(listToday).slice().sort();
    const beforeRest = new Set(tokensOf(listToday).filter((t) => !PADDING_RE.test(t)));
    unmount();

    render(<Harness listClassName={LAYOUT} listProps={SITE} />);
    const after = get('list');
    expect(new Set(tokensOf(after).filter((t) => !PADDING_RE.test(t)))).toEqual(beforeRest);
    expect(beforePadding).toEqual(['pt-2', 'px-4']);
    expect(paddingOf(after).slice().sort()).toEqual(['pl-4', 'pr-4', 'pt-2']);
  });

  it('the converted call site still carries its layout classes', () => {
    render(<Harness listClassName={LAYOUT} listProps={SITE} />);
    const set = tokenSet(get('list'));
    expect(set.has('w-full')).toBe(true);
    expect(set.has('justify-start')).toBe(true);
  });
});
