/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.1 - the server's dashboard tile catalog.

   Seam: the catalog's eligibility function (`eligibleTiles`) and its data. Expected eligibility is derived from
   the switch catalog (a person's switch values are built from it), never a second copy of the rules.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TILE_CATALOG,
  TILE_CATEGORIES,
  CATEGORY_UNLOCKED_BY,
  TILE_CATEGORY_LABELS,
  eligibleTiles,
  categoriesOfTiles,
  type TileCategory,
} from '../lib/dashboard/tileCatalog';
import { SWITCH_CATALOG, SCOPE_SWITCH_KEY, type SwitchValue } from '../lib/permissions/switches/catalog';
import { presetValues } from '../lib/permissions/switches/store';

/** Every switch off (a choice at its narrowest, a list empty), then the named values laid over it. */
function person(values: Record<string, SwitchValue> = {}): Record<string, SwitchValue> {
  return { ...presetValues(null), ...values };
}
const ids = (values: Record<string, SwitchValue>) => eligibleTiles(values).map((t) => t.id);
const byCategory = (cats: TileCategory[]) => TILE_CATALOG.filter((t) => cats.includes(t.category)).map((t) => t.id);

/** The ids the dashboard has drawn since before this slice: saved layouts are keyed by them. */
const TODAYS_IDS = [
  'kpi.revenue_mtd', 'kpi.collected_today', 'kpi.recurring', 'kpi.ar', 'kpi.close_rate', 'kpi.jobs_today', 'kpi.open_leads',
  'kpi.avg_ticket', 'kpi.jobs_week', 'kpi.deposits', 'smart_insights', 'needs_attention', 'schedule_today', 'revenue_chart',
  'pipeline', 'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources', 'jobs_by_status', 'revenue_by_job_type', 'coming_up',
  'recent_activity', 'service_areas', 'recent_calls',
];

describe('the tile catalog', () => {
  it('keeps every id the dashboard draws today, and holds each exactly once', () => {
    const held = TILE_CATALOG.map((t) => t.id);
    for (const id of TODAYS_IDS) expect(held, id).toContain(id);
    expect(new Set(held).size).toBe(held.length);
  });

  it('gives every tile exactly one category, and every category the switches the PRD names', () => {
    for (const tile of TILE_CATALOG) expect(TILE_CATEGORIES, tile.id).toContain(tile.category);
    for (const [category, switches] of Object.entries(CATEGORY_UNLOCKED_BY)) {
      for (const key of switches) expect(SWITCH_CATALOG.some((s) => s.key === key), `${category}:${key}`).toBe(true);
    }
    expect(CATEGORY_UNLOCKED_BY.jobs).toEqual(['view_jobs']);
    expect(CATEGORY_UNLOCKED_BY.invoices_and_payments).toEqual(['view_invoices']);
    expect(CATEGORY_UNLOCKED_BY.company_figures).toEqual(['see_company_figures']);
    expect(CATEGORY_UNLOCKED_BY.office_review).toEqual(['office_review']);
    expect(CATEGORY_UNLOCKED_BY.communication).toEqual(['access_communication']);
    expect(CATEGORY_UNLOCKED_BY.costs).toEqual(['see_financial_data']);
  });

  it('holds no commission tile, and the switch catalog holds no dashboard switch', () => {
    expect(TILE_CATALOG.some((t) => /commission/i.test(`${t.id} ${t.title}`))).toBe(false);
    expect(SWITCH_CATALOG.some((s) => /dashboard/i.test(`${s.key} ${s.label}`))).toBe(false);
  });

  it('draws every tile it holds, and holds every tile it draws (the two lists of ids agree)', () => {
    const registry = readFileSync(join(__dirname, '../../../frontend/src/components/dashboard/widgetRegistry.tsx'), 'utf8');
    const drawn = [...registry.matchAll(/^\s+id: '([a-z_.]+)'/gm)].map((m) => m[1]!);
    expect(drawn.sort()).toEqual(TILE_CATALOG.map((t) => t.id).sort());
  });

  it('holds the tiles built since, each under the id the page keys it by', () => {
    expect(TILE_CATALOG.map((t) => t.id)).toContain('unscheduled_jobs');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('office_review_queue');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('missing_lead_owner');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('missing_crew');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('jobs_this_month');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('completed_jobs_value');
    expect(TILE_CATALOG.map((t) => t.id)).toContain('estimates_to_send');
  });

  it('draws only ids the catalog holds (every id of the routed registry is a tile)', () => {
    const registry = readFileSync(join(__dirname, '../../../frontend/src/components/dashboard/widgetRegistry.tsx'), 'utf8');
    const drawn = [...registry.matchAll(/^\s+id: '([a-z_.]+)'/gm)].map((m) => m[1]!);
    expect(drawn.length).toBeGreaterThan(20);
    const held = TILE_CATALOG.map((t) => t.id);
    for (const id of drawn) expect(held, id).toContain(id);
  });

  it('says "Unassigned" nowhere in a tile id or title', () => {
    for (const tile of TILE_CATALOG) expect(`${tile.id} ${tile.title}`).not.toMatch(/unassigned/i);
  });
});

