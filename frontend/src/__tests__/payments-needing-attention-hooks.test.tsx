/**
 * Payments go-live slice 11, re-homed in P8. "Payments needing attention" left Settings for the Payments page's Needs
 * attention card (P7). What stays here is the two row actions the card still uses, tested through their hooks: Refund
 * sends the money back and the server's row comes back; Mark resolved closes a row with no money moving; a refund the
 * server could not send surfaces ServWave's own wording, never the processor's name. The Settings list hook is gone.
 *
 * The card-side assertions that used to live here are written against P7's card in
 * pages/v2/payments/__tests__/AttentionCardLessons.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import api from '@/lib/axios';
import * as attention from '@/lib/api/paymentsNeedingAttention';
import { extractApiError } from '@/lib/utils';

const mockApi = vi.mocked(api);

const ENDPOINT = '/api/payments-needing-attention';

const OPEN_PAYMENT = {
  id: 'uc-1',
  kind: 'PAYMENT' as const,
  reason: 'INVOICE_NOT_PAYABLE',
  amount: 120,
  status: 'OPEN' as const,
  created_at: '2026-10-05T15:30:00.000Z',
  refunded_at: null,
  invoice: { id: 'inv-1', invoice_number: 'INV-1001' },
  can_refund: true,
  can_resolve: true,
};
const STRAY_REFUND = { ...OPEN_PAYMENT, id: 'uc-2', kind: 'REFUND' as const, reason: 'REFUND_UNMATCHED', amount: 42, invoice: null, can_refund: false };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe('the Settings list is gone', () => {
  it('no hook lists payments needing attention for the Settings page any more', () => {
    expect('usePaymentsNeedingAttention' in attention).toBe(false);
  });

  it('keeps the two row actions the Needs attention card uses', () => {
    expect(typeof attention.useRefundPaymentNeedingAttention).toBe('function');
    expect(typeof attention.useResolvePaymentNeedingAttention).toBe('function');
  });
});

describe('Refund', () => {
  it('posts to the row\'s refund route and returns the row the server sends back', async () => {
    const refunded = { ...OPEN_PAYMENT, status: 'REFUNDED', can_refund: false, refunded_at: '2026-10-07T10:00:00.000Z' };
    mockApi.post.mockResolvedValue({ data: { item: refunded } });
    const { result } = renderHook(() => attention.useRefundPaymentNeedingAttention(), { wrapper: wrapper() });

    let row: unknown;
    await act(async () => { row = await result.current.mutateAsync('uc-1'); });

    expect(mockApi.post).toHaveBeenCalledWith(`${ENDPOINT}/uc-1/refund`);
    expect(row).toEqual(refunded);
  });

  it('a refund that could not be sent surfaces the server\'s ServWave wording, with no processor name', async () => {
    const message = "This refund couldn't be sent through ServWave Payments. Try again in a moment, or contact ServWave support.";
    mockApi.post.mockRejectedValue({ isAxiosError: true, response: { status: 502, data: { error: message } } });
    const { result } = renderHook(() => attention.useRefundPaymentNeedingAttention(), { wrapper: wrapper() });

    await act(async () => { await result.current.mutateAsync('uc-1').catch(() => undefined); });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const shown = extractApiError(result.current.error, 'Could not refund.');
    expect(shown).toBe(message);
    expect(shown).not.toMatch(/stripe/i);
  });
});

describe('Mark resolved', () => {
  it('posts to the row\'s resolve route and returns the resolved row, with nothing left to do', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { ...STRAY_REFUND, status: 'RESOLVED', can_resolve: false } } });
    const { result } = renderHook(() => attention.useResolvePaymentNeedingAttention(), { wrapper: wrapper() });

    let row: { status: string; can_resolve: boolean } | undefined;
    await act(async () => { row = await result.current.mutateAsync('uc-2') as never; });

    expect(mockApi.post).toHaveBeenCalledWith(`${ENDPOINT}/uc-2/resolve`);
    expect(row).toMatchObject({ status: 'RESOLVED', can_resolve: false });
  });
});
