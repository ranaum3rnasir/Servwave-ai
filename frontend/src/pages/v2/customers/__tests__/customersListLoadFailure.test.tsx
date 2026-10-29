import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import CustomersPage from '../CustomersPage';

/**
 * Mobile slice 68 (PRD story 140): a customers list that fails to load shows an error with Retry
 * instead of "No results found.", so nobody concludes their customers are gone. Retry loads it.
 * The copy is fixed text: the server's own message never reaches the screen.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001', customer_number: 'C00001', first_name: 'John', last_name: 'Doe',
  company_name: null, email: 'john@doe.test', phone: '5125550100', ad_source: null,
  created_at: '2026-01-15T00:00:00.000Z', service_locations: [], _count: { leads: 1, jobs: 2 }, tags: [],
};

function serve(failing: { on: boolean }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    if (url === '/api/customers/stats') return { data: { total: 10, newThisMonth: 2, activeLeads: 3, activeJobs: 4 } };
    if (url === '/api/customers') {
      if (failing.on) {
        throw { isAxiosError: true, message: 'Request failed', response: { status: 500, data: { error: 'Supabase upstream timeout' } } };
      }
      return { data: { customers: [CUSTOMER], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 } } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CustomersPage - a failed list is an error with Retry (slice 68)', () => {
  it('shows an error and Retry, never "No results found."; Retry loads the list', async () => {
    const failing = { on: true };
    serve(failing);
    renderWithProviders(<CustomersPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/customers'],
    });

    expect(await screen.findByText("Couldn't load customers.")).toBeInTheDocument();
    expect(screen.queryByText('No results found.')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/supabase|timeout/i);

    failing.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('C00001')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load customers.")).toBeNull();
  });

  it('a list that loaded and is genuinely empty still says "No results found."', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/me/table-views/')) return { data: {} };
      if (url === '/api/customers/stats') return { data: { total: 0, newThisMonth: 0, activeLeads: 0, activeJobs: 0 } };
      if (url === '/api/customers') return { data: { customers: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } } };
      return { data: {} };
    });
    renderWithProviders(<CustomersPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/customers'],
    });

    expect(await screen.findByText('No results found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
