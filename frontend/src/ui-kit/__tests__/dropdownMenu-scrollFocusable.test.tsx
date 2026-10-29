import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

/**
 * Mobile slice 55 fix: the menu panel scrolls (`overflow-y-auto`, capped at the space the browser
 * has left), and a scrolling region that nothing in the tab order reaches fails axe's
 * `scrollable-region-focusable` rule. The status menu on a lead, opened on a phone held sideways
 * (390 px tall), is such a panel: a few pixels of scroll under a header that moved down a row.
 * Radix keeps every item at tabindex -1, so the panel itself is made a tab stop.
 */
describe('DropdownMenuContent is a keyboard-reachable scroll region', () => {
  it('has tabindex 0 once open, so a scrolling menu passes the focusable-region rule', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Pick one">
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuItem>Two</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const menu = await screen.findByRole('menu');
    expect(menu.getAttribute('tabindex')).toBe('0');
  });
});
