import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  useStripeStatus,
  useConnectStripe,
  useStripeAccountSession,
  useAcceptPaymentsTerms,
  useStripeAccountLink,
  type StripeStatus,
} from './organization';

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

const baseStatus: StripeStatus = {
  stripe_account_id: 'acct_123',
  stripe_charges_enabled: true,
  stripe_payouts_enabled: false,
  stripe_details_submitted: true,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  platform_fee_bps: 50,
  collected_awaiting_payout: 12000,
};

describe('useStripeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches GET /api/organization/stripe/status and returns the status', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: baseStatus });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStripeStatus(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.get).toHaveBeenCalledWith('/api/organization/stripe/status');
    expect(result.current.data).toEqual(baseStatus);
  });
});

describe('useConnectStripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs /api/organization/stripe/connect and invalidates the organization query', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { stripe_account_id: 'acct_456' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useConnectStripe(), { wrapper: wrapper(qc) });

    const response = await result.current.mutateAsync();

    expect(api.post).toHaveBeenCalledWith('/api/organization/stripe/connect');
    expect(response).toEqual({ stripe_account_id: 'acct_456' });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organization'] }));
  });

  it('settles into an error state on failure (onError toasts, mutateAsync still rejects)', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('network down'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useConnectStripe(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync()).rejects.toThrow('network down');
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useStripeAccountSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs /api/organization/stripe/account-session and returns the client secret', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { client_secret: 'seti_123_secret' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStripeAccountSession(), { wrapper: wrapper(qc) });

    const response = await result.current.mutateAsync();

    expect(api.post).toHaveBeenCalledWith('/api/organization/stripe/account-session');
    expect(response).toEqual({ client_secret: 'seti_123_secret' });
  });

  it('propagates a 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED failure untouched (no onError swallow)', async () => {
    const err = Object.assign(new Error('Forbidden'), {
      response: {
        status: 403,
        data: { code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED', error: 'Accept the ServWave Payments Terms to continue.' },
      },
    });
    vi.mocked(api.post).mockRejectedValue(err);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStripeAccountSession(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync()).rejects.toBe(err);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as typeof err).response.data.code).toBe('PAYMENTS_TERMS_ACCEPTANCE_REQUIRED');
  });
});

describe('useAcceptPaymentsTerms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs /api/organization/stripe/accept-terms with accepted+authority_attested and invalidates organization', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { accepted: true, terms_version: 3 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAcceptPaymentsTerms(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync();

    expect(api.post).toHaveBeenCalledWith('/api/organization/stripe/accept-terms', {
      accepted: true,
      authority_attested: true,
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['organization'] }));
  });
});

describe('useStripeAccountLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs /api/organization/stripe/account-link and returns the hosted onboarding url', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { url: 'https://connect.stripe.com/setup/xyz' } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useStripeAccountLink(), { wrapper: wrapper(qc) });

    const response = await result.current.mutateAsync();

    expect(api.post).toHaveBeenCalledWith('/api/organization/stripe/account-link');
    expect(response).toEqual({ url: 'https://connect.stripe.com/setup/xyz' });
  });
});
