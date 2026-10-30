import { useMutation } from '@tanstack/react-query';

import api from '@/lib/axios';

/**
 * "Payments needing attention" (payments go-live slice 11): money ServWave took but could not apply
 * to an invoice, with a one-click refund. Its list left Settings for the Payments page (P8/P7); what stays here is the
 * two row actions that page's card uses.
 */
export type AttentionStatus = 'OPEN' | 'REFUNDED' | 'RESOLVED';

export interface PaymentNeedingAttention {
  id: string;
  /** PAYMENT: money that came in. REFUND: a refund that went out for a payment ServWave never recorded. */
  kind: 'PAYMENT' | 'REFUND';
  /** Why it was not applied (UnappliedCaptureReason on the server). */
  reason: string;
  /** In dollars; null when the amount is not known. */
  amount: number | null;
  status: AttentionStatus;
  created_at: string;
  refunded_at: string | null;
  /** The invoice's status says why it could not take the payment (PAID, VOIDED, or neither). */
  invoice: { id: string; invoice_number: string; status?: string } | null;
  can_refund: boolean;
  /** An open row a person can close as dealt with another way. */
  can_resolve: boolean;
}

const ENDPOINT = '/api/payments-needing-attention';


/** One row action: post it and hand back the row the server returns (the card owns what to do with it). */
function useRowAction(action: 'refund' | 'resolve') {
  return useMutation({
    mutationFn: (id: string) => api.post(`${ENDPOINT}/${id}/${action}`).then((r) => r.data.item as PaymentNeedingAttention),
  });
}

/** Send money back: all of it, or `amount` of it (a partial leaves the item open with what is left). */
export function useRefundPaymentNeedingAttention() {
  return useMutation({
    mutationFn: ({ id, amount }: { id: string; amount?: number }) =>
      api.post(`${ENDPOINT}/${id}/refund`, amount == null ? undefined : { amount }, { silentErrors: true })
        .then((r) => r.data.item as PaymentNeedingAttention),
  });
}

/** Record the money on an open invoice that can take all of it. The server refuses anything else (409, with a sentence). */
export function useAttachPaymentNeedingAttention() {
  return useMutation({
    mutationFn: ({ id, invoiceId }: { id: string; invoiceId: string }) =>
      api.post(`${ENDPOINT}/${id}/attach`, { invoice_id: invoiceId }, { silentErrors: true })
        .then((r) => r.data as { item: PaymentNeedingAttention; invoice: { id: string; number?: string; status?: string } }),
  });
}

/** Close a row a person dealt with another way. Moves no money. */
export function useResolvePaymentNeedingAttention() {
  return useRowAction('resolve');
}
