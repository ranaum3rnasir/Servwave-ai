import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatCard } from '@/ui-kit/components/data/statCard';

/**
 * A KPI tile is a title, a number, and - since #2011 - an optional second
 * figure of the same metric underneath.
 *
 * This file used to pin the opposite: a `meta` caption slot ("42% of $80,000
 * goal") and a `delta` chip with a polarity model behind it, so a falling cost
 * could read green. Both stay gone at the owner's call - that ruling was never
 * about the value having no company, it was about a caption or a sentiment
 * chip - and neither survives as an accepted-and-ignored prop, so a call site
 * that still passes one is a compile error rather than a silent drop. That is
 * the same rule `children` is held to here, for the same reason: this
 * component has already shipped one prop that vanished without a word.
 *
 * What is left to pin is that a tile with no `detail` renders the label and
 * the value and no third node, in both the loaded and the loading state - a
 * caption relocated into some other wrapper would pass an "is the badge gone"
 * check and fail this one - and that a tile WITH `detail` renders it as a
 * dedicated, marked node rather than folded into the value.
 */
describe('kit StatCard content', () => {
  it('renders the label and the value, and nothing else', () => {
    const { container } = render(<StatCard label="Revenue" value="$33,600" />);

    const tile = container.querySelector('[data-slot="stat-card"]')!;
    expect(tile.textContent).toBe('Revenue$33,600');
    // The two slots this card used to have, by the markers they left behind.
    expect(container.querySelector('[data-slot="stat-card-meta"]')).toBeNull();
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it('takes a node for the value, so a number can carry its own formatting', () => {
    render(<StatCard label="Won" value={<span data-testid="money">$12,004</span>} />);

    expect(screen.getByTestId('money')).toBeInTheDocument();
  });

  it('shows two skeleton bars while loading, one per line the loaded tile has', () => {
    const { container } = render(<StatCard label="Revenue" value="$33,600" loading />);

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  });

  it('renders detail in a dedicated node under the value, when passed', () => {
    const { container } = render(
      <StatCard label="Draft" value={11} detail="$1,357.19" />,
    );

    const detailNode = container.querySelector('[data-slot="stat-card-detail"]');
    expect(detailNode).not.toBeNull();
    expect(detailNode!.textContent).toBe('$1,357.19');
  });

  it('shows three skeleton bars while loading, when detail is passed', () => {
    const { container } = render(
      <StatCard label="Draft" value={11} detail="$1,357.19" loading />,
    );

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  });

  it('is a button only when it can be clicked, so a static tile is not in the tab order', () => {
    const { rerender } = render(<StatCard label="Open jobs" value={12} />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<StatCard label="Open jobs" value={12} active onClick={() => {}} />);
    const button = screen.getByRole('button', { name: /open jobs/i });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
