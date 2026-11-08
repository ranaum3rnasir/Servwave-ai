/**
 * Manual Communication Log — "When did it happen? *" is REQUIRED, so the shared
 * DateTimePicker's clear (×) must not be reachable in this drawer.
 *
 * The X is not the drawer's own markup: DateTimePicker renders it for every consumer that
 * holds a value. Most of them (tasks, service plans, inventory stages) carry an OPTIONAL
 * date, where emptying it is a real intent. Here it is the one thing the
 * button cannot express — clearing only drops the form into a state the user must re-fill —
 * so the drawer opts out with `clearable={false}`. This spec pins the CALL SITE: a picker
 * that quietly stopped passing the prop would still pass DateTimePicker's own unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LogCommunicationDrawer — required occurred-at', () => {
  it('offers no clear button on the date field even once a date is chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LogCommunicationDrawer anchor={{ leadId: 'lead-1' }} onClose={vi.fn()} />,
    );

    expect(await screen.findByText(/when did it happen\?/i)).toBeInTheDocument();
    // Empty: nobody renders the X in this state, so it proves nothing on its own.
    expect(screen.queryByRole('button', { name: /clear date and time/i })).not.toBeInTheDocument();

    // Pick a date — the state in which every other consumer WOULD show the X.
    const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
    await user.type(dateInput, '8/5/2026');
    await user.tab();
    expect(screen.getByDisplayValue('08/05/2026')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /clear date and time/i })).not.toBeInTheDocument();
  });
});
