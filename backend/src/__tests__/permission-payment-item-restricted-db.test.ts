/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 47): a payment item on an invoice the person can't open
   says nothing about that invoice.

   The payments pages show an unapplied payment on an invoice outside the person's reach as "restricted" (View payments is
   company money). Its reason words must then read the same whatever happened to that invoice: paid already, voided, or
   paid twice. Otherwise the words tell the person the state of an invoice they cannot open. The Admin, who can open it,
   still gets the specific words (the control, so the comparison is not between three blanks).

   The person is on a custom role with every switch on and every scope at Their own; the invoices are on the Admin's job.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('a restricted payment item says nothing about the invoice (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  const captures: string[] = [];
  afterAll(async () => {
    await db.unappliedCapture.deleteMany({ where: { id: { in: captures } } }).catch(() => undefined);
    await fx.cleanup();
  });

  let org = '';
  let admin: Person;
  let person: Person;
  const items: Record<'paid' | 'voided' | 'twice', string> = { paid: '', voided: '', twice: '' };

  beforeAll(async () => {
    const o = await fx.newOrg();
    org = o.org;
    admin = o.admin;
    const values: Record<string, unknown> = { ...presetSwitchSet('ADMIN') };
    for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) values[s.key] = 'attached';
    await fx.addCustomRole(org, 'pay-reach', 'DISPATCHER');
    await fx.setRoleSwitches(org, 'pay-reach', values as never);
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'pay-reach' } });
    person = await fx.addUser(org, 'payviewer', 'DISPATCHER', { customRoleId: role.id });

    // Three payments of 60 that could not land, each on an invoice of the Admin's job in a different state.
    const capture = async (status: 'PAID' | 'VOIDED', paidAmount: number | null) => {
      const job = await fx.addJob(org, o.customer, { crew: [admin.id] });
      const inv = await fx.addInvoice(org, o.customer, { jobId: job.id });
      await db.invoice.update({ where: { id: inv.id }, data: { status, amount_due: 0, ...(status === 'PAID' ? { paid_at: new Date() } : {}) } });
      if (paidAmount != null) await db.payment.create({ data: { invoice_id: inv.id, amount: paidAmount, method: 'CHECK', paid_at: new Date() } });
      const id = randomUUID();
      captures.push(id);
      await db.unappliedCapture.create({
        data: { id, organization_id: org, invoice_id: inv.id, reason: 'INVOICE_NOT_PAYABLE', amount: 60, source_key: `t33-${id}` },
      });
      return id;
    };
    items.paid = await capture('PAID', 100);
    items.voided = await capture('VOIDED', null);
    items.twice = await capture('PAID', 60);
  }, 120_000);

  /** The answer with what names the item itself (its id, key and time) taken out. */
  const shape = (body: Record<string, unknown>, id: string) => {
    const { id: _id, key: _key, created_at: _at, ...rest } = body;
    return JSON.parse(JSON.stringify(rest).split(id).join('<id>'));
  };

  const doors = [
    (id: string) => `/api/payments-needing-attention/${id}`,
    (id: string) => `/api/payments-page/attention/unmatched_payment:${id}`,
  ];

  for (const door of doors) {
    it(`${door('<id>')}: the restricted item reads the same for a paid, a voided and a paid-twice invoice`, async () => {
      const answers = [];
      for (const id of Object.values(items)) {
        const res = await (await fx.signedInAs(person)).get(door(id));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.restricted).toBe(true);
        answers.push(shape(res.body, id));
      }
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[2]).toEqual(answers[0]);
    });
  }

  it('the Admin, who can open the invoices, still gets the reason for each (the control)', async () => {
    const reasons = [];
    for (const id of Object.values(items)) {
      const res = await (await fx.signedInAs(admin)).get(`/api/payments-needing-attention/${id}`);
      expect(res.status).toBe(200);
      reasons.push(res.body.reason_short);
    }
    expect(new Set(reasons).size).toBe(3);
  });
});
