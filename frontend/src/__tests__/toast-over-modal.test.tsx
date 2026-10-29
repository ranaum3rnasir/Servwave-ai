/**
 * Mobile slice 27, staging fix 1: a toast raised from inside an open modal (Mark Sent, Send
 * Estimate, Send Invoice raise a never-auto-dismiss error toast while the dialog is still open)
 * must be closable without taking the dialog and its unsaved form down with it.
 *
 * Radix treats any pointer press outside a modal's content as "dismiss", and the toaster is outside
 * it. So pressing the toast's close used to be a press on the scrim as far as the dialog was
 * concerned (once the toast could be pressed at all). The four modal primitives share one
 * `onPointerDownOutside` guard (ui-kit/hooks/useListClosesFirst); a press that lands on the
 * toaster is not an outside press.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/__tests__/helpers';
import * as AppDialog from '@/components/ui/dialog';
import * as AppSheet from '@/components/ui/sheet';
import * as KitDialog from '@/ui-kit/components/ui/dialog';
import * as KitSheet from '@/ui-kit/components/ui/sheet';
import { Toaster } from '@/ui-kit/components/ui/sonner';

interface Surface {
  name: string;
  render: (props: { onOpenChange: (open: boolean) => void }) => ReactNode;
}

const SURFACES: Surface[] = [
  {
    name: 'components/ui/dialog',
    render: ({ onOpenChange }) => (
      <AppDialog.Dialog open onOpenChange={onOpenChange}>
        <AppDialog.DialogContent aria-describedby={undefined}>
          <AppDialog.DialogTitle>Surface</AppDialog.DialogTitle>
        </AppDialog.DialogContent>
      </AppDialog.Dialog>
    ),
  },
  {
    name: 'components/ui/sheet',
    render: ({ onOpenChange }) => (
      <AppSheet.Sheet open onOpenChange={onOpenChange}>
        <AppSheet.SheetContent aria-describedby={undefined}>
          <AppSheet.SheetTitle>Surface</AppSheet.SheetTitle>
        </AppSheet.SheetContent>
      </AppSheet.Sheet>
    ),
  },
  {
    name: 'ui-kit dialog',
    render: ({ onOpenChange }) => (
      <KitDialog.Dialog open onOpenChange={onOpenChange}>
        <KitDialog.DialogContent aria-describedby={undefined}>
          <KitDialog.DialogTitle>Surface</KitDialog.DialogTitle>
        </KitDialog.DialogContent>
      </KitDialog.Dialog>
    ),
  },
  {
    name: 'ui-kit sheet',
    render: ({ onOpenChange }) => (
      <KitSheet.Sheet open onOpenChange={onOpenChange}>
        <KitSheet.SheetContent aria-describedby={undefined}>
          <KitSheet.SheetTitle>Surface</KitSheet.SheetTitle>
        </KitSheet.SheetContent>
      </KitSheet.Sheet>
    ),
  },
];

beforeAll(() => {
  // sonner's swipe-to-dismiss captures the pointer; jsdom has no pointer capture.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
  cleanup();
});

async function setup(surface: Surface) {
  // Radix sets this on <body> for a modal; jsdom needs it said, user-event honours it.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const onOpenChange = vi.fn();
  renderWithProviders(
    <>
      {surface.render({ onOpenChange })}
      <Toaster />
    </>,
  );
  const scrim = screen.getByRole('dialog').previousElementSibling as HTMLElement | null;
  if (!scrim?.hasAttribute('data-state')) throw new Error('backdrop not found');
  act(() => {
    sonnerToast.error('Could not mark as sent', { duration: Infinity });
  });
  const toast = await waitFor(() => {
    const el = document.querySelector('[data-sonner-toast]') as HTMLElement | null;
    if (!el) throw new Error('toast not shown yet');
    return el;
  });
  return { user, onOpenChange, scrim, toast };
}

describe.each(SURFACES)('$name - a toast raised over the open modal', (surface) => {
  it("closing the toast leaves the modal open", async () => {
    const { user, onOpenChange, toast } = await setup(surface);

    await user.click(within(toast).getByRole('button', { name: /close/i }));

    await waitFor(() => expect(screen.queryByText('Could not mark as sent')).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('pressing the toast body leaves the modal open too', async () => {
    const { user, onOpenChange, toast } = await setup(surface);

    await user.click(within(toast).getByText('Could not mark as sent'));

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('a press on the scrim still dismisses the modal (the guard is toast-only)', async () => {
    const { user, onOpenChange, scrim } = await setup(surface);

    await user.click(scrim);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
