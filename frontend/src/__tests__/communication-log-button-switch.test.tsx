/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.14 - the Log button follows Log past communications.
//
// The record tabs of the Communication section (customer, lead, job) offer "Log communication" to a person holding
// Log past communications and to nobody else, whatever else they hold. The person's ability is compiled from the backend
// switch catalog for a custom role holding exactly the switches under test, so a change to what the switch grants fails
// here. The built-in Technician's values keep the button.
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import type { AppAbility } from '@/lib/ability';
import { abilityWithSwitches } from './support/backendSwitchCatalog';
import { technicianAbility } from './support/technicianPreset';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';

const mockApi = vi.mocked(api);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({ EntityCallDrawer: () => null }));
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({ EntitySmsDrawer: () => null }));

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000042';

const TABS: Array<[string, () => ReactElement, string]> = [
  ['customer', () => <CustomerCommunicationsTab customerId={CUSTOMER_ID} />, 'Inbound call'],
  [
    'lead',
    () => (
      <LeadCommunicationsTab
        leadId={LEAD_ID} leadLabel="L00001" customerId={CUSTOMER_ID} customerName="Doe HVAC" customerPhone="5551234567"
      />
    ),
    'Inbound call',
  ],
  [
    'job',
    () => (
      <JobCommunicationsTab
        jobId={JOB_ID} jobNumber="J00042" customerId={CUSTOMER_ID} customerName="Doe HVAC"
        customerEmail="doe@example.test" customerPhone="5551234567"
      />
    ),
    'Inbound call',
  ],
];

const SECTION = ['View communication'];
const logButton = () => screen.queryByRole('button', { name: /log communication/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) =>
    url === '/api/communication/manual-log/performers'
      ? { data: { users: [] } }
      : {
          data: {
            items: [{
              id: 'cs-00000000-0000-0000-0000-000000000001', channel: 'call', direction: 'in', who: 'Maria',
              title: 'Inbound call', preview: 'Asked about the spring.', at: '2026-06-01T14:00:00.000Z',
            }],
          },
        },
  );
});

function renderTab(tab: () => ReactElement, ability: AppAbility) {
  return renderWithProviders(tab(), { ability });
}

describe.each(TABS)('the %s record tab', (_name, tab, row) => {
  it('offers Log communication with Log past communications', async () => {
    renderTab(tab, abilityWithSwitches(...SECTION, 'Log past communications'));
    await screen.findByText(new RegExp(row));
    await waitFor(() => expect(logButton()).toBeInTheDocument());
  });

  it('does not offer it without Log past communications, even with Contact customers and every other communication switch', async () => {
    renderTab(
      tab,
      abilityWithSwitches(...SECTION, 'Access Communication', 'Contact customers', 'Play recording', 'View transcript', 'See call insights'),
    );
    await screen.findByText(new RegExp(row));
    expect(logButton()).not.toBeInTheDocument();
  });

  it('keeps it for a person with the Technician preset\'s values', async () => {
    renderTab(tab, technicianAbility());
    await screen.findByText(new RegExp(row));
    await waitFor(() => expect(logButton()).toBeInTheDocument());
  });
});
