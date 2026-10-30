/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * A saved link that filters the Leads list on Cancelled (S05.18).
 *
 * Cancelled is retired for leads: every lead that was Cancelled is Lost now. A bookmark or saved link from before still
 * carries `?status=CANCELLED`, and the routed Leads page must read it as Lost: the request it makes asks for Lost leads
 * and the filter chip says Lost, never Cancelled and never "every lead".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import LeadsPage from '../LeadsPage';

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));

const mockApi = vi.mocked(api);
const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/leads') return { data: { leads: [], pagination: PAGINATION, stats: {}, users: [] } };
    return { data: {} };
  });
});

const leadListParams = () =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/leads').map(([, config]) => (config as { params: Record<string, unknown> }).params);

describe('the routed Leads list opened from a saved Cancelled link', () => {
  it('asks the server for Lost leads and shows a Lost filter chip', async () => {
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/leads?status=CANCELLED'],
    });

    await waitFor(() => expect(leadListParams().length).toBeGreaterThan(0));
    for (const params of leadListParams()) expect(params.status).toBe('LOST');

    expect(await screen.findByText(/Status:.*Lost|Lost/)).toBeInTheDocument();
    expect(screen.queryByText(/Cancelled/)).not.toBeInTheDocument();
  });
});
