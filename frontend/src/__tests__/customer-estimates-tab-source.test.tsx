import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import CustomerDetailPage from '@/pages/CustomerDetailPage';

const mockApi = vi.mocked(api);

const PRO_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling', 'leads'];
const STARTER_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments'];

/**
 * org_features is set EXPLICITLY, never omitted: useFeature fails OPEN while it is
 * undefined ("unknown is not denied"), so an omitted list would make the Starter
 * fixture look entitled and quietly void these assertions.
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

// The customer Estimates tab used to derive its rows from GET /api/leads
// (leads.flatMap(l => l.estimates)). Two defects fell out of that:
//
//  1. /api/leads sits behind requireFeature('leads') (Pro) while Estimates is
//     Starter core, so on a Starter org the request could only 402 and the tab
//     rendered "No estimates yet" for a customer that had estimates.
//  2. leadListSelect nests estimates as { id, total_amount } only, so even on
//     Pro the Estimate #, Status and Created columns rendered as em-dashes.
//
// The tab now reads GET /api/estimates?customer_id=, filtered on the direct
// Estimate.customer_id column (R6, NOT NULL) so lead-anchored, customer-anchored
// and job-anchored estimates all appear.

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const CUSTOMER = {
  id: CUSTOMER_ID,
  customer_number: 'C00001',
  first_name: 'Maria',
  last_name: 'Garcia',
  company_name: null,
  email: 'maria.garcia@example.com',
  extra_emails: [],
  phone: '4695550391',
  phone_ext: null,
  secondary_phone: null,
  secondary_phone_ext: null,
  ad_source: 'Google',
  allow_billing: false,
  tax_exempt: false,
  payment_type: null,
  notes: null,
  is_active: true,
  archived_at: null,
  created_at: '2026-04-01T00:00:00.000Z',
  service_locations: [],
  _count: { jobs: 0, leads: 1 },
  jobs: [],
  invoices: [],
};

const SUMMARY = {
  financials: {
    lifetime_revenue: 0,
    total_invoiced: 0,
    past_due_balance: 0,
    due_balance: 0,
    paid_invoice_count: 0,
    unpaid_invoice_count: 0,
  },
  // A direct COUNT over Estimate.customer_id — the tab trigger reads this, so it
  // is right on first paint without the Pro-gated leads query.
  estimates: { total: 2, pending: 1, approved: 1, total_value: 3400 },
  deposits: { collected: 0, pending: 0 },
};

// GET /api/estimates?customer_id= — the estimateListSelect shape.
const ESTIMATES = [
  {
    id: 'f0000000-0000-0000-0000-000000000001',
    estimate_number: 'E00002',
    status: 'WON',
    total_amount: '2400.00',
    created_at: '2026-05-10T00:00:00.000Z',
    // Lead-anchored: the originating request text fills the Service Request column.
    lead: { id: 'e0000000-0000-0000-0000-000000000001', service_request: 'AC condenser replacement' },
  },
  {
    id: 'f0000000-0000-0000-0000-000000000002',
    estimate_number: 'E00001',
    status: 'DRAFT',
    total_amount: '1000.00',
    created_at: '2026-05-01T00:00:00.000Z',
    // Customer-anchored (lead-less) — R6 relaxed Estimate.lead_id to optional.
    lead: null,
  },
];

/**
 * Route api.get by URL. `leads` decides what GET /api/leads does:
 *  - 'pro'     resolves with a lead payload (entitled org)
 *  - 'starter' rejects 402, exactly as requireFeature('leads') answers
 */
function mockApiGet(leads: 'pro' | 'starter') {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/estimates') return Promise.resolve({ data: { estimates: ESTIMATES } });
    if (url === '/api/leads') {
      if (leads === 'starter') {
        return Promise.reject(
          Object.assign(new Error('Payment Required'), {
            response: { status: 402, data: { error: 'feature_not_available', feature: 'leads' } },
          })
        );
      }
      return Promise.resolve({
        data: {
          leads: [
            {
              id: 'e0000000-0000-0000-0000-000000000001',
              lead_number: 'L00001',
              status: 'WON',
              service_request: 'AC condenser replacement',
              created_at: '2026-04-02T00:00:00.000Z',
              lead_assignees: [],
              // What leadListSelect actually nests: no number, status or date.
              estimates: [{ id: 'f0000000-0000-0000-0000-000000000001', total_amount: '2400.00' }],
            },
          ],
        },
      });
    }
    return Promise.resolve({ data: { customer: CUSTOMER, summary: SUMMARY } });
  });
}

async function openEstimatesTab() {
  const user = userEvent.setup();
  renderWithProviders(
    <Routes>
      <Route path="/customers/:id" element={<CustomerDetailPage />} />
    </Routes>,
    { initialEntries: [`/customers/${CUSTOMER_ID}`] }
  );
  await screen.findByRole('heading', { name: /Maria Garcia/ });
  await user.click(screen.getByRole('tab', { name: /estimates/i }));
  return screen.findByRole('tabpanel');
}

