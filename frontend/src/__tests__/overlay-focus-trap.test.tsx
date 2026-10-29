/**
 * Mobile slice 16 (A11Y-04): the hand-rolled overlays move onto the dialog primitive, so each
 * one moves focus in when it opens, keeps Tab inside itself while open, and hands focus back to
 * the control that opened it when it closes.
 *
 * The five overlays: the schedule's three confirmations (the 409 conflict, "Nobody is assigned"
 * and "Move to Unscheduled?") and the two photo/video lightboxes. Each is driven the way a
 * keyboard or screen-reader user meets it: an opener button on the page, another control behind
 * the overlay that Tab must never reach, then a dismissal.
 */
import { useState, type ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { ConflictModal } from '@/pages/v2/schedule/components/conflictModal';
import { NeedsCrewConfirm } from '@/pages/v2/schedule/components/needsCrewConfirm';
import { UnscheduleConfirm } from '@/pages/v2/schedule/components/unscheduleConfirm';

const TZ = 'America/New_York';

/** An opener, a control behind the overlay, and the overlay itself while open. */
function Page({ overlay }: { overlay: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open it
      </button>
      <button type="button">Behind the overlay</button>
      {open && overlay(() => setOpen(false))}
    </div>
  );
}

/** The overlay's own surface: the dialog or alertdialog that holds focus. */
function surface(): HTMLElement {
  const all = [...screen.queryAllByRole('dialog'), ...screen.queryAllByRole('alertdialog')];
  if (all.length !== 1) throw new Error(`expected one open overlay, found ${all.length}`);
  return all[0]!;
}

async function expectFocusTrapped(user: ReturnType<typeof userEvent.setup>) {
  const panel = surface();
  // Focus moved in on open.
  await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  // Tab and Shift+Tab never leave it, however many times they are pressed.
  for (let i = 0; i < 6; i++) {
    await user.tab();
    expect(panel.contains(document.activeElement), `Tab #${i + 1} left the overlay for "${(document.activeElement as HTMLElement | null)?.textContent}"`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await user.tab({ shift: true });
    expect(panel.contains(document.activeElement), `Shift+Tab #${i + 1} left the overlay`).toBe(true);
  }
}

async function expectFocusBackOnOpener() {
  const opener = screen.getByRole('button', { name: 'Open it' });
  await waitFor(() => expect(screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
}

interface Case {
  name: string;
  overlay: (close: () => void) => ReactNode;
  /** The accessible name of the overlay surface. */
  label: RegExp;
  /** The button that dismisses it without acting. */
  dismiss: RegExp;
}

const CASES: Case[] = [
  {
    name: 'schedule conflict confirm',
    overlay: (close) => <ConflictModal message="A performer is double-booked." tz={TZ} onCancel={close} onConfirm={vi.fn()} />,
    label: /scheduling conflict/i,
    dismiss: /^cancel$/i,
  },
  {
    name: '"Nobody is assigned" confirm',
    overlay: (close) => <NeedsCrewConfirm number="J00041" onBack={close} onConfirm={vi.fn()} />,
    label: /nobody is assigned|schedule with no crew/i,
    dismiss: /^back$/i,
  },
  {
    name: '"Move to Unscheduled?" confirm',
    overlay: (close) => <UnscheduleConfirm number="J00041" keepsAnotherVisit={false} onCancel={close} onConfirm={vi.fn()} />,
    label: /move to unscheduled/i,
    dismiss: /^cancel$/i,
  },
  {
    name: 'photo lightbox',
    overlay: (close) => (
      <AttachmentLightbox url="https://x.test/a.png" caption="Front door" onDelete={vi.fn()} onDownload={vi.fn()} onClose={close} />
    ),
    label: /attachment preview/i,
    dismiss: /close preview/i,
  },
  {
    name: 'video lightbox',
    overlay: (close) => <VideoPreviewDialog url="https://x.test/a.mp4" onClose={close} />,
    label: /video preview/i,
    dismiss: /close preview/i,
  },
];

describe.each(CASES)('$name', ({ overlay, label, dismiss }) => {
  it('is a named modal surface', async () => {
    const user = userEvent.setup();
    render(<Page overlay={overlay} />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    const panel = surface();
    expect(panel).toHaveAccessibleName(label);
    // Modal: the page behind it is hidden from assistive technology while it is open.
    const behind = screen.getByRole('button', { name: 'Behind the overlay', hidden: true });
    expect(behind.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('moves focus in, traps it, and returns it to the opener when dismissed', async () => {
    const user = userEvent.setup();
    render(<Page overlay={overlay} />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await expectFocusTrapped(user);
    await user.click(screen.getByRole('button', { name: dismiss }));
    await expectFocusBackOnOpener();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Page overlay={overlay} />);
    await user.click(screen.getByRole('button', { name: 'Open it' }));
    await waitFor(() => expect(surface().contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await expectFocusBackOnOpener();
  });
});
