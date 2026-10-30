import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, TEST_ORG, ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Typed mock surface ────────────────────────────────
const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timeEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  timeClockOtReview: {
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

// Where the tech fixtures punch from: a spot in Austin, TX, and one far away in NYC (~2700km). Nothing checks it,
// the point is that both are recorded the same way.
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const FAR_AWAY = { lat: 40.7128, lng: -74.006 };

/**
 * Build a single prisma.user.findUnique implementation that returns an
 * auth-complete + timeclock-complete user for ANY select. authenticate's lookup
 * (needs is_active/role/organization_id) and the controller's lookup (needs
 * enforce_clock_in_location / can_approve_clock_overrides) both resolve from it.
 */
function setClockUser(authKey: 'admin' | 'technician', over: Record<string, unknown> = {}) {
  const base = TEST_USERS[authKey];
  (prisma.user.findUnique as any).mockImplementation((args: any) => {
    const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
    if (!match) return Promise.resolve(null);
    return Promise.resolve({
      ...match,
      enforce_clock_in_location: true,
      can_approve_clock_overrides: false,
      organization: TEST_ORG,
      ...(match.id === base.id ? over : {}),
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  // Default: no prior punches.
  (prisma.timeEntry.findFirst as any).mockResolvedValue(null);
  (prisma.timeEntry.findMany as any).mockResolvedValue([]);
  (prisma.timeClockOtReview.findMany as any).mockResolvedValue([]);
  (prisma.user.findMany as any).mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════
// POST /api/timeclock/punches
// ═══════════════════════════════════════════════════════
describe('POST /api/timeclock/punches', () => {
  function stampCreate() {
    (prisma.timeEntry.create as any).mockImplementation((args: any) =>
      Promise.resolve({
        id: 'punch-1',
        user_id: TEST_USERS.technician.id,
        user: { first_name: 'Test', last_name: 'Tech' },
        created_at: new Date('2026-06-10T12:00:00Z'),
        accuracy_m: null,
        ...args.data,
      })
    );
  }

  it('IN records where it happened and returns 201 with a PunchDTO', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng, accuracy_m: 8 });

    expect(res.status).toBe(201);
    expect(res.body.punch).toMatchObject({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng, accuracyM: 8 });
    expect(typeof res.body.punch.ts).toBe('number');
    // tenant-scoped write
    const writeData = (prisma.timeEntry.create as any).mock.calls[0][0].data;
    expect(writeData.organization_id).toBe(ALPHA_ORG_ID);
    expect(writeData.user_id).toBe(TEST_USERS.technician.id);
    expect(writeData.lat).toBe(AUSTIN.lat);
    expect(writeData.lng).toBe(AUSTIN.lng);
  });

  it('IN and OUT far from anywhere are recorded the same way, with no block and no override request', async () => {
    mockAuthAs('technician');
    setClockUser('technician', { enforce_clock_in_location: true });
    stampCreate();

    const clockIn = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });
    expect(clockIn.status).toBe(201);
    expect(clockIn.body.requiresOverride).toBeUndefined();

    (prisma.timeEntry.findFirst as any).mockResolvedValue({ type: 'IN' }); // now clocked in
    const clockOut = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'OUT', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });
    expect(clockOut.status).toBe(201);
    expect((prisma.timeEntry.create as any).mock.calls.map((c: any) => c[0].data.type)).toEqual(['IN', 'OUT']);
  });

  it('double IN (already clocked in) → 409 Already clocked in', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    (prisma.timeEntry.findFirst as any).mockResolvedValue({ type: 'IN' });

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Already clocked in');
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('OUT without an open IN → 409 Not clocked in', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    (prisma.timeEntry.findFirst as any).mockResolvedValue(null); // never clocked in

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'OUT', lat: AUSTIN.lat, lng: AUSTIN.lng });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Not clocked in');
  });
});

