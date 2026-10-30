/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions - the sidebar and the job page's customer block read the person's own switches through one
 * reader, so a screen holding both asks the server once and both draw from the same answer.
 *
 * The routed v2 shell renders the sidebar; the customer card is the block on the job page that draws from the
 * switches (the contact display policy).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { CustomerContactCard } from '@/components/jobs/overview/CustomerContactCard';

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

const JOB = {
  id: 'b0000000-0000-0000-0000-000000000001',
  job_number: 'J00042',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Daniel',
    last_name: 'Cohen',
    company_name: null,
    email: 'daniel@example.test',
    phone: '5551234567',
  },
  service_location: null,
};

function meRequests(): number {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/permission-switches/me').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') {
      return { data: { admin_box: false, values: { access_schedule: true, view_customers: true } } };
    }
    return { data: { items: [] } };
  });
});

describe('one reader of the person\'s own switches', () => {
  it('a screen with the sidebar and the job customer block asks for the answer once', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <AbilityProvider ability={buildAbility([{ action: 'read', subject: 'Communication' }])}>
            <Routes>
              <Route element={<V2AppLayout />}>
                <Route path="/" element={<CustomerContactCard job={JOB} />} />
              </Route>
            </Routes>
          </AbilityProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Both consumers are on screen: the block drew the customer, and the menu drew the entry the answer switches on.
    expect(await screen.findByText('(555) 123-4567')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-slot="sidebar-item"][title="Schedule"]')).not.toBeNull());

    expect(meRequests()).toBe(1);
  });
});
