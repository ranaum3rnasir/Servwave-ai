import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Card, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Heading } from '@/ui-kit/components/ui/heading';

/**
 * A card title has to be a real heading.
 *
 * `CardTitle` used to be `function CardTitle(props: React.ComponentProps<"div">)`
 * returning a div, so every card title in the app sat OUTSIDE the document
 * outline - Dashboard's ledger names it as the one accessibility difference
 * between the v2 widget shell and the legacy one, and the same loss reaches
 * every module that uses a Card header.
 *
 * The workaround modules reached for instead is `role="heading"` with an
 * explicit `aria-level` on a p/span/div (ten modules did it; see
 * `pages/v2/auth-public/components/publicShell.tsx`'s PublicCardTitle and
 * `pages/v2/reports/components/heading.tsx`). That announces correctly but is
 * not a heading ELEMENT, so nothing that walks the DOM outline sees it.
 */
describe('kit CardTitle document outline', () => {
  it('renders a real heading element, not a div', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
      </Card>,
    );

    const title = screen.getByRole('heading', { name: 'Details' });
    // Level 3 by default: a card sits under the page <h1> that
    // layout/pageHeader renders, and usually under a section heading too. It
    // is the same default PublicCardTitle picked independently.
    expect(title.tagName).toBe('H3');
  });

  it('lets the caller place the title in the outline', () => {
    render(<CardTitle level={2}>Payment Options</CardTitle>);
    expect(screen.getByRole('heading', { name: 'Payment Options', level: 2 }).tagName).toBe('H2');
  });

  it('keeps its data-slot and its typography, so no existing card moves', () => {
    const { container } = render(<CardTitle className="flex items-center gap-2">Estimate Info</CardTitle>);

    const title = container.querySelector('[data-slot="card-title"]');
    expect(title).not.toBeNull();
    // The exact class string the div version emitted. CardHeader's grid keys
    // off data-slot and the 15px/bold/tight signature is what every migrated
    // card already looks like; a heading element must not change either.
    expect(title!.className).toContain('text-[15px]');
    expect(title!.className).toContain('font-bold');
    expect(title!.className).toContain('leading-tight');
    expect(title!.className).toContain('tracking-tight');
    // Caller classes still win, since CardTitle is routinely given a flex row
    // to hold an icon beside the words.
    expect(title!.className).toContain('flex');
  });
});

/**
 * The primitive CardTitle is built on, and the kit's answer to the single
 * most-wanted missing component (13 of 15 modules hand-rolled one).
 *
 * Only the kit may author `<h1>`-`<h6>`: the design-system raw-tag ratchet
 * counts heading tags everywhere OUTSIDE `src/ui-kit`, so a v2 page has no way
 * to open one and can only borrow one from a kit component. `layout/pageHeader`
 * already renders the page `<h1>`; this covers everything below it.
 */
describe('kit Heading', () => {
  it('renders the element the level names', () => {
    render(
      <>
        <Heading level={1}>One</Heading>
        <Heading level={3}>Three</Heading>
        <Heading level={6}>Six</Heading>
      </>,
    );

    expect(screen.getByText('One').tagName).toBe('H1');
    expect(screen.getByText('Three').tagName).toBe('H3');
    expect(screen.getByText('Six').tagName).toBe('H6');
  });

  it('defaults to level 2 - a section under the page title pageHeader owns', () => {
    render(<Heading>Recent activity</Heading>);
    expect(screen.getByRole('heading', { name: 'Recent activity', level: 2 })).toBeInTheDocument();
  });

  it('sizes independently of level, because the outline and the visual weight disagree in real pages', () => {
    render(
      <>
        <Heading level={2} scale="sm">
          Small but high
        </Heading>
        <Heading level={4} scale="2xl">
          Big but low
        </Heading>
      </>,
    );

    const small = screen.getByText('Small but high');
    const big = screen.getByText('Big but low');
    expect(small.tagName).toBe('H2');
    expect(small.className).toContain('text-[13px]');
    expect(big.tagName).toBe('H4');
    expect(big.className).toContain('text-[23px]');
  });

  it('emits no type classes at all when the container owns the typography', () => {
    render(
      <Heading level={3} scale="inherit" className="text-[15px]">
        Details
      </Heading>,
    );

    const heading = screen.getByText('Details');
    // Exactly the caller's class and nothing else - this is the mode CardTitle
    // uses to keep its own 15px signature while gaining a real element.
    expect(heading.className).toBe('text-[15px]');
  });
});
