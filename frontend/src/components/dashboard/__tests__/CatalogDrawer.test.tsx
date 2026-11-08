/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CatalogDrawer from '../CatalogDrawer';

// #371 (hardening) — same bug class as the sidebar overflow: a long widget title
// in the w-64 catalog drawer row would push the ✓/＋ affordance out of view.
// jsdom cannot measure layout overflow, so the tests pin the CSS contract:
// title span `min-w-0 truncate` so the flex item shrinks + ellipsizes.
describe('CatalogDrawer', () => {
  it('truncates widget titles so the add (＋) affordance always stays in view', () => {
    render(<CatalogDrawer open layout={[]} onAdd={vi.fn()} onClose={vi.fn()} />);

    const title = screen.getByText('Dispatch Scoreboard');
    expect(title).toHaveClass('truncate');
    expect(title).toHaveClass('min-w-0');
    // Full name stays discoverable on hover once truncated.
    expect(title).toHaveAttribute('title', 'Dispatch Scoreboard');

    // The matching add button (aria-label) is present alongside the title.
    expect(
      screen.getByRole('button', { name: 'Add Dispatch Scoreboard' })
    ).toBeInTheDocument();
  });
});
