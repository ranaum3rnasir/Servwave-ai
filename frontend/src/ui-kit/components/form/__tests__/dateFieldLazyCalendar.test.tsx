/**
 * Mobile slice 47: the calendar behind every date field is a lazy chunk.
 *
 * `dateField.test.tsx` models the usual case (the chunk was fetched while the page idled). This is
 * the unusual one: the picker is opened before it arrived. The field must stay usable, hold the
 * panel's place with an empty box, then show the calendar, and must keep working when picked from.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DateField } from '../dateField';

describe('DateField with the calendar chunk not yet loaded', () => {
  it('opens to a placeholder box, then shows the calendar, and a day can be picked', async () => {
    const onChange = vi.fn();
    render(<DateField value="2026-08-15" onChange={onChange} aria-label="Date" />);

    fireEvent.click(screen.getByLabelText('Open calendar'));

    // Cold: the very first open in this module graph has nothing cached yet.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    // The rest of the panel is already usable while it loads.
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();

    const grid = await screen.findByRole('grid');
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    const day20 = within(grid)
      .getAllByRole('gridcell')
      .map((c) => within(c).queryByRole('button'))
      .find((b) => b?.textContent === '20');
    fireEvent.click(day20!);
    expect(onChange).toHaveBeenCalledWith('2026-08-20');
  });
});
