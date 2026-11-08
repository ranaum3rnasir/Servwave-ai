import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoicesPage from '@/pages/InvoicesPage';
import JobsPage from '@/pages/JobsPage';
import LeadsPage from '@/pages/LeadsPage';
import EstimatesPage from '@/pages/EstimatesPage';

const mockApi = vi.mocked(api);

// Interim behavior: every list page defaults to ALL statuses (no status param), so
// terminal records (PAID/VOIDED, COMPLETED/CANCELLED, WON/LOST) are visible by default.
// Users narrow via the Status menu / KPI tiles; search always spans all statuses.

describe('InvoicesPage default status filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: { invoices: [], pagination: { total: 0 }, stats: {} },
    });
  });

  it('requests all statuses (no status param) on mount', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith(
        '/api/invoices',
        expect.objectContaining({
          params: expect.objectContaining({ status: undefined }),
        }),
      );
    });
  });
});

describe('JobsPage default status filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Jobs page fires several GETs (jobs + techs + departments); a single
    // resolver shape that satisfies all of them is enough for this assertion.
    mockApi.get.mockResolvedValue({
      data: { jobs: [], pagination: { total: 0 }, stats: {}, users: [], departments: [] },
    });
  });

  it('requests all statuses (no status param) on mount', async () => {
    renderWithProviders(<JobsPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith(
        '/api/jobs',
        expect.objectContaining({
          params: expect.objectContaining({ status: undefined }),
        }),
      );
    });
  });
});

describe('LeadsPage default status filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: {
        leads: [], jobs: [], estimates: [], invoices: [], assignees: [],
        users: [], departments: [], organization: {},
        pagination: { total: 0 }, stats: {},
      },
    });
  });

  it('requests all statuses (no status param) on mount', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith(
        '/api/leads',
        expect.objectContaining({
          params: expect.objectContaining({ status: undefined }),
        }),
      );
    });
  });
});

describe('EstimatesPage default status filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: {
        estimates: [], leads: [], jobs: [], invoices: [],
        users: [], organization: {},
        pagination: { total: 0 }, stats: {},
      },
    });
  });

  it('requests all statuses (no status param) on mount', async () => {
    renderWithProviders(<EstimatesPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith(
        '/api/estimates',
        expect.objectContaining({
          params: expect.objectContaining({ status: undefined }),
        }),
      );
    });
  });
});
