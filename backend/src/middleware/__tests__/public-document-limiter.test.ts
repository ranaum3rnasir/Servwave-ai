/**
 * The limiters on a customer's public link (#2981).
 *
 * Signing and paying are counted per connection AND document, 20 per 15 minutes, so a customer whose
 * card is declined can try again and a second estimate from the same office is never held back by the
 * first. Declining is its own bucket, per connection, 5 per 15 minutes. Real in-memory limiters on a
 * real Express app: the seam is the status and body a caller gets.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';

vi.mock('../../lib/security-signal', () => ({ reportSecuritySignal: vi.fn() }));

import {
  publicDocumentActionUserLimiter,
  publicDeclineConnectionLimiter,
  PUBLIC_DOCUMENT_ACTIONS_PER_CONNECTION,
  PUBLIC_DECLINES_PER_CONNECTION,
} from '../rate-limit';

const DOC_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const DOC_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function appWith(documentPoints = PUBLIC_DOCUMENT_ACTIONS_PER_CONNECTION, declinePoints = PUBLIC_DECLINES_PER_CONNECTION) {
  const app = express();
  app.set('trust proxy', true);
  const docRL = publicDocumentActionUserLimiter(new RateLimiterMemory({ points: documentPoints, duration: 900 }));
  const declineRL = publicDeclineConnectionLimiter(new RateLimiterMemory({ points: declinePoints, duration: 900 }));
  app.post('/estimates/:id/approve', docRL, (_req, res) => { res.json({ ok: true }); });
  app.post('/invoices/:id/public/checkout', docRL, (_req, res) => { res.json({ ok: true }); });
  app.post('/estimates/:id/decline', declineRL, (_req, res) => { res.json({ ok: true }); });
  return app;
}

const ask = (app: express.Express, path: string, ip = '198.51.100.1') =>
  request(app).post(path).set('X-Forwarded-For', ip);

describe('signing and paying tries: 20 per connection per document', () => {
  it('allows 20 in 15 minutes and refuses the 21st with 429 and retryAfter', async () => {
    expect(PUBLIC_DOCUMENT_ACTIONS_PER_CONNECTION).toBe(20);
    const app = appWith();
    for (let i = 0; i < 20; i++) expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(200);

    const blocked = await ask(app, `/estimates/${DOC_A}/approve`);
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('a try on another document from the same connection does not count against this one', async () => {
    const app = appWith(3);
    for (let i = 0; i < 4; i++) await ask(app, `/estimates/${DOC_A}/approve`);

    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(429);
    expect((await ask(app, `/estimates/${DOC_B}/approve`)).status).toBe(200);
    expect((await ask(app, `/invoices/${DOC_B}/public/checkout`)).status).toBe(200);
  });

  it('another connection has its own allowance on the same document', async () => {
    const app = appWith(2);
    for (let i = 0; i < 3; i++) await ask(app, `/estimates/${DOC_A}/approve`);

    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(429);
    expect((await ask(app, `/estimates/${DOC_A}/approve`, '203.0.113.7')).status).toBe(200);
  });

  it('a spelling that is not the canonical id shares one bucket, so it never buys a fresh allowance', async () => {
    const app = appWith(2);
    const spellings = ['AAAAAAAA-0000-4000-8000-000000000001', 'aaaaaaaa000040008000000000000001', `{${DOC_A}}`];
    for (const s of spellings) await ask(app, `/estimates/${encodeURIComponent(s)}/approve`);

    expect((await ask(app, `/estimates/${encodeURIComponent(spellings[0]!)}/approve`)).status).toBe(429);
    // ...and it is not the canonical document's bucket either.
    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(200);
  });

  it('names no vendor in the refusal', async () => {
    const app = appWith(1);
    await ask(app, `/estimates/${DOC_A}/approve`);
    const blocked = await ask(app, `/estimates/${DOC_A}/approve`);
    expect(JSON.stringify(blocked.body)).not.toMatch(/redis|stripe|supabase|resend|render|vercel/i);
  });
});

describe('declining: its own allowance of 5 per connection', () => {
  it('refuses the 6th decline, and payment tries never use that allowance', async () => {
    expect(PUBLIC_DECLINES_PER_CONNECTION).toBe(5);
    const app = appWith();
    for (let i = 0; i < 5; i++) expect((await ask(app, `/estimates/${DOC_A}/decline`)).status).toBe(200);
    const blocked = await ask(app, `/estimates/${DOC_A}/decline`);
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);

    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(200);
  });

  it('declines never use the payment allowance', async () => {
    const app = appWith(2, 50);
    for (let i = 0; i < 10; i++) await ask(app, `/estimates/${DOC_A}/decline`);

    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(200);
    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(200);
    expect((await ask(app, `/estimates/${DOC_A}/approve`)).status).toBe(429);
  });
});
