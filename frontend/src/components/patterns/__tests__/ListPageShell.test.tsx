/**
 * ListPageShell - phase 7e rendered contract.
 *
 * Three questions, and they are different.
 *
 * 1. THE SHAPE. The measured list page is `space-y-6` + header + band +
 *    content, unanimous across the five <h1>-plus-DataTable pages. The shell
 *    must produce that and nothing else - in particular it must not invent a
 *    wrapper element around the content, because a wrapper collapses the seam
 *    between two content siblings from 24px to 0 and 7f would ship that as a
 *    silent regression.
 *
 * 2. THE ROUTER. `loading` beats `empty` beats `children`, and a flag whose
 *    slot was not filled falls through to `children` rather than blanking the
 *    region. The inverse precedence is the flash of "nothing here yet" over a
 *    list that is still arriving; it is asserted here rather than left to
 *    reading order.
 *
 * 3. THE LAYERING RULE. `components/patterns/` is NOT one of layering-guard's
 *    four shared directories, so any appearance class this file handed to
 *    Stack or PageHeader would be a real counted violation. ListPageShell
 *    authors no className at all, and the root's exact class string is pinned
 *    below so that stays a fact rather than a claim in a comment.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { ListPageShell } from '@/components/patterns/ListPageShell';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';
const sorted = (s: string) => s.split(/\s+/).filter(Boolean).sort();

/** ListPageShell's own outer element. */
const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

describe('ListPageShell - the measured list-page shape', () => {
  it('renders the root as a flex column at the measured list rhythm, gap 6', () => {
    const { container } = render(
      <ListPageShell header={{ title: 'Invoices' }}>
        <div data-testid="content" />
      </ListPageShell>
    );
    expect(sorted(cls(root(container)))).toEqual(sorted('flex flex-col gap-6'));
  });

  it('takes a different step for the detail/form pages measured at space-y-4', () => {
    const { container } = render(
      <ListPageShell gap={4}>
        <div />
      </ListPageShell>
    );
    expect(sorted(cls(root(container)))).toEqual(sorted('flex flex-col gap-4'));
  });

  it('puts header, band and content in that order, each a direct flex item', () => {
    const { container } = render(
      <ListPageShell header={{ title: 'Invoices' }} band={<div data-testid="band" />}>
        <div data-testid="content" />
      </ListPageShell>
    );
    const kids = [...root(container).children];
    expect(kids).toHaveLength(3);
    expect(kids[0]).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(kids[1]).toBe(screen.getByTestId('band'));
    expect(kids[2]).toBe(screen.getByTestId('content'));
  });

  it('emits no wrapper around the content, so several content siblings keep the gap', () => {
    const { container } = render(
      <ListPageShell header={{ title: 'Invoices' }}>
        <div data-testid="table" />
        <div data-testid="dialog" />
      </ListPageShell>
    );
    // header + 2 content siblings, all direct children of the gap-6 column -
    // exactly what `<div className="space-y-6">` gives those pages today.
    const kids = [...root(container).children];
    expect(kids).toHaveLength(3);
    expect(kids[1]).toBe(screen.getByTestId('table'));
    expect(kids[2]).toBe(screen.getByTestId('dialog'));
  });

  it('emits no element for a band or a header that was not given', () => {
    const { container } = render(
      <ListPageShell>
        <div data-testid="content" />
      </ListPageShell>
    );
    const kids = [...root(container).children];
    expect(kids).toHaveLength(1);
    expect(kids[0]).toBe(screen.getByTestId('content'));
    expect(container.querySelectorAll('h1')).toHaveLength(0);
  });
});

