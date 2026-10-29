/**
 * The unauthenticated routes parse JSON under their own, tighter ceilings (middleware/publicBodyLimit.ts),
 * mounted ahead of the app-wide 1mb parser. An oversized body is a 413 before any handler or
 * lookup runs; a real body still reaches its handler.
 */
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'http';
import app from '../app';
import { prisma } from '../lib/prisma';
import { listenOnLoopback, closeServer } from './loopback-app';
import {
  publicBodyLimitFor,
  PUBLIC_JSON_LIMIT,
  PUBLIC_DECLINE_JSON_LIMIT,
  PUBLIC_APPROVE_JSON_LIMIT,
  PUBLIC_BODY_TOO_LARGE_MESSAGE,
  PUBLIC_BODY_UNREADABLE_MESSAGE,
  PUBLIC_BODY_UNSUPPORTED_MESSAGE,
} from '../middleware/publicBodyLimit';
import { TOO_COMPLEX_MESSAGE } from '../middleware/validate';
import { PUBLIC_SELECTIONS_STRUCTURE } from '../controllers/estimate.controller';

const mockPrisma = prisma as unknown as {
  estimate: { findFirst: { mock: { calls: unknown[] }; mockResolvedValue: (v: unknown) => void; mockClear: () => void } };
};

const ID = '00000000-0000-4000-8000-000000000001';
const KB = 1024;

let server: Server;
beforeAll(async () => { server = await listenOnLoopback(app); });
afterAll(() => closeServer(server));

beforeEach(() => {
  mockPrisma.estimate.findFirst.mockClear();
  mockPrisma.estimate.findFirst.mockResolvedValue(null);
});

