/**
 * `GET /api/leads/:id/timeline` is LEAD-only again.
 *
 * #2088 (B6) had widened this endpoint's `where` into an `OR`: the LEAD branch, plus an ESTIMATE
 * branch scoped to `SELECTION_CHANGED` and intersected with the caller's own Estimate read scope
 * (SEC1). The 2026-09-18 optional-add-ons revision (decision 5) stops that event type ever being
 * written, so the branch reads nothing and is gone.
 *
 * What this file inherits from the suite it replaces:
 *   - AC-N7 (tenancy) survives verbatim, now on a flat `where` rather than "outside the OR".
 *   - AC-N8 was "only SELECTION_CHANGED crosses over". It survives STRICTLY WIDENED: no ESTIMATE
 *     event of ANY type, SELECTION_CHANGED included, can reach a lead timeline, because the query
 *     no longer asks about the ESTIMATE entity at all.
 *   - The SEC1 authorization pair survives as one case, also widened. The old pair split on
 *     whether the caller could read the lead's estimate; that distinction is moot now, so the case
 *     that matters is the one that used to be ALLOWED: a technician who CAN read both the lead and
 *     its estimate still gets no estimate row. Removing the branch removes the thing SEC1 was
 *     protecting, which is strictly narrowing - the `canAccessRow(req, 'Lead', ...)` check and the
 *     top-level `tenantWhere(req)` are untouched, and both are still pinned below.
 *   - The `?? []` guard case died with the estimate-id lookup it guarded.
 *
 * Uses the harness's REAL default grants (`mockAuthAs('technician')` wires DEFAULT_GRANTS for
 * TECHNICIAN, same as production) and the shared `matchesScopeWhere` matcher, so the `where` the
 * controller builds is really applied to the fixture rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, ALPHA_ORG_ID, LEAD_FIXTURE, mockAuthAs, authHeader, matchesScopeWhere, mockScopedFindFirst } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  lead: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { findMany: ReturnType<typeof vi.fn> };
};

const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
});

describe('GET /api/leads/:id/timeline asks only about the LEAD entity', () => {
  it('AC-N7: the where is flat and tenant-scoped, with no OR to spread a tenant guard across', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/timeline`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = mockPrisma.timelineEvent.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.OR).toBeUndefined();
    expect(where.entity_type).toBe('LEAD');
    expect(where.entity_id).toBe(LEAD_FIXTURE.id);
    expect(where.event_type).toBeUndefined();
  });

  it('AC-N8, widened: no ESTIMATE event type of any kind is asked for, and the estimate-id lookup is gone', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue(LEAD_FIXTURE);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/timeline`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Serialising the whole where is the closed form of the old 13-item exclusion list: if the
    // string does not contain 'ESTIMATE' anywhere, no estimate event type can be reached.
    const where = mockPrisma.timelineEvent.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('ESTIMATE');
    // The lookup that existed only to scope the dead branch is gone with it.
    expect(mockPrisma.estimate.findMany).not.toHaveBeenCalled();
  });
});

describe('a caller who can read the lead AND its estimate still gets no estimate row', () => {
  const TECH_ID = TEST_USERS.technician.id;
  const TECH_LEAD_ID = 'e0000000-0000-0000-0000-0000000000c9';

  // A walkthrough-only relation (OWN_WALKTHROUGH) passes canAccessRow('Lead', ...).
  const WALKTHROUGH_ONLY_LEAD_ROW = {
    id: TECH_LEAD_ID,
    organization_id: ALPHA_ORG_ID,
    visits: [{ assignees: [{ user_id: TECH_ID }] }],
  };

  const LEAD_EVENT = {
    id: 'tl00000-0000-0000-0000-00000000000a',
    entity_type: 'LEAD',
    entity_id: TECH_LEAD_ID,
    organization_id: ALPHA_ORG_ID,
    event_type: 'OWNER_CHANGED',
    description: 'ok',
    metadata: null,
    created_at: new Date('2026-02-01'),
    creator: null,
  };
  const HISTORICAL_SELECTION_EVENT = {
    id: 'tl00000-0000-0000-0000-00000000000b',
    entity_type: 'ESTIMATE',
    entity_id: ESTIMATE_ID,
    organization_id: ALPHA_ORG_ID,
    event_type: 'SELECTION_CHANGED',
    description: 'Smart thermostat upgrade included by a technician',
    metadata: { line_id: 'li0000-selection', is_selected: true },
    created_at: new Date('2026-02-02'),
    creator: null,
  };

  it('the lead events come through and the historical estimate rows still in the table do not', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue(WALKTHROUGH_ONLY_LEAD_ROW);
    mockScopedFindFirst(mockPrisma.lead.findFirst, WALKTHROUGH_ONLY_LEAD_ROW);
    // Hand the (now removed) estimate-id lookup this lead's estimate unconditionally, so the old
    // ESTIMATE branch would have been at its WIDEST here: the caller can read the estimate, and
    // the branch would have matched the row below. Post-change nothing calls this mock at all.
    mockPrisma.estimate.findMany.mockResolvedValue([{ id: ESTIMATE_ID }]);
    // Rows written before the revision are NOT deleted or migrated - they stay in the table and
    // simply go inert. This fixture is one of them, and it must not surface here.
    mockPrisma.timelineEvent.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve([LEAD_EVENT, HISTORICAL_SELECTION_EVENT].filter((e) => matchesScopeWhere(where, e))),
    );

    const res = await request(app)
      .get(`/api/leads/${TECH_LEAD_ID}/timeline`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const types = res.body.events.map((e: { event_type: string }) => e.event_type);
    expect(types).toContain('OWNER_CHANGED');
    expect(types).not.toContain('SELECTION_CHANGED');
    expect(res.body.events.some((e: { id: string }) => e.id === HISTORICAL_SELECTION_EVENT.id)).toBe(false);
  });

  it('still 403s an own-scoped caller who cannot read the lead at all (canAccessRow is untouched)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      commission_owner_id: TEST_USERS.admin.id,
      lead_assignees: [{ user_id: TEST_USERS.admin.id }],
    });
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}/timeline`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.timelineEvent.findMany).not.toHaveBeenCalled();
  });
});