// ═══════════════════════════════════════════════════════
// GET /api/timeclock/punches
// ═══════════════════════════════════════════════════════
describe('GET /api/timeclock/punches', () => {
  const PUNCH_ROW = {
    id: 'punch-1',
    user_id: TEST_USERS.technician.id,
    user: { first_name: 'Test', last_name: 'Tech' },
    type: 'IN',
    ts: new Date('2026-06-10T12:00:00Z'),
    lat: AUSTIN.lat,
    lng: AUSTIN.lng,
    accuracy_m: 10,
  };

  it('a technician asking for scope=org is refused (no See everyone\'s timesheets) and nothing is read', async () => {
    mockAuthAs('technician');
    (prisma.timeEntry.findMany as any).mockResolvedValue([PUNCH_ROW]);

    const res = await request(app)
      .get('/api/timeclock/punches?scope=org')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it('a technician sees their own punches, with where each happened', async () => {
    mockAuthAs('technician');
    (prisma.timeEntry.findMany as any).mockResolvedValue([PUNCH_ROW]);

    const res = await request(app)
      .get('/api/timeclock/punches')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const where = (prisma.timeEntry.findMany as any).mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.user_id).toBe(TEST_USERS.technician.id);
    expect(res.body.punches[0]).toMatchObject({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng, accuracyM: 10 });
  });

  it('a dispatcher on the built-in role sees everyone through the preset, a salesperson does not', async () => {
    mockAuthAs('dispatcher');
    (prisma.timeEntry.findMany as any).mockResolvedValue([PUNCH_ROW]);
    const dispatcher = await request(app).get('/api/timeclock/punches?scope=org').set(authHeader('dispatcher'));
    expect(dispatcher.status).toBe(200);
    expect((prisma.timeEntry.findMany as any).mock.calls[0][0].where.user_id).toBeUndefined();

    mockAuthAs('sales');
    const sales = await request(app).get('/api/timeclock/punches?scope=org').set(authHeader('sales'));
    expect(sales.status).toBe(403);
  });

  it('admin scope=org returns all org rows (no user_id filter)', async () => {
    mockAuthAs('admin');
    (prisma.timeEntry.findMany as any).mockResolvedValue([PUNCH_ROW]);

    const res = await request(app)
      .get('/api/timeclock/punches?scope=org')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const where = (prisma.timeEntry.findMany as any).mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.user_id).toBeUndefined();
  });

  it('admin scope=me filters to own user_id', async () => {
    mockAuthAs('admin');
    (prisma.timeEntry.findMany as any).mockResolvedValue([]);
    await request(app).get('/api/timeclock/punches?scope=me').set(authHeader('admin'));
    const where = (prisma.timeEntry.findMany as any).mock.calls[0][0].where;
    expect(where.user_id).toBe(TEST_USERS.admin.id);
  });

  it('from/to filter the ts range', async () => {
    mockAuthAs('admin');
    (prisma.timeEntry.findMany as any).mockResolvedValue([]);
    await request(app)
      .get('/api/timeclock/punches?from=2026-06-01T00:00:00Z&to=2026-06-30T00:00:00Z')
      .set(authHeader('admin'));
    const where = (prisma.timeEntry.findMany as any).mock.calls[0][0].where;
    expect(where.ts.gte).toBeInstanceOf(Date);
    expect(where.ts.lte).toBeInstanceOf(Date);
  });

  it('an invalid from date → 400 (no query against the DB)', async () => {
    mockAuthAs('admin');
    (prisma.timeEntry.findMany as any).mockResolvedValue([]);
    const res = await request(app)
      .get('/api/timeclock/punches?from=garbage')
      .set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid from/to date');
    expect(prisma.timeEntry.findMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// OT reviews
// ═══════════════════════════════════════════════════════
describe('ot-reviews', () => {
  it('GET gives a technician their own reviews', async () => {
    mockAuthAs('technician');
    (prisma.timeClockOtReview.findMany as any).mockResolvedValue([
      { user_id: TEST_USERS.technician.id, period_key: '2026-W24', state: 'APPROVED', reviewed_by: TEST_USERS.admin.id, reviewed_at: new Date() },
    ]);
    const res = await request(app)
      .get('/api/timeclock/ot-reviews')
      .set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect((prisma.timeClockOtReview.findMany as any).mock.calls[0][0].where.user_id).toBe(TEST_USERS.technician.id);
    expect(res.body.reviews[0]).toMatchObject({ period_key: '2026-W24', state: 'APPROVED' });
  });

  it('GET with scope=org is refused for a technician (no See everyone\'s timesheets) and nothing is read', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .get('/api/timeclock/ot-reviews?scope=org')
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(prisma.timeClockOtReview.findMany).not.toHaveBeenCalled();
  });

  it('POST requires approver → 403 for plain technician', async () => {
    mockAuthAs('technician');
    setClockUser('technician', { can_approve_clock_overrides: false });
    const res = await request(app)
      .post('/api/timeclock/ot-reviews')
      .set(authHeader('technician'))
      .send({ user_id: TEST_USERS.technician.id, period_key: '2026-W24', state: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  it('POST upserts on (org,user,period) for an approver', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    // target user is in the caller's org
    (prisma.user.findFirst as any).mockResolvedValue({ id: TEST_USERS.technician.id });
    (prisma.timeClockOtReview.upsert as any).mockResolvedValue({
      user_id: TEST_USERS.technician.id, period_key: '2026-W24', state: 'APPROVED', reviewed_by: TEST_USERS.admin.id, reviewed_at: new Date(),
    });
    const res = await request(app)
      .post('/api/timeclock/ot-reviews')
      .set(authHeader('admin'))
      .send({ user_id: TEST_USERS.technician.id, period_key: '2026-W24', state: 'APPROVED' });
    expect(res.status).toBe(200);
    const args = (prisma.timeClockOtReview.upsert as any).mock.calls[0][0];
    expect(args.where.organization_id_user_id_period_key.organization_id).toBe(ALPHA_ORG_ID);
    expect(args.create.reviewed_by).toBe(TEST_USERS.admin.id);
    // tenant guard ran against the org
    expect((prisma.user.findFirst as any).mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('POST with a user_id from another org → 404 and writes nothing', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    // target user not found in the caller's org (foreign-org user_id)
    (prisma.user.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/timeclock/ot-reviews')
      .set(authHeader('admin'))
      .send({ user_id: 'foreign-org-user', period_key: '2026-W24', state: 'APPROVED' });
    expect(res.status).toBe(404);
    expect(prisma.timeClockOtReview.upsert).not.toHaveBeenCalled();
    expect((prisma.user.findFirst as any).mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });
});

// ═══════════════════════════════════════════════════════
// The location endpoints are gone (S01.13): not found, for every person
// ═══════════════════════════════════════════════════════
describe('radius, work-zone, per-user location and override endpoints', () => {
  for (const role of ['admin', 'dispatcher', 'sales', 'technician'] as const) {
    it(`answer 404 to ${role}`, async () => {
      mockAuthAs(role);
      const id = TEST_USERS.technician.id;
      const calls = [
        request(app).get('/api/timeclock/config').set(authHeader(role)),
        request(app).put('/api/timeclock/config').set(authHeader(role)).send({ radiusM: 200 }),
        request(app).post('/api/timeclock/stores').set(authHeader(role)).send({ label: 'X', lat: 1, lng: 2 }),
        request(app).patch(`/api/timeclock/stores/${id}`).set(authHeader(role)).send({ label: 'Y' }),
        request(app).delete(`/api/timeclock/stores/${id}`).set(authHeader(role)),
        request(app).patch(`/api/timeclock/users/${id}/timeclock-settings`).set(authHeader(role)).send({ enforce_clock_in_location: false }),
        request(app).post(`/api/timeclock/punches/${id}/override/approve`).set(authHeader(role)),
        request(app).post(`/api/timeclock/punches/${id}/override/reject`).set(authHeader(role)),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(404);
    });
  }
});
