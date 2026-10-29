import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EventColorsCard } from './eventColorsCard';
import { SCHEDULE_EVENT_PALETTE } from '@/design-system/scheduleEventPalette';
import { EVENT_TYPE_META } from '@/components/schedule/scheduleModel';

describe('EventColorsCard', () => {
  it('renders a row per board event type, labelled from the shared META', () => {
    render(<EventColorsCard value={{}} onChange={vi.fn()} />);
    for (const meta of Object.values(EVENT_TYPE_META)) {
      expect(screen.getByText(meta.label)).toBeInTheDocument();
    }
  });

  it('offers exactly the design-system palette for every type, by name', () => {
    render(<EventColorsCard value={{}} onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    const swatches = within(group).getAllByRole('radio');
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual(
      SCHEDULE_EVENT_PALETTE.map((e) => e.label),
    );
  });

  // Owner, 2026-09-15: the org picks from the app's palette, never a colour of its own.
  it('has no custom colour input of any kind', () => {
    render(<EventColorsCard value={{}} onChange={vi.fn()} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/custom/i)).not.toBeInTheDocument();
  });

  it('says which types are still on the default', () => {
    render(<EventColorsCard value={{}} onChange={vi.fn()} />);
    expect(screen.getAllByText('Using the default')).toHaveLength(4);
  });

  it('picking a swatch writes that type only, as a TOKEN NAME, leaving the others unset', async () => {
    const onChange = vi.fn();
    render(<EventColorsCard value={{}} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    await userEvent.click(within(group).getByRole('radio', { name: 'Sage' }));
    expect(onChange).toHaveBeenCalledWith({ job: 'sage-700' });
  });

  it('keeps the other types when one is changed', async () => {
    const onChange = vi.fn();
    render(<EventColorsCard value={{ walkthrough: 'amber-700' }} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    await userEvent.click(within(group).getByRole('radio', { name: 'Ocean' }));
    expect(onChange).toHaveBeenCalledWith({ walkthrough: 'amber-700', job: 'ocean-700' });
  });

  it('marks the chosen swatch as checked', () => {
    render(<EventColorsCard value={{ job: 'sage-700' }} onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    expect(within(group).getByRole('radio', { name: 'Sage' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: 'Ocean' })).toHaveAttribute('aria-checked', 'false');
  });

  // "Unset" has to stay reachable, not just be the initial state: it is what keeps an org
  // tracking the design system if the tokens move.
  it('reset DELETES the key rather than writing the default token', async () => {
    const onChange = vi.fn();
    render(<EventColorsCard value={{ job: 'sage-700', walkthrough: 'amber-700' }} onChange={onChange} />);
    await userEvent.click(screen.getAllByRole('button', { name: /reset to default/i })[0]!);
    expect(onChange).toHaveBeenCalledWith({ walkthrough: 'amber-700' });
    expect(onChange.mock.calls[0]![0]).not.toHaveProperty('job');
  });

  it('only offers Reset for a type that is actually customised', () => {
    render(<EventColorsCard value={{ job: 'sage-700' }} onChange={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /reset to default/i })).toHaveLength(1);
    expect(screen.getAllByText('Using the default')).toHaveLength(3);
  });

  it('paints every swatch through its token, never a literal', () => {
    render(<EventColorsCard value={{}} onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: /job colour/i });
    for (const swatch of within(group).getAllByRole('radio')) {
      expect(swatch.getAttribute('style')).toMatch(/rgb\(var\(--[a-z0-9-]+\)\)/);
      expect(swatch.getAttribute('style')).not.toMatch(/#[0-9a-f]{6}/i);
    }
  });
});
