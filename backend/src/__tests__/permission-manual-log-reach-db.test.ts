/* =============================================================================
   Roles & Permissions security, finding M2 (ticket 32) - "Log past communication" onto a lead, job or customer
   checks the person's reach on that target first.

   Everything goes through the public interface: the manual-log routes, called as people on custom roles (never a
   built-in role name) whose Leads scope and Jobs scope are the switch values under test. A target outside the person's
   reach answers "not found", the same as a target that does not exist, and nothing is written: no entry, no activity
   line, and a New lead stays New. A target inside the reach still works. Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed again.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { findSwitch, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;
const ENDPOINT = '/api/communication/manual-log';

suite('Log past communication checks reach on the target (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role: the preset of the base role, with exactly these switch values on top. */
  async function personWith(org: string, values: Record<string, boolean | string>, base: 'DISPATCHER' | 'TECHNICIAN' = 'TECHNICIAN') {
    const key = `m2-log-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const body = (anchor: { lead_id?: string; job_id?: string; customer_id?: string }) => ({
    ...anchor, direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Rang the customer from my mobile to confirm the install window.',
  });

  /** Everything a refused call must not have touched. */
  async function writes(org: string, leadId?: string) {
    return {
      entries: await db.manualCommunicationLog.count({ where: { organization_id: org } }),
      activity: await db.timelineEvent.count({ where: { organization_id: org } }),
      lead: leadId ? await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { status: true, contacted_at: true } }) : null,
    };
  }

  /** A person who reaches only what they are attached to, and a lead and job they are on next to a lead and job they are not. */
  async function world() {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
    const mine = await fx.addLead(org, customer, { dispatcher: me.id });
    const theirs = await fx.addLead(org, customer, { assignees: [admin.id] });
    const myJob = await fx.addJob(org, customer, { crew: [me.id] });
    const theirJob = await fx.addJob(org, customer, { crew: [admin.id] });
    return { org, customer, admin, me, mine, theirs, myJob, theirJob };
  }

  it('holds the switch and the Attached scope the cases rely on, read from the catalog', () => {
    expect(findSwitch('log_past_communications')!.presets.TECHNICIAN).toBe(true);
    expect(findSwitch('leads_scope')!.presets.TECHNICIAN).toBe('attached');
  });

  it('refuses a lead the person cannot open with the same "not found" as a missing lead, and writes nothing', async () => {
    const w = await world();
    const before = await writes(w.org, w.theirs.id);
    expect(before.lead!.status).toBe('NEW');

    const refused = await (await w.me.api()).post(ENDPOINT, body({ lead_id: w.theirs.id }));
    const missing = await (await w.me.api()).post(ENDPOINT, body({ lead_id: randomUUID() }));

    expect(refused.status).toBe(404);
    expect(refused.status).toBe(missing.status);
    expect(refused.body).toEqual(missing.body);
    expect(await writes(w.org, w.theirs.id)).toEqual(before);
  });

  it('refuses a job the person cannot open the same way, and writes nothing', async () => {
    const w = await world();
    const before = await writes(w.org);

    const refused = await (await w.me.api()).post(ENDPOINT, body({ job_id: w.theirJob.id }));
    const missing = await (await w.me.api()).post(ENDPOINT, body({ job_id: randomUUID() }));

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect(await writes(w.org)).toEqual(before);
  });

  it('refuses a customer the person cannot reach the same way, and writes nothing', async () => {
    const w = await world();
    // They may open customer pages (View customers on); this customer is simply not one of theirs.
    const viewer = await personWith(w.org, { leads_scope: 'attached', jobs_scope: 'attached', view_customers: true });
    await fx.addLead(w.org, w.customer, { dispatcher: viewer.id });
    // A customer with no lead and no job the person is on.
    const stranger = randomUUID();
    await db.customer.create({
      data: { id: stranger, organization_id: w.org, customer_number: `C-${stranger.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Sam', last_name: 'Stranger' },
    });
    await fx.addLead(w.org, stranger, { assignees: [w.admin.id] });
    const before = await writes(w.org);

    const refused = await (await viewer.api()).post(ENDPOINT, body({ customer_id: stranger }));
    const missing = await (await viewer.api()).post(ENDPOINT, body({ customer_id: randomUUID() }));

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect(await writes(w.org)).toEqual(before);
  });

  it('refuses re-pointing an entry the person logged onto a lead or job they cannot open, and leaves the entry as it was', async () => {
    const w = await world();
    const api = await w.me.api();
    const created = await api.post(ENDPOINT, body({ lead_id: w.mine.id }));
    expect(created.status).toBe(201);
    const entryId = created.body.entry.id as string;
    const stored = () => db.manualCommunicationLog.findUniqueOrThrow({ where: { id: entryId } });
    const before = await stored();
    const edit = { ...body({}), channel: 'call', performed_by: w.me.id };

    for (const anchor of [{ lead_id: w.theirs.id }, { job_id: w.theirJob.id }]) {
      const res = await (await w.me.api()).put(`${ENDPOINT}/${entryId}`, { ...edit, ...anchor });
      expect(res.status).toBe(404);
      expect(await stored()).toEqual(before);
    }
  });

  it('still logs onto a lead, a job and a customer the person can open', async () => {
    const w = await world();

    const onLead = await (await w.me.api()).post(ENDPOINT, body({ lead_id: w.mine.id }));
    const onJob = await (await w.me.api()).post(ENDPOINT, body({ job_id: w.myJob.id }));

    expect(onLead.status).toBe(201);
    expect(onJob.status).toBe(201);
    expect(await db.manualCommunicationLog.count({ where: { organization_id: w.org } })).toBe(2);
  });

  it('still logs onto a customer who comes with a lead the person is on, when they may open customer pages', async () => {
    const w = await world();
    const viewer = await personWith(w.org, { leads_scope: 'attached', jobs_scope: 'attached', view_customers: true });
    await fx.addLead(w.org, w.customer, { dispatcher: viewer.id });

    const res = await (await viewer.api()).post(ENDPOINT, body({ customer_id: w.customer }));

    expect(res.status).toBe(201);
    expect(await db.manualCommunicationLog.count({ where: { organization_id: w.org, customer_id: w.customer } })).toBe(1);
  });

  it('refuses a customer for a person who may not open customer pages at all, and writes nothing', async () => {
    const w = await world();
    const blind = await personWith(w.org, { leads_scope: 'attached', jobs_scope: 'attached', view_customers: false });
    await fx.addLead(w.org, w.customer, { dispatcher: blind.id });
    const before = await writes(w.org);

    const res = await (await blind.api()).post(ENDPOINT, body({ customer_id: w.customer }));

    expect(res.status).toBe(404);
    expect(await writes(w.org)).toEqual(before);
  });

  describe('when the person\'s scope reaches nothing (the View switch is off)', () => {
    const standingOn = (key: string): string[] => {
      const direct = SWITCH_CATALOG.filter((sw) => sw.requires.includes(key)).map((sw) => sw.key);
      return [...new Set([...direct, ...direct.flatMap(standingOn)])];
    };
    const withOff = (...keys: string[]) => {
      const values: Record<string, boolean | string> = { leads_scope: 'all', jobs_scope: 'all' };
      for (const key of keys) for (const k of [key, ...standingOn(key)]) values[k] = false;
      return values;
    };

    it.each([['lead', ['view_leads']], ['job', ['view_jobs']], ['customer', ['view_customers']]] as const)(
      'refuses logging onto a %s like a missing one, and writes nothing',
      async (kind, off) => {
        const w = await world();
        const nobody = await personWith(w.org, withOff(...off));
        await fx.addLead(w.org, w.customer, { dispatcher: nobody.id });
        await fx.addJob(w.org, w.customer, { crew: [nobody.id] });
        const target = { lead: { lead_id: w.mine.id }, job: { job_id: w.myJob.id }, customer: { customer_id: w.customer } }[kind];
        const missing = { lead: { lead_id: randomUUID() }, job: { job_id: randomUUID() }, customer: { customer_id: randomUUID() } }[kind];
        const before = await writes(w.org, w.theirs.id);

        const refused = await (await nobody.api()).post(ENDPOINT, body(target));
        const gone = await (await nobody.api()).post(ENDPOINT, body(missing));

        expect(gone.status).toBe(404);
        expect(refused.status).toBe(404);
        expect(refused.body).toEqual(gone.body);
        expect(await writes(w.org, w.theirs.id)).toEqual(before);
      },
    );

    it.each([['lead', ['view_leads'], 'onMyLead'], ['job', ['view_jobs'], 'onMyJob']] as const)(
      'answers a read, a re-point and a delete of an entry on a %s like a missing entry, and changes nothing',
      async (_kind, off, which) => {
        const w = await world();
        const editor = await personWith(w.org, { ...withOff(...off), edit_others_logged_communications: true });
        await fx.addLead(w.org, w.customer, { dispatcher: editor.id });
        await fx.addJob(w.org, w.customer, { crew: [editor.id] });
        const made = await (await fx.signedInAs(w.admin)).post(ENDPOINT, body(which === 'onMyLead' ? { lead_id: w.mine.id } : { job_id: w.myJob.id }));
        expect(made.status).toBe(201);
        const entry = made.body.entry.id as string;
        const before = await db.manualCommunicationLog.findUnique({ where: { id: entry } });
        const edit = { ...body({ lead_id: w.mine.id }), channel: 'call', performed_by: editor.id };

        const statuses = [
          (await (await editor.api()).get(`${ENDPOINT}/${entry}`)).status,
          (await (await editor.api()).put(`${ENDPOINT}/${entry}`, edit)).status,
          (await (await editor.api()).delete(`${ENDPOINT}/${entry}`)).status,
        ];

        expect(statuses).toEqual([404, 404, 404]);
        expect(await db.manualCommunicationLog.findUnique({ where: { id: entry } })).toEqual(before);
      },
    );
  });

  describe('an entry already on a record the person cannot open', () => {
    /** A colleague's entry on each kind of record, made through the API as the Admin, so a lead it reached is Contacted. */
    async function entries() {
      const w = await world();
      const editor = await personWith(w.org, { leads_scope: 'attached', jobs_scope: 'attached', view_customers: true, edit_others_logged_communications: true });
      const mineLead = await fx.addLead(w.org, w.customer, { dispatcher: editor.id });
      const admin = await fx.signedInAs(w.admin);
      const make = async (anchor: { lead_id?: string; job_id?: string; customer_id?: string }) => {
        const res = await (await fx.signedInAs(w.admin)).post(ENDPOINT, body(anchor));
        expect(res.status).toBe(201);
        return res.body.entry.id as string;
      };
      expect(admin).toBeTruthy();
      const stranger = randomUUID();
      await db.customer.create({
        data: { id: stranger, organization_id: w.org, customer_number: `C-${stranger.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Sam', last_name: 'Stranger' },
      });
      await fx.addLead(w.org, stranger, { assignees: [w.admin.id] });
      return {
        w, editor, mineLead,
        onTheirLead: await make({ lead_id: w.theirs.id }),
        onTheirJob: await make({ job_id: w.theirJob.id }),
        onStranger: await make({ customer_id: stranger }),
        onMyLead: await make({ lead_id: mineLead.id }),
      };
    }
    const stored = (id: string) => db.manualCommunicationLog.findUnique({ where: { id } });
    const leadState = (id: string) => db.lead.findUniqueOrThrow({ where: { id }, select: { status: true, contacted_at: true } });

    it.each([['lead', 'onTheirLead'], ['job', 'onTheirJob'], ['customer', 'onStranger']] as const)(
      'answers a read, a re-point and a delete of an entry on a %s they cannot open like a missing entry, and changes nothing',
      async (_kind, which) => {
        const e = await entries();
        const entry = e[which];
        const before = await stored(entry);
        const leadBefore = await leadState(e.w.theirs.id);
        expect(leadBefore.status).toBe('CONTACTED');
        const edit = { ...body({ lead_id: e.mineLead.id }), channel: 'call', performed_by: e.editor.id };
        const missingId = randomUUID();

        const read = await (await e.editor.api()).get(`${ENDPOINT}/${entry}`);
        const readMissing = await (await e.editor.api()).get(`${ENDPOINT}/${missingId}`);
        const move = await (await e.editor.api()).put(`${ENDPOINT}/${entry}`, edit);
        const moveMissing = await (await e.editor.api()).put(`${ENDPOINT}/${missingId}`, edit);
        const del = await (await e.editor.api()).delete(`${ENDPOINT}/${entry}`);
        const delMissing = await (await e.editor.api()).delete(`${ENDPOINT}/${missingId}`);

        for (const [refused, missing] of [[read, readMissing], [move, moveMissing], [del, delMissing]] as const) {
          expect(missing.status).toBe(404);
          expect(refused.status).toBe(404);
          expect(refused.body).toEqual(missing.body);
        }
        expect(await stored(entry)).toEqual(before);
        expect(await leadState(e.w.theirs.id)).toEqual(leadBefore);
      },
    );

    it('still lets the holder of the edit switch read, move and delete an entry on a lead they can open', async () => {
      const e = await entries();
      const edit = { ...body({ lead_id: e.mineLead.id }), channel: 'call', performed_by: e.editor.id, notes: 'Corrected by the editor.' };

      expect((await (await e.editor.api()).get(`${ENDPOINT}/${e.onMyLead}`)).status).toBe(200);
      expect((await (await e.editor.api()).put(`${ENDPOINT}/${e.onMyLead}`, edit)).status).toBe(200);
      expect((await stored(e.onMyLead))!.notes).toBe('Corrected by the editor.');
      expect((await (await e.editor.api()).delete(`${ENDPOINT}/${e.onMyLead}`)).status).toBe(204);
      expect(await stored(e.onMyLead)).toBeNull();
    });
  });

  it('still logs onto any lead for a person whose scope is All', async () => {
    const w = await world();
    const wide: Person & { api: () => Promise<Awaited<ReturnType<typeof fx.signedInAs>>> } = await personWith(w.org, { leads_scope: 'all', jobs_scope: 'all' });

    const res = await (await wide.api()).post(ENDPOINT, body({ lead_id: w.theirs.id }));

    expect(res.status).toBe(201);
  });
});
