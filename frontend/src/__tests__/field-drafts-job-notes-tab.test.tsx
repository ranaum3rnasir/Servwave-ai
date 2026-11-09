import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildAbility } from '@/lib/ability';
import { useAuthStore, type User } from '@/stores/auth.store';
import { ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { JOB_ID, renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import api from '@/lib/axios';
import { draftStorageKey, readDraft } from '@/lib/drafts/fieldDraftStore';

stubBrowser();

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

stubBrowser();

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const mockApi = vi.mocked(api);

const ORG = 'org-aaaa';

const JOB = {
  id: JOB_ID, job_number: 'J00001', status: 'IN_PROGRESS', scope_notes: null, estimated_duration: null,
  completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null, completed_at: null,
  cancelled_at: null, cancelled_reason: null, created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
  assignees: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS, source_plan: null,
};

function setUser(id: string) {
  const user = { id, organization_id: ORG } as User;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

const tabKey = (userId: string) =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'JOB', recordId: JOB_ID, field: 'notes-tab-note' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setUser('user-tech');
  serveJobDetail({
    job: JOB,
    routes: [
      { match: (url) => url.includes('/notes'), data: { notes: [] } },
    ],
  });
});

describe('job page Notes tab', () => {
  it('keeps a note typed in the tab across a tab switch, restored with "Draft restored"', async () => {
    const user = userEvent.setup();
    renderJobDetail({ ability: adminAbility });

    await user.click(await screen.findByRole('tab', { name: 'Notes' }));
    await user.type(await screen.findByLabelText('Note'), 'Replaced both hinges, door still rubs');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();

    // Switching tabs unmounts the Notes panel.
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByLabelText('Note')).not.toBeInTheDocument();
    expect(readDraft(tabKey('user-tech'))).toBe('Replaced both hinges, door still rubs');

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(await screen.findByLabelText('Note')).toHaveValue('Replaced both hinges, door still rubs');
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
  });

  it('adding the note clears the draft', async () => {
    mockApi.post.mockResolvedValue({ data: { note: { id: 'n1' } } });
    const user = userEvent.setup();
    renderJobDetail({ ability: adminAbility });

    await user.click(await screen.findByRole('tab', { name: 'Notes' }));
    await user.type(await screen.findByLabelText('Note'), 'done');
    await user.click(screen.getByRole('button', { name: 'Add Note' }));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/notes`, { content: 'done' });
    await vi.waitFor(() => expect(readDraft(tabKey('user-tech'))).toBeNull());
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });

  it("does not show another user's draft", async () => {
    const user = userEvent.setup();
    const first = renderJobDetail({ ability: adminAbility });
    await user.click(await screen.findByRole('tab', { name: 'Notes' }));
    await user.type(await screen.findByLabelText('Note'), "first user's private note");
    first.unmount();
    expect(readDraft(tabKey('user-tech'))).toBe("first user's private note");

    setUser('user-other');
    renderJobDetail({ ability: adminAbility });
    await user.click(await screen.findByRole('tab', { name: 'Notes' }));
    expect(await screen.findByLabelText('Note')).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });
});
