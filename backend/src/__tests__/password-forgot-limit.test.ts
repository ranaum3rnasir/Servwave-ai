/**
 * POST /api/auth/password/forgot is behind the per-IP forgot limiter (brief §3.2). Limiters pass
 * through in tests (no Redis), so this swaps in one that is already over its limit and checks the
 * endpoint answers 429 before any account is looked up or any email goes out. What the limiter
 * counts is covered in middleware/__tests__/forgot-password-limiter.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>();
  return {
    ...actual,
    passwordResetRequestLimiter: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(429).json({ error: 'Too many requests', retryAfter: 900 }),
  };
});

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { sendPasswordResetEmail } from '../lib/email';

describe('POST /api/auth/password/forgot rate limit', () => {
  it('answers 429 once the IP is over its limit, and looks nothing up', async () => {
    const res = await request(app).post('/api/auth/password/forgot').send({ email: 'dana@example.test' });

    expect(res.status).toBe(429);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
