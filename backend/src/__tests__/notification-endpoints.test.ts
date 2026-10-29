import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// ─── Typed mock aliases ──────────────────────────────────────────────────
const findMany = prisma.notificationRecipient.findMany as ReturnType<typeof vi.fn>;
const countMock = prisma.notificationRecipient.count as ReturnType<typeof vi.fn>;
const updateMany = prisma.notificationRecipient.updateMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
});

// ─── Fixtures ────────────────────────────────────────────────────────────

const RECIPIENT_FIXTURE = {
  id: 'r1111111-0000-0000-0000-000000000001',
  notification_id: 'n0000000-0000-0000-0000-000000000001',
  organization_id: TEST_USERS.sales.organization_id,
  recipient_id: TEST_USERS.sales.id,
  priority: 'FEED',
  needs_action: true,
  seen_at: null,
  read_at: null,
  acted_at: null,
  dismissed_at: null,
  created_at: new Date('2026-06-17T10:00:00Z'),
  notification: {
    id: 'n0000000-0000-0000-0000-000000000001',
    organization_id: TEST_USERS.sales.organization_id,
    actor_id: null,
    verb: 'estimate.approved',
    category: 'ESTIMATE',
    priority: 'INTERRUPT', // event-level priority (should NOT appear in view; view uses recipient priority)
    needs_action: false,   // event-level (should NOT appear in view; view uses recipient row)
    object_type: 'Estimate',
    object_id: 'f0000000-0000-0000-0000-000000000001',
    object_label: 'E00042',
    title: 'E0042 approved',
    body: 'Your estimate has been approved.',
    data: {},
    action_type: null,
    dedup_key: null,
    group_key: null,
    created_at: new Date('2026-06-17T10:00:00Z'),
  },
};

// ─── GET /api/notifications ───────────────────────────────────────────────

describe('GET /api/notifications', () => {
  it('returns only my non-dismissed rows and maps needs_action/priority from the recipient row', async () => {
    mockAuthAs('sales');
    findMany.mockResolvedValue([RECIPIENT_FIXTURE]);

    const res = await request(app)
      .get('/api/notifications')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    // Query must filter on recipient_id (mine) and dismissed_at: null
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipient_id: TEST_USERS.sales.id,
          dismissed_at: null,
        }),
      }),
    );

    const item = res.body.items[0];
    expect(item.title).toBe('E0042 approved');
    // priority and needs_action must come from the RECIPIENT row, not the event
    expect(item.priority).toBe('FEED');        // recipient row value
    expect(item.needs_action).toBe(true);       // recipient row value
  });

  it('filters to needs_action=true + acted_at=null when ?needs_action=true', async () => {
    mockAuthAs('dispatcher');
    findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/notifications?needs_action=true')
      .set(authHeader('dispatcher'));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          needs_action: true,
          acted_at: null,
        }),
      }),
    );
  });

  it('returns nextCursor when a full page is returned', async () => {
    mockAuthAs('dispatcher');
    // Return limit+1 rows to trigger cursor generation (default limit = 25)
    const rows = Array.from({ length: 26 }, (_, i) => ({
      ...RECIPIENT_FIXTURE,
      id: `r${String(i).padStart(7, '0')}-0000-0000-0000-000000000001`,
      created_at: new Date(`2026-06-17T10:${String(i).padStart(2, '0')}:00Z`),
    }));
    findMany.mockResolvedValue(rows);

    const res = await request(app)
      .get('/api/notifications')
      .set(authHeader('dispatcher'));

    expect(res.body.items).toHaveLength(25);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('returns nextCursor=null when fewer rows than limit are returned', async () => {
    mockAuthAs('sales');
    findMany.mockResolvedValue([RECIPIENT_FIXTURE]);

    const res = await request(app)
      .get('/api/notifications')
      .set(authHeader('sales'));

    expect(res.body.nextCursor).toBeNull();
  });
});

// ─── GET /api/notifications/unread-count ─────────────────────────────────

