/**
 * StatusMenu: per-option meaning and lock reason (walkthrough lead-statuses PRD 7.4, tests 12.4).
 *
 * On a computer every option explains itself on hover and on keyboard focus, a locked one also says
 * why, and a locked one cannot be picked. On a touch screen the menu shows names only: a locked
 * option is greyed out and tapping it changes nothing and leaves the menu open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { DESKTOP, PHONE_PORTRAIT, TABLET, emulateDevice, type DeviceShape } from '@/__tests__/support/deviceShape';

import { StatusMenu, type StatusMenuOption } from '../statusMenu';

const MEANING = {
  CONTACTED: "We've contacted this lead at least once.",
  WALKTHROUGH_SCHEDULED: 'A walkthrough is booked and hasn\'t happened yet.',
  ESTIMATED: "We've sent this lead an estimate.",
};
const LOCK = 'No estimate has been sent to this lead yet.';

const OPTIONS: StatusMenuOption[] = [
  { value: 'CONTACTED', available: true, description: MEANING.CONTACTED, reason: null },
  { value: 'WALKTHROUGH_SCHEDULED', available: true, description: MEANING.WALKTHROUGH_SCHEDULED, reason: null },
  { value: 'ESTIMATED', available: false, description: MEANING.ESTIMATED, reason: LOCK },
];

let restoreDevice: (() => void) | undefined;
function onDevice(shape: DeviceShape) {
  restoreDevice = emulateDevice(shape);
}
afterEach(() => {
  restoreDevice?.();
  restoreDevice = undefined;
});

function renderMenu(options: readonly (string | StatusMenuOption)[] = OPTIONS, onValueChange = vi.fn()) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(
    <StatusMenu domain="lead" label="Lead status" value="CONTACTED" options={options} onValueChange={onValueChange} />,
  );
  return { user, onValueChange };
}

const trigger = () => screen.getByRole('button', { name: /lead status: contacted/i });

describe('StatusMenu on a computer', () => {
  it('lets an available option be picked', async () => {
    onDevice(DESKTOP);
    const { user, onValueChange } = renderMenu();
    await user.click(trigger());
    await user.click(await screen.findByRole('menuitem', { name: /walkthrough scheduled/i }));
    expect(onValueChange).toHaveBeenCalledWith('WALKTHROUGH_SCHEDULED');
  });

  it('marks a locked option aria-disabled (not disabled) and does not let it be picked', async () => {
    onDevice(DESKTOP);
    const { user, onValueChange } = renderMenu();
    await user.click(trigger());
    const locked = await screen.findByRole('menuitem', { name: /estimate sent/i });

    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).not.toHaveAttribute('data-disabled');
    await user.click(locked);

    expect(onValueChange).not.toHaveBeenCalled();
    // The menu stays open, so the person can pick another status.
    expect(screen.getByRole('menuitem', { name: /walkthrough scheduled/i })).toBeInTheDocument();
  });

  it('does not let a locked option be picked from the keyboard either', async () => {
    onDevice(DESKTOP);
    const { user, onValueChange } = renderMenu();
    await user.click(trigger());
    const locked = await screen.findByRole('menuitem', { name: /estimate sent/i });
    locked.focus();
    await user.keyboard('{Enter}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('never shows the current status as locked, even when the server says it is not available', async () => {
    onDevice(DESKTOP);
    const { user, onValueChange } = renderMenu([
      { value: 'CONTACTED', available: false, description: MEANING.CONTACTED, reason: LOCK },
      { value: 'WALKTHROUGH_SCHEDULED', available: true, description: MEANING.WALKTHROUGH_SCHEDULED, reason: null },
    ]);
    await user.click(trigger());
    const current = await screen.findByRole('menuitem', { name: /contacted/i });

    expect(current).not.toHaveAttribute('aria-disabled');
    await user.hover(current);
    expect(await screen.findByRole('tooltip')).not.toHaveTextContent(LOCK);
    await user.click(current);
    expect(onValueChange).toHaveBeenCalledWith('CONTACTED');
  });

  it('shows what an option means when the pointer is over it', async () => {
    onDevice(DESKTOP);
    const { user } = renderMenu();
    await user.click(trigger());
    await user.hover(await screen.findByRole('menuitem', { name: /walkthrough scheduled/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(MEANING.WALKTHROUGH_SCHEDULED);
    // An option that can be picked says nothing about locks.
    expect(tip).not.toHaveTextContent(LOCK);
  });

  it('shows the meaning AND the reason on a locked option', async () => {
    onDevice(DESKTOP);
    const { user } = renderMenu();
    await user.click(trigger());
    await user.hover(await screen.findByRole('menuitem', { name: /estimate sent/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(MEANING.ESTIMATED);
    expect(tip).toHaveTextContent(LOCK);
  });

  it('shows the same text when an option takes keyboard focus', async () => {
    onDevice(DESKTOP);
    const { user } = renderMenu();
    await user.click(trigger());
    const locked = await screen.findByRole('menuitem', { name: /estimate sent/i });
    locked.focus();

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(MEANING.ESTIMATED);
    expect(tip).toHaveTextContent(LOCK);
  });

  it('shows the current status\'s meaning on the button, on hover and on focus', async () => {
    onDevice(DESKTOP);
    const { user } = renderMenu();
    await user.hover(trigger());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(MEANING.CONTACTED);
  });

  it('shows the current status\'s meaning when the button takes keyboard focus', async () => {
    onDevice(DESKTOP);
    renderMenu();
    trigger().focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(MEANING.CONTACTED);
  });

  it('falls back to a plain list of statuses when no option carries any detail', async () => {
    onDevice(DESKTOP);
    const { user, onValueChange } = renderMenu(['CONTACTED', 'WALKTHROUGH_SCHEDULED', 'ESTIMATED']);
    await user.click(trigger());
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.trim())).toEqual(['Contacted', 'Walkthrough Scheduled', 'Estimate Sent']);
    items.forEach((i) => expect(i).not.toHaveAttribute('aria-disabled'));

    await user.click(items[2]!);
    expect(onValueChange).toHaveBeenCalledWith('ESTIMATED');
  });
});

describe.each([
  ['a phone (bottom sheet)', { ...PHONE_PORTRAIT, viewportWidth: 390 }],
  ['a touch tablet (dropdown menu)', { ...TABLET, viewportWidth: 1024 }],
] as const)('StatusMenu on %s', (_name, shape) => {
  const optionRows = () => {
    const sheet = screen.queryByRole('dialog');
    const scope = sheet ? within(sheet) : screen;
    return scope.getAllByRole(sheet ? 'button' : 'menuitem').filter((el) => /contacted|walkthrough|estimate sent/i.test(el.textContent ?? ''));
  };

  it('shows status names only: no meaning, no reason, not even after a hover or focus', async () => {
    onDevice(shape);
    const { user } = renderMenu();
    await user.click(trigger());
    await screen.findByText(/estimate sent/i);
    const rows = optionRows();
    const last = rows[rows.length - 1]!;
    await user.hover(last);
    last.focus();

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(LOCK);
    expect(document.body).not.toHaveTextContent(MEANING.ESTIMATED);
    expect(document.body).not.toHaveTextContent(MEANING.WALKTHROUGH_SCHEDULED);
  });

  it('greys out a locked option, and tapping it changes nothing and leaves the menu open', async () => {
    onDevice(shape);
    const { user, onValueChange } = renderMenu();
    await user.click(trigger());
    await screen.findByText(/estimate sent/i);
    const rows = optionRows();
    const locked = rows.find((r) => /estimate sent/i.test(r.textContent ?? ''))!;

    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked.classList.contains('opacity-50')).toBe(true);
    await user.click(locked);

    expect(onValueChange).not.toHaveBeenCalled();
    // Still open: the other rows are still on screen.
    expect(screen.getByText(/walkthrough scheduled/i)).toBeInTheDocument();
  });

  it('still lets an available option be picked', async () => {
    onDevice(shape);
    const { user, onValueChange } = renderMenu();
    await user.click(trigger());
    await screen.findByText(/estimate sent/i);
    const available = optionRows().find((r) => /walkthrough scheduled/i.test(r.textContent ?? ''))!;
    await user.click(available);
    expect(onValueChange).toHaveBeenCalledWith('WALKTHROUGH_SCHEDULED');
  });

  it('shows no tooltip on the status button', async () => {
    onDevice(shape);
    const { user } = renderMenu();
    await user.hover(trigger());
    await act(async () => {
      trigger().focus();
      // Past the tooltip's open delay, so "nothing opened" is a fact and not just "not yet".
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});

/**
 * The menu panel has to be wide enough for its longest row.
 *
 * RED before the fix: the panel was a fixed 224 px (w-56), matched to the old short labels; the
 * current 'Walkthrough Scheduled' row (semibold, with its dot and check mark) wrapped onto two
 * lines, 55 px tall against 36 px for the others.
 *
 * jsdom performs no layout, so this pins the width the panel asks for against the row's measured
 * parts: panel padding 12, item padding 20, dot 8 + gap 10, gap 10 + check 16, and the label at
 * about 7.2 px per character at 13px semibold.
 */
describe('StatusMenu panel width', () => {
  it('is wide enough for the longest lead status row with its dot and check mark', async () => {
    onDevice(DESKTOP);
    const { STATUS_REGISTRY } = await import('@/design-system/status-registry');
    const longest = Math.max(...Object.values(STATUS_REGISTRY.lead).map((s) => s.label.length));
    const { user } = renderMenu(['CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED']);
    await user.click(trigger());
    const panel = await screen.findByRole('menu', { name: /lead status/i });

    const widthClass = Array.from(panel.classList).find((c) => /^w-\d+$/.test(c));
    expect(widthClass).toBeDefined();
    const panelPx = Number(widthClass!.slice(2)) * 4;
    const rowPx = 12 + 20 + 8 + 10 + 10 + 16 + Math.ceil(longest * 7.2);
    expect(panelPx).toBeGreaterThanOrEqual(rowPx);
  });
});
