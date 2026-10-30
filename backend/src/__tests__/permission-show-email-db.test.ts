/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): Show Email off closes the person's mailbox on the server.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The
   real dispatcher runs; only the mail provider's client is faked, so no email leaves the machine.

   Two cases, both driven from the route file itself so a route added later joins them:
    - the table: every route of the mail router answers 403 to a person holding every other Communication switch with
      Show Email off, and answers something other than a refusal with it on;
    - the journey: the same person writes, lists, reads and files mail with Show Email on, is refused every one of those
      with it off (and nothing is sent or changed), and has them back the moment it is on again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, { RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { scanRouteGates } from './permission-communication-routes-scan';
import { RECORD_TAB_ROUTES } from './permission-show-email-routes';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

/** Every route of the mail router, read from its source, with the placeholders in its path filled in. */
const MAIL_ROUTES = scanRouteGates(readFileSync(join(__dirname, '..', 'routes', 'comm-email.routes.ts'), 'utf8'), '/api/communication');
const SOME_ID = randomUUID();
const concrete = (path: string) => path.replace(/:index/g, '0').replace(/:[a-zA-Z]+/g, SOME_ID);

suite('Show Email closes the mail routes on the server (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['email_read_states', 'emails', 'reply_tokens', 'email_threads', 'mailbox_readers', 'mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  type Who = Person & { api: () => ReturnType<typeof fx.signedInAs>; role: string; org: string; mailbox: string };
  let sequence = 0;

  /** A company that sends mail, with its main mailbox and address. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { email_sending_enabled: true, email_sender_local_part: part } });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    return { ...made, part };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** Every Communication switch the mail routes ask for besides Show Email, on; Show Email as given. */
  const mailSwitches = (showEmail: boolean) => ({
    access_communication: true, show_email: showEmail, view_communication: true, communication_scope: 'all',
    contact_customers: true, attach_conversations: true, edit_communication_records: true,
  });

  async function personWith(w: World, showEmail: boolean): Promise<Who> {
    const role = `se-role-${++sequence}`;
    const row = await fx.addCustomRole(w.org, role, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: w.org, roleKey: role, values: mailSwitches(showEmail), actorId: null, reason: 'manual' });
    const person = await fx.addUser(w.org, `p${sequence}`, 'DISPATCHER', { customRoleId: row.id });
    const mailbox = randomUUID();
    await db.mailbox.create({
      data: { id: mailbox, organization_id: w.org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'active' },
    });
    await db.mailboxAddress.create({
      data: { local_part: `${person.email.split('@')[0]}.${w.part}`.toLowerCase(), organization_id: w.org, mailbox_id: mailbox, is_primary: true },
    });
    return Object.assign(person, { api: () => fx.signedInAs(person), role, org: w.org, mailbox });
  }
  const setShowEmail = (p: Who, on: boolean) =>
    setRoleSwitchValues({ organizationId: p.org, roleKey: p.role, values: { show_email: on }, actorId: null, reason: 'manual' });

  /** An inbound conversation in `mailbox`. */
  async function addConversation(w: World, mailbox: string) {
    const thread = randomUUID();
    await db.emailThread.create({ data: { id: thread, organization_id: w.org, mailbox_id: mailbox, origin: 'started', assigned_to_user_id: null } });
    const email = randomUUID();
    await db.email.create({
      data: {
        id: email, organization_id: w.org, thread_id: thread, customer_id: w.customer, account: 'user', direction: 'in', folder: 'inbox',
        from: { name: null, email: 'customer@example.com' }, to: 'office@example.com',
        subject: 'run-show-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
      },
      select: { id: true },
    });
    return { thread, email };
  }

  const call = (api: Awaited<ReturnType<typeof fx.signedInAs>>, r: { method: string; path: string }) => {
    const path = concrete(r.path);
    switch (r.method) {
      case 'get': return api.get(path);
      case 'post': return api.post(path, {});
      case 'put': return api.put(path, {});
      case 'patch': return api.patch(path, {});
      default: return api.delete(path);
    }
  };

  const RECORD_TAB = new Set(Object.keys(RECORD_TAB_ROUTES));
  const keyOf = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
  const PAGE_ROUTES = MAIL_ROUTES.filter((r) => !RECORD_TAB.has(keyOf(r)));
  const TAB_ROUTES = MAIL_ROUTES.filter((r) => RECORD_TAB.has(keyOf(r)));

  describe('the table: every route of the mail router', () => {
    it('finds the routes (guards against a table that reads nothing and so passes)', () => {
      expect(PAGE_ROUTES.length).toBeGreaterThan(15);
      expect(TAB_ROUTES).toHaveLength(RECORD_TAB.size);
    });

    it('answers 403 on every Email page route to a person with Show Email off, holding every other Communication switch', async () => {
      const w = await newOrg();
      const me = await personWith(w, false);
      const letIn: string[] = [];
      for (const r of PAGE_ROUTES) {
        const res = await call(await me.api(), r);
        if (res.status !== 403) letIn.push(`${keyOf(r)} -> ${res.status}`);
        else expect(res.body.error, r.path).toBe('Insufficient permissions');
      }
      expect(letIn).toEqual([]);
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('does not refuse the same person on any Email page route with Show Email on', async () => {
      const w = await newOrg();
      const me = await personWith(w, true);
      const refused: string[] = [];
      for (const r of PAGE_ROUTES) {
        const res = await call(await me.api(), r);
        if ([401, 402, 403].includes(res.status)) refused.push(`${keyOf(r)} -> ${res.status}`);
      }
      expect(refused).toEqual([]);
    });

    it('answers 403 to the same routes written another way: capitals, a trailing slash, a doubled slash', async () => {
      const w = await newOrg();
      const me = await personWith(w, false);
      const letIn: string[] = [];
      for (const path of [
        '/api/communication/EMAILS', '/api/communication/emails/', '/api/Communication/Emails', '/api/communication//emails',
        '/api/communication/Mailboxes/', '/api/communication/MY-MAILBOX', `/api/communication/emails/${SOME_ID.toUpperCase()}`,
        `/api/communication/Emails/${SOME_ID}/attachments/0/`,
      ]) {
        const res = await (await me.api()).get(path);
        if (res.status !== 403) letIn.push(`${path} -> ${res.status}`);
      }
      expect(letIn).toEqual([]);
    });

    it('leaves the record-tab routes as they were: Show Email off is not what refuses them', async () => {
      const w = await newOrg();
      const me = await personWith(w, false);
      const refused: string[] = [];
      for (const r of TAB_ROUTES) {
        // A send that names no record is the Email page's own (below); the others answer whatever their own rules say.
        if (keyOf(r) === 'POST /api/communication/emails') continue;
        const res = await call(await me.api(), r);
        if ([401, 402, 403].includes(res.status)) refused.push(`${keyOf(r)} -> ${res.status}`);
      }
      expect(refused).toEqual([]);
    });
  });

  describe('the journey: a person writes, lists, reads and files mail, loses the switch, and gets it back', () => {
    type A = Awaited<ReturnType<typeof fx.signedInAs>>;

    it('is served with Show Email on, refused on each Email page action with it off (nothing sent or changed), still writes from a customer\'s page, and is served again with it on', async () => {
      const w = await newOrg();
      const me = await personWith(w, true);
      const { thread, email } = await addConversation(w, me.mailbox);

      /** The Email page's actions, as the screen makes them. */
      const pageActions: { name: string; run: (a: A) => Promise<{ status: number }>; ok: number }[] = [
        { name: 'list', run: (a) => a.get('/api/communication/emails'), ok: 200 },
        { name: 'read', run: (a) => a.get(`/api/communication/emails/${email}`), ok: 200 },
        { name: 'mailboxes', run: (a) => a.get('/api/communication/mailboxes'), ok: 200 },
        { name: 'my mailbox', run: (a) => a.get('/api/communication/my-mailbox'), ok: 200 },
        { name: 'mark read', run: (a) => a.patch('/api/communication/emails/thread-read', { thread_id: thread }), ok: 200 },
        { name: 'archive', run: (a) => a.patch(`/api/communication/emails/threads/${thread}/archive`, { archived: true }), ok: 200 },
        { name: 'assign', run: (a) => a.patch(`/api/communication/emails/threads/${thread}/assign`, { user_id: me.id }), ok: 200 },
        { name: 'send', run: (a) => a.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Hello', body: ['Hi'] }), ok: 201 },
        { name: 'reply', run: (a) => a.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Re', body: ['Hi'], thread_id: thread }), ok: 201 },
        { name: 'attachment', run: (a) => a.get(`/api/communication/emails/${email}/attachments/0`), ok: 404 },
      ];
      /** What a customer's page does: the sender line and a send that names the customer. */
      const tabActions: typeof pageActions = [
        { name: 'sender line', run: (a) => a.get('/api/communication/sending-identity'), ok: 200 },
        { name: 'send from the customer page', run: (a) => a.post('/api/communication/emails', { to: 'customer@example.com', subject: 'Hi', body: ['Hi'], customer_id: w.customer }), ok: 201 },
      ];
      const run = async (actions: typeof pageActions) => {
        const got: string[] = [];
        for (const action of actions) got.push(`${action.name}:${(await action.run(await me.api())).status}`);
        return got;
      };

      // On: every action is served.
      const served = await run(pageActions);
      expect(served).toEqual(pageActions.map((a) => `${a.name}:${a.ok}`));
      expect(await run(tabActions)).toEqual(tabActions.map((a) => `${a.name}:${a.ok}`));
      const sentWhileOn = resendSend.mock.calls.length;
      expect(sentWhileOn).toBe(3);
      const emailsWhileOn = await db.email.count({ where: { organization_id: w.org } });

      // Off: every Email page action is refused, and nothing was sent or stored.
      await setShowEmail(me, false);
      expect(await run(pageActions)).toEqual(pageActions.map((a) => `${a.name}:403`));
      expect(resendSend.mock.calls.length).toBe(sentWhileOn);
      expect(await db.email.count({ where: { organization_id: w.org } })).toBe(emailsWhileOn);
      // A customer's page still writes to the customer from the person's own address: Contact customers decides that.
      expect(await run(tabActions)).toEqual(tabActions.map((a) => `${a.name}:${a.ok}`));
      expect(resendSend.mock.calls.length).toBe(sentWhileOn + 1);

      // On again: the Email page is served again.
      await setShowEmail(me, true);
      expect(await run(pageActions)).toEqual(served);
    });

    it('leaves the mail out of the unread badge for a person with Show Email off, and counts it with it on', async () => {
      const w = await newOrg();
      const me = await personWith(w, true);
      await addConversation(w, me.mailbox);

      const on = await (await me.api()).get('/api/communication/unread-counts');
      expect(on.status).toBe(200);
      expect(on.body.email).toBe(1);

      await setShowEmail(me, false);
      const off = await (await me.api()).get('/api/communication/unread-counts');
      expect(off.status).toBe(200);
      expect(off.body.email).toBe(0);
    });
  });
});
