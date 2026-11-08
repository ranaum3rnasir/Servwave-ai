/**
 * Heading - phase 7d rendered-class contract.
 *
 * The hard constraint on every phase 7 change is that no existing default
 * moves a pixel. Heading is new, so "existing default" means the signature the
 * two tracer pages render today: `InvoiceDetailPage.tsx:666` is
 * `<h1 className="text-xl font-semibold text-text-primary">` and
 * `InvoicesPage.tsx:481` is the same three appearance classes plus a layout
 * row (`flex items-center gap-2`). Those exact strings are asserted below, so
 * the conversion in 7f is a provable no-op rather than a hopeful one.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Heading, DEFAULT_SCALE, type HeadingLevel } from '@/components/ui/heading';

const cls = (el: HTMLElement) => el.getAttribute('class') ?? '';

describe('Heading - the default may not differ from what the pages render today', () => {
  it('renders <h1 class="text-xl font-semibold text-text-primary"> with no props', () => {
    render(<Heading>Invoices</Heading>);
    const h = screen.getByRole('heading', { level: 1 });
    expect(h.tagName).toBe('H1');
    expect(cls(h)).toBe('text-xl font-semibold text-text-primary');
  });

  it('reproduces InvoiceDetailPage.tsx:666 byte for byte', () => {
    render(<Heading>INV-1001</Heading>);
    expect(cls(screen.getByRole('heading'))).toBe('text-xl font-semibold text-text-primary');
  });

  it('reproduces InvoicesPage.tsx:481 once its layout classes are passed through className', () => {
    // flex / items-center / gap-2 are LAYOUT under the phase-6 classifier, so
    // they stay the call site's business and do not block 7f's zero-appearance
    // exit criterion.
    render(<Heading className="flex items-center gap-2">Invoices</Heading>);
    const rendered = cls(screen.getByRole('heading')).split(' ').sort();
    expect(rendered).toEqual(
      'flex items-center gap-2 text-xl font-semibold text-text-primary'.split(' ').sort()
    );
  });

  it('emits no appearance class beyond the three the pages already carry', () => {
    render(<Heading>x</Heading>);
    expect(cls(screen.getByRole('heading')).split(' ')).toHaveLength(3);
  });
});

describe('Heading - level and scale are independent', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)('level=%i renders the matching <hN> element', (level) => {
    render(<Heading level={level}>heading {level}</Heading>);
    expect(screen.getByRole('heading', { level }).tagName).toBe(`H${level}`);
  });

  it('keeps the h1 look on an h3 element', () => {
    render(
      <Heading level={3} scale="xl">
        looks like a page title, sits at level 3
      </Heading>
    );
    const h = screen.getByRole('heading', { level: 3 });
    expect(h.tagName).toBe('H3');
    expect(cls(h)).toBe('text-xl font-semibold text-text-primary');
  });

  it('keeps the h3 look on an h1 element', () => {
    render(
      <Heading level={1} scale="sm">
        small but top of the outline
      </Heading>
    );
    const h = screen.getByRole('heading', { level: 1 });
    expect(h.tagName).toBe('H1');
    expect(cls(h)).toBe('text-sm font-semibold text-text-primary');
  });

  it('applies the measured per-level ramp when scale is omitted', () => {
    // Levels 2-6 default to `sm` because 14px is what those levels actually
    // render today (h2 35 of 66 sites, h3 53 of 97, h4 2 of 4). A prettier
    // descending ramp would restyle ~90 sites at conversion time.
    const expected: Record<HeadingLevel, string> = {
      1: 'text-xl',
      2: 'text-sm',
      3: 'text-sm',
      4: 'text-sm',
      5: 'text-sm',
      6: 'text-sm',
    };
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const { unmount } = render(<Heading level={level}>h{level}</Heading>);
      expect(cls(screen.getByRole('heading', { level }))).toBe(
        `${expected[level]} font-semibold text-text-primary`
      );
      unmount();
    }
  });

  it('DEFAULT_SCALE is the single place the ramp lives', () => {
    expect(DEFAULT_SCALE).toEqual({ 1: 'xl', 2: 'sm', 3: 'sm', 4: 'sm', 5: 'sm', 6: 'sm' });
  });
});

describe('Heading - scale', () => {
  it.each([
    ['2xl', 'text-2xl'],
    ['xl', 'text-xl'],
    ['lg', 'text-lg'],
    ['base', 'text-base'],
    ['sm', 'text-sm'],
    ['xs', 'text-xs'],
  ] as const)('scale=%s renders %s', (scale, expected) => {
    render(<Heading scale={scale}>t</Heading>);
    expect(cls(screen.getByRole('heading')).split(' ')).toContain(expected);
  });
});

describe('Heading - tone', () => {
  it.each([
    ['neutral', 'text-text-primary'],
    ['subtle', 'text-text-secondary'],
    ['brand', 'text-primary'],
  ] as const)('tone=%s renders %s', (tone, expected) => {
    render(<Heading tone={tone}>t</Heading>);
    expect(cls(screen.getByRole('heading')).split(' ')).toContain(expected);
  });

  it('tone="neutral" is the chrome text role, not the neutral status role', () => {
    // --text-primary is #10202B; --neutral-text is #5E707B. Rendering
    // `text-neutral-text` here would be a 4-point-contrast colour change on
    // 166 heading sites.
    render(<Heading tone="neutral">t</Heading>);
    expect(cls(screen.getByRole('heading'))).not.toMatch(/text-neutral-text/);
  });
});

describe('Heading - weight', () => {
  it.each([
    ['semibold', 'font-semibold'],
    ['bold', 'font-bold'],
  ] as const)('weight=%s renders %s', (weight, expected) => {
    render(<Heading weight={weight}>t</Heading>);
    expect(cls(screen.getByRole('heading')).split(' ')).toContain(expected);
  });
});

describe('Heading - hygiene', () => {
  it('every class it can emit is a token or a stock Tailwind key', () => {
    const emitted = new Set<string>();
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      for (const scale of ['2xl', 'xl', 'lg', 'base', 'sm', 'xs'] as const) {
        for (const tone of ['neutral', 'subtle', 'brand'] as const) {
          for (const weight of ['semibold', 'bold'] as const) {
            const { unmount } = render(
              <Heading level={level} scale={scale} tone={tone} weight={weight}>
                t
              </Heading>
            );
            for (const c of cls(screen.getByRole('heading', { level })).split(' ')) emitted.add(c);
            unmount();
          }
        }
      }
    }
    expect([...emitted].sort()).toEqual([
      'font-bold',
      'font-semibold',
      'text-2xl',
      'text-base',
      'text-lg',
      'text-primary',
      'text-sm',
      'text-text-primary',
      'text-text-secondary',
      'text-xl',
      'text-xs',
    ]);
    for (const c of emitted) {
      expect(c, `${c} must not be an arbitrary bracket value`).not.toMatch(/\[/);
      expect(c, `${c} must not be a raw hex`).not.toMatch(/#[0-9a-fA-F]{3}/);
      // Raw Tailwind palette families the token guard bans.
      expect(c, `${c} must not be a raw palette class`).not.toMatch(
        /-(slate|gray|zinc|neutral-\d|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/
      );
    }
  });

  it('a call site className wins over the variant class', () => {
    render(<Heading className="text-2xl">t</Heading>);
    // twMerge must drop the variant's text-xl, not stack both font sizes.
    const rendered = cls(screen.getByRole('heading')).split(' ');
    expect(rendered).toContain('text-2xl');
    expect(rendered).not.toContain('text-xl');
  });

  it('forwards a ref to the heading element', () => {
    const ref = { current: null as HTMLHeadingElement | null };
    render(<Heading ref={ref}>t</Heading>);
    expect(ref.current).toBeInstanceOf(HTMLHeadingElement);
    expect(ref.current?.tagName).toBe('H1');
  });

  it('passes through arbitrary heading attributes', () => {
    render(<Heading id="page-title">t</Heading>);
    expect(screen.getByRole('heading').id).toBe('page-title');
  });
});
