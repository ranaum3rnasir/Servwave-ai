/**
 * #2090 slice 3d - the chosen/declined option names an approval notification and the customer's
 * approval email both carry.
 *
 * Four separate doors emit `estimate.approved` (the public approve, the internal approve, a
 * recorded full payment and the Stripe webhook) and each holds a differently-shaped `existing`
 * row. Rather than widening four selects, this loads the two columns the summary needs, once, and
 * hands back a data bag that is safe to spread into any of them.
 *
 * The derivation itself lives in `estimate-document-view.ts` and is the DOCUMENT's own: what the
 * PDF prints beside "Optional (not included)" is what the email calls declined.
 */
import { prisma } from '../prisma';
import { logger } from '../logger';
import { summariseEstimateOptions, type OptionSummary } from '../estimate-document-view';

export type { OptionSummary };

const EMPTY: OptionSummary = { chosen: [], declined: [] };

/** The estimate's add-ons, split by whether the customer took them. Never throws. */
export async function loadOptionSummary(estimateId: string): Promise<OptionSummary> {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      select: {
        scopes: true,
        line_items: {
          select: { description: true, is_optional: true, is_selected: true },
          orderBy: { sequence: 'asc' },
        },
      },
    });
    if (!estimate) return EMPTY;
    return summariseEstimateOptions(estimate);
  } catch (err) {
    // A notification that cannot name the options is still a notification worth sending, and an
    // approval is not worth failing over a list of add-ons.
    logger.error(`Failed to summarise options for estimate ${estimateId}:`, err);
    return EMPTY;
  }
}

/**
 * The same summary as notification `data` keys. An empty list is OMITTED rather than sent as an
 * empty string: `templates.ts`'s `s()` treats an empty string as absent anyway, and an estimate
 * that offered no add-ons must produce exactly the body it produced before this existed.
 */
export function optionSummaryData(summary: OptionSummary): {
  options_chosen?: string;
  options_declined?: string;
} {
  return {
    ...(summary.chosen.length > 0 ? { options_chosen: summary.chosen.join(', ') } : {}),
    ...(summary.declined.length > 0 ? { options_declined: summary.declined.join(', ') } : {}),
  };
}

/** Load and shape in one step, for the four `estimate.approved` emit sites. */
export async function loadOptionSummaryData(estimateId: string) {
  return optionSummaryData(await loadOptionSummary(estimateId));
}
