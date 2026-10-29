/**
 * Mobile slice 24 (rubric KB-08, user stories 30 and 99): a dialog, a sheet, a
 * search popover or a field never focuses a text field on its own when the
 * primary pointer is coarse, so the on-screen keyboard does not cover the
 * surface on arrival. With a fine pointer (a desktop) every one of them still
 * focuses its field exactly as before.
 *
 * jsdom answers every media query `false` (src/__tests__/setup.ts); each spec
 * here sets the pointer explicitly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as KitDialog from '@/ui-kit/components/ui/dialog';
import * as KitSheet from '@/ui-kit/components/ui/sheet';
import * as KitPopover from '@/ui-kit/components/ui/popover';
import * as Dialog from '@/components/ui/dialog';
import * as Sheet from '@/components/ui/sheet';
import * as Popover from '@/components/ui/popover';
import { SearchablePanel } from '@/components/ui/searchable-panel';
import { Combobox } from '@/components/ui/combobox';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';

const originalMatchMedia = window.matchMedia;

function setPointer(pointer: 'coarse' | 'fine') {
  window.matchMedia = ((query: string) => ({
    matches: query.includes(`pointer: ${pointer}`) || (pointer === 'fine' && query.includes('hover: hover')),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

/** Let Radix's mount-autofocus effect (and its focus-scope timers) run. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function expectNoTextFieldFocused() {
  const el = document.activeElement as HTMLElement | null;
  expect(el?.tagName).not.toBe('INPUT');
  expect(el?.tagName).not.toBe('TEXTAREA');
}

describe('canAutoFocus', () => {
  it('is false on a coarse primary pointer and true on a fine one', () => {
    setPointer('coarse');
    expect(canAutoFocus()).toBe(false);
    setPointer('fine');
    expect(canAutoFocus()).toBe(true);
  });
});

/** Each overlay primitive, rendered open with a text field as its first tabbable element. */
const OVERLAYS: Array<[string, () => JSX.Element]> = [
  [
    'kit Dialog',
    () => (
      <KitDialog.Dialog open>
        <KitDialog.DialogContent aria-describedby={undefined}>
          <KitDialog.DialogTitle>New tag</KitDialog.DialogTitle>
          <input aria-label="Tag name" />
        </KitDialog.DialogContent>
      </KitDialog.Dialog>
    ),
  ],
  [
    'Dialog',
    () => (
      <Dialog.Dialog open>
        <Dialog.DialogContent aria-describedby={undefined}>
          <Dialog.DialogTitle>New tag</Dialog.DialogTitle>
          <input aria-label="Tag name" />
        </Dialog.DialogContent>
      </Dialog.Dialog>
    ),
  ],
  [
    'kit Sheet',
    () => (
      <KitSheet.Sheet open>
        <KitSheet.SheetContent aria-describedby={undefined}>
          <KitSheet.SheetTitle>Filter</KitSheet.SheetTitle>
          <input aria-label="Tag name" />
        </KitSheet.SheetContent>
      </KitSheet.Sheet>
    ),
  ],
  [
    'Sheet',
    () => (
      <Sheet.Sheet open>
        <Sheet.SheetContent aria-describedby={undefined}>
          <Sheet.SheetTitle>Filter</Sheet.SheetTitle>
          <input aria-label="Tag name" />
        </Sheet.SheetContent>
      </Sheet.Sheet>
    ),
  ],
  [
    'kit Popover',
    () => (
      <KitPopover.Popover open>
        <KitPopover.PopoverTrigger>Open</KitPopover.PopoverTrigger>
        <KitPopover.PopoverContent>
          <input aria-label="Tag name" />
        </KitPopover.PopoverContent>
      </KitPopover.Popover>
    ),
  ],
  [
    'Popover',
    () => (
      <Popover.Popover open>
        <Popover.PopoverTrigger>Open</Popover.PopoverTrigger>
        <Popover.PopoverContent>
          <input aria-label="Tag name" />
        </Popover.PopoverContent>
      </Popover.Popover>
    ),
  ],
];

describe.each(OVERLAYS)('%s opening', (_name, Overlay) => {
  it('on a coarse pointer keeps focus in the overlay but off its text field', async () => {
    setPointer('coarse');
    render(<Overlay />);
    await settle();
    expectNoTextFieldFocused();
    const field = screen.getByRole('textbox', { name: 'Tag name' });
    // Focus is still inside the overlay (a screen reader lands in it, a modal still traps).
    const container = field.closest('[role="dialog"]') ?? field.parentElement!.closest('[data-radix-popper-content-wrapper] > *');
    expect(container).not.toBeNull();
    expect(container!.contains(document.activeElement)).toBe(true);
  });

  it('on a fine pointer still focuses the first field', async () => {
    setPointer('fine');
    render(<Overlay />);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Tag name' }));
  });
});

function PanelHarness() {
  const [open, setOpen] = useState(false);
  return (
    <SearchablePanel
      open={open}
      onOpenChange={setOpen}
      trigger={<button type="button">Assign</button>}
      rows={[{ key: 'a', label: 'Alex', render: 'Alex' }]}
      searchAriaLabel="Search people"
    />
  );
}

function ComboHarness() {
  const [value, setValue] = useState('');
  return (
    <Combobox
      value={value}
      onValueChange={setValue}
      aria-label="Tax rate"
      options={Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }))}
    />
  );
}

describe('the two shared search popovers', () => {
  it('SearchablePanel: no search-field focus on a coarse pointer, focus on a fine one', async () => {
    setPointer('coarse');
    const touch = render(<PanelHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Search people' })).not.toHaveFocus();
    expectNoTextFieldFocused();
    touch.unmount();

    setPointer('fine');
    render(<PanelHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Search people' })).toHaveFocus();
  });

  it('Combobox: no search-field focus on a coarse pointer, focus on a fine one', async () => {
    setPointer('coarse');
    const touch = render(<ComboHarness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Tax rate' }));
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Search options' })).not.toHaveFocus();
    expectNoTextFieldFocused();
    touch.unmount();

    setPointer('fine');
    render(<ComboHarness />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Tax rate' }));
    await settle();
    expect(screen.getByRole('searchbox', { name: 'Search options' })).toHaveFocus();
  });
});
