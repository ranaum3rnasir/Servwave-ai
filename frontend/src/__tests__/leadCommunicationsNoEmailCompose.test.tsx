/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.11 - the lead page's Communication tab has no email composer (email from a lead
// is intentionally not offered there; a lead's customer is emailed from the customer's page or the Email page). So there
// is nothing on the lead page that sends by hand from an address, and no "Sending as" line to show. This pins that: if an
// email composer is ever added to the lead tab it must carry the line (and the disabled Send), and this test says where.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  vi.mocked(api.get).mockResolvedValue({ data: { items: [] } });
});

describe('the lead page Communication tab', () => {
  it('offers texts and calls but no email composer, so there is no "Sending as" line', async () => {
    renderWithProviders(
      <LeadCommunicationsTab leadId="l1" leadLabel="L00001" customerId="c1" customerName="Daniel Cohen" customerPhone="5551234567" />,
      { ability },
    );
    await screen.findByPlaceholderText(/text daniel cohen/i);
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sending as')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/api/communication/sending-identity');
  });
});
