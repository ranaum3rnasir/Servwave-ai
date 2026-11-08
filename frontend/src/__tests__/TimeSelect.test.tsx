/**
 * TimeSelect — time-only scrollable dropdown replacing the native
 * <input type="time"> '--:--' spinner on the Lead schedule fields (#358).
 *
 * Value contract: '' or 'HH:MM' (24-hour) — identical to the native input it
 * replaces, so combineDatetime/extractTime callers are unchanged.
 *
 * Renders via SelectField (Radix Select) rather than a native <select> (Task
 * 10 — OS-native dropdowns are invisible during screen-share support calls).
 * Radix portals its option list and only renders it while open, and doesn't
 * expose the underlying 'HH:MM' value as a DOM attribute (SelectItem only
 * carries its visible label in the DOM) — so these tests open the dropdown
 * via a real click and assert on rendered option labels instead of
 * `<option>`/`.value` DOM APIs.
 *
 * The original native <select>'s empty `<option value="">Select time…</option>`
 * was NOT disabled — a user could reopen the dropdown at any time and click it
 * to reset back to blank, even after picking a real time. Radix Select has no
 * selectable "" item, so that reset option is modeled as a real 'NONE'
 * sentinel entry (mapped back to '' by TimeSelect's onChange), always present
 * as the first item in the open list — not just a pre-selection placeholder.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimeSelect } from '@/components/form/TimeSelect';

describe('TimeSelect', () => {
  it('renders 96 15-minute options plus a selectable reset-to-blank option', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="" onChange={vi.fn()} />);
    // Closed trigger shows the reset sentinel's label (it's the selected item).
    expect(screen.getByRole('combobox')).toHaveTextContent('Select time…');
    await user.click(screen.getByRole('combobox'));
    // 96 real time slots + 1 reset-to-blank sentinel, reachable at any time.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(97);
    expect(screen.getByRole('option', { name: 'Select time…' })).toBeInTheDocument();
  });

  it('uses 12-hour h:mm a labels with HH:MM-granular (15-min) values', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="" onChange={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: '9:00 AM' })).toBeInTheDocument();
    // Every real time-slot option lands on a 15-minute boundary (00/15/30/45)
    // — skip the reset-to-blank sentinel, which isn't a time slot.
    const options = screen
      .getAllByRole('option')
      .filter((o) => o.textContent !== 'Select time…');
    expect(options).toHaveLength(96);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  it('calls onChange with the HH:MM value when an option is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeSelect value="" onChange={onChange} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: '1:30 PM' }));
    expect(onChange).toHaveBeenCalledWith('13:30');
  });

  it('keeps an off-grid saved value selected via a prepended option', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:07" onChange={vi.fn()} />);
    // Trigger shows the off-grid time's label even though it's not on the 15-min grid.
    expect(screen.getByRole('combobox')).toHaveTextContent('9:07 AM');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: '9:07 AM' })).toBeInTheDocument();
  });

  it('can be reset back to blank after a value was already picked', async () => {
    // Regression: the reset option must stay reachable from the open dropdown
    // even once a real time is selected — not just before any pick is made.
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeSelect value="13:30" onChange={onChange} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('1:30 PM');
    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Select time…' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
