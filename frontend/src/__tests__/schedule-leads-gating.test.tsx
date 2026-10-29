// SRVW-102 - the schedule must not make a positively FALSE claim about rows it never fetched.
//
// /api/leads sits behind requireFeature('leads') (PRO), while Scheduling is Starter core, so
// useScheduleData disables both lead queries for a Starter org. The Unassigned sidebar then
// rendered a Walkthroughs bucket with count 0 and the copy "Nothing here - all Walkthroughs
// are scheduled." over a query that never ran. Staging held Starter orgs with 16, 5 and 1
// REQUESTED walkthroughs while that bucket claimed all of them were scheduled.
//
// The fix is HIDE, not hint: useModuleAccess.ts:18-21 is the shipped policy - a host surface
// hides a higher-plan widget, and the nav lock plus <RequireFeature> stay the only places a
// user is told to upgrade.
//
// Two tests below render an ADMIN `manage all` ability ON PURPOSE: CASL cannot express the
// entitlement axis (defineAbilityFor short-circuits every admin to a superuser), so an admin
// is exactly the case that slips through a bare ability.can() check.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';

const mockApi = vi.mocked(api);

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
// The SALES / TECHNICIAN shape: defaultGrants.ts grants `read ServicePlan` to DISPATCHER only
// (ADMIN passes via manage-all), so neither role can read a service plan even on a paid SCALE org.
const NO_READ_SERVICE_PLAN = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Lead' },
  { action: 'read', subject: 'Department' },
]);

const STARTER_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling'];
const PAID_FEATURES = [...STARTER_FEATURES, 'leads', 'service_plans'];

/**
 * org_features is set EXPLICITLY on every fixture: useFeature fails OPEN while it is
 * undefined ("unknown != denied"), and setup.ts's default auth-store user carries none.
 * Omitting it would make an unentitled fixture look entitled and void these assertions.
 */
function mockOrgFeatures(features: string[], plan: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') {
      return Promise.resolve({ data: { plans: [] } });
    }
    return Promise.resolve({ data: {} });
  });
});

describe('SchedulePage - lead-derived surfaces are hidden, never falsely explained', () => {
  it('STARTER org - no /api/leads request, no Walkthroughs bucket, and no "all scheduled" claim', async () => {
    mockOrgFeatures(STARTER_FEATURES, 'STARTER');
    renderWithProviders(<SchedulePage />, { ability: ADMIN });

    // The page itself still works - Scheduling is in their plan.
    expect(await screen.findByText('Jobs')).toBeInTheDocument();

    const leadCalls = mockApi.get.mock.calls.filter(([url]) => String(url).includes('/api/leads'));
    expect(leadCalls).toEqual([]);

    expect(screen.queryByText('Walkthroughs')).not.toBeInTheDocument();
    expect(screen.queryByText(/all Walkthroughs are scheduled/)).not.toBeInTheDocument();
    // Service Plans is PRO too - an unpaid module is hidden, never misreported as unbuilt.
    expect(screen.queryByText(/Recurring visits land here/)).not.toBeInTheDocument();
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
  });

  it('the Service Plans bucket also disappears for a user who cannot read ServicePlan, on a FULLY-ENTITLED org', async () => {
    mockOrgFeatures(PAID_FEATURES, 'SCALE');
    renderWithProviders(<SchedulePage />, { ability: NO_READ_SERVICE_PLAN });

    expect(await screen.findByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Walkthroughs')).toBeInTheDocument();

    expect(screen.queryByText('Service Plans')).not.toBeInTheDocument();
    expect(screen.queryByText(/soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recurring visits land here/)).not.toBeInTheDocument();
  });

  // Sensitivity control for both tests above.
  it('control - a paid org with an admin ability still gets both buckets and still calls /api/leads', async () => {
    mockOrgFeatures(PAID_FEATURES, 'PRO');
    renderWithProviders(<SchedulePage />, { ability: ADMIN });

    expect(await screen.findByText('Jobs')).toBeInTheDocument();
    expect(screen.getByText('Walkthroughs')).toBeInTheDocument();
    expect(screen.getByText('Service Plans')).toBeInTheDocument();

    const leadCalls = mockApi.get.mock.calls.filter(([url]) => String(url).includes('/api/leads'));
    expect(leadCalls.length).toBeGreaterThan(0);
  });
});
