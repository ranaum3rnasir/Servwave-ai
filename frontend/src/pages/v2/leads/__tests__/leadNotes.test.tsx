import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { useAuthStore, type User } from '@/stores/auth.store';
import { draftStorageKey, readDraft } from '@/lib/drafts/fieldDraftStore';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: LEAD_FIXTURE.id }), useNavigate: () => vi.fn() };
});

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('leadNoteDelete', () => {
  /* =============================================================================
     Roles & Permissions, PRD 4, slice S04.25 - the delete control on a lead's notes. Renders the ROUTED lead page
     (pages/v2/leads/LeadDetailPage) and opens the Activity panel in its side rail, where the lead's notes are listed.

     Whether this person may delete a note is the server's per-note answer (`can_delete`). A lead never takes the job
     lock, and a closed lead (Won or Lost) locks only its contact entries, so a closed lead's notes delete like any
     other. A confirmed delete calls the lead's own route and refreshes the notes.
     ========================================================================== */

  stubBrowser();

  const mockApi = vi.mocked(api);

  const note = (id: string, first: string, answer: Record<string, unknown>) => ({
    id, content: `Text of ${id}`, created_at: '2026-08-10T12:00:00.000Z',
    creator: { id: `u-${id}`, first_name: first, last_name: 'Tester' }, ...answer,
  });
  const MINE = note('mine', 'Mia', { can_delete: true, locked_actions: [] });
  const THEIRS = note('theirs', 'Theo', { can_delete: false, locked_actions: [] });

  let noteRows: unknown[] = [];

  function renderLeadPage(over: Record<string, unknown> = {}) {
    const lead = { ...LEAD_FIXTURE, estimates: [], contact_entries: [], actions: [], ...over };
    serveLeadDetail({ lead, notes: () => noteRows });
    return renderLeadDetail({ ability: buildAbility([{ action: 'read', subject: 'Lead' }]) });
  }

  const openActivity = async () => {
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Activity' }));
    return within(await screen.findByTestId('icon-rail-panel'));
  };

  let restoreDevice: (() => void) | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    noteRows = [];
    restoreDevice = emulateDevice(DESKTOP);
  });
  afterEach(() => {
    restoreDevice?.();
  });

  describe('the lead page\'s Activity panel', () => {
    it('draws Delete on a note the person may delete and on no other', async () => {
      noteRows = [MINE, THEIRS];
      renderLeadPage();
      const panel = await openActivity();
      await panel.findByText('Text of mine');
      expect(panel.getByRole('button', { name: 'Delete note by Mia Tester' })).toBeEnabled();
      expect(panel.getByText('Text of theirs')).toBeInTheDocument();
      expect(panel.queryByRole('button', { name: 'Delete note by Theo Tester' })).not.toBeInTheDocument();
    });

    it.each(['WON', 'LOST'])('still draws Delete on the notes of a %s lead: the closed-lead lock covers contact entries only', async (status) => {
      noteRows = [MINE];
      renderLeadPage({ status });
      const panel = await openActivity();
      await panel.findByText('Text of mine');
      expect(panel.getByRole('button', { name: 'Delete note by Mia Tester' })).toBeEnabled();
    });

    it('asks first, then deletes through the lead\'s own route and refreshes the notes', async () => {
      noteRows = [MINE];
      renderLeadPage();
      const panel = await openActivity();
      await panel.findByText('Text of mine');
      const user = userEvent.setup();
      await user.click(panel.getByRole('button', { name: 'Delete note by Mia Tester' }));
      expect(mockApi.delete).not.toHaveBeenCalled();
      noteRows = [];
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/notes/mine`));
      await waitFor(() => expect(panel.queryByText('Text of mine')).not.toBeInTheDocument());
    });
  });
});

describe('leadNotesTab', () => {
  /* =============================================================================
     The lead page's Notes tab - the job's Notes tab on the lead (the shared RecordNotesTab). Renders the ROUTED lead page.
     The tab strip order, the newest-first list with author, time ago and the delete control where the server's per-note
     answer allows, "Add note" only from the lead's `add_note` action, and the unsent text surviving a tab switch.
     ========================================================================== */

  stubBrowser();

  const mockApi = vi.mocked(api);

  const note = (id: string, first: string, createdAt: string, answer: Record<string, unknown> = {}) => ({
    id, content: `Text of ${id}`, created_at: createdAt,
    creator: { id: `u-${id}`, first_name: first, last_name: 'Tester' }, can_delete: false, locked_actions: [], ...answer,
  });

  let noteRows: unknown[] = [];

  let history: unknown[] = [];

  function renderLeadPage(actions: string[]) {
    const lead = { ...LEAD_FIXTURE, estimates: [], contact_entries: [], actions, walkthrough_history: history };
    serveLeadDetail({ lead, notes: () => noteRows });
    return renderLeadDetail({
      ability: buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'read', subject: 'Communication' }]),
    });
  }

  const openNotesTab = async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notes' }));
    return user;
  };

  let restoreDevice: (() => void) | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // The kept unsent text is keyed on the signed-in account, so a person is signed in.
    const me = { id: 'user-1', organization_id: 'org-1' } as User;
    vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
      selector({ user: me, isAuthenticated: true })) as never);
    noteRows = [];
    history = [];
    restoreDevice = emulateDevice(DESKTOP);
  });
  afterEach(() => {
    restoreDevice?.();
  });

  describe("the lead page's Notes tab", () => {
    it('puts Notes last, after Tasks', async () => {
      renderLeadPage([]);
      await screen.findByRole('tab', { name: 'Notes' });
      const names = screen.getAllByRole('tab').map((t) => (t.textContent ?? '').replace(/\s*\(\d+\)$/, '').trim());
      expect(names).toEqual(['Overview', 'Walkthrough', 'Estimates', 'Attachments', 'Communication', 'Tasks', 'Notes']);
    });

    it('lists the lead notes newest first with author, time ago and Delete only where the server allows it', async () => {
      noteRows = [
        note('old', 'Olga', '2026-08-01T12:00:00.000Z', { can_delete: true }),
        note('new', 'Nils', '2026-08-10T12:00:00.000Z'),
      ];
      renderLeadPage(['add_note']);
      await openNotesTab();
      await screen.findByText('Text of new');

      expect(screen.getByRole('heading', { name: /^Notes\s*\(2\)$/ })).toBeInTheDocument();
      expect(screen.getByText('(2)')).toBeInTheDocument();
      const texts = screen.getAllByText(/^Text of /).map((e) => e.textContent);
      expect(texts).toEqual(['Text of new', 'Text of old']);
      expect(screen.getByText('Nils Tester')).toBeInTheDocument();
      expect(screen.getAllByText(/ago$/)).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Delete note by Olga Tester' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Delete note by Nils Tester' })).not.toBeInTheDocument();
    });

    it('offers the Add note box only when the lead lists add_note', async () => {
      noteRows = [note('one', 'Nils', '2026-08-10T12:00:00.000Z')];
      const { unmount } = renderLeadPage(['add_note']);
      await openNotesTab();
      await screen.findByText('Text of one');
      expect(screen.getByText('Add note')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Note' })).toBeInTheDocument();
      unmount();

      renderLeadPage(['edit']);
      await openNotesTab();
      await screen.findByText('Text of one');
      expect(screen.queryByText('Add note')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument();
    });

    it('keeps the unsent text across a tab switch', async () => {
      renderLeadPage(['add_note']);
      const user = await openNotesTab();
      await user.type(await screen.findByRole('textbox', { name: 'Note' }), 'Gate code is 4410');

      await user.click(screen.getByRole('tab', { name: 'Tasks' }));
      await user.click(screen.getByRole('tab', { name: 'Notes' }));

      expect(await screen.findByRole('textbox', { name: 'Note' })).toHaveValue('Gate code is 4410');
      // Kept on the device against the lead (record type LEAD + id), not the job.
      expect(readDraft(draftStorageKey({ organizationId: 'org-1', userId: 'user-1', recordType: 'LEAD', recordId: LEAD_FIXTURE.id, field: 'notes-tab-note' })))
        .toBe('Gate code is 4410');
    });

    it('adds a note through the lead\'s own route', async () => {
      renderLeadPage(['add_note']);
      mockApi.post.mockResolvedValue({ data: { note: note('made', 'Me', '2026-08-11T12:00:00.000Z') } });
      const user = await openNotesTab();
      await user.type(await screen.findByRole('textbox', { name: 'Note' }), 'Called back');
      await user.click(screen.getByRole('button', { name: 'Add Note' }));

      expect(mockApi.post).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/notes`, { content: 'Called back' });
    });

    describe('Walkthrough notes', () => {
      const wt = (id: string, seq: number, extra: Record<string, unknown> = {}) => ({
        id, visit_seq: seq, status: 'SCHEDULED', scheduled_at: '2026-11-05T15:00:00.000Z', completed_at: null,
        cancelled_at: null, cancelled_reason: null, created_at: `2026-10-0${seq}T12:00:00.000Z`, notes: `Notes of ${seq}`,
        performers: [{ id: 'p1', first_name: 'Sam', last_name: 'Ortiz' }], can_write_notes: false, ...extra,
      });

      it('shows one card per walkthrough, newest first, cancelled ones with their notes and reason', async () => {
        history = [
          wt('w1', 1, { status: 'CANCELLED', cancelled_at: '2026-10-30T13:40:00.000Z', cancelled_reason: 'Customer not home' }),
          wt('w2', 2),
        ];
        renderLeadPage([]);
        await openNotesTab();
        expect(await screen.findByText('Walkthrough notes')).toBeInTheDocument();
        const titles = screen.getAllByText(/^Walkthrough \d$/).map((e) => e.textContent);
        expect(titles).toEqual(['Walkthrough 2', 'Walkthrough 1']);
        expect(screen.getByText('Notes of 1')).toBeInTheDocument();
        expect(screen.getByText(/^Cancelled .* · Customer not home$/)).toBeInTheDocument();
        expect(screen.getByText(/^Scheduled .* · Sam Ortiz$/)).toBeInTheDocument();
        expect(screen.queryByText(/visit notes/i)).not.toBeInTheDocument();
      });

      it('a card the person may not write has the text and no box and no Save', async () => {
        history = [wt('w1', 1)];
        renderLeadPage([]);
        await openNotesTab();
        await screen.findByText('Notes of 1');
        expect(screen.queryByRole('textbox', { name: 'Walkthrough 1 notes' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save Notes' })).not.toBeInTheDocument();
      });

      it('a writable card shows Save Notes once something is typed and saves through the walkthrough door', async () => {
        history = [wt('w1', 1, { can_write_notes: true })];
        mockApi.patch.mockResolvedValue({ data: {} });
        renderLeadPage([]);
        const user = await openNotesTab();
        const box = await screen.findByRole('textbox', { name: 'Walkthrough 1 notes' });
        expect(screen.queryByRole('button', { name: 'Save Notes' })).not.toBeInTheDocument();
        await user.type(box, ' more');
        await user.click(screen.getByRole('button', { name: 'Save Notes' }));
        expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/visits/w1/notes`, { notes: 'Notes of 1 more' });
      });
    });
  });
});
