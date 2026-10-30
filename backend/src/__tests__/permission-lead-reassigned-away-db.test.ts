/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.26 (scenario pass 3 fix) - the "reassigned away" lead alert reaches the previous Owner
   even when the reassignment takes the lead out of their sight.

   The alert is addressed to one named person. The row-scope filter dropped it for a person who sees only the leads they are on,
   because by the time it ran they no longer were: the one person it exists for never heard. It is personal now, as "Unassigned
   from you" is for a job, and says only the lead number.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '10');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

const slots = { can_be_on_crew: true, can_own_leads: true, can_be_dispatcher: true };
const opensLeads = { view_leads: true, leads_scope: 'all', ...slots };
const REASSIGNED_AWAY = 'lead.reassigned_away';

suite('the "reassigned away" lead alert (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `lead-reassign-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `r${sequence}`, base, { customRoleId: role.id });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  const alertsFor = (leadId: string) =>
    db.notification.findMany({ where: { object_id: leadId, verb: REASSIGNED_AWAY }, include: { recipients: true } });

  it('reaches the previous Owner when the reassignment takes the lead out of their sight, saying only the lead number', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, { ...opensLeads, assign_people_to_leads: true });
    // A person who sees only the leads they are on: handing the lead to someone else is what closes it to them.
    const previous = await personWith(org, { view_leads: true, leads_scope: 'attached', ...slots }, 'TECHNICIAN');
    const next = await personWith(org, { view_leads: true, leads_scope: 'attached', ...slots }, 'TECHNICIAN');
    const bystander = await personWith(org, { ...opensLeads, assign_people_to_leads: true, alert_every_lead: true });
    const lead = await fx.addLead(org, customer, { owner: previous.id, assignees: [previous.id] });
    const number = (await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } })).lead_number;

    const res = await (await fx.signedInAs(me)).post(`/api/leads/${lead.id}/assign`, { assigned_to: next.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const alerts = await alertsFor(lead.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.recipients.map((r) => r.recipient_id)).toEqual([previous.id]);
    expect(alerts[0]!.title).toBe(`${number} reassigned away from you`);
    expect(alerts[0]!.body).toBeNull();
    expect(alerts[0]!.recipients.map((r) => r.recipient_id)).not.toContain(bystander.id);
  });

  it('is not sent to the person who made the reassignment, nor when the Owner does not change', async () => {
    const { org, customer } = await quietOrg();
    const me = await personWith(org, { ...opensLeads, assign_people_to_leads: true });
    const next = await personWith(org, opensLeads);
    const mine = await fx.addLead(org, customer, { owner: me.id, assignees: [me.id] });
    const api = await fx.signedInAs(me);

    expect((await api.post(`/api/leads/${mine.id}/assign`, { assigned_to: next.id })).status).toBe(200);
    expect((await api.post(`/api/leads/${mine.id}/assign`, { assigned_to: next.id })).status).toBe(200);

    expect(await alertsFor(mine.id)).toEqual([]);
  });
});
