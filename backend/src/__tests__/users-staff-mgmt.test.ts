import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { TEST_USERS, TEST_ORG, mockAuthAs, authHeader } from './helpers';
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
import { USER_PHONE_INVALID_MESSAGE } from '../lib/user-phone';

// inviteUser needs a real sendUserInviteEmail mock (setup.ts's email mock omits it).
vi.mock('../lib/email', () => ({
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

const mockSupabaseAdmin = supabaseAdmin as unknown as {
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    admin: {
      createUser: ReturnType<typeof vi.fn>;
      deleteUser: ReturnType<typeof vi.fn>;
      updateUserById: ReturnType<typeof vi.fn>;
      listUsers: ReturnType<typeof vi.fn>;
    };
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// After mockAuthAs(...), resolve both the admin (auth middleware's resolveAppUser
// looks up by id) AND a specific target row. Stub findUnique AND findFirst because
// the controllers are mixed: revoke-login looks the target up by findUnique, while
// update/deactivate use tenant-scoped findFirst.
function authPlusTarget(target: Record<string, unknown> & { id: string }) {
  const resolve = ({ where }: { where: { id?: string; email?: string } }) => {
    if (where.id === target.id) return Promise.resolve({ ...target, organization: TEST_ORG });
    if (where.id === TEST_USERS.admin.id) return Promise.resolve({ ...TEST_USERS.admin, has_login: true, organization: TEST_ORG });
    return Promise.resolve(null);
  };
  (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(resolve);
  (mockPrisma.user.findFirst as ReturnType<typeof vi.fn>).mockImplementation(resolve);
}

// ═══════════════════════════════════════════════════════
// Phone on create / invite / update (Task 3)
// ═══════════════════════════════════════════════════════
describe('phone on user invite/update', () => {
  it('normalizes a display-form phone to E.164 when inviting a user, and keeps the extension', async () => {
    mockAuthAs('admin');
    mockPrisma.user.create.mockResolvedValue({
      id: 'u-ph', email: 'p@test.com', first_name: 'P', last_name: 'H', role: 'TECHNICIAN',
      is_active: true, has_login: true, phone: '+15551112222', phone_ext: '12',
      department_id: null, department: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'P', last_name: 'H', email: 'p@test.com', role: 'TECHNICIAN', phone: '(555) 111-2222', phone_ext: '12' });
    expect(res.status).toBe(201);
    // The invite card masks to display form as the admin types; the column must
    // still hold ONE spelling, so the schema transform is what reaches Prisma.
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ phone: '+15551112222', phone_ext: '12' });
  });

  it('normalizes the phone an admin PATCHes onto another user', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000c1';
    authPlusTarget({ id: TARGET, role: 'TECHNICIAN', is_active: true });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, phone: '+15559998888' });
    const res = await request(app)
      .patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ phone: '(555) 999-8888' });
    expect(res.status).toBe(200);
    // The handler copies from an explicit allowlist, not `data: req.body` - the
    // transform has to have run in `validate()` for the normalized value to survive it.
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ phone: '+15559998888' });
  });

  it('normalizes the phone on POST /api/users (the API-only create door)', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'u-new' } }, error: null });
    mockPrisma.user.create.mockResolvedValue({ id: 'u-new', email: 'c@test.com', phone: '+15552223333' });
    const res = await request(app)
      .post('/api/users').set(authHeader('admin'))
      .send({ email: 'c@test.com', password: 'password1', first_name: 'C', last_name: 'D', role: 'TECHNICIAN', phone: '555-222-3333' });
    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ phone: '+15552223333' });
  });

  it('accepts a leading-1 eleven-digit number and stores the same single spelling', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000c2';
    authPlusTarget({ id: TARGET, role: 'TECHNICIAN', is_active: true });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, phone: '+15559998888' });
    const res = await request(app)
      .patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ phone: '1 (555) 999-8888' });
    expect(res.status).toBe(200);
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ phone: '+15559998888' });
  });
});

