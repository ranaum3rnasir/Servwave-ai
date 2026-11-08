/**
 * team-notifications.test.ts — Task 3.6
 *
 * TDD for emitting notifications on:
 *   1. team.ot_override_requested — timeclock OVERRIDE punch
 *   2. team.invite_accepted       — acceptInvite + googleFinalize
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import * as email from '../lib/email';
import { signInviteToken } from '../lib/invite-token';
import { TEST_USERS, TEST_ORG, ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// ─── Spy on emit ─────────────────────────────────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;
const mockSupabase = supabaseAdmin as any;

// ─── Geofence fixtures ────────────────────────────────────────────────────────

const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const FAR_AWAY = { lat: 40.7128, lng: -74.006 }; // NYC — ~2700 km away

const STORE_ROW = {
  id: 'store-id-1',
  organization_id: ALPHA_ORG_ID,
  label: 'HQ',
  lat: AUSTIN.lat,
  lng: AUSTIN.lng,
  created_at: new Date('2026-01-01'),
};

const PUNCH_ID = 'punch-uuid-1';

/** Wire prisma.timeEntry.create to return a minimal punch row */
function stampCreate() {
  mockPrisma.timeEntry.create.mockImplementation((args: any) =>
    Promise.resolve({
      id: PUNCH_ID,
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

/**
 * Wire the clock user lookup — must satisfy both authenticate (is_active, role,
 * organization_id) and the controller's own lookup (enforce_clock_in_location).
 */
function setClockUser(authKey: 'admin' | 'technician', over: Record<string, unknown> = {}) {
  const base = TEST_USERS[authKey];
  mockPrisma.user.findUnique.mockImplementation((args: any) => {
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

// ─── Invite fixtures ──────────────────────────────────────────────────────────

const INVITE_UID = '00000000-0000-0000-0000-0000000007bb';
const INVITE_EMAIL = 'newinvitee@test.com';
const INVITED_ROW = {
  id: INVITE_UID,
  email: INVITE_EMAIL,
  first_name: 'New',
  last_name: 'Invitee',
  role: 'TECHNICIAN',
  is_active: true,
  organization_id: ALPHA_ORG_ID,
  department_id: null,
  location_id: null,
  has_login: false,
  phone: null,
  phone_ext: null,
};

// ─── beforeEach ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  clearTokenCache();

  // Defaults for timeclock tests
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  mockPrisma.geofenceStore.findMany.mockResolvedValue([STORE_ROW]);
  mockPrisma.geofenceConfig.findUnique.mockResolvedValue(null);
  mockPrisma.timeEntry.findFirst.mockResolvedValue(null);
  mockPrisma.timeEntry.findMany.mockResolvedValue([]);
  mockPrisma.timeClockOtReview.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.userPermissionOverride.findMany.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// team.ot_override_requested
// ═══════════════════════════════════════════════════════════════════════════════

describe('team.ot_override_requested', () => {
  it('emits on an OVERRIDE punch with correct verb, object.type, object.id, entity.user_id, and data.punch_id', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    // Wire approver list for notifyApprovers email path
    mockPrisma.user.findMany.mockResolvedValue([{ email: 'admin@test.com' }]);
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: FAR_AWAY.lat, lng: FAR_AWAY.lng, override: true });

    expect(res.status).toBe(201);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('team.ot_override_requested');
    expect(call.object.type).toBe('TIME_ENTRY');
    expect(call.object.id).toBe(PUNCH_ID);
    expect(call.entity.user_id).toBe(TEST_USERS.technician.id);
    expect(call.data.punch_id).toBe(PUNCH_ID);
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBe(TEST_USERS.technician.id);
  });

  it('does NOT emit for a normal in-zone IN punch', async () => {
    mockAuthAs('technician');
    setClockUser('technician');
    stampCreate();

    const res = await request(app)
      .post('/api/timeclock/punches')
      .set(authHeader('technician'))
      .send({ type: 'IN', lat: AUSTIN.lat, lng: AUSTIN.lng });

    expect(res.status).toBe(201);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// team.invite_accepted — acceptInvite path
// ═══════════════════════════════════════════════════════════════════════════════

describe('team.invite_accepted via acceptInvite', () => {
  it('emits after a successful password-set with correct verb, object.type, object.id, and dedupKey', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(INVITED_ROW);
    mockSupabase.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supa-new-id' } },
      error: null,
    });
    const token = signInviteToken(INVITE_UID, INVITE_EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret99', accepted_terms: true });

    expect(res.status).toBe(200);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('team.invite_accepted');
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(INVITE_UID);
    expect(call.dedupKey).toBe(`team.invite_accepted:${INVITE_UID}`);
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBe(INVITE_UID);
    expect(call.data.object_label).toBe('New Invitee');
  });

  it('does NOT emit when the invite token is invalid', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token: 'bad-token', password: 'sup3rsecret99' });

    expect(res.status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// team.invite_accepted — googleFinalize path
// ═══════════════════════════════════════════════════════════════════════════════

describe('team.invite_accepted via googleFinalize', () => {
  it('emits after a successful Google finalize with correct verb, object.type, object.id, and dedupKey', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: INVITE_UID, email: INVITE_EMAIL } },
      error: null,
    });
    // resolveAppUser lookups (by id, by email) + mfa check
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      if (args.select && 'mfa_email_enrolled' in args.select) {
        return Promise.resolve({ mfa_email_enrolled: false });
      }
      return Promise.resolve(INVITED_ROW);
    });
    mockPrisma.rolePermission.findMany.mockResolvedValue([]);
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('team.invite_accepted');
    expect(call.object.type).toBe('USER');
    expect(call.object.id).toBe(INVITE_UID);
    expect(call.dedupKey).toBe(`team.invite_accepted:${INVITE_UID}`);
    expect(call.organizationId).toBe(ALPHA_ORG_ID);
    expect(call.actorId).toBe(INVITE_UID);
    expect(call.data.object_label).toBe('New Invitee');
  });

  it('does NOT emit for a RETURNING user (has_login already true)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: INVITE_UID, email: INVITE_EMAIL } },
      error: null,
    });
    // Returning user: has_login = true
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      if (args.select && 'mfa_email_enrolled' in args.select) {
        return Promise.resolve({ mfa_email_enrolled: false });
      }
      return Promise.resolve({ ...INVITED_ROW, has_login: true });
    });
    mockPrisma.rolePermission.findMany.mockResolvedValue([]);
    mockPrisma.userPermissionOverride.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('does NOT emit when the Google user is unauthorized (not in DB)', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'unknown-id', email: 'ghost@test.com' } },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockSupabase.auth.admin.deleteUser.mockResolvedValue({ error: null });

    const res = await request(app)
      .post('/api/auth/google/finalize')
      .set('Authorization', 'Bearer google-token');

    expect(res.status).toBe(403);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
