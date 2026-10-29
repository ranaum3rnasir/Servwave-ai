/**
 * The limiter on POST /api/users/me/password (password reset spec §4.2, brief §3.2).
 *
 * The login limiter keys its account bucket on `body.email`, which this endpoint never sends,
 * so on its own every caller shared one empty-email bucket per IP. This limiter keys the account
 * bucket on the signed-in user instead. Real in-memory limiters, a real Express app: the seam is
 * the HTTP status a caller gets.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { RateLimiterMemory } from 'rate-limiter-flexible';

vi.mock('../../lib/security-signal', () => ({ reportSecuritySignal: vi.fn() }));

import { authLimiterImpl, userIdentityKey } from '../rate-limit';

/** A stand-in for the endpoint: `outcome` decides whether this attempt failed. */
function appWith(points: number) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: String(req.headers['x-user']) } as typeof req.user;
    next();
  });
  app.post(
    '/me/password',
    authLimiterImpl(new RateLimiterMemory({ points, duration: 900 }), new RateLimiterMemory({ points: 1000, duration: 900 }), userIdentityKey),
    (req, res) => {
      res.status(req.body.outcome === 'ok' ? 200 : 400).json({});
    },
  );
  return app;
}

const attempt = (app: express.Express, user: string, outcome: 'ok' | 'wrong', ip = '198.51.100.1') =>
  request(app).post('/me/password').set({ 'x-user': user, 'X-Forwarded-For': ip }).send({ outcome });

describe('password change limiter', () => {
  it('blocks a user after 5 failed attempts with no email in the body, even from new addresses', async () => {
    const app = appWith(5);
    for (let i = 0; i < 5; i++) expect((await attempt(app, 'user-a', 'wrong', `198.51.100.${i + 1}`)).status).toBe(400);

    expect((await attempt(app, 'user-a', 'wrong', '198.51.100.99')).status).toBe(429);
  });

  it('one user hitting the limit does not lock out another', async () => {
    const app = appWith(5);
    for (let i = 0; i < 6; i++) await attempt(app, 'user-a', 'wrong');

    expect((await attempt(app, 'user-b', 'wrong')).status).toBe(400);
  });

  it('successful changes are refunded, so only failures count', async () => {
    const app = appWith(5);
    for (let i = 0; i < 8; i++) expect((await attempt(app, 'user-a', 'ok')).status).toBe(200);

    expect((await attempt(app, 'user-a', 'wrong')).status).toBe(400);
  });
});
