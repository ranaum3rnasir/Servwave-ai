/**
 * PageHeader - phase 7e rendered contract.
 *
 * Two things are asserted here, and they are different questions.
 *
 * 1. COVERAGE. The 2 <h1> class signatures PageHeader claims to cover (18 of
 *    the 36 measured page <h1> tags) must come out byte for byte. Anything
 *    less and 7f/11 would silently restyle a page while claiming a no-op.
 *
 * 2. THE LAYERING RULE. PageHeader lives in `components/patterns/`, which is
 *    NOT one of layering-guard's four shared directories, so an appearance
 *    class it hands to Heading / Stack / Button / Breadcrumb is a real
 *    violation that the guard would count. The rendered class of every element
 *    PageHeader itself creates is pinned below, which is what makes "it owns
 *    exactly one appearance decision, the description's two tokens" a fact
 *    rather than a claim in a comment.
 *
 * The back control is asserted against `buttonVariants` rather than a literal,
 * so it is provably the same class string the three measured sites
 * (CustomerFormPage.tsx:778, JobFormPage.tsx:238, LeadFormPage.tsx:444) render
 * - `variant="ghost" tone="subtle"`, phase 12c's replacement for the
 * deprecated `ghostMuted` alias those three sites used to write.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { PageHeader } from '@/components/patterns/PageHeader';
import { Button, buttonVariants } from '@/components/ui/button';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';
const sorted = (s: string) => s.split(/\s+/).filter(Boolean).sort();

/** PageHeader's own outer element. */
const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

const withRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('PageHeader - signature coverage', () => {
  it('covers signature 1 (x10) byte for byte: text-xl font-semibold text-text-primary', () => {
    render(<PageHeader title="Service Plans" />);
    const h = screen.getByRole('heading', { level: 1 });
    expect(h.tagName).toBe('H1');
    expect(cls(h)).toBe('text-xl font-semibold text-text-primary');
    expect(h).toHaveTextContent('Service Plans');
  });

  it('covers signature 2 (x8): the icon row, with the <h1> class unchanged', () => {
    const { container } = render(
      <PageHeader title="Invoices" icon={<svg data-testid="icon" aria-hidden />} />
    );
    const h = screen.getByRole('heading', { level: 1 });
    // The heading itself gains nothing - flex/items-center/gap-2 move to the
    // row, exactly as InvoicesPage.tsx:481 renders them today.
    expect(cls(h)).toBe('text-xl font-semibold text-text-primary');

    const row = screen.getByTestId('icon').parentElement as HTMLElement;
    expect(sorted(cls(row))).toEqual(sorted('flex flex-row items-center gap-2'));
    // icon first, then the heading - the reading order the 12 measured sites use
    expect(row.children[0]).toBe(screen.getByTestId('icon'));
    expect(row.children[1]).toBe(h);
    expect(container).toBeTruthy();
  });

  it('renders exactly one <h1> even with every slot filled', () => {
    withRouter(
      <PageHeader
        title="Vendors"
        icon={<svg aria-hidden />}
        description="Master vendor list"
        breadcrumbs={[{ label: 'Inventory', href: '/inventory' }, { label: 'Vendors' }]}
        back={{ onClick: () => {} }}
        actions={<Button>New</Button>}
      />
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('PageHeader - the one appearance decision it owns', () => {
  it('renders the description as <p class="text-sm text-text-secondary">', () => {
    render(<PageHeader title="Tasks" description="Plan, assign, and close the loop." />);
    const p = screen.getByText('Plan, assign, and close the loop.');
    expect(p.tagName).toBe('P');
    expect(cls(p)).toBe('text-sm text-text-secondary');
  });

  it('omits the description element entirely when there is no description', () => {
    const { container } = render(<PageHeader title="Tasks" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('every element PageHeader itself creates carries layout classes only', () => {
    const { container } = render(
      <PageHeader
        title="Statement"
        icon={<svg data-testid="icon" aria-hidden />}
        description="Running ledger"
        actions={<Button>Export</Button>}
      />
    );
    // The outer Stack, the actions row, the icon row, the title column and the
    // main row. Every class below is layout under both classifiers; the only
    // appearance in the whole subtree comes from Heading, Button and the <p>.
    expect(sorted(cls(root(container)))).toEqual(sorted('flex flex-col gap-0'));

    const p = screen.getByText('Running ledger');
    const titleColumn = p.parentElement as HTMLElement;
    expect(sorted(cls(titleColumn))).toEqual(sorted('flex flex-col gap-1 min-w-0'));

    const mainRow = titleColumn.parentElement as HTMLElement;
    expect(sorted(cls(mainRow))).toEqual(
      sorted('flex flex-row flex-wrap gap-3 items-start justify-between')
    );

    const actionsRow = screen.getByRole('button', { name: 'Export' }).parentElement as HTMLElement;
    expect(sorted(cls(actionsRow))).toEqual(
      sorted('flex flex-row flex-wrap gap-2 items-center shrink-0')
    );
  });

  it('uses items-center on the main row when there is no description', () => {
    render(<PageHeader title="Service Plans" actions={<Button>New Plan</Button>} />);
    // h1 -> title column -> main row. The title column is always present, so
    // the DOM shape does not change with the description.
    const titleColumn = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    expect(sorted(cls(titleColumn))).toEqual(sorted('flex flex-col gap-1 min-w-0'));
    const mainRow = titleColumn.parentElement as HTMLElement;
    expect(sorted(cls(mainRow))).toEqual(
      sorted('flex flex-row flex-wrap gap-3 items-center justify-between')
    );
  });

  it('emits no row wrapper at all when there are no actions', () => {
    const { container } = render(<PageHeader title="Leads" />);
    // outer Stack -> title column -> h1. No justify-between row is invented.
    const outer = root(container);
    expect(outer.children).toHaveLength(1);
    expect(sorted(cls(outer.children[0] as HTMLElement))).toEqual(
      sorted('flex flex-col gap-1 min-w-0')
    );
  });
});

describe('PageHeader - back navigation', () => {
  it('renders the same class string the three measured back-button sites render', () => {
    render(<PageHeader title="New Job" back={{ onClick: () => {} }} />);
    const btn = screen.getByRole('button', { name: 'Back' });
    expect(cls(btn)).toBe(
      buttonVariants({ variant: 'ghost', tone: 'subtle', size: 'sm', className: '-ml-1' })
    );
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('calls onClick, for the navigate(-1) shape', async () => {
    const onClick = vi.fn();
    render(<PageHeader title="New Customer" back={{ onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders a real link when given `to`, so open-in-new-tab keeps working', () => {
    withRouter(<PageHeader title="Sales by Tech" back={{ to: '/reports', label: 'Back to Reports' }} />);
    const link = screen.getByRole('link', { name: 'Back to Reports' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/reports');
    expect(cls(link)).toBe(
      buttonVariants({ variant: 'ghost', tone: 'subtle', size: 'sm', className: '-ml-1' })
    );
  });

  it('defaults the label to "Back" and puts the control before the title', () => {
    render(<PageHeader title="New Job" back={{ onClick: () => {} }} />);
    const btn = screen.getByRole('button', { name: 'Back' });
    const lead = btn.parentElement as HTMLElement;
    expect(sorted(cls(lead))).toEqual(sorted('flex flex-row gap-3 items-center min-w-0'));
    expect(lead.children[0]).toBe(btn);
    expect(within(lead.children[1] as HTMLElement).getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('renders no back control when `back` is omitted', () => {
    render(<PageHeader title="Leads" />);
    expect(screen.queryByRole('button', { name: /back/i })).toBeNull();
  });
});

describe('PageHeader - breadcrumbs', () => {
  it('renders the trail through the shipped Breadcrumb primitive', () => {
    withRouter(
      <PageHeader
        title="INV-1001"
        breadcrumbs={[{ label: 'Invoices', href: '/invoices' }, { label: 'INV-1001' }]}
      />
    );
    expect(screen.getByRole('link', { name: 'Invoices' }).getAttribute('href')).toBe('/invoices');
    expect(screen.getByRole('navigation')).toBeTruthy();
  });

  it('suppresses Breadcrumb\'s own back button so `back` is the only one', () => {
    withRouter(<PageHeader title="INV-1001" breadcrumbs={[{ label: 'INV-1001' }]} />);
    expect(screen.queryByRole('button', { name: 'Go back' })).toBeNull();
  });

  it('renders no navigation element when the trail is empty or omitted', () => {
    const { container } = render(<PageHeader title="Leads" breadcrumbs={[]} />);
    expect(container.querySelectorAll('nav')).toHaveLength(0);
  });
});

describe('PageHeader - slots and passthrough', () => {
  it('forwards className as layout and keeps its own classes', () => {
    const { container } = render(<PageHeader title="Leads" className="mb-4" />);
    expect(sorted(cls(root(container)))).toEqual(sorted('flex flex-col gap-0 mb-4'));
  });

  it('forwards arbitrary div props such as data-testid', () => {
    render(<PageHeader title="Leads" data-testid="leads-header" />);
    expect(screen.getByTestId('leads-header')).toBeTruthy();
  });

  it('puts actions after the title in DOM order', () => {
    render(<PageHeader title="Service Plans" actions={<Button>New Plan</Button>} />);
    const titleColumn = screen.getByRole('heading', { level: 1 }).parentElement as HTMLElement;
    const mainRow = titleColumn.parentElement as HTMLElement;
    expect(mainRow.children).toHaveLength(2);
    expect(mainRow.children[0]).toBe(titleColumn);
    expect(within(mainRow.children[1] as HTMLElement).getByRole('button', { name: 'New Plan' })).toBeTruthy();
  });
});
