import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import ModeFork from '../ModeFork';

describe('ModeFork', () => {
  it('renders both cards, verbatim titles + date-card copy with anchorLabel interpolated', () => {
    renderWithProviders(
      <ModeFork subject="invoice" anchorLabel="the invoice due date" value={null} onPick={vi.fn()} />,
    );

    expect(screen.getByText('How should it start?')).toBeInTheDocument();
    expect(
      screen.getByText('Two different jobs — pick the one that matches what you have in mind.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Right after something happens')).toBeInTheDocument();
    expect(screen.getByText('Before or after a date')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Count from a date you know ahead of time — the invoice due date — and act a set time before or after it.',
      ),
    ).toBeInTheDocument();
  });

  it('clicking each card calls onPick with the right mode; value drives aria-pressed', () => {
    const onPick = vi.fn();
    renderWithProviders(<ModeFork subject="job" anchorLabel="the appointment" value="event" onPick={onPick} />);

    const eventBtn = screen.getByText('Right after something happens').closest('button')!;
    const dateBtn = screen.getByText('Before or after a date').closest('button')!;
    expect(eventBtn).toHaveAttribute('aria-pressed', 'true');
    expect(dateBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(dateBtn);
    expect(onPick).toHaveBeenCalledWith('date');
  });

  it('locked state (anchorLabel null): date card disabled, shows exact mockup lock copy, click is a no-op', () => {
    const onPick = vi.fn();
    renderWithProviders(<ModeFork subject="job" anchorLabel={null} value={null} onPick={onPick} />);

    const dateBtn = screen.getByText('Before or after a date').closest('button')!;
    expect(dateBtn).toBeDisabled();
    expect(screen.getByText('This subject has no scheduled date to count from.')).toBeInTheDocument();

    fireEvent.click(dateBtn);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('event-card body varies by subject noun (job vs estimate article)', () => {
    const { unmount } = renderWithProviders(
      <ModeFork subject="job" anchorLabel="x" value={null} onPick={vi.fn()} />,
    );
    expect(
      screen.getByText('React the moment a job event occurs. You can add a short wait after.'),
    ).toBeInTheDocument();
    unmount();

    renderWithProviders(<ModeFork subject="estimate" anchorLabel="x" value={null} onPick={vi.fn()} />);
    expect(
      screen.getByText('React the moment an estimate event occurs. You can add a short wait after.'),
    ).toBeInTheDocument();
  });
});
