// Slice 6 FE — SMS composer gating + delivery-status bubbles (§5.4 + addendum §A.6/§B).
//
// Contract under test:
//   • The disabled composer shows ONE muted banner naming the SPECIFIC blocker:
//     !connected → "connect your phone system"; connected && !smsReady → "A2P
//     approval pending"; connected + ready but no sms_enabled number → "buy one
//     in the Numbers tab".
//   • connected + smsReady + an SMS-capable number → composer enabled, no
//     banner; drafts over 160 chars show a muted live segment hint
//     ("{n} segments", ceil(len/160)).
//   • failed messages surface a danger-token "Failed to send" indicator with a
//     tooltip (notify rose stays badge-count-only).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000077';

const CUSTOMER_THREAD: MessageThread = {
  id: 'thr_test_customer',
  customerId: CUSTOMER_ID,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    {
      id: 'mt1',
      direction: 'out',
      body: 'Confirmed: Thu 8:00 AM.',
      ts: '2026-07-09T14:00:00Z',
      status: 'delivered',
    },
    {
      id: 'mt2',
      direction: 'out',
      body: 'This one bounced.',
      ts: '2026-07-09T14:05:00Z',
      status: 'failed',
    },
  ],
};

// An owned, texting-capable number (wire shape of GET /api/communication/numbers).
const SMS_NUMBER = {
  id: 'num-1',
  e164: '+15512827064',
  sms_enabled: true,
  created_at: '2026-07-01T00:00:00Z',
};

function mockOrg(
  org: Record<string, unknown>,
  numbers: Array<Record<string, unknown>> = [],
) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: org };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    if (url === '/api/communication/numbers') return { data: { numbers } };
    return { data: {} };
  });
}

const BANNER_CONNECT = 'Text messaging activates when your phone system is connected.';
const BANNER_A2P =
  'Texting activates once the A2P campaign is approved — check status in Settings → Phone & SMS.';
const BANNER_NO_NUMBER = 'No SMS-capable number — buy one in the Numbers tab.';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SmsInboxView — composer gating', () => {
  it('disables the composer with the connect banner when the org is not connected', async () => {
    mockOrg({ phone_connected: false, ctm_account_id: null, ctm_sms_ready: false });
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    expect(await screen.findByText(BANNER_CONNECT)).toBeInTheDocument();
    expect(screen.getAllByText(BANNER_CONNECT)).toHaveLength(1);
    expect(screen.getByPlaceholderText('Type an SMS reply…')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  // The deprecated `ctm_account_id` key (true/null, kept one ship for old
  // bundles) is never read: the composer follows `phone_connected`.
  it('disables the composer when phone_connected is false, even if the old key is truthy', async () => {
    mockOrg({ phone_connected: false, ctm_account_id: true, ctm_sms_ready: true }, [SMS_NUMBER]);
    const { queryClient } = renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    // The connect banner is also what shows before the org has loaded, so wait
    // for the org record to arrive before reading the gate.
    await waitFor(() => expect(queryClient.getQueryState(['organization'])?.status).toBe('success'));
    expect(screen.getByText(BANNER_CONNECT)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type an SMS reply…')).toBeDisabled();
  });

  it('shows the A2P-approval banner when connected but smsReady is false', async () => {
    mockOrg({ phone_connected: true, ctm_account_id: true, ctm_sms_ready: false });
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    expect(await screen.findByText(BANNER_A2P)).toBeInTheDocument();
    expect(screen.queryByText(BANNER_CONNECT)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type an SMS reply…')).toBeDisabled();
  });

  it('shows the buy-a-number banner when connected + ready but no number can text', async () => {
    mockOrg({ phone_connected: true, ctm_account_id: true, ctm_sms_ready: true }, [
      { ...SMS_NUMBER, sms_enabled: false },
    ]);
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    expect(await screen.findByText(BANNER_NO_NUMBER)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type an SMS reply…')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('enables the composer with no banner when connected + smsReady + an SMS number', async () => {
    mockOrg({ phone_connected: true, ctm_account_id: true, ctm_sms_ready: true }, [SMS_NUMBER]);
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    // The gate opens once the org + numbers queries resolve.
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.queryByText(BANNER_CONNECT)).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_A2P)).not.toBeInTheDocument();
    expect(screen.queryByText(BANNER_NO_NUMBER)).not.toBeInTheDocument();
  });
});

describe('SmsInboxView — segment hint', () => {
  it('shows "{n} segments" (ceil(len/160)) once the draft passes 160 chars', async () => {
    mockOrg({ phone_connected: true, ctm_account_id: true, ctm_sms_ready: true }, [SMS_NUMBER]);
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    fireEvent.change(input, { target: { value: 'x'.repeat(160) } });
    expect(screen.queryByText(/segments/)).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'x'.repeat(161) } });
    expect(screen.getByText('2 segments')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'x'.repeat(500) } });
    expect(screen.getByText('4 segments')).toBeInTheDocument();
  });
});

describe('SmsInboxView — failed delivery bubbles', () => {
  it('marks a failed message with a danger indicator + tooltip', async () => {
    mockOrg({ phone_connected: true, ctm_account_id: true, ctm_sms_ready: true }, [SMS_NUMBER]);
    renderWithProviders(
      <SmsInboxView threads={[CUSTOMER_THREAD]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    const indicator = await screen.findByText('Failed to send');
    expect(indicator).toHaveAttribute('title');
    expect(indicator.className).toContain('text-danger');
    // Delivered messages carry no failure indicator.
    expect(screen.getAllByText('Failed to send')).toHaveLength(1);
  });
});
