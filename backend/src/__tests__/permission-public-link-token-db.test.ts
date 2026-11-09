/* =============================================================================
   Security finding N0 (re-audit 2026-10-29, pre-PR review fixes): a customer's estimate or invoice link opens only with its own
   token, written as one plain piece of text.

   Express reads `?token[not]=x` as an object and `?token=a&token=b` as a list. Handed to the database as the token, the object
   is a filter ("any token but x"), so a record id alone opened the link and could approve or decline the estimate. Every link
   door now takes the token only as non-empty plain text and answers 404 "not found" to anything else, the same answer as a
   wrong token; nothing is read and nothing changes.

   The doors are read off the live routers (every route marked `unscopedRequest`, the customer-link marker), so a link door
   added later joins this table or fails it. Everything goes through the HTTP API on a real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { Router } from 'express';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { unscopedRequest } from '../middleware/unscopedRequest';
import estimateRoutes from '../routes/estimate.routes';
import invoiceRoutes from '../routes/invoice.routes';

const suite = realClient ? describe : describe.skip;

type Door = { method: 'get' | 'post' | 'patch'; path: string; record: 'estimate' | 'invoice'; body?: (line: string) => object };

/** Every customer-link door, with a body the door would accept, so the token is the only thing that can refuse it. */
const DOORS: Record<string, Door> = {
  'GET /api/estimates/:id/public': { method: 'get', path: '/api/estimates/:id/public', record: 'estimate' },
  'GET /api/estimates/:id/public/pdf': { method: 'get', path: '/api/estimates/:id/public/pdf', record: 'estimate' },
  'PATCH /api/estimates/:id/public/selections': {
    method: 'patch', path: '/api/estimates/:id/public/selections', record: 'estimate',
    body: (line) => ({ selections: [{ kind: 'line', id: line, is_selected: false }] }),
  },
  'POST /api/estimates/:id/approve': {
    method: 'post', path: '/api/estimates/:id/approve', record: 'estimate',
    body: () => ({ signature_data: 'data:image/png;base64,iVBORw0KGgo=' }),
  },
  'GET /api/estimates/:id/decline-reasons': { method: 'get', path: '/api/estimates/:id/decline-reasons', record: 'estimate' },
  'POST /api/estimates/:id/decline': { method: 'post', path: '/api/estimates/:id/decline', record: 'estimate', body: () => ({}) },
  'GET /api/invoices/:id/public': { method: 'get', path: '/api/invoices/:id/public', record: 'invoice' },
  'GET /api/invoices/:id/public/pdf': { method: 'get', path: '/api/invoices/:id/public/pdf', record: 'invoice' },
  'POST /api/invoices/:id/public/checkout': { method: 'post', path: '/api/invoices/:id/public/checkout', record: 'invoice', body: () => ({}) },
};

/** The link doors the routers really mount: every route that carries the customer-link marker. */
function linkDoorsOf(router: Router, base: string): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
  return (router.stack as unknown as Layer[])
    .filter((l) => l.route && l.route.stack.some((s) => s.handle === unscopedRequest))
    .map((l) => `${Object.keys(l.route!.methods).map((m) => m.toUpperCase()).join(',')} ${base}${l.route!.path}`);
}

suite('N0: a customer link opens only with its own token, as plain text (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = await fx.listener();
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A sent estimate and a sent invoice, each with its own link token, on a fresh company. */
  async function linkedRecords() {
    const { org, admin, customer } = await fx.newOrg();
    const n = ++sequence;
    const estimate = await fx.addEstimate(org, customer, admin.id);
    const estimateToken = `n0-estimate-token-${n}-${org.slice(0, 8)}`;
    await db.estimate.update({
      where: { id: estimate.id },
      data: { status: 'SENT', public_token: estimateToken, sent_at: new Date(), valid_until: new Date(Date.now() + 30 * 86_400_000) },
    });
    const invoice = await fx.addInvoice(org, customer);
    const invoiceToken = `n0-invoice-token-${n}-${org.slice(0, 8)}`;
    await db.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT', public_token: invoiceToken } });
    return { estimate, estimateToken, invoice, invoiceToken };
  }

  function call(door: Door, id: string, query: string, line: string) {
    const url = `${door.path.replace(':id', id)}${query ? `?${query}` : ''}`;
    const r = request(app)[door.method](url);
    return door.body ? r.send(door.body(line)) : r;
  }

  it('tests every customer-link door the routers mount (a new door joins this table or fails it)', () => {
    const mounted = [...linkDoorsOf(estimateRoutes, '/api/estimates'), ...linkDoorsOf(invoiceRoutes, '/api/invoices')].sort();
    expect(mounted).toEqual(Object.keys(DOORS).sort());
  });

  it('answers 404 to a token that is an object, a list, empty or missing, and changes nothing', async () => {
    const r = await linkedRecords();
    // An object filter, the same filter around the real token, a list holding the real token, empty text, and no token.
    const shapes = (real: string) => [
      'token[not]=zzz',
      'token[contains]=n0',
      `token[equals]=${real}`,
      `token[]=${real}`,
      `token=${real}&token=${real}`,
      'token=',
      '',
    ];
    const answers: string[] = [];
    for (const [key, door] of Object.entries(DOORS)) {
      const id = door.record === 'estimate' ? r.estimate.id : r.invoice.id;
      const real = door.record === 'estimate' ? r.estimateToken : r.invoiceToken;
      for (const q of shapes(real)) {
        const res = await call(door, id, q, r.estimate.lineId);
        if (res.status !== 404) answers.push(`${key} ?${q} -> ${res.status}`);
      }
    }
    expect(answers, 'doors that did not answer 404').toEqual([]);

    const estimate = await db.estimate.findUniqueOrThrow({
      where: { id: r.estimate.id }, select: { status: true, signature_data: true, lost_reason: true },
    });
    expect(estimate).toEqual({ status: 'SENT', signature_data: null, lost_reason: null });
    const line = await db.estimateLineItem.findUniqueOrThrow({ where: { id: r.estimate.lineId }, select: { is_selected: true } });
    expect(line.is_selected).toBe(true);
    expect(await db.invoice.findUniqueOrThrow({ where: { id: r.invoice.id }, select: { status: true } })).toEqual({ status: 'SENT' });
  });

  it('still opens, approves and declines with the right token', async () => {
    const r = await linkedRecords();
    const est = await request(app).get(`/api/estimates/${r.estimate.id}/public?token=${r.estimateToken}`);
    expect(est.status).toBe(200);
    expect(est.body.id ?? est.body.estimate?.id).toBe(r.estimate.id);
    const inv = await request(app).get(`/api/invoices/${r.invoice.id}/public?token=${r.invoiceToken}`);
    expect(inv.status).toBe(200);
    expect(await request(app).get(`/api/estimates/${r.estimate.id}/decline-reasons?token=${r.estimateToken}`).then((x) => x.status)).toBe(200);

    const approved = await request(app)
      .post(`/api/estimates/${r.estimate.id}/approve?token=${r.estimateToken}`)
      .send({ signature_data: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(approved.status).toBe(200);
    expect((await db.estimate.findUniqueOrThrow({ where: { id: r.estimate.id }, select: { status: true } })).status).toBe('WON');

    const other = await linkedRecords();
    const declined = await request(app).post(`/api/estimates/${other.estimate.id}/decline?token=${other.estimateToken}`).send({});
    expect(declined.status).toBe(200);
    expect((await db.estimate.findUniqueOrThrow({ where: { id: other.estimate.id }, select: { status: true } })).status).toBe('DECLINED');
  });
});
