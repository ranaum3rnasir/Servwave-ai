/**
 * POST /api/auth/password/reset is behind the auth limiter (spec §5.2, brief §3.2), which counts
 * failed attempts. Limiters pass through in tests (no Redis), so this swaps in one that is already
 * over its limit and checks the token is never checked and no password is set.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>();
  return {
    ...actual,
    authLimiter: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(429).json({ error: 'Too many requests', retryAfter: 900 }),
  };
});

import app from '../app';
import { supabaseAdmin, createIsolatedAuthClient } from '../lib/supabase';

describe('POST /api/auth/password/reset rate limit', () => {
  it('answers 429 once the limit is reached and never checks the token', async () => {
    const secret = () => randomBytes(16).toString('base64url');

    const res = await request(app).post('/api/auth/password/reset').send({ token: secret(), password: secret() });

    expect(res.status).toBe(429);
    expect(createIsolatedAuthClient).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
});
