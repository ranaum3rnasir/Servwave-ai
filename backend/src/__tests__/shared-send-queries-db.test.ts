/* =============================================================================
   #2992: Spider's per-lead alerts now read the company row, the outbound number and the suppression list once per
   run, through optional pre-reads on the shared send code. Every OTHER caller passes nothing and must behave exactly as
   before. This file records, statement by statement, the SQL each non-Spider caller of the shared code sends, and its
   answer, and compares both with the record captured from the code before #2992 (fixtures/shared-send-queries-2992.json,
   captured at e9e13e8f0 with SHARED_SEND_CAPTURE=1, which prints the record instead of comparing):
     - precheckCtmSms (a user's send: per-user number, then the company default),
     - sendCtmSms (an automation's send, no user),
     - sendStaffAlertSms with no pre-read (the starting summary's texts),
     - resolveOutboundNumber for a call (an explicit pick),
     - isTransactionalSendSuppressed (every business email), one address and a list,
   across a company with a default number, one without (the oldest active number) and one not ready to text.

   Real migrated database (TEST_DATABASE_URL); skips when it is unset. Fixed ids, removed before and after.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return {
    realClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) : undefined,
  };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { countQueries, type CountedQuery } from './support/query-counter';
import * as ctm from '../lib/ctm/client';
import { precheckCtmSms, sendCtmSms, sendStaffAlertSms, _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { resolveOutboundNumber } from '../lib/communication/resolveOutboundNumber';
import { isTransactionalSendSuppressed } from '../lib/email-suppression';

const suite = realClient ? describe : describe.skip;

const ORG_DEFAULT = '29920000-0000-4000-8000-000000000001';
const ORG_LEGACY = '29920000-0000-4000-8000-000000000002';
const ORG_NOT_READY = '29920000-0000-4000-8000-000000000003';
const USER_WITH_NUMBER = '29920000-0000-4000-8000-000000000011';
const USER_PLAIN = '29920000-0000-4000-8000-000000000012';
const NUM_DEFAULT = '29920000-0000-4000-8000-000000000021';
const NUM_USER = '29920000-0000-4000-8000-000000000022';
const NUM_OLD = '29920000-0000-4000-8000-000000000023';
const NUM_NEW = '29920000-0000-4000-8000-000000000024';
const MESSAGE = '29920000-0000-4000-8000-000000000031';
const ORGS = [ORG_DEFAULT, ORG_LEGACY, ORG_NOT_READY];
const SUPPRESSED = 'shared-send-2992@example.test';

const FIXTURE = join(__dirname, 'fixtures', 'shared-send-queries-2992.json');

/** A wall-clock value as Prisma reports a parameter ("2026-11-04 08:02:04.580 UTC") or as ISO. */
const TIME = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?( ?UTC|Z|[+-]\d\d:?\d\d)?/g;

/** A statement as sent, with wall-clock values (never part of the behaviour) replaced. */
function shape(q: CountedQuery): { sql: string; params: string } {
  return { sql: q.sql, params: q.params.replace(TIME, '<time>') };
}