describe('publicBodyLimitFor', () => {
  it('maps every unauthenticated JSON route to its ceiling', () => {
    expect(publicBodyLimitFor(`/api/estimates/${ID}/public`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates/${ID}/public/selections`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates/${ID}/public/pdf`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates/${ID}/decline-reasons`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates/${ID}/decline`)).toBe(PUBLIC_DECLINE_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates/${ID}/approve`)).toBe(PUBLIC_APPROVE_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/invoices/${ID}/public`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/invoices/${ID}/public/checkout`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor('/api/auth/login')).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor('/api/auth/password/reset')).toBe(PUBLIC_JSON_LIMIT);
  });

  it('matches the way Express routes: any case, optional trailing slash', () => {
    expect(publicBodyLimitFor(`/API/Estimates/${ID}/PUBLIC/selections/`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor('/api/AUTH/login/')).toBe(PUBLIC_JSON_LIMIT);
  });

  it('collapses repeated slashes, which Express routes to the same handler', () => {
    expect(publicBodyLimitFor(`/api/estimates//${ID}/approve`)).toBe(PUBLIC_APPROVE_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/estimates//${ID}//decline`)).toBe(PUBLIC_DECLINE_JSON_LIMIT);
    expect(publicBodyLimitFor(`/api/invoices//${ID}/public//checkout`)).toBe(PUBLIC_JSON_LIMIT);
    expect(publicBodyLimitFor('//api//auth//login')).toBe(PUBLIC_JSON_LIMIT);
  });

  it('leaves signed-in routes on the app-wide parser', () => {
    expect(publicBodyLimitFor(`/api/estimates/${ID}`)).toBeNull();
    expect(publicBodyLimitFor(`/api/estimates/${ID}/approve-internal`)).toBeNull();
    expect(publicBodyLimitFor(`/api/estimates/${ID}/decline-internal`)).toBeNull();
    expect(publicBodyLimitFor('/api/price-book/items/import')).toBeNull();
    expect(publicBodyLimitFor('/api/authority')).toBeNull();
    expect(publicBodyLimitFor('/api/webhooks/stripe')).toBeNull();
  });
});

describe('public JSON body ceilings', () => {
  it('answers 413 for a selections body over 64kb, before any lookup', async () => {
    const body = JSON.stringify({ selections: [], pad: 'x'.repeat(65 * KB) });
    const res = await request(server)
      .patch(`/api/estimates/${ID}/public/selections?token=t`)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: PUBLIC_BODY_TOO_LARGE_MESSAGE });
    expect(mockPrisma.estimate.findFirst.mock.calls).toHaveLength(0);
  });

  it('answers 413 on an auth route over 64kb', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@example.test', pad: 'x'.repeat(65 * KB) }));
    expect(res.status).toBe(413);
  });

  it('still delivers a normal selections body to its handler', async () => {
    const res = await request(server)
      .patch(`/api/estimates/${ID}/public/selections?token=t`)
      .send({ selections: [{ kind: 'line', id: ID, is_selected: true }] });
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(400);
    expect(mockPrisma.estimate.findFirst.mock.calls.length).toBeGreaterThan(0);
  });

  it('still delivers a decline with a maximum-length multi-byte note', async () => {
    const res = await request(server)
      .post(`/api/estimates/${ID}/decline?token=t`)
      .send({ lost_reason_note: '€'.repeat(20_000) }); // 3 bytes each: ~60KB
    expect(res.status).not.toBe(413);
    expect(mockPrisma.estimate.findFirst.mock.calls.length).toBeGreaterThan(0);
  });

  it('still delivers an approve carrying a full-size signature image', async () => {
    const signature = 'data:image/png;base64,' + 'A'.repeat(500_000 - 22);
    const selections = Array.from({ length: 200 }, () => ({ kind: 'line', id: ID, is_selected: true }));
    const res = await request(server)
      .post(`/api/estimates/${ID}/approve?token=t`)
      .send({ signature_data: signature, terms_accepted: true, selections });
    expect(res.status).not.toBe(413);
    expect(mockPrisma.estimate.findFirst.mock.calls.length).toBeGreaterThan(0);
  });

  it('refuses an approve whose selections array is over the structural limit, before any lookup', async () => {
    // approve parses its own body, so it runs validate()'s guard itself. Inside its 640kb cap.
    const res = await request(server)
      .post(`/api/estimates/${ID}/approve?token=t`)
      .send({ selections: new Array(PUBLIC_SELECTIONS_STRUCTURE.maxArrayLength + 1).fill({}) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: TOO_COMPLEX_MESSAGE });
    expect(mockPrisma.estimate.findFirst.mock.calls).toHaveLength(0);
  });

  it('refuses a selections body over the public array ceiling before zod runs', async () => {
    const res = await request(server)
      .patch(`/api/estimates/${ID}/public/selections?token=t`)
      .send({ selections: new Array(PUBLIC_SELECTIONS_STRUCTURE.maxArrayLength + 1).fill({}) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Validation failed', details: [{ field: '', message: TOO_COMPLEX_MESSAGE }] });
    expect(mockPrisma.estimate.findFirst.mock.calls).toHaveLength(0);
  });

  it('answers 413 for an approve over its ceiling sent with a doubled slash', async () => {
    const res = await request(server)
      .post(`/api/estimates//${ID}/approve?token=t`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ signature_data: 'x'.repeat(641 * KB) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: PUBLIC_BODY_TOO_LARGE_MESSAGE });
    expect(mockPrisma.estimate.findFirst.mock.calls).toHaveLength(0);
  });

  it('answers 413 for a decline and a checkout over their ceilings sent with a doubled slash', async () => {
    const decline = await request(server)
      .post(`/api/estimates//${ID}/decline?token=t`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ lost_reason_note: 'x'.repeat(129 * KB) }));
    expect(decline.status).toBe(413);
    const checkout = await request(server)
      .post(`/api/invoices//${ID}/public/checkout?token=t`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(65 * KB) }));
    expect(checkout.status).toBe(413);
  });

  it('answers malformed JSON with a short 400 instead of a 500', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PUBLIC_BODY_UNREADABLE_MESSAGE });
  });

  it('answers an unsupported charset with a short 415 instead of a 500', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json; charset=koi8-r')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: PUBLIC_BODY_UNSUPPORTED_MESSAGE });
  });

  it('answers 413 for an approve body over its 640kb ceiling', async () => {
    const res = await request(server)
      .post(`/api/estimates/${ID}/approve?token=t`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ signature_data: 'x'.repeat(641 * KB) }));
    expect(res.status).toBe(413);
  });
});