// A number that cannot be dialled is refused at the door rather than stored, on
// every door - the point of the slice is that there is ONE rule, not four.
describe('unusable phone numbers are refused at entry', () => {
  const UNUSABLE = '555-0188';

  it('rejects an unusable number on the invite door, naming what is acceptable', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'P', last_name: 'H', email: 'bad@test.com', role: 'TECHNICIAN', phone: UNUSABLE });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field: 'phone', message: USER_PHONE_INVALID_MESSAGE });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects an unusable number on the admin update door', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000c3';
    authPlusTarget({ id: TARGET, role: 'TECHNICIAN', is_active: true });
    const res = await request(app)
      .patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ phone: UNUSABLE });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field: 'phone', message: USER_PHONE_INVALID_MESSAGE });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unusable number on the self-service profile door', async () => {
    mockAuthAs('admin');
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ phone: UNUSABLE });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field: 'phone', message: USER_PHONE_INVALID_MESSAGE });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unusable number on the create door', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users').set(authHeader('admin'))
      .send({ email: 'bad2@test.com', password: 'password1', first_name: 'C', last_name: 'D', role: 'TECHNICIAN', phone: UNUSABLE });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({ field: 'phone', message: USER_PHONE_INVALID_MESSAGE });
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
  });
});

// The field is optional on every door: a seat with no number must stay
// creatable, invitable and saveable, and a blank must clear rather than 400.
describe('a blank or absent phone is accepted on every door', () => {
  it('invites a user with no phone at all', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: 'u-nophone', email: 'np@test.com', first_name: 'N', last_name: 'P', role: 'TECHNICIAN',
      is_active: true, has_login: true, phone: null, phone_ext: null,
      department_id: null, department: null, created_at: new Date(), updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/users/invite').set(authHeader('admin'))
      .send({ first_name: 'N', last_name: 'P', email: 'np@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ phone: null });
  });

  it('lets an admin null out a stored number', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000c4';
    authPlusTarget({ id: TARGET, role: 'TECHNICIAN', is_active: true });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, phone: null });
    const res = await request(app)
      .patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ phone: null });
    expect(res.status).toBe(200);
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ phone: null });
  });

  it('creates a user with no phone via POST /api/users', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'u-np2' } }, error: null });
    mockPrisma.user.create.mockResolvedValue({ id: 'u-np2', email: 'np2@test.com', phone: null });
    const res = await request(app)
      .post('/api/users').set(authHeader('admin'))
      .send({ email: 'np2@test.com', password: 'password1', first_name: 'N', last_name: 'P', role: 'TECHNICIAN' });
    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ phone: null });
  });

  it('saves a name-only profile edit with no phone key at all', async () => {
    mockAuthAs('admin');
    mockPrisma.user.update.mockResolvedValue({ id: TEST_USERS.admin.id, first_name: 'Solo' });
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ first_name: 'Solo' });
    expect(res.status).toBe(200);
    // An absent key must stay absent - a transform that turned it into an
    // explicit `undefined`/null would blank a stored number on a name edit.
    expect(mockPrisma.user.update.mock.calls[0][0].data).not.toHaveProperty('phone');
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/:id/revoke-login (Task 4)
// ═══════════════════════════════════════════════════════
describe('POST /api/users/:id/revoke-login', () => {
  const TARGET = '00000000-0000-0000-0000-0000000000e1';

  it('clears has_login, blanks password_hash, and deletes the Supabase auth user', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'rev@test.com', role: 'TECHNICIAN', is_active: true, has_login: true });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb1', email: 'rev@test.com' }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, has_login: false });

    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('sb1');
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ has_login: false, password_hash: '' });
  });

  it('is idempotent when has_login is already false (no Supabase call, no update)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'rev@test.com', role: 'TECHNICIAN', is_active: true, has_login: false });
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks revoking login from the last active admin (409)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'admin2@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('admin')).send({});
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('requires user-management permission (dispatcher 403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).post(`/api/users/${TARGET}/revoke-login`).set(authHeader('dispatcher')).send({});
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════
// DELETE /api/users/:id (deactivate force-revokes login) (Task 4)
// ═══════════════════════════════════════════════════════
describe('DELETE /api/users/:id (deactivate)', () => {
  const TARGET = '00000000-0000-0000-0000-0000000000e2';

  it('sets is_active:false AND clears login (deletes Supabase auth, clears has_login)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'deact@test.com', role: 'TECHNICIAN', is_active: true, has_login: true });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb2', email: 'deact@test.com' }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
    mockPrisma.user.update.mockResolvedValue({ id: TARGET });

    const res = await request(app).delete(`/api/users/${TARGET}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith('sb2');
    expect(mockPrisma.user.update.mock.calls[0][0].data).toMatchObject({ is_active: false, has_login: false, password_hash: '' });
  });

  it('blocks deactivating the last active admin (409)', async () => {
    mockAuthAs('admin');
    authPlusTarget({ id: TARGET, email: 'admin3@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).delete(`/api/users/${TARGET}`).set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// PATCH /api/users/:id last-admin guard (Task 4)
// ═══════════════════════════════════════════════════════
describe('PATCH /api/users/:id last-admin guard', () => {
  it('blocks demoting the last active admin (409)', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000e3';
    authPlusTarget({ id: TARGET, email: 'a@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    const res = await request(app).patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ role: 'SALES' });
    expect(res.status).toBe(409);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('allows editing the last admin name (not a demote/deactivate)', async () => {
    mockAuthAs('admin');
    const TARGET = '00000000-0000-0000-0000-0000000000e4';
    authPlusTarget({ id: TARGET, email: 'a@test.com', role: 'ADMIN', is_active: true, has_login: true });
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.user.update.mockResolvedValue({ id: TARGET, first_name: 'New' });
    const res = await request(app).patch(`/api/users/${TARGET}`).set(authHeader('admin')).send({ first_name: 'New' });
    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// Self-service /me (Task 5)
// ═══════════════════════════════════════════════════════
describe('PATCH /api/users/me', () => {
  it('updates own first_name and normalizes own phone via req.user.id', async () => {
    mockAuthAs('admin');
    mockPrisma.user.update.mockResolvedValue({ id: TEST_USERS.admin.id, first_name: 'Renamed', phone: '+15550001111' });
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ first_name: 'Renamed', phone: '(555) 000-1111' });
    expect(res.status).toBe(200);
    const args = mockPrisma.user.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: TEST_USERS.admin.id });
    // updateMe spreads `req.body` wholesale, so the schema transform is the only
    // thing standing between the masked form value and the column.
    expect(args.data).toMatchObject({ first_name: 'Renamed', phone: '+15550001111' });
  });

  it('rejects privileged keys (role) with 400 (.strict)', async () => {
    mockAuthAs('admin');
    const res = await request(app).patch('/api/users/me').set(authHeader('admin')).send({ role: 'SALES' });
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/me/password', () => {
  it('updates the Supabase password for a has_login user (resolved by email), after current-password re-auth (#4)', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...TEST_USERS.admin, has_login: true, organization: TEST_ORG });
    mockSupabaseAdmin.auth.admin.listUsers.mockResolvedValue({
      data: { users: [{ id: 'sb-admin', email: TEST_USERS.admin.email }], nextPage: null }, error: null,
    });
    mockSupabaseAdmin.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'sb-admin' } }, error: null });
    mockSupabaseAdmin.auth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'newpass123' });
    expect(res.status).toBe(200);
    expect(mockSupabaseAdmin.auth.signInWithPassword).toHaveBeenCalledWith({ email: TEST_USERS.admin.email, password: 'oldpass123' });
    expect(mockSupabaseAdmin.auth.admin.updateUserById).toHaveBeenCalledWith('sb-admin', { password: 'newpass123' });
  });

  it('returns 400 when the caller has_login is false', async () => {
    mockAuthAs('admin');
    (mockPrisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...TEST_USERS.admin, has_login: false, organization: TEST_ORG });
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'newpass123' });
    expect(res.status).toBe(400);
    expect(mockSupabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a missing current_password with 400 (#4 — schema requires it)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/users/me/password').set(authHeader('admin')).send({ password: 'newpass123' });
    expect(res.status).toBe(400);
    expect(mockSupabaseAdmin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('rejects a too-short password with 400', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/users/me/password')
      .set(authHeader('admin'))
      .send({ current_password: 'oldpass123', password: 'short' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// POST /api/users/invite (email guard)
// ═══════════════════════════════════════════════════════
describe('POST /api/users/invite', () => {
  it('409s with the canonical message and does NOT call prisma.user.create when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'taken@test.com', role: 'TECHNICIAN' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});
