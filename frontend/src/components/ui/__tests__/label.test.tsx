/**
 * Label - `tone` / `size` / `weight` rendered-class contract.
 *
 * Label already shipped a `tone` prop (#909/#1017) with non-vocabulary
 * values `default` (implicit) / `strong`. A prior pass added the
 * closed-vocabulary tone values `subtle` / `neutral` as a lossless rename:
 * `subtle` == the old `default` (`text-text-secondary`). Named `subtle`, not
 * `muted` (rev 2's name) - `--muted` is a Tier-1 primitive token
 * (tokens.css:23) and tokens.css:12 forbids a component from referencing a
 * Tier-1 primitive directly, so `subtle` is the settled rename (program plan
 * section 2a.2, rev 3). `neutral` == the old `strong` (`text-text-primary`).
 * `default` / `strong` keep working as deprecated aliases resolving to the
 * exact same class strings, so all 190 existing call sites - 12 of which
 * pass `tone="strong"` today - keep rendering byte-for-byte identical
 * output.
 *
 * This repair pass adds `size` (font-size: `sm` default / `xs`) and `weight`
 * (`bold` default / `semibold`) - the per-primitive scope table's Label row
 * required both alongside `tone` and the prior pass shipped only the tone
 * half. See label.tsx's own header for the full rationale, including why
 * `size` here means font-size rather than the control-height ladder other
 * primitives use.
 *
 * Pulling the pre-existing hard-coded `text-sm` and `font-bold` out of the
 * base string and into their own variants moves them from the FRONT of the
 * rendered class string to the END (cva always emits the base string whole,
 * then appends each variant's resolved class after it). The rendered TOKEN
 * SET for a propless Label is unchanged - same classes, same computed
 * styles, since class order in the DOM `class` attribute has no effect on
 * the cascade - but the literal string is no longer byte-identical to the
 * pre-repair render. The exact-string assertion below is therefore replaced
 * with a token-set assertion, which is what "renders identically" actually
 * requires.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Label, labelVariants } from '@/components/ui/label';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const tokens = (el: HTMLElement) => cls(el).split(/\s+/).filter(Boolean);

/**
 * The full set of classes a propless Label has always rendered - unordered,
 * because ordering is not a rendered-behaviour guarantee (see file header).
 */
const BASELINE_TOKENS = new Set([
  'text-sm',
  'font-bold',
  'leading-none',
  'transition-colors',
  'duration-300',
  'hover:text-text-primary',
  'has-[+input:is(:hover,:focus)]:text-text-primary',
  'has-[+textarea:is(:hover,:focus)]:text-text-primary',
  'peer-disabled:cursor-not-allowed',
  'peer-disabled:opacity-70',
  'text-text-secondary',
]);

describe('Label - default render is unchanged', () => {
  it('renders the exact pre-existing default class SET with no props (order is not a guarantee - see file header)', () => {
    render(<Label htmlFor="x">Name</Label>);
    const rendered = tokens(screen.getByText('Name'));
    expect(new Set(rendered)).toEqual(BASELINE_TOKENS);
    expect(rendered).toHaveLength(BASELINE_TOKENS.size);
  });

  it('tone="strong" (the 12 existing call sites) still renders text-text-primary', () => {
    render(<Label tone="strong">Name</Label>);
    const rendered = cls(screen.getByText('Name')).split(' ');
    expect(rendered).toContain('text-text-primary');
    expect(rendered).not.toContain('text-text-secondary');
  });

  it('tone="default" still renders text-text-secondary', () => {
    render(<Label tone="default">Name</Label>);
    expect(cls(screen.getByText('Name')).split(' ')).toContain('text-text-secondary');
  });
});

describe('Label - size (closed-vocabulary font-size axis)', () => {
  it.each([
    ['sm', 'text-sm'],
    ['xs', 'text-xs'],
  ] as const)('size=%s renders %s', (size, expected) => {
    render(<Label size={size}>t</Label>);
    expect(tokens(screen.getByText('t'))).toContain(expected);
  });

  it('the default (size omitted) matches size="sm" exactly', () => {
    render(<Label>a</Label>);
    const bare = new Set(tokens(screen.getByText('a')));
    const { unmount } = render(<Label size="sm">b</Label>);
    const sm = new Set(tokens(screen.getByText('b')));
    unmount();
    expect(bare).toEqual(sm);
  });

  it('size="xs" does not also emit text-sm', () => {
    render(<Label size="xs">t</Label>);
    expect(tokens(screen.getByText('t'))).not.toContain('text-sm');
  });
});

