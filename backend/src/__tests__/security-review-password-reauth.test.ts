import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, TEST_ORG, mockAuthAs, authHeader } from './helpers';

// SECURITY (review #4): POST /api/users/me/password must require AND verify the current password,
// so a momentarily-stolen session can't be turned into permanent account takeover by silently
// resetting the password.

const mockSupabase = supabaseAdmin as unknown as {
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    admin: { listUsers: ReturnType<typeof vi.fn>; updateUserById: ReturnType<typeof vi.fn> };
  };
};

// changeMyPassword reads { has_login, email }; authenticate also reads the user by id. Return a
// single object that satisfies both, keyed by the requesting user's id.
function mockLoginUser(userKey: 'admin' | 'sales' = 'admin') {
  mockAuthAs(userKey);
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation((args: { where: { id: string } }) => {
    const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
    return Promise.resolve(match ? { ...match, has_login: true, organization: TEST_ORG } : null);
  });
  // findSupabaseAuthIdByEmail → listUsers
  mockSupabase.auth.admin.listUsers.mockResolvedValue({
    data: { users: [{ id: 'auth-id-1', email: TEST_USERS[userKey].email }], nextPage: null },
    error: null,
  });
  mockSupabase.auth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/users/me/password — current-password re-auth (#4)', () => {
  it('rejects with 400 when current_password is missing (schema)', async () => {
    mockLoginUser('admin');
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ password: 'newStrongPass1' });
    expect(res.status).toBe(400);
    expect(mockSupabase.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the current password is wrong, and never updates the password', async () => {
    mockLoginUser('admin');
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials' } });

    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'wrong-password', password: 'newStrongPass1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Current password is incorrect');
    expect(mockSupabase.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('updates the password (200) only after the current password verifies', async () => {
    mockLoginUser('admin');
    mockSupabase.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'auth-id-1' } }, error: null });

    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'correct-current', password: 'newStrongPass1' });

    expect(res.status).toBe(200);
    expect(mockSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: TEST_USERS.admin.email,
      password: 'correct-current',
    });
    expect(mockSupabase.auth.admin.updateUserById).toHaveBeenCalledWith('auth-id-1', { password: 'newStrongPass1' });
  });
});
