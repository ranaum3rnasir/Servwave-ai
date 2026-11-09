/**
 * Mobile slice 43: logging a call, typing notes, then tapping away asks before it discards them.
 *
 * Before this the drawer closed on every dismissal - outside tap, Escape, Cancel - and the notes
 * somebody had typed up from memory were gone with no question asked. The drawer now reports its
 * own dirtiness to the shared guard, so every way out asks while there is something to lose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: { entry: { id: 'entry-1' } } })),
    put: vi.fn(),
    get: vi.fn(() => Promise.resolve({ data: { users: [] } })),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { id: 'org-1', timezone: 'America/New_York' }, isLoading: false }),
}));

beforeEach(() => vi.clearAllMocks());

function openDrawer() {
  const onClose = vi.fn();
  renderWithProviders(
    <LogCommunicationDrawer anchor={{ kind: 'lead', id: 'lead-1' }} onClose={onClose} />,
  );
  return onClose;
}

async function typeNotes(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText(/what was discussed/i), 'He rang about the quote.');
}

describe('LogCommunicationDrawer dirty guard', () => {
  it('Escape after typing notes asks before discarding', async () => {
    const user = userEvent.setup();
    const onClose = openDrawer();
    await typeNotes(user);
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel after typing notes asks; Keep editing keeps the notes', async () => {
    const user = userEvent.setup();
    const onClose = openDrawer();
    await typeNotes(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/what was discussed/i)).toHaveValue('He rang about the quote.');
  });

  it('Discard closes the drawer', async () => {
    const user = userEvent.setup();
    const onClose = openDrawer();
    await typeNotes(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an untouched drawer closes without a question', async () => {
    const user = userEvent.setup();
    const onClose = openDrawer();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });
});
