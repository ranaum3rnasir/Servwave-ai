/**
 * Multi-visit spec slice S1, the lead-page half of the tracer bullet.
 *
 * A lead can now hold SEVERAL live visits at once (user story 7: pre-book the follow-up while
 * still on site for the first). The page has to show all of them, not just the one the legacy
 * flat `walkthrough_*` fields resolve to.
 *
 * Driven through the rendered page - what a user can actually read on screen - so it survives any
 * reshuffle of how the visit list is derived internally.
 *
 * Against the ROUTED page (`pages/v2/leads/LeadDetailPage`, what `/leads/:id` mounts). It used
 * to import the unrouted `pages/LeadDetailPage`, so S1 was being proved on a page no user could
 * open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));

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
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const FIRST_VISIT = {
  id: 'v-1',
  status: 'SCHEDULED',
  scheduled_at: '2026-09-01T14:00:00.000Z',
  duration_minutes: 60,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-08-20T10:00:00.000Z',
};

const SECOND_VISIT = {
  ...FIRST_VISIT,
  id: 'v-2',
  scheduled_at: '2026-09-08T14:00:00.000Z',
  created_at: '2026-08-20T11:00:00.000Z',
};

function mockLeadWithVisits(visits: Array<Record<string, unknown>>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/leads/')) {
      return {
        data: {
          lead: {
            ...LEAD_FIXTURE,
            status: 'CONTACTED',
            // The legacy flat fields still describe the CURRENT (earliest live) visit.
            walkthrough_scheduled_at: visits[0]?.scheduled_at ?? null,
            walkthrough_completed_at: null,
            walkthrough_cancelled_at: null,
            walkthrough_count: visits.length,
            walkthrough_history: visits,
          },
        },
      };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 LeadDetailPage - a lead holding several live visits (S1)', () => {
  it('counts every visit, including a second live one', async () => {
    mockLeadWithVisits([FIRST_VISIT, SECOND_VISIT]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    // The visit list lives in the Walkthrough tab, which mounts its content only once active.
    await userEvent.click(await screen.findByRole('tab', { name: /walkthrough/i }));

    expect(await screen.findByText(/2 Visits Total/i)).toBeInTheDocument();
  });

  it('lists the SECOND live visit behind the disclosure, not only the current one', async () => {
    // The defect this guards: the history filter dropped every SCHEDULED row whenever the
    // current visit was itself scheduled, which under the old one-live-visit invariant removed
    // exactly the row already shown above - and under multi-visit hides real, booked trips.
    mockLeadWithVisits([FIRST_VISIT, SECOND_VISIT]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    // The visit list lives in the Walkthrough tab, which mounts its content only once active.
    await userEvent.click(await screen.findByRole('tab', { name: /walkthrough/i }));

    await userEvent.click(await screen.findByText(/2 Visits Total/i));

    // Sep 8 is the second booking; it must be readable somewhere on the page.
    expect(await screen.findByText(/Sep 8, 2026/i)).toBeInTheDocument();
    // ...and it must NOT report "No earlier visits", which is what the old filter produced.
    expect(screen.queryByText(/No earlier visits/i)).not.toBeInTheDocument();
  });
});