describe('GET /api/notifications/unread-count', () => {
  it('counts unseen + needs_action with two separate count calls', async () => {
    mockAuthAs('dispatcher');
    countMock.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unseen: 3, needs_action: 1 });

    // First count = unseen (seen_at: null), second = needs_action
    expect(countMock).toHaveBeenCalledTimes(2);
    expect(countMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          recipient_id: TEST_USERS.dispatcher.id,
          dismissed_at: null,
          seen_at: null,
        }),
      }),
    );
    expect(countMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          recipient_id: TEST_USERS.dispatcher.id,
          dismissed_at: null,
          needs_action: true,
          acted_at: null,
        }),
      }),
    );
  });
});

// ─── PATCH /api/notifications/seen ───────────────────────────────────────

describe('PATCH /api/notifications/seen', () => {
  it('stamps seen_at on all unseen rows when no ids provided', async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 4 });

    const res = await request(app)
      .patch('/api/notifications/seen')
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 4 });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipient_id: TEST_USERS.sales.id,
          dismissed_at: null,
          seen_at: null,
        }),
        data: expect.objectContaining({ seen_at: expect.any(Date) }),
      }),
    );
  });

  it('scopes to provided ids when ids array is given', async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 1 });
    const id = '11111111-0000-0000-0000-000000000001';

    await request(app)
      .patch('/api/notifications/seen')
      .set(authHeader('sales'))
      .send({ ids: [id] });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [id] },
          recipient_id: TEST_USERS.sales.id,
        }),
      }),
    );
  });

  it('rejects invalid uuid in ids array → 400', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch('/api/notifications/seen')
      .set(authHeader('sales'))
      .send({ ids: ['not-a-uuid'] });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/notifications/read-all ────────────────────────────────────

describe('POST /api/notifications/read-all watermark', () => {
  it('marks all my unread rows read and scopes to recipient_id + read_at: null', async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 5 });

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 5 });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recipient_id: TEST_USERS.sales.id,
          dismissed_at: null,
          read_at: null,
        }),
        data: expect.objectContaining({ read_at: expect.any(Date) }),
      }),
    );
  });
});

// ─── PATCH /api/notifications/:id/read ───────────────────────────────────

describe('cross-user safety: PATCH /:id/read', () => {
  it("stamps read_at on own row → 200", async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/notifications/11111111-1111-1111-1111-111111111111/read')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
  });

  it("PATCH :id/read on someone else's row updates nothing (scoped updateMany) → 404", async () => {
    mockAuthAs('technician');
    updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/notifications/other-row/read')
      .set(authHeader('technician'));

    expect(res.status).toBe(404);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'other-row',
          recipient_id: TEST_USERS.technician.id,
        }),
      }),
    );
  });
});

// ─── PATCH /api/notifications/:id/act ────────────────────────────────────

describe('PATCH /:id/act', () => {
  it('stamps acted_at and read_at on own row → 200', async () => {
    mockAuthAs('dispatcher');
    updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/notifications/r1111111-0000-0000-0000-000000000001/act')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          acted_at: expect.any(Date),
          read_at: expect.any(Date),
        }),
      }),
    );
  });

  it("count 0 on someone else's row → 404", async () => {
    mockAuthAs('technician');
    updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/notifications/other-row/act')
      .set(authHeader('technician'));

    expect(res.status).toBe(404);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'other-row',
          recipient_id: TEST_USERS.technician.id,
        }),
      }),
    );
  });
});

// ─── PATCH /api/notifications/:id/dismiss ────────────────────────────────

describe('PATCH /:id/dismiss', () => {
  it('stamps dismissed_at on own row → 200', async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/notifications/r1111111-0000-0000-0000-000000000001/dismiss')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dismissed_at: expect.any(Date) }),
      }),
    );
  });

  it("count 0 on someone else's row → 404", async () => {
    mockAuthAs('sales');
    updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/notifications/other-row/dismiss')
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'other-row',
          recipient_id: TEST_USERS.sales.id,
        }),
      }),
    );
  });
});
