import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as email from '../lib/email';
import { TEST_USERS, TEST_ORG, ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { isCatalogEntry } from '../lib/permissions/catalog';

// ─── Typed mock surface ────────────────────────────────
const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timeEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  geofenceConfig: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  geofenceStore: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timeClockOtReview: {
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

// A store zone in Austin, TX. The tech fixtures punch right on top of it (in-zone)
// or far away (out-of-zone) depending on the test.
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const FAR_AWAY = { lat: 40.7128, lng: -74.006 }; // NYC — ~2700km away

const STORE_ROW = {
  id: 'store-id-1',
  organization_id: ALPHA_ORG_ID,
  label: 'HQ',
  lat: AUSTIN.lat,
  lng: AUSTIN.lng,
  created_at: new Date('2026-01-01'),
};

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
  // Org timezone lookup (used by override-request email path).
  (prisma.organization.findUnique as any).mockResolvedValue({ timezone: 'America/New_York' });
  // Default: one store zone + default radius config absent (→ 150).
  (prisma.geofenceStore.findMany as any).mockResolvedValue([STORE_ROW]);
  (prisma.geofenceConfig.findUnique as any).mockResolvedValue(null);
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
        reviewed_by: null,
        reviewed_at: null,
        matched_zone_id: null,
        matched_zone_label: null,
        matched_zone_kind: null,
        matched_job_number: null,
        distance_m: null,
        accuracy_m: null,
        ...args.data,
      })
    );
  }

  it('IN inside the zone records IN_ZONE / review NONE and returns 201 with a PunchDTO', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng });

    expect(res.status).toBe(201);
    expect(res.body.punch).toMatchObject({
      type: 'IN',
      status: 'in_zone',
      review: 'none',
      matchedZoneLabel: 'HQ',
      matchedZoneKind: 'store',
    });
    expect(typeof res.body.punch.ts).toBe('number');
    // tenant-scoped + correct enum casing in the write
    const writeData = (prisma.timeEntry.create as any).mock.calls[0][0].data;
    expect(writeData.organization_id).toBe(ALPHA_ORG_ID);
    expect(writeData.status).toBe('IN_ZONE');
    expect(writeData.review).toBe('NONE');
  });

  it('OUT always records IN_ZONE / NONE even out of zone (and even while clocked in)', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    (prisma.timeEntry.findFirst as any).mockResolvedValue({ type: 'IN' }); // clocked in
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'OUT', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

    expect(res.status).toBe(201);
    const writeData = (prisma.timeEntry.create as any).mock.calls[0][0].data;
    expect(writeData.status).toBe('IN_ZONE');
    expect(writeData.review).toBe('NONE');
    expect(writeData.type).toBe('OUT');
  });

  it('IN out-of-zone, enforce on, non-admin, no override → 422 requiresOverride, records nothing', async () => {
    mockAuthAs('technician');
    setClockUser('technician');

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

    expect(res.status).toBe(422);
    expect(res.body.requiresOverride).toBe(true);
    expect(res.body.verdict).toBeTruthy();
    expect(prisma.timeEntry.create).not.toHaveBeenCalled();
  });

  it('IN out-of-zone with override:true → OVERRIDE/PENDING and emails approvers', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    (prisma.user.findMany as any).mockResolvedValue([
      { email: 'admin@test.com' },
      { email: 'lead@test.com' },
    ]);
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng, override: true });

    expect(res.status).toBe(201);
    const writeData = (prisma.timeEntry.create as any).mock.calls[0][0].data;
    expect(writeData.status).toBe('OVERRIDE');
    expect(writeData.review).toBe('PENDING');
    expect(writeData.matched_zone_id).toBeNull();
    expect(email.sendClockOverrideRequestedEmail).toHaveBeenCalledTimes(1);
    const args = (email.sendClockOverrideRequestedEmail as any).mock.calls[0][0];
    expect(args.to).toEqual(['admin@test.com', 'lead@test.com']);
  });

  it('IN admin out-of-zone bypasses geofence → records IN_ZONE', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('admin'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

    expect(res.status).toBe(201);
    expect((prisma.timeEntry.create as any).mock.calls[0][0].data.status).toBe('IN_ZONE');
  });

  it('IN with enforcement disabled out-of-zone → records IN_ZONE', async () => {
    mockAuthAs('technician');
    setClockUser('technician', { enforce_clock_in_location: false });
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng });

    expect(res.status).toBe(201);
    expect((prisma.timeEntry.create as any).mock.calls[0][0].data.status).toBe('IN_ZONE');
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
    matched_zone_id: 'store:store-id-1',
    matched_zone_label: 'HQ',
    matched_zone_kind: 'STORE',
    matched_job_number: null,
    distance_m: 5,
    status: 'IN_ZONE',
    review: 'NONE',
  };

  it('technician is forced to scope=me even when scope=org requested', async () => {
    mockAuthAs('technician');
    (prisma.timeEntry.findMany as any).mockResolvedValue([PUNCH_ROW]);

    const res = await request(app)
      .get('/api/timeclock/punches?scope=org')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const where = (prisma.timeEntry.findMany as any).mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(where.user_id).toBe(TEST_USERS.technician.id);
    expect(res.body.punches[0]).toMatchObject({ status: 'in_zone', matchedZoneKind: 'store' });
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
// Config + stores
// ═══════════════════════════════════════════════════════
describe('GET /api/timeclock/config', () => {
  it('returns defaults when no config/stores', async () => {
    mockAuthAs('technician');
    (prisma.geofenceConfig.findUnique as any).mockResolvedValue(null);
    (prisma.geofenceStore.findMany as any).mockResolvedValue([]);

    const res = await request(app).get('/api/timeclock/config').set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ radiusM: 150, stores: [] });
  });

  it('returns configured radius + stores', async () => {
    mockAuthAs('technician');
    (prisma.geofenceConfig.findUnique as any).mockResolvedValue({ radius_m: 200 });
    (prisma.geofenceStore.findMany as any).mockResolvedValue([STORE_ROW]);

    const res = await request(app).get('/api/timeclock/config').set(authHeader('technician'));
    expect(res.body.radiusM).toBe(200);
    expect(res.body.stores[0]).toMatchObject({ id: 'store-id-1', label: 'HQ', lat: AUSTIN.lat, lng: AUSTIN.lng });
  });
});