describe('eligibility follows the switches', () => {
  it('offers nothing to a person whose switches unlock nothing', () => {
    expect(eligibleTiles(person())).toEqual([]);
  });

  it('offers no invoices-and-payments tile with View invoices off, whatever else is on', () => {
    const everythingButInvoices = Object.fromEntries(
      SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, s.key !== 'view_invoices']),
    );
    const eligible = ids(person(everythingButInvoices));
    for (const id of byCategory(['invoices_and_payments'])) expect(eligible, id).not.toContain(id);
    expect(eligible).toContain('kpi.jobs_today');
  });

  it('offers no Jobs, Job value or Office review tile with View jobs off', () => {
    // Office review requires View jobs (the switch catalog refuses a set that holds the one without the other), so a
    // person without View jobs never holds Office review either: the switches that require it go with it.
    const requiresViewJobs = (key: string) => key === 'view_jobs' || (SWITCH_CATALOG.find((s) => s.key === key)?.requires ?? []).includes('view_jobs');
    const everythingButJobs = Object.fromEntries(
      SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, !requiresViewJobs(s.key)]),
    );
    const eligible = ids(person(everythingButJobs));
    for (const id of byCategory(['jobs', 'job_value', 'office_review'])) expect(eligible, id).not.toContain(id);
  });

  it('offers Recent Calls only with Access Communication', () => {
    expect(ids(person({ access_communication: true }))).toContain('recent_calls');
    expect(ids(person({ view_jobs: true, view_leads: true }))).not.toContain('recent_calls');
  });

  it('offers Recent Activity with any one of the five View switches, and not with all five off', () => {
    for (const key of ['view_jobs', 'view_leads', 'view_estimates', 'view_invoices', 'view_tasks']) {
      expect(ids(person({ [key]: true })), key).toContain('recent_activity');
    }
    expect(ids(person())).not.toContain('recent_activity');
  });

  it('offers Needs Attention with any one of View jobs, View leads or View invoices', () => {
    for (const key of ['view_jobs', 'view_leads', 'view_invoices']) expect(ids(person({ [key]: true })), key).toContain('needs_attention');
    expect(ids(person({ view_estimates: true, view_tasks: true }))).not.toContain('needs_attention');
  });

  it('offers the Company figures tiles only with See company figures and the View switch of what they read', () => {
    const companyTiles = byCategory(['company_figures']);
    expect(companyTiles.sort()).toEqual(['kpi.recurring', 'revenue_by_job_type', 'smart_insights']);
    const noFigures = ids(person({ view_jobs: true, view_leads: true, view_invoices: true, view_service_plans: true }));
    for (const id of companyTiles) expect(noFigures, id).not.toContain(id);
    const withFigures = ids(person({ see_company_figures: true, view_jobs: true, view_leads: true, view_invoices: true, view_service_plans: true }));
    for (const id of companyTiles) expect(withFigures, id).toContain(id);
    // Smart Insights reads leads and invoices; Recurring reads service plans.
    const noPlans = ids(person({ see_company_figures: true, view_jobs: true, view_leads: true, view_invoices: true }));
    expect(noPlans).not.toContain('kpi.recurring');
    const noLeads = ids(person({ see_company_figures: true, view_jobs: true, view_invoices: true }));
    expect(noLeads).not.toContain('smart_insights');
  });

  it('offers the Revenue Pipeline when any one of its stages could be drawn', () => {
    for (const key of ['view_leads', 'view_estimates', 'view_jobs', 'view_invoices']) expect(ids(person({ [key]: true })), key).toContain('pipeline');
  });

  it('is the same whatever the Data Scope is', () => {
    const attached = ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'attached' }));
    const all = ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'all' }));
    expect(attached).toEqual(all);
  });
});

