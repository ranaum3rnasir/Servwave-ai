// Mobile slice 26: an overlay states its intent and the width picks the presentation. Exactly one
// variant mounts, the header carries a 44 px-on-touch close, and the footer is padded by the
// bottom safe area. jsdom applies no CSS, so the presentation is read from `data-presentation`
// and the classes that carry the geometry.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, sheetVariants } from '@/ui-kit/components/ui/sheet';

function mockWidth(opts: { belowMd: boolean; shortHeight?: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      (query === MEDIA.belowMd && opts.belowMd) || (query === MEDIA.shortHeight && !!opts.shortHeight),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function Form({ intent }: { intent?: 'form' | 'choice' | 'content' }) {
  return (
    <Dialog open>
      <DialogContent intent={intent} aria-describedby={undefined}>
        <DialogHeader><DialogTitle>New thing</DialogTitle></DialogHeader>
        <DialogBody><input aria-label="Name" /></DialogBody>
        <DialogFooter><button type="button">Save</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('kit DialogContent with an intent', () => {
  it('a form is full-screen on a phone', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="form" />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content).toHaveAttribute('data-presentation', 'fullscreen');
    expect(content.className).toContain('inset-0');
    expect(content.className).toContain('h-[calc(100dvh-var(--keyboard-inset,0px))]');
  });

  it('a form is full-screen on a landscape phone (wide but short)', () => {
    mockWidth({ belowMd: false, shortHeight: true });
    render(<Form intent="form" />);
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveAttribute('data-presentation', 'fullscreen');
  });

  it('a choice is a bottom sheet on a phone, capped by the dynamic viewport', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="choice" />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(content.className).toContain('bottom-[var(--keyboard-inset,0px)]');
    expect(content.className).toMatch(/max-h-\[min\(\d+dvh,/);
  });

  it('stays a centred card at md and up, as today', () => {
    mockWidth({ belowMd: false });
    render(<Form intent="form" />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content).toHaveAttribute('data-presentation', 'card');
    expect(content.className).toContain('max-w-[27.5rem]');
    expect(content.className).not.toContain('h-dvh');
  });

  it('a dialog with no intent is the card at every width (nothing changes until it opts in)', () => {
    mockWidth({ belowMd: true });
    render(<Form />);
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveAttribute('data-presentation', 'card');
  });

  it('mounts exactly one variant', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="form" />);
    expect(document.querySelectorAll('[data-slot="dialog-content"]')).toHaveLength(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('the close is 44 px on a coarse pointer, and the footer is padded by the bottom safe area', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="form" />);
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('touch:size-11');
    expect(document.querySelector('[data-slot="dialog-footer"]')!.className).toContain('var(--safe-bottom,0px)');
  });

  it('the full-screen close clears the status bar even on a coarse pointer (slice 25 offset must not win)', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="form" />);
    const cls = screen.getByRole('button', { name: 'Close' }).className;
    expect(cls).toContain('touch:top-[calc(env(safe-area-inset-top)+0.375rem)]');
    expect(cls).not.toContain('touch:top-1.5');
  });

  it('the body is the only scroller and keeps room for the sticky header and footer', () => {
    mockWidth({ belowMd: true });
    render(<Form intent="form" />);
    const body = document.querySelector('[data-slot="dialog-body"]')!;
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
    expect(body.className).toMatch(/scroll-py-/);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content.className).toContain('overflow-hidden');
  });
});

describe('kit sheet', () => {
  it('the bottom variant is capped by the dynamic viewport height, not the layout viewport', () => {
    const cls = sheetVariants({ side: 'bottom' });
    expect(cls).toMatch(/max-h-\[min\(\d+dvh,/);
    expect(cls).not.toMatch(/max-h-\[\d+vh\]/);
  });

  it('a form sheet is full-screen on a phone and a side sheet at md', () => {
    mockWidth({ belowMd: true });
    const { unmount } = render(
      <Sheet open><SheetContent side="right" intent="form" aria-describedby={undefined}><SheetTitle>T</SheetTitle></SheetContent></Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute('data-presentation', 'fullscreen');
    unmount();
    mockWidth({ belowMd: false });
    render(
      <Sheet open><SheetContent side="right" intent="form" aria-describedby={undefined}><SheetTitle>T</SheetTitle></SheetContent></Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute('data-presentation', 'side-sheet');
  });
});

describe('Modal (the older titled dialog) that opts in with an intent', () => {
  it('Add Item style: full-screen on a phone with the footer pinned and only the body scrolling', async () => {
    const { Modal } = await import('@/components/ui/modal');
    mockWidth({ belowMd: true });
    render(
      <Modal open onClose={() => {}} title="Add Item to Stock" intent="form" footer={<button type="button">Save</button>}>
        <input aria-label="Item Name" />
      </Modal>,
    );
    const content = document.querySelector('[role="dialog"]')!;
    expect(content).toHaveAttribute('data-presentation', 'fullscreen');
    expect(content.className).toContain('h-[calc(100dvh-var(--keyboard-inset,0px))]');
    expect(content.querySelector('[data-slot="modal-body"]')!.className).toContain('overflow-y-auto');
    expect(screen.getByRole('button', { name: 'Save' }).parentElement!.className).toContain('var(--safe-bottom,0px)');
    expect(screen.getByRole('button', { name: 'Close' }).className).toContain('touch:size-11');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('is the same card as today at md and up, and with no intent', async () => {
    const { Modal } = await import('@/components/ui/modal');
    mockWidth({ belowMd: false });
    const { unmount } = render(
      <Modal open onClose={() => {}} title="Add Item to Stock" intent="form"><input aria-label="Item Name" /></Modal>,
    );
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-presentation', 'card');
    expect(document.querySelector('[data-slot="modal-body"]')).toBeNull();
    unmount();
    mockWidth({ belowMd: true });
    render(<Modal open onClose={() => {}} title="Old"><input aria-label="Item Name" /></Modal>);
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-presentation', 'card');
  });
});
