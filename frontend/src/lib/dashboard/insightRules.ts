import type { DashboardResponse } from '@/lib/api/dashboard';

export interface Insight {
  id: string;
  icon: string;
  tone: 'danger' | 'info' | 'success';
  text: string;
  cta_label: string;
  link: string;
  weight: number;
}

const fmt = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${n}`;

/**
 * Deterministic, rule-based "smart insights". Pure function over the dashboard
 * payload — no AI model. Returns the top 3 by weight (severity / $ impact).
 */
export function computeInsights(d: DashboardResponse): Insight[] {
  const out: Insight[] = [];
  const ar = d.kpis?.ar;
  const close_rate = d.kpis?.close_rate;

  const pastDue = (ar?.over_30 ?? 0) + (ar?.over_60 ?? 0);
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

  const topSource = [...(d.lead_sources ?? [])].sort((a, b) => b.lead_pct - a.lead_pct)[0];
  if (topSource) {
    out.push({
      id: 'top_source',
      icon: '📈',
      tone: 'success',
      weight: topSource.revenue,
      text: `${topSource.label} = ${topSource.lead_pct}% of leads. Worth scaling spend.`,
      cta_label: 'See lead sources',
      link: '/leads',
    });
  }

  if ((close_rate?.rate ?? 0) > 0) {
    const pp = close_rate?.vs_last_period_pp ?? 0;
    out.push({
      id: 'pipeline_nudge',
      icon: '📄',
      tone: 'info',
      weight: 1,
      text: `Close rate ${close_rate?.rate ?? 0}% (${pp >= 0 ? '+' : ''}${pp}pp). Send pending estimates to keep it climbing.`,
      cta_label: 'Go to estimates',
      link: '/estimates',
    });
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}
