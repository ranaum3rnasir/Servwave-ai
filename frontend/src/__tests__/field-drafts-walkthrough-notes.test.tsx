/**
 * Mobile slice 66 (moved to the Notes tab's walkthrough cards): a half-typed walkthrough note on the
 * lead page survives a tab switch. The Notes panel unmounts when another tab is chosen; each
 * walkthrough's card keeps its unsent text through the one draft hook (the walkthrough's saved
 * notes are its baseline), per walkthrough and per person, and clears it on a successful save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from './helpers';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { LeadWalkthroughNotes } from '@/pages/v2/leads/components/leadWalkthroughNotes';
import type { VisitHistoryRow } from '@/pages/v2/leads/components/leadShared';
import { buildAbility } from '@/lib/ability';
import { useAuthStore, type User } from '@/stores/auth.store';
import { draftStorageKey, readDraft } from '@/lib/drafts/fieldDraftStore';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));

stubBrowser();

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/leadDetailRouter')).leadDetailRouter());

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const ORG = 'org-aaaa';
const PLACEHOLDER = 'Walkthrough notes...';

function setUser(id: string) {
  const user = { id, organization_id: ORG } as User;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

const notesKey = (userId: string, visitId = 'w1') =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'LEAD', recordId: LEAD_ID, field: `walkthrough-notes-${visitId}` });

const wt = (id: string, seq: number, notes: string | null) => ({
  id, visit_seq: seq, status: 'SCHEDULED', scheduled_at: '2026-11-05T15:00:00.000Z', completed_at: null,
  cancelled_at: null, cancelled_reason: null, created_at: `2026-10-0${seq}T12:00:00.000Z`, notes,
  performers: [{ id: 'p1', first_name: 'Test', last_name: 'Tech' }], can_write_notes: true,
});

function mockLead(savedNotes: string | null, extraVisits: unknown[] = []) {
  serveLeadDetail({
    lead: { ...LEAD_FIXTURE, status: 'CONTACTED', walkthrough_history: [wt('w1', 1, savedNotes), ...extraVisits] },
  });
}

async function openNotes(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: 'Notes' }));
  return screen.findByRole('textbox', { name: 'Walkthrough 1 notes' });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setUser('user-tech');
  mockLead(null);
});

describe('lead walkthrough notes on the Notes tab', () => {
  it('keeps notes typed on the card across a tab switch, restored with "Draft restored"', async () => {
    const user = userEvent.setup();
    renderLeadDetail();

    const notes = await openNotes(user);
    await user.type(notes, 'Unit is on the roof; access via the south stairwell.');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();

    // Switching tabs unmounts the Notes panel.
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByPlaceholderText(PLACEHOLDER)).not.toBeInTheDocument();
    expect(readDraft(notesKey('user-tech'))).toBe('Unit is on the roof; access via the south stairwell.');

    const back = await openNotes(user);
    expect(back).toHaveValue('Unit is on the roof; access via the south stairwell.');
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
    // Still unsaved, so the Save Notes control is still offered.
    expect(screen.getByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
  });

  it("opens on the walkthrough's saved notes, which are not a draft", async () => {
    mockLead('Gate code is 4417');
    const user = userEvent.setup();
    renderLeadDetail();

    const notes = await openNotes(user);
    expect(notes).toHaveValue('Gate code is 4417');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Notes/ })).not.toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('an edit to saved notes survives a tab switch and comes back as the edited text', async () => {
    mockLead('Gate code is 4417');
    const user = userEvent.setup();
    renderLeadDetail();

    const notes = await openNotes(user);
    await user.type(notes, ' and the dog is friendly');
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    const back = await openNotes(user);
    expect(back).toHaveValue('Gate code is 4417 and the dog is friendly');
    expect(screen.getByText('Draft restored')).toBeInTheDocument();
  });

  it("keeps each walkthrough's unsent text on its own card", async () => {
    mockLead('One', [wt('w2', 2, 'Two')]);
    const user = userEvent.setup();
    renderLeadDetail();

    await openNotes(user);
    await user.type(screen.getByRole('textbox', { name: 'Walkthrough 2 notes' }), ' typed');
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await openNotes(user);
    expect(screen.getByRole('textbox', { name: 'Walkthrough 2 notes' })).toHaveValue('Two typed');
    expect(screen.getByRole('textbox', { name: 'Walkthrough 1 notes' })).toHaveValue('One');
    expect(readDraft(notesKey('user-tech', 'w1'))).toBeNull();
  });

  it('saving the notes clears the draft', async () => {
    mockApi.patch.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    renderLeadDetail();

    const notes = await openNotes(user);
    await user.type(notes, 'Done and dusted');
    await user.click(screen.getByRole('button', { name: /Save Notes/ }));
    expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/visits/w1/notes`, { notes: 'Done and dusted' });
    await waitFor(() => expect(readDraft(notesKey('user-tech'))).toBeNull());
    expect(hasUnsavedWork()).toBe(false);
  });

  it("does not show another user's draft", async () => {
    const user = userEvent.setup();
    const first = renderLeadDetail();
    await user.type(await openNotes(user), "first user's private note");
    first.unmount();

    setUser('user-other');
    renderLeadDetail();
    expect(await openNotes(user)).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });
});

describe('a walkthrough notes card follows notes saved elsewhere', () => {
  const card = (notes: string | null) =>
    <LeadWalkthroughNotes leadId={LEAD_ID} tz="America/New_York" history={[wt('w1', 1, notes) as unknown as VisitHistoryRow]} />;

  it('shows the newly saved text, with no Save Notes, when nothing unsent was typed', async () => {
    const view = renderWithProviders(card('Gate code is 4417'), { ability: adminAbility });
    expect(screen.getByRole('textbox', { name: 'Walkthrough 1 notes' })).toHaveValue('Gate code is 4417');

    view.rerender(card('Gate code is 9999'));
    expect(screen.getByRole('textbox', { name: 'Walkthrough 1 notes' })).toHaveValue('Gate code is 9999');
    expect(screen.queryByRole('button', { name: /Save Notes/ })).not.toBeInTheDocument();
  });

  it('keeps the unsent text the person typed when the saved notes change', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(card('Gate code is 4417'), { ability: adminAbility });
    await user.type(screen.getByRole('textbox', { name: 'Walkthrough 1 notes' }), ' plus my addition');
    // The draft reaches storage after the typing pause (the saved notes then change under it).
    await waitFor(() => expect(readDraft(notesKey('user-tech'))).toBe('Gate code is 4417 plus my addition'));

    view.rerender(card('Gate code is 9999'));
    expect(screen.getByRole('textbox', { name: 'Walkthrough 1 notes' })).toHaveValue('Gate code is 4417 plus my addition');
    expect(screen.getByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
  });

  it('keeps text typed while the person\'s own save is in flight', async () => {
    const user = userEvent.setup();
    let finish!: (v: unknown) => void;
    mockApi.patch.mockImplementation(() => new Promise((r) => { finish = r; }) as never);
    const view = renderWithProviders(card('A'), { ability: adminAbility });
    const box = () => screen.getByRole('textbox', { name: 'Walkthrough 1 notes' });
    await user.type(box(), ' B');
    await user.click(screen.getByRole('button', { name: /Save Notes/ }));
    await user.type(box(), ' C');
    finish({ data: {} });
    await waitFor(() => expect(readDraft(notesKey('user-tech'))).toBe('A B C'));

    // The refetch brings back what was sent; the card remounts on it.
    view.rerender(card('A B'));
    expect(mockApi.patch).toHaveBeenCalledWith(expect.any(String), { notes: 'A B' });
    expect(box()).toHaveValue('A B C');
    expect(screen.getByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
    expect(readDraft(notesKey('user-tech'))).toBe('A B C');
  });
});
