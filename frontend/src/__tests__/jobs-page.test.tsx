import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobsPage from '@/pages/JobsPage';
import { startOfMonthDay, endOfMonthDay } from '@/lib/date-range';
import { DEFAULT_SCHEDULE_TIMEZONE } from '@/lib/schedule-tz';

const mockApi = vi.mocked(api);

const JOB_LIST_FIXTURE = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: null,
        customer_number: 'C00001',
      },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    unassigned: 2,
    scheduled: 5,
    in_progress: 1,
    completed: 3,
    cancelled: 1,
    need_invoices: 4,
  },
  // Jobs page fires several GETs (jobs + assignable users + departments); a
  // single resolver shape that satisfies all of them is enough here (mirrors
  // list-status-defaults.test.tsx's JobsPage mock).
  users: [],
  departments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: JOB_LIST_FIXTURE });
});

// Radix Popover needs a real constructable ResizeObserver + fireEvent (not
// userEvent) to open in jsdom — mirrors FilterBar.test.tsx / leads-page.test.tsx's
// established precedent.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Exposes the MemoryRouter's current path+search so tests can assert on the URL. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function jobsApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/jobs');
}

describe('JobsPage', () => {
  it('renders page heading', async () => {
    renderWithProviders(<JobsPage />);
    expect(screen.getByText('Jobs')).toBeInTheDocument();
  });

  it('renders KPI strip with tile labels', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    });
    // "Scheduled" is both the KPI tile label AND the fixture job row's
    // StatusBadge text (status: 'SCHEDULED') — assert at least one match
    // rather than a single unique element.
    expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Need Invoices')).toBeInTheDocument();
  });

  it('renders job customer name in table', async () => {
    renderWithProviders(<JobsPage />);
    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });
  });

  it('shows search placeholder', () => {
    renderWithProviders(<JobsPage />);
    expect(screen.getByPlaceholderText('Search jobs...')).toBeInTheDocument();
  });

  it('calls API with correct params on mount', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', {
        params: expect.objectContaining({ page: 1, limit: 25, exclude_plan_visits: 'true' }),
      });
    });
  });
});

describe('JobsPage — generalized filter registry (Task 11)', () => {
  it('setting Status + Scheduled range updates both the URL query string and the /api/jobs request params', async () => {
    renderWithProviders(
      <>
        <JobsPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    });

    // Open the Filter popover (Status is the first/default facet pane) and
    // select the "Scheduled" status checkbox.
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Scheduled' }));

    // Switch to the "Scheduled" date-range facet (distinct `role="tab"` from
    // the same-named status checkbox above) and pick the "Today" preset.
    fireEvent.click(screen.getByRole('tab', { name: /^scheduled$/i }));
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Today' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    // URL reflects both facets, using the frontend codec's dateRange suffix convention.
    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('status=SCHEDULED');
      expect(url).toMatch(/scheduled_after=\d{4}-\d{2}-\d{2}/);
      expect(url).toMatch(/scheduled_before=\d{4}-\d{2}-\d{2}/);
    });

    // The outgoing /api/jobs request carries the matching (backend-aligned) param names.
    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'SCHEDULED',
            scheduled_after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            scheduled_before: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            exclude_plan_visits: 'true',
          }),
        })
      );
    });
  });

  it('clicking the "Unscheduled" (all-time) KPI tile applies {status:[UNSCHEDULED]} with no date range', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /unscheduled/i }));

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ status: 'UNSCHEDULED' }) })
      );
      // Only the status facet is active — no leftover scheduled range, assignee,
      // or needs_invoice from a previous preset (guards the KPI preset's exact shape).
      expect(lastCall[1].params.scheduled_after).toBeUndefined();
      expect(lastCall[1].params.scheduled_before).toBeUndefined();
      expect(lastCall[1].params.assigned_to).toBeUndefined();
      expect(lastCall[1].params.needs_invoice).toBeUndefined();
    });

    // The tile now shows itself as active; clicking it again clears back to the default view.
    fireEvent.click(screen.getByRole('button', { name: /unscheduled/i }));

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.status).toBeUndefined();
    });
  });

  it('clicking the "Completed" (monthly) KPI tile applies {status:[COMPLETED], scheduled: current month}', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    // Anchored: the Need Invoices tile's sub-caption text is "Completed, unbilled",
    // which would otherwise also match an unanchored /completed/i.
    fireEvent.click(screen.getByRole('button', { name: /^completed/i }));

    // #1634: the "scheduled" facet's month bounds are now the ORG's month, not
    // the browser's. This harness's single mockApi.get resolver (JOB_LIST_FIXTURE,
    // no `timezone` key) makes useOrganization()'s data.timezone undefined, so
    // useScheduleTimezone() falls back to DEFAULT_SCHEDULE_TIMEZONE - exactly
    // what JobsPage resolves too. Pinned explicitly rather than relying on the
    // test runner's own local zone happening to agree.
    const monthStart = startOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE);
    const monthEnd = endOfMonthDay(DEFAULT_SCHEDULE_TIMEZONE);

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'COMPLETED',
            scheduled_after: monthStart,
            scheduled_before: monthEnd,
          }),
        })
      );
    });
  });

  it('clicking the "Need Invoices" KPI tile applies needs_invoice=true with no status filter', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('Need Invoices')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /need invoices/i }));

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ needs_invoice: 'true' }) })
      );
      expect(lastCall[1].params.status).toBeUndefined();
    });

    // Toggle off
    fireEvent.click(screen.getByRole('button', { name: /need invoices/i }));

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.needs_invoice).toBeUndefined();
    });
  });

  it('"Needs Invoice" is a real filter-bar facet: checking it in the Filter popover applies needs_invoice=true', async () => {
    renderWithProviders(
      <>
        <JobsPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    });

    // Open the Filter popover and switch to the "Needs Invoice" facet tab
    // (distinct `role="tab"` from the checkbox of the same name inside its pane).
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^needs invoice$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs Invoice' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('needs_invoice=true');
    });

    await waitFor(() => {
      const calls = jobsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ needs_invoice: 'true' }) })
      );
    });

    // Unchecking clears the facet (and the URL param) entirely. The trigger's
    // accessible name is now "Filter1" (badge count folded into the label),
    // so match on the leading "Filter" rather than an exact string.
    fireEvent.click(screen.getByRole('button', { name: /^filter/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs Invoice' }));
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).not.toContain('needs_invoice');
    });
  });

  it('does not render a standalone customer picker (customer filtering is via the global search bar)', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    });

    expect(screen.queryByPlaceholderText(/search customer/i)).not.toBeInTheDocument();
  });

  it('never sends customer_id to /api/jobs', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      const calls = jobsApiCalls();
      expect(calls.length).toBeGreaterThan(0);
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.customer_id).toBeUndefined();
    });
  });
});
