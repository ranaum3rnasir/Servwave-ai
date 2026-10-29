/**
 * RescheduleConfirmDialog - the from -> to confirmation with NO notify composer.
 *
 * Customer notifications come only from automations (scheduling-notifications slice 01). This
 * dialog used to host the hand-composed "Notify the customer" composer, defaulted on, so a
 * board drag emailed the customer from two places at once: the tick here and the org's "Job is
 * rescheduled" automation. The composer is gone; the dialog confirms the move and nothing else.
 * The calendar event dialog keeps its own notify block, because events have no automation.
 *
 * What must stay true:
 *   1. It never claims a send it does not control - it no longer mentions email at all.
 *   2. The confirm button reads as a plain confirmation, never "Reschedule & send".
 *   3. Confirming still fires the move.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RescheduleConfirmDialog } from '../components/rescheduleConfirmDialog';

const BASE = {
  open: true,
  eventType: 'job' as const,
  eventNumber: 'J00042',
  oldStart: new Date('2026-08-01T09:00:00'),
  oldEnd: new Date('2026-08-01T11:00:00'),
  newStart: new Date('2026-08-02T13:00:00'),
  newEnd: new Date('2026-08-02T15:00:00'),
  crewNames: ['Test Tech'],
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('RescheduleConfirmDialog - no customer notification fields', () => {
  it('offers no notify fields: no opt-out, no To, no CC, no Message', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/CC/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.queryByText(/notify the customer/i)).not.toBeInTheDocument();
  });

  it('never asserts that notification emails are being sent', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    expect(screen.queryByText(/notification emails will be sent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Email /)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reschedule & send/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm reschedule/i })).toBeInTheDocument();
  });

  it('still shows the from -> to window and the unchanged crew', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    expect(screen.getByText('Sat, Aug 1')).toBeInTheDocument();
    expect(screen.getByText('Sun, Aug 2')).toBeInTheDocument();
    expect(screen.getByText('Test Tech')).toBeInTheDocument();
  });

  it('confirming fires the move', async () => {
    const onConfirm = vi.fn();
    render(<RescheduleConfirmDialog {...BASE} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByRole('button', { name: /confirm reschedule/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('names a walkthrough as such in the title', () => {
    render(<RescheduleConfirmDialog {...BASE} eventType="walkthrough" eventNumber="L00007" />);

    expect(screen.getByText('Reschedule Walkthrough?')).toBeInTheDocument();
    expect(screen.getByText('L00007')).toBeInTheDocument();
  });
});
