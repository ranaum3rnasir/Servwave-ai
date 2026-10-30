/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.22 - the missed-call and voicemail alert goes to people by their switches, their
   scope and their place on the record, never by a role name.

   A missed call reaches the union of: the people on the job or lead the call is tied to (Owner or Sold By, Dispatcher, crew),
   the holders of Communication scope "All", and everyone linked to the company number it came in on (for the main line, the
   people ticked on it and the people the main-line fallback covers). Every one of them is active, holds Access Communication
   and passes the access filter (S08.21), which has the last word.

   Every case drives the REAL ingest entry point with a synthetic payload (no call is placed), the way the webhook does: the
   alert is handed over by `afterCommit` and run once the row is stored. People are on custom roles built from the catalog
   (never a built-in role name, except the cases that pin what the built-in Admin and Dispatcher presets give). Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
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

suite('the missed-call and voicemail alert goes to switches, scope and numbers (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
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
    const key = `call-alert-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    const all = {
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
      access_communication: true, view_communication: true, communication_scope: 'linked_to_me',
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

  /**
   * A missed (or voicemail) inbound call arriving through the real ingest, the way the webhook runs it: the alert is handed over
   * and run once the row is stored. `tie` stamps the job or lead on the row first, as an earlier event or an attach would have.
   * Returns who was told, and the alert's own priority and ask.
   */
  async function ringIn(
    org: string, number: { e164: string } | null, opts: { status?: 'missed' | 'voicemail'; tie?: { jobId?: string; leadId?: string }; sid?: string } = {},
  ) {
    const sid = opts.sid ?? `CA-s0822-${randomUUID().slice(0, 12)}`;
    if (opts.tie) {
      await db.callSession.create({
        data: {
          organization_id: org, ctm_call_id: sid, direction: 'in', from_number: '+15555550100', to_number: number?.e164 ?? 'unknown',
          status: 'ringing', answered_by: {}, started_at: new Date(), job_id: opts.tie.jobId ?? null, lead_id: opts.tie.leadId ?? null,
        },
      });
    }
    const { ingestCall } = await import('../lib/ctm/ingest.js');
    const raised: Array<() => Promise<unknown>> = [];
    const payload = {
      sid, account_id: 596375, caller_number: '+15555550100', tracking_number: number?.e164 ?? '+15555550199', direction: 'inbound',
      dial_status: opts.status === 'voicemail' ? 'voicemail' : 'no-answer', call_status: opts.status === 'voicemail' ? 'voicemail' : 'no-answer',
      talk_time: 0, unix_time: Math.floor(Date.now() / 1000),
    };
    const result = await ingestCall(db, org, payload, 'end', { afterCommit: (raise) => { raised.push(raise); } });
    await Promise.all(raised.map((raise) => raise()));
    return { sid, callId: result!.callSessionId, ...(await alertFor(org, sid)) };
  }

  async function alertFor(org: string, sid: string) {
    const notification = await db.notification.findFirst({
      where: { organization_id: org, dedup_key: `ctm:${sid}:missed` },
      select: { id: true, title: true, priority: true, needs_action: true, recipients: { select: { recipient_id: true, priority: true, needs_action: true } } },
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

  it('tells a holder of All, the people linked to the called number and the people on the tied job, and nobody else', async () => {
    const { org, admin, customer } = await newOrg();
    const called = await addNumber(org, 'run-called');
    const other = await addNumber(org, 'run-other');

    const soldBy = await personWith(org, {});
    const dispatcher = await personWith(org, {});
    const crew = await personWith(org, {});
    const removedCrew = await personWith(org, {});
    const job = await fx.addJob(org, customer, { crew: [crew.id, removedCrew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });
    await fx.removeCrew(job.visitId!, removedCrew.id);

    const people = {
      holderOfAll: await personWith(org, { communication_scope: 'all' }),
      linkedToCalled: await personWith(org, {}, { numbers: [called.id] }),
      linkedToCalledAndOther: await personWith(org, {}, { numbers: [called.id, other.id] }),
      narrowNotLinked: await personWith(org, {}),
      linkedToOtherOnly: await personWith(org, {}, { numbers: [other.id] }),
      linkedNoAccess: await personWith(org, withDependantsOff(['access_communication']), { numbers: [called.id] }),
      linkedNoView: await personWith(org, withDependantsOff(['view_communication']), { numbers: [called.id] }),
      soldBy, dispatcher, crew, removedCrew,
    };

    const { told, notification } = await ringIn(org, called, { tie: { jobId: job.id } });

    expect(names(told, people)).toEqual(['crew', 'dispatcher', 'holderOfAll', 'linkedToCalled', 'linkedToCalledAndOther', 'soldBy']);
    // The built-in Admin holds every switch on its preset, Communication scope All included: told through All, like anyone on it.
    expect(told.has(admin.id)).toBe(true);
    expect(notification!.title).toMatch(/^Missed call/);
  }, 240_000);

  it('tells the Owner, the Dispatcher and the walkthrough crew of the lead the call is tied to, not an assignee', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const owner = await personWith(org, {});
    const dispatcher = await personWith(org, {});
    const walkthrough = await personWith(org, {});
    const assignee = await personWith(org, {});
    const lead = await fx.addLead(org, customer, { owner: owner.id, dispatcher: dispatcher.id, walkthroughCrew: [walkthrough.id], assignees: [assignee.id] });
    const people = { owner, dispatcher, walkthrough, assignee };

    const { told } = await ringIn(org, number, { tie: { leadId: lead.id } });

    // The record's people are the Owner, the Dispatcher and the crew of its walkthroughs: an assignee is not one of them.
    expect(names(told, people)).toEqual(['dispatcher', 'owner', 'walkthrough']);
  }, 240_000);

  it('does not widen what a person on the record reads: someone who cannot open the job is dropped by the filter', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const crewNoJobs = await personWith(org, withDependantsOff(['view_jobs']));
    const job = await fx.addJob(org, customer, { crew: [crewNoJobs.id] });

    const { told } = await ringIn(org, number, { tie: { jobId: job.id } });

    expect(told.has(crewNoJobs.id)).toBe(false);
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

    const { told } = await ringIn(org, main);

    expect(names(told, people)).toEqual(['holderOfAll', 'noNumberFallbackOn', 'tickedOnMain']);
  }, 240_000);

  it('does not apply the main-line fallback to a call on any other number', async () => {
    const { org } = await newOrg();
    await addNumber(org, 'run-main', { orgDefault: true });
    const other = await addNumber(org, 'run-other');
    const fallback = await personWith(org, { see_main_line_when_no_number: true });

    const { told } = await ringIn(org, other);

    expect(told.has(fallback.id)).toBe(false);
  }, 120_000);

  it('stops the fallback for a person once a number is linked to them, and starts it again when it is unlinked', async () => {
    const { org } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const mine = await addNumber(org, 'run-mine');
    const person = await personWith(org, { see_main_line_when_no_number: true });

    expect((await ringIn(org, main)).told.has(person.id)).toBe(true);
    await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id: mine.id } });
    expect((await ringIn(org, main)).told.has(person.id)).toBe(false);
    await db.userPhoneNumber.delete({ where: { user_id_phone_number_id: { user_id: person.id, phone_number_id: mine.id } } });
    expect((await ringIn(org, main)).told.has(person.id)).toBe(true);
  }, 120_000);

  // ─── Deactivated people ────────────────────────────────────────────────────────────────────

  it('never tells a deactivated person, whichever way they would qualify', async () => {
    const { org, customer } = await newOrg();
    const main = await addNumber(org, 'run-main', { orgDefault: true });
    const called = await addNumber(org, 'run-called');
    const soldBy = await personWith(org, {}, { inactive: true });
    const crew = await personWith(org, {}, { inactive: true });
    const job = await fx.addJob(org, customer, { crew: [crew.id], soldBy: soldBy.id });
    const people = {
      byAll: await personWith(org, { communication_scope: 'all' }, { inactive: true }),
      byLink: await personWith(org, {}, { numbers: [called.id], inactive: true }),
      byFallback: await personWith(org, { see_main_line_when_no_number: true }, { inactive: true }),
      byMainLineTick: await personWith(org, {}, { numbers: [main.id], inactive: true }),
      soldBy, crew,
    };
    const active = await personWith(org, { communication_scope: 'all' });

    const onJob = await ringIn(org, called, { tie: { jobId: job.id } });
    const onMain = await ringIn(org, main);

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

    const { told } = await ringIn(org, number);

    expect(told.has(holder.id)).toBe(false);
    expect(told.has(bystander.id)).toBe(false);
    // Still not vacuous: the call alerts the person linked to the number.
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
    const copyOfAdmin = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: false }, { base: 'ADMIN' });
    const copyOfDispatcher = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: false }, { base: 'DISPATCHER' });

    const onOther = await ringIn(org, other);
    const onMain = await ringIn(org, main);

    // The Admin box holds every switch, Communication scope All among them: told for any call, through All.
    expect(onOther.told.has(admin.id)).toBe(true);
    expect(onMain.told.has(admin.id)).toBe(true);
    // The Dispatcher preset is Linked to me with the main-line fallback on: the main line's calls, and no other number's.
    expect(onOther.told.has(builtInDispatcher.id)).toBe(false);
    expect(onMain.told.has(builtInDispatcher.id)).toBe(true);
    // Sales is the same shape. The Technician preset has the fallback off: no main-line call either.
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
    const fallbackOn = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: true }, { base: 'ADMIN' });
    const fallbackOff = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: false }, { base: 'ADMIN' });

    const { told } = await ringIn(org, main);

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

    const { told } = await ringIn(org, number);

    for (const person of [stranger.admin, strangerAll, strangerLinked]) expect(told.has(person.id)).toBe(false);
    expect(await db.notificationRecipient.count({ where: { organization_id: stranger.org } })).toBe(0);
  }, 120_000);

  // ─── Voicemail, priority and duplicates ────────────────────────────────────────────────────

  it('treats a voicemail exactly like a missed call', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const crew = await personWith(org, {});
    const job = await fx.addJob(org, customer, { crew: [crew.id] });
    const holder = await personWith(org, { communication_scope: 'all' });
    const linked = await personWith(org, {}, { numbers: [number.id] });
    const bystander = await personWith(org, {});

    const voicemail = await ringIn(org, number, { status: 'voicemail', tie: { jobId: job.id } });

    expect(voicemail.notification!.title).toMatch(/^Voicemail/);
    expect([crew, holder, linked].every((p) => voicemail.told.has(p.id))).toBe(true);
    expect(voicemail.told.has(bystander.id)).toBe(false);
  }, 120_000);

  it('still interrupts and asks for a call back, for everyone it tells', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    await personWith(org, {}, { numbers: [number.id] });
    await personWith(org, { communication_scope: 'all' });

    const { notification, recipients } = await ringIn(org, number);

    expect(notification!.priority).toBe('INTERRUPT');
    expect(notification!.needs_action).toBe(true);
    expect(recipients.length).toBeGreaterThanOrEqual(3); // both, and the built-in Admin
    for (const r of recipients) {
      expect(r.priority).toBe('INTERRUPT');
      expect(r.needs_action).toBe(true);
    }
  }, 120_000);

  it('tells a person found by two routes once, and a webhook retry writes no second alert', async () => {
    const { org, customer } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const both = await personWith(org, { communication_scope: 'all' }, { numbers: [number.id] });
    const job = await fx.addJob(org, customer, { crew: [both.id], soldBy: both.id, dispatcher: both.id });
    const sid = `CA-s0822-${randomUUID().slice(0, 12)}`;

    const first = await ringIn(org, number, { sid, tie: { jobId: job.id } });
    const retry = await ringIn(org, number, { sid });

    expect(first.recipients.filter((r) => r.recipient_id === both.id)).toHaveLength(1);
    expect(retry.notification!.id).toBe(first.notification!.id);
    expect(await db.notification.count({ where: { organization_id: org, dedup_key: `ctm:${sid}:missed` } })).toBe(1);
    expect(await db.notificationRecipient.count({ where: { notification_id: first.notification!.id } })).toBe(first.recipients.length);
  }, 120_000);

  it('ends cleanly when nobody is to be told: no alert is written, nothing throws, and the empty answer is there to be hooked', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    // Nobody active at all: the built-in Admin is the only person, and it is deactivated.
    await db.user.updateMany({ where: { organization_id: org }, data: { is_active: false } });

    const { notification, told, callId } = await ringIn(org, number);

    expect(told.size).toBe(0);
    expect(notification).toBeNull();
    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect(await conversationAlertRecipients({ kind: 'call', organizationId: org, callId })).toEqual([]);
  }, 120_000);

  it('counts nobody who cannot use the section: the empty answer comes after the access filter, not before it', async () => {
    const { org } = await newOrg();
    const number = await addNumber(org, 'run-number');
    await db.user.updateMany({ where: { organization_id: org }, data: { is_active: false } });
    // Named by All and by the number, and neither can use the section.
    await personWith(org, { ...withDependantsOff(['access_communication']), communication_scope: 'all' });
    await personWith(org, withDependantsOff(['access_communication']), { numbers: [number.id] });
    await personWith(org, withDependantsOff(['view_communication']), { numbers: [number.id] });

    const { notification, callId } = await ringIn(org, number);

    expect(notification).toBeNull();
    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect(await conversationAlertRecipients({ kind: 'call', organizationId: org, callId })).toEqual([]);
  }, 120_000);

  it('answers with exactly the people it tells', async () => {
    const { org, admin } = await newOrg();
    const number = await addNumber(org, 'run-number');
    const linked = await personWith(org, {}, { numbers: [number.id] });
    await personWith(org, {});

    const { callId, told } = await ringIn(org, number);

    const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
    expect((await conversationAlertRecipients({ kind: 'call', organizationId: org, callId })).sort()).toEqual([admin.id, linked.id].sort());
    expect([...told].sort()).toEqual([admin.id, linked.id].sort());
  }, 120_000);
});