suite('the shared send code answers every non-Spider caller exactly as before #2992 (real database)', () => {
  const db = realClient as PrismaClient;

  async function clean() {
    await db.emailSuppression.deleteMany({ where: { address: SUPPRESSED } });
    await db.userPhoneNumber.deleteMany({ where: { user_id: { in: [USER_WITH_NUMBER, USER_PLAIN] } } });
    for (const table of ['phone_numbers', 'users']) {
      await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, ORGS);
    }
    await db.organization.deleteMany({ where: { id: { in: ORGS } } });
  }

  beforeAll(async () => {
    await clean();
    const org = (id: string, ready: boolean) => ({
      id, name: `shared-send-${id.slice(-1)}`, email: `org-${id.slice(-4)}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      plan: 'SCALE' as const, is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
      ctm_account_id: `acct-${id.slice(-4)}`, ctm_sms_ready: ready, sms_sending_enabled: true,
    });
    await db.organization.createMany({ data: [org(ORG_DEFAULT, true), org(ORG_LEGACY, true), org(ORG_NOT_READY, false)] });
    const T = (d: number) => new Date(Date.UTC(2026, 0, d));
    await db.phoneNumber.createMany({
      data: [
        { id: NUM_DEFAULT, organization_id: ORG_DEFAULT, e164: '+16175552001', sms_enabled: true, ctm_number_id: 'TPN-default', status: 'active', is_org_default: true, created_at: T(5) },
        { id: NUM_USER, organization_id: ORG_DEFAULT, e164: '+16175552002', sms_enabled: true, ctm_number_id: 'TPN-user', status: 'active', created_at: T(6) },
        { id: NUM_OLD, organization_id: ORG_LEGACY, e164: '+16175552003', sms_enabled: true, ctm_number_id: 'TPN-old', status: 'active', created_at: T(1) },
        { id: NUM_NEW, organization_id: ORG_LEGACY, e164: '+16175552004', sms_enabled: true, ctm_number_id: 'TPN-new', status: 'active', created_at: T(9) },
      ],
    });
    for (const [id, orgId] of [[USER_WITH_NUMBER, ORG_DEFAULT], [USER_PLAIN, ORG_DEFAULT]] as const) {
      await db.user.create({
        data: { id, organization_id: orgId, email: `u-${id.slice(-2)}-2992@example.test`, first_name: 'U', last_name: 'Ser', role: 'ADMIN', is_admin: true, is_active: true, has_login: true },
      });
    }
    await db.userPhoneNumber.create({ data: { user_id: USER_WITH_NUMBER, phone_number_id: NUM_USER, is_default: true } });
    await db.emailSuppression.create({ data: { address: SUPPRESSED, category: 'TRANSACTIONAL', kind: 'HARD_BOUNCE' } });
  });

  afterAll(async () => {
    await clean().catch(() => undefined);
    await db.$disconnect();
  });

  it('every statement and every answer is the one the code before #2992 gave', async () => {
    vi.mocked(ctm.isCtmConfigured).mockReturnValue(true);
    vi.mocked(ctm.isOutboundAllowed).mockReturnValue(true);
    vi.mocked(ctm.isOptedOut).mockResolvedValue(false);
    vi.mocked(ctm.sendSms).mockResolvedValue({ id: 'sms-2992' });
    _resetCtmSmsDoubleFireGuard();

    const steps: [string, () => Promise<unknown>][] = [
      ['precheck, a user with their own number', () => precheckCtmSms(db, { orgId: ORG_DEFAULT, toE164: '+16175553001', threadId: 't1', body: 'hi', userId: USER_WITH_NUMBER })],
      ['precheck, a user with none: the company default', () => precheckCtmSms(db, { orgId: ORG_DEFAULT, toE164: '+16175553001', threadId: 't1', body: 'hi', userId: USER_PLAIN })],
      ['precheck, no default: the oldest active number', () => precheckCtmSms(db, { orgId: ORG_LEGACY, toE164: '+16175553001', threadId: 't1', body: 'hi' })],
      ['precheck, not ready to text', () => precheckCtmSms(db, { orgId: ORG_NOT_READY, toE164: '+16175553001', threadId: 't1', body: 'hi' })],
      ['an automation send (no user, a missing message row)', () => sendCtmSms(db, { orgId: ORG_LEGACY, toE164: '+16175553002', threadId: 't2', body: 'auto', messageId: MESSAGE })],
      ['a staff text with no pre-read', () => sendStaffAlertSms(db, { orgId: ORG_DEFAULT, toE164: '+16175553003', body: 'staff', alertKey: 'k1' })],
      ['a staff text, not ready', () => sendStaffAlertSms(db, { orgId: ORG_NOT_READY, toE164: '+16175553003', body: 'staff', alertKey: 'k2' })],
      ['a call, an explicit pick', () => resolveOutboundNumber(db, { orgId: ORG_DEFAULT, userId: USER_WITH_NUMBER, explicitNumberId: NUM_USER })],
      ['suppression, one address in another case', () => isTransactionalSendSuppressed(`  ${SUPPRESSED.toUpperCase()} `)],
      ['suppression, a list', () => isTransactionalSendSuppressed(['nobody-2992@example.test', `Name <${SUPPRESSED}>`])],
      ['suppression, nobody', () => isTransactionalSendSuppressed('nobody-2992@example.test')],
    ];
    const record: { step: string; answer: unknown; queries: { sql: string; params: string }[] }[] = [];
    for (const [step, call] of steps) {
      const { queries, result } = await countQueries(call, db);
      record.push({ step, answer: result, queries: queries.map(shape) });
    }

    if (process.env.SHARED_SEND_CAPTURE === '1') {
      console.info(`[2992-capture]${JSON.stringify(record)}[/2992-capture]`);
      return;
    }
    // The record as captured, with its wall-clock values replaced the same way.
    const before = JSON.parse(readFileSync(FIXTURE, 'utf8').replace(TIME, '<time>')) as typeof record;
    expect(record.map((r) => r.step)).toEqual(before.map((r) => r.step));
    for (const [i, r] of record.entries()) expect(r, r.step).toEqual(before[i]);
  });
});
