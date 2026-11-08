/**
 * DateTimePicker — shared in-DOM date+time control replacing native
 * datetime-local inputs inside Radix dialogs (#430), and native browser-locale
 * date/time formatting (job scheduling relabel + date-format fix, 2026-08-04).
 *
 * Value contract: '' or 'YYYY-MM-DDTHH:MM' (local) — identical to the
 * native input it replaces, so callers keep their ISO conversion. Composed
 * of a typeable DatePicker (MM/DD/YYYY by default) + a typeable TimeCombobox,
 * each its own portaled Radix Popover.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { setOrgFormattingPrefs } from '@/lib/org-format';

function dayButton(day: string): HTMLElement {
  const grid = screen.getByRole('grid');
  const btn = within(grid)
    .getAllByRole('button')
    .find((b) => b.textContent?.trim() === day);
  if (!btn) throw new Error(`day button ${day} not found`);
  return btn;
}

beforeEach(() => {
  setOrgFormattingPrefs({}); // reset to unset -> default MM/DD/YYYY pattern
});

describe('DateTimePicker', () => {
  it('renders MM/DD/YYYY and Time placeholders when value is empty', () => {
    render(<DateTimePicker value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('MM/DD/YYYY')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Time')).toBeInTheDocument();
  });

  it('opens a popover with a calendar grid on calendar-icon click', async () => {
    const user = userEvent.setup();
    render(<DateTimePicker value="" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open calendar/i }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
  });

  it('clicking a day calls onChange with YYYY-MM-DDTHH:MM defaulting time to 09:00', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /open calendar/i }));
    await screen.findByRole('grid');
    await user.click(dayButton('15'));
    const now = new Date();
    const expected = `${format(new Date(now.getFullYear(), now.getMonth(), 15), 'yyyy-MM-dd')}T09:00`;
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('with an existing value, picking a new time keeps the date and a new day keeps the time', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { unmount } = render(
      <DateTimePicker value="2026-07-10T14:30" onChange={onChange} />,
    );
    expect(screen.getByDisplayValue('07/10/2026')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2:30 PM')).toBeInTheDocument();

    // New time keeps the date part.
    const timeInput = screen.getByDisplayValue('2:30 PM');
    await user.click(timeInput);
    const option = await screen.findByRole('button', { name: '4:45 PM' });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith('2026-07-10T16:45');
    unmount();

    // New day keeps the time part.
    onChange.mockClear();
    render(<DateTimePicker value="2026-07-10T14:30" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /open calendar/i }));
    await screen.findByRole('grid');
    await user.click(dayButton('15'));
    expect(onChange).toHaveBeenCalledWith('2026-07-15T14:30');
  });

  it('offers only 15-minute increments in the time list', async () => {
    const user = userEvent.setup();
    render(<DateTimePicker value="" onChange={vi.fn()} />);
    await user.click(screen.getByPlaceholderText('Time'));
    const options = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2} (AM|PM)/ });
    expect(options).toHaveLength(96);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  it('typing a date directly and blurring commits it, normalized to MM/DD/YYYY', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} />);
    const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
    await user.type(dateInput, '8/5/2026');
    await user.tab();
    expect(onChange).toHaveBeenCalledWith('2026-08-05T09:00');
  });

  it('typing a time shorthand directly and blurring commits it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateTimePicker value="2026-08-05T00:00" onChange={onChange} />);
    const timeInput = screen.getByPlaceholderText('Time');
    await user.clear(timeInput);
    await user.type(timeInput, '3p');
    await user.tab();
    expect(onChange).toHaveBeenCalledWith('2026-08-05T15:00');
  });

  it('the clear (×) button is on by default, only appears with a value, and clears both fields', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<DateTimePicker value="" onChange={onChange} />);
    expect(screen.queryByRole('button', { name: /clear date and time/i })).not.toBeInTheDocument();

    rerender(<DateTimePicker value="2026-07-10T14:30" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /clear date and time/i }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('clearable={false} suppresses the clear button while leaving both fields usable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateTimePicker value="2026-07-10T14:30" onChange={onChange} clearable={false} />,
    );
    // The opt-out for REQUIRED fields (LogCommunicationDrawer's "When did it happen? *"):
    // the button is gone even though a value is present, which is the only state in which
    // it would otherwise render.
    expect(screen.queryByRole('button', { name: /clear date and time/i })).not.toBeInTheDocument();

    // Suppressing the button must not disable the pair itself.
    expect(screen.getByDisplayValue('07/10/2026')).toBeInTheDocument();
    await user.click(screen.getByDisplayValue('2:30 PM'));
    await user.click(await screen.findByRole('button', { name: '4:45 PM' }));
    expect(onChange).toHaveBeenCalledWith('2026-07-10T16:45');
  });

  it('outside click closes the calendar popover', async () => {
    const user = userEvent.setup();
    render(<DateTimePicker value="" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /open calendar/i }));
    await screen.findByRole('grid');
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('grid')).not.toBeInTheDocument(),
    );
  });

  it('respects an org-configured DD/MM/YYYY date format', () => {
    setOrgFormattingPrefs({ dateFormat: 'DD/MM/YYYY' });
    render(<DateTimePicker value="2026-07-10T14:30" onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('10/07/2026')).toBeInTheDocument();
  });
});
