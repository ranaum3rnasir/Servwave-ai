/* =============================================================================
   Payments go-live slice 36 - processor sandbox end to end: the contractor's colour and logo reach the
   connected account's branding settings, and read back from the processor afterwards.

   The account under test is created by the product's own account-creation code (createConnectedAccount), so
   it has the product's real controller settings (the processor collects requirements and carries payment
   losses; the platform may NOT write the business profile or the payment settings on it). The test asserts
   that model and fails loudly if the account is anything else: an account on the older model allows every
   write and would prove nothing. It never touches a demo org's account.

   Opt-in, because it writes to the shared sandbox: runs only with TEST_DATABASE_URL set,
   STRIPE_SANDBOX_E2E=1, and a test-mode key (sk_test_) in backend/.env. It never runs in live mode.

     STRIPE_SANDBOX_E2E=1 TEST_DATABASE_URL=postgresql://...:5433/... \
       npx vitest run src/__tests__/branding-and-descriptor-sandbox-db.test.ts
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl && process.env.STRIPE_SANDBOX_E2E === '1' ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup fakes the processor; here it is the real sandbox.
vi.unmock('../lib/stripe');

import Stripe from 'stripe';
import sharp from 'sharp';
import { env } from '../config/env';
import { supabaseAdmin } from '../lib/supabase';
import { STRIPE_API_VERSION, createConnectedAccount } from '../lib/stripe';
import { syncOrgBranding } from '../lib/stripe-branding';
import { mccForIndustry } from '../lib/stripe-mcc';

function sandboxKey(): string | undefined {
  try {
    const key = dotenv.parse(readFileSync(join(__dirname, '../../.env')))['STRIPE_SECRET_KEY']?.trim();
    return key?.startsWith('sk_test_') ? key : undefined;
  } catch {
    return undefined;
  }
}

const key = realClient ? sandboxKey() : undefined;
const suite = realClient && key ? describe : describe.skip;

suite('sandbox: branding read back from the processor on a platform-controlled account', () => {
  const db = realClient!;
  const org = randomUUID();
  const user = randomUUID();
  const tag = org.slice(0, 8);
  let app: Parameters<typeof request>[0];
  let platform: Stripe;
  let account: Stripe.Account;

  beforeAll(async () => {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = key;
    platform = new Stripe(key!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
    account = await createConnectedAccount({
      orgId: org, email: `pay36-${tag}@example.test`, businessName: `Sandbox Branding ${tag}`, mcc: mccForIndustry(null),
      statementDescriptor: `SANDBOX ${tag.toUpperCase()}`, brandColorHex: '#0C2D3A', businessType: 'company',
      address: { line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108' },
    });
    // The wrong account model would let every write through and prove nothing: refuse to run on it.
    if (account.controller?.requirement_collection !== 'stripe') {
      throw new Error(`sandbox account ${account.id} is not on the product's account model (requirement_collection=${account.controller?.requirement_collection}); this test would prove nothing`);
    }
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
    await db.organization.create({
      data: {
        id: org, name: `Sandbox Branding ${tag}`, email: `pay36-${tag}@example.test`, brand_color: '#0C2D3A',
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', stripe_account_id: account.id,
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
  }, 60000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
    await quietly(db.$executeRawUnsafe(`DELETE FROM users WHERE organization_id = '${org}'`));
    await quietly(db.organization.deleteMany({ where: { id: org } }));
    await db.$disconnect();
    // The account was made for this run; remove it (the sandbox may refuse, which is harmless).
    if (account?.id) await quietly(platform.accounts.del(account.id));
  }, 60000);

  it('the account has the product\'s controller settings', () => {
    // The refusal of business_profile / payment settings is exercised against a double in stripe-lib.test.ts:
    // the key in a local .env is the platform's own and is not refused the way the deployed one is.
    expect(account.controller?.requirement_collection).toBe('stripe');
    expect(account.controller?.losses?.payments).toBe('stripe');
    expect(account.controller?.fees?.payer).toBe('account');
  });

  it('a colour save and a logo upload reach the account and read back', async () => {
    const colourBefore = (await platform.accounts.retrieve(account.id)).settings?.branding?.primary_color;
    // The colour, through the real save route.
    const save = await request(app).patch('/api/organization').set('Authorization', `Bearer pay36-${tag}`)
      .send({ brand_color: '#AA3311' });
    expect(save.status).toBe(200);
    await vi.waitFor(async () => {
      const a = await platform.accounts.retrieve(account.id);
      expect(a.settings?.branding?.primary_color).toBe('#AA3311');
    }, { timeout: 30000, interval: 1000 });
    expect(colourBefore).not.toBe('#AA3311');

    // The logo: a real image through the real sync step, read back as a file on the account.
    const logoBefore = (await platform.accounts.retrieve(account.id)).settings?.branding?.logo ?? null;
    const logo = await sharp({ create: { width: 267, height: 107, channels: 3, background: '#aa3311' } }).png().toBuffer();
    await syncOrgBranding(org, { logo: { data: logo, mime: 'image/png' } });
    const after = await platform.accounts.retrieve(account.id);
    const logoAfter = after.settings?.branding?.logo;
    expect(typeof logoAfter).toBe('string');
    expect(logoAfter).not.toBe(logoBefore);
    expect(after.settings?.branding?.primary_color).toBe('#AA3311');
    console.log(`[sandbox-read-back] primary_color=${after.settings?.branding?.primary_color} logo=${logoAfter}`);
  }, 120000);
});
