/**
 * POST /api/users/me/password is behind the password change limiter (spec §4.2, brief §3.2).
 * Limiters pass through in tests (no Redis), so this swaps in one that is already over its
 * limit and checks the endpoint answers 429 before anything reaches the auth provider. What the
 * limiter counts is covered in middleware/__tests__/password-change-limiter.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>();
  return {
    ...actual,
    passwordChangeLimiter: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(429).json({ error: 'Too many requests', retryAfter: 900 }),
  };
});

import app from '../app';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader } from './helpers';

describe('POST /api/users/me/password rate limit', () => {
  it('answers 429 once the limit is reached and never asks the auth provider', async () => {
    mockAuthAs('admin');
    const secret = () => randomBytes(12).toString('base64url');

    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: secret(), password: secret() });

    expect(res.status).toBe(429);
    expect(supabaseAdmin.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });
});
