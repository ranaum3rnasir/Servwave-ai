import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

/**
 * Mobile slice 44 follow-up: the menu panel is capped to the room under its trigger and scrolls past
 * that (a landscape phone is 390 px tall), and a scroll box has to be in the tab order or a keyboard
 * cannot reach it (axe `scrollable-region-focusable`). Radix leaves the panel at tabindex -1, so the
 * kit panel sets 0. The mobile gate's `popovers-and-pickers.spec.ts` measures the real scroll.
 */
describe('kit DropdownMenuContent: reachable by keyboard when it scrolls', () => {
  it('is in the tab order, and the menu still takes arrow-key focus on its items', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Status</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Status">
          <DropdownMenuItem>New</DropdownMenuItem>
          <DropdownMenuItem>Won</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Status' }));
    const menu = await screen.findByRole('menu', { name: 'Status' });
    expect(menu).toHaveAttribute('tabindex', '0');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'New' })).toHaveFocus();
  });
});
