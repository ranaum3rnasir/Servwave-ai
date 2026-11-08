import type { Prisma, CustomerKind, CustomerSegment } from '@prisma/client';
import { allocateNumber } from './numbering';
import { deriveCustomerKind } from './customer-kind';

/**
 * Single source of truth for the Customer columns that are NOT-NULL with no DB
 * default: `customer_number` (per-org app-allocated sequence), `kind`, and
 * `segment`. Omitting any of them makes `customer.create` throw against a real
 * database (→ a 500 that mocked unit tests never catch).
 *
 * `kind` is ALWAYS server-derived from `first_name`/`company_name` (see
 * `deriveCustomerKind`) — any client-supplied `kind` on `data` is ignored
 * (unified-client-creation §5.1).
 *
 * Both customer-creation paths route through here so they can't drift apart:
 *   - POST /api/customers          (customer.controller.ts)
 *   - inline new_customer on a lead/job (lead.controller.ts / job.controller.ts)
 *
 * Call inside the same `$transaction` as the `customer.create` so the number
 * allocation rolls back with the row if the surrounding insert fails.
 */
export async function withRequiredCustomerFields<T extends Record<string, unknown>>(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: T,
): Promise<T & {
  organization_id: string;
  customer_number: string;
  kind: CustomerKind;
  segment: CustomerSegment;
}> {
  const customer_number = await allocateNumber(tx, 'customer', orgId);
  return {
    ...data,
    organization_id: orgId,
    customer_number,
    kind: deriveCustomerKind(data as { first_name?: string | null; company_name?: string | null }),
    segment: (data.segment ?? 'RESIDENTIAL') as CustomerSegment,
  };
}
