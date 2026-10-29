import type { SortingState } from '@tanstack/react-table';

/**
 * Default sort for the Customers list: newest customers first (issue #420).
 *
 * `created_at` matches the backend parseSortParams allowlist; `created` would
 * be rejected. Shared by the legacy list page and its /v2 rebuild so the two
 * cannot open on a different order.
 */
export const DEFAULT_CUSTOMERS_SORTING: SortingState = [{ id: 'created_at', desc: true }];
