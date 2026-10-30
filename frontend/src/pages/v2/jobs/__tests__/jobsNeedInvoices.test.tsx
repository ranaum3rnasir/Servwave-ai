import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';

/**
 * Roles & Permissions S04.2 - the Jobs page's Need Invoices tile and "needs invoice" filter follow
 * the View invoices switch (the `read Invoice` grant on the page), whatever the person's role. The
 * five status tiles show to everyone.
 *
 * Every person here is a bag of grants, never a role name: a role-name check cannot pass.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const JOB_LIST = {
  jobs: [
    {
      id: 'j0000000-0000-0000-0000-000000000001',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scheduled_start: '2026-07-20T09:00:00.000Z',
      created_at: '2026-07-15T00:00:00.000Z',
      customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
      assignees: [],
      service_location: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: { unassigned: 2, scheduled: 5, in_progress: 1, completed: 3, cancelled: 1, need_invoices: 4 },
  users: [],
  departments: [],
  tags: [],
};

const withoutViewInvoices = buildAbility([{ action: 'read', subject: 'Job' }]);
const withViewInvoices = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Invoice' },
]);

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function jobsApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/jobs');
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
});

describe('Jobs page - Need Invoices follows View invoices', () => {
  it('shows the five status tiles and no Need Invoices tile without View invoices', async () => {
    renderWithProviders(<JobsPage />, { ability: withoutViewInvoices, initialEntries: ['/jobs'] });

    await screen.findByText('J00001');
    for (const label of ['Unscheduled', 'Scheduled', 'In Progress', 'Completed', 'Cancelled']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('Need Invoices')).not.toBeInTheDocument();
  });

  it('offers no "needs invoice" filter without View invoices', async () => {
    renderWithProviders(<JobsPage />, { ability: withoutViewInvoices, initialEntries: ['/jobs'] });

    await screen.findByText('J00001');
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));

    // The popover is open: another facet's tab is there, the invoice one is not.
    expect(await screen.findByRole('tab', { name: /^status$/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^needs invoice$/i })).not.toBeInTheDocument();
  });

  it('does not send a needs_invoice deep link to the server without View invoices', async () => {
    renderWithProviders(<JobsPage />, {
      ability: withoutViewInvoices,
      initialEntries: ['/jobs?needs_invoice=true'],
    });

    await screen.findByText('J00001');
    const calls = jobsApiCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const [, config] of calls) {
      expect((config as { params: Record<string, unknown> }).params.needs_invoice).toBeUndefined();
    }
  });

  it('shows the Need Invoices tile with View invoices, and it applies needs_invoice=true', async () => {
    renderWithProviders(
      <>
        <JobsPage />
        <LocationProbe />
      </>,
      { ability: withViewInvoices, initialEntries: ['/jobs'] },
    );

    await screen.findByText('J00001');
    fireEvent.click(screen.getByText('Need Invoices'));

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).toContain('needs_invoice=true');
    });
    await waitFor(() => {
      const calls = jobsApiCalls();
      const last = calls[calls.length - 1];
      expect((last?.[1] as { params: Record<string, unknown> }).params.needs_invoice).toBe('true');
    });
  });

  it('offers the "needs invoice" filter with View invoices', async () => {
    renderWithProviders(<JobsPage />, { ability: withViewInvoices, initialEntries: ['/jobs'] });

    await screen.findByText('J00001');
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));

    expect(await screen.findByRole('tab', { name: /^needs invoice$/i })).toBeInTheDocument();
  });
});
