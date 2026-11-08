/**
 * Textarea `size` - phase 8a rendered-class contract.
 *
 * Textarea has 43 call sites across 33 files (see the header comment on
 * components/ui/textarea.tsx for the full measurement). `size="md"` is
 * today's default geometry and must not move a pixel, so the first block
 * pins the exact class string a propless render has always produced. The
 * rest asserts each new rung (`sm`, `lg`) changes only what the evidence
 * supports - height, plus a forced small font on `sm` - and leaves every
 * other baseline token untouched.
 *
 * FLAGGED: sm=64px / md=80px / lg=112px are Textarea's own min-height
 * sub-scale, not VOCAB_V3's shared six-rung 24-44px ladder - the ladder's
 * own max (lg=44px) is smaller than the frozen 80px default, so literal
 * ladder reuse is impossible without moving that default or shipping an
 * `lg` smaller than it. See textarea.tsx's header comment; this is an open
 * item pending the vocabulary owner's call, not a silent deviation.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Textarea, textareaVariants } from '@/components/ui/textarea';

/** The exact string Textarea has rendered for a propless call site since before 8a. */
const BASELINE =
  'flex min-h-[80px] w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base transition-colors duration-300 placeholder:text-text-soft hover:border-primary focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

/** Renders a Textarea and returns the class attribute the DOM actually receives. */
function renderedClass(props: Record<string, unknown> = {}): string {
  const { container, unmount } = render(<Textarea {...props} />);
  const cls = (container.firstElementChild as HTMLElement).className;
  unmount();
  return cls;
}

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);

describe('Textarea - phase 8a `size` rendered-class contract', () => {
  describe('md (default) - the frozen baseline', () => {
    it('a propless render is byte-identical to the pre-8a baseline', () => {
      expect(renderedClass()).toBe(BASELINE);
    });

    it('size="md" passed explicitly renders the same baseline - md never moves', () => {
      expect(renderedClass({ size: 'md' })).toBe(BASELINE);
    });

    it('textareaVariants({}) resolves through the md default to the same baseline', () => {
      expect(textareaVariants({})).toBe(BASELINE);
    });

    it('textareaVariants({ size: "md" }) is byte-identical to textareaVariants({})', () => {
      expect(textareaVariants({ size: 'md' })).toBe(textareaVariants({}));
    });
  });

  describe('sm - height + forced small font, 64px', () => {
    it('replaces min-h-[80px] with min-h-16 and changes nothing else height-wise', () => {
      const got = tokens(renderedClass({ size: 'sm' }));
      expect(got).not.toContain('min-h-[80px]');
      expect(got).toContain('min-h-16');
    });

    it('drops the unprefixed text-base and forces text-sm unconditionally', () => {
      const got = tokens(renderedClass({ size: 'sm' }));
      expect(got).not.toContain('text-base');
      expect(got.filter((t) => t === 'text-sm')).toHaveLength(1);
      // the base string's own md:text-sm is a distinct modifier group and
      // must survive untouched alongside the new unprefixed text-sm
      expect(got).toContain('md:text-sm');
    });

    it('every other baseline token survives untouched', () => {
      const got = tokens(renderedClass({ size: 'sm' }));
      const survivors = tokens(BASELINE).filter(
        (t) => t !== 'min-h-[80px]' && t !== 'text-base'
      );
      for (const tok of survivors) expect(got).toContain(tok);
    });
  });

  describe('lg - height only, 112px', () => {
    it('replaces min-h-[80px] with min-h-28 and changes nothing else', () => {
      const got = tokens(renderedClass({ size: 'lg' }));
      expect(got).not.toContain('min-h-[80px]');
      expect(got).toContain('min-h-28');

      const survivors = tokens(BASELINE).filter((t) => t !== 'min-h-[80px]');
      for (const tok of survivors) expect(got).toContain(tok);

      // exactly one token added (min-h-28), one removed (min-h-[80px])
      expect(got).toHaveLength(tokens(BASELINE).length);
    });
  });

  describe('a caller className still layers on top of every size', () => {
    it('an arbitrary caller class survives alongside size="lg"', () => {
      const got = tokens(renderedClass({ size: 'lg', className: 'resize-none' }));
      expect(got).toContain('resize-none');
      expect(got).toContain('min-h-28');
    });
  });
});
