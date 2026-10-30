/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.20 - the customer's Communication tab marks an email that was linked to the customer by
// its sender's address although the sender's domain could not vouch for it, and no other row. The tab runs with its real data hook;
// the server is answered at the network layer.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';

const mockApi = vi.mocked(api);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const email = (over: Record<string, unknown>) => ({
  channel: 'email', direction: 'in', who: 'Pat Payer', preview: 'Are you open on Saturday?', at: '2026-06-02T09:30:00.000Z', ...over,
});

const ITEMS = [
  email({ id: 'em-unverified', title: 'From an unverified sender', unverifiedSender: true }),
  email({ id: 'em-verified', title: 'From a verified sender', at: '2026-06-03T09:30:00.000Z' }),
  email({ id: 'em-sent', title: 'Sent to the customer', direction: 'out', at: '2026-06-04T09:30:00.000Z' }),
];

describe('the customer Communication tab marks an unverified sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Unverified sender" on the row the server marked and on no other', async () => {
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });
    renderWithProviders(<CustomerCommunicationsTab customerId={CUSTOMER_ID} />);

    const row = (await screen.findByText('From an unverified sender')).closest('li') as HTMLElement;
    expect(within(row).getByText('Unverified sender')).toBeInTheDocument();
    expect(screen.getAllByText('Unverified sender')).toHaveLength(1);
    const verified = (screen.getByText('From a verified sender')).closest('li') as HTMLElement;
    expect(within(verified).queryByText('Unverified sender')).not.toBeInTheDocument();
    const sent = (screen.getByText('Sent to the customer')).closest('li') as HTMLElement;
    expect(within(sent).queryByText('Unverified sender')).not.toBeInTheDocument();
  });
});
