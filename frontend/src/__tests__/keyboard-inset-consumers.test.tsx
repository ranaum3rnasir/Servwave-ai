// Mobile slice 54: the sticky footers, composers and bottom sheets READ the keyboard inset the app
// hook publishes. jsdom applies no CSS, so these read the classes that carry the geometry, the way
// adaptive-overlay.test.tsx does; the real layout is proven in e2e/mobile/keyboard-inset.spec.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderWithProviders } from './helpers';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import {
  Dialog as LegacyDialog, DialogContent as LegacyDialogContent, DialogTitle as LegacyDialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { ComposeWindow } from '@/components/communication/inbox/ComposeWindow';
import type { ComposeState } from '@/lib/api/communication';

function mockPhone() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MEDIA.belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockDesktop() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => vi.restoreAllMocks());

const LIFT = 'var(--keyboard-inset,0px)';

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

describe('overlays above the keyboard', () => {
  it('a full-screen kit form ends where the keyboard begins', () => {
    mockPhone();
    render(<Form intent="form" />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content).toHaveAttribute('data-presentation', 'fullscreen');
    expect(content.className).toContain(`h-[calc(100dvh-${LIFT})]`);
  });

  it('the footer drops the home-indicator padding while the keyboard covers it', () => {
    mockPhone();
    render(<Form intent="form" />);
    const footer = document.querySelector('[data-slot="dialog-footer"]')!;
    expect(footer.className).toContain('var(--safe-bottom,0px)');
    expect(footer.className).not.toContain('env(safe-area-inset-bottom)');
  });

  it('a kit bottom sheet lifts by the inset and is capped by the visible height', () => {
    mockPhone();
    render(<Form intent="choice" />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(content.className).toContain(`bottom-[${LIFT}]`);
    expect(content.className).toContain('max-h-[min(85dvh,var(--visible-height,100dvh))]');
  });

  it('a centred card is centred in the part the keyboard leaves', () => {
    render(<Form />);
    const content = document.querySelector('[data-slot="dialog-content"]')!;
    expect(content.className).toContain(`top-[calc((100%-${LIFT})/2)]`);
    expect(content.className).toContain(`max-h-[calc(100dvh-2.5rem-${LIFT})]`);
  });

  it('a legacy full-screen form ends where the keyboard begins', () => {
    mockPhone();
    render(
      <LegacyDialog open>
        <LegacyDialogContent intent="form" aria-describedby={undefined}>
          <LegacyDialogTitle>Legacy</LegacyDialogTitle>
        </LegacyDialogContent>
      </LegacyDialog>,
    );
    const content = document.querySelector('[data-presentation="fullscreen"]')!;
    expect(content.className).toContain(`h-[calc(100dvh-${LIFT})]`);
  });

  it('a legacy bottom sheet dialog lifts by the inset', () => {
    mockPhone();
    render(
      <LegacyDialog open>
        <LegacyDialogContent intent="choice" aria-describedby={undefined}>
          <LegacyDialogTitle>Legacy</LegacyDialogTitle>
        </LegacyDialogContent>
      </LegacyDialog>,
    );
    const content = document.querySelector('[data-presentation="bottom-sheet"]')!;
    expect(content.className).toContain(`bottom-[${LIFT}]`);
    expect(content.className).toContain('max-h-[min(85dvh,var(--visible-height,100dvh))]');
  });

  it('a kit sheet that goes full-screen, a side sheet and the bottom sheet follow the keyboard too', () => {
    mockPhone();
    const full = render(
      <Sheet open>
        <SheetContent intent="form" aria-describedby={undefined}><SheetTitle>Form</SheetTitle></SheetContent>
      </Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-content"]')!.className).toContain(`h-[calc(100dvh-${LIFT})]`);
    full.unmount();
    const side = render(
      <Sheet open>
        <SheetContent side="right" aria-describedby={undefined}><SheetTitle>Side</SheetTitle></SheetContent>
      </Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-content"]')!.className).toContain(`h-[calc(100dvh-${LIFT})]`);
    side.unmount();
    render(
      <Sheet open>
        <SheetContent side="bottom" aria-describedby={undefined}><SheetTitle>Bottom</SheetTitle></SheetContent>
      </Sheet>,
    );
    const bottom = document.querySelector('[data-slot="sheet-content"]')!;
    expect(bottom.className).toContain(`bottom-[${LIFT}]`);
    expect(bottom.className).toContain('max-h-[min(80dvh,var(--visible-height,100dvh))]');
  });
});

describe('schedule create sheet', () => {
  it('is capped by the visible height, so its top never goes under the status bar with the keyboard up', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'pages', 'v2', 'schedule', 'creation', 'scheduleCreatePopover.tsx'),
      'utf8',
    );
    expect(src).toContain('max-h-[min(85dvh,var(--visible-height,100dvh))]');
    expect(src).not.toContain('max-h-[85vh]');
  });
});

describe('email compose', () => {
  const STATE: ComposeState = { mode: 'new', account: 'system', to: '', subject: '', body: '' };

  it('sits on top of the keyboard and keeps Send inside the visible height', () => {
    // The docked card is the md-and-up presentation; below md the window is a full-screen form (slice 46).
    mockDesktop();
    renderWithProviders(
      <ComposeWindow
        state={STATE}
        onChange={() => {}}
        onSend={() => {}}
        onDiscard={() => {}}
        onClose={() => {}}
        onToast={() => {}}
      />,
    );
    const panel = [...document.querySelectorAll('div')].find((d) => d.className.includes('w-[540px]'))!;
    expect(panel.className).toContain(`bottom-[${LIFT}]`);
    expect(panel.className).toContain('max-h-[min(80vh,var(--visible-height,100vh))]');
    // The footer holding Send is sticky and carries the home-indicator padding that drops under a keyboard.
    const footer = document.querySelector('[data-slot="compose-footer"]')!;
    expect(footer.className).toContain('sticky');
    expect(footer.className).toContain('var(--safe-bottom,0px)');
    expect(footer.querySelector('button')!.textContent).toContain('Send');
    // The body gives way before the footer does: its minimum height follows the visible height.
    expect(document.querySelector('textarea')!.className).toContain('var(--visible-height');
  });

  it('on a phone is a full-screen form whose Send footer ends above the keyboard and keeps the home-indicator padding', () => {
    mockPhone();
    renderWithProviders(
      <ComposeWindow
        state={STATE}
        onChange={() => {}}
        onSend={() => {}}
        onDiscard={() => {}}
        onClose={() => {}}
        onToast={() => {}}
      />,
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    // The form dialog ends where the keyboard begins, so the pinned footer rides above it.
    expect(dialog.className).toContain('h-[calc(100dvh-var(--keyboard-inset,0px))]');
    const footer = document.querySelector('[data-slot="compose-footer"]')!;
    expect(dialog.contains(footer)).toBe(true);
    expect(footer.className).toContain('shrink-0');
    expect(footer.className).toContain('var(--safe-bottom,0px)');
    expect(footer.querySelector('button')!.textContent).toContain('Send');
  });
});
