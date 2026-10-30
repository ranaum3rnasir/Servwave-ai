/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.11 - the "Sending as" line on the job page's Communication tab (the routed
// JobDetailPage renders this JobCommunicationsTab), in Email mode.
//
// The REAL data hooks run; only the network layer is faked. An email written here goes out from the sender's OWN address
// whoever the customer is; a person with no address of their own reads the address-needed sentence, and Send is disabled
// with its reason readable by a screen reader. The same line is on the customer page (customerComposeSendingAs.test) and
// the Email page (inboxSendingAs.test); the lead page has no email composer at all (leadCommunicationsNoEmailCompose.test).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";
const OWN_ADDRESS = 'jane.smith.acme@mail.example.test';
const OWN_NAME = 'Jane Smith at Acme';

type Identity = { status: 'active' | 'address_needed'; address: string | null; name: string | null; sendingEnabled: boolean };
let identity: Identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/api/communication/sending-identity') return { data: identity };
    return { data: { items: [] } };
  });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

async function openEmailMode() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(
    <JobCommunicationsTab
      jobId="b0000000-0000-0000-0000-000000000001" jobNumber="J00042" customerId="c0000000-0000-0000-0000-000000000001"
      customerName="Daniel Cohen" customerEmail="daniel@example.test" customerPhone="5551234567"
    />,
    { ability },
  );
  await user.click(await screen.findByRole('button', { name: 'Email' }));
  return user;
}

describe('the job page Communication tab: "Sending as" in Email mode', () => {
  it('shows the sender\'s own address and the name the recipient sees, and sends the email stamped with the job', async () => {
    const user = await openEmailMode();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/email daniel cohen/i), 'Hello there');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/communication/emails', expect.objectContaining({ job_id: 'b0000000-0000-0000-0000-000000000001' })));
    // Nothing in the request names who it goes out as: the server decides.
    const body = vi.mocked(api.post).mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(body).filter((k) => /from/i.test(k))).toEqual([]);
  });

  it('is not shown in Text mode', async () => {
    renderWithProviders(
      <JobCommunicationsTab jobId="b1" jobNumber="J1" customerId="c1" customerName="Daniel Cohen" customerEmail="daniel@example.test" customerPhone="5551234567" />,
      { ability },
    );
    await screen.findByRole('button', { name: 'Email' });
    expect(screen.queryByText('Sending as')).not.toBeInTheDocument();
  });

  it('reads the address-needed sentence and disables Send, with the reason readable, for a person with no address', async () => {
    identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    const user = await openEmailMode();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/email daniel cohen/i), 'Hello there');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(NEEDED_SENTENCE);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('names no email provider or other vendor', async () => {
    identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    await openEmailMode();
    await screen.findByText('Sending as');
    expect(document.body.innerHTML).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|stripe|twilio/i);
  });
});
