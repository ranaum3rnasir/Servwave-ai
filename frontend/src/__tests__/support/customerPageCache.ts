/**
 * The customer page's cached queries, for the visit-write refresh suites (visits-and-task-categories
 * slice 01). A visit write must leave every one of these stale, so navigating back to the customer
 * page refetches them instead of serving the five-minute-old copy.
 */
import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { customerListPageKey } from '@/pages/v2/customers/useCustomerListPage';

export const CUSTOMER_ID = 'cust-1';

/**
 * The queries the routed customer page (pages/v2/customers/CustomerDetailPage) reads that show a
 * visit. Its Events list (`customer-calendar-entries`) is not one: a calendar entry has no job,
 * lead or visit behind it, and calendar-entry writes refresh it themselves (code review #11).
 */
export const CUSTOMER_PAGE_KEYS = [
  ['customer', CUSTOMER_ID],
  // The paged Jobs and Leads tabs (slice 06): a page past the first must go stale too.
  customerListPageKey('customer-leads', CUSTOMER_ID, 2, 20),
  customerListPageKey('customer-jobs', CUSTOMER_ID, 3, 20),
  // The per-visit schedule feed (slices 04/05): only the Schedule tab reads it (the Jobs and Leads
  // tabs take their server-side dates from their own paged endpoints above), so a visit write must
  // leave it stale.
  ['customer-schedule', CUSTOMER_ID],
] as const;

/**
 * Caches the customer page's data the way navigating away from it leaves it: fresh, unobserved,
 * and kept (the test client's gcTime of 0 would otherwise drop an unobserved query at once).
 */
export function seedCustomerPage(qc: QueryClient) {
  for (const key of CUSTOMER_PAGE_KEYS) {
    qc.setQueryDefaults(key, { gcTime: Infinity });
    qc.setQueryData(key, { seeded: true });
  }
}

export async function expectCustomerPageStale(qc: QueryClient) {
  await waitFor(() => {
    for (const key of CUSTOMER_PAGE_KEYS) {
      expect(qc.getQueryState(key)?.isInvalidated, `${key[0]} should be stale`).toBe(true);
    }
  });
}
