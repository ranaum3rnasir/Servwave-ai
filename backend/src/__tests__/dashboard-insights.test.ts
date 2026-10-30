/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.1 - Smart Insights is built on the server (it moved here from the browser).
   The rules are the same three, with the same wording and links; the expected text is written out by hand.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { insightsFrom } from '../services/dashboard/insights';

const quiet = { ar: { over_30: 0, over_60: 0 }, closeRate: { rate: 0, vs_last_period_pp: 0 }, leadSources: [] };

describe('insightsFrom', () => {
  it('returns nothing when there is nothing to say', () => {
    expect(insightsFrom(quiet)).toEqual([]);
  });

  it('flags past-due unpaid invoices first when they are the biggest number, with the cash-lever wording and the invoices link', () => {
    const [first] = insightsFrom({ ...quiet, ar: { over_30: 8000, over_60: 4000 } });
    expect(first).toMatchObject({
      id: 'past_due_ar',
      tone: 'danger',
      text: '$12k past due. The 60+ bucket is your biggest cash lever.',
      cta_label: 'Review unpaid invoices',
      link: '/invoices',
      weight: 12000,
    });
  });

  it('emits no past-due insight when both aging buckets are zero', () => {
    expect(insightsFrom({ ...quiet, leadSources: [{ label: 'Google', lead_pct: 60, revenue: 10 }] }).some((i) => i.id === 'past_due_ar')).toBe(false);
  });

  it('names the biggest lead source by share, weighted by its revenue', () => {
    const insights = insightsFrom({
      ...quiet,
      leadSources: [{ label: 'Referral', lead_pct: 20, revenue: 900 }, { label: 'Google', lead_pct: 60, revenue: 500 }],
    });
    expect(insights).toEqual([
      { id: 'top_source', icon: '📈', tone: 'success', weight: 500, text: 'Google = 60% of leads. Worth scaling spend.', cta_label: 'See lead sources', link: '/leads' },
    ]);
  });

  it('nudges about the close rate with its signed change in points', () => {
    const [nudge] = insightsFrom({ ...quiet, closeRate: { rate: 40, vs_last_period_pp: -5 } });
    expect(nudge).toMatchObject({ id: 'pipeline_nudge', text: 'Close rate 40% (-5pp). Send pending estimates to keep it climbing.', link: '/estimates' });
    expect(insightsFrom({ ...quiet, closeRate: { rate: 40, vs_last_period_pp: 3 } })[0]!.text).toContain('(+3pp)');
  });

  it('returns at most three, heaviest first', () => {
    const insights = insightsFrom({
      ar: { over_30: 100, over_60: 0 },
      closeRate: { rate: 50, vs_last_period_pp: 1 },
      leadSources: [{ label: 'Google', lead_pct: 60, revenue: 5000 }, { label: 'Yelp', lead_pct: 10, revenue: 1 }],
    });
    expect(insights.map((i) => i.id)).toEqual(['top_source', 'past_due_ar', 'pipeline_nudge']);
  });
});
