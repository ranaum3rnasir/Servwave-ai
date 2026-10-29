/**
 * Mobile slice 57: the job-note and visit-cancel-reason surfaces keep what was typed.
 *
 * A technician types a note, the camera opens (or the screen locks, or the tab is switched), and
 * the page comes back with an empty box. These tests drive the real components, with a signed-in
 * user carrying an organisation, and prove the text survives a remount, comes back with
 * "Draft restored" and a Discard, is cleared by a save, and is never shown to a second user.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { useAuthStore, type User } from '@/stores/auth.store';
import { JobNotesPreview } from '@/components/jobs/overview/JobNotesPreview';
import { VisitsCard } from '@/pages/v2/jobs/components/visitsCard';
import { ActivityPanel } from '@/components/crm/ActivityPanel';
import { draftStorageKey, readDraft, writeDraft } from '@/lib/drafts/fieldDraftStore';
import { DRAFT_DEBOUNCE_MS } from '@/lib/drafts/useFieldDraft';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';
import type { JobVisitRow } from '@/lib/visits';

const mockApi = vi.mocked(api);

const ORG = 'org-aaaa';
const TECH = 'user-tech';
const OTHER = 'user-other';
const JOB = 'job-0001';

function setUser(id: string | null) {
  const user = id ? ({ id, organization_id: ORG } as User) : null;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: !!user })) as never);
}

const noteKey = (userId = TECH, field = 'overview-note') =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'JOB', recordId: JOB, field });

/** The page being backgrounded: what the camera opening, the screen locking or a tab freeze do. */
function backgroundThePage() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setUser(TECH);
  mockApi.get.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── The job overview's note composer ────────────────────────────────────────

describe('JobNotesPreview composer', () => {
  function renderComposer(extra: Partial<React.ComponentProps<typeof JobNotesPreview>> = {}) {
    return renderWithProviders(
      <JobNotesPreview jobId={JOB} notes={[]} addAffordance="inline-button" {...extra} />,
    );
  }

  it('types a note, backgrounds the page, and the note is back after a remount with "Draft restored"', async () => {
    const user = userEvent.setup();
    const first = renderComposer();
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await user.type(screen.getByPlaceholderText('Type internal note…'), 'Gate code is 4411, dog in yard');
    backgroundThePage();
    expect(readDraft(noteKey())).toBe('Gate code is 4411, dog in yard');

    // The page was discarded while backgrounded and came back: a fresh mount.
    first.unmount();
    renderComposer();

    // The composer opens by itself: a restored draft hidden behind a closed card is a lost draft.
    const box = screen.getByPlaceholderText('Type internal note…');
    expect(box).toHaveValue('Gate code is 4411, dog in yard');
    const note = screen.getByRole('status');
    expect(within(note).getByText('Draft restored')).toBeInTheDocument();
    expect(within(note).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('shows no restored note on a fresh composer, or for text typed in this visit', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await user.type(screen.getByPlaceholderText('Type internal note…'), 'fresh');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });

  it('Discard empties the box and deletes the draft', async () => {
    writeDraft(noteKey(), 'old words');
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByPlaceholderText('Type internal note…')).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
    expect(readDraft(noteKey())).toBeNull();
  });

  it('saving the note clears the draft', async () => {
    writeDraft(noteKey(), 'a note to save');
    mockApi.post.mockResolvedValue({ data: { note: { id: 'n1' } } });
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Add Note' }));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB}/notes`, { content: 'a note to save' });
    await vi.waitFor(() => expect(readDraft(noteKey())).toBeNull());
    expect(hasUnsavedWork()).toBe(false);
  });

  it('a failed save keeps the draft', async () => {
    writeDraft(noteKey(), 'a note that will not save');
    mockApi.post.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Add Note' }));
    expect(await screen.findByText('Failed to add note')).toBeInTheDocument();
    expect(readDraft(noteKey())).toBe('a note that will not save');
    expect(screen.getByPlaceholderText('Type internal note…')).toHaveValue('a note that will not save');
  });

  it('Cancel (the person abandoning the note) clears the draft', async () => {
    writeDraft(noteKey(), 'changed my mind');
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(readDraft(noteKey())).toBeNull();
  });

  it("a second user on the same device never sees the first user's draft", async () => {
    writeDraft(noteKey(TECH), 'first user, customer details');
    setUser(OTHER);
    renderComposer();
    // Nothing restored: the composer stays closed and no note is shown.
    expect(screen.queryByPlaceholderText('Type internal note…')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
    expect(screen.queryByText('first user, customer details')).not.toBeInTheDocument();
  });

  it('registers with the unsaved-work signal while it holds a draft', async () => {
    writeDraft(noteKey(), 'unsaved');
    const { unmount } = renderComposer();
    expect(hasUnsavedWork()).toBe(true);
    unmount();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('does not store a draft for someone who cannot add notes', () => {
    writeDraft(noteKey(), 'left over from before the role changed');
    renderComposer({ canAddNotes: false });
    expect(screen.queryByPlaceholderText('Type internal note…')).not.toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('writes after the debounce while typing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderComposer();
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await user.type(screen.getByPlaceholderText('Type internal note…'), 'abc');
    expect(readDraft(noteKey())).toBeNull();
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS + 10); });
    expect(readDraft(noteKey())).toBe('abc');
    vi.useRealTimers();
  });
});

// ─── The visit cancel reason ─────────────────────────────────────────────────

const VISIT = {
  id: 'visit-0001',
  visit_seq: 2,
  status: 'SCHEDULED',
  scheduled_at: '2026-10-06T14:00:00.000Z',
  scheduled_end: '2026-10-06T15:00:00.000Z',
  is_all_day: false,
  assignees: [],
} as unknown as JobVisitRow;

const reasonKey = (userId = TECH) =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'VISIT', recordId: VISIT.id, field: 'cancel-reason' });

