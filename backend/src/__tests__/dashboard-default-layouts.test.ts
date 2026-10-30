/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.4 - the default layout of each built-in preset (fixed data in the tile
   catalog).

   Seam: the catalog's `defaultLayoutOf` and `eligibleTiles`. Eligibility is read from the catalog and the switch
   catalog's preset values, never a copy of them. The only tests that name built-in roles are these, because what
   they check IS a built-in preset (M1).
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES } from '../lib/permissions/switches/catalog';
import { presetValues } from '../lib/permissions/switches/store';
import { defaultLayoutOf, eligibleTiles, findTile, TILE_CATALOG } from '../lib/dashboard/tileCatalog';

const idsOf = (role: (typeof BUILT_IN_ROLES)[number] | null) => defaultLayoutOf(role).map((e) => e.id);

describe('the default layout of each built-in preset', () => {
  it('(M1) is made only of tiles the preset can have, each held once and shown', () => {
    for (const role of BUILT_IN_ROLES) {
      const eligible = new Set(eligibleTiles(presetValues(role)).map((t) => t.id));
      const layout = defaultLayoutOf(role);
      expect(layout.length, role).toBeGreaterThan(0);
      for (const entry of layout) {
        expect(findTile(entry.id), `${role}:${entry.id} is in the catalog`).toBeDefined();
        expect(eligible.has(entry.id), `${role}:${entry.id} is eligible under the ${role} preset`).toBe(true);
        expect(entry.visible, `${role}:${entry.id}`).toBe(true);
      }
      expect(new Set(layout.map((e) => e.id)).size, role).toBe(layout.length);
    }
  });

  it('gives the Technician default no invoices-and-payments tile', () => {
    for (const id of idsOf('TECHNICIAN')) expect(findTile(id)!.category).not.toBe('invoices_and_payments');
  });

  it("gives the Admin preset today's factory layout, in today's order, then the tiles built since", () => {
    expect(idsOf('ADMIN')).toEqual([
      'kpi.revenue_mtd', 'kpi.collected_today', 'kpi.recurring', 'kpi.ar', 'kpi.close_rate', 'kpi.jobs_today', 'kpi.open_leads',
      'kpi.avg_ticket', 'kpi.jobs_week', 'kpi.deposits', 'smart_insights', 'needs_attention', 'schedule_today', 'revenue_chart',
      'pipeline', 'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources', 'revenue_by_job_type', 'unscheduled_jobs', 'office_review_queue',
    ]);
  });

  it('gives the Dispatcher preset the PRD list, for the tiles that exist so far', () => {
    expect(idsOf('DISPATCHER')).toEqual([
      'kpi.jobs_today', 'kpi.open_leads', 'kpi.jobs_week', 'unscheduled_jobs', 'office_review_queue', 'missing_crew', 'missing_lead_owner', 'schedule_today', 'needs_attention',
      'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources',
    ]);
  });

  // S09.18 completed both lists: they are the PRD's lists in the PRD's order (Jobs this month, Completed jobs value, Close Rate,
  // Open Leads, Estimates still to send; Open Leads, Close Rate, Estimates still to send, Monthly Revenue, Revenue Pipeline, Coming Up).
  it('gives the Technician preset the PRD list, in full and in the PRD order', () => {
    expect(idsOf('TECHNICIAN')).toEqual(['jobs_this_month', 'completed_jobs_value', 'kpi.close_rate', 'kpi.open_leads', 'estimates_to_send']);
  });

  it('gives the Sales preset the PRD list, in full and in the PRD order', () => {
    expect(idsOf('SALES')).toEqual(['kpi.open_leads', 'kpi.close_rate', 'estimates_to_send', 'kpi.revenue_mtd', 'pipeline', 'coming_up']);
  });

  it('gives a role with no built-in preset (made from blank) an empty layout', () => {
    expect(defaultLayoutOf(null)).toEqual([]);
  });

  it('hands out a copy, so a caller changing it cannot change the default', () => {
    const first = defaultLayoutOf('ADMIN');
    first.pop();
    first[0]!.visible = false;
    expect(defaultLayoutOf('ADMIN')).toHaveLength(21);
    expect(defaultLayoutOf('ADMIN')[0]!.visible).toBe(true);
  });

  it('keeps every default tile in the catalog, so a renamed id cannot leave a dead entry', () => {
    const held = new Set(TILE_CATALOG.map((t) => t.id));
    for (const role of BUILT_IN_ROLES) for (const id of idsOf(role)) expect(held.has(id), `${role}:${id}`).toBe(true);
  });
});
