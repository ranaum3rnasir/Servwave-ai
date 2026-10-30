/// <reference types="@testing-library/jest-dom/vitest" />
// SPEC-4 §6.6 (Option A, chosen 24 Oct): the lead page's Communication tab offers Email next to Text, the same as the
// Job tab, and an email sent there is filed on the lead (`lead_id`), which is what lets it release the lead's Spider
// alert once it is sent. This replaces the S10.11 pin that the lead tab had no email composer: that pin said an email
// composer added here must carry the "Sending as" line and the disabled Send, and these tests hold it to that.
//
// The REAL data hooks run; only the network layer is faked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";
const OWN_ADDRESS = 'jane.smith@mail.example.test';
const OWN_NAME = 'Jane Smith';

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

function renderTab(props: { customerEmail?: string; onSent?: () => void } = { customerEmail: 'daniel@example.test' }) {
  return renderWithProviders(
    <LeadCommunicationsTab
      leadId="l1" leadLabel="L00001" customerId="c1" customerName="Daniel Cohen" customerPhone="5551234567"
      {...props}
    />,
    { ability },
  );
}

async function openEmailMode(props?: Parameters<typeof renderTab>[0]) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const rendered = renderTab(props);
  await user.click(await screen.findByRole('button', { name: 'Email' }));
  return { user, ...rendered };
}

describe('the lead page Communication tab: Email mode', () => {
  it('offers Email next to Text when the customer has an email address', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: 'Email' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Text' })).toBeInTheDocument();
  });

  it('with no address on file, Email is disabled and says why', async () => {
    renderTab({});
    expect(await screen.findByRole('button', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText('No email on file for this customer.')).toBeInTheDocument();
  });

  it('shows the "Sending as" line with the sender\'s own address in Email mode', async () => {
    await openEmailMode();
    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    expect(screen.getByText('Emails sent from this lead are tagged L00001 automatically.')).toBeInTheDocument();
  });

  it('disables Send with the reason while the sender has no address', async () => {
    identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    const { user } = await openEmailMode();
    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/email daniel cohen/i), 'Hello there');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(NEEDED_SENTENCE);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends the email filed on the lead, and refreshes the lead\'s views', async () => {
    const onSent = vi.fn();
    const { user, queryClient } = await openEmailMode({ customerEmail: 'daniel@example.test', onSent });
    // The lead views, cached before the send (kept: the test client collects unobserved queries at once).
    for (const key of [['lead', 'l1'], ['leads', { page: 1 }], ['timeline', 'LEAD', 'l1']]) {
      queryClient.setQueryDefaults(key, { gcTime: Infinity });
      queryClient.setQueryData(key, { seeded: true });
    }

    await user.type(screen.getByPlaceholderText('Subject'), 'Your quote');
    await user.type(screen.getByPlaceholderText(/email daniel cohen/i), 'Hello there');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/communication/emails', {
        to: 'daniel@example.test',
        subject: 'Your quote',
        body: ['Hello there'],
        lead_id: 'l1',
      }),
    );
    await waitFor(() => expect(queryClient.getQueryState(['lead', 'l1'])?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(['leads', { page: 1 }])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['timeline', 'LEAD', 'l1'])?.isInvalidated).toBe(true);
    // The Spider draft's mark-read rides the Text path only.
    expect(onSent).not.toHaveBeenCalled();
  });

  it('names no email provider or other vendor', async () => {
    identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    await openEmailMode();
    await screen.findByText('Sending as');
    expect(document.body.innerHTML).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|stripe|twilio/i);
  });
});
