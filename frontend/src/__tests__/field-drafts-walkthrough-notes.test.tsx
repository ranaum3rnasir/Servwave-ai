/**
 * Mobile slice 66: walkthrough notes on the lead page survive a tab switch.
 *
 * The Walkthrough panel unmounts when another tab is chosen, and its notes used to live in
 * component state seeded from the saved lead, so a half-typed note was gone on coming back. The
 * notes now go through the one draft hook (with the lead's saved notes as its baseline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import { buildAbility } from '@/lib/ability';
import { useAuthStore, type User } from '@/stores/auth.store';
import { draftStorageKey, readDraft } from '@/lib/drafts/fieldDraftStore';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const ORG = 'org-aaaa';

function setUser(id: string) {
  const user = { id, organization_id: ORG } as User;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

const notesKey = (userId: string) =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'LEAD', recordId: LEAD_ID, field: 'walkthrough_notes' });

function mockLead(walkthroughNotes: string | null) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return {
        data: {
          lead: {
            ...LEAD_FIXTURE,
            status: 'CONTACTED',
            walkthrough_scheduled_at: '2026-03-01T15:00:00.000Z',
            walkthrough_duration_minutes: 60,
            walkthrough_completed_at: null,
            walkthrough_notes: walkthroughNotes,
            walkthrough_performers: [
              { user: { id: '00000000-0000-0000-0000-000000000004', first_name: 'Test', last_name: 'Tech' } },
            ],
          },
        },
      };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

async function openWalkthrough(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('tab', { name: /Walkthrough/ }));
  return screen.findByPlaceholderText('Walkthrough notes...');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setUser('user-tech');
  mockLead(null);
});

describe('lead Walkthrough notes', () => {
  it('keeps notes typed in the tab across a tab switch, restored with "Draft restored"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const notes = await openWalkthrough(user);
    await user.type(notes, 'Unit is on the roof; access via the south stairwell.');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();

    // Switching tabs unmounts the Walkthrough panel.
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.queryByPlaceholderText('Walkthrough notes...')).not.toBeInTheDocument();
    expect(readDraft(notesKey('user-tech'))).toBe('Unit is on the roof; access via the south stairwell.');

    const back = await openWalkthrough(user);
    expect(back).toHaveValue('Unit is on the roof; access via the south stairwell.');
    expect(within(screen.getByRole('status')).getByText('Draft restored')).toBeInTheDocument();
    // Still unsaved, so the Save Notes control is still offered.
    expect(screen.getByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
  });

  it('opens on the lead\'s saved notes, which are not a draft', async () => {
    mockLead('Gate code is 4417');
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const notes = await openWalkthrough(user);
    expect(notes).toHaveValue('Gate code is 4417');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Notes/ })).not.toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('an edit to saved notes survives a tab switch and comes back as the edited text', async () => {
    mockLead('Gate code is 4417');
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const notes = await openWalkthrough(user);
    await user.type(notes, ' and the dog is friendly');
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    const back = await openWalkthrough(user);
    expect(back).toHaveValue('Gate code is 4417 and the dog is friendly');
    expect(screen.getByText('Draft restored')).toBeInTheDocument();
  });

  it('saving the notes clears the draft', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const notes = await openWalkthrough(user);
    await user.type(notes, 'Done and dusted');
    await user.click(screen.getByRole('button', { name: /Save Notes/ }));
    expect(mockApi.post).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/walkthrough`, {
      walkthrough_notes: 'Done and dusted',
    });
    await waitFor(() => expect(readDraft(notesKey('user-tech'))).toBeNull());
    expect(hasUnsavedWork()).toBe(false);
  });

  it("does not show another user's draft", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await user.type(await openWalkthrough(user), "first user's private note");
    first.unmount();

    setUser('user-other');
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    expect(await openWalkthrough(user)).toHaveValue('');
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });
});
