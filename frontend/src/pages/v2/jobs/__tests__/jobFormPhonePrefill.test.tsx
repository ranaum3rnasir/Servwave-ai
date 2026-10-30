import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { buildAbility } from '@/lib/ability';

/**
 * Roles & Permissions S02.27 - the Texts inbox and the dialer offer "Create job" for an unknown number, and it opens
 * /jobs/new?phone=<e164>. The job form reads that number the way the lead form does: country code stripped, masked,
 * and placed in the new-customer part (the phone box, with no customer picked).
 */

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async () => ({ data: {} }));
});

describe('JobFormPage (create) - ?phone= create-prefill (S02.27)', () => {
  it('seeds the phone field from /jobs/new?phone=<e164>, country code stripped and masked', async () => {
    renderWithProviders(<JobFormPage />, {
      ability: adminAbility,
      initialEntries: ['/jobs/new?phone=%2B16098745252'],
    });

    await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
  });

  it('leaves the phone field empty when no number is passed', async () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    expect(await screen.findByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('(609) 874-5252')).not.toBeInTheDocument();
  });

  it('puts the number in the new-customer part: no customer is picked', async () => {
    renderWithProviders(<JobFormPage />, {
      ability: adminAbility,
      initialEntries: ['/jobs/new?phone=%2B16098745252'],
    });

    await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
    expect(mockApi.get.mock.calls.some(([url]) => String(url).startsWith('/api/customers/picker/'))).toBe(false);
  });
});
