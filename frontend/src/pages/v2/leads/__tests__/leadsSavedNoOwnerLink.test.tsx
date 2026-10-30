/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * The Leads list opened from the dashboard's Missing lead owner links (S09.11): `/leads?assigned_to=NO_OWNER`.
 *
 * The tile and the Needs Attention item send this address (the server writes it). The routed Leads page has to read it as
 * its No owner filter: the request it makes carries that choice, and the No owner card shows as the active one.
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
    if (url === '/api/leads') return { data: { leads: [], pagination: PAGINATION, stats: { total: 5, no_owner: 2 }, users: [] } };
    return { data: {} };
  });
});

const leadListParams = () =>
  mockApi.get.mock.calls.filter(([url]) => url === '/api/leads').map(([, config]) => (config as { params: Record<string, unknown> }).params);

describe('the routed Leads list opened from the dashboard\'s No owner link', () => {
  it('asks the server for the leads with no owner and shows a No owner filter chip', async () => {
    renderWithProviders(<LeadsPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: ['/leads?assigned_to=NO_OWNER'],
    });

    await waitFor(() => expect(leadListParams().length).toBeGreaterThan(0));
    for (const params of leadListParams()) expect(String(params.assigned_to)).toBe('NO_OWNER');
    expect(await screen.findByText(/Owner:.*No owner|No owner/)).toBeInTheDocument();
  });
});
