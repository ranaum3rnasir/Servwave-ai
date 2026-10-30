/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 6, slice S06.31 - the routed v2 sidebar's Jobs entry carries the office review queue count.
 *
 * The count is the server's answer (`GET /api/jobs/review-queue`): jobs in Office review for a holder of Office review,
 * jobs Ready to close for a holder of Close jobs, within the person's reach. The sidebar only draws it in the row's
 * existing count slot, and asks for it only when the person's switches say they could hold a queue. Any job action
 * refreshes it through the same `jobs` queries the action already refreshes.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { emptyAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const mockApi = vi.mocked(api);

const USER_ID = '00000000-0000-0000-0000-000000000002';
const QUEUE_ROUTE = '/api/jobs/review-queue';

const USER = {
  id: USER_ID,
  email: 'person@test.com',
  first_name: 'Test',
  last_name: 'Person',
  role: 'DISPATCHER',
  org_features: ['leads', 'service_plans', 'automations', 'inventory', 'phone', 'email'],
};

/** The Jobs entry shows with View jobs; the queue switches ride on top. */
const JOBS = { view_jobs: true };

/** What the server answers the two reads with, changeable between renders. */
let queueAnswer: Record<string, number>;

function answer(values: Record<string, boolean>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values, rules: [] } };
    if (url === QUEUE_ROUTE) return { data: queueAnswer };
    return { data: {} };
  });
}

function renderShell() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user: USER, isAuthenticated: true, isLoading: false, error: null } as never),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={emptyAbility}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** The Jobs row of the sidebar. */
const jobsRow = () => document.querySelector('[data-slot="sidebar-item"][title="Jobs"]');
const countOf = (row: Element | null) => row?.querySelector('.sb-count')?.textContent ?? null;
const queueAsked = () => mockApi.get.mock.calls.some(([url]) => url === QUEUE_ROUTE);

describe('v2 sidebar - the Jobs entry carries the office review queue count', () => {
  beforeEach(() => {
    localStorage.clear();
    mockApi.get.mockReset();
    queueAnswer = { total: 0 };
  });

  it('shows the server total in the Jobs row for a holder of Office review', async () => {
    queueAnswer = { office_review: 4, total: 4 };
    answer({ ...JOBS, office_review: true });
    renderShell();

    await waitFor(() => expect(countOf(jobsRow())).toBe('4'));
  });

  it('shows the sum the server sends for a holder of both switches', async () => {
    queueAnswer = { office_review: 3, ready_to_close: 2, total: 5 };
    answer({ ...JOBS, office_review: true, close_jobs: true });
    renderShell();

    await waitFor(() => expect(countOf(jobsRow())).toBe('5'));
  });

  it('asks for the count for a holder of Close jobs alone', async () => {
    queueAnswer = { ready_to_close: 2, total: 2 };
    answer({ ...JOBS, close_jobs: true });
    renderShell();

    await waitFor(() => expect(countOf(jobsRow())).toBe('2'));
  });

  it('draws no count when the queue is empty', async () => {
    queueAnswer = { office_review: 0, total: 0 };
    answer({ ...JOBS, office_review: true });
    renderShell();

    await waitFor(() => expect(queueAsked()).toBe(true));
    await waitFor(() => expect(jobsRow()).not.toBeNull());
    await act(async () => {});
    expect(countOf(jobsRow())).toBeNull();
  });

  it('caps a long queue at 99+', async () => {
    queueAnswer = { office_review: 140, total: 140 };
    answer({ ...JOBS, office_review: true });
    renderShell();

    await waitFor(() => expect(countOf(jobsRow())).toBe('99+'));
  });

  it('does not ask for the count, and draws none, for a person who holds neither switch', async () => {
    queueAnswer = { office_review: 9, total: 9 };
    answer({ ...JOBS, complete_jobs: true });
    renderShell();

    await waitFor(() => expect(jobsRow()).not.toBeNull());
    await act(async () => {});
    expect(queueAsked()).toBe(false);
    expect(countOf(jobsRow())).toBeNull();
  });

  it('reads the count again when the job queries are refreshed, as every job action does', async () => {
    queueAnswer = { office_review: 2, total: 2 };
    answer({ ...JOBS, office_review: true });
    const { client } = renderShell();
    await waitFor(() => expect(countOf(jobsRow())).toBe('2'));

    // A review is finished somewhere in this browser: the action refreshes the `jobs` queries.
    queueAnswer = { office_review: 1, total: 1 };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['jobs'] });
    });

    await waitFor(() => expect(countOf(jobsRow())).toBe('1'));
  });

  it('keeps the Jobs row itself when the person has no count to show', async () => {
    answer({ ...JOBS });
    renderShell();

    await waitFor(() => expect(screen.getAllByText('Jobs').length).toBeGreaterThan(0));
  });
});
