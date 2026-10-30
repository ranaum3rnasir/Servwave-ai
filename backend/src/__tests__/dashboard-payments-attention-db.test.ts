/* =============================================================================
   Payments go-live P9 - the dashboard's payments item, against a real migrated database (TEST_DATABASE_URL; skips when
   unset). Called as people on custom roles (never a built-in role name). The item counts every kind of item the
   Payments page's Needs attention view holds, for the caller (privacy applied), and opens that page only for people
   who may open it.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

type Item = { id: string; type: string; badge: string; title: string; link: string | null };

suite('GET /api/dashboard payments item counts the page\'s own items (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    for (const org of orgs) {
      const q = (sql: string) => db.$executeRawUnsafe(sql).catch(() => undefined);
      await q(`DELETE FROM unapplied_captures WHERE organization_id = '${org}'`);
      await q(`DELETE FROM payouts WHERE organization_id = '${org}'`);
    }
    await fx.cleanup();
  });

  let sequence = 0;
  const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
  const SEES_ALL = { view_payments: true, view_invoices: true, invoices_scope: 'all' };

  async function newOrg() {
    const o = await fx.newOrg();
    orgs.push(o.org);
    return o;
  }
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `dash-pay-role-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, `t${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }
  const itemOf = async (person: Person): Promise<Item | undefined> => {
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data.needs_attention as Item[]).find((i) => i.type === 'payments_attention');
  };
  const pageCount = async (person: Person): Promise<number> => (await (await fx.signedInAs(person)).get('/api/payments-page/attention/summary')).body.open;

  const addPayout = (org: string) => db.payout.create({
    data: {
      organization_id: org, stripe_payout_id: `po_test_${randomUUID().slice(0, 12)}`, status: 'FAILED', amount: 500,
      arrival_date: new Date('2026-10-10T00:00:00Z'), processor_created_at: new Date(Date.now() - 2 * 86_400_000), failure_code: 'account_closed',
    },
  });
  async function addUnapplied(org: string, invoiceId: string | null = null) {
    const id = randomUUID();
    await db.unappliedCapture.create({
      data: {
        id, organization_id: org, invoice_id: invoiceId, reason: 'OVERPAYMENT', amount: 25, status: 'OPEN', source_key: `src-${id}`,
        stripe_payment_intent_id: `pi_test_${id.slice(0, 12)}`, stripe_account_id: `acct_test_${id.slice(0, 8)}`,
      },
    });
    return id;
  }

  it('shows a View payments holder a failed payout alone (it did not before), opening the page on the attention chip', async () => {
    const { org } = await newOrg();
    await addPayout(org);
    const person = await personWith(org, { ...SEES_ALL, show_payments_page: true });
    expect(await itemOf(person)).toMatchObject({ badge: '1', title: '1 payment needs attention', link: '/payments?tab=payments&chip=attention' });
  });

  it('counts a failed payout and an unmatched payment as 2, equal to the page\'s own count, and drops when one is resolved', async () => {
    const { org } = await newOrg();
    await addPayout(org);
    const captureId = await addUnapplied(org);
    const person = await personWith(org, { ...SEES_ALL, show_payments_page: true });
    expect((await itemOf(person))?.badge).toBe('2');
    expect(await pageCount(person)).toBe(2);
    await db.unappliedCapture.update({ where: { id: captureId }, data: { status: 'RESOLVED' } });
    expect((await itemOf(person))?.badge).toBe('1');
    expect(await pageCount(person)).toBe(1);
  });

  it('shows the row but sends no link to a holder with Show Payments page off', async () => {
    const { org } = await newOrg();
    await addPayout(org);
    const person = await personWith(org, { ...SEES_ALL, show_payments_page: false });
    const item = await itemOf(person);
    expect(item).toBeDefined();
    expect(item!.link).toBeNull();
  });

  it('is absent, and adds no count, for someone holding no payments switch', async () => {
    const { org } = await newOrg();
    await addPayout(org);
    const person = await personWith(org, { view_invoices: true, invoices_scope: 'all' });
    expect(await itemOf(person)).toBeUndefined();
  });

  it('does not count an item on the company itself for a caller whose invoice reach is narrower', async () => {
    const { org } = await newOrg();
    await addUnapplied(org);
    const narrowed = await personWith(org, { ...SEES_ALL, invoices_scope: 'attached', show_payments_page: true });
    expect(await pageCount(narrowed)).toBe(0);
    expect(await itemOf(narrowed)).toBeUndefined();
  });

  it('is the first item the API returns', async () => {
    const { org } = await newOrg();
    await addPayout(org);
    const person = await personWith(org, { ...SEES_ALL, show_payments_page: true });
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect((res.body.data.needs_attention as Item[])[0].type).toBe('payments_attention');
  });
});
