/**
 * ActionLink - rendered-class contract plus the dedicated asChild/ref
 * verifier action-link.tsx's header calls for.
 *
 * ActionLink is brand new (no prior shipped component to stay byte-identical
 * against), so the "propless" assertions below pin the primitive's own
 * evidence contract instead of a frozen pre-existing string - see
 * action-link.tsx's header for the site citations.
 */
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ActionLink, actionLinkVariants, type ActionLinkProps } from '@/components/ui/action-link';
import { BUTTON_CELL_CLASSES } from '@/components/ui/button';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const tokens = (el: HTMLElement) => cls(el).split(' ').filter(Boolean).sort();
const expected = (s: string) => s.split(' ').filter(Boolean).sort();
const link = () => screen.getByTestId('al');

describe('ActionLink - the default (variant="link")', () => {
  it('propless renders exactly Button\'s own link/brand cell on a real <a>', () => {
    render(<ActionLink data-testid="al">Details</ActionLink>);
    expect(link().tagName).toBe('A');
    expect(cls(link())).toBe('text-primary underline-offset-4 hover:underline');
  });

  it('is byte-identical to Button\'s BUTTON_CELL_CLASSES["link/brand"] cell', () => {
    // The header states this reuse as a design contract, not a coincidence -
    // pin it directly against Button's own grid so the two cannot drift
    // apart silently.
    render(<ActionLink data-testid="al">Details</ActionLink>);
    expect(cls(link())).toBe(BUTTON_CELL_CLASSES['link/brand']);
  });

  it('variant="link" stated explicitly is byte-identical to propless', () => {
    render(
      <ActionLink data-testid="al" variant="link">
        Details
      </ActionLink>
    );
    expect(cls(link())).toBe('text-primary underline-offset-4 hover:underline');
  });
});

describe('ActionLink - variant="outline"', () => {
  it('reproduces VendorDetailDialog.tsx:302-308 byte for byte', () => {
    render(
      <ActionLink data-testid="al" variant="outline" href="mailto:vendor@example.test">
        Email Vendor
      </ActionLink>
    );
    expect(tokens(link())).toEqual(
      expected(
        'inline-flex items-center gap-1.5 rounded-md border border-primary-subtle bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle'
      )
    );
    expect(link().getAttribute('href')).toBe('mailto:vendor@example.test');
  });
});

