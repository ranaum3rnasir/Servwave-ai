import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import LeadsPage from '../LeadsPage';

/**
 * Mobile slice 68 (PRD story 140): a leads list that fails to load shows an error with Retry
 * instead of "No results found.", so nobody concludes their leads are gone. Retry loads it.
 * The copy is fixed text: the server's own message never reaches the screen.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

const LEAD = {
  id: 'e0000000-0000-0000-0000-000000000001', lead_number: 'L00001', status: 'NEW', service_request: 'AC not cooling',
  job_type: null, scheduled_start: null, created_at: '2026-01-15T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, phone: '5551234567', ad_source: null },
  commission_owner: null, lead_assignees: [], walkthrough_performers: [], tags: [], estimates: [],
};
const STATS = { total: 1, won: 0, lost: 0, new_this_week: 1, no_owner: 1 };

function serve(failing: { on: boolean }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/me/table-views/')) return { data: {} };
    if (url === '/api/leads') {
      if (failing.on) {
        throw { isAxiosError: true, message: 'Request failed', response: { status: 502, data: { error: 'Supabase upstream timeout' } } };
      }
      return { data: { leads: [LEAD], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 }, stats: STATS } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LeadsPage - a failed list is an error with Retry (slice 68)', () => {
  it('shows an error and Retry, never "No results found."; Retry loads the list', async () => {
    const failing = { on: true };
    serve(failing);
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/leads'],
    });

    expect(await screen.findByText("Couldn't load leads.")).toBeInTheDocument();
    expect(screen.queryByText('No results found.')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/supabase|timeout/i);

    failing.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('L00001')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load leads.")).toBeNull();
  });

  it('a list that loaded and is genuinely empty still says "No results found."', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/me/table-views/')) return { data: {} };
      if (url === '/api/leads') {
        return { data: { leads: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 }, stats: STATS } };
      }
      return { data: {} };
    });
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/leads'],
    });

    expect(await screen.findByText('No results found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