describe('the Unscheduled jobs tile', () => {
  it('is a Jobs tile that View jobs alone unlocks, whatever the Jobs scope is', () => {
    expect(TILE_CATALOG.find((t) => t.id === 'unscheduled_jobs')?.category).toBe('jobs');
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })), scope).toContain('unscheduled_jobs');
    }
    expect(ids(person({ view_leads: true, view_estimates: true, view_invoices: true }))).not.toContain('unscheduled_jobs');
    expect(ids(person())).not.toContain('unscheduled_jobs');
  });

  it('is named in the PRD\'s words', () => {
    expect(TILE_CATALOG.find((t) => t.id === 'unscheduled_jobs')?.title).toBe('Unscheduled jobs');
  });
});

describe('the Office review queue tile', () => {
  const tileId = 'office_review_queue';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);

  it('is an Office review tile that the Office review switch alone unlocks, whatever View jobs and the Jobs scope are', () => {
    expect(def()?.category).toBe('office_review');
    expect(def()?.title).toBe('Office review queue');
    // Eligibility reads the switch values as given: the switch catalog refuses a set that holds Office review without
    // View jobs, so the "View jobs off" half is asked of the catalog's function, not of a saved role.
    for (const viewJobs of [true, false]) {
      for (const scope of ['attached', 'team', 'location', 'all']) {
        expect(ids(person({ office_review: true, view_jobs: viewJobs, [SCOPE_SWITCH_KEY.Job]: scope })), `${viewJobs}/${scope}`).toContain(tileId);
      }
    }
    // Everything else on, Office review off: not offered.
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'office_review').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, office_review: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('follows the Jobs scope for the count, and labels nobody (no one owns a review)', () => {
    const wide = eligibleTiles(person({ office_review: true, view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'all' })).find((t) => t.id === tileId);
    const narrow = eligibleTiles(person({ office_review: true, view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'attached' })).find((t) => t.id === tileId);
    expect(wide).toMatchObject({ mode: 'company', label: null });
    expect(narrow).toMatchObject({ mode: 'scope', label: null });
  });
});

describe('the Missing crew tile', () => {
  const tileId = 'missing_crew';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);

  it('is a Jobs tile that View jobs unlocks under every Jobs scope, Attached included, and nothing else does', () => {
    expect(def()?.category).toBe('jobs');
    expect(def()?.title).toBe('Missing crew');
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })), scope).toContain(tileId);
    }
    // View jobs on alone is enough: a person with View leads off is still offered it (its walkthroughs are what go).
    expect(ids(person({ view_jobs: true, view_leads: false }))).toContain(tileId);
    // Everything else on, View jobs off: not offered. A person with nothing on is not offered it either.
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'view_jobs').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, view_jobs: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('follows the Jobs scope for its mode and label, like every other Jobs tile', () => {
    const modeOf = (scope: string) => eligibleTiles(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })).find((t) => t.id === tileId);
    expect(modeOf('all')).toMatchObject({ mode: 'company', label: null });
    expect(modeOf('attached')).toMatchObject({ mode: 'scope' });
  });
});

describe('the Jobs this month tile', () => {
  const tileId = 'jobs_this_month';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);

  it('is a Jobs tile that View jobs unlocks under every Jobs scope, and nothing else does', () => {
    expect(def()?.category).toBe('jobs');
    expect(def()?.title).toBe('Jobs this month');
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })), scope).toContain(tileId);
    }
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'view_jobs').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, view_jobs: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('follows the Jobs scope for its mode and carries no label', () => {
    const modeOf = (scope: string) => eligibleTiles(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })).find((t) => t.id === tileId);
    expect(modeOf('all')).toMatchObject({ mode: 'company', label: null });
    expect(modeOf('attached')).toMatchObject({ mode: 'scope', label: null });
  });
});

