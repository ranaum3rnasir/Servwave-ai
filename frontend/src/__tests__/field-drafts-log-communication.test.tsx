/**
 * Mobile slice 66: the log-a-call drawer keeps its notes.
 *
 * Notes typed up after a call are the one thing in the drawer that cannot be re-picked from a
 * list. Anything that takes the drawer away without a save (the screen locking and the tab being
 * killed, the page behind it navigating) used to take them with it. They now go through the one
 * draft hook, and come back with "Draft restored" the next time the drawer opens for the same
 * lead or job. Saving, or choosing Discard on the "Discard your changes?" question, clears them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatInTimeZone } from 'date-fns-tz';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import { useAuthStore, type User } from '@/stores/auth.store';
import { draftStorageKey, readDraft } from '@/lib/drafts/fieldDraftStore';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: { entry: { id: 'entry-1' } } })),
    put: vi.fn(),
    get: vi.fn(() => Promise.resolve({ data: { users: [] } })),
    delete: vi.fn(),
  },
}));
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { id: 'org-1', timezone: 'America/New_York' }, isLoading: false }),
}));

const mockApi = vi.mocked(api);
const ORG = 'org-aaaa';
const NOTES = 'He rang about the quote and wants it by Friday.';

function setUser(id: string) {
  const user = { id, organization_id: ORG } as User;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

const draftKey = (userId: string, anchorId = 'lead-1') =>
  draftStorageKey({
    organizationId: ORG,
    userId,
    recordType: 'COMM_LOG_NEW',
    recordId: `lead:${anchorId}`,
    field: 'notes',
  });

function openDrawer(anchorId = 'lead-1') {
  const onClose = vi.fn();
  const view = renderWithProviders(
    <LogCommunicationDrawer anchor={{ kind: 'lead', id: anchorId }} onClose={onClose} />,
  );
  return { onClose, ...view };
}

const notesField = () => screen.findByPlaceholderText(/what was discussed/i);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setUser('user-rep');
});

describe('LogCommunicationDrawer notes drafts', () => {
  it('puts the notes back, with "Draft restored", when the drawer is opened again', async () => {
    const user = userEvent.setup();
    const first = openDrawer();
    await user.type(await notesField(), NOTES);
    // The drawer goes away without a save or a question: the page behind it moved on.
    first.unmount();
    expect(readDraft(draftKey('user-rep'))).toBe(NOTES);

    openDrawer();
    expect(await notesField()).toHaveValue(NOTES);
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
  });

  it('a restored draft counts as unsaved work: closing asks first', async () => {
    const user = userEvent.setup();
    const first = openDrawer();
    await user.type(await notesField(), NOTES);
    first.unmount();

    const { onClose } = openDrawer();
    await notesField();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is kept per lead or job: another record opens empty', async () => {
    const user = userEvent.setup();
    const first = openDrawer('lead-1');
    await user.type(await notesField(), NOTES);
    first.unmount();

    openDrawer('lead-2');
    expect(await notesField()).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });

  it("does not show another user's draft", async () => {
    const user = userEvent.setup();
    const first = openDrawer();
    await user.type(await notesField(), NOTES);
    first.unmount();

    setUser('user-other');
    openDrawer();
    expect(await notesField()).toHaveValue('');
  });

  it('logging the call clears the draft', async () => {
    const user = userEvent.setup();
    const { onClose } = openDrawer();
    await user.click(await screen.findByRole('radio', { name: /outbound/i }));
    await user.type(await notesField(), NOTES);
    const dateInput = screen.getByPlaceholderText('MM/DD/YYYY');
    await user.type(dateInput, formatInTimeZone(new Date(Date.now() - 2 * 86_400_000), 'America/New_York', 'M/d/yyyy'));
    await user.tab();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log communication' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Log communication' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(readDraft(draftKey('user-rep'))).toBeNull();
  });

  it('choosing Discard on the question throws the notes away on purpose', async () => {
    const user = userEvent.setup();
    const { onClose, unmount } = openDrawer();
    await user.type(await notesField(), NOTES);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(readDraft(draftKey('user-rep'))).toBeNull();

    openDrawer();
    expect(await notesField()).toHaveValue('');
  });

  it('Discard on the restored note empties the field', async () => {
    const user = userEvent.setup();
    const first = openDrawer();
    await user.type(await notesField(), NOTES);
    first.unmount();

    openDrawer();
    await notesField();
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'Discard' }));
    expect(screen.getByPlaceholderText(/what was discussed/i)).toHaveValue('');
    expect(readDraft(draftKey('user-rep'))).toBeNull();
  });
});
