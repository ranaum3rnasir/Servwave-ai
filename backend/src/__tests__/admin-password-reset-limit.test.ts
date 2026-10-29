/**
 * POST /api/users/:id/password-reset is behind the per-admin limiter (slice 07; brief §3.2).
 * Limiters pass through in tests (no Redis), so this swaps in one that is already over its limit
 * and checks the endpoint answers 429 before any user is looked up or any email goes out. What the
 * limiter counts is covered in middleware/__tests__/admin-password-reset-limiter.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>();
  return {
    ...actual,
    adminPasswordResetLimiter: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(429).json({ error: 'Too many requests', retryAfter: 900 }),
  };
});

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { sendPasswordResetEmail } from '../lib/email';
import { mockAuthAs, authHeader } from './helpers';

describe('POST /api/users/:id/password-reset rate limit', () => {
  it('answers 429 once the admin is over the limit, and looks up, records and sends nothing', async () => {
    mockAuthAs('admin');

    const res = await request(app).post('/api/users/00000000-0000-4000-8000-0000000000a1/password-reset').set(authHeader('admin'));

    expect(res.status).toBe(429);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(supabaseAdmin.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});
