/* =============================================================================
   Roles & Permissions security, finding M2 (ticket 32, round 2) - every communication door that takes the id of a lead, job
   or customer in its body checks the person's reach on that target first.

   One table over all the doors: a call, a call-attribution stash, a conversation, a text, a WhatsApp chat and an email. Each
   row is called as a person on a custom role (never a built-in role name) who reaches only what they are attached to, and
   compares the answer for a record OUTSIDE their reach with the answer for an id that does not exist: the same status and
   the same body, and nothing is written or sent (no call, stash, thread, message, chat, email or activity line, no change
   to the lead, and the texting and email edges never called). The same door on a record the person can open still gets past
   the target check. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

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
// The texting edge, watched: the real functions behind a spy, so "nothing was sent" is a call count.
vi.mock('../lib/ctm/sendSms', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/ctm/sendSms')>();
  return { ...real, sendCtmSms: vi.fn(real.sendCtmSms), precheckCtmSms: vi.fn(real.precheckCtmSms) };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import * as smsEdge from '../lib/ctm/sendSms';
import * as emailEdge from '../lib/email';

const suite = realClient ? describe : describe.skip;

suite('communication doors that name a lead, job or customer check reach on it (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['pending_call_attributions', 'call_sessions', 'messages', 'message_threads', 'whatsapp_messages', 'whatsapp_chats', 'emails', 'timeline_events']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A person on a fresh custom role: the Communication section open, and reach only to what they are attached to. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}): Promise<Who> {
    const key = `target-reach-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, view_leads: true, view_customers: true, jobs_scope: 'attached', leads_scope: 'attached',
        access_communication: true, view_communication: true, communication_scope: 'all', contact_customers: true,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    await fx.addUserMailbox(org, person);
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** Every switch that stands on this one, directly or through another: turning this off takes them all off. */
  const standingOn = (key: string): string[] => {
    const direct = SWITCH_CATALOG.filter((sw) => sw.requires.includes(key)).map((sw) => sw.key);
    return [...new Set([...direct, ...direct.flatMap(standingOn)])];
  };
  /** The switch values for a person with these switches OFF (and everything standing on them), on Leads and Jobs scope All. */
  const withOff = (...keys: string[]): Record<string, boolean | string> => {
    const values: Record<string, boolean | string> = { leads_scope: 'all', jobs_scope: 'all' };
    for (const key of keys) for (const k of [key, ...standingOn(key)]) values[k] = false;
    // A switch that needs "at least one of" some others goes off once all of those are off.
    for (const sw of SWITCH_CATALOG) {
      if (sw.requiresAny?.length && sw.requiresAny.every((r) => values[r] === false)) for (const k of [sw.key, ...standingOn(sw.key)]) values[k] = false;
    }
    return values;
  };
  /** A person whose reach on the kind of record the door names is NOTHING, because that View switch is off (scope All). */
  const NOTHING_REACHED: Record<Kind, { label: string; off: string[] }> = {
    lead: { label: 'View leads off', off: ['view_leads'] },
    job: { label: 'View jobs off', off: ['view_jobs'] },
    customer: { label: 'View leads, View jobs and View customers all off', off: ['view_leads', 'view_jobs', 'view_customers'] },
  };

  /** The person's world: a lead, a job and a customer they are on, and a lead, a job and a customer that are someone else's. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const me = await personWith(made.org);
    const mineCustomer = made.customer;
    const mineLead = await fx.addLead(made.org, mineCustomer, { dispatcher: me.id });
    const mineJob = await fx.addJob(made.org, mineCustomer, { crew: [me.id] });
    const otherCustomer = randomUUID();
    await db.customer.create({
      data: { id: otherCustomer, organization_id: made.org, customer_number: `C-${otherCustomer.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Sam', last_name: 'Stranger' },
    });
    const otherLead = await fx.addLead(made.org, otherCustomer, { assignees: [made.admin.id] });
    const otherJob = await fx.addJob(made.org, otherCustomer, { crew: [made.admin.id] });
    return {
      ...made, me,
      ids: {
        lead: { mine: mineLead.id, other: otherLead.id },
        job: { mine: mineJob.id, other: otherJob.id },
        customer: { mine: mineCustomer, other: otherCustomer },
      },
    };
  }
  type Kind = 'lead' | 'job' | 'customer';

  // The doors. `send` makes the call with the target's id in the body field the door reads it from.
  const PHONE = '+15555550123';
  interface Door { name: string; kind: Kind; demoOnly?: boolean; send: (api: Api, id: string) => Promise<{ status: number; body: Record<string, unknown> }> }
  const DOORS: Door[] = [
    { name: 'log a call, on a lead', kind: 'lead', send: (api, id) => api.post('/api/communication/calls', { direction: 'in', from_number: PHONE, to_number: '+15555550199', status: 'completed', lead_id: id }) },
    { name: 'log a call, on a job', kind: 'job', send: (api, id) => api.post('/api/communication/calls', { direction: 'in', from_number: PHONE, to_number: '+15555550199', status: 'completed', job_id: id }) },
    { name: 'log a call, on a customer', kind: 'customer', send: (api, id) => api.post('/api/communication/calls', { direction: 'in', from_number: PHONE, to_number: '+15555550199', status: 'completed', customer_id: id }) },
    { name: 'stash a call attribution, on a lead', kind: 'lead', send: (api, id) => api.post('/api/communication/calls/attribution', { to_number: PHONE, lead_id: id }) },
    { name: 'stash a call attribution, on a job', kind: 'job', send: (api, id) => api.post('/api/communication/calls/attribution', { to_number: PHONE, job_id: id }) },
    { name: 'stash a call attribution, on a customer', kind: 'customer', send: (api, id) => api.post('/api/communication/calls/attribution', { to_number: PHONE, customer_id: id }) },
    { name: 'start a conversation, on a lead', kind: 'lead', send: (api, id) => api.post('/api/communication/threads', { from_number: PHONE, campaign_type: 'customer_care', lead_id: id }) },
    { name: 'text a customer', kind: 'customer', send: (api, id) => api.post('/api/communication/sms', { customerId: id, body: 'Your appointment is tomorrow.' }) },
    { name: 'start a WhatsApp chat, on a lead', kind: 'lead', demoOnly: true, send: (api, id) => api.post('/api/communication/whatsapp-chats', { name: 'Pat Payer', org: 'Payer Co', phone: PHONE, lead_id: id }) },
    { name: 'email a customer', kind: 'customer', send: (api, id) => api.post('/api/communication/emails', { to: 'pat@example.test', subject: 'Hello', body: ['Hello there.'], customer_id: id }) },
  ];

  /** Everything a refused door must not have touched, in the company and on the lead that was out of reach. */
  async function snapshot(org: string, leadId: string) {
    const count = (table: string) => db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${table} WHERE organization_id = '${org}'`).then((r) => Number(r[0]!.n));
    return {
      rows: {
        calls: await count('call_sessions'), stashes: await count('pending_call_attributions'), threads: await count('message_threads'),
        messages: await count('messages'), chats: await count('whatsapp_chats'), emails: await count('emails'), activity: await count('timeline_events'),
      },
      lead: await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true, contacted_at: true, updated_at: true } }),
      texts: vi.mocked(smsEdge.sendCtmSms).mock.calls.length + vi.mocked(smsEdge.precheckCtmSms).mock.calls.length,
      emails: vi.mocked(emailEdge.sendComposedEmail).mock.calls.length,
    };
  }

  /** WhatsApp is open to the demo company only; every other door is the same for any company. */
  async function worldFor(door: Door) {
    const w = await world();
    if (door.demoOnly) await db.organization.update({ where: { id: w.org }, data: { is_demo: true } });
    return w;
  }

  it.each(DOORS)('$name: a target outside the reach answers like a missing one, and nothing is written or sent', async (door) => {
    const w = await worldFor(door);
    const before = await snapshot(w.org, w.ids.lead.other);

    const refused = await door.send(await w.me.api(), w.ids[door.kind].other);
    const missing = await door.send(await w.me.api(), randomUUID());

    expect(missing.status).toBe(404);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect(await snapshot(w.org, w.ids.lead.other)).toEqual(before);
  });

  it.each(DOORS)('$name: a target the person can open gets past the check', async (door) => {
    const w = await worldFor(door);

    const res = await door.send(await w.me.api(), w.ids[door.kind].mine);

    // Whatever else the door answers (a send can still be turned down for its own reasons), it is not "not found".
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  it.each(DOORS)('$name: when the person\'s scope reaches nothing (the View switch is off), it answers like a missing target and writes nothing', async (door) => {
    const w = await worldFor(door);
    const { off } = NOTHING_REACHED[door.kind];
    const nobody = await personWith(w.org, withOff(...off));
    // The record is theirs (they are on it), and would be reachable but for the View switch.
    await fx.addLead(w.org, w.ids.customer.mine, { dispatcher: nobody.id });
    await fx.addJob(w.org, w.ids.customer.mine, { crew: [nobody.id] });
    const before = await snapshot(w.org, w.ids.lead.other);

    const refused = await door.send(await nobody.api(), w.ids[door.kind].mine);
    const missing = await door.send(await nobody.api(), randomUUID());

    expect(missing.status).toBe(404);
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect(await snapshot(w.org, w.ids.lead.other)).toEqual(before);
  });

  it('reaches a customer through a job alone or through a lead alone, and through neither once both View switches are off', async () => {
    const w = await world();
    const texts = async (who: Who) => (await (await who.api()).post('/api/communication/sms', { customerId: w.ids.customer.mine, body: 'Running late.' })).status;
    const throughJob = await personWith(w.org, withOff('view_customers', 'view_leads'));
    await fx.addJob(w.org, w.ids.customer.mine, { crew: [throughJob.id] });
    const throughLead = await personWith(w.org, withOff('view_customers', 'view_jobs'));
    await fx.addLead(w.org, w.ids.customer.mine, { dispatcher: throughLead.id });
    const neither = await personWith(w.org, withOff('view_customers', 'view_leads', 'view_jobs'));
    await fx.addJob(w.org, w.ids.customer.mine, { crew: [neither.id] });
    await fx.addLead(w.org, w.ids.customer.mine, { dispatcher: neither.id });

    expect(await texts(throughJob)).not.toBe(404);
    expect(await texts(throughLead)).not.toBe(404);
    expect(await texts(neither)).toBe(404);
  });

  it('lets a person with View customers off contact the customer of a job they are on, and refuses another customer', async () => {
    const w = await world();
    const blind = await personWith(w.org, { view_customers: false, create_customers: false, edit_customers: false });
    const job = await fx.addJob(w.org, w.ids.customer.mine, { crew: [blind.id] });
    expect(job.id).toBeTruthy();

    const own = await (await blind.api()).post('/api/communication/sms', { customerId: w.ids.customer.mine, body: 'Running late.' });
    const other = await (await blind.api()).post('/api/communication/sms', { customerId: w.ids.customer.other, body: 'Running late.' });

    expect(own.status).not.toBe(404);
    expect(other.status).toBe(404);
  });
});
