/**
 * Manual Communication Log — re-clicking a required pill must not silently un-answer it.
 *
 * Radix's single-select ToggleGroup emits `''` when the active item is re-clicked. Both required
 * rows here — Channel and Direction — go through RequiredToggleGroup, which refuses that one
 * transition. Without it the second click on the selected Direction pill cleared the field, and
 * the only visible consequence was a Save button that greyed out with no message next to it.
 *
 * This spec pins the CALL SITES: the guard living in the shared module proves nothing about this
 * drawer until this drawer actually uses it, and the broken version (`?? ''`, which never fires
 * on the empty string) type-checks and renders identically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import api from '@/lib/axios';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: { entry: { id: 'entry-1' } } })),
    put: vi.fn(),
    get: vi.fn(() => Promise.resolve({ data: { users: [] } })),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({
    data: { id: 'org-1', timezone: 'America/New_York' },
    isLoading: false,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ data: { users: [] } });
});

const save = () => screen.getByRole('button', { name: /log communication/i });

/** A complete entry: direction, a date in the past, and notes. */
async function openAndComplete(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(
    <LogCommunicationDrawer anchor={{ kind: 'lead', id: 'lead-1' }} onClose={vi.fn()} />,
  );
  await user.click(await screen.findByRole('radio', { name: /outbound/i }));
  await user.type(screen.getByPlaceholderText(/what was discussed/i), 'He rang about the quote.');
  const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
  await user.type(dateInput, '8/5/2026');
  await user.tab();
}

describe('LogCommunicationDrawer — required pills survive a second click', () => {
  it('keeps Direction selected, and Save enabled, when the active pill is clicked again', async () => {
    const user = userEvent.setup();
    await openAndComplete(user);
    expect(save()).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: /outbound/i }));

    expect(save()).toBeEnabled();
    expect(screen.getByRole('radio', { name: /outbound/i })).toHaveAttribute('data-state', 'on');
  });

  it('keeps Channel selected, and Save enabled, when the active pill is clicked again', async () => {
    const user = userEvent.setup();
    await openAndComplete(user);

    await user.click(screen.getByRole('radio', { name: /^call$/i }));

    expect(save()).toBeEnabled();
    expect(screen.getByRole('radio', { name: /^call$/i })).toHaveAttribute('data-state', 'on');
  });

  it('still lets Direction be switched to the other pill', async () => {
    const user = userEvent.setup();
    await openAndComplete(user);

    await user.click(screen.getByRole('radio', { name: /inbound/i }));

    expect(screen.getByRole('radio', { name: /inbound/i })).toHaveAttribute('data-state', 'on');
    expect(screen.getByRole('radio', { name: /outbound/i })).toHaveAttribute('data-state', 'off');
    expect(save()).toBeEnabled();
  });
});