describe('ListPageShell - composition with PageHeader', () => {
  it('renders the header through PageHeader, one <h1>, signature unchanged', () => {
    render(
      <ListPageShell header={{ title: 'Invoices' }}>
        <div />
      </ListPageShell>
    );
    const h = screen.getByRole('heading', { level: 1 });
    expect(h.tagName).toBe('H1');
    // Byte-identical to the x10 signature PageHeader covers, and therefore to
    // InvoicesPage.tsx:481 as it renders today.
    expect(cls(h)).toBe('text-xl font-semibold text-text-primary');
    expect(h).toHaveTextContent('Invoices');
  });

  it('passes the whole PageHeaderProps surface through, not a re-declared subset', () => {
    render(
      <MemoryRouter>
        <ListPageShell
          header={{
            title: 'INV-1001',
            icon: <svg data-testid="icon" aria-hidden />,
            description: 'Issued 12 May',
            breadcrumbs: [{ label: 'Invoices', href: '/invoices' }, { label: 'INV-1001' }],
            back: { to: '/invoices', label: 'Back to Invoices' },
            actions: <button type="button">Send</button>,
          }}
        >
          <div />
        </ListPageShell>
      </MemoryRouter>
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('icon')).toBeTruthy();
    expect(screen.getByText('Issued 12 May').tagName).toBe('P');
    expect(screen.getByRole('link', { name: 'Back to Invoices' }).getAttribute('href')).toBe(
      '/invoices'
    );
    expect(screen.getByRole('link', { name: 'Invoices' }).getAttribute('href')).toBe('/invoices');
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('ListPageShell - the loading / empty router', () => {
  const shell = (props: Partial<React.ComponentProps<typeof ListPageShell>>) =>
    render(
      <ListPageShell
        header={{ title: 'Invoices' }}
        band={<div data-testid="band" />}
        loadingState={<Skeleton data-testid="placeholder" className="h-16 w-full" />}
        emptyState={<EmptyState title="No invoices yet." />}
        {...props}
      >
        <div data-testid="content" />
      </ListPageShell>
    );

  it('renders children when neither flag is set', () => {
    shell({});
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(screen.queryByTestId('placeholder')).toBeNull();
    expect(screen.queryByText('No invoices yet.')).toBeNull();
  });

  it('swaps the content region for loadingState while loading', () => {
    shell({ loading: true });
    expect(screen.getByTestId('placeholder')).toBeTruthy();
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('swaps the content region for emptyState when empty', () => {
    shell({ empty: true });
    expect(screen.getByText('No invoices yet.')).toBeTruthy();
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('gives loading precedence over empty, so an empty state never flashes mid-load', () => {
    shell({ loading: true, empty: true });
    expect(screen.getByTestId('placeholder')).toBeTruthy();
    expect(screen.queryByText('No invoices yet.')).toBeNull();
    expect(screen.queryByTestId('content')).toBeNull();
  });

  it('falls through to children when loading is set but its slot was not filled', () => {
    shell({ loading: true, empty: true, loadingState: undefined });
    // Degrades to today's behaviour, never to a blank region - and it must not
    // fall sideways into emptyState, which would reintroduce the flash.
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(screen.queryByText('No invoices yet.')).toBeNull();
  });

  it('falls through to children when empty is set but its slot was not filled', () => {
    shell({ empty: true, emptyState: undefined });
    expect(screen.getByTestId('content')).toBeTruthy();
  });

  it('keeps header and band mounted through both states', () => {
    const { rerender } = render(
      <ListPageShell
        header={{ title: 'Invoices' }}
        band={<div data-testid="band" />}
        loading
        loadingState={<Skeleton data-testid="placeholder" />}
        emptyState={<EmptyState title="No invoices yet." />}
      >
        <div data-testid="content" />
      </ListPageShell>
    );
    expect(screen.getByTestId('band')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();

    rerender(
      <ListPageShell
        header={{ title: 'Invoices' }}
        band={<div data-testid="band" />}
        empty
        loadingState={<Skeleton data-testid="placeholder" />}
        emptyState={<EmptyState title="No invoices yet." />}
      >
        <div data-testid="content" />
      </ListPageShell>
    );
    // A KpiStrip renders its own placeholders from its own `loading` prop; the
    // shell must never swap the band away from under it.
    expect(screen.getByTestId('band')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});

describe('ListPageShell - slots, passthrough and the layering rule', () => {
  it('authors no className of its own - the root is exactly Stack plus the caller', () => {
    const { container } = render(
      <ListPageShell header={{ title: 'Invoices' }} className="mx-auto max-w-7xl">
        <div />
      </ListPageShell>
    );
    expect(sorted(cls(root(container)))).toEqual(
      sorted('flex flex-col gap-6 mx-auto max-w-7xl')
    );
  });

  it('forwards arbitrary div props such as data-testid', () => {
    render(
      <ListPageShell data-testid="invoices-page">
        <div />
      </ListPageShell>
    );
    expect(screen.getByTestId('invoices-page')).toBeTruthy();
  });

  it('forwards a ref to the outer element', () => {
    const ref = React.createRef<HTMLDivElement>();
    const { container } = render(
      <ListPageShell ref={ref}>
        <div />
      </ListPageShell>
    );
    expect(ref.current).toBe(root(container));
  });
});
