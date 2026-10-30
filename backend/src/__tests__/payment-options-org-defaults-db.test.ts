/* =============================================================================
   Payments go-live, slice 19 - the defaults an owner saves are the defaults a customer sees.

   Drives the real routes (PATCH /api/organization through auth and the permission check, then
   the public invoice payload) against a real, migrated database. Every org here is provisioned
   the way a real tenant is: ops-sql.ts and seed.ts both write the legacy per-org
   `available_payment_methods` settings row, frozen at CARD / BANK_TRANSFER / CHECK / CASH. A
   mocked client that returns no such row cannot show that row shadowing the owner's choice.

   The app's client is swapped for one pointed at TEST_DATABASE_URL; only the identity provider
   stays mocked (it has no local stand-in). Skips when TEST_DATABASE_URL is unset, like every
   other *-db suite. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

/** The legacy row every onboarded tenant carries (ops-sql.ts APP_SETTINGS, seed.ts). */
const LEGACY_METHODS_ROW = JSON.stringify(['CARD', 'BANK_TRANSFER', 'CHECK', 'CASH']);

suite('org payment defaults reach the public payload (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  async function tenant(opts: { accepted: string[] }) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay19-${randomUUID()}`;
    // One bearer per tenant: the auth layer caches a verified token, so a shared one would keep
    // resolving to the first tenant's user.
    const bearer = `local-db-test-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay19-defaults-${tag}`, email: `defaults-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_pay19_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: opts.accepted,
      },
    });
    await db.appSetting.create({ data: { organization_id: org, key: 'available_payment_methods', value: LEGACY_METHODS_ROW } });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'SENT',
        subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500, public_token: token,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const publicMethods = async () => {
      const res = await request(app).get(`/api/invoices/${invoice}/public`).query({ token });
      expect(res.status).toBe(200);
      return res.body.available_payment_methods as string[];
    };
    const patchOrg = (body: Record<string, unknown>) =>
      request(app).patch('/api/organization').set('Authorization', `Bearer ${bearer}`).send(body);
    return { org, invoice, bearer, publicMethods, patchOrg };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'settings_audit_logs', 'app_settings', 'invoices', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('a tenant provisioned with the legacy methods row saves new defaults, and the public payload shows them', async () => {
    const t = await tenant({ accepted: ['BANK_TRANSFER', 'CHECK', 'CASH', 'CARD'] });

    const saved = await t.patchOrg({ accepted_payment_methods: ['CHECK', 'ZELLE'] });
    expect(saved.status).toBe(200);

    expect(await t.publicMethods()).toEqual(['CHECK', 'ZELLE', 'CARD']);
  });

  // CARD and ACH in accepted_payment_methods are capability facts the server owns in both
  // directions (conductor decision 2026-10-06): CARD while charges are enabled, ACH while the
  // account's bank-debit capability is active. A settings save can neither add nor remove them;
  // it changes only the manual methods.
  it('a settings save that leaves ACH out keeps it while the account can take bank payments', async () => {
    const t = await tenant({ accepted: ['CHECK', 'CARD', 'ACH'] });

    const saved = await t.patchOrg({ accepted_payment_methods: ['CHECK', 'CASH'] });
    expect(saved.status).toBe(200);
    expect(saved.body.accepted_payment_methods).toEqual(['CHECK', 'CASH', 'CARD', 'ACH']);

    expect(await t.publicMethods()).toEqual(['CHECK', 'CASH', 'CARD', 'ACH']);
  });

  it('a settings save that lists ACH does not add it while the account cannot take bank payments', async () => {
    const t = await tenant({ accepted: ['CHECK', 'CARD'] });

    const saved = await t.patchOrg({ accepted_payment_methods: ['CHECK', 'ACH'] });
    expect(saved.status).toBe(200);
    expect(saved.body.accepted_payment_methods).toEqual(['CHECK', 'CARD']);

    expect(await t.publicMethods()).toEqual(['CHECK', 'CARD']);
  });

  // The owner's default on/off for bank payments is its own switch beside card's, never the
  // capability fact (conductor decision 2026-10-06).
  it('the owner switches Bank off by default: no bank payment without an override, bank on an invoice that asks for it', async () => {
    const t = await tenant({ accepted: ['CHECK', 'CARD', 'ACH'] });

    const off = await t.patchOrg({ bank_offered_by_default: false });
    expect(off.status).toBe(200);
    expect(off.body.bank_offered_by_default).toBe(false);
    // The account can still take bank payments; only the default offer changed.
    expect(off.body.accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);

    expect(await t.publicMethods()).toEqual(['CHECK', 'CARD']);

    const override = await request(app).patch(`/api/invoices/${t.invoice}`).set('Authorization', `Bearer ${t.bearer}`)
      .send({ payment_methods_override: ['ACH', 'CHECK'] });
    expect(override.status).toBe(200);
    expect(await t.publicMethods()).toEqual(['ACH', 'CHECK']);
  });
});
