/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.22 - a saved sidebar shortcut follows the menu in the routed v2 shell.
 *
 * The person's saved layout (the pinned keys in their browser) can name pages their switches now hide, including a
 * pinned report and the top-level Price Book entry. A hidden page's shortcut is not drawn, and it is drawn again when
 * its switches come back, with the saved layout untouched. Every person holds an EMPTY ability, so only their switches
 * can be what decides an entry.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { emptyAbility } from '@/lib/ability';
import { CURRENT_LAYOUT_VERSION } from '@/components/layout/nav-registry';
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
const USER_ID = '00000000-0000-0000-0000-000000000001';

const ORG_USER = {
  id: USER_ID,
  email: 'person@test.com',
  first_name: 'Test',
  last_name: 'Person',
  role: 'TECHNICIAN',
  org_features: ['leads', 'service_plans', 'automations', 'inventory', 'phone', 'email'],
};

/** What the person pinned: the Dashboard, a job list, Billing, the top-level Price Book and two pinned reports. */
const SAVED_LAYOUT = ['dashboard', 'jobs', 'billing', 'pricebook', 'rpt-revenue', 'rpt-job-profit'];

function on(...keys: string[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((key) => [key, true]));
}

function answerMe(values: Record<string, boolean>) {
  mockApi.get.mockImplementation(async (url: string) =>
    url === '/api/permission-switches/me' ? { data: { admin_box: false, values, rules: [] } } : { data: {} });
}

function renderShell() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user: ORG_USER, isAuthenticated: true, isLoading: false, error: null } as never),
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

/** Every destination row's label, in the order the column renders them. */
function menu(): string[] {
  const nav = document.querySelector('[data-slot="sidebar-nav"]');
  return Array.from(nav?.querySelectorAll('[data-slot="sidebar-item"]') ?? []).map(
    (row) => row.getAttribute('title') ?? '',
  );
}

async function drawn(...entries: string[]) {
  await waitFor(() => expect([...menu()].sort()).toEqual(['Dashboard', ...entries].sort()));
}

describe('v2 sidebar - saved shortcuts follow the menu', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(`servwave:nav-layout:${USER_ID}`, JSON.stringify(SAVED_LAYOUT));
    localStorage.setItem(`servwave:nav-layout-version:${USER_ID}`, String(CURRENT_LAYOUT_VERSION));
    mockApi.get.mockReset();
  });

  it('draws no shortcut to a page the person cannot see', async () => {
    // Only the Revenue report's Access is on: Jobs, Billing, Price Book and the other report are all hidden.
    answerMe(on('access_reports'));
    renderShell();
    await drawn('Revenue', 'Job Profitability');
    expect(menu()).not.toContain('Jobs');
    expect(menu()).not.toContain('Billing');
    expect(menu()).not.toContain('Price Book');
  });

  it('draws a saved shortcut to a record page only with its View on', async () => {
    answerMe(on('access_billing'));
    const first = renderShell();
    await drawn('Billing');
    first.unmount();
    localStorage.clear();
    localStorage.setItem(`servwave:nav-layout:${USER_ID}`, JSON.stringify(SAVED_LAYOUT));
    localStorage.setItem(`servwave:nav-layout-version:${USER_ID}`, String(CURRENT_LAYOUT_VERSION));

    answerMe(on('view_jobs', 'access_billing'));
    renderShell();
    await drawn('Jobs', 'Billing');
  });

  it('draws the shortcut again when its page shows again, with the saved layout untouched', async () => {
    answerMe(on('access_billing'));
    const { client } = renderShell();
    await drawn('Billing');

    await act(async () => {
      client.setQueryData(['permission-switches', 'me', USER_ID], {
        admin_box: false,
        values: on('access_billing', 'view_jobs', 'access_reports'),
      });
    });
    await drawn('Jobs', 'Billing', 'Revenue', 'Job Profitability');
    expect(JSON.parse(localStorage.getItem(`servwave:nav-layout:${USER_ID}`) ?? '[]')).toEqual(SAVED_LAYOUT);
  });

  it('draws a saved Price Book shortcut on View price book, and not without it', async () => {
    answerMe(on('access_billing'));
    const without = renderShell();
    await drawn('Billing');
    without.unmount();
    localStorage.clear();
    localStorage.setItem(`servwave:nav-layout:${USER_ID}`, JSON.stringify(SAVED_LAYOUT));
    localStorage.setItem(`servwave:nav-layout-version:${USER_ID}`, String(CURRENT_LAYOUT_VERSION));

    answerMe(on('view_price_book', 'access_billing'));
    renderShell();
    await drawn('Billing', 'Price Book');
  });

  it('keeps a saved Price Book shortcut hidden when the rest of Inventory is on without it', async () => {
    answerMe(on('view_stock', 'view_vendors', 'access_billing'));
    renderShell();
    await drawn('Billing');
    expect(menu()).not.toContain('Price Book');
  });
});
