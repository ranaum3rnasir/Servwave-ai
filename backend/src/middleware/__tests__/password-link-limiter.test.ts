/**
 * The limiter on POST /api/users/me/password/email-link (slice 06; brief §3.2).
 *
 * Each accepted request may send an email, so every request counts, success included, per
 * signed-in user across IPs. Real in-memory limiter, real Express app: the seam is the HTTP status
 * a caller gets.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';

vi.mock('../../lib/security-signal', () => ({ reportSecuritySignal: vi.fn() }));

import { passwordLinkUserLimiter, PASSWORD_LINK_REQUESTS_PER_USER } from '../rate-limit';

function appWith(points: number) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    req.user = { id: String(req.headers['x-user']) } as typeof req.user;
    next();
  });
  app.post('/me/password/email-link', passwordLinkUserLimiter(new RateLimiterMemory({ points, duration: 900 })), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const ask = (app: express.Express, user: string, ip = '198.51.100.1') =>
  request(app).post('/me/password/email-link').set({ 'x-user': user, 'X-Forwarded-For': ip });

describe('set-password link limiter', () => {
  it('allows a handful of requests per user in 15 minutes', () => {
    expect(PASSWORD_LINK_REQUESTS_PER_USER).toBe(5);
  });

  it('counts successful requests, and blocks the user once over the limit, from any IP', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) expect((await ask(app, 'u1', `198.51.100.${i + 1}`)).status).toBe(200);

    const blocked = await ask(app, 'u1', '203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(blocked.body)).not.toMatch(/redis|supabase|resend|render|vercel/i);
  });

  it('one user over the limit does not hold back another on the same IP', async () => {
    const app = appWith(3);
    for (let i = 0; i < 4; i++) await ask(app, 'u1');

    expect((await ask(app, 'u2')).status).toBe(200);
  });
});
