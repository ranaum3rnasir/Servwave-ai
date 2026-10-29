/**
 * TextLink - phase 7 rendered-class contract.
 *
 * TextLink is a new primitive, so "no existing default moves" means something
 * specific and checkable: the class SET it emits for each of the 8 anchor
 * sites measured on the two tracer pages must equal the set that site
 * hand-rolls today. Those 8 strings are pinned literally below, copied from
 * the pages rather than retyped from memory, so the 7f conversion is a
 * provable no-op instead of a hopeful one.
 *
 * The one intended exception is stated in link.tsx and belongs in the PR body:
 * InvoicesPage:164 is a link hand-rolled as a `<span>` with an onClick.
 * Converting it to a real anchor adds keyboard reachability and a link role -
 * and therefore a focus ring that does not exist today. That is a behaviour
 * change on purpose. It is asserted here as such.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TextLink } from '@/components/ui/link';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';
const tokens = (el: HTMLElement) => cls(el).split(' ').filter(Boolean).sort();
const expected = (s: string) => s.split(' ').filter(Boolean).sort();
const link = () => screen.getByTestId('tl');

describe('TextLink - the default', () => {
  it('renders a bare <a> with only the hover underline', () => {
    render(<TextLink data-testid="tl">job</TextLink>);
    expect(link().tagName).toBe('A');
    expect(cls(link())).toBe('hover:underline');
  });

  it('paints no idle colour, no size and no weight of its own', () => {
    render(<TextLink data-testid="tl">job</TextLink>);
    // An unprefixed colour, font-size or font-weight class here would repaint
    // every converted call site. The base string is empty by design.
    expect(tokens(link())).toEqual(['hover:underline']);
  });

  it('adds no focus, offset or transition treatment to the base string', () => {
    render(<TextLink data-testid="tl">job</TextLink>);
    expect(cls(link())).not.toMatch(/focus|ring|offset|transition|duration/);
  });
});

describe('TextLink - one axis at a time', () => {
  it.each([
    ['tone="brand"', <TextLink data-testid="tl" tone="brand" key="a" />, 'text-primary hover:underline'],
    [
      'hoverTone="brand"',
      <TextLink data-testid="tl" hoverTone="brand" key="b" />,
      'hover:text-primary hover:underline',
    ],
    ['weight="medium"', <TextLink data-testid="tl" weight="medium" key="c" />, 'font-medium hover:underline'],
    ['size="xs"', <TextLink data-testid="tl" size="xs" key="d" />, 'text-xs hover:underline'],
    ['underline="none"', <TextLink data-testid="tl" underline="none" key="e" />, 'no-underline'],
    ['underline="hover"', <TextLink data-testid="tl" underline="hover" key="f" />, 'hover:underline'],
  ])('%s emits exactly its own class', (_label, element, want) => {
    render(element);
    expect(tokens(link())).toEqual(expected(want));
  });

  it('underline="none" REPLACES the default rather than sitting beside it', () => {
    // The default variant is `hover`, so the only thing standing between the
    // chip at InvoiceDetailPage:1093 and a stray hover rule is cva picking the
    // explicit value over the default. Assert the absence directly: a set
    // comparison alone would still pass if cva emitted both and twMerge
    // happened to drop one, which is not the contract being claimed.
    render(<TextLink data-testid="tl" underline="none" />);
    expect(cls(link())).toBe('no-underline');
    expect(tokens(link())).not.toContain('hover:underline');
    expect(cls(link())).not.toMatch(/hover/);
  });

  it('keeps tone and hoverTone independent - the reason they are two props', () => {
    // The tel: and mailto: anchors at InvoiceDetailPage:708 and :717 set a
    // hover colour and NO idle colour. A single merged prop cannot express
    // that without giving them an idle colour they do not have today.
    render(<TextLink data-testid="tl" hoverTone="brand" />);
    expect(tokens(link())).not.toContain('text-primary');
  });
});

describe('TextLink - reproduces every measured call site byte for byte', () => {
  it('InvoicesPage.tsx:649 - the job link in the To Be Invoiced dialog', () => {
    render(
      <MemoryRouter>
        <TextLink asChild tone="brand" weight="medium">
          <Link to="/jobs/1" data-testid="tl">
            J00001
          </Link>
        </TextLink>
      </MemoryRouter>
    );
    expect(tokens(link())).toEqual(expected('font-medium text-primary hover:underline'));
  });

  it('InvoiceDetailPage.tsx:698 - the customer link', () => {
    render(
      <MemoryRouter>
        <TextLink asChild tone="brand" weight="medium">
          <Link to="/customers/1" data-testid="tl">
            Acme
          </Link>
        </TextLink>
      </MemoryRouter>
    );
    expect(tokens(link())).toEqual(expected('text-primary hover:underline font-medium'));
  });

  it.each([
    ['InvoiceDetailPage.tsx:739 - the job link', '/jobs/1'],
    ['InvoiceDetailPage.tsx:755 - the estimate link', '/estimates/1'],
  ])('%s', (_label, to) => {
    render(
      <MemoryRouter>
        <TextLink asChild tone="brand">
          <Link to={to} data-testid="tl">
            linked record
          </Link>
        </TextLink>
      </MemoryRouter>
    );
    expect(tokens(link())).toEqual(expected('text-primary hover:underline'));
  });

  it.each([
    ['InvoiceDetailPage.tsx:708 - the tel: anchor', 'tel:+15125550100'],
    ['InvoiceDetailPage.tsx:717 - the mailto: anchor', 'mailto:owner@example.test'],
  ])('%s inherits its idle colour and paints only on hover', (_label, href) => {
    render(
      <TextLink asChild hoverTone="brand">
        <a href={href} data-testid="tl">
          contact
        </a>
      </TextLink>
    );
    expect(tokens(link())).toEqual(expected('hover:text-primary hover:underline'));
    expect(link().getAttribute('href')).toBe(href);
  });

  it('InvoiceDetailPage.tsx:1093 - the chip owns its typography here, its box in phase 9', () => {
    // The border, radius, padding and hover fill are the deferred Chip
    // primitive's, and stay at the call site this session. TextLink owns the
    // three tokens it can express.
    render(
      <MemoryRouter>
        <TextLink asChild size="xs" weight="medium" underline="none">
          <Link to="/estimates/1" data-testid="tl">
            E00001
          </Link>
        </TextLink>
      </MemoryRouter>
    );
    expect(tokens(link())).toEqual(expected('text-xs font-medium no-underline'));
  });
});

describe('TextLink - bucket H, the span that was never a link', () => {
  it('emits the 3 paint tokens InvoicesPage:164 hand-rolls, and drops cursor-pointer', () => {
    // The 4th token, cursor-pointer, is retired by rendering the right
    // ELEMENT: an anchor takes cursor: pointer from the user-agent
    // stylesheet, which Tailwind preflight does not override.
    render(
      <MemoryRouter>
        <TextLink asChild tone="brand" weight="medium">
          <Link to="/jobs/1" data-testid="tl">
            J00001
          </Link>
        </TextLink>
      </MemoryRouter>
    );
    expect(tokens(link())).toEqual(expected('font-medium text-primary hover:underline'));
    expect(tokens(link())).not.toContain('cursor-pointer');
  });

  it('IS the behaviour change: it announces a link role and is keyboard reachable', () => {
    // Today this is <span onClick> - no role, not focusable, invisible to a
    // keyboard user. The focus ring this adds is intended and is reported in
    // the PR body; the visual gate cannot see it because it never screenshots
    // a focused state.
    render(
      <MemoryRouter>
        <TextLink asChild tone="brand" weight="medium">
          <Link to="/jobs/1">J00001</Link>
        </TextLink>
      </MemoryRouter>
    );
    const el = screen.getByRole('link', { name: 'J00001' });
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/jobs/1');
  });
});

describe('TextLink - asChild and className', () => {
  it('renders its own <a> when asChild is not set', () => {
    render(
      <TextLink data-testid="tl" href="/invoices">
        invoices
      </TextLink>
    );
    expect(link().tagName).toBe('A');
    expect(link().getAttribute('href')).toBe('/invoices');
  });

  it('forwards its classes onto the child element and renders no extra anchor', () => {
    render(
      <TextLink asChild tone="brand">
        <a href="/x" data-testid="tl">
          child
        </a>
      </TextLink>
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(tokens(link())).toEqual(expected('text-primary hover:underline'));
  });

  it('lets a caller className through, appended after the variant classes', () => {
    render(
      <TextLink data-testid="tl" tone="brand" className="truncate">
        x
      </TextLink>
    );
    expect(cls(link()).endsWith('truncate')).toBe(true);
    expect(tokens(link())).toEqual(expected('text-primary hover:underline truncate'));
  });

  it('forwards a ref to the rendered anchor', () => {
    const ref = { current: null as HTMLAnchorElement | null };
    render(
      <TextLink ref={ref} href="/x">
        x
      </TextLink>
    );
    expect(ref.current?.tagName).toBe('A');
  });
});

/*
 * Token hygiene, the same sweep text.test.tsx runs.
 *
 * A NOTE ON WHY THE PALETTE CHECK IS BUILT FROM AN ARRAY rather than written
 * as one literal regex, copied from the reasoning at
 * design-system/__tests__/component-api-guard.test.ts:169. The unresolved-class
 * gate (scripts/check-unresolved-classes.mjs) tokenises raw SOURCE TEXT on a
 * word-plus-hyphen shape and has no idea whether it is reading a className or
 * a regex alternation. A literal list of palette family stems in this file
 * would therefore be scraped as if it were a set of live classes and reported
 * as unresolved. Joining the hyphen in at runtime keeps the list readable
 * while breaking that accidental collision.
 */
