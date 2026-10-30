/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.3 - the server sends each tile's, row's and stage's click target, or none.

   Seams: the tile catalog's eligibility function (`eligibleTiles`, whose answer now carries each tile's `link`), the
   click-target table (`clickTarget`, `canOpen`) and the pure helpers that put a target on a pipeline stage or a Smart
   Insights card. A person's switch values are built from the switch catalog (everything off, then the values under
   test), so no expected value is a copy of a rule: the paths are the app's own addresses, and the switches each page
   needs are read back from the routed guards that decide whether that page opens.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { insightsFrom } from '../services/dashboard/insights';
import { eligibleTiles } from '../lib/dashboard/tileCatalog';
import { CLICK_TARGETS, canOpen, clickTarget, linkPipelineStages, linkInsights, type ClickTargetKey } from '../lib/dashboard/clickTargets';
import { buildPipeline } from '../services/dashboard-metrics';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { presetValues } from '../lib/permissions/switches/store';

/** Every switch off (a choice at its narrowest, a list empty), then the named values laid over it. */
function person(values: Record<string, SwitchValue> = {}): Record<string, SwitchValue> {
  return { ...presetValues(null), ...values };
}
/** Everything a person could need on: every toggle on, then the named switches turned off. */
function everythingBut(...off: string[]): Record<string, SwitchValue> {
  return person({
    ...Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true])),
    ...Object.fromEntries(off.map((k) => [k, false])),
  });
}
const linkOf = (values: Record<string, SwitchValue>, id: string) => {
  const t = eligibleTiles(values).find((x) => x.id === id);
  expect(t, `${id} is eligible`).toBeDefined();
  return t!.link;
};