describe('VisitsCard cancel reason', () => {
  function renderCard() {
    return renderWithProviders(<VisitsCard jobId={JOB} visits={[VISIT]} canSchedule />);
  }

  async function openCancel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    return screen.findByPlaceholderText('Why is this visit being called off?');
  }

  it('keeps the reason when the dialog is dismissed or the page is backgrounded, and restores it on reopening', async () => {
    const user = userEvent.setup();
    const first = renderCard();
    const reason = await openCancel(user);
    await user.type(reason, 'Customer is away until Friday');
    backgroundThePage();
    expect(readDraft(reasonKey())).toBe('Customer is away until Friday');

    first.unmount();
    renderCard();
    const again = await openCancel(user);
    expect(again).toHaveValue('Customer is away until Friday');
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
  });

  it('Discard on the restored note empties the reason and deletes the draft', async () => {
    writeDraft(reasonKey(), 'old reason');
    const user = userEvent.setup();
    renderCard();
    const reason = await openCancel(user);
    expect(reason).toHaveValue('old reason');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(reason).toHaveValue('');
    expect(readDraft(reasonKey())).toBeNull();
  });

  it('cancelling the visit clears the draft', async () => {
    writeDraft(reasonKey(), 'Customer is away');
    mockApi.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    renderCard();
    await openCancel(user);
    await user.click(screen.getByRole('button', { name: 'Cancel visit' }));
    expect(mockApi.post).toHaveBeenCalledWith(
      `/api/jobs/${JOB}/visits/${VISIT.id}/cancel`,
      { cancelled_reason: 'Customer is away' },
    );
    await vi.waitFor(() => expect(readDraft(reasonKey())).toBeNull());
  });

  it("a second user never sees the first user's reason", async () => {
    writeDraft(reasonKey(TECH), "first user's reason");
    setUser(OTHER);
    const user = userEvent.setup();
    renderCard();
    const reason = await openCancel(user);
    expect(reason).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });
});

// ─── The activity rail's note box on a job ───────────────────────────────────

describe('ActivityPanel note box', () => {
  const railKey = (entityType: string, userId = TECH) =>
    draftStorageKey({ organizationId: ORG, userId, recordType: entityType, recordId: JOB, field: 'activity-note' });

  it('keeps a job note across a remount, with "Draft restored"', async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<ActivityPanel entityType="JOB" entityId={JOB} />);
    await user.type(screen.getByPlaceholderText('Add a note...'), 'Needs a longer ladder next time');
    backgroundThePage();
    expect(readDraft(railKey('JOB'))).toBe('Needs a longer ladder next time');

    first.unmount();
    renderWithProviders(<ActivityPanel entityType="JOB" entityId={JOB} />);
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('Needs a longer ladder next time');
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
  });

  it('adding the note clears the draft', async () => {
    writeDraft(railKey('JOB'), 'to be added');
    mockApi.post.mockResolvedValue({ data: { note: { id: 'n1' } } });
    const user = userEvent.setup();
    renderWithProviders(<ActivityPanel entityType="JOB" entityId={JOB} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(readDraft(railKey('JOB'))).toBeNull());
  });

  it("is for job notes only: a lead's note box is left exactly as it was", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityPanel entityType="LEAD" entityId={JOB} />);
    await user.type(screen.getByPlaceholderText('Add a note...'), 'a lead note');
    backgroundThePage();
    expect(readDraft(railKey('LEAD'))).toBeNull();
  });
});
