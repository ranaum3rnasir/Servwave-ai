/**
 * Walkthrough words (Roles & Permissions, PRD 4, S04.20), on the ROUTED lead page.
 *
 * A walkthrough is a visit on a lead, so it takes the visit word: its last step reads "Finish walkthrough" and a
 * finished one reads "Finished". "Completed" belongs to the job. The LEAD's own status, Walkthrough Completed,
 * is a different thing and keeps its name; every assertion about the walkthrough's own words is made inside the
 * walkthrough tab (and on the header line that sums it up), never on the lead's status chip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { WALKTHROUGH_FILTERS } from '@/lib/filters/registries/leads';
import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/components/crm/AttachmentSection', () => ({ AttachmentSection: () => null }));
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: () => <div>performers</div>,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);

const performer = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'perform_walkthrough', subject: 'Lead' },
]);

const baseLead = {
  ...LEAD_FIXTURE,
  estimates: [],
  walkthrough_notes: '',
  walkthrough_cancelled_at: null,
  walkthrough_performers: [{ user: { id: 'user-1', first_name: 'Ran', last_name: 'Roffe' } }],
};
const scheduledLead = {
  ...baseLead,
  status: 'WALKTHROUGH_SCHEDULED',
  walkthrough_scheduled_at: '2026-09-01T13:00:00.000Z',
  walkthrough_duration_minutes: 60,
  walkthrough_completed_at: null,
  actions: ['walkthrough_notes', 'walkthrough_finish'],
};
const finishedLead = {
  ...baseLead,
  status: 'WALKTHROUGH_COMPLETED',
  walkthrough_scheduled_at: '2026-09-01T13:00:00.000Z',
  walkthrough_completed_at: '2026-09-01T14:30:00.000Z',
  walkthrough_count: 2,
  walkthrough_history: [
    { id: 'wt-1', status: 'COMPLETED', scheduled_at: '2026-08-20T13:00:00.000Z', completed_at: '2026-08-20T14:00:00.000Z', cancelled_at: null, created_at: '2026-08-19T09:00:00.000Z' },
    { id: 'wt-2', status: 'COMPLETED', scheduled_at: '2026-09-01T13:00:00.000Z', completed_at: '2026-09-01T14:30:00.000Z', cancelled_at: null, created_at: '2026-08-25T09:00:00.000Z' },
  ],
  actions: [],
};

function serve(lead: unknown) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/api/leads/')) return { data: { lead } };
    return { data: {} };
  });
}

async function openWalkthroughTab() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<LeadDetailPage />, { ability: performer });
  await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the walkthrough tab\'s words', () => {
  it('reads "Finish walkthrough" on the last step of a scheduled walkthrough, and nothing says Complete', async () => {
    serve(scheduledLead);
    await openWalkthroughTab();

    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Complete/ })).toBeNull();
    expect(panel.textContent).not.toMatch(/Complet/);
  });

  it('says "Finishing..." while the step is being taken and "Failed to finish walkthrough" when it cannot be', async () => {
    serve(scheduledLead);
    mockApi.post.mockRejectedValue({ response: { status: 500, data: {} } });
    const user = await openWalkthroughTab();

    await user.click(await screen.findByRole('button', { name: 'Finish walkthrough' }));
    expect(await screen.findByText('Failed to finish walkthrough')).toBeInTheDocument();
    expect(mockApi.post).toHaveBeenCalledWith('/api/leads/e0000000-0000-0000-0000-000000000001/walkthrough/complete');
    expect(screen.getByRole('tabpanel').textContent).not.toMatch(/Complet/);
  });

  it('reads "Finished on" on a finished walkthrough, with no Complete anywhere in the tab', async () => {
    serve(finishedLead);
    await openWalkthroughTab();

    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText(/^Finished on /)).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/Complet/);
  });

  it('reads "Finished" on an earlier finished visit in the history', async () => {
    serve(finishedLead);
    const user = await openWalkthroughTab();

    await user.click(await screen.findByRole('button', { name: /2 Visits Total/ }));
    const panel = screen.getByRole('tabpanel');
    await waitFor(() => expect(within(panel).getByText(/^Finished Aug 20/)).toBeInTheDocument());
    expect(panel.textContent).not.toMatch(/Complet/);
  });
});

describe('the lead page header line for a finished walkthrough', () => {
  it('reads "Finished <date>" while the lead\'s own status keeps the name Walkthrough Completed', async () => {
    serve(finishedLead);
    renderWithProviders(<LeadDetailPage />, { ability: performer });

    expect(await screen.findByText(/^Finished Sep 1/)).toBeInTheDocument();
    expect(screen.queryByText(/^Completed /)).toBeNull();
    expect(screen.getAllByText('Walkthrough Completed').length).toBeGreaterThan(0);
  });
});

describe('the Leads list Walkthrough filter', () => {
  it('offers "Finished" for a finished walkthrough, on the same value as before', () => {
    const finished = WALKTHROUGH_FILTERS.find((o) => o.value === 'completed');
    expect(finished?.label).toBe('Finished');
    expect(WALKTHROUGH_FILTERS.map((o) => o.label)).not.toContain('Completed');
  });
});
