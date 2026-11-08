// Regression: a higher-plan module must never take away a module the org HAS.
//
// Reported against a real Pro org (Stripe Test Plumbing, plan PRO, no `inventory`):
// approving an estimate and converting it to a job landed on /jobs/:id, which mounted
// the Scale-only inventory cost rollup. That 402'd, and the axios interceptor's
// blanket `window.location.href = '/upgrade'` tore the user off the job page entirely
// - "Inventory requires Scale" blocking Jobs, which Pro includes.
//
// Two independent regressions are pinned here:
//   1. No /api/inventory/* request is made at all without the entitlement.
//   2. The Logistics tab (pure inventory surface) is not offered.
// The interceptor half is covered separately in src/lib/handle402.test.ts.
//
// The user is an ADMIN with `manage all` ON PURPOSE: CASL cannot express this gate
// (defineAbilityFor short-circuits every admin to a superuser), so an admin is
// exactly the case that used to slip through.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/components/inventory/lo/LOList', () => ({
  LOList: () => <div data-testid="lolist" />,
}));
vi.mock('@/components/jobs/JobStagesSection', () => ({
  JobStagesSection: () => <div data-testid="job-stages" />,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const BASE_JOB = {
  id: JOB_ID,
  job_number: 'J00042',
  status: 'UNSCHEDULED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  tags: [],
  source_plan_id: null,
  source_plan: null,
};

/**
 * org_features is set EXPLICITLY on every fixture below, never omitted: useFeature
 * fails OPEN while it is undefined ("unknown ≠ denied", so a cached pre-entitlements
 * payload cannot grey out a paid org). Omitting it would make an unentitled fixture
 * look entitled and quietly void these assertions.
 */
function mockOrgFeatures(features: string[], plan: string) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_plan: plan,
        org_features: features,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

const PRO_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling', 'leads'];
const SCALE_FEATURES = [...PRO_FEATURES, 'inventory'];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/scopes')) {
      return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    }
    if (url.endsWith('/line-items')) {
      return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    }
    if (url.includes('/api/jobs/')) {
      return { data: { job: BASE_JOB } };
    }
    return { data: {} };
  });
});

describe('JobDetailPage - a Scale module must not degrade a Pro-included one', () => {
  it('makes no /api/inventory request on a PRO org (the 402 that ejected the user)', async () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    // The job itself still loads - Jobs is in their plan and stays fully usable.
    expect(await screen.findByRole('tab', { name: /Overview/ })).toBeInTheDocument();

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    const inventoryCalls = mockApi.get.mock.calls.filter(([url]) =>
      String(url).includes('/api/inventory'),
    );
    expect(inventoryCalls).toEqual([]);
  });

  it('does not offer the Logistics tab on a PRO org', async () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    // Jobs' own tabs are untouched - this hides one module, it does not degrade the page.
    expect(await screen.findByRole('tab', { name: /Overview/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Items/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Logistics/ })).not.toBeInTheDocument();
  });

  // Also the sensitivity check for the two assertions above: it proves the inventory
  // request and the Logistics tab are genuinely reachable in this harness, so their
  // absence on PRO is the gate working rather than the fixture never wiring them up.
  it('still fetches inventory and offers Logistics on a SCALE org', async () => {
    mockOrgFeatures(SCALE_FEATURES, 'SCALE');
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('tab', { name: /Logistics/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        mockApi.get.mock.calls.filter(([url]) => String(url).includes('/api/inventory')),
      ).not.toEqual([]),
    );
  });
});
