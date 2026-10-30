import type { FacetConfig } from '@/lib/filters/types';

/**
 * Payments page facets (payments go-live P6). The `param` of each facet is the wire contract with
 * `backend/src/lib/query/registries/payment.filters.ts` (a parity test reads both): `status`, `method`,
 * `payout_status`, and `amount` -> `amount_min` / `amount_max`.
 *
 * There is NO date facet: time is the period picker only. The quick chips (`chip` param) are the page's own and are not
 * facets, so they are not in this list.
 *
 * Module-level const, as `useFilterState` requires a stable reference.
 */
export const paymentsRegistry: FacetConfig[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    label: 'Status',
    // lucide ListChecks, as every other registry's Status facet.
    icon: 'M13 5H21 M13 12H21 M13 19H21 M3 17L5 19L9 15 M3 7L5 9L9 5',
    options: [
      { value: 'succeeded', label: 'Succeeded' },
      { value: 'pending', label: 'Pending' },
      { value: 'failed', label: 'Failed' },
      { value: 'refunded', label: 'Refunded' },
      { value: 'partially_refunded', label: 'Partially refunded' },
      { value: 'disputed', label: 'Disputed' },
      { value: 'refund_failed', label: 'Refund failed' },
      // The API sends both; a real state is never hidden (V7 C-23).
      { value: 'charged_back', label: 'Charged back' },
      { value: 'voided', label: 'Voided' },
    ],
  },
  {
    key: 'amount',
    kind: 'range',
    param: 'amount',
    label: 'Amount',
    // lucide Banknote, as Invoices' Total facet.
    icon: 'M4 6H20A2 2 0 0 1 22 8V16A2 2 0 0 1 20 18H4A2 2 0 0 1 2 16V8A2 2 0 0 1 4 6Z M14 12A2 2 0 1 1 10 12A2 2 0 1 1 14 12Z M6 12H6.01 M18 12H18.01',
    money: true,
    min: 0,
    maxSource: 'payments.maxAmount',
  },
  {
    key: 'method',
    kind: 'multi',
    param: 'method',
    label: 'Method',
    // lucide CreditCard.
    icon: 'M4 5H20A2 2 0 0 1 22 7V17A2 2 0 0 1 20 19H4A2 2 0 0 1 2 17V7A2 2 0 0 1 4 5Z M2 10H22',
    options: [
      { value: 'CARD', label: 'Credit card' },
      { value: 'ACH', label: 'Bank (ACH)' },
    ],
  },
  {
    key: 'payout_status',
    kind: 'multi',
    param: 'payout_status',
    label: 'Payout status',
    // lucide Landmark.
    icon: 'M3 22H21 M6 18V11 M10 18V11 M14 18V11 M18 18V11 M12 2L20 7H4Z',
    options: [
      { value: 'awaiting', label: 'Awaiting payout' },
      { value: 'in_transit', label: 'In transit' },
      { value: 'paid', label: 'Paid out' },
      { value: 'failed', label: 'Payout failed' },
    ],
  },
];