describe('PUT /api/timeclock/config', () => {
  it('non-admin → 403', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .put('/api/timeclock/config')
      .set(authHeader('technician'))
      .send({ radiusM: 200 });
    expect(res.status).toBe(403);
  });

  it('admin upserts radius', async () => {
    mockAuthAs('admin');
    (prisma.geofenceConfig.upsert as any).mockResolvedValue({ radius_m: 200 });
    const res = await request(app)
      .put('/api/timeclock/config')
      .set(authHeader('admin'))
      .send({ radiusM: 200 });
    expect(res.status).toBe(200);
    const args = (prisma.geofenceConfig.upsert as any).mock.calls[0][0];
    expect(args.where.organization_id).toBe(ALPHA_ORG_ID);
    expect(res.body.radiusM).toBe(200);
  });

  it('rejects radius out of 50-300 range', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .put('/api/timeclock/config')
      .set(authHeader('admin'))
      .send({ radiusM: 5000 });
    expect(res.status).toBe(400);
  });
});

describe('stores CRUD', () => {
  it('non-admin create → 403', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/timeclock/stores')
      .set(authHeader('technician'))
      .send({ label: 'X', lat: 1, lng: 2 });
    expect(res.status).toBe(403);
  });

  it('admin creates a store (tenant-stamped)', async () => {
    mockAuthAs('admin');
    (prisma.geofenceStore.create as any).mockResolvedValue(STORE_ROW);
    const res = await request(app)
      .post('/api/timeclock/stores')
      .set(authHeader('admin'))
      .send({ label: 'HQ', lat: AUSTIN.lat, lng: AUSTIN.lng });
    expect(res.status).toBe(201);
    expect((prisma.geofenceStore.create as any).mock.calls[0][0].data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('PATCH a store updates only tenant rows', async () => {
    mockAuthAs('admin');
    (prisma.geofenceStore.findFirst as any).mockResolvedValue(STORE_ROW);
    (prisma.geofenceStore.update as any).mockResolvedValue({ ...STORE_ROW, label: 'New' });
    const res = await request(app)
      .patch('/api/timeclock/stores/store-id-1')
      .set(authHeader('admin'))
      .send({ label: 'New' });
    expect(res.status).toBe(200);
    expect((prisma.geofenceStore.findFirst as any).mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('cross-org store → 404 on PATCH', async () => {
    mockAuthAs('admin');
    (prisma.geofenceStore.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .patch('/api/timeclock/stores/other-org-store')
      .set(authHeader('admin'))
      .send({ label: 'New' });
    expect(res.status).toBe(404);
  });

  it('DELETE store tenant-scoped; 404 when not found', async () => {
    mockAuthAs('admin');
    (prisma.geofenceStore.deleteMany as any).mockResolvedValue({ count: 0 });
    const res = await request(app)
      .delete('/api/timeclock/stores/nope')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect((prisma.geofenceStore.deleteMany as any).mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });
});

// ═══════════════════════════════════════════════════════
// User timeclock settings
// ═══════════════════════════════════════════════════════
describe('PATCH /api/timeclock/users/:id/timeclock-settings', () => {
  it('non-admin → 403', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch(`/api/timeclock/users/${TEST_USERS.technician.id}/timeclock-settings`)
      .set(authHeader('technician'))
      .send({ enforce_clock_in_location: false });
    expect(res.status).toBe(403);
  });

  it('admin updates a tenant user', async () => {
    mockAuthAs('admin');
    (prisma.user.update as any).mockResolvedValue({
      id: TEST_USERS.technician.id,
      enforce_clock_in_location: false,
      can_approve_clock_overrides: true,
    });
    // tenant guard: target must be in org
    (prisma.user.findFirst as any).mockResolvedValue({ id: TEST_USERS.technician.id });
    const res = await request(app)
      .patch(`/api/timeclock/users/${TEST_USERS.technician.id}/timeclock-settings`)
      .set(authHeader('admin'))
      .send({ enforce_clock_in_location: false, can_approve_clock_overrides: true });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════
// Override approve / reject
// ═══════════════════════════════════════════════════════
describe('override approve/reject', () => {
  const PENDING_PUNCH = {
    id: 'punch-9',
    organization_id: ALPHA_ORG_ID,
    user_id: TEST_USERS.technician.id,
    review: 'PENDING',
    user: { first_name: 'Test', last_name: 'Tech', email: 'tech@test.com' },
  };

  it('plain technician (not approver) → 403', async () => {
    mockAuthAs('technician');
    setClockUser('technician', { can_approve_clock_overrides: false });
    const res = await request(app)
      .post('/api/timeclock/punches/punch-9/override/approve')
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('admin approves: sets review APPROVED + reviewer + emails tech', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    (prisma.timeEntry.findFirst as any).mockResolvedValue(PENDING_PUNCH);
    (prisma.timeEntry.update as any).mockResolvedValue({
      ...PENDING_PUNCH,
      review: 'APPROVED',
      ts: new Date('2026-06-10T12:00:00Z'),
      type: 'IN',
      lat: 1, lng: 2, status: 'OVERRIDE',
    });
    const res = await request(app)
      .post('/api/timeclock/punches/punch-9/override/approve')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    const upd = (prisma.timeEntry.update as any).mock.calls[0][0].data;
    expect(upd.review).toBe('APPROVED');
    expect(upd.reviewed_by).toBe(TEST_USERS.admin.id);
    expect(upd.reviewed_at).toBeInstanceOf(Date);
    expect(email.sendClockOverrideDecisionEmail).toHaveBeenCalledTimes(1);
    expect((email.sendClockOverrideDecisionEmail as any).mock.calls[0][0].decision).toBe('approved');
  });

  it('can_approve user rejects', async () => {
    mockAuthAs('technician');
    setClockUser('technician', { can_approve_clock_overrides: true });
    (prisma.timeEntry.findFirst as any).mockResolvedValue(PENDING_PUNCH);
    (prisma.timeEntry.update as any).mockResolvedValue({
      ...PENDING_PUNCH, review: 'REJECTED', ts: new Date(), type: 'IN', lat: 1, lng: 2, status: 'OVERRIDE',
    });
    const res = await request(app)
      .post('/api/timeclock/punches/punch-9/override/reject')
      .set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect((prisma.timeEntry.update as any).mock.calls[0][0].data.review).toBe('REJECTED');
  });

  it('approving a non-PENDING punch → 409', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    (prisma.timeEntry.findFirst as any).mockResolvedValue({ ...PENDING_PUNCH, review: 'APPROVED' });
    const res = await request(app)
      .post('/api/timeclock/punches/punch-9/override/approve')
      .set(authHeader('admin'));
    expect(res.status).toBe(409);
  });

  it('cross-org punch → 404', async () => {
    mockAuthAs('admin');
    setClockUser('admin');
    (prisma.timeEntry.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/timeclock/punches/foreign/override/approve')
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect((prisma.timeEntry.findFirst as any).mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
  });
});

// ═══════════════════════════════════════════════════════
// OT reviews
// ═══════════════════════════════════════════════════════
describe('ot-reviews', () => {
  it('GET technician forced to me', async () => {
    mockAuthAs('technician');
    (prisma.timeClockOtReview.findMany as any).mockResolvedValue([
      { user_id: TEST_USERS.technician.id, period_key: '2026-W24', state: 'APPROVED', reviewed_by: TEST_USERS.admin.id, reviewed_at: new Date() },
    ]);
    const res = await request(app)
      .get('/api/timeclock/ot-reviews?scope=org')
      .set(authHeader('technician'));
    expect(res.status).toBe(200);
    expect((prisma.timeClockOtReview.findMany as any).mock.calls[0][0].where.user_id).toBe(TEST_USERS.technician.id);
    expect(res.body.reviews[0]).toMatchObject({ period_key: '2026-W24', state: 'APPROVED' });
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
// RBAC — timeclock admin mutations are CASL-gated (issue #236)
//
// Mutations moved off the legacy `authorize('ADMIN')` literal onto
// `canDo('update', 'Timeclock')`. ADMIN passes via `manage all`; no non-admin
// role has a Timeclock grant, so dispatcher/sales/technician still get 403 —
// behavior preserved, now visible in the Roles & Permissions UI.
// ═══════════════════════════════════════════════════════
describe('RBAC: timeclock admin mutations gated by canDo("update","Timeclock")', () => {
  it('catalog: update Timeclock IS a catalog entry; no Walkthrough subject remains', () => {
    expect(isCatalogEntry('update', 'Timeclock')).toBe(true);
    expect(isCatalogEntry('read', 'Timeclock')).toBe(true);
    // #237 — the dead 'Walkthrough' CASL subject is gone (walkthrough = Lead action).
    expect(isCatalogEntry('read', 'Walkthrough')).toBe(false);
    expect(isCatalogEntry('update', 'Walkthrough')).toBe(false);
    expect(isCatalogEntry('manage', 'Walkthrough')).toBe(false);
  });

  it('admin CAN PUT /config (not 403)', async () => {
    mockAuthAs('admin');
    (prisma.geofenceConfig.upsert as any).mockResolvedValue({ radius_m: 200 });
    const res = await request(app)
      .put('/api/timeclock/config')
      .set(authHeader('admin'))
      .send({ radiusM: 200 });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  it('admin CAN POST /stores (not 403)', async () => {
    mockAuthAs('admin');
    (prisma.geofenceStore.create as any).mockResolvedValue(STORE_ROW);
    const res = await request(app)
      .post('/api/timeclock/stores')
      .set(authHeader('admin'))
      .send({ label: 'HQ', lat: AUSTIN.lat, lng: AUSTIN.lng });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  // dispatcher / sales / technician each have no Timeclock grant → 403 on every mutation.
  for (const role of ['dispatcher', 'sales', 'technician'] as const) {
    describe(`${role} (no Timeclock grant) → 403 on mutations`, () => {
      it('PUT /config → 403', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .put('/api/timeclock/config')
          .set(authHeader(role))
          .send({ radiusM: 200 });
        expect(res.status).toBe(403);
        expect(prisma.geofenceConfig.upsert).not.toHaveBeenCalled();
      });

      it('POST /stores → 403', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .post('/api/timeclock/stores')
          .set(authHeader(role))
          .send({ label: 'X', lat: 1, lng: 2 });
        expect(res.status).toBe(403);
        expect(prisma.geofenceStore.create).not.toHaveBeenCalled();
      });

      it('PATCH /users/:id/timeclock-settings → 403', async () => {
        mockAuthAs(role);
        const res = await request(app)
          .patch(`/api/timeclock/users/${TEST_USERS.technician.id}/timeclock-settings`)
          .set(authHeader(role))
          .send({ enforce_clock_in_location: false });
        expect(res.status).toBe(403);
        expect(prisma.user.update).not.toHaveBeenCalled();
      });
    });
  }
});
