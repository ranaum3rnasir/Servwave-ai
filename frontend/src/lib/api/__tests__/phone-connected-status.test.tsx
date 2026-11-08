/// <reference types="@testing-library/jest-dom/vitest" />
// Whether the org's phone service is set up comes from the server-computed
// `phone_connected` on GET /api/organization. The phone account id itself never
// reaches the browser (Ran: "the account ID cannot be exposed").
//
// The frontend (Vercel) and backend (Render) deploy about two minutes apart in
// no fixed order, so for one ship a new bundle can meet an OLD backend, which
// sends no `phone_connected` and the real id in `ctm_account_id`. Only then is
// the old key consulted; whenever `phone_connected` is present it wins.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useCalls, useCtmStatus, useMessageThreads } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const org = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: org.current }),
}));
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => true }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <AbilityProvider ability={communicationSectionAbility()}>{children}</AbilityProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockApi.get.mockResolvedValue({ data: {} });
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000001', role: 'ADMIN', org_features: ['phone', 'email'] },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
});

describe('useCtmStatus follows phone_connected', () => {
  it.each([
    ['set up, texting approved', { phone_connected: true, ctm_sms_ready: true }, { connected: true, smsReady: true }],
    ['set up, texting pending', { phone_connected: true, ctm_sms_ready: false }, { connected: true, smsReady: false }],
    ['not set up', { phone_connected: false, ctm_sms_ready: true }, { connected: false, smsReady: false }],
    // The deprecated key says "set up", phone_connected says not: the page follows phone_connected.
    ['not set up, old key still truthy', { phone_connected: false, ctm_account_id: true, ctm_sms_ready: true }, { connected: false, smsReady: false }],
    // An old backend: no phone_connected at all.
    ['old backend, account set', { ctm_account_id: '123', ctm_sms_ready: true }, { connected: true, smsReady: true }],
    ['old backend, no account', { ctm_account_id: null, ctm_sms_ready: true }, { connected: false, smsReady: false }],
    // The texting flag's neutral key. The new backend sends `sms_ready` and the
    // deprecated `ctm_sms_ready` with the same value; `sms_ready` alone must
    // be enough (once the alias goes), and it wins whenever it is present.
    ['texting approved, neutral key only', { phone_connected: true, sms_ready: true }, { connected: true, smsReady: true }],
    ['texting pending, neutral key only', { phone_connected: true, sms_ready: false }, { connected: true, smsReady: false }],
    ['neutral key wins over a stale old key', { phone_connected: true, sms_ready: false, ctm_sms_ready: true }, { connected: true, smsReady: false }],
  ])('%s', (_label, body, expected) => {
    org.current = body;
    const { result } = renderHook(() => useCtmStatus(), { wrapper });
    expect(result.current).toEqual(expected);
  });
});

describe('live polling runs only while the phone service is set up', () => {
  const intervalOf = (key: string[]) =>
    (client.getQueryCache().find({ queryKey: key })?.options as { refetchInterval?: unknown } | undefined)
      ?.refetchInterval;

  it('polls the call log and the threads every 20s when phone_connected is true', async () => {
    org.current = { phone_connected: true, ctm_sms_ready: true };
    renderHook(() => { useCalls(); useMessageThreads(); }, { wrapper });

    await waitFor(() => expect(intervalOf(['communication', 'calls'])).toBe(20_000));
    expect(intervalOf(['communication', 'threads'])).toBe(20_000);
  });

  it('does not poll when phone_connected is false, whatever the old key says', async () => {
    org.current = { phone_connected: false, ctm_account_id: true };
    renderHook(() => { useCalls(); useMessageThreads(); }, { wrapper });

    await waitFor(() => expect(client.getQueryCache().find({ queryKey: ['communication', 'calls'] })).toBeDefined());
    expect(intervalOf(['communication', 'calls'])).toBe(false);
    expect(intervalOf(['communication', 'threads'])).toBe(false);
  });
});
