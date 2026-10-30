/* =============================================================================
   V7 review fix 11c - the bodies of the V7 handlers are read through Zod at the boundary. The answers a malformed body
   gets are the sentences and statuses the screens already show, so they are pinned here: the same 400 and the same
   words as before the parsers were replaced. Real migrated database (TEST_DATABASE_URL); the processor is faked.
   Skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { createRefund, getStripeForOrg, listPaymentIntentRefunds, retrieveCapturePayerDetail } from '../lib/stripe';
import { supabaseAdmin } from '../lib/supabase';
import { addCapture, addInvoice, cleanupOrgs, seedOrg, type Fixture } from './helpers/unapplied-money-fixture';

const suite = realClient ? describe : describe.skip;

suite('V7 handlers: a malformed body gets the same 400 (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  afterAll(async () => {
    await cleanupOrgs(db, orgs);
    await db.$disconnect();
  });
  beforeEach(() => {
    vi.mocked(createRefund).mockReset();
    vi.mocked(listPaymentIntentRefunds).mockReset().mockResolvedValue([]);
    vi.mocked(retrieveCapturePayerDetail).mockReset().mockResolvedValue({ method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: null } as never);
    vi.mocked(getStripeForOrg).mockReturnValue({ stripe: {}, stripeAccount: undefined } as unknown as ReturnType<typeof getStripeForOrg>);
  });

  /** A signed-in admin; `raw` sends the body exactly as given (an array, a bare string), the way a hand-made request could. */
  function as(f: Fixture) {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: { id: f.admin.id, email: f.admin.email } }, error: null });
    const bearer = `Bearer v709b-${f.admin.id}`;
    return {
      send: (method: 'post' | 'patch', path: string, body: unknown) =>
        request(app)[method](path).set('Authorization', bearer).set('Content-Type', 'application/json').send(JSON.stringify(body)),
    };
  }

  describe('POST /api/payments-needing-attention/:id/attach', () => {
    it.each([
      ['an invoice_id that is a number', { invoice_id: 5 }],
      ['an invoice_id that is null', { invoice_id: null }],
      ['an invoice_id that is not an id', { invoice_id: 'not-an-id' }],
      ['an empty body', {}],
      ['an array', []],
    ])('%s: 400 "Choose an invoice." with the field', async (_name, body) => {
      const f = await seedOrg(db, orgs);
      const capture = await addCapture(db, f, { amount: 50 });
      const res = await as(f).send('post', `/api/payments-needing-attention/${capture.id}/attach`, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Choose an invoice.', field: 'invoice_id' });
    });

    it('a well-formed body still reaches the booking', async () => {
      const f = await seedOrg(db, orgs);
      const invoice = await addInvoice(db, f, { total: 50 });
      const capture = await addCapture(db, f, { amount: 50 });
      expect((await as(f).send('post', `/api/payments-needing-attention/${capture.id}/attach`, { invoice_id: invoice.id })).status).toBe(200);
    });
  });

  describe('POST /api/payments-needing-attention/:id/refund', () => {
    it.each([
      ['an amount that is a boolean', { amount: true }],
      ['an amount that is an object', { amount: { value: 5 } }],
      ['an amount that is an array', { amount: [5] }],
      ['an amount that is text', { amount: 'abc' }],
      ['an amount of zero', { amount: 0 }],
      ['a negative amount', { amount: -5 }],
    ])('%s: 400 "Enter an amount above $0.00." with the field, and nothing is sent', async (_name, body) => {
      const f = await seedOrg(db, orgs);
      const capture = await addCapture(db, f, { amount: 50 });
      const res = await as(f).send('post', `/api/payments-needing-attention/${capture.id}/refund`, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Enter an amount above $0.00.', field: 'amount' });
      expect(createRefund).not.toHaveBeenCalled();
    });

    it('an amount above what is left: 400 "Enter $50.00 or less."', async () => {
      const f = await seedOrg(db, orgs);
      const capture = await addCapture(db, f, { amount: 50 });
      const res = await as(f).send('post', `/api/payments-needing-attention/${capture.id}/refund`, { amount: '50.01' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Enter $50.00 or less.', field: 'amount' });
    });
  });

  describe('POST /api/payments-needing-attention/:id/resolve', () => {
    it.each([
      ['a reason that is a number', { reason: 5 }],
      ['a reason that is an object', { reason: { text: 'x' } }],
      ['an empty reason', { reason: '' }],
      ['an unknown reason', { reason: 'Because' }],
      ['a reason from the other kind\'s set', { reason: 'Returned the money another way' }],
    ])('%s: 400 "Choose a reason." with the field, and the item stays open', async (_name, body) => {
      const f = await seedOrg(db, orgs);
      const capture = await addCapture(db, f, { amount: 50 });
      const res = await as(f).send('post', `/api/payments-needing-attention/${capture.id}/resolve`, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Choose a reason.', field: 'reason' });
      expect((await db.unappliedCapture.findUniqueOrThrow({ where: { id: capture.id } })).status).toBe('OPEN');
    });

    it('no reason at all, null or an array body are still accepted (older clients send none)', async () => {
      const f = await seedOrg(db, orgs);
      for (const body of [{}, { reason: null }, []]) {
        const capture = await addCapture(db, f, { amount: 50 });
        const res = await as(f).send('post', `/api/payments-needing-attention/${capture.id}/resolve`, body);
        expect(res.status, JSON.stringify(body)).toBe(200);
      }
    });
  });

  describe('POST /api/payments-page/attention/:key/resolve', () => {
    const key = () => `failed_payment:${randomUUID()}`;
    it.each([
      ['a note that is a number', { note: 5 }, 'note', 'Note must be '],
      ['a note that is an object', { note: { a: 1 } }, 'note', 'Note must be '],
      ['a note over the limit', { note: 'x'.repeat(100_001) }, 'note', 'Note must be '],
      ['a reason that is a number', { reason: 5 }, 'reason', 'Choose a reason.'],
      ['an unknown reason', { reason: 'Because' }, 'reason', 'Choose a reason.'],
      ['a bad note and a bad reason: the note is named first', { note: 5, reason: 5 }, 'note', 'Note must be '],
    ])('%s: 400 with the field', async (_name, body, field, text) => {
      const f = await seedOrg(db, orgs);
      const res = await as(f).send('post', `/api/payments-page/attention/${key()}/resolve`, body);
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
      expect(res.body.error.startsWith(text)).toBe(true);
    });
  });

  describe('POST /api/tags and PATCH /api/tags/:id', () => {
    it.each([
      ['a name that is a number', { name: 5, color: '#112233' }],
      ['a name that is blank', { name: '   ', color: '#112233' }],
      ['a colour that is not a hex colour', { name: 'Rush', color: 'red' }],
      ['an empty body', {}],
    ])('create with %s: 400 "Validation failed"', async (_name, body) => {
      const f = await seedOrg(db, orgs);
      const res = await as(f).send('post', '/api/tags', body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(await db.tag.count({ where: { organization_id: f.org } })).toBe(0);
    });

    it.each([
      ['a name that is a number', { name: 5 }],
      ['a colour that is not a hex colour', { color: 'red' }],
    ])('rename with %s: 400 "Validation failed" and the tag is unchanged', async (_name, body) => {
      const f = await seedOrg(db, orgs);
      const tag = await db.tag.create({ data: { organization_id: f.org, name: 'Rush', color: '#112233' } });
      const res = await as(f).send('patch', `/api/tags/${tag.id}`, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(await db.tag.findUniqueOrThrow({ where: { id: tag.id } })).toMatchObject({ name: 'Rush', color: '#112233' });
    });
  });
});
