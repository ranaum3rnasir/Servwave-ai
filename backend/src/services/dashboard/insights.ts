import { closeRateOver, leadSourceRows } from './workTiles';
import { arBuckets, openInvoices } from './moneyTiles';
import { linkInsights } from '../../lib/dashboard/clickTargets';
import type { DashContext } from './context';

/**
 * Smart Insights (PRD 9): the dashboard's rule-based advice, built on the server from the company's unpaid balance, close
 * rate and lead sources. It is a Company figures tile (business advice built on company money), so only a person who
 * holds See company figures is given it, and it reads the whole company whichever other tiles the person shows. No
 * model: the same three deterministic rules the browser used to run, with the same wording and the same links.
 */

export interface Insight {
  id: string;
  icon: string;
  tone: 'danger' | 'info' | 'success';
  text: string;
  cta_label: string;
  /** The card's list page, or null when the person may not open it (the card is then not clickable). */
  link: string | null;
  weight: number;
}

const fmt = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`);

/** The rules over their three inputs. Pure: the top 3 by weight (severity / dollar impact). */
export function insightsFrom(input: {
  ar: { over_30: number; over_60: number };
  closeRate: { rate: number; vs_last_period_pp: number };
  leadSources: { label: string; lead_pct: number; revenue: number }[];
}): Insight[] {
  const out: Insight[] = [];

  const pastDue = input.ar.over_30 + input.ar.over_60;
  if (pastDue > 0) {
    out.push({
      id: 'past_due_ar',
      icon: '💰',
      tone: 'danger',
      weight: pastDue,
      text: `${fmt(pastDue)} past due. The 60+ bucket is your biggest cash lever.`,
      cta_label: 'Review unpaid invoices',
      link: '/invoices',
    });
  }

  const topSource = [...input.leadSources].sort((a, b) => b.lead_pct - a.lead_pct)[0];
  if (topSource) {
    out.push({
      id: 'top_source',
      icon: '📈',
      tone: 'success',
      weight: topSource.revenue ?? 0,
      text: `${topSource.label} = ${topSource.lead_pct}% of leads. Worth scaling spend.`,
      cta_label: 'See lead sources',
      link: '/leads',
    });
  }

  if (input.closeRate.rate > 0) {
    const pp = input.closeRate.vs_last_period_pp;
    out.push({
      id: 'pipeline_nudge',
      icon: '📄',
      tone: 'info',
      weight: 1,
      text: `Close rate ${input.closeRate.rate}% (${pp >= 0 ? '+' : ''}${pp}pp). Send pending estimates to keep it climbing.`,
      cta_label: 'Go to estimates',
      link: '/estimates',
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

export async function smartInsights(ctx: DashContext): Promise<Insight[]> {
  const [open, closeRate, leadSources] = await Promise.all([
    openInvoices(ctx, {}),
    closeRateOver(ctx, {}),
    leadSourceRows(ctx, {}, {}),
  ]);
  return linkInsights(insightsFrom({ ar: arBuckets(open, ctx.b.now, ctx.timeZone), closeRate, leadSources }), ctx.values);
}
