/* =============================================================================
   Roles & Permissions, PRD 8 (S08.21 and S08.23, fix round fp-comm-2) - the inbound-text alert and the conversation read agree.

   The alert quotes the first 80 characters of an inbound text, so every person it reaches must be able to read THAT message when they
   open the conversation. A message is readable by a person on "Linked to me" when it is one of their own (a linked number, a text
   they sent, a reply attributed to them) or when they may open the job or lead it hangs off (PRD 8, "Which messages a single
   conversation returns"). The recipient rule and the message read rule are one predicate, so a person told about a text is a person
   who reads it, and nobody is told something their thread then hides from them.

   Every case drives the REAL inbound text webhook route with the provider's body (no text is sent), then reads the conversation as
   the person through the real route. People are on custom roles built from the catalog. Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
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
// A text on a number the company does not have would read the phone system after the answer; none is wanted here.
vi.mock('../lib/ctm/unknownNumberSync', () => ({ syncIfUnknownNumber: vi.fn(async () => undefined) }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';

const TOKEN = 'fp-comm-2-webhook-token';

const suite = realClient ? describe : describe.skip;

suite('the inbound-text alert and the conversation read agree (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as never;
    // The route is closed while no token is set; the suite-wide setup leaves the environment's own object in place.
    (env as { CTM_WEBHOOK_TOKEN?: string }).CTM_WEBHOOK_TOKEN = TOKEN;
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM ctm_events WHERE payload::text LIKE '%${org.slice(0, 8)}%'`));
    }
    await fx.cleanup();
  });

  type Member = Person & { base: Role };
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    // The webhook finds the company by the account number the provider names.
    const account = `fpc2${made.tag}`;
    await db.organization.update({ where: { id: made.org }, data: { ctm_account_id: account } });
    return { ...made, account };
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

  /** A person on a fresh custom role holding these switch values, linked to these company numbers. */
  async function personWith(
    org: string, values: Record<string, boolean | string>, opts: { numbers?: string[] } = {},
  ): Promise<Member> {
    const base: Role = 'TECHNICIAN';
    const key = `text-read-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, actorId: null, reason: 'manual',
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
        access_communication: true, view_communication: true, communication_scope: 'attached',
        see_main_line_when_no_number: false, ...values,
      },
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    for (const phone_number_id of opts.numbers ?? []) await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id } });
    return Object.assign(person, { base });
  }

  async function addNumber(org: string, tag: string) {
    const id = randomUUID();
    const e164 = `+1555${String(++sequence).padStart(7, '0')}`;
    await db.phoneNumber.create({ data: { id, organization_id: org, e164, label: tag, is_org_default: false, status: 'active' } });
    return { id, e164 };
  }

  /**
   * A customer's text arriving through the real webhook route. `earlier` puts outbound texts in the conversation first. Returns the
   * conversation and message the text landed in, who was told, and the alert row.
   */
  async function textInThroughWebhook(
    org: string, account: string, number: { e164: string },
    opts: { body: string; earlier?: Array<{ number: { id: string }; by?: string | null; jobId?: string; leadId?: string; minutesAgo: number }> },
  ) {
    const counterpart = `+1555555${String(++sequence).padStart(4, '0').slice(-4)}`;
    const thread = await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', title: counterpart } });
    for (const e of opts.earlier ?? []) {
      await db.message.create({
        data: {
          organization_id: org, thread_id: thread.id, direction: 'out', body: 'run-earlier', status: 'sent',
          ts: new Date(Date.now() - e.minutesAgo * 60_000), phone_number_id: e.number.id, sent_by_user_id: e.by ?? null,
          job_id: e.jobId ?? null, job_label: e.jobId ? 'J' : null, lead_id: e.leadId ?? null,
        },
      });
    }
    const sid = `MSG-fpc2-${randomUUID().slice(0, 12)}`;
    const res = await request(app)
      .post(`/api/webhooks/ctm/inbound_text?token=${TOKEN}`)
      .send({
        message_id: sid, account_id: account, caller_number: counterpart, tracking_number: number.e164,
        direction: 'msg_inbound', message_body: opts.body, unix_time: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(200);
    // The alert is raised once the answer is sent; wait for its row.
    let notification = null;
    for (let tries = 0; tries < 100 && !notification; tries++) {
      notification = await db.notification.findFirst({
        where: { organization_id: org, dedup_key: { startsWith: `ctm:${sid}:inbound` } },
        select: { id: true, body: true, recipients: { select: { recipient_id: true } } },
      });
      if (!notification) await new Promise((r) => setTimeout(r, 100));
    }
    const message = await db.message.findFirstOrThrow({ where: { organization_id: org, ctm_sms_id: sid }, select: { id: true, thread_id: true } });
    return { threadId: message.thread_id, messageId: message.id, notification, told: new Set((notification?.recipients ?? []).map((r) => r.recipient_id)) };
  }

  /** What the person's own request returns for the conversation: the ids of the messages in it, or null when it answers not found. */
  async function messagesTheyRead(person: Person, threadId: string): Promise<string[] | null> {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/threads/${threadId}`);
    if (res.status === 404) return null;
    expect(res.status).toBe(200);
    return (res.body.thread.messages as Array<{ id: string }>).map((m) => m.id);
  }

  it('a crew member told about a text on a number nobody linked to them reads that text in the conversation', async () => {
    const { org, account, customer } = await newOrg();
    const lineA = await addNumber(org, 'run-line-a');
    const lineB = await addNumber(org, 'run-line-b');
    const crew = await personWith(org, {}, { numbers: [lineA.id] });
    const job = await fx.addJob(org, customer, { crew: [crew.id] });

    const sent = await textInThroughWebhook(org, account, lineB, {
      body: 'run-gate-code-9931',
      earlier: [{ number: lineB, minutesAgo: 30, jobId: job.id }],
    });

    // Told, because the text is tied to their job ...
    expect(sent.told.has(crew.id)).toBe(true);
    // ... and so the text the alert quotes is in what they read.
    expect(await messagesTheyRead(crew, sent.threadId)).toContain(sent.messageId);
  }, 240_000);

  it('does not tell a person on the job who cannot open it, even when they read another message of the conversation', async () => {
    const { org, account, customer } = await newOrg();
    const lineA = await addNumber(org, 'run-line-a');
    const lineB = await addNumber(org, 'run-line-b');
    // On the job's crew, linked to Line A, but with no access to jobs: the job opens nothing for them.
    const crewNoJobs = await personWith(org, withDependantsOff(['view_jobs']), { numbers: [lineA.id] });
    const job = await fx.addJob(org, customer, { crew: [crewNoJobs.id] });

    const sent = await textInThroughWebhook(org, account, lineB, {
      body: 'run-gate-code-4417',
      earlier: [
        // Their own number: the conversation is theirs to open ...
        { number: lineA, minutesAgo: 60 },
        // ... and the office last texted about the job from Line B, so the customer's reply is tied to it.
        { number: lineB, minutesAgo: 30, jobId: job.id },
      ],
    });

    // The conversation opens for them, the text does not: it is on a number that is not theirs, about a job they cannot open.
    const read = await messagesTheyRead(crewNoJobs, sent.threadId);
    expect(read).not.toBeNull();
    expect(read).not.toContain(sent.messageId);
    // So the alert, which quotes that text, is not theirs either.
    expect(sent.told.has(crewNoJobs.id)).toBe(false);
  }, 240_000);

  it('tells a person on the job who can open it, and the text they are told about is in what they read', async () => {
    const { org, account, customer } = await newOrg();
    const lineA = await addNumber(org, 'run-line-a');
    const lineB = await addNumber(org, 'run-line-b');
    const crew = await personWith(org, {}, { numbers: [lineA.id] });
    const job = await fx.addJob(org, customer, { crew: [crew.id] });

    const sent = await textInThroughWebhook(org, account, lineB, {
      body: 'run-gate-code-5521',
      earlier: [{ number: lineA, minutesAgo: 60 }, { number: lineB, minutesAgo: 30, jobId: job.id }],
    });

    expect(sent.told.has(crew.id)).toBe(true);
    expect(await messagesTheyRead(crew, sent.threadId)).toContain(sent.messageId);
  }, 240_000);

  it('tells the person a reply is attributed to, who has no number linked, and the reply is in what they read', async () => {
    const { org, account } = await newOrg();
    const lineB = await addNumber(org, 'run-line-b');
    const sender = await personWith(org, {});
    const bystander = await personWith(org, {});

    const sent = await textInThroughWebhook(org, account, lineB, {
      body: 'run-thanks-see-you-then',
      earlier: [{ number: lineB, by: sender.id, minutesAgo: 10 }],
    });

    expect(sent.told.has(sender.id)).toBe(true);
    expect(await messagesTheyRead(sender, sent.threadId)).toContain(sent.messageId);
    expect(sent.told.has(bystander.id)).toBe(false);
  }, 240_000);
});