describe('ActionLink - asChild and className', () => {
  it('renders its own <a> when asChild is not set', () => {
    render(
      <ActionLink data-testid="al" href="/vendors/1">
        vendor
      </ActionLink>
    );
    expect(link().tagName).toBe('A');
    expect(link().getAttribute('href')).toBe('/vendors/1');
  });

  it('forwards its classes onto the child element and renders no extra anchor', () => {
    render(
      <ActionLink asChild variant="outline">
        <a href="/x" data-testid="al">
          child
        </a>
      </ActionLink>
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(tokens(link())).toEqual(
      expected(
        'inline-flex items-center gap-1.5 rounded-md border border-primary-subtle bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle'
      )
    );
  });

  it('lets a caller className through, appended after the variant classes', () => {
    render(
      <ActionLink data-testid="al" className="truncate">
        x
      </ActionLink>
    );
    expect(cls(link()).endsWith('truncate')).toBe(true);
    expect(tokens(link())).toEqual(
      expected('text-primary underline-offset-4 hover:underline truncate')
    );
  });
});

describe('ActionLink - the dedicated asChild/ref-forwarding verifier', () => {
  // This is the risk action-link.tsx's header flags: `asChild` has to reach
  // the REAL rendered DOM node with both the ref and the merged className,
  // for every one of the three targets the phase-9 evidence names - a plain
  // <a>, a router <Link>, and a bare <button>. A wrapper-level ref (pointing
  // at Slot's own clone rather than the child's real node) or a dropped
  // className would pass a shallower test but fail a real caller silently.

  it('without asChild: the ref reaches ActionLink\'s own <a>', () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <ActionLink ref={ref} href="/x">
        x
      </ActionLink>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe('A');
    expect(ref.current?.getAttribute('href')).toBe('/x');
  });

  it('asChild + a plain <a>: the ref reaches the real anchor, not a wrapper', () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <ActionLink asChild ref={ref} variant="outline">
        <a href="/vendors/1" data-testid="al">
          Email Vendor
        </a>
      </ActionLink>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(screen.getByTestId('al'));
    expect(ref.current?.tagName).toBe('A');
    // The merged className landed on the SAME node the ref points at, not a
    // separate wrapper.
    expect(ref.current?.className).toContain('border-primary-subtle');
  });

  it('asChild + react-router <Link>: the ref reaches the real anchor react-router renders', () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <MemoryRouter>
        <ActionLink asChild ref={ref}>
          <Link to="/vendors/1" data-testid="al">
            Vendor
          </Link>
        </ActionLink>
      </MemoryRouter>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(screen.getByTestId('al'));
    expect(ref.current?.tagName).toBe('A');
    expect(ref.current?.getAttribute('href')).toBe('/vendors/1');
    expect(ref.current?.className).toBe('text-primary underline-offset-4 hover:underline');
    // Confirms this is react-router's OWN rendered anchor, not a second one
    // ActionLink introduced alongside it.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('asChild + a bare <button>: renders a real button, ref reaches it, no href expected', () => {
    // The phase-9 evidence explicitly names <button> as a third render
    // target - a "link" with no real destination that performs a JS action
    // instead. React's ref type is generic here for exactly this case: the
    // static HTMLAnchorElement annotation on ActionLink's own forwardRef is
    // the accepted, established looseness Button and TextLink both carry
    // (see action-link.tsx's header) - what has to hold at RUNTIME is that
    // the ref lands on the real node, which this test checks directly rather
    // than trusting the type.
    const ref = createRef<HTMLButtonElement>();
    render(
      <ActionLink asChild ref={ref as unknown as React.Ref<HTMLAnchorElement>} variant="link">
        <button type="button" data-testid="al">
          Load more
        </button>
      </ActionLink>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current).toBe(screen.getByTestId('al'));
    expect((ref.current as unknown as HTMLElement)?.tagName).toBe('BUTTON');
    expect((ref.current as unknown as HTMLElement)?.className).toBe(
      'text-primary underline-offset-4 hover:underline'
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('asChild forwards arbitrary props (onClick) to the real rendered node', () => {
    let clicked = false;
    render(
      <ActionLink asChild>
        <button type="button" data-testid="al" onClick={() => (clicked = true)}>
          Load more
        </button>
      </ActionLink>
    );
    screen.getByTestId('al').click();
    expect(clicked).toBe(true);
  });
});

describe('ActionLink - hygiene', () => {
  it('a call-site className wins over the variant class it collides with', () => {
    render(
      <ActionLink data-testid="al" variant="link" className="text-text-secondary">
        x
      </ActionLink>
    );
    const rendered = tokens(link());
    expect(rendered).toContain('text-text-secondary');
    expect(rendered).not.toContain('text-primary');
  });

  it('variant never reaches the DOM', () => {
    render(
      <ActionLink data-testid="al" variant="outline">
        x
      </ActionLink>
    );
    expect(link().getAttribute('variant')).toBeNull();
  });

  it('actionLinkVariants({}) resolves to the same propless string the component renders', () => {
    expect(actionLinkVariants({})).toBe('text-primary underline-offset-4 hover:underline');
  });

  it('every class it can emit is a design token or a stock Tailwind key', () => {
    const emitted = new Set<string>();
    for (const variant of ['link', 'outline'] as const) {
      const { unmount } = render(
        <ActionLink data-testid="al" variant={variant}>
          x
        </ActionLink>
      );
      for (const c of cls(link()).split(' ')) if (c) emitted.add(c);
      unmount();
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
      expect(c, `${c} must not be a raw hex`).not.toMatch(/#[0-9a-fA-F]{3}/);
    }
  });
});

/** Documents which ActionLinkProps values are exercised above, for completeness. */
const AXES = { variant: ['link', 'outline'] } as const satisfies {
  variant: NonNullable<ActionLinkProps['variant']>[];
};

describe('ActionLink - completeness', () => {
  it('every implemented variant is exercised at least once above', () => {
    // A compile-time + trivial runtime guard: if a third variant is minted
    // later without a matching test above, this still passes (it only
    // checks the KNOWN axis), so it is a floor, not a substitute for adding
    // real coverage - the same status chip.test.tsx's own hygiene block has.
    expect(AXES.variant).toEqual(['link', 'outline']);
  });
});
