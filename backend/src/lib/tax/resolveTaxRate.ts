import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Org-owned tax rates (2026-08-05). Every org holds its own copy of the global state list in
 * `org_tax_rates` and may correct any row, so the org's row is the authority and
 * `state_tax_rates` is only the seed source + fallback.
 *
 * This is the single lookup behind every derivation site (estimate create/re-point, invoice
 * create + tax-location change, service-plan activate/renew), so the org-first fallback exists
 * once rather than four times.
 *
 * `is_visible` is deliberately NOT part of the lookup: hiding a rate filters the picker in
 * Settings, and must never be able to silently under-charge tax on an out-of-state job.
 */
export async function resolveTaxRateForState(
  client: Prisma.TransactionClient | typeof prisma,
  organizationId: string,
  state: string | null | undefined,
): Promise<number> {
  const code = state?.trim().toUpperCase();
  if (!code) return 0;

  const orgRow = await client.orgTaxRate.findFirst({
    where: { organization_id: organizationId, state_code: code },
  });
  if (orgRow) return Number(orgRow.rate);

  const globalRow = await client.stateTaxRate.findFirst({ where: { state_code: code } });
  return globalRow ? Number(globalRow.tax_rate) : 0;
}