describe('the Completed jobs value tile', () => {
  const tileId = 'completed_jobs_value';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);
  const tileOf = (values: Record<string, SwitchValue>) => eligibleTiles(values).find((t) => t.id === tileId);

  it('is a Job value tile that View jobs unlocks under every Jobs scope, and nothing else does', () => {
    expect(def()?.category).toBe('job_value');
    expect(def()?.title).toBe('Completed jobs value');
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(ids(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: scope })), scope).toContain(tileId);
    }
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'view_jobs').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, view_jobs: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('needs no See financial data and no View invoices: the job price shows to anyone who can open the job', () => {
    expect(tileOf(person({ view_jobs: true, see_financial_data: false, view_invoices: false }))).toBeDefined();
  });

  it('is the person\'s own money, "Yours", without See company figures, whatever the Jobs scope', () => {
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(tileOf(person({ view_jobs: true, see_company_figures: false, [SCOPE_SWITCH_KEY.Job]: scope })), scope).toMatchObject({ mode: 'own', label: 'Yours' });
    }
  });

  it('lets the Jobs scope decide with See company figures: All is the company with no label, the narrower scopes say whose', () => {
    const modeOf = (scope: string) => tileOf(person({ view_jobs: true, see_company_figures: true, [SCOPE_SWITCH_KEY.Job]: scope }));
    expect(modeOf('all')).toMatchObject({ mode: 'company', label: null });
    expect(modeOf('attached')).toMatchObject({ mode: 'scope', label: 'Yours' });
    expect(modeOf('team')).toMatchObject({ mode: 'scope', label: 'Your team' });
    expect(modeOf('location')).toMatchObject({ mode: 'scope', label: 'Your location' });
  });
});

describe('the Estimates still to send tile', () => {
  const tileId = 'estimates_to_send';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);
  const tileOf = (values: Record<string, SwitchValue>) => eligibleTiles(values).find((t) => t.id === tileId);

  it('is an Estimates tile that View estimates unlocks under every Estimates scope, and nothing else does', () => {
    expect(def()?.category).toBe('estimates');
    expect(def()?.title).toBe('Estimates still to send');
    for (const scope of ['attached', 'team', 'location', 'all', 'through_own_leads']) {
      expect(ids(person({ view_estimates: true, [SCOPE_SWITCH_KEY.Estimate]: scope })), scope).toContain(tileId);
    }
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'view_estimates').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, view_estimates: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('needs no See financial data and no See company figures: the total is the record\'s price', () => {
    expect(tileOf(person({ view_estimates: true, see_financial_data: false, see_company_figures: false }))).toBeDefined();
  });

  it('is a count tile that follows the Estimates scope and carries no label', () => {
    expect(tileOf(person({ view_estimates: true, [SCOPE_SWITCH_KEY.Estimate]: 'all' }))).toMatchObject({ mode: 'company', label: null });
    expect(tileOf(person({ view_estimates: true, [SCOPE_SWITCH_KEY.Estimate]: 'attached' }))).toMatchObject({ mode: 'scope', label: null });
  });
});

describe('the Missing lead owner tile', () => {
  const tileId = 'missing_lead_owner';
  const def = () => TILE_CATALOG.find((t) => t.id === tileId);

  it('is a Leads tile that View leads unlocks under every Leads scope, Attached included, and nothing else does', () => {
    expect(def()?.category).toBe('leads');
    expect(def()?.title).toBe('Missing lead owner');
    for (const scope of ['attached', 'team', 'location', 'all']) {
      expect(ids(person({ view_leads: true, [SCOPE_SWITCH_KEY.Lead]: scope })), scope).toContain(tileId);
    }
    // Everything else on, View leads off: not offered. A person with nothing on is not offered it either.
    const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== 'view_leads').map((s) => [s.key, true]));
    expect(ids(person({ ...everythingElse, view_leads: false }))).not.toContain(tileId);
    expect(ids(person())).not.toContain(tileId);
  });

  it('follows the Leads scope for its mode and label, like every other Leads tile', () => {
    const modeOf = (scope: string) => eligibleTiles(person({ view_leads: true, [SCOPE_SWITCH_KEY.Lead]: scope })).find((t) => t.id === tileId);
    expect(modeOf('all')).toMatchObject({ mode: 'company', label: null });
    expect(modeOf('attached')).toMatchObject({ mode: 'scope' });
  });
});

