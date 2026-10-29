/**
 * Mobile slice 45 (CMP-04 date, TOUCH-01 date; story 44): below md the day picker opens in a bottom
 * sheet with 40 px day cells; from md up it is the popover it always was, with 36 px days.
 *
 * jsdom applies no CSS, so the layout is read from `data-presentation` and the classes that carry
 * the geometry; the real-browser measurement (every day cell at least 40 px, the whole calendar
 * inside the viewport at 320) is e2e/mobile/date-picker-sheet.spec.ts.
 */
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { DateField } from '../dateField';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { Sheet, SheetContent, SheetTitle } from '@/ui-kit/components/ui/sheet';

function mockWidth(opts: { belowMd: boolean; shortHeight?: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: (query === MEDIA.belowMd && opts.belowMd) || (query === MEDIA.shortHeight && !!opts.shortHeight),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// The calendar is a lazy chunk (slice 47); warm it once so the rest of the file sees it at once.
beforeAll(async () => {
  mockWidth({ belowMd: false });
  const { unmount } = render(<DateField value="" onChange={() => {}} aria-label="Warm-up" />);
  fireEvent.click(screen.getByLabelText('Open calendar'));
  await screen.findByRole('grid');
  unmount();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dayButtons = (scope: HTMLElement) =>
  within(scope)
    .getAllByRole('gridcell')
    .map((c) => within(c).queryByRole('button'))
    .filter((b): b is HTMLElement => b !== null);

describe('DateField on a phone (below md)', () => {
  beforeEach(() => mockWidth({ belowMd: true }));

  it('opens the calendar in a bottom sheet, not a popover', async () => {
    render(<DateField value="2026-08-15" onChange={() => {}} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date' });
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(sheet.className).toContain('bottom-[var(--keyboard-inset,0px)]');
    expect(sheet).toContainElement(await screen.findByRole('grid'));
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it('every day cell is a 40 px square (size-10), and the whole month grid is in the sheet', async () => {
    render(<DateField value="2026-08-15" onChange={() => {}} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const grid = await screen.findByRole('grid');
    const days = dayButtons(grid);
    expect(days.length).toBe(42); // six fixed week rows
    for (const day of days) expect(day.className).toMatch(/(^|\s)size-10(\s|$)/);
    expect(grid.querySelectorAll('thead th').length).toBe(7);
  });

  it('picking a day sets it and closes the sheet', async () => {
    const onChange = vi.fn();
    render(<DateField value="2026-08-15" onChange={onChange} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const grid = await screen.findByRole('grid');
    fireEvent.click(dayButtons(grid).find((b) => b.textContent === '20')!);
    expect(onChange).toHaveBeenCalledWith('2026-08-20');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Today and Clear are 44 px buttons in the sheet and behave as in the popover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(2026, 7, 5, 9, 0));
    const onChange = vi.fn();
    render(<DateField value="2026-08-15" onChange={onChange} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date' });
    const today = within(sheet).getByRole('button', { name: 'Today' });
    expect(today.className).toMatch(/h-11/);
    fireEvent.click(today);
    expect(onChange).toHaveBeenCalledWith('2026-08-05');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.useRealTimers();

    fireEvent.click(screen.getByLabelText('Open calendar'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Choose a date' })).getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('still disables days outside min and max', async () => {
    render(<DateField value="2026-08-15" min="2026-08-10" max="2026-08-20" onChange={() => {}} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const grid = await screen.findByRole('grid');
    const byText = (t: string) => dayButtons(grid).find((b) => b.textContent === t && !b.closest('[data-outside]'))!;
    expect(byText('9')).toBeDisabled();
    expect(byText('21')).toBeDisabled();
    expect(byText('15')).not.toBeDisabled();
  });

  it('commits typed text when the sheet closes (Escape)', async () => {
    const onChange = vi.fn();
    render(<DateField value="" onChange={onChange} aria-label="Date" />);
    const field = screen.getByLabelText('Date');
    fireEvent.change(field, { target: { value: '08/15/2026' } });
    fireEvent.click(screen.getByLabelText('Open calendar'));
    await screen.findByRole('dialog', { name: 'Choose a date' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith('2026-08-15');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('datetime mode: the sheet offers Now, and picking a day keeps the time', async () => {
    function Controlled() {
      const [v, setV] = useState('2026-08-15T14:30');
      return <DateField mode="datetime" value={v} onChange={setV} aria-label="Due" />;
    }
    render(<Controlled />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date and time' });
    expect(within(sheet).getByRole('button', { name: 'Now' })).toBeInTheDocument();
    fireEvent.click(dayButtons(await within(sheet).findByRole('grid')).find((b) => b.textContent === '20')!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Due date')).toHaveValue('08/20/2026');
  });

  it('range mode: one month wide enough for a phone, presets as 44 px buttons above it', async () => {
    const onChange = vi.fn();
    render(<DateField mode="range" value={{ from: '', to: '' }} onChange={onChange} aria-label="Created" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date range' });
    expect(await within(sheet).findAllByRole('grid')).toHaveLength(1);
    const preset = within(sheet).getByRole('button', { name: 'Today' });
    expect(preset.className).toMatch(/min-h-11/);
    fireEvent.click(preset);
    expect(onChange).toHaveBeenCalled();
  });

  // The list filters put the date field INSIDE a popover (z-floating, 100). A sheet on the page layer
  // (z-50) opened from there painted underneath it, hiding the day grid (staging finding, slice 45).
  it('sits on the floating layer, above the popover it was opened from', async () => {
    render(
      <Popover open>
        <PopoverTrigger>Filter</PopoverTrigger>
        <PopoverContent>
          <DateField value="2026-08-15" onChange={() => {}} aria-label="Created" />
        </PopoverContent>
      </Popover>,
    );
    const popover = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(popover.className).toMatch(/(^|\s)z-floating(\s|$)/);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date' });
    expect(sheet.className).toMatch(/(^|\s)z-floating(\s|$)/);
    expect(sheet.className).not.toMatch(/(^|\s)z-50(\s|$)/);
    const scrim = document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement;
    expect(scrim.className).toMatch(/(^|\s)z-floating(\s|$)/);
    expect(scrim.className).not.toMatch(/(^|\s)z-50(\s|$)/);
    // Equal z-index: the later portal paints on top, and the sheet opens after the popover.
    expect(popover.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an ordinary sheet stays on the page layer', () => {
    render(
      <Sheet open>
        <SheetContent><SheetTitle>Plain</SheetTitle></SheetContent>
      </Sheet>,
    );
    const content = document.querySelector('[data-slot="sheet-content"]') as HTMLElement;
    expect(content.className).toMatch(/(^|\s)z-50(\s|$)/);
    expect(content.className).not.toContain('z-floating');
    expect((document.querySelector('[data-slot="sheet-overlay"]') as HTMLElement).className).toMatch(/(^|\s)z-50(\s|$)/);
  });

  it('a phone held sideways (short window) takes the sheet too, not a 150 px popover', async () => {
    mockWidth({ belowMd: false, shortHeight: true });
    render(<DateField value="2026-08-15" onChange={() => {}} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const sheet = await screen.findByRole('dialog', { name: 'Choose a date' });
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
  });
});

describe('DateField from md up: the popover it always was', () => {
  beforeEach(() => mockWidth({ belowMd: false }));

  it('opens a popover with 36 px (size-9) days and no dialog', async () => {
    render(<DateField value="2026-08-15" onChange={() => {}} aria-label="Date" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const grid = await screen.findByRole('grid');
    // A Radix popover is itself role="dialog", so the sheet is told apart by its slot.
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    for (const day of dayButtons(grid)) {
      expect(day.className).toMatch(/(^|\s)size-9(\s|$)/);
      expect(day.className).not.toMatch(/(^|\s)size-10(\s|$)/);
    }
  });

  it('range mode keeps two months side by side with its rail', async () => {
    render(<DateField mode="range" value={{ from: '', to: '' }} onChange={() => {}} aria-label="Created" />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(await screen.findAllByRole('grid')).toHaveLength(2);
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });
});