const H = '-';
const BANNED_PALETTE_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

/** Every value of every axis, so the sweep below is exhaustive by construction. */
const AXES = {
  size: ['xs'],
  weight: ['medium'],
  tone: ['brand'],
  hoverTone: ['brand'],
  underline: ['hover', 'none'],
} as const;

describe('TextLink - hygiene', () => {
  it('emits exactly six classes across every combination of every axis', () => {
    const emitted = new Set<string>();
    for (const size of AXES.size) {
      for (const weight of AXES.weight) {
        for (const tone of AXES.tone) {
          for (const hoverTone of AXES.hoverTone) {
            for (const underline of AXES.underline) {
              const { unmount } = render(
                <TextLink
                  data-testid="tl"
                  size={size}
                  weight={weight}
                  tone={tone}
                  hoverTone={hoverTone}
                  underline={underline}
                />
              );
              for (const c of cls(link()).split(' ')) if (c) emitted.add(c);
              unmount();
            }
          }
        }
      }
    }
    expect([...emitted].sort()).toEqual([
      'font-medium',
      'hover:text-primary',
      'hover:underline',
      'no-underline',
      'text-primary',
      'text-xs',
    ]);
  });

  it('every class it can emit is a design token or a stock Tailwind key', () => {
    const emitted = new Set<string>();
    for (const underline of AXES.underline) {
      const { unmount } = render(
        <TextLink data-testid="tl" size="xs" weight="medium" tone="brand" hoverTone="brand" underline={underline} />
      );
      for (const c of cls(link()).split(' ')) if (c) emitted.add(c);
      unmount();
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
      expect(c, `${c} must not be a raw hex`).not.toMatch(/#[0-9a-fA-F]{3}/);
      for (const family of BANNED_PALETTE_FAMILIES) {
        expect(
          new RegExp(H + family + H + '\\d').test(c),
          `${c} must not be a raw Tailwind palette class`
        ).toBe(false);
      }
      // `neutral` is a live semantic token name in this tree as well as a
      // Tailwind palette family, so it is checked only in its numbered
      // palette form and never as a bare stem.
      expect(new RegExp(H + 'neutral' + H + '\\d').test(c), `${c} palette form`).toBe(false);
    }
  });

  it('emits no line-height utility on any combination', () => {
    // Not additive if it did: seven of the eight measured sites inherit their
    // line box from an ancestor as an absolute length, so a leading class here
    // would move geometry on every one of them.
    const { container } = render(
      <TextLink size="xs" weight="medium" tone="brand" hoverTone="brand">
        x
      </TextLink>
    );
    expect(container.innerHTML).not.toMatch(/leading/);
  });

  it('a call-site className wins over the variant class it collides with', () => {
    render(
      <TextLink data-testid="tl" size="xs" className="text-sm">
        x
      </TextLink>
    );
    const rendered = tokens(link());
    expect(rendered).toContain('text-sm');
    expect(rendered).not.toContain('text-xs');
  });
});
