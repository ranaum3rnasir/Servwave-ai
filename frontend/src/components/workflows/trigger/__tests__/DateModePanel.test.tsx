import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import DateModePanel from '../DateModePanel';

const ANCHOR = 'the appointment';

describe('DateModePanel', () => {
  it('renders the mockup’s heading/subheading with anchorLabel interpolated', () => {
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={vi.fn()} />);

    expect(screen.getByText(`How far from ${ANCHOR}?`)).toBeInTheDocument();
    expect(screen.getByText(/Tap a common timing, or set your own\./)).toBeInTheDocument();
  });

  it('renders exactly five chips (the four approved presets + Custom…) and nothing day-of/morning-of', () => {
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: '1 day before' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 hours before' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 day after' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 days after' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom…' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(5);

    expect(screen.queryByText(/morning|on the day|day-of|same day|evening/i)).not.toBeInTheDocument();
  });

  it.each([
    ['1 day before', { direction: 'before', offsetMinutes: 1440 }],
    ['2 hours before', { direction: 'before', offsetMinutes: 120 }],
    ['1 day after', { direction: 'after', offsetMinutes: 1440 }],
    ['3 days after', { direction: 'after', offsetMinutes: 4320 }],
  ] as const)('clicking preset "%s" emits exactly %j', (label, expected) => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('value matching a preset highlights only that chip and keeps the custom row closed', () => {
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 120 }} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: '2 hours before' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1 day before' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Custom timing')).not.toBeInTheDocument();
  });

  it('value of null highlights nothing and keeps the custom row closed', () => {
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={vi.fn()} />);

    for (const name of ['1 day before', '2 hours before', '1 day after', '3 days after', 'Custom…']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.queryByText('Custom timing')).not.toBeInTheDocument();
  });

  it('value prop (not internal click state) drives which chip is highlighted, across rerenders', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 1440 }} onChange={onChange} />,
    );
    expect(screen.getByRole('button', { name: '1 day before' })).toHaveAttribute('aria-pressed', 'true');

    rerender(<DateModePanel anchorLabel={ANCHOR} value={{ direction: 'after', offsetMinutes: 4320 }} onChange={onChange} />);

    expect(screen.getByRole('button', { name: '1 day before' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '3 days after' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a value matching no preset auto-opens Custom… and seeds the row via splitOffset', () => {
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 90 }} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Custom timing')).toBeInTheDocument();
    expect(screen.getByLabelText('Timing amount')).toHaveValue(90);
    expect(screen.getByRole('combobox', { name: 'Timing unit' })).toHaveTextContent('minutes');
    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the direction control is a genuine 2-option segmented toggle — no dropdown, no third "On" option', () => {
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'after', offsetMinutes: 90 }} onChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Before' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^On$/)).not.toBeInTheDocument();
    // Exactly one combobox on screen (the unit dropdown) — direction is a button pair, never a <select>.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('opening Custom… from scratch seeds a default (1 day, Before) without itself calling onChange', () => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Timing amount')).toHaveValue(1);
    expect(screen.getByRole('combobox', { name: 'Timing unit' })).toHaveTextContent('days');
    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opening Custom… from an active preset seeds the row from that preset’s current value', () => {
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 120 }} onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));

    expect(screen.getByLabelText('Timing amount')).toHaveValue(2);
    expect(screen.getByRole('combobox', { name: 'Timing unit' })).toHaveTextContent('hours');
    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('custom row: editing the number recomputes offsetMinutes from the current unit + direction', () => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' })); // seeds 1 / days / Before

    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '3' } });

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'before', offsetMinutes: 4320 });
  });

  it('custom row: 3 × days + After emits the brief’s exact acceptance value', () => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' })); // seeds 1 / days / Before

    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'After' }));

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'after', offsetMinutes: 4320 });
  });

  it('custom row: switching direction alone preserves the current amount', () => {
    const onChange = vi.fn();
    renderWithProviders(
      // 4320min/before matches no preset (4320 only pairs with 'after' in PRESETS) → custom auto-opens, seeded 3/days/before.
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 4320 }} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'After' }));

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'after', offsetMinutes: 4320 });
  });

  it('custom row: switching the unit alone recomputes with the current number + direction', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      // 4320min/after matches the '3d_after' preset exactly → custom starts closed; opening it re-seeds 3/days/after.
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'after', offsetMinutes: 4320 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));

    await user.click(screen.getByRole('combobox', { name: 'Timing unit' }));
    await user.click(await screen.findByRole('option', { name: 'hours' }));

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'after', offsetMinutes: 180 });
  });

  it('custom row: the weeks unit (a local extension — not in the shared OffsetUnit type) computes correctly', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '2' } });

    await user.click(screen.getByRole('combobox', { name: 'Timing unit' }));
    await user.click(await screen.findByRole('option', { name: 'weeks' }));

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'before', offsetMinutes: 20160 });
  });

  it('custom row: 0 is a legitimate amount ("just before/after")', () => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));

    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '0' } });

    expect(onChange).toHaveBeenLastCalledWith({ direction: 'before', offsetMinutes: 0 });
  });

  it('custom row: clearing the number does not emit (avoids NaN) but leaves the field editable', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 1440 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    onChange.mockClear();

    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Timing amount')).toHaveValue(null);
  });

  it('custom row: a non-integer final offset (e.g. 1.5 minutes) does not emit', () => {
    const onChange = vi.fn();
    // 90 minutes matches no preset → custom auto-opens seeded via splitOffset(90) = 90 / minutes.
    renderWithProviders(
      <DateModePanel anchorLabel={ANCHOR} value={{ direction: 'before', offsetMinutes: 90 }} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '1.5' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('picking a preset after the custom row was open closes the custom row again', () => {
    const onChange = vi.fn();
    renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));
    expect(screen.getByText('Custom timing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '1 day before' }));

    expect(screen.queryByText('Custom timing')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({ direction: 'before', offsetMinutes: 1440 });
  });

  // ── allowAfter={false} — used for the Estimate subject ────────────────────
  // "N after the estimate expiration" can never fire: estimate-expiration.ts
  // CANCELs the estimate the moment valid_until passes, and the date-anchor
  // sweep only selects SENT/PENDING. So the whole after direction is hidden for
  // estimates rather than offered-and-silently-broken.
  describe('allowAfter={false}', () => {
    it('shows only the before presets + Custom… (no after chips), three buttons total', () => {
      renderWithProviders(<DateModePanel anchorLabel={ANCHOR} allowAfter={false} value={null} onChange={vi.fn()} />);

      expect(screen.getByRole('button', { name: '1 day before' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '2 hours before' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '1 day after' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '3 days after' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Custom…' })).toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(3);
    });

    it('the custom row offers no After segment and its offsets always emit before', () => {
      const onChange = vi.fn();
      renderWithProviders(<DateModePanel anchorLabel={ANCHOR} allowAfter={false} value={null} onChange={onChange} />);
      fireEvent.click(screen.getByRole('button', { name: 'Custom…' }));

      expect(screen.getByText('Custom timing')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'After' })).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Timing amount'), { target: { value: '5' } });
      expect(onChange).toHaveBeenLastCalledWith({ direction: 'before', offsetMinutes: 5 * 1440 });
    });

    it('defaults to before presets when omitted (allowAfter is true by default)', () => {
      renderWithProviders(<DateModePanel anchorLabel={ANCHOR} value={null} onChange={vi.fn()} />);
      expect(screen.getByRole('button', { name: '1 day after' })).toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
  });
});
