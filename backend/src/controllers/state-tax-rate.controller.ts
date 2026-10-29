import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

/**
 * The tax-rate picker feed, read by every ReceiptCard tax dropdown (estimates, invoices, jobs).
 *
 * 2026-08-05: an org now owns its own copy of the state list in `org_tax_rates` and chooses which
 * rows appear here, so this returns the org's VISIBLE rates rather than every global state plus
 * the org's extras. The response shape is unchanged - {state_code, state_name, tax_rate} - so no
 * picker needed a change. A rate the org has hidden but already applied to a document still
 * renders, because ReceiptCard falls back to "Custom rate (X%)" for a rate it cannot match.
 *
 * Settings reads GET /api/org-tax-rates instead, which returns hidden rows too.
 */
export async function list(req: Request, res: Response) {
  try {
    const orgRates = await prisma.orgTaxRate.findMany({
      where: { organization_id: req.user!.organization_id },
      orderBy: { name: 'asc' },
    });

    // An org created before the backfill has no rows of its own; hand it the global list so it
    // never faces an empty picker. Having rows but hiding every one of them is a deliberate
    // choice rather than this case, so it deliberately does not fall back.
    if (orgRates.length === 0) {
      const rates = await prisma.stateTaxRate.findMany({ orderBy: { state_name: 'asc' } });
      res.json({ data: rates });
      return;
    }

    const data = orgRates
      .filter((r) => r.is_visible)
      .map((r) => ({
        id: r.id,
        // A seeded row keeps its real 2-letter code so matchTaxRateState can still tie a
        // document's service state to it; a hand-made rate has none, and `CUSTOM-<id>` can never
        // collide with a real state code.
        state_code: r.state_code ?? `CUSTOM-${r.id}`,
        state_name: r.name,
        tax_rate: r.rate,
      }));

    res.json({ data });
  } catch (err) {
    logger.error('Failed to list state tax rates:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
