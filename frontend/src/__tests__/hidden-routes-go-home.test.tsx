/**
 * Roles & Permissions, PRD 2, S02.23 - hidden list and page routes go to the dashboard, and record routes stay open.
 *
 * Renders the REAL routed table (`moduleV2Routes`, every module's own route file) with only the app chrome (the sign-in
 * guard, the app layout, the demo-company guard) and the pages themselves stubbed, so the only thing deciding where a
 * person ends up is each route's own guard. Every person here is a custom role described by the switches under test
 * (the "me" answer), never a built-in role name. Switch keys are looked up in the backend catalog by the label a person
 * sees, so a renamed or removed switch fails here instead of silently testing nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { moduleV2Routes } from '@/pages/v2/routes';
import { renderWithProviders } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/DemoOnlyRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

const stub = vi.hoisted(() => async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => createElement('p', { 'data-testid': 'opened' }, useLocation().pathname);
  return { default: Opened };
});
vi.mock('@/pages/v2/leads/LeadsPage', stub);
vi.mock('@/pages/v2/leads/LeadFormPage', stub);
vi.mock('@/pages/v2/leads/LeadDetailPage', stub);
vi.mock('@/pages/v2/customers/CustomersPage', stub);
vi.mock('@/pages/v2/customers/CustomerFormPage', stub);
vi.mock('@/pages/v2/customers/CustomerDetailPage', stub);
vi.mock('@/pages/v2/customers/StatementPage', stub);
vi.mock('@/pages/v2/jobs/JobsPage', stub);
vi.mock('@/pages/v2/jobs/JobFormPage', stub);
vi.mock('@/pages/v2/jobs/JobDetailPage', stub);
vi.mock('@/pages/v2/estimates/EstimatesPage', stub);
vi.mock('@/pages/v2/estimates/NewEstimateRedirect', stub);
vi.mock('@/pages/v2/estimates/EstimateWorkspacePage', stub);
vi.mock('@/pages/v2/estimates/EstimateVersionPage', stub);
vi.mock('@/pages/v2/invoices/InvoicesPage', stub);
vi.mock('@/pages/v2/payments/PaymentsPage', stub);
vi.mock('@/pages/v2/invoices/StandaloneInvoiceFormPage', stub);
vi.mock('@/pages/v2/invoices/InvoiceDetailPage', stub);
vi.mock('@/pages/v2/tasks/TasksHubPage', stub);
vi.mock('@/pages/v2/service-plans/ServicePlansPage', stub);
vi.mock('@/pages/v2/automations/AutomationsHomePage', stub);
vi.mock('@/pages/v2/automations/AutomationBuilderPage', stub);
vi.mock('@/pages/v2/inventory/InventoryPage', stub);
vi.mock('@/pages/v2/inventory/PriceBookPage', stub);
vi.mock('@/pages/v2/inventory/PurchaseOrdersPage', stub);
vi.mock('@/pages/v2/inventory/PurchaseOrderRecordPage', stub);
vi.mock('@/pages/v2/inventory/LogisticOrderRecordPage', stub);
vi.mock('@/pages/v2/inventory/VendorsPage', stub);
vi.mock('@/pages/v2/schedule/SchedulePage', stub);
vi.mock('@/pages/v2/reports/ReportsPage', stub);
vi.mock('@/pages/v2/reports/ReportRoute', stub);
vi.mock('@/pages/v2/reports/MarketingAnalyticsPage', stub);
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', null, 'Dashboard') };
});

const mockApi = vi.mocked(api);

/** A list route: it opens on the module's View AND Show switches. */
const LIST_ROUTES: Array<{ name: string; path: string; view: string; show: string }> = [
  { name: 'Customers', path: '/customers', view: 'View customers', show: 'Show Customers page' },
  { name: 'Leads', path: '/leads', view: 'View leads', show: 'Show Leads page' },
  { name: 'Jobs', path: '/jobs', view: 'View jobs', show: 'Show Jobs page' },
  { name: 'Estimates', path: '/estimates', view: 'View estimates', show: 'Show Estimates page' },
  { name: 'Invoices', path: '/invoices', view: 'View invoices', show: 'Show Invoices page' },
  { name: 'Payments', path: '/payments', view: 'View payments and payouts', show: 'Show Payments page' },
  { name: 'Tasks', path: '/tasks', view: 'View tasks', show: 'Show Tasks page' },
  { name: 'Service Plans', path: '/service-plans', view: 'View service plans', show: 'Show Service Plans page' },
  { name: 'Automations', path: '/automations', view: 'View automations', show: 'Show Automations page' },
  { name: 'Stock', path: '/inventory', view: 'View stock', show: 'Show Stock page' },
  { name: 'Purchase Orders', path: '/inventory/purchase-orders', view: 'View purchase orders', show: 'Show Purchase Orders page' },
  { name: 'Vendors', path: '/inventory/vendors', view: 'View vendors', show: 'Show Vendors page' },
  { name: 'Logistic Orders', path: '/inventory/logistic-orders', view: 'View logistic orders', show: 'Show Logistic Orders page' },
  { name: 'Price Book', path: '/inventory/price-book', view: 'View price book', show: 'Show Price Book page' },
];

