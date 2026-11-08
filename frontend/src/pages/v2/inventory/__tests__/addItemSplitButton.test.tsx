// Slice 17 D1 - "Manage categories" opens a NON-modal panel elsewhere on the
// page. If it opens while the menu is still mounted (closing, animating out),
// the menu can take focus back - a pointerleave on the item focuses the menu's
// own content - and the panel sees focus outside and closes itself. So the
// entry's action runs only once the menu is gone. jsdom cannot reproduce the
// pointer/scroll race itself (the Playwright script
// $SP/s17/manage-stays-open.mjs does); this pins the ordering it depends on.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddItemSplitButton } from '../components/addItemSplitButton';

function renderButton(onManageCategories: () => void) {
  render(
    <AddItemSplitButton
      onAddItem={vi.fn()}
      onAddCategory={vi.fn()}
      onManageCategories={onManageCategories}
    />,
  );
}

describe('AddItemSplitButton - "Manage categories" sequencing', () => {
  it('runs only after the menu has closed and left the DOM', async () => {
    const menuPresentWhenCalled: boolean[] = [];
    const onManage = vi.fn(() => {
      menuPresentWhenCalled.push(document.querySelector('[role="menu"]') !== null);
    });
    renderButton(onManage);

    await userEvent.click(screen.getByRole('button', { name: 'More add options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Manage categories' }));

    await waitFor(() => expect(onManage).toHaveBeenCalledTimes(1));
    expect(menuPresentWhenCalled).toEqual([false]);
  });

  it('runs from the keyboard too, once', async () => {
    const onManage = vi.fn();
    renderButton(onManage);

    screen.getByRole('button', { name: 'More add options' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('menu');
    await userEvent.keyboard('{End}{Enter}');

    await waitFor(() => expect(onManage).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not run when the menu is dismissed without choosing it', async () => {
    const onManage = vi.fn();
    renderButton(onManage);

    await userEvent.click(screen.getByRole('button', { name: 'More add options' }));
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(onManage).not.toHaveBeenCalled();
  });
});
