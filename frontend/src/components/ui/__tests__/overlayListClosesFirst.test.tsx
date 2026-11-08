/**
 * Slice 07: with a list open inside a dialog or sheet, the FIRST click on the backdrop only
 * closes the list; it does not close the dialog and throw away the form behind it.
 *
 * Base got that for free, because the crew picker was a modal Radix Select that swallowed the
 * click. Now that the picker is a non-modal Combobox, that click reaches the dialog's own
 * click-outside handling. So the four overlay primitives hold the rule themselves, through one
 * shared helper (ui-kit/hooks/useListClosesFirst). The same four cases run against each.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { renderWithProviders } from '@/__tests__/helpers';
import { Combobox } from '@/components/ui/combobox';
import * as AppDialog from '@/components/ui/dialog';
import * as AppSheet from '@/components/ui/sheet';
import * as KitDialog from '@/ui-kit/components/ui/dialog';
import * as KitSheet from '@/ui-kit/components/ui/sheet';

type OnOutside = (event: Event) => void;
interface Surface {
  name: string;
  render: (props: { onOpenChange: (open: boolean) => void; onPointerDownOutside?: OnOutside; children: ReactNode }) => ReactNode;
}

const SURFACES: Surface[] = [
  {
    name: 'components/ui/dialog',
    render: ({ onOpenChange, onPointerDownOutside, children }) => (
      <AppDialog.Dialog open onOpenChange={onOpenChange}>
        <AppDialog.DialogContent onPointerDownOutside={onPointerDownOutside} aria-describedby={undefined}>
          <AppDialog.DialogTitle>Surface</AppDialog.DialogTitle>
          {children}
        </AppDialog.DialogContent>
      </AppDialog.Dialog>
    ),
  },
  {
    name: 'components/ui/sheet',
    render: ({ onOpenChange, onPointerDownOutside, children }) => (
      <AppSheet.Sheet open onOpenChange={onOpenChange}>
        <AppSheet.SheetContent onPointerDownOutside={onPointerDownOutside} aria-describedby={undefined}>
          <AppSheet.SheetTitle>Surface</AppSheet.SheetTitle>
          {children}
        </AppSheet.SheetContent>
      </AppSheet.Sheet>
    ),
  },
  {
    name: 'ui-kit dialog',
    render: ({ onOpenChange, onPointerDownOutside, children }) => (
      <KitDialog.Dialog open onOpenChange={onOpenChange}>
        <KitDialog.DialogContent onPointerDownOutside={onPointerDownOutside} aria-describedby={undefined}>
          <KitDialog.DialogTitle>Surface</KitDialog.DialogTitle>
          {children}
        </KitDialog.DialogContent>
      </KitDialog.Dialog>
    ),
  },
  {
    name: 'ui-kit sheet',
    render: ({ onOpenChange, onPointerDownOutside, children }) => (
      <KitSheet.Sheet open onOpenChange={onOpenChange}>
        <KitSheet.SheetContent onPointerDownOutside={onPointerDownOutside} aria-describedby={undefined}>
          <KitSheet.SheetTitle>Surface</KitSheet.SheetTitle>
          {children}
        </KitSheet.SheetContent>
      </KitSheet.Sheet>
    ),
  },
];

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
];

function setup(surface: Surface) {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const callerOutside = vi.fn();
  renderWithProviders(
    <>
      {surface.render({
        onOpenChange,
        onPointerDownOutside: callerOutside,
        children: <Combobox aria-label="Crew" value="" onValueChange={vi.fn()} options={OPTIONS} />,
      })}
    </>,
  );
  // The scrim: the surface's own sibling in the portal. Read before any list opens - the list's
  // popover is a role="dialog" too.
  const scrim = screen.getByRole('dialog').previousElementSibling as HTMLElement | null;
  if (!scrim?.hasAttribute('data-state')) throw new Error('backdrop not found');
  const backdrop = () => scrim;
  const openList = async () => {
    await user.click(screen.getByRole('combobox', { name: 'Crew' }));
    await screen.findByRole('option', { name: /Alpha/ });
  };
  return { user, onOpenChange, callerOutside, backdrop, openList };
}

describe.each(SURFACES)('$name - the first backdrop click closes an open list, not the surface', (surface) => {
  it('with a list open, a backdrop click keeps the surface open and closes the list', async () => {
    const { user, onOpenChange, backdrop, openList } = setup(surface);
    await openList();

    await user.click(backdrop());

    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('with no list open, a backdrop click closes the surface as before', async () => {
    const { user, onOpenChange, backdrop, openList } = setup(surface);
    await openList();
    await user.click(backdrop());
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());

    await user.click(backdrop());

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Escape is unchanged: the first closes the list, the next closes the surface', async () => {
    const { user, onOpenChange, openList } = setup(surface);
    await openList();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a caller's own onPointerDownOutside still runs, on both clicks", async () => {
    const { user, callerOutside, backdrop, openList } = setup(surface);
    await openList();

    await user.click(backdrop());
    await waitFor(() => expect(screen.queryByRole('option')).not.toBeInTheDocument());
    await user.click(backdrop());

    expect(callerOutside).toHaveBeenCalledTimes(2);
  });
});

/**
 * Code review #9: the guard's pointerdown recorder belongs to an OPEN surface. The four wrappers
 * render for every Dialog/Sheet in the tree whether it is open or not, so a recorder registered
 * from the wrapper itself ran on every click in the app, once per closed dialog on the page.
 */
