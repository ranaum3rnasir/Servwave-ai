/**
 * Input `size` - phase 8a rendered-class contract.
 *
 * Input has 236 call sites across 63 files (see the header comment on
 * components/ui/input.tsx for the full measurement). Per the vocabulary's
 * absolute px ladder (xs=32, sm=36, md=40, lg=44), Input's default geometry
 * is 44px, so its default rung is `size="lg"` - not `md` - and must not move
 * a pixel. The first block pins the exact class string a propless render has
 * always produced. The rest asserts each new rung (`sm`, `xs`) changes only
 * what the evidence supports - height, plus a forced small font on `xs` -
 * and leaves every other baseline token, plus the pre-existing
 * `tone`/`invalid` props, untouched.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input, inputVariants } from '@/components/ui/input';

/** The exact string Input has rendered for a propless call site since before 8a. */
const BASELINE =
  'flex h-11 w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base transition-colors duration-300 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-soft hover:border-primary focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

/** Renders an Input and returns the class attribute the DOM actually receives. */
function renderedClass(props: Record<string, unknown> = {}): string {
  const { container, unmount } = render(<Input {...props} />);
  const cls = (container.firstElementChild as HTMLElement).className;
  unmount();
  return cls;
}

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

describe('Input - phase 8a `size` rendered-class contract', () => {
  describe('lg (default) - the frozen baseline', () => {
    it('a propless render is byte-identical to the pre-8a baseline', () => {
      expect(renderedClass()).toBe(BASELINE);
    });

    it('size="lg" passed explicitly renders the same baseline - lg never moves', () => {
      expect(renderedClass({ size: 'lg' })).toBe(BASELINE);
    });

    it('inputVariants({}) resolves through the lg default to the same baseline', () => {
      expect(inputVariants({})).toBe(BASELINE);
    });

    it('inputVariants({ size: "lg" }) is byte-identical to inputVariants({})', () => {
      expect(inputVariants({ size: 'lg' })).toBe(inputVariants({}));
    });
  });

  describe('sm - height only, 36px', () => {
    it('replaces h-11 with h-9 and changes nothing else', () => {
      const got = tokens(renderedClass({ size: 'sm' }));
      expect(got).not.toContain('h-11');
      expect(got).toContain('h-9');

      const survivors = tokens(BASELINE).filter((t) => t !== 'h-11');
      for (const tok of survivors) expect(got).toContain(tok);

      // exactly one token added (h-9), one removed (h-11)
      expect(got).toHaveLength(tokens(BASELINE).length);
    });
  });

  describe('xs - height + forced small font, 32px', () => {
    it('replaces h-11 with h-8 and drops the unprefixed text-base', () => {
      const got = tokens(renderedClass({ size: 'xs' }));
      expect(got).not.toContain('h-11');
      expect(got).toContain('h-8');
      expect(got).not.toContain('text-base');
    });

    it('forces text-sm unconditionally: the new unprefixed text-sm plus the base md:text-sm', () => {
      const got = tokens(renderedClass({ size: 'xs' }));
      expect(got.filter((t) => t === 'text-sm')).toHaveLength(1);
      expect(got).toContain('md:text-sm');
      // file:text-sm is a distinct modifier group and must survive untouched
      expect(got).toContain('file:text-sm');
    });

    it('every other baseline token survives untouched', () => {
      const got = tokens(renderedClass({ size: 'xs' }));
      const survivors = tokens(BASELINE).filter((t) => t !== 'h-11' && t !== 'text-base');
      for (const tok of survivors) expect(got).toContain(tok);
    });
  });

  describe('pre-existing props are unaffected by the cva change', () => {
    it('tone="sage" still layers its border treatment on top of every size', () => {
      expect(tokens(renderedClass({ tone: 'sage' }))).toContain('border-sage-200');
      expect(tokens(renderedClass({ tone: 'sage', size: 'xs' }))).toContain('border-sage-200');
    });

    it('invalid still layers its danger border on top of every size', () => {
      expect(tokens(renderedClass({ invalid: true }))).toContain('border-danger');
      expect(tokens(renderedClass({ invalid: true, size: 'sm' }))).toContain('border-danger');
    });
  });

  describe('W2/8 rename schedule gap fix - tone="business" (sage -> business)', () => {
    it('tone="business" renders byte-identical to the deprecated tone="sage"', () => {
      expect(renderedClass({ tone: 'business' })).toBe(renderedClass({ tone: 'sage' }));
    });

    it('tone="business" carries the same sage-* border classes as tone="sage"', () => {
      const got = tokens(renderedClass({ tone: 'business' }));
      expect(got).toContain('border-sage-200');
      expect(got).toContain('hover:border-sage-500');
      expect(got).toContain('focus-visible:border-sage-500');
    });
  });
});