describe('mode and label', () => {
  const MONEY_TILES = ['kpi.revenue_mtd', 'kpi.collected_today', 'kpi.ar', 'kpi.avg_ticket', 'kpi.deposits', 'revenue_chart'];
  const modeOf = (values: Record<string, SwitchValue>, id: string) => {
    const t = eligibleTiles(values).find((x) => x.id === id);
    return t && { mode: t.mode, label: t.label };
  };

  it('puts a money tile in "own" mode labelled "Yours" without See company figures, whatever the scope', () => {
    for (const scope of ['attached', 'team', 'location', 'all']) {
      const values = person({ view_invoices: true, [SCOPE_SWITCH_KEY.Invoice]: scope });
      for (const id of MONEY_TILES) expect(modeOf(values, id), `${id} ${scope}`).toEqual({ mode: 'own', label: 'Yours' });
    }
  });

  it('puts a money tile in "company" mode with no label under scope All, with See company figures', () => {
    const values = person({ view_invoices: true, see_company_figures: true, [SCOPE_SWITCH_KEY.Invoice]: 'all' });
    for (const id of MONEY_TILES) expect(modeOf(values, id), id).toEqual({ mode: 'company', label: null });
  });

  it('labels a scope-mode money tile Yours, Your team or Your location by the Invoices scope', () => {
    const labelFor = (scope: string) =>
      modeOf(person({ view_invoices: true, see_company_figures: true, [SCOPE_SWITCH_KEY.Invoice]: scope }), 'kpi.ar');
    expect(labelFor('attached')).toEqual({ mode: 'scope', label: 'Yours' });
    expect(labelFor('through_own_leads')).toEqual({ mode: 'scope', label: 'Yours' });
    expect(labelFor('team')).toEqual({ mode: 'scope', label: 'Your team' });
    expect(labelFor('location')).toEqual({ mode: 'scope', label: 'Your location' });
  });

  it('puts a count tile in company mode under scope All and scope mode otherwise, with no label', () => {
    expect(modeOf(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'all' }), 'kpi.jobs_today')).toEqual({ mode: 'company', label: null });
    expect(modeOf(person({ view_jobs: true, [SCOPE_SWITCH_KEY.Job]: 'attached' }), 'kpi.jobs_today')).toEqual({ mode: 'scope', label: null });
  });

  it('puts a Company figures tile in company mode with no label', () => {
    const values = person({ see_company_figures: true, view_jobs: true, view_leads: true, view_invoices: true, [SCOPE_SWITCH_KEY.Job]: 'attached' });
    expect(modeOf(values, 'smart_insights')).toEqual({ mode: 'company', label: null });
  });
});

/* S09.2 - the picker groups tiles by the category names the server sends (PRD 9, "The picker groups tiles by these
   categories"). The names are the PRD's category table; the groups are the categories with an eligible tile. */
describe('category names for the picker', () => {
  it('names every category in the PRD\'s words, one distinct name each', () => {
    expect(TILE_CATEGORY_LABELS).toEqual({
      jobs: 'Jobs',
      leads: 'Leads',
      estimates: 'Estimates',
      invoices_and_payments: 'Invoices and payments',
      job_value: 'Job value',
      company_figures: 'Company figures',
      office_review: 'Office review',
      communication: 'Communication',
      costs: 'Costs',
      each_record: 'Across your records',
    });
    expect(Object.keys(TILE_CATEGORY_LABELS).sort()).toEqual([...TILE_CATEGORIES].sort());
    expect(new Set(Object.values(TILE_CATEGORY_LABELS)).size).toBe(TILE_CATEGORIES.length);
  });

  it('names no vendor in a category name', () => {
    for (const label of Object.values(TILE_CATEGORY_LABELS)) expect(label).not.toMatch(/ctm|supabase|render|stripe|twilio|resend|quickbooks/i);
  });

  it('lists only the categories that have an eligible tile, in the catalog\'s category order', () => {
    const tiles = eligibleTiles(person({ view_leads: true }));
    const categories = categoriesOfTiles(tiles);
    expect(categories.map((c) => c.id)).toEqual(['leads', 'each_record']);
    expect(categories.map((c) => c.label)).toEqual(['Leads', 'Across your records']);
  });

  it('is the same in the offline seed the browser can run on (no second, drifting list of names)', () => {
    const seed = readFileSync(join(__dirname, '../../../frontend/src/lib/api/_mock/dashboard/seed.ts'), 'utf8');
    const pairs = [...seed.matchAll(/\{ id: '([a-z_]+)', label: '([^']+)' \}/g)];
    expect(pairs.length).toBeGreaterThan(3);
    for (const [, id, label] of pairs) expect(TILE_CATEGORY_LABELS[id as TileCategory], id).toBe(label);
  });

  it('lists nothing for a person whose switches unlock no tile', () => {
    expect(categoriesOfTiles(eligibleTiles(person()))).toEqual([]);
  });

  it('lists every category an all-access person has a tile in, and none without one', () => {
    const everything = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
    const tiles = eligibleTiles(person(everything));
    const listed = categoriesOfTiles(tiles).map((c) => c.id);
    const withTiles = TILE_CATEGORIES.filter((c) => tiles.some((t) => t.category === c));
    expect(listed).toEqual(withTiles);
    // Costs has no tile in this build, so it never shows.
    expect(listed).not.toContain('costs');
  });
});
