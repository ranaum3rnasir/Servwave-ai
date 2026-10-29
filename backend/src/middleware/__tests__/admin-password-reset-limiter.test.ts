/**
 * The limiter on POST /api/users/:id/password-reset (slice 07; brief §3.2).
 *
 * Each accepted request sends an email, so every request counts, success included, per signed-in
 * admin across IPs and target users. Real in-memory limiter, real Express app: the seam is the HTTP
 * status a caller gets.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';

vi.mock('../../lib/security-signal', () => ({ reportSecuritySignal: vi.fn() }));

import { adminPasswordResetUserLimiter, ADMIN_PASSWORD_RESETS_PER_USER } from '../rate-limit';

function appWith(points: number) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    req.user = { id: String(req.headers['x-user']) } as typeof req.user;
    next();
  });
  app.post('/users/:id/password-reset', adminPasswordResetUserLimiter(new RateLimiterMemory({ points, duration: 900 })), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const send = (app: express.Express, admin: string, target: string, ip = '198.51.100.1') =>
  request(app).post(`/users/${target}/password-reset`).set({ 'x-user': admin, 'X-Forwarded-For': ip });

describe('admin password reset limiter', () => {
  it('allows an admin a working batch of sends in 15 minutes', () => {
    expect(ADMIN_PASSWORD_RESETS_PER_USER).toBe(20);
  });

  it('counts successful sends across different people and IPs, and blocks the admin once over the limit', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) expect((await send(app, 'admin-1', `user-${i}`, `198.51.100.${i + 1}`)).status).toBe(200);

    const blocked = await send(app, 'admin-1', 'user-9', '203.0.113.9');
    expect(blocked.status).toBe(429);
    expect(JSON.stringify(blocked.body)).not.toMatch(/redis|supabase|resend|render|vercel/i);
  });

  it('one admin over the limit does not hold back another admin on the same IP', async () => {
    const app = appWith(3);
    for (let i = 0; i < 4; i++) await send(app, 'admin-1', 'user-1');

    expect((await send(app, 'admin-2', 'user-1')).status).toBe(200);
  });
});
