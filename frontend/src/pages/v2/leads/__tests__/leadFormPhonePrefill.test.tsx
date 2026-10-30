import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * Roles & Permissions S02.27 - "Create lead" in the Texts inbox and the dialer opens /leads/new?phone=<e164>. The
 * ROUTED lead form (pages/v2) puts that number, country code stripped and masked, in its new-customer part.
 */

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async () => ({ data: {} }));
});

describe('LeadFormPage (routed, create) - ?phone= create-prefill (S02.27)', () => {
  it('seeds the phone field from /leads/new?phone=<e164>, country code stripped and masked', async () => {
    renderWithProviders(<LeadFormPage />, {
      ability: adminAbility,
      initialEntries: ['/leads/new?phone=%2B16098745252'],
    });

    await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
  });
});
