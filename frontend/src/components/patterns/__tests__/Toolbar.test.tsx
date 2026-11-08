/**
 * Toolbar - phase 10 rendered contract.
 *
 * Three things are asserted here.
 *
 * 1. NO SEARCH BOX WITHOUT `onSearchChange`. A Toolbar with only filters/
 *    actions must not render a search Input at all.
 * 2. THE SEARCH BOX USES THE REAL `Input` PRIMITIVE, not a raw `<input>` -
 *    the exact bypass this component exists to close.
 * 3. THE LAYERING RULE. `components/patterns` is ratcheted to a directory-
 *    wide appearance ceiling of 0 - every class this file itself authors is
 *    pinned below as LAYOUT, never appearance.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toolbar } from '@/components/patterns/Toolbar';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

describe('Toolbar - search slot', () => {
  it('renders no search box when onSearchChange is omitted', () => {
    render(<Toolbar filters={<span>a filter</span>} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('renders a real Input (not a raw <input> hand-styled by the call site) wired to the given handlers', async () => {
    const onSearchChange = vi.fn();
    render(<Toolbar searchValue="abc" onSearchChange={onSearchChange} searchPlaceholder="Search…" />);
    const box = screen.getByPlaceholderText('Search…');
    expect(box.tagName).toBe('INPUT');
    expect(box).toHaveValue('abc');
    await userEvent.type(box, 'd');
    expect(onSearchChange).toHaveBeenCalled();
  });

  it('forwards searchInputProps onto the internal Input, e.g. a compact size rung', () => {
    render(
      <Toolbar
        searchValue=""
        onSearchChange={vi.fn()}
        searchPlaceholder="Search…"
        searchInputProps={{ size: 'xs', className: 'pl-8' }}
      />
    );
    const box = screen.getByPlaceholderText('Search…');
    expect(cls(box)).toContain('h-8');
    expect(cls(box)).toContain('pl-8');
  });

  it('wraps a caller-supplied searchIcon in a LAYOUT-only positioning slot, not colouring it itself', () => {
    render(
      <Toolbar
        searchValue=""
        onSearchChange={vi.fn()}
        searchIcon={<svg data-testid="icon" aria-hidden />}
      />
    );
    const icon = screen.getByTestId('icon');
    const wrapper = icon.parentElement as HTMLElement;
    expect(cls(wrapper)).toBe('pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2');
  });

  it('renders no icon wrapper at all when searchIcon is omitted', () => {
    const { container } = render(<Toolbar searchValue="" onSearchChange={vi.fn()} />);
    expect(container.querySelector('.pointer-events-none')).toBeNull();
  });
});

describe('Toolbar - filters and actions slots', () => {
  it('renders filters after the search box, in document order', () => {
    render(
      <Toolbar searchValue="" onSearchChange={vi.fn()} filters={<button type="button">Category</button>} />
    );
    const box = screen.getByRole('textbox');
    const filterButton = screen.getByRole('button', { name: 'Category' });
    expect(box.compareDocumentPosition(filterButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('right-aligns actions via ml-auto (layout, not appearance)', () => {
    render(<Toolbar actions={<span data-testid="count">3 of 10</span>} />);
    const wrapper = screen.getByTestId('count').parentElement as HTMLElement;
    expect(cls(wrapper)).toBe('ml-auto flex items-center gap-2');
  });

  it('renders no actions wrapper when actions is omitted', () => {
    const { container } = render(<Toolbar filters={<span>x</span>} />);
    expect(container.querySelector('.ml-auto')).toBeNull();
  });
});

describe('Toolbar - root layout', () => {
  it('renders a flex row (Inline) with the default gap of 2', () => {
    const { container } = render(<Toolbar filters={<span>x</span>} />);
    expect(cls(container.firstElementChild)).toBe('flex flex-row flex-wrap gap-2 items-center');
  });

  it('accepts a custom gap step', () => {
    const { container } = render(<Toolbar filters={<span>x</span>} gap={3} />);
    expect(cls(container.firstElementChild)).toContain('gap-3');
  });
});