// Phase 11.6 - CustomerDetailPage moves from DetailPageShell to TabStrip.
// Pins the real page's rendered tab-strip markup byte-exact: no wrapper at
// all (the old `railWrapperClassName="border-b border-border"` was redundant
// with TabsList's own default `variant="line"` border, so it is dropped
// without a replacement) and the `underline-fill` triggers. `gap-0` from the
// old `listClassName` has no equivalent on TabStrip and is NOT reproduced -
// see this page's own comment above its `TabStrip` call - so this is not
// asserted as a no-op difference, only the axes that genuinely stayed the
// same are pinned here.
describe('CustomerDetailPage tab strip - TabStrip rendered contract', () => {
  const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

  it('renders no rail wrapper and underline-fill triggers', async () => {
    vi.clearAllMocks();
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    mockApiGet('pro');
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER_ID}`] }
    );
    await screen.findByRole('heading', { name: /Maria Garcia/ });

    const list = await screen.findByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');

    // No wrapper div: TabsList is the Tabs root's direct child, and the Tabs root
    // itself carries no className (no Card, no surface).
    const tabsRoot = list.parentElement as HTMLElement;
    expect(cls(tabsRoot)).toBe('');

    const estimatesTab = screen.getByRole('tab', { name: /estimates/i });
    expect(cls(estimatesTab)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group ' +
        'text-sm text-text-secondary font-medium hover:text-text-primary ' +
        'hover:bg-background-light/50 data-[state=active]:text-primary ' +
        'data-[state=active]:font-semibold flex-1 px-4'
    );
    // underline-fill wraps children in its own underline-bar span.
    expect(cls(estimatesTab.firstElementChild)).toBe(
      'relative inline-flex flex-col items-center py-3 after:absolute after:bottom-0 ' +
        'after:inset-x-0 after:h-0.5 after:rounded-full after:bg-transparent ' +
        'after:transition-colors group-data-[state=active]:after:bg-primary'
    );
  });
});

describe('CustomerDetailPage Estimates tab data source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFeatures(PRO_FEATURES, 'PRO');
  });

  // The real Starter shape once #1005 landed: `leads` is absent from org_features, so the
  // Leads trigger is hidden and the landing tab falls back to Estimates. Estimates must then
  // fetch off `effectiveTab` - keying the query on the raw `activeTab` (still 'leads' here)
  // would leave exactly this case unfetched.
  it('fetches and populates on the redirected landing tab of an unentitled org', async () => {
    mockOrgFeatures(STARTER_FEATURES, 'STARTER');
    mockApiGet('starter');
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER_ID}`] }
    );
    await screen.findByRole('heading', { name: /Maria Garcia/ });

    // Leads is hidden, and Estimates is selected without the user clicking anything.
    expect(screen.queryByRole('tab', { name: /leads/i })).not.toBeInTheDocument();
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('E00002');
    expect(within(panel).getByText('E00001')).toBeInTheDocument();

    // Nothing ever asked for leads.
    expect(mockApi.get.mock.calls.map(([url]) => url)).not.toContain('/api/leads');
  });

  it('populates on a Starter org, where /api/leads can only 402', async () => {
    mockApiGet('starter');
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER_ID}`] }
    );
    await screen.findByRole('heading', { name: /Maria Garcia/ });

    // Leads is the landing tab, so its (402-ing) query has already fired. Hiding
    // that tab for an unentitled org is issue #1004's job; what matters here is
    // that the Estimates tab does not ride on its result.
    const leadsCallsBefore = mockApi.get.mock.calls.filter(([url]) => url === '/api/leads').length;

    await user.click(screen.getByRole('tab', { name: /estimates/i }));
    const panel = await screen.findByRole('tabpanel');

    // Both estimates render despite the leads query having failed.
    await within(panel).findByText('E00002');
    expect(within(panel).getByText('E00001')).toBeInTheDocument();
    expect(within(panel).queryByText(/no estimates yet/i)).not.toBeInTheDocument();

    // Opening the tab hit /api/estimates and provoked no further leads request.
    const urls = mockApi.get.mock.calls.map(([url]) => url);
    expect(urls).toContain('/api/estimates');
    expect(urls.filter((url) => url === '/api/leads')).toHaveLength(leadsCallsBefore);
  });

  it('requests estimates by the direct customer_id anchor', async () => {
    mockApiGet('starter');
    await openEstimatesTab();

    const call = mockApi.get.mock.calls.find(([url]) => url === '/api/estimates');
    expect(call?.[1]).toMatchObject({ params: { customer_id: CUSTOMER_ID } });
  });

  it('renders the columns the leads-nested shape never carried', async () => {
    mockApiGet('pro');
    const panel = await openEstimatesTab();

    const row = (await within(panel).findByText('E00002')).closest('tr')!;
    // Estimate #, Status, Total and Created all resolve from the real estimate row.
    expect(within(row).getByText('AC condenser replacement')).toBeInTheDocument();
    expect(within(row).getByText('$2,400.00')).toBeInTheDocument();
    // Loose on the day so the assertion does not depend on the runner's timezone -
    // the point is that a real formatted date renders where an em-dash used to.
    expect(within(row).getByText(/May \d{1,2}, 2026/)).toBeInTheDocument();
    expect(within(row).queryByText('—')).not.toBeInTheDocument();
  });

  it('shows a dash for a lead-less estimate instead of crashing', async () => {
    mockApiGet('pro');
    const panel = await openEstimatesTab();

    const row = (await within(panel).findByText('E00001')).closest('tr')!;
    // No originating lead, so no service request — but the row still renders.
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).getByText('$1,000.00')).toBeInTheDocument();
  });

  it('counts estimates from the customer summary, not from the leads query', async () => {
    mockApiGet('starter');
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER_ID}`] }
    );

    // Correct on first paint, while still on the Leads tab and with no estimates
    // request in flight. The old count reduced over leads[].estimates and showed
    // "—" until that Pro-gated query resolved.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /estimates/i })).toHaveTextContent('2 estimates')
    );
  });
});
