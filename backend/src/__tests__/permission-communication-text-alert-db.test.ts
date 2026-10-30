/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.23 - the inbound-text alert goes to people by their switches, their scope, their place on
   the record and the reply they are waiting on, never by a role name; and its preview reaches only them.

   An inbound text reaches the union of: the people on the job or lead the text is tied to (Owner or Sold By, Dispatcher, crew),
   the holders of Communication scope "All", everyone linked to the company number it came in on (for the main line, the people
   ticked on it and the people the main-line fallback covers) and the person reply attribution names (the sender of the latest
   outbound text before it, in the same conversation and on the same company number). Every one of them is active, holds Access
   Communication and passes the access filter (S08.21), which has the last word.

   Every case drives the REAL text ingest entry point with a synthetic payload (no text is sent), the way the webhook does: the
   alert is handed over by `afterCommit` and run once the row is stored. People are on custom roles built from the catalog (never
   a built-in role name, except the cases that pin what the built-in presets give). Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('the inbound-text alert goes to switches, scope, numbers and replies (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notification_recipients WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Member = Person & { base: Role };
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of SWITCH_CATALOG) {
        if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
      }
    }
    return out;
  };

  /**
   * A person on a fresh custom role of this base holding exactly these switch values, linked to these company numbers. The base
   * defaults to Technician, a role the old alert never reached: whoever is told here is told by switches, scope and numbers.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; numbers?: string[]; inactive?: boolean } = {},
  ): Promise<Member> {
    const base = opts.base ?? 'TECHNICIAN';
    const key = `text-alert-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    const all = {
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
      access_communication: true, view_communication: true, communication_scope: 'attached',
      see_main_line_when_no_number: false, ...values,
    };
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: all, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    for (const phone_number_id of opts.numbers ?? []) await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id } });
    if (opts.inactive) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { base });
  }

  async function addNumber(org: string, tag: string, opts: { orgDefault?: boolean } = {}) {
    const id = randomUUID();
    const e164 = `+1555${String(++sequence).padStart(7, '0')}`;
    await db.phoneNumber.create({
      data: { id, organization_id: org, e164, label: tag, is_org_default: opts.orgDefault ?? false, status: 'active' },
    });
    return { id, e164 };
  }

  /** An earlier outbound text of the conversation: who sent it (null: automated or sent from outside the app) and on which number. */
  interface Earlier { by: string | null; number: { id: string } | null; minutesAgo: number; jobId?: string }

  /**
   * An inbound text arriving through the real ingest, the way the webhook runs it: the alert is handed over and run once the row
   * is stored. `earlier` puts outbound texts in the conversation first; `jobId` is a job the office last texted about from this
   * conversation (the router then ties the reply to it); `leadId` ties the stored text to a lead the way an attach would, before
   * the alert runs. Returns who was told, and the alert row.
   */
  async function textIn(
    org: string, number: { e164: string } | null,
    opts: { body?: string; sid?: string; counterpart?: string; earlier?: Earlier[]; leadId?: string; media?: string[]; reuseThread?: boolean } = {},
  ) {
    const sid = opts.sid ?? `MSG-s0823-${randomUUID().slice(0, 12)}`;
    const counterpart = opts.counterpart ?? `+1555555${String(++sequence).padStart(4, '0').slice(-4)}`;
    let thread = await db.messageThread.findFirst({ where: { organization_id: org, channel: 'sms', title: counterpart } });
    if (!thread) {
      thread = await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', title: counterpart } });
    }
    for (const e of opts.earlier ?? []) {
      await db.message.create({
        data: {
          organization_id: org, thread_id: thread.id, direction: 'out', body: 'run-earlier', status: 'sent',
          ts: new Date(Date.now() - e.minutesAgo * 60_000), phone_number_id: e.number?.id ?? null, sent_by_user_id: e.by,
          job_id: e.jobId ?? null, job_label: e.jobId ? 'J' : null,
        },
      });
    }
    const { ingestSms } = await import('../lib/ctm/ingest.js');
    const raised: Array<() => Promise<unknown>> = [];
    const payload: Record<string, unknown> = {
      message_id: sid, account_id: 596375, caller_number: counterpart, tracking_number: number?.e164 ?? '+15555550199',
      direction: 'msg_inbound', message_body: opts.body ?? 'run-hello', unix_time: Math.floor(Date.now() / 1000),
      ...(opts.media ? { message_media: opts.media } : {}),
    };
    const result = await ingestSms(db, org, payload, { afterCommit: (raise) => { raised.push(raise); } });
    if (opts.leadId) await db.message.update({ where: { id: result!.messageId }, data: { lead_id: opts.leadId } });
    await Promise.all(raised.map((raise) => raise()));
    return { sid, threadId: result!.threadId, messageId: result!.messageId, counterpart, ...(await alertFor(org, sid)) };
  }

  async function alertFor(org: string, sid: string) {
    const notification = await db.notification.findFirst({
      where: { organization_id: org, dedup_key: `ctm:${sid}:inbound` },
      select: {
        id: true, title: true, body: true, data: true, priority: true, needs_action: true, object_type: true, object_id: true,
        recipients: { select: { id: true, recipient_id: true, priority: true, needs_action: true } },
      },
    });
    return {
      notification,
      told: new Set((notification?.recipients ?? []).map((r) => r.recipient_id)),
      recipients: notification?.recipients ?? [],
    };
  }

  /** Who is told, as a sorted list of the labels the case gave the people, so a failure names them. */
  const names = (told: Set<string>, people: Record<string, { id: string }>) =>
    Object.entries(people).filter(([, p]) => told.has(p.id)).map(([label]) => label).sort();

  // ─── Switches, scope and numbers ───────────────────────────────────────────────────────────

  it('tells a holder of All, the people linked to the number and the people on the tied job, and nobody else', async () => {
    const { org, admin, customer } = await newOrg();
    const texted = await addNumber(org, 'run-texted');
    const other = await addNumber(org, 'run-other');

    const soldBy = await personWith(org, {});
    const dispatcher = await personWith(org, {});
    const crew = await personWith(org, {});
    const removedCrew = await personWith(org, {});
    const job = await fx.addJob(org, customer, { crew: [crew.id, removedCrew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });
    await fx.removeCrew(job.visitId!, removedCrew.id);

    const people = {
      holderOfAll: await personWith(org, { communication_scope: 'all' }),
      linkedToTexted: await personWith(org, {}, { numbers: [texted.id] }),
      linkedToTextedAndOther: await personWith(org, {}, { numbers: [texted.id, other.id] }),
      narrowNotLinked: await personWith(org, {}),
      linkedToOtherOnly: await personWith(org, {}, { numbers: [other.id] }),
      linkedNoAccess: await personWith(org, withDependantsOff(['access_communication']), { numbers: [texted.id] }),
      linkedNoView: await personWith(org, withDependantsOff(['view_communication']), { numbers: [texted.id] }),
      soldBy, dispatcher, crew, removedCrew,
    };

    // The office last texted this customer about the job from this conversation, so the reply is tied to it.
    const { told, notification } = await textIn(org, texted, { earlier: [{ by: null, number: texted, minutesAgo: 30, jobId: job.id }] });

    expect(names(told, people)).toEqual(['crew', 'dispatcher', 'holderOfAll', 'linkedToTexted', 'linkedToTextedAndOther', 'soldBy']);
    // The built-in Admin holds every switch on its preset, Communication scope All included: told through All, like anyone on it.
    expect(told.has(admin.id)).toBe(true);
    expect(notification!.title).toMatch(/^New text/);
  }, 240_000);

  it('tells the Owner, the Dispatcher and the walkthrough crew of the lead the text is tied to, not an assignee', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const owner = await personWith(org, {});
    const dispatcher = await personWith(org, {});
    const walkthrough = await personWith(org, {});
    const assignee = await personWith(org, {});
    const lead = await fx.addLead(org, customer, { owner: owner.id, dispatcher: dispatcher.id, walkthroughCrew: [walkthrough.id], assignees: [assignee.id] });
    const people = { owner, dispatcher, walkthrough, assignee };

    const { told } = await textIn(org, number, { leadId: lead.id });

    // The record's people are the Owner, the Dispatcher and the crew of its walkthroughs: an assignee is not one of them.
    expect(names(told, people)).toEqual(['dispatcher', 'owner', 'walkthrough']);
  }, 240_000);

  it('does not widen what a person on the record reads: someone who cannot open the job is dropped by the filter', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const crewNoJobs = await personWith(org, withDependantsOff(['view_jobs']));
    const job = await fx.addJob(org, customer, { crew: [crewNoJobs.id] });

    const { told } = await textIn(org, number, { earlier: [{ by: null, number, minutesAgo: 30, jobId: job.id }] });

    expect(told.has(crewNoJobs.id)).toBe(false);
  }, 120_000);

  it('tells the people of a text tied to no record only through the scope and the number', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const people = {
      linked: await personWith(org, {}, { numbers: [number.id] }),
      holderOfAll: await personWith(org, { communication_scope: 'all' }),
      narrow: await personWith(org, {}),
    };

    const { told } = await textIn(org, number);

    expect(names(told, people)).toEqual(['holderOfAll', 'linked']);
  }, 120_000);

  // ─── The main line ─────────────────────────────────────────────────────────────────────────

  it('tells the people ticked on the main line and the people the main-line fallback covers, not the rest', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const mine = await addNumber(org, 'run-mine');

    const people = {
      tickedOnMain: await personWith(org, {}, { numbers: [main.id] }),
      noNumberFallbackOn: await personWith(org, { see_main_line_when_no_number: true }),
      noNumberFallbackOff: await personWith(org, { see_main_line_when_no_number: false }),
      ownNumberFallbackOn: await personWith(org, { see_main_line_when_no_number: true }, { numbers: [mine.id] }),
      ownNumberFallbackOff: await personWith(org, { see_main_line_when_no_number: false }, { numbers: [mine.id] }),
      holderOfAll: await personWith(org, { communication_scope: 'all' }),
    };

    const { told } = await textIn(org, main);

    expect(names(told, people)).toEqual(['holderOfAll', 'noNumberFallbackOn', 'tickedOnMain']);
  }, 240_000);

  it('does not apply the main-line fallback to a text on any other number', async () => {
    const { org } = await newOrg();
    await addNumber(org, 'run-main', { orgDefault: true });
    const other = await addNumber(org, 'run-other');
    const fallback = await personWith(org, { see_main_line_when_no_number: true });

    const { told } = await textIn(org, other);

    expect(told.has(fallback.id)).toBe(false);
  }, 120_000);

  it('stops the fallback for a person once a number is linked to them, and starts it again when it is unlinked', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const mine = await addNumber(org, 'run-mine');
    const person = await personWith(org, { see_main_line_when_no_number: true });

    expect((await textIn(org, main)).told.has(person.id)).toBe(true);
    await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id: mine.id } });
    expect((await textIn(org, main)).told.has(person.id)).toBe(false);
    await db.userPhoneNumber.delete({ where: { user_id_phone_number_id: { user_id: person.id, phone_number_id: mine.id } } });
    expect((await textIn(org, main)).told.has(person.id)).toBe(true);
  }, 120_000);

  // ─── Reply attribution ─────────────────────────────────────────────────────────────────────

  it('tells the sender of the latest outbound text on that number in that conversation, even with no linked number', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    // Linked to Calls-only scope, no number, fallback off: nothing but the reply route can name them.
    const sender = await personWith(org, { see_main_line_when_no_number: false });
    const bystander = await personWith(org, { see_main_line_when_no_number: false });

    const { told, recipients } = await textIn(org, main, { earlier: [{ by: sender.id, number: main, minutesAgo: 10 }] });

    expect(told.has(sender.id)).toBe(true);
    expect(told.has(bystander.id)).toBe(false);
    // They are a feed item like everyone else's.
    expect(recipients.find((r) => r.recipient_id === sender.id)).toMatchObject({ priority: 'FEED', needs_action: false });
  }, 120_000);

  it('does not tell an earlier sender who is not the latest, unless they qualify some other way', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const first = await personWith(org, {});
    const latest = await personWith(org, {});
    const firstAndLinked = await personWith(org, {}, { numbers: [main.id] });

    const { told } = await textIn(org, main, {
      earlier: [
        { by: first.id, number: main, minutesAgo: 30 },
        { by: firstAndLinked.id, number: main, minutesAgo: 25 },
        { by: latest.id, number: main, minutesAgo: 10 },
      ],
    });

    expect(told.has(latest.id)).toBe(true);
    expect(told.has(first.id)).toBe(false);
    // The earlier sender who is also linked to the number is told, by the number, not by the reply.
    expect(told.has(firstAndLinked.id)).toBe(true);
  }, 120_000);

  it('does not tell a sender whose latest outbound text went out on a different company number', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const elsewhere = await addNumber(org, 'run-elsewhere');
    const sentFromElsewhere = await personWith(org, {});
    const sentFromMain = await personWith(org, {});

    // Same conversation: one person texted from another number more recently, the other from the number the customer replied to.
    const { told } = await textIn(org, main, {
      earlier: [
        { by: sentFromMain.id, number: main, minutesAgo: 20 },
        { by: sentFromElsewhere.id, number: elsewhere, minutesAgo: 5 },
      ],
    });

    expect(told.has(sentFromMain.id)).toBe(true);
    expect(told.has(sentFromElsewhere.id)).toBe(false);
  }, 120_000);

  it('does not tell a deactivated sender', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const gone = await personWith(org, {}, { inactive: true });
    const active = await personWith(org, { communication_scope: 'all' });

    const { told } = await textIn(org, main, { earlier: [{ by: gone.id, number: main, minutesAgo: 10 }] });

    expect(told.has(gone.id)).toBe(false);
    expect(told.has(active.id)).toBe(true);
  }, 120_000);

  it('names nobody for a reply to an automated text, even when a person texted before it', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const earlierSender = await personWith(org, {});

    const { told } = await textIn(org, main, {
      earlier: [{ by: earlierSender.id, number: main, minutesAgo: 30 }, { by: null, number: main, minutesAgo: 10 }],
    });

    expect(told.has(earlierSender.id)).toBe(false);
  }, 120_000);

  it('still requires the sender to hold Access Communication and View communication', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const noAccess = await personWith(org, withDependantsOff(['access_communication']));
    const noView = await personWith(org, withDependantsOff(['view_communication']));

    const first = await textIn(org, main, { earlier: [{ by: noAccess.id, number: main, minutesAgo: 10 }] });
    const second = await textIn(org, main, { earlier: [{ by: noView.id, number: main, minutesAgo: 10 }] });

    expect(first.told.has(noAccess.id)).toBe(false);
    expect(second.told.has(noView.id)).toBe(false);
  }, 120_000);

  it('does not tell a sender the reply was not addressed to: their text is in another conversation', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const otherChat = await personWith(org, {});
    await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', title: '+15555559999' } });
    await textIn(org, main, { counterpart: '+15555559999', earlier: [{ by: otherChat.id, number: main, minutesAgo: 10 }] });

    const { told } = await textIn(org, main, { counterpart: '+15555558888' });

    expect(told.has(otherChat.id)).toBe(false);
  }, 120_000);

  it('uses the same rule as the inbox: the person it names is the person whose list holds the reply', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const sender = await personWith(org, {});
    const { messageId, threadId, told } = await textIn(org, main, { earlier: [{ by: sender.id, number: main, minutesAgo: 10 }] });
    expect(told.has(sender.id)).toBe(true);

    const api = await fx.signedInAs(sender);
    const listed = await api.get('/api/communication/threads');
    expect(listed.status).toBe(200);
    const thread = await api.get(`/api/communication/threads/${threadId}`);
    expect(thread.status).toBe(200);
    expect(JSON.stringify(thread.body)).toContain(messageId);
  }, 120_000);

  // ─── Deactivated people ────────────────────────────────────────────────────────────────────

  it('never tells a deactivated person, whichever way they would qualify', async () => {
    const { org, customer } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const texted = await addNumber(org, 'run-texted');
    const soldBy = await personWith(org, {}, { inactive: true });
    const crew = await personWith(org, {}, { inactive: true });
    const job = await fx.addJob(org, customer, { crew: [crew.id], soldBy: soldBy.id });
    const replied = await personWith(org, {}, { inactive: true });
    const people = {
      byAll: await personWith(org, { communication_scope: 'all' }, { inactive: true }),
      byLink: await personWith(org, {}, { numbers: [texted.id], inactive: true }),
      byFallback: await personWith(org, { see_main_line_when_no_number: true }, { inactive: true }),
      byMainLineTick: await personWith(org, {}, { numbers: [main.id], inactive: true }),
      byReply: replied,
      soldBy, crew,
    };
    const active = await personWith(org, { communication_scope: 'all' });

    const onJob = await textIn(org, texted, { earlier: [{ by: replied.id, number: texted, minutesAgo: 5, jobId: job.id }] });
    const onMain = await textIn(org, main);

    expect(names(onJob.told, people)).toEqual([]);
    expect(names(onMain.told, people)).toEqual([]);
    // The check is not vacuous: an active holder of All is told both times.
    expect(onJob.told.has(active.id)).toBe(true);
    expect(onMain.told.has(active.id)).toBe(true);
  }, 240_000);

  // ─── The "Alert me about every ..." switches ───────────────────────────────────────────────

  it('adds nobody for a person who holds an "Alert me about every ..." switch', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const everyAlert = SWITCH_CATALOG.map((s) => s.key).filter((k) => k.startsWith('alert_every_'));
    expect(everyAlert.length).toBeGreaterThanOrEqual(4);
    const holder = await personWith(org, { view_estimates: true, view_invoices: true, ...Object.fromEntries(everyAlert.map((k) => [k, true])) });
    const bystander = await personWith(org, {});
    const linked = await personWith(org, {}, { numbers: [number.id] });

    const { told } = await textIn(org, number);

    expect(told.has(holder.id)).toBe(false);
    expect(told.has(bystander.id)).toBe(false);
    // Still not vacuous: the text alerts the person linked to the number.
    expect(told.has(linked.id)).toBe(true);
  }, 120_000);

  // ─── No role name decides ──────────────────────────────────────────────────────────────────

  it('treats the built-in Admin and Dispatcher presets by their switches, and copies of them by their own values', async () => {
    const { org, admin } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const other = await addNumber(org, 'run-other');
    const builtInDispatcher = await fx.addUser(org, 'builtin-dispatcher', 'DISPATCHER');
    const builtInSales = await fx.addUser(org, 'builtin-sales', 'SALES');
    const builtInTech = await fx.addUser(org, 'builtin-tech', 'TECHNICIAN');
    const copyOfAdmin = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, { base: 'ADMIN' });
    const copyOfDispatcher = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, { base: 'DISPATCHER' });

    const onOther = await textIn(org, other);
    const onMain = await textIn(org, main);

    // The Admin box holds every switch, Communication scope All among them: told for any text, through All.
    expect(onOther.told.has(admin.id)).toBe(true);
    expect(onMain.told.has(admin.id)).toBe(true);
    // The Dispatcher preset is Linked to me with the main-line fallback on: the main line's texts, and no other number's.
    expect(onOther.told.has(builtInDispatcher.id)).toBe(false);
    expect(onMain.told.has(builtInDispatcher.id)).toBe(true);
    // Sales is the same shape. The Technician preset has the fallback off: no main-line text either.
    expect(onOther.told.has(builtInSales.id)).toBe(false);
    expect(onMain.told.has(builtInSales.id)).toBe(true);
    expect(onOther.told.has(builtInTech.id)).toBe(false);
    expect(onMain.told.has(builtInTech.id)).toBe(false);
    // A copy of Admin or Dispatcher on Linked to me with no link and the fallback off is told nothing, on either number.
    for (const copy of [copyOfAdmin, copyOfDispatcher]) {
      expect(onOther.told.has(copy.id)).toBe(false);
      expect(onMain.told.has(copy.id)).toBe(false);
    }
  }, 240_000);

  it('tells a copy of Admin set to Linked to me by its fallback value alone: on, it is told the main line, off, it is not', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const fallbackOn = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true }, { base: 'ADMIN' });
    const fallbackOff = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, { base: 'ADMIN' });

    const { told } = await textIn(org, main);

    expect(told.has(fallbackOn.id)).toBe(true);
    expect(told.has(fallbackOff.id)).toBe(false);
  }, 120_000);

  // ─── Other companies ───────────────────────────────────────────────────────────────────────

  it('never tells a person of another company, even one linked to the number or on All', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const stranger = await newOrg();
    const strangerAll = await personWith(stranger.org, { communication_scope: 'all' });
    const strangerLinked = await personWith(stranger.org, {});
    // A link row that crosses companies cannot be made through the app; if one existed, it still tells nobody.
    await db.userPhoneNumber.create({ data: { user_id: strangerLinked.id, phone_number_id: number.id } });

    const { told } = await textIn(org, number);

    for (const person of [stranger.admin, strangerAll, strangerLinked]) expect(told.has(person.id)).toBe(false);
    expect(await db.notificationRecipient.count({ where: { organization_id: stranger.org } })).toBe(0);
  }, 120_000);

  // ─── Weight, duplicates and an empty answer ────────────────────────────────────────────────

  it('stays a feed item that asks for nothing, for everyone it tells', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    await personWith(org, {}, { numbers: [number.id] });
    await personWith(org, { communication_scope: 'all' });

    const { notification, recipients } = await textIn(org, number);

    expect(notification!.priority).toBe('FEED');
    expect(notification!.needs_action).toBe(false);
    expect(notification!.object_type).toBe('MESSAGE_THREAD');
    expect(recipients.length).toBeGreaterThanOrEqual(3); // both, and the built-in Admin
    for (const r of recipients) {
      expect(r.priority).toBe('FEED');
      expect(r.needs_action).toBe(false);
    }
  }, 120_000);

  it('tells a person found by several routes once, and a webhook retry writes no second alert', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const several = await personWith(org, { communication_scope: 'all' }, { numbers: [number.id] });
    const job = await fx.addJob(org, customer, { crew: [several.id], soldBy: several.id, dispatcher: several.id });
    const sid = `MSG-s0823-${randomUUID().slice(0, 12)}`;
    const counterpart = '+15555557777';

    const first = await textIn(org, number, {
      sid, counterpart, earlier: [{ by: several.id, number, minutesAgo: 10, jobId: job.id }],
    });
    const retry = await textIn(org, number, { sid, counterpart });

    expect(first.recipients.filter((r) => r.recipient_id === several.id)).toHaveLength(1);
    expect(retry.notification!.id).toBe(first.notification!.id);
    expect(await db.notification.count({ where: { organization_id: org, dedup_key: `ctm:${sid}:inbound` } })).toBe(1);
    expect(await db.notificationRecipient.count({ where: { notification_id: first.notification!.id } })).toBe(first.recipients.length);
  }, 120_000);

  it('ends cleanly when nobody is to be told: no alert is written, nothing throws, and the empty answer is there to be hooked', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    // Nobody active at all: the built-in Admin is the only person, and it is deactivated.
    await db.user.updateMany({ where: { organization_id: org }, data: { is_active: false } });

    const { notification, told, threadId, messageId } = await textIn(org, number);

    expect(told.size).toBe(0);
    expect(notification).toBeNull();
    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect(await conversationAlertRecipients({ kind: 'text', organizationId: org, threadId, messageId })).toEqual([]);
  }, 120_000);

  it('counts nobody who cannot use the section: the empty answer comes after the access filter, not before it', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    await db.user.updateMany({ where: { organization_id: org }, data: { is_active: false } });
    // Named by All, by the number and by the reply, and none can use the section.
    const sender = await personWith(org, withDependantsOff(['access_communication']));
    await personWith(org, { ...withDependantsOff(['access_communication']), communication_scope: 'all' });
    await personWith(org, withDependantsOff(['access_communication']), { numbers: [number.id] });
    await personWith(org, withDependantsOff(['view_communication']), { numbers: [number.id] });

    const { notification, threadId, messageId } = await textIn(org, number, { earlier: [{ by: sender.id, number, minutesAgo: 10 }] });

    expect(notification).toBeNull();
    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect(await conversationAlertRecipients({ kind: 'text', organizationId: org, threadId, messageId })).toEqual([]);
  }, 120_000);

  it('answers with exactly the people it tells, and takes the latest inbound text when the caller names none', async () => {
    const { org, admin } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const linked = await personWith(org, {}, { numbers: [number.id] });
    await personWith(org, {});

    const { threadId, messageId, told } = await textIn(org, number);

    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect((await conversationAlertRecipients({ kind: 'text', organizationId: org, threadId, messageId })).sort()).toEqual([admin.id, linked.id].sort());
    expect((await conversationAlertRecipients({ kind: 'text', organizationId: org, threadId })).sort()).toEqual([admin.id, linked.id].sort());
    expect([...told].sort()).toEqual([admin.id, linked.id].sort());
  }, 120_000);

  it('alerts a STOP text as it does today, with the word as its preview', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const linked = await personWith(org, {}, { numbers: [number.id] });

    const { told, notification } = await textIn(org, number, { body: 'STOP' });

    expect(told.has(linked.id)).toBe(true);
    expect(notification!.body).toBe('STOP');
  }, 120_000);

  // ─── The preview ───────────────────────────────────────────────────────────────────────────

  describe('the preview', () => {
    it('is the first 80 characters of the text, whitespace collapsed, stored on the alert the recipients share', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      const linked = await personWith(org, {}, { numbers: [number.id] });
      const words = `Gate   code\nis 4412 ${'x'.repeat(120)}`;

      const { notification, told } = await textIn(org, number, { body: words });

      const expected = `Gate code is 4412 ${'x'.repeat(120)}`.slice(0, 80);
      expect(notification!.body).toBe(expected);
      expect((notification!.data as { preview: string }).preview).toBe(expected);
      expect(told.has(linked.id)).toBe(true);
    }, 120_000);

    it('counts what a person sees as one character: an emoji and an accented letter are never cut in half', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      await personWith(org, {}, { numbers: [number.id] });
      const seen = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length;

      const emoji = await textIn(org, number, { body: '👨‍👩‍👧‍👦'.repeat(90) });
      const accents = await textIn(org, number, { body: 'é'.repeat(90) });

      expect(seen(emoji.notification!.body!)).toBe(80);
      expect(emoji.notification!.body).toBe('👨‍👩‍👧‍👦'.repeat(80));
      expect(seen(accents.notification!.body!)).toBe(80);
      expect(accents.notification!.body).toBe('é'.repeat(80));
    }, 120_000);

    it('says only who texted for a picture with no words, and never puts the picture\'s link in the alert', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      await personWith(org, {}, { numbers: [number.id] });

      const { notification, messageId } = await textIn(org, number, { body: '', media: ['https://files.example.test/signed/pic.jpg?token=secret'] });

      expect(notification!.title).toMatch(/^New text — /);
      expect(notification!.body).toBeNull();
      expect(JSON.stringify(notification!.data)).not.toContain('secret');
      // The text itself is stored with its link, as before.
      expect((await db.message.findUnique({ where: { id: messageId }, select: { body: true } }))!.body).toContain('pic.jpg');
    }, 120_000);

    it('shows the customer\'s name, or the number, as the title says today', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      const { notification, counterpart } = await textIn(org, number);

      expect(notification!.title).toBe(`New text — ${counterpart}`);
    }, 120_000);

    it('reaches only the recipients: a person who is not one sees nothing of it through any bell route', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      const recipient = await personWith(org, {}, { numbers: [number.id] });
      const bystander = await personWith(org, {});
      const bystanderAll = await personWith(org, { communication_scope: 'all', ...withDependantsOff(['access_communication']) });
      const stranger = await newOrg();

      const { notification, recipients } = await textIn(org, number, { body: 'The gate code is 4412' });
      expect(notification!.body).toBe('The gate code is 4412');
      const mine = recipients.find((r) => r.recipient_id === recipient.id)!;

      // The recipient sees it, with its preview.
      const asRecipient = await fx.signedInAs(recipient);
      const list = await asRecipient.get('/api/notifications');
      expect(list.status).toBe(200);
      expect((list.body.items as Array<{ body: string | null }>).map((i) => i.body)).toContain('The gate code is 4412');
      expect((await asRecipient.get('/api/notifications/unread-count')).body.unseen).toBeGreaterThanOrEqual(1);

      for (const outsider of [bystander, bystanderAll, stranger.admin]) {
        const api = await fx.signedInAs(outsider);
        const theirs = await api.get('/api/notifications');
        expect(theirs.status).toBe(200);
        expect(JSON.stringify(theirs.body)).not.toContain('4412');
        expect(JSON.stringify(theirs.body)).not.toContain(notification!.id);
        expect((await api.get('/api/notifications/unread-count')).body).toMatchObject({ unseen: 0, needs_action: 0 });
        // Asking for it by the alert's id, or by the recipient's own row id, finds nothing and changes nothing.
        for (const id of [notification!.id, mine.id]) {
          for (const verb of ['read', 'act', 'dismiss'] as const) {
            expect((await api.patch(`/api/notifications/${id}/${verb}`)).status, `${verb} ${id}`).toBe(404);
          }
        }
        expect((await api.patch('/api/notifications/seen', { ids: [mine.id] })).body).toMatchObject({ count: 0 });
      }
      // None of it touched the recipient's own row.
      const after = await db.notificationRecipient.findUnique({ where: { id: mine.id }, select: { read_at: true, dismissed_at: true, acted_at: true, seen_at: true } });
      expect(after).toEqual({ read_at: null, dismissed_at: null, acted_at: null, seen_at: null });
    }, 240_000);

    it('is not in the live-update ping, which says only that something changed, on the private channel of each recipient', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      const recipient = await personWith(org, {}, { numbers: [number.id] });
      const bystander = await personWith(org, {});

      const posts: Array<{ url: string; body: string }> = [];
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
        if (String(url).includes('/realtime/v1/api/broadcast')) {
          posts.push({ url: String(url), body: String(init?.body ?? '') });
          return new Response(null, { status: 202 });
        }
        return realFetch(url as never, init as never);
      });
      try {
        const { flushRealtimePublishes } = await import('../services/notifications/realtimePublish.js');
        const { notification } = await textIn(org, number, { body: 'The gate code is 4412', counterpart: '+15555556543' });
        await flushRealtimePublishes();

        expect(notification).not.toBeNull();
        const sent = posts.flatMap((p) => (JSON.parse(p.body).messages as Array<{ topic: string; event: string; payload: unknown }>));
        const mine = sent.filter((m) => m.topic.includes(org));
        expect(mine.length).toBeGreaterThanOrEqual(1);
        for (const m of mine) {
          expect(m.payload).toEqual({ type: m.event });
          expect(m.topic).toMatch(new RegExp(`^org:${org}:user:`));
        }
        const everything = posts.map((p) => p.body).join('');
        expect(everything).not.toContain('4412');
        expect(everything).not.toContain('15555556543');
        // Only the recipients' channels are pinged.
        expect(mine.some((m) => m.topic.endsWith(`:user:${recipient.id}`))).toBe(true);
        expect(mine.some((m) => m.topic.endsWith(`:user:${bystander.id}`))).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    }, 120_000);

    it('is carried by the alert, not by the conversation: a second alert about the same text without the preview is its own row', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-number');
      const linked = await personWith(org, {}, { numbers: [number.id] });

      const first = await textIn(org, number, { body: 'The gate code is 4412' });
      const { emit } = await import('../services/notifications/notificationService.js');
      // What the never-silent fallback (S08.24) will do for people who may not read the conversation: raise its own alert, with
      // its own dedup key and none of the preview. The preview lives in that alert's row alone.
      const told = await emit({
        verb: 'communication.sms_inbound', organizationId: org, actorId: null, entity: { message_id: first.messageId },
        object: { type: 'MESSAGE_THREAD', id: first.threadId, label: first.counterpart }, data: { customer_name: null },
        dedupKey: `s0823:no-preview:${first.sid}`,
      });

      const second = await db.notification.findFirst({ where: { organization_id: org, dedup_key: `s0823:no-preview:${first.sid}` }, select: { id: true, body: true, data: true } });
      expect(told).toContain(linked.id);
      expect(second!.id).not.toBe(first.notification!.id);
      expect(second!.body).toBeNull();
      expect(JSON.stringify(second!.data)).not.toContain('4412');
      // The first alert still holds its preview, untouched.
      expect((await db.notification.findUnique({ where: { id: first.notification!.id }, select: { body: true } }))!.body).toBe('The gate code is 4412');
    }, 120_000);
  });
});
