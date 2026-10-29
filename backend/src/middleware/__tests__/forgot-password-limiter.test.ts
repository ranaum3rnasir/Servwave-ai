/**
 * The per-IP limiter on POST /api/auth/password/forgot (password reset spec §5.2, brief §3.2).
 *
 * The endpoint answers 200 to everything, and the auth limiter refunds every response < 400, so
 * on its own nothing would ever be counted. This limiter counts every request from an IP. Real
 * in-memory limiter, real Express app: the seam is the HTTP status a caller gets.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';

vi.mock('../../lib/security-signal', () => ({ reportSecuritySignal: vi.fn() }));

import { forgotPasswordIpLimiter } from '../rate-limit';

function appWith(points: number) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/forgot', forgotPasswordIpLimiter(new RateLimiterMemory({ points, duration: 900 })), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const ask = (app: express.Express, ip: string, email = 'dana@example.test') =>
  request(app).post('/forgot').set('X-Forwarded-For', ip).send({ email });

describe('forgot-password IP limiter', () => {
  it('counts successful requests, and blocks an IP once it is over the limit', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) expect((await ask(app, '198.51.100.1', `u${i}@example.test`)).status).toBe(200);

    const blocked = await ask(app, '198.51.100.1', 'someone-else@example.test');
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(blocked.body)).not.toMatch(/redis|supabase|resend|render|vercel/i);
  });

  it('one IP over the limit does not hold back another', async () => {
    const app = appWith(3);
    for (let i = 0; i < 4; i++) await ask(app, '198.51.100.1');

    expect((await ask(app, '198.51.100.2')).status).toBe(200);
  });
});