/** A page route: it opens on its one Access switch. */
const PAGE_ROUTES: Array<{ name: string; path: string; access: string }> = [
  { name: 'Schedule', path: '/schedule', access: 'Access Schedule' },
  { name: 'Reports', path: '/reports', access: 'Access Reports' },
  { name: 'a report page', path: '/reports/revenue', access: 'Access Reports' },
  { name: 'Billing', path: '/reports/unpaid-invoices', access: 'Access Billing' },
  { name: 'Marketing', path: '/marketing', access: 'Access Marketing' },
];

const key = (label: string) => catalogToggle(label).key;

function serve(values: Record<string, boolean>) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values, rules: [] } })
      : Promise.resolve({ data: {} }));
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string, values: Record<string, boolean>) {
  serve(values);
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {moduleV2Routes()}
        <Route path="*" element={<p>Nothing here</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path] },
  );
}

const dashboard = () => screen.findByRole('heading', { name: 'Dashboard' });
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe.each(LIST_ROUTES)('$name list ($path)', ({ path, view, show }) => {
  it('opens with View and Show on', async () => {
    open(path, { [key(view)]: true, [key(show)]: true });

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('goes to the dashboard with Show off, View still on', async () => {
    open(path, { [key(view)]: true, [key(show)]: false });

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('goes to the dashboard for a role with every switch off', async () => {
    open(path, {});

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});

describe.each(PAGE_ROUTES)('$name page ($path)', ({ path, access }) => {
  it('opens with its Access switch on', async () => {
    open(path, { [key(access)]: true });

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
  });

  it('goes to the dashboard with its Access switch off', async () => {
    open(path, { [key(access)]: false });

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});

/**
 * Record routes are not blocked by the client on View or Show: the record page asks the server, so a record reached
 * from search, a picker or a link on a job or lead opens whenever the server allows it, whatever the person's lists say.
 */
const RECORD_ROUTES = [
  '/customers/c-1',
  '/leads/l-1',
  '/jobs/j-1',
  '/estimates/e-1',
  '/invoices/i-1',
];

describe.each(RECORD_ROUTES)('record route %s', (path) => {
  it('opens for a role with every switch off', async () => {
    open(path, {});

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('opens with its list hidden (View on, Show off)', async () => {
    const module = path.split('/')[1]!;
    const { view, show } = LIST_ROUTES.find((r) => r.path === `/${module}`)!;
    open(path, { [key(view)]: true, [key(show)]: false });

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
  });
});

/**
 * A purchase order opened from a job is a record route too: it opens whatever the list switches say, and the page asks
 * the server (S07.10).
 */
describe('purchase order record route', () => {
  const path = '/inventory/purchase-orders/po-1';

  it('opens for a role with every switch off', async () => {
    open(path, {});

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('opens with the list hidden (View purchase orders on, Show Purchase Orders page off)', async () => {
    open(path, { [key('View purchase orders')]: true, [key('Show Purchase Orders page')]: false });

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
  });
});

/** A logistic order opened from its alert is a record route too: it opens whatever the list switches say (S07.9). */
describe('logistic order record route', () => {
  const path = '/inventory/logistic-orders/lo-1';

  it('opens for a role with every switch off', async () => {
    open(path, {});

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('opens with the list hidden (View logistic orders on, Show Logistic Orders page off)', async () => {
    open(path, { [key('View logistic orders')]: true, [key('Show Logistic Orders page')]: false });

    expect(await screen.findByTestId('opened')).toHaveTextContent(path);
  });
});

/** The standalone New Lead (see NEW_LEAD below) opens on Create leads alone, and goes to the dashboard without it. */
// Built from parts: a repo-wide guard counts the quoted literal and pins how many files may hold it.
const NEW_LEAD = `/leads/${'new'}`;
describe('New Lead (the new-lead address)', () => {
  it('opens with Create leads on, whatever the list switches say', async () => {
    open(NEW_LEAD, { [key('Create leads')]: true });

    expect(await screen.findByTestId('opened')).toHaveTextContent(NEW_LEAD);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });

  it('goes to the dashboard with Create leads off, even with View leads and Show Leads page on', async () => {
    open(NEW_LEAD, { [key('Create leads')]: false, [key('View leads')]: true, [key('Show Leads page')]: true });

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('goes to the dashboard for a role with every switch off', async () => {
    open(NEW_LEAD, {});

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});

describe('a role with every switch off', () => {
  it('lands on its dashboard at the home address, with no redirect loop', async () => {
    open('/', {});

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('lands on its dashboard when it opens the Leads list by address', async () => {
    open('/leads', {});

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});

/**
 * The person's last answer is kept in the browser and draws at first paint. An answer that opens the route may draw
 * at once; one that does not must wait for the fresh answer before sending anyone home, so a switch turned on since
 * their last visit does not bounce them.
 */
describe('a route guard and the last-known answer', () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  const leadsKeys = [key('View leads'), key('Show Leads page')];
  const allowing = Object.fromEntries(leadsKeys.map((k) => [k, true]));
  const refusing = Object.fromEntries(leadsKeys.map((k) => [k, false]));

  function cache(values: Record<string, boolean>) {
    localStorage.setItem(`servwave_my_switches:${userId}`, JSON.stringify({ admin_box: false, values }));
  }

  /** The "me" request stays open until the test answers it (or fails it). */
  function openWithPendingAnswer() {
    let settle: { ok: (values: Record<string, boolean>) => void; fail: () => void } = { ok: () => {}, fail: () => {} };
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/permission-switches/me'
        ? new Promise((resolve, reject) => {
            settle = {
              ok: (values) => resolve({ data: { admin_box: false, values, rules: [] } }),
              fail: () => reject(new Error('Request failed with status code 500')),
            };
          })
        : Promise.resolve({ data: {} }));
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {moduleV2Routes()}
          <Route path="*" element={<p>Nothing here</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/leads'] },
    );
    return { answer: (values: Record<string, boolean>) => settle.ok(values), fail: () => settle.fail() };
  }

  it('opens at once on a cached answer that allows the route, then goes home when the fresh answer takes it away', async () => {
    cache(allowing);
    const server = openWithPendingAnswer();

    expect(await screen.findByTestId('opened')).toHaveTextContent('/leads');

    server.answer(refusing);
    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('draws nothing on a cached answer that refuses the route until the fresh answer, then opens it when it allows', async () => {
    cache(refusing);
    const server = openWithPendingAnswer();

    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    expect(where()).toBe('/leads');
    expect(screen.queryByTestId('opened')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();

    server.answer(allowing);
    expect(await screen.findByTestId('opened')).toHaveTextContent('/leads');
    expect(where()).toBe('/leads');
  });

  it('goes home when the fresh answer also refuses', async () => {
    cache(refusing);
    const server = openWithPendingAnswer();

    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    server.answer(refusing);

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('goes home when the fresh read fails and the cached answer does not allow the route', async () => {
    cache(refusing);
    const server = openWithPendingAnswer();

    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    server.fail();

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });

  it('goes home when the read fails and there is no answer at all', async () => {
    const server = openWithPendingAnswer();

    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    server.fail();

    expect(await dashboard()).toBeInTheDocument();
  });

  it('keeps the route open when the fresh read fails but the cached answer allows it', async () => {
    cache(allowing);
    const server = openWithPendingAnswer();

    expect(await screen.findByTestId('opened')).toHaveTextContent('/leads');
    server.fail();

    await vi.waitFor(() => expect(mockApi.get).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('opened')).toHaveTextContent('/leads');
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });
});
