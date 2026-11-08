import type { CustomerKind } from '@prisma/client';

const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * Unified-client-creation identity gate (spec §2): a customer needs a first
 * name OR a company name. Shared by customer/lead/job create (and the
 * customer update kind-re-derivation) so the rule can't drift between them.
 */
export function hasNameOrCompany(d: { first_name?: string | null; company_name?: string | null }): boolean {
  return hasText(d.first_name) || hasText(d.company_name);
}

/**
 * `kind` is a derived, silent DB classification (spec §2) — NEVER accepted
 * from the client. `company_name` present (non-blank) makes the customer a
 * COMPANY; otherwise PERSON. A first_name presence never overrides a
 * company_name — company wins.
 */
export function deriveCustomerKind(d: { first_name?: string | null; company_name?: string | null }): CustomerKind {
  return hasText(d.company_name) ? 'COMPANY' : 'PERSON';
}
