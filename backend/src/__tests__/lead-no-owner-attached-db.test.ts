/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.4 - the "No owner" card and the Owner filter's "No owner" choice
   under Leads scope Attached.

   A person on Attached sees the card and the choice like everyone else, counting only the OPEN leads they
   are on (as Dispatcher or walkthrough performer, say) that have no Owner. The old Unassigned tile counted
   leads that had the person as an assignee and no assignees, which is never; this suite pins the new count
   with a person holding the Sales preset's values (Attached, from the catalog) and answers every question
   the card is asked three ways (the list's stats, the stats route, the filter) so they cannot drift.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LeadStatus, PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('"No owner" under Leads scope Attached (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A lead with the given people and status. */
  async function lead(
    org: string,
    customer: string,
    status: LeadStatus,
    people: Parameters<typeof fx.addLead>[2] = {},
  ) {
    const row = await fx.addLead(org, customer, people);
    await db.lead.update({ where: { id: row.id }, data: { status } });
    return row.id;
  }

  /**
   * One org; the viewer holds a custom role copied from the Sales preset and nothing changed on it, so
   * every value is the preset's. A colleague holds the same.
   */
  async function world() {
    const { org, customer } = await fx.newOrg();
    const role = await fx.addCustomRole(org, `sales-copy-${++sequence}`, 'SALES');
    const viewer = await fx.addUser(org, 'viewer', 'SALES', { customRoleId: role.id });
    const colleague = await fx.addUser(org, 'colleague', 'SALES', { customRoleId: role.id });

    const ids = {
      // Open, no Owner, and the viewer is on them.
      asDispatcher: await lead(org, customer, 'NEW', { dispatcher: viewer.id }),
      onWalkthroughCrew: await lead(org, customer, 'WALKTHROUGH_SCHEDULED', { walkthroughCrew: [viewer.id] }),
      walkthroughDone: await lead(org, customer, 'WALKTHROUGH_COMPLETED', { dispatcher: viewer.id }),
      // Open, no Owner, and the viewer is not on them.
      colleagueDispatcher: await lead(org, customer, 'NEW', { dispatcher: colleague.id }),
      nobody: await lead(org, customer, 'CONTACTED'),
      // The viewer is on them but they have an Owner (the viewer, or the colleague).
      ownedByViewer: await lead(org, customer, 'NEW', { owner: viewer.id, assignees: [viewer.id] }),
      ownedByColleague: await lead(org, customer, 'ESTIMATED', { owner: colleague.id, assignees: [colleague.id], dispatcher: viewer.id }),
      // The viewer is an assignee of a lead nobody owns: the old tile's shape. It has an assignee, so it has an Owner.
      assigneeOnly: await lead(org, customer, 'NEW', { assignees: [viewer.id] }),
      // Closed, no Owner, the viewer is on them.
      wonAsDispatcher: await lead(org, customer, 'WON', { dispatcher: viewer.id }),
      lostAsDispatcher: await lead(org, customer, 'LOST', { dispatcher: viewer.id }),
    };
    return { org, customer, viewer, colleague, ids, api: await fx.signedInAs(viewer) };
  }

  const idsOf = (body: { leads: Array<{ id: string }> }) => body.leads.map((l) => l.id).sort();

  it('holds Attached from the Sales preset, read from the catalog', async () => {
    const { org, viewer } = await world();
    const { resolveSwitches } = await import('../lib/permissions/switches/store.js');
    const preset = SWITCH_CATALOG.find((s) => s.key === 'leads_scope')!.presets.SALES;
    const stored = await db.user.findUniqueOrThrow({ where: { id: viewer.id }, include: { custom_role: true } });
    const values = await resolveSwitches({ id: viewer.id, organization_id: org, role: stored.role, custom_role: stored.custom_role });
    expect(values.leads_scope).toBe(preset);
    expect(values.leads_scope).toBe('attached');
  });

  it('counts only the open no-Owner leads the person is on: a Dispatcher or walkthrough performer counts, a lead they are not on does not', async () => {
    const { ids, api } = await world();
    const expected = [ids.asDispatcher, ids.onWalkthroughCrew, ids.walkthroughDone].sort();

    const list = await api.get('/api/leads?limit=100');
    expect(list.status).toBe(200);
    expect(list.body.stats.no_owner).toBe(expected.length);
    // The leads the page lists are the ones the person can open: never the colleague's or nobody's.
    expect(idsOf(list.body)).not.toContain(ids.colleagueDispatcher);
    expect(idsOf(list.body)).not.toContain(ids.nobody);

    const stats = await api.get('/api/leads/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.no_owner).toBe(expected.length);
  });

  it('never counts a lead that has an Owner or an assignee, the old tile\'s shape, or a closed lead', async () => {
    const { ids, api } = await world();
    const filtered = await api.get('/api/leads?limit=100&assigned_to=NO_OWNER');
    expect(filtered.status).toBe(200);
    const returned = idsOf(filtered.body);
    for (const n of ['ownedByViewer', 'ownedByColleague', 'assigneeOnly', 'wonAsDispatcher', 'lostAsDispatcher'] as const) {
      expect(returned, n).not.toContain(ids[n]);
    }
  });

  it('returns the same leads from the card and from the filter choice, a person at a time', async () => {
    const { ids, api } = await world();
    const all = await api.get('/api/leads?limit=100');
    const filtered = await api.get('/api/leads?limit=100&assigned_to=NO_OWNER');
    expect(idsOf(filtered.body)).toEqual([ids.asDispatcher, ids.onWalkthroughCrew, ids.walkthroughDone].sort());
    expect(filtered.body.pagination.total).toBe(all.body.stats.no_owner);
    expect(filtered.body.stats.no_owner).toBe(all.body.stats.no_owner);
    // The filter's old name still answers for a saved view.
    const legacy = await api.get('/api/leads?limit=100&assigned_to=UNASSIGNED');
    expect(idsOf(legacy.body)).toEqual(idsOf(filtered.body));
  });

  it('is non-zero for the Sales preset whenever such a lead exists, and follows the person off the lead on the next request', async () => {
    const { ids, api } = await world();
    expect((await api.get('/api/leads?limit=100')).body.stats.no_owner).toBeGreaterThan(0);

    // Taking the person off the Dispatcher slot and the crew drops them out of the card at once.
    await db.lead.update({ where: { id: ids.asDispatcher }, data: { dispatcher_id: null } });
    await db.lead.update({ where: { id: ids.walkthroughDone }, data: { dispatcher_id: null } });
    await db.visitAssignee.deleteMany({ where: { visit: { lead_id: ids.onWalkthroughCrew } } });
    const after = await api.get('/api/leads?limit=100');
    expect(after.body.stats.no_owner).toBe(0);
    expect((await api.get('/api/leads/stats')).body.no_owner).toBe(0);
    expect((await api.get('/api/leads?limit=100&assigned_to=NO_OWNER')).body.leads).toHaveLength(0);
  });

  it('gives an Owner picked together with No owner no reach beyond the person\'s own leads', async () => {
    const { ids, colleague, api } = await world();
    const res = await api.get(`/api/leads?limit=100&assigned_to=NO_OWNER&assigned_to=${colleague.id}`);
    expect(res.status).toBe(200);
    const returned = idsOf(res.body);
    expect(returned).toContain(ids.asDispatcher);
    expect(returned).not.toContain(ids.colleagueDispatcher);
    expect(returned).not.toContain(ids.nobody);
  });
});