describe('the click-target table', () => {
  it('names only switches the switch catalog holds', () => {
    const keys = new Set(SWITCH_CATALOG.map((s) => s.key));
    for (const [name, target] of Object.entries(CLICK_TARGETS)) {
      expect(target.needs.length, name).toBeGreaterThan(0);
      for (const key of target.needs) expect(keys.has(key), `${name}:${key}`).toBe(true);
    }
  });

  it('asks for exactly the switches the routed guard of that page asks for', () => {
    // The route files are the source of truth for who may open a page: a list page's guard, a page's Access switch.
    const dir = join(__dirname, '../../../frontend/src/pages/v2/routes');
    const routes = readdirSync(dir).filter((f) => f.endsWith('.routes.tsx')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const guardOf = (path: string): string[] => {
      const at = routes.indexOf(`path="${path}"`);
      expect(at, `a route for ${path}`).toBeGreaterThan(-1);
      const guard = [...routes.slice(0, at).matchAll(/<RequirePageAccess all=\{\[([^\]]*)\]\}/g)].pop();
      return [...(guard?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    };
    for (const [name, target] of Object.entries(CLICK_TARGETS)) {
      // The report pages share one guard (`/reports/:slug`, Access Reports); /reports itself is guarded the same way.
      const route = target.path.startsWith('/reports/') ? '/reports/:slug' : target.path;
      expect([...target.needs].sort(), name).toEqual(guardOf(route).sort());
    }
  });

  it('is clickable only when every switch it needs is on', () => {
    for (const [name, target] of Object.entries(CLICK_TARGETS)) {
      expect(clickTarget(name as ClickTargetKey, everythingBut()), name).toBe(target.path);
      for (const key of target.needs) {
        expect(clickTarget(name as ClickTargetKey, everythingBut(key)), `${name} without ${key}`).toBeNull();
        expect(canOpen(name as ClickTargetKey, everythingBut(key)), `${name} without ${key}`).toBe(false);
      }
    }
  });
});

describe('the Payments page target (P9)', () => {
  it('opens /payments, with its attention-chip query, only with View payments and Show Payments page', () => {
    expect(CLICK_TARGETS.payments_page.path).toBe('/payments');
    expect(clickTarget('payments_page', everythingBut(), '?tab=payments&chip=attention')).toBe('/payments?tab=payments&chip=attention');
    expect(clickTarget('payments_page', everythingBut('view_payments'), '?tab=payments&chip=attention')).toBeNull();
    expect(clickTarget('payments_page', everythingBut('show_payments_page'), '?tab=payments&chip=attention')).toBeNull();
  });
});

describe('each tile carries the target its switches allow', () => {
  it('has no target for Close Rate, Collected Today, Unpaid Balance and Avg Ticket without Access Reports, and one with it', () => {
    const ids = ['kpi.close_rate', 'kpi.collected_today', 'kpi.ar', 'kpi.avg_ticket'];
    for (const id of ids) {
      expect(linkOf(everythingBut('access_reports'), id), id).toBeNull();
      expect(linkOf(everythingBut(), id), id).not.toBeNull();
    }
    expect(linkOf(everythingBut(), 'kpi.collected_today')).toBe('/reports/payments');
    expect(linkOf(everythingBut(), 'kpi.ar')).toBe('/reports/unpaid-invoices');
    expect(linkOf(everythingBut(), 'kpi.close_rate')).toBe('/reports/estimate-conversion');
    expect(linkOf(everythingBut(), 'kpi.avg_ticket')).toBe('/reports');
  });

  it('has no target for Monthly Revenue and its chart without Show Invoices page, and one with it', () => {
    for (const id of ['kpi.revenue_mtd', 'revenue_chart']) {
      expect(linkOf(everythingBut('show_invoices_page'), id), id).toBeNull();
      expect(linkOf(everythingBut(), id), id).toBe('/invoices');
    }
  });

  it('opens the lists for Jobs This Week, Open Leads and Deposits Awaiting when View and Show are both on', () => {
    expect(linkOf(everythingBut(), 'kpi.jobs_week')).toBe('/jobs');
    expect(linkOf(everythingBut(), 'kpi.open_leads')).toBe('/leads');
    expect(linkOf(everythingBut(), 'kpi.deposits')).toBe('/estimates');
    expect(linkOf(everythingBut('show_jobs_page'), 'kpi.jobs_week')).toBeNull();
    expect(linkOf(everythingBut('show_leads_page'), 'kpi.open_leads')).toBeNull();
    expect(linkOf(everythingBut('show_estimates_page'), 'kpi.deposits')).toBeNull();
  });

  it('opens the Jobs list filtered to Unscheduled from Unscheduled jobs, only with View jobs and Show Jobs page', () => {
    expect(linkOf(everythingBut(), 'unscheduled_jobs')).toBe('/jobs?status=UNSCHEDULED');
    expect(linkOf(everythingBut('show_jobs_page'), 'unscheduled_jobs')).toBeNull();
    // Without View jobs the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_jobs')).some((t) => t.id === 'unscheduled_jobs')).toBe(false);
  });

  it('opens the Jobs list filtered to the Office review queue from Office review queue, only with View jobs and Show Jobs page', () => {
    expect(linkOf(everythingBut(), 'office_review_queue')).toBe('/jobs?in_office_review=true');
    expect(linkOf(everythingBut('show_jobs_page'), 'office_review_queue')).toBeNull();
    expect(linkOf(everythingBut('view_jobs'), 'office_review_queue')).toBeNull();
    // Without Office review the tile is not offered at all.
    expect(eligibleTiles(everythingBut('office_review')).some((t) => t.id === 'office_review_queue')).toBe(false);
  });

  it('opens the Jobs list from Jobs this month, only with View jobs and Show Jobs page', () => {
    expect(linkOf(everythingBut(), 'jobs_this_month')).toBe('/jobs');
    expect(linkOf(everythingBut('show_jobs_page'), 'jobs_this_month')).toBeNull();
    // Without View jobs the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_jobs')).some((t) => t.id === 'jobs_this_month')).toBe(false);
  });

  it('opens the Jobs list from Completed jobs value, only with View jobs and Show Jobs page, carrying the Completed this month filter', () => {
    expect(linkOf(everythingBut(), 'completed_jobs_value')).toBe('/jobs?completed_this_month=true');
    expect(linkOf(everythingBut('show_jobs_page'), 'completed_jobs_value')).toBeNull();
    // Without View jobs the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_jobs')).some((t) => t.id === 'completed_jobs_value')).toBe(false);
  });

  it('opens the Estimates list filtered to Draft from Estimates still to send, only with View estimates and Show Estimates page', () => {
    expect(linkOf(everythingBut(), 'estimates_to_send')).toBe('/estimates?status=DRAFT');
    expect(linkOf(everythingBut('show_estimates_page'), 'estimates_to_send')).toBeNull();
    // Without View estimates the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_estimates')).some((t) => t.id === 'estimates_to_send')).toBe(false);
  });

  it('opens the Schedule\'s No crew filter from Missing crew, only with Access Schedule (View jobs and Show Jobs page do not decide it)', () => {
    expect(linkOf(everythingBut(), 'missing_crew')).toBe('/schedule?filter=no_crew');
    expect(linkOf(everythingBut('access_schedule'), 'missing_crew')).toBeNull();
    expect(linkOf(everythingBut('show_jobs_page'), 'missing_crew')).toBe('/schedule?filter=no_crew');
    // Without View jobs the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_jobs')).some((t) => t.id === 'missing_crew')).toBe(false);
  });

  it('opens the Leads list filtered to No owner from Missing lead owner, only with View leads and Show Leads page', () => {
    expect(linkOf(everythingBut(), 'missing_lead_owner')).toBe('/leads?assigned_to=NO_OWNER');
    expect(linkOf(everythingBut('show_leads_page'), 'missing_lead_owner')).toBeNull();
    // Without View leads the tile is not offered at all.
    expect(eligibleTiles(everythingBut('view_leads')).some((t) => t.id === 'missing_lead_owner')).toBe(false);
  });

  it('opens the Schedule from Jobs Today, Today\'s Schedule and Coming Up only with Access Schedule', () => {
    for (const id of ['kpi.jobs_today', 'schedule_today', 'coming_up']) {
      expect(linkOf(everythingBut(), id), id).toBe('/schedule');
      expect(linkOf(everythingBut('access_schedule'), id), id).toBeNull();
    }
  });

  it('opens the Jobs list from the scoreboards and Jobs by Status, the Reports page from Revenue by Job Type, the Service plans list from Recurring', () => {
    for (const id of ['tech_scoreboard', 'dispatch_scoreboard', 'jobs_by_status']) {
      expect(linkOf(everythingBut(), id), id).toBe('/jobs');
      expect(linkOf(everythingBut('show_jobs_page'), id), id).toBeNull();
    }
    expect(linkOf(everythingBut(), 'revenue_by_job_type')).toBe('/reports');
    expect(linkOf(everythingBut('access_reports'), 'revenue_by_job_type')).toBeNull();
    expect(linkOf(everythingBut(), 'kpi.recurring')).toBe('/service-plans');
    expect(linkOf(everythingBut('show_service_plans_page'), 'kpi.recurring')).toBeNull();
  });

  it('gives a tile whose rows carry their own targets, or that opens nothing, no tile-level target', () => {
    for (const id of ['smart_insights', 'needs_attention', 'pipeline', 'lead_sources', 'recent_activity', 'service_areas', 'recent_calls']) {
      const tile = eligibleTiles(everythingBut()).find((t) => t.id === id);
      expect(tile, id).toBeDefined();
      expect(tile!.link, id).toBeNull();
    }
  });
});

describe('a Revenue Pipeline stage carries the target of the list page it names', () => {
  const stages = buildPipeline({ leads: 1, estimatesAmount: 1, approvedAmount: 1, depositAmount: 1, jobAmount: 1, invoicedAmount: 1, paidAmount: 1 });
  const linkByKey = (values: Record<string, SwitchValue>) => Object.fromEntries(linkPipelineStages(stages, values).map((s) => [s.key, s.link]));

  it('has no target on the Invoiced and Paid stages without Show Invoices page', () => {
    const links = linkByKey(everythingBut('show_invoices_page'));
    expect(links.invoiced).toBeNull();
    expect(links.paid).toBeNull();
    expect(links.estimates).toBe('/estimates');
  });

  it('opens the Estimates, Approved and Deposit stages on the Estimates list, and the Leads and Job stages on theirs', () => {
    const links = linkByKey(everythingBut());
    expect(links).toEqual({
      leads: '/leads',
      estimates: '/estimates',
      approved: '/estimates?status=approved',
      deposit: '/estimates',
      job: '/jobs',
      invoiced: '/invoices',
      paid: '/invoices?status=paid',
    });
  });

  it('leaves a stage without a target when its list page is closed, whichever page that is', () => {
    expect(linkByKey(everythingBut('show_estimates_page'))).toMatchObject({ estimates: null, approved: null, deposit: null, leads: '/leads' });
    expect(linkByKey(everythingBut('show_jobs_page')).job).toBeNull();
    expect(linkByKey(everythingBut('show_leads_page')).leads).toBeNull();
  });

  it('keeps every other field of the stage as built', () => {
    for (const s of linkPipelineStages(stages, everythingBut())) {
      const built = stages.find((b) => b.key === s.key)!;
      expect({ ...s, link: null }).toEqual({ ...built, link: null });
    }
  });
});

describe('a Smart Insights card carries its list page\'s target only when the person may open it', () => {
  const insights = insightsFrom({
    ar: { over_30: 500, over_60: 500 },
    closeRate: { rate: 40, vs_last_period_pp: 2 },
    leadSources: [{ label: 'Google', lead_pct: 60, revenue: 100 }],
  });
  const linkById = (values: Record<string, SwitchValue>) => Object.fromEntries(linkInsights(insights, values).map((i) => [i.id, i.link]));

  it('opens each card on its list page when the person may', () => {
    expect(linkById(everythingBut())).toEqual({ past_due_ar: '/invoices', top_source: '/leads', pipeline_nudge: '/estimates' });
  });

  it('gives a card no target when its list page is closed to the person', () => {
    expect(linkById(everythingBut('show_invoices_page')).past_due_ar).toBeNull();
    expect(linkById(everythingBut('show_leads_page')).top_source).toBeNull();
    expect(linkById(everythingBut('view_estimates')).pipeline_nudge).toBeNull();
    // The other cards are unaffected.
    expect(linkById(everythingBut('show_invoices_page')).top_source).toBe('/leads');
  });
});

describe('the offline seed the browser can run on', () => {
  it('carries the target the server sends each tile when every page is open (no second, drifting list of addresses)', () => {
    const seed = readFileSync(join(__dirname, '../../../frontend/src/lib/api/_mock/dashboard/seed.ts'), 'utf8');
    const tiles = [...seed.matchAll(/tile\('([a-z_.]+)', '[a-z_]+'(?:, '([^']+)')?\)/g)];
    expect(tiles.length).toBeGreaterThan(20);
    const served = eligibleTiles(everythingBut());
    for (const [, id, link] of tiles) {
      const real = served.find((t) => t.id === id);
      expect(real, id).toBeDefined();
      expect(link ?? null, id).toBe(real!.link);
    }
  });
});
