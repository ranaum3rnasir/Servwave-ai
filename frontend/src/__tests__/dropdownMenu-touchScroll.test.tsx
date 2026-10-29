import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  DropdownMenu as LegacyMenu, DropdownMenuContent as LegacyContent, DropdownMenuItem as LegacyItem,
  DropdownMenuTrigger as LegacyTrigger,
} from '@/components/ui/dropdown-menu';
import {
  DropdownMenu as KitMenu, DropdownMenuContent as KitContent, DropdownMenuItem as KitItem,
  DropdownMenuTrigger as KitTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

/**
 * Mobile slice 73 follow-up (real-device row RD-11, TOUCH-12): a finger that goes down on a menu
 * button and turns into a scroll must not open the menu. Radix opens a dropdown on `pointerdown`
 * for every pointer type, so a touch that starts on a row's "More actions" button opened the menu
 * before the browser decided the touch was a scroll. A touch or pen now opens the menu on the
 * `click` (the pointer went up where it went down); a mouse still opens on press, and the keyboard
 * and a screen reader's activation are unchanged. Both menu families share the one trigger.
 */
const families = [
  { name: 'kit menu', Menu: KitMenu, Content: KitContent, Item: KitItem, Trigger: KitTrigger },
  { name: 'legacy menu', Menu: LegacyMenu, Content: LegacyContent, Item: LegacyItem, Trigger: LegacyTrigger },
];

describe.each(families)('$name trigger on touch', ({ Menu, Content, Item, Trigger }) => {
  const setup = (props: { onOpenChange?: (o: boolean) => void } = {}) => {
    render(
      <Menu {...props}>
        <Trigger>Row actions</Trigger>
        <Content aria-label="Row actions">
          <Item>Edit</Item>
        </Content>
      </Menu>,
    );
    return screen.getByRole('button', { name: 'Row actions' });
  };
  const touch = { pointerType: 'touch', button: 0, isPrimary: true };

  it('does not open when a touch goes down on the button and turns into a scroll', () => {
    const button = setup();
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerMove(button, { ...touch, clientY: 40 });
    // The browser takes the touch for a scroll: it cancels the pointer, and no click follows.
    fireEvent.pointerCancel(button, touch);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves the browser\'s pointerdown uncancelled, so the tap\'s click is not suppressed (WebKit drops the click otherwise)', () => {
    const button = setup();
    // fireEvent returns false when the event was cancelled.
    expect(fireEvent.pointerDown(button, touch)).toBe(true);
    expect(fireEvent.pointerDown(button, { ...touch, pointerType: 'pen' })).toBe(true);
  });

  it('does not open on the press itself, only on the tap that follows', () => {
    const button = setup();
    fireEvent.pointerDown(button, touch);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerUp(button, touch);
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens on a pen tap the same way', () => {
    const button = setup();
    fireEvent.pointerDown(button, { ...touch, pointerType: 'pen' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.pointerUp(button, { ...touch, pointerType: 'pen' });
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('opens once, and reports it once, on a tap', () => {
    const onOpenChange = vi.fn();
    const button = setup({ onOpenChange });
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerUp(button, touch);
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe.each(families)('$name trigger on mouse, keyboard and assistive technology', ({ Menu, Content, Item, Trigger }) => {
  const setup = () => {
    render(
      <Menu>
        <Trigger>Row actions</Trigger>
        <Content aria-label="Row actions">
          <Item>Edit</Item>
        </Content>
      </Menu>,
    );
    return screen.getByRole('button', { name: 'Row actions' });
  };

  it('a mouse click opens it, and Escape closes it', async () => {
    const user = userEvent.setup();
    const button = setup();
    await user.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a mouse press opens it before the button is released, and the click does not shut it', () => {
    const button = setup();
    fireEvent.pointerDown(button, { pointerType: 'mouse', button: 0, ctrlKey: false });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerUp(button, { pointerType: 'mouse', button: 0 });
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it.each([['{Enter}'], [' '], ['{ArrowDown}']])('the keyboard opens it with %s', async (key) => {
    const user = userEvent.setup();
    const button = setup();
    button.focus();
    await user.keyboard(key);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('a click with no pointer press before it (a screen reader activation) opens it', () => {
    const button = setup();
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('keeps the trigger\'s aria attributes, closed and open', async () => {
    const user = userEvent.setup();
    const button = setup();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('data-state', 'closed');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveAttribute('data-state', 'open');
    expect(button).toHaveAttribute('aria-controls', screen.getByRole('menu').id);
  });

  it('a mouse click and a later screen reader click do not leak into each other', async () => {
    const user = userEvent.setup();
    const button = setup();
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('the trigger on a controlled menu', () => {
  it('a touch tap asks the owner to open it, a scroll does not', () => {
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <KitMenu open={open} onOpenChange={(o) => { onOpenChange(o); setOpen(o); }}>
          <KitTrigger>Row actions</KitTrigger>
          <KitContent aria-label="Row actions"><KitItem>Edit</KitItem></KitContent>
        </KitMenu>
      );
    }
    render(<Controlled />);
    const button = screen.getByRole('button', { name: 'Row actions' });
    const touch = { pointerType: 'touch', button: 0 };
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerCancel(button, touch);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(button, touch);
    fireEvent.pointerUp(button, touch);
    fireEvent.click(button);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
