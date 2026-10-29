import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoicesPage from '@/pages/InvoicesPage';
import JobsPage from '@/pages/JobsPage';

const mockApi = vi.mocked(api);

// Bug #21 — completed-but-unbilled jobs were invisible from the billing surface:
// GET /api/invoices already returns stats.need_invoices but the InvoicesPage
// KpiStrip discarded it. The fix surfaced it as a "To Be Invoiced" tile.
// #594 — the tile now opens an in-page modal listing those jobs (each row links
// to the job detail page) instead of deep-linking to /jobs?needs_invoice=true.
// JobsPage still honors the ?needs_invoice=true URL param (regression coverage).

const INVOICE_STATS = {
  due: { total: 1500, count: 2 },
  overdue: { total: 0, count: 0 },
  collected_this_month: { total: 0, count: 0 },
  unsent: 1,
  need_invoices: 4,
};

describe('Bug #21 — "To Be Invoiced" surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a "To Be Invoiced" KPI tile with the need_invoices count', async () => {
    mockApi.get.mockResolvedValue({
      data: { invoices: [], pagination: { total: 0 }, stats: INVOICE_STATS },
    });

    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(screen.getByText('To Be Invoiced')).toBeInTheDocument();
    });
    // The discarded count is now shown on the tile.
    expect(screen.getByText('4')).toBeInTheDocument();
    // The tile is a button (clickable KPI), labelled with the count + sub copy.
    const tile = screen.getByText('To Be Invoiced').closest('button');
    expect(tile).not.toBeNull();
    expect(tile).toHaveTextContent('Completed, unbilled');
  });

  it('JobsPage applies the needs_invoice filter when the URL param is present', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/jobs') {
        return Promise.resolve({ data: { jobs: [], pagination: { total: 0 }, stats: {} } });
      }
      // /api/users, /api/departments — return shape the page expects.
      return Promise.resolve({ data: { users: [], departments: [] } });
    });

    renderWithProviders(<JobsPage />, { initialEntries: ['/jobs?needs_invoice=true'] });

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', {
        params: expect.objectContaining({ needs_invoice: 'true' }),
      });
    });
  });

  it('JobsPage does NOT apply the needs_invoice filter without the URL param', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/jobs') {
        return Promise.resolve({ data: { jobs: [], pagination: { total: 0 }, stats: {} } });
      }
      return Promise.resolve({ data: { users: [], departments: [] } });
    });

    renderWithProviders(<JobsPage />, { initialEntries: ['/jobs'] });

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', expect.anything());
    });
    const jobsCall = mockApi.get.mock.calls.find(([url]) => url === '/api/jobs');
    expect(jobsCall?.[1]?.params?.needs_invoice).toBeUndefined();
  });

  it('clicking the tile opens a modal listing jobs needing invoices, rows link to job detail', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/jobs') {
        return Promise.resolve({ data: { jobs: [{ id: 'j1', job_number: 'JOB-1001', scheduled_start: null, customer: { id: 'c1', first_name: 'Ann', last_name: 'Lee', company_name: null } }], pagination: { total: 1 }, stats: {} } });
      }
      return Promise.resolve({ data: { invoices: [], pagination: { total: 0 }, stats: INVOICE_STATS } });
    });

    renderWithProviders(<InvoicesPage />);
    await waitFor(() => expect(screen.getByText('To Be Invoiced')).toBeInTheDocument());
    fireEvent.click(screen.getByText('To Be Invoiced').closest('button')!);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', {
        params: expect.objectContaining({ needs_invoice: 'true' }),
      });
    });
    const link = await screen.findByRole('link', { name: 'JOB-1001' });
    expect(link).toHaveAttribute('href', '/jobs/j1');
  });
});
