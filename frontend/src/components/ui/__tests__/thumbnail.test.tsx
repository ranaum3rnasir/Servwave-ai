/**
 * Thumbnail - rendered-class contract for the W2 `size` / `variant` axes.
 *
 * Thumbnail is a brand-new primitive (phase 9), so there is no pre-existing
 * default string to freeze the way avatar.test.tsx does - these tests pin
 * the API this file's own header documents: `md` (40px, `h-10 w-10`) is the
 * default diameter, radius and `object-cover` are always present (baked into
 * the base string, not a prop), and `variant="outline"` is the only minted
 * border cell. `size` only mints the three rungs of the closed vocabulary's
 * absolute ladder with measured demand - `3xs` (24px), `xs` (32px), `md`
 * (40px) - the old relative-scale `sm`/`lg` values (32px/56px under the
 * pre-fix draft) are gone, not aliased: see thumbnail.tsx's header for why
 * an absolute ladder forbids keeping either as a same-named deprecated
 * alias.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Thumbnail, type ThumbnailSize } from '@/components/ui/thumbnail';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const img = () => screen.getByTestId('thumbnail');

describe('Thumbnail - renders', () => {
  it('renders an <img> with the given src and alt', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="Item photo" />);
    expect(img().tagName).toBe('IMG');
    expect(img().getAttribute('src')).toBe('/photo.jpg');
    expect(img().getAttribute('alt')).toBe('Item photo');
  });

  it('forwards a ref to the img element', () => {
    const ref = { current: null as HTMLImageElement | null };
    render(<Thumbnail ref={ref} data-testid="thumbnail" src="/photo.jpg" alt="" />);
    expect(ref.current).toBeInstanceOf(HTMLImageElement);
  });

  it('passes through arbitrary img attributes', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" loading="lazy" />);
    expect(img().getAttribute('loading')).toBe('lazy');
  });
});

describe('Thumbnail - the propless default', () => {
  it('renders exactly "rounded object-cover h-10 w-10" - the dominant real shape-1 signature', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" />);
    expect(cls(img())).toBe('rounded object-cover h-10 w-10');
  });

  it('size="md" stated explicitly is byte-identical to propless', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size="md" />);
    expect(cls(img())).toBe('rounded object-cover h-10 w-10');
  });

  it('carries no border/ring class when variant is unset', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" />);
    expect(cls(img())).not.toMatch(/ring|border/);
  });
});

describe('Thumbnail - size rungs', () => {
  const RUNGS: Array<[ThumbnailSize, string]> = [
    ['3xs', 'h-6 w-6'],
    ['xs', 'h-8 w-8'],
    ['md', 'h-10 w-10'],
  ];

  it.each(RUNGS)('size="%s" renders "rounded object-cover %s"', (size, expected) => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size={size} />);
    expect(cls(img())).toBe(`rounded object-cover ${expected}`);
  });

  it('covers every rung with a literal class string, never a computed one', () => {
    const emitted = new Set<string>();
    for (const [size] of RUNGS) {
      const { unmount } = render(
        <Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size={size} />
      );
      for (const c of cls(img()).split(' ')) if (c) emitted.add(c);
      unmount();
    }
    expect([...emitted].sort()).toEqual(
      ['rounded', 'object-cover', 'h-6', 'w-6', 'h-8', 'w-8', 'h-10', 'w-10'].sort()
    );
  });
});

describe('Thumbnail - variant', () => {
  it('variant="outline" adds the ring border treatment on top of the default size', () => {
    render(<Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" variant="outline" />);
    expect(cls(img())).toBe('rounded object-cover h-10 w-10 ring-1 ring-border');
  });

  it('variant="outline" composes with an explicit size', () => {
    render(
      <Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size="xs" variant="outline" />
    );
    expect(cls(img())).toBe('rounded object-cover h-8 w-8 ring-1 ring-border');
  });
});

describe('Thumbnail - hygiene', () => {
  it('a call site className wins over the size rung, the singleton-diameter pattern', () => {
    // AddGroupDialog.tsx:568 (28px) and PriceBookPage.tsx:758 (36px) are
    // singleton diameters not minted on the closed three-rung scale - they
    // keep a bespoke className override, and tailwind-merge must still let
    // it win over `size`'s h-w classes.
    render(
      <Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size="md" className="h-9 w-9" />
    );
    const rendered = cls(img()).split(' ');
    expect(rendered).toContain('h-9');
    expect(rendered).toContain('w-9');
    expect(rendered).not.toContain('h-10');
    expect(rendered).not.toContain('w-10');
  });

  it('neither size nor variant reaches the DOM', () => {
    render(
      <Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size="xs" variant="outline" />
    );
    expect(img().getAttribute('size')).toBeNull();
    expect(img().getAttribute('variant')).toBeNull();
  });

  it('every class it can emit is a plain Tailwind utility, never an arbitrary bracket value', () => {
    const emitted = new Set<string>();
    for (const size of ['3xs', 'xs', 'md'] as const) {
      for (const variant of [undefined, 'outline' as const]) {
        const { unmount } = render(
          <Thumbnail data-testid="thumbnail" src="/photo.jpg" alt="" size={size} variant={variant} />
        );
        for (const c of cls(img()).split(' ')) if (c) emitted.add(c);
        unmount();
      }
    }
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
    }
  });

  it('an out-of-ladder legacy value ("lg", 56px under the pre-fix relative scale) is no longer part of the size type and renders no diameter classes', () => {
    render(
      <Thumbnail
        data-testid="thumbnail"
        src="/photo.jpg"
        alt=""
        size={'lg' as unknown as ThumbnailSize}
      />
    );
    const rendered = cls(img()).split(' ');
    expect(rendered).not.toContain('h-14');
    expect(rendered).not.toContain('w-14');
  });
});
