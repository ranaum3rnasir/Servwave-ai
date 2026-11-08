// The v2 field set every scheduling surface renders: start date, start time, end date,
// end time. Same shape and same field-moves-field rules as the legacy
// `components/schedule/ScheduleTimeFields`, because both delegate to the one
// `scheduleTimeValue` module - only the chrome differs (UI kit here, legacy tokens there).
// The arithmetic itself is pinned in scheduleTimeValue.test.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ScheduleTimeFields } from '../scheduleTimeFields';
import type { ScheduleTimeValue } from '@/components/schedule/scheduleTimeValue';

const VALUE: ScheduleTimeValue = {
  date: '2026-08-10',
  startTime: '09:00',
  endDate: '2026-08-10',
  endTime: '11:00',
};

function renderFields(over: Partial<React.ComponentProps<typeof ScheduleTimeFields>> = {}) {
  const onChange = vi.fn();
  renderWithProviders(<ScheduleTimeFields value={VALUE} onChange={onChange} {...over} />);
  return { onChange };
}

describe('v2 ScheduleTimeFields', () => {
  it('renders exactly four fields: start date, start time, end date, end time', () => {
    renderFields();
    expect(screen.getByLabelText('Start date')).toHaveValue('08/10/2026');
    expect(screen.getByLabelText('Start time')).toHaveValue('9:00 AM');
    expect(screen.getByLabelText('End date')).toHaveValue('08/10/2026');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00 AM');
    // No duration control anywhere - it was the field that made the board and the job
    // dialog describe one act of scheduling two different ways.
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
  });

  it('editing the end time emits the new end, leaving the start alone', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '10:00 AM' } });
    fireEvent.blur(screen.getByLabelText('End time'));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, endTime: '10:00' });
  });

  it('an end time at or before the start rolls the end DATE forward, visibly', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '1:00 AM' } });
    fireEvent.blur(screen.getByLabelText('End time'));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, endDate: '2026-08-11', endTime: '01:00' });
  });

  it('moving the start time drags the end with it, keeping the span', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2:00 PM' } });
    fireEvent.blur(screen.getByLabelText('Start time'));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, startTime: '14:00', endTime: '16:00' });
  });

  it('moving the start date drags the end date with it', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '09/01/2026' } });
    fireEvent.blur(screen.getByLabelText('Start date'));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, date: '2026-09-01', endDate: '2026-09-01' });
  });

  it('takes a multi-day range as typed, without a reveal step', () => {
    const { onChange } = renderFields();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '08/12/2026' } });
    fireEvent.blur(screen.getByLabelText('End date'));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, endDate: '2026-08-12' });
  });

  it('says so when the end is dragged back before the start', () => {
    renderFields({ value: { ...VALUE, endDate: '2026-08-09' } });
    expect(screen.getByText('Ends before it starts')).toBeInTheDocument();
  });

  it('stays quiet on a valid range', () => {
    renderFields();
    expect(screen.queryByText('Ends before it starts')).not.toBeInTheDocument();
  });

  it('disables every field together', () => {
    renderFields({ disabled: true });
    expect(screen.getByLabelText('Start date')).toBeDisabled();
    expect(screen.getByLabelText('Start time')).toBeDisabled();
    expect(screen.getByLabelText('End date')).toBeDisabled();
    expect(screen.getByLabelText('End time')).toBeDisabled();
  });
});
