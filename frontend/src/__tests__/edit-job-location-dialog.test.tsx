import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

// The dialog is driven THROUGH THE PAGE, never mounted on its own. A component test that
// holds `currentLocation` fixed passes against the broken code and proves nothing: the whole
// defect is that a successful save invalidates ['job', id], the refetch returns the newly
// anchored job, and `job.service_location` therefore arrives as a NEW OBJECT while the dialog
// is still open. Only the page seam reproduces that.

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: () => null,
}));

// floating-ui (under Radix) does `new ResizeObserver(...)`; the global setup mock returns a
// plain object and isn't constructable (same stub as job-detail-page.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: JOB_ID }),
    useNavigate: () => vi.fn(),
  };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const mockApi = vi.mocked(api);

const LOC_TX = {
  id: 'loc-tx',
  address_line1: '1 Austin Way',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  is_primary: true,
};

const LOC_CA = {
  id: 'loc-ca',
  address_line1: '2 Bay St',
  address_line2: null,
  city: 'San Francisco',
  state: 'CA',
  zip: '94105',
  is_primary: false,
};

const BASE_JOB = {
  id: JOB_ID,
  job_number: 'J00001',
  status: 'UNSCHEDULED',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null as string | null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: {
    id: CUSTOMER_ID,
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: LOC_TX as typeof LOC_TX | null,
  estimate: null,
  invoices: [] as unknown[],
  linked_estimates: [] as unknown[],
  tags: [] as unknown[],
  source_plan_id: null,
  source_plan: null,
};

/** Serve the job the mutable `served` box currently holds, exactly as the real GET would. */
function serveJob(getServed: () => unknown) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/jobs/')) return { data: { job: getServed() } };
    if (url.includes('/api/customers/')) {
      return { data: { customer: { id: CUSTOMER_ID, service_locations: [LOC_TX, LOC_CA] } } };
    }
    return { data: {} };
  });
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /edit service location/i }));
  return screen.findByRole('dialog');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JobDetailPage — changing the job service location', () => {
  it("lists the customer's other saved addresses to pick from", async () => {
    const user = userEvent.setup();
    serveJob(() => BASE_JOB);

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const dialog = await openDialog(user);
    expect(await within(dialog).findByText(/2 Bay St, San Francisco, CA 94105/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 Austin Way, Austin, TX 78701/)).toBeInTheDocument();
  }, 180000);

  // The tax state is the basis the job's money is priced against, so the warning is the
  // dispatcher's to dismiss (Done / close) and NEVER a refetch's to erase. Every cross-state
  // move changes the anchor by definition, so an unguarded reset keyed on the anchor OBJECT
  // makes this warning unreadable in production precisely when it matters.
  it('keeps the cross-state tax warning readable after the job refetches with the new anchor', async () => {
    const user = userEvent.setup();
    let served: unknown = BASE_JOB;
    serveJob(() => served);
    mockApi.patch.mockImplementation(async () => {
      served = { ...BASE_JOB, service_location: LOC_CA };
      return {
        data: { job: served, tax_warning: { tax_warning: true, old_state: 'TX', new_state: 'CA' } },
      };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const dialog = await openDialog(user);
    await user.click(await within(dialog).findByText(/2 Bay St, San Francisco, CA 94105/));
    await user.click(within(dialog).getByRole('button', { name: /save location/i }));

    expect(mockApi.patch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}`, {
      service_location_id: LOC_CA.id,
    });

    expect(await within(dialog).findByText(/from TX to CA/)).toBeInTheDocument();

    // The refetch lands: the masthead flips to the new address. (With the warning shown the
    // dialog hides the address list, so this match can only be the page's own masthead.)
    await waitFor(() => {
      expect(screen.getByText(/2 Bay St, San Francisco, CA 94105/)).toBeInTheDocument();
    });

    // …and the warning MUST have survived that refresh.
    expect(within(dialog).getByText(/from TX to CA/)).toBeInTheDocument();
    expect(within(dialog).getByText(/tax rate may differ/i)).toBeInTheDocument();
  }, 180000);

  it('does not carry a failed save’s error message into the next time the dialog is opened', async () => {
    const user = userEvent.setup();
    serveJob(() => BASE_JOB);
    mockApi.patch.mockRejectedValue({
      response: { data: { error: 'Location locked — job has invoices' } },
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const dialog = await openDialog(user);
    await user.click(await within(dialog).findByText(/2 Bay St, San Francisco, CA 94105/));
    await user.click(within(dialog).getByRole('button', { name: /save location/i }));

    expect(await within(dialog).findByText(/Location locked/)).toBeInTheDocument();

    // Give up, close, come back later.
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const reopened = await openDialog(user);
    expect(within(reopened).queryByText(/Location locked/)).toBeNull();
  }, 180000);

  it('resets cleanly on reopen after a warned save — fresh list, no stale warning', async () => {
    const user = userEvent.setup();
    let served: unknown = BASE_JOB;
    serveJob(() => served);
    mockApi.patch.mockImplementation(async () => {
      served = { ...BASE_JOB, service_location: LOC_CA };
      return {
        data: { job: served, tax_warning: { tax_warning: true, old_state: 'TX', new_state: 'CA' } },
      };
    });

    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const dialog = await openDialog(user);
    await user.click(await within(dialog).findByText(/2 Bay St, San Francisco, CA 94105/));
    await user.click(within(dialog).getByRole('button', { name: /save location/i }));
    expect(await within(dialog).findByText(/from TX to CA/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The guard must not over-correct into never resetting at all.
    const reopened = await openDialog(user);
    expect(within(reopened).queryByText(/from TX to CA/)).toBeNull();
    expect(await within(reopened).findByText(/1 Austin Way, Austin, TX 78701/)).toBeInTheDocument();
    expect(within(reopened).getByRole('button', { name: /save location/i })).toBeDisabled();
  }, 180000);
});