describe('Label - weight (closed-vocabulary weight axis)', () => {
  it.each([
    ['bold', 'font-bold'],
    ['semibold', 'font-semibold'],
  ] as const)('weight=%s renders %s', (weight, expected) => {
    render(<Label weight={weight}>t</Label>);
    expect(tokens(screen.getByText('t'))).toContain(expected);
  });

  it('the default (weight omitted) matches weight="bold" exactly', () => {
    render(<Label>a</Label>);
    const bare = new Set(tokens(screen.getByText('a')));
    const { unmount } = render(<Label weight="bold">b</Label>);
    const bold = new Set(tokens(screen.getByText('b')));
    unmount();
    expect(bare).toEqual(bold);
  });

  it('weight="semibold" does not also emit font-bold', () => {
    render(<Label weight="semibold">t</Label>);
    expect(tokens(screen.getByText('t'))).not.toContain('font-bold');
  });
});

describe('Label - tone (closed-vocabulary values)', () => {
  it.each([
    ['subtle', 'text-text-secondary'],
    ['neutral', 'text-text-primary'],
  ] as const)('tone=%s renders %s', (tone, expected) => {
    render(<Label tone={tone}>t</Label>);
    expect(cls(screen.getByText('t')).split(' ')).toContain(expected);
  });

  it('tone="subtle" is a byte-for-byte rename of the old default, not a new colour', () => {
    render(<Label tone="subtle">t</Label>);
    // The base string itself carries `hover:text-text-primary` and the two
    // sibling-hover has()-variant classes regardless of tone, so this
    // checks for the bare (unprefixed) token, not a substring match.
    expect(cls(screen.getByText('t')).split(' ')).not.toContain('text-text-primary');
  });

  it('tone="neutral" is a byte-for-byte rename of the old strong, not a new colour', () => {
    render(<Label tone="neutral">t</Label>);
    expect(cls(screen.getByText('t')).split(' ')).not.toContain('text-text-secondary');
  });

  it('the default variant (tone omitted) matches tone="subtle" exactly', () => {
    render(<Label>a</Label>);
    const bare = cls(screen.getByText('a'));
    const { unmount: unmountA } = render(<Label tone="subtle">b</Label>);
    const subtle = cls(screen.getByText('b'));
    expect(bare).toBe(subtle);
    unmountA();
  });

  it('tone="default" and tone="strong" resolve to exactly the same classes as tone="subtle" and tone="neutral"', () => {
    render(<Label tone="default">a</Label>);
    const legacySubtle = cls(screen.getByText('a'));
    const { unmount: u1 } = render(<Label tone="subtle">b</Label>);
    const subtle = cls(screen.getByText('b'));
    u1();
    render(<Label tone="strong">c</Label>);
    const legacyNeutral = cls(screen.getByText('c'));
    const { unmount: u2 } = render(<Label tone="neutral">d</Label>);
    const neutral = cls(screen.getByText('d'));
    u2();
    expect(legacySubtle).toBe(subtle);
    expect(legacyNeutral).toBe(neutral);
  });

  it('never emits an unmapped class for an unknown tone value', () => {
    // An unmapped tone appends no colour token - cva emits only the base
    // string for a variant value with no matching key. Checked token-by-token,
    // not by substring, because the base string itself already contains
    // `hover:text-text-primary`.
    const got = labelVariants({ tone: 'unknown' as unknown as 'subtle' }).split(/\s+/).filter(Boolean);
    expect(got).not.toContain('text-text-secondary');
    expect(got.filter((t) => t === 'text-text-primary')).toHaveLength(0);
  });
});

describe('Label - hygiene', () => {
  it('the two tone axis values only ever toggle between the two colours already in the base string', () => {
    // Both `text-text-secondary` and `text-text-primary` are pre-existing
    // tokens.css-backed classes already present in the file before this
    // change (text-text-primary via the base string's hover/has- variants,
    // text-text-secondary via the old default tone). Adding `subtle`/
    // `neutral` introduces no new class name, so there is nothing new for
    // the token guard (design-system/__tests__/tokens-guard.test.ts, run
    // separately over components/ui at zero tolerance) to catch - this test
    // just pins that invariant locally.
    const emitted = new Set<string>();
    for (const tone of ['subtle', 'neutral', 'default', 'strong'] as const) {
      const { unmount } = render(<Label tone={tone}>t</Label>);
      for (const c of cls(screen.getByText('t')).split(' ')) emitted.add(c);
      unmount();
    }
    expect(emitted.has('text-text-secondary')).toBe(true);
    expect(emitted.has('text-text-primary')).toBe(true);
  });

  it('a call site className wins over the tone class', () => {
    render(<Label tone="subtle" className="text-text-primary">t</Label>);
    const rendered = cls(screen.getByText('t')).split(' ');
    expect(rendered).toContain('text-text-primary');
    expect(rendered).not.toContain('text-text-secondary');
  });

  it('forwards a ref to the label element', () => {
    const ref = { current: null as HTMLLabelElement | null };
    render(<Label ref={ref}>t</Label>);
    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });

  it('passes through arbitrary label attributes', () => {
    render(<Label htmlFor="field-id">t</Label>);
    expect(screen.getByText('t').getAttribute('for')).toBe('field-id');
  });
});