describe('a closed surface registers no pointerdown listener', () => {
  const CLOSED: { name: string; render: (open: boolean) => ReactNode }[] = [
    {
      name: 'components/ui/dialog',
      render: (open) => (
        <AppDialog.Dialog open={open}>
          <AppDialog.DialogContent aria-describedby={undefined}><AppDialog.DialogTitle>S</AppDialog.DialogTitle></AppDialog.DialogContent>
        </AppDialog.Dialog>
      ),
    },
    {
      name: 'components/ui/sheet',
      render: (open) => (
        <AppSheet.Sheet open={open}>
          <AppSheet.SheetContent aria-describedby={undefined}><AppSheet.SheetTitle>S</AppSheet.SheetTitle></AppSheet.SheetContent>
        </AppSheet.Sheet>
      ),
    },
    {
      name: 'ui-kit dialog',
      render: (open) => (
        <KitDialog.Dialog open={open}>
          <KitDialog.DialogContent aria-describedby={undefined}><KitDialog.DialogTitle>S</KitDialog.DialogTitle></KitDialog.DialogContent>
        </KitDialog.Dialog>
      ),
    },
    {
      name: 'ui-kit sheet',
      render: (open) => (
        <KitSheet.Sheet open={open}>
          <KitSheet.SheetContent aria-describedby={undefined}><KitSheet.SheetTitle>S</KitSheet.SheetTitle></KitSheet.SheetContent>
        </KitSheet.Sheet>
      ),
    },
  ];

  /** Live capture-phase pointerdown listeners on the document, counted through add/remove. */
  function trackPointerdownCaptures() {
    let live = 0;
    const isCapture = (opts?: boolean | AddEventListenerOptions) =>
      opts === true || (typeof opts === 'object' && opts?.capture === true);
    const add = vi.spyOn(document, 'addEventListener').mockImplementation(function (this: Document, type, listener, opts) {
      if (type === 'pointerdown' && isCapture(opts)) live += 1;
      return EventTarget.prototype.addEventListener.call(this, type, listener, opts);
    });
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation(function (this: Document, type, listener, opts) {
      if (type === 'pointerdown' && isCapture(opts)) live -= 1;
      return EventTarget.prototype.removeEventListener.call(this, type, listener, opts);
    });
    return { live: () => live, restore: () => { add.mockRestore(); remove.mockRestore(); } };
  }

  it.each(CLOSED)('$name: none while closed, one while open, none again once closed', ({ render }) => {
    const tracker = trackPointerdownCaptures();
    try {
      const view = renderWithProviders(<>{render(false)}</>);
      expect(tracker.live()).toBe(0);

      view.rerender(<>{render(true)}</>);
      expect(tracker.live()).toBe(1);

      view.rerender(<>{render(false)}</>);
      expect(tracker.live()).toBe(0);
    } finally {
      tracker.restore();
    }
  });
});
