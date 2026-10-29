/**
 * calendar-entry-notifications.test.ts — slice 07 (spec §5, §9 risk 3)
 *
 * THE TRAP under test: template/verb selection must be driven by a DIFF of the entry's
 * previous/next start-end and each participant's own prior-known state — NEVER by reading a
 * status value. CalendarEntry has no status column at all, so the only way this slice could
 * repeat #1550 (a moved job telling the customer it had been "scheduled") is by picking the
 * wrong branch off something else. These tests pin the branch selection directly, the same way
 * job-notify-customer.test.ts pins /assign's own scheduled-vs-rescheduled choice.
 *
 * `lib/email` is globally mocked in setup.ts (see sendCalendarEntryScheduledEmail et al there);
 * `services/notifications/notificationService` is mocked HERE, file-local, so assertions can
 * read the exact verb/entity emit() was called with without needing to also exercise
 * loadRoleHolders/filterRecipientsByAccess/realtimePublish — those belong to notificationService's
 * own test suite, not this controller's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, CUSTOMER_FIXTURE } from './helpers';
import {
  sendCalendarEntryScheduledEmail,
  sendCalendarEntryMovedEmail,
  sendCalendarEntryCancelledEmail,
} from '../lib/email';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue([]),
}));
import { emit } from '../services/notifications/notificationService';

const mockPrisma = prisma as unknown as {
  calendarEntry: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  calendarEntryParticipant: {
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  user: { findMany: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const mockScheduled = sendCalendarEntryScheduledEmail as ReturnType<typeof vi.fn>;
const mockMoved = sendCalendarEntryMovedEmail as ReturnType<typeof vi.fn>;
const mockCancelled = sendCalendarEntryCancelledEmail as ReturnType<typeof vi.fn>;
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────

const ENTRY_ID = 'ce100000-0000-0000-0000-000000000001';
const USER_PARTICIPANT_ID = TEST_USERS.sales.id;
const CUSTOMER_WITH_EMAIL_ID = CUSTOMER_FIXTURE.id;
const CUSTOMER_NO_EMAIL_ID = 'c0000000-0000-0000-0000-000000000099';

const USER_ROW = (notified: Date | null = null) =>
  ({ id: 'pr000000-0000-0000-0000-000000000001', kind: 'USER', user_id: USER_PARTICIPANT_ID, customer_id: null, notified_at: notified });
const CUSTOMER_ROW = (notified: Date | null = null) =>
  ({ id: 'pr000000-0000-0000-0000-000000000002', kind: 'CUSTOMER', user_id: null, customer_id: CUSTOMER_WITH_EMAIL_ID, notified_at: notified });
const CUSTOMER_NO_EMAIL_ROW = (notified: Date | null = null) =>
  ({ id: 'pr000000-0000-0000-0000-000000000003', kind: 'CUSTOMER', user_id: null, customer_id: CUSTOMER_NO_EMAIL_ID, notified_at: notified });

const ENTRY_FIXTURE = {
  id: ENTRY_ID,
  organization_id: ALPHA_ORG_ID,
  title: 'Meet the Smiths',
  description: 'Pre-lead walk-through',
  start: new Date('2026-09-01T09:00:00.000Z'),
  end: new Date('2026-09-01T10:00:00.000Z'),
  is_all_day: false,
  rrule: null,
  recurrence_until: null,
  created_by: TEST_USERS.dispatcher.id,
  created_at: new Date('2026-08-24T00:00:00.000Z'),
  updated_at: new Date('2026-08-24T00:00:00.000Z'),
  participants: [] as unknown[],
};

function selectFrom<T extends Record<string, unknown>>(row: T, select?: Record<string, unknown>): Partial<T> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key in row) out[key] = row[key as keyof T];
  }
  return out as Partial<T>;
}

/** Every test needs a distinct "entry as it stands before this request" — set per-test. */
let CURRENT_FIXTURE: typeof ENTRY_FIXTURE = ENTRY_FIXTURE;

beforeEach(() => {
  vi.clearAllMocks();
  CURRENT_FIXTURE = ENTRY_FIXTURE;

  mockPrisma.calendarEntry.findFirst.mockImplementation(
    ({ where, select }: { where: { id?: string; organization_id?: string }; select?: Record<string, unknown> }) => {
      if (where.id && where.id !== CURRENT_FIXTURE.id) return Promise.resolve(null);
      if (where.organization_id && where.organization_id !== ALPHA_ORG_ID) return Promise.resolve(null);
      // The controller's PRE-check call carries organization_id (existence + tenant check); its
      // POST-write refetch (inside the transaction) carries only {id}. For THAT second shape,
      // when this request actually replaced the participant set (deleteMany fired), synthesize
      // the refetched participants from whatever was just createMany'd — a stable placeholder id
      // per row is enough for notify.ts's participantKey lookups, which key on kind+user/customer
      // id, never on the participant row's own id.
      if (!where.organization_id && mockPrisma.calendarEntryParticipant.deleteMany.mock.calls.length > 0) {
        const lastCreateMany = mockPrisma.calendarEntryParticipant.createMany.mock.calls.at(-1);
        const rows = lastCreateMany
          ? (lastCreateMany[0].data as Record<string, unknown>[]).map((r, i) => ({ id: `synth-${i}`, notified_at: null, ...r }))
          : [];
        return Promise.resolve(selectFrom({ ...CURRENT_FIXTURE, participants: rows }, select));
      }
      return Promise.resolve(selectFrom(CURRENT_FIXTURE, select));
    },
  );
  mockPrisma.calendarEntry.create.mockResolvedValue({ id: ENTRY_ID });
  mockPrisma.calendarEntry.update.mockResolvedValue({ id: ENTRY_ID });
  mockPrisma.calendarEntry.delete.mockResolvedValue({ id: ENTRY_ID });
  mockPrisma.calendarEntryParticipant.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.calendarEntryParticipant.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.calendarEntryParticipant.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.organization.findUnique.mockResolvedValue({
    name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A', timezone: 'America/New_York',
  });

  const ALL_USERS = [{ id: USER_PARTICIPANT_ID, first_name: 'Sam', last_name: 'Sales', email: TEST_USERS.sales.email }];
  const ALL_CUSTOMERS = [
    { id: CUSTOMER_WITH_EMAIL_ID, company_name: null, first_name: CUSTOMER_FIXTURE.first_name, last_name: CUSTOMER_FIXTURE.last_name, customer_number: 'C00001', email: CUSTOMER_FIXTURE.email },
    { id: CUSTOMER_NO_EMAIL_ID, company_name: null, first_name: 'No', last_name: 'Email', customer_number: 'C00002', email: null },
  ];
  // validateParticipantRefs compares `rows.length` against the requested id count, so a static
  // return (ignoring `where`) breaks the moment a test needs MORE than one real customer/user to
  // exist overall — it must actually filter by the ids asked for, the way real Prisma would.
  mockPrisma.user.findMany.mockImplementation(({ where }: { where?: { id?: { in?: string[] } } } = {}) =>
    Promise.resolve(where?.id?.in ? ALL_USERS.filter((u) => where.id!.in!.includes(u.id)) : ALL_USERS));
  mockPrisma.customer.findMany.mockImplementation(({ where }: { where?: { id?: { in?: string[] } } } = {}) =>
    Promise.resolve(where?.id?.in ? ALL_CUSTOMERS.filter((c) => where.id!.in!.includes(c.id)) : ALL_CUSTOMERS));

  mockScheduled.mockResolvedValue({ status: 'sent' });
  mockMoved.mockResolvedValue({ status: 'sent' });
  mockCancelled.mockResolvedValue({ status: 'sent' });
  mockEmit.mockResolvedValue([]);
});

// ══════════════════════════════════════════════════════
// POST /api/calendar-entries — the SCHEDULED outcome
// ══════════════════════════════════════════════════════

describe('POST /api/calendar-entries — notifications', () => {
  it('notify_customer omitted → no customer email is even attempted', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_WITH_EMAIL_ID }],
      });

    expect(res.status).toBe(201);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('notify_customer: true → sendCalendarEntryScheduledEmail fires with the free-text message and Customer.email', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_WITH_EMAIL_ID }],
        notify_customer: true,
        notify_message: 'Looking forward to meeting you!',
      });

    expect(res.status).toBe(201);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockMoved).not.toHaveBeenCalled();
    expect(mockCancelled).not.toHaveBeenCalled();
    const call = mockScheduled.mock.calls[0][0];
    expect(call.to).toBe(CUSTOMER_FIXTURE.email);
    expect(call.message).toBe('Looking forward to meeting you!');
  });

  it('a customer participant with no email on file is never sent to, even with notify_customer: true', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [CUSTOMER_NO_EMAIL_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_NO_EMAIL_ID }],
        notify_customer: true,
      });

    expect(res.status).toBe(201);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('a successful send stamps notified_at on that participant row', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW()] }),
    );

    await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_WITH_EMAIL_ID }],
        notify_customer: true,
      });

    expect(mockPrisma.calendarEntryParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [CUSTOMER_ROW().id] } },
      data: { notified_at: expect.any(Date) },
    });
  });

  it('a USER participant always gets the in-app calendar_entry.scheduled notice, independent of notify_customer', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [USER_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', user_id: USER_PARTICIPANT_ID }],
        // notify_customer NOT sent — proves the in-app channel is not gated by it.
      });

    expect(res.status).toBe(201);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const call = mockEmit.mock.calls[0][0];
    expect(call.verb).toBe('calendar_entry.scheduled');
    expect(call.entity.participant_user_ids).toEqual([USER_PARTICIPANT_ID]);
  });

  // ─── Product-owner change, 2026-08-25 ────────────────────────────────────
  // "I actually wanted all participants to be notified." The notify checkbox used to govern
  // customer email only; a teammate's whole notification was the in-app notice above. The two
  // channels stay asymmetric on purpose — in-app is unconditional, email is opt-in — so these
  // pin both halves.

  it('notify_customer: true emails a USER participant as well, at their own User.email', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [USER_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', user_id: USER_PARTICIPANT_ID }],
        notify_customer: true,
        notify_message: 'Kickoff moved to the depot.',
      });

    expect(res.status).toBe(201);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockScheduled.mock.calls[0][0].to).toBe(TEST_USERS.sales.email);
    expect(mockScheduled.mock.calls[0][0].message).toBe('Kickoff moved to the depot.');
    // The greeting name comes off first/last for a teammate, not the customer-only `name`.
    expect(mockScheduled.mock.calls[0][0].customerName).toBe('Sam Sales');
    expect(res.body.notify.users[0]).toMatchObject({ user_id: USER_PARTICIPANT_ID, status: 'sent' });
    // In-app is a SEPARATE channel and still fires exactly once.
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('a user-only entry with notify_customer omitted still sends NO email — the checkbox governs both kinds', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [USER_ROW()] }),
    );

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', user_id: USER_PARTICIPANT_ID }],
      });

    expect(res.status).toBe(201);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('emit() throwing does not fail the create request (best-effort, same contract as notificationService itself)', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.calendarEntry.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...ENTRY_FIXTURE, participants: [USER_ROW()] }),
    );
    mockEmit.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .post('/api/calendar-entries')
      .set(authHeader('dispatcher'))
      .send({
        title: 'Meet the Smiths', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T10:00:00.000Z',
        participants: [{ kind: 'USER', user_id: USER_PARTICIPANT_ID }],
      });

    expect(res.status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════
// PATCH /api/calendar-entries/:id — THE TRAP: scheduled vs moved vs nothing
// ══════════════════════════════════════════════════════

describe('PATCH /api/calendar-entries/:id — notifications (diff-driven, not status-driven)', () => {
  it('description-only PATCH on a previously-notified customer participant sends NOTHING', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      participants: [CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))], // notified_at set
    };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ description: 'Updated notes', notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a time-only PATCH on a previously-notified customer participant sends MOVED, never SCHEDULED', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      participants: [CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))],
    };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T12:00:00.000Z', notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockMoved).toHaveBeenCalledTimes(1);
    expect(mockScheduled).not.toHaveBeenCalled();
    const call = mockMoved.mock.calls[0][0];
    expect(call.to).toBe(CUSTOMER_FIXTURE.email);
    expect(call.newStart).toEqual(new Date('2026-09-01T11:00:00.000Z'));
  });

  it('a customer participant ADDED in this same time-changing PATCH gets SCHEDULED, never MOVED', async () => {
    mockAuthAs('dispatcher');
    // Nobody was on the entry before this save.
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [] };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({
        start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T12:00:00.000Z',
        participants: [{ kind: 'CUSTOMER', customer_id: CUSTOMER_WITH_EMAIL_ID }],
        notify_customer: true,
      });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a customer participant who existed before but was NEVER notified gets SCHEDULED on a time-changing save, never MOVED', async () => {
    mockAuthAs('dispatcher');
    // Present before (their row already exists), but notified_at is null — nobody ever told them
    // ANY version of this entry's time, so "moved" (which presupposes a prior notice) would be
    // the #1550 lie in the other direction.
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(null)] };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T12:00:00.000Z', notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a time-unchanged PATCH sends nothing even when notify_customer: true is passed', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))] };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ title: 'Renamed', notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a USER participant present before a time change gets the in-app MOVED verb', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [USER_ROW()] };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T12:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].verb).toBe('calendar_entry.moved');
  });

  it('a description-only PATCH sends no in-app notice to an already-present USER participant', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [USER_ROW()] };

    const res = await request(app)
      .patch(`/api/calendar-entries/${ENTRY_ID}`)
      .set(authHeader('dispatcher'))
      .send({ description: 'Updated notes' });

    expect(res.status).toBe(200);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════
// DELETE /api/calendar-entries/:id — the CANCELLED outcome
// ══════════════════════════════════════════════════════

describe('DELETE /api/calendar-entries/:id — notifications', () => {
  it('defaults to emailing EVERY participant (pre-ticked, spec §5) and always notifies user participants in-app', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(), USER_ROW()] };

    const res = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(204);
    // Product-owner change, 2026-08-25 — the teammate is emailed too, not only told in-app.
    expect(mockCancelled).toHaveBeenCalledTimes(2);
    expect(mockCancelled.mock.calls.map((c) => c[0].to).sort())
      .toEqual([CUSTOMER_FIXTURE.email, TEST_USERS.sales.email].sort());
    // A staff recipient carries NO transactional record: that anchor files the mail against a
    // customer conversation, and a teammate has none to join.
    const staffCall = mockCancelled.mock.calls.find((c) => c[0].to === TEST_USERS.sales.email);
    expect(staffCall![0].record).toBeUndefined();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].verb).toBe('calendar_entry.cancelled');
  });

  it('?notify=false suppresses every cancellation email but NOT the in-app notice to users', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(), USER_ROW()] };

    const res = await request(app)
      .delete(`/api/calendar-entries/${ENTRY_ID}?notify=false`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(204);
    expect(mockCancelled).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0].verb).toBe('calendar_entry.cancelled');
  });

  it('the delete still proceeds (204) even when the notify pipeline throws — the prompt governs the email, not the delete', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW()] };
    mockCancelled.mockRejectedValueOnce(new Error('resend is down'));

    const res = await request(app).delete(`/api/calendar-entries/${ENTRY_ID}`).set(authHeader('dispatcher'));

    expect(res.status).toBe(204);
    expect(mockPrisma.calendarEntry.delete).toHaveBeenCalledWith({ where: { id: ENTRY_ID } });
  });
});

// ══════════════════════════════════════════════════════
// POST /api/calendar-entries/:id/notify-moved — slice 08's drag/resize toast confirm action
// ══════════════════════════════════════════════════════
//
// This route exists BECAUSE the drag/resize itself already saved start/end through a plain
// PATCH before the toast was ever answered (spec: "the move persists before the toast is
// answered"). By the time a test here calls it, CURRENT_FIXTURE's start/end already ARE the
// post-drag values — there is nothing left to diff. `timeChanged: true` is asserted from the
// route's own structural position (see the controller's doc comment), never re-derived here.
describe('POST /api/calendar-entries/:id/notify-moved — the drag toast confirm', () => {
  it('a previously-notified customer participant gets MOVED, and notified_at is re-stamped', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      participants: [CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))],
    };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockMoved).toHaveBeenCalledTimes(1);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockMoved.mock.calls[0][0].to).toBe(CUSTOMER_FIXTURE.email);
    expect(mockPrisma.calendarEntryParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [CUSTOMER_ROW().id] } },
      data: { notified_at: expect.any(Date) },
    });
  });

  it('a customer participant who was NEVER notified gets SCHEDULED, not MOVED (first notice, spec §5)', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(null)] };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a customer participant with no email on file is skipped, never counted as sent', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_NO_EMAIL_ROW(new Date('2026-08-20T00:00:00.000Z'))] };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockMoved).not.toHaveBeenCalled();
    expect(res.body.notify.customers[0]).toMatchObject({ status: 'no_recipient' });
  });

  it('emails a USER participant too, but never re-emits their in-app notice (the drag itself already did)', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      participants: [USER_ROW(), CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))],
    };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    // THE INVARIANT THIS TEST EXISTS FOR: a duplicate in-app notice for the user participant
    // would show up as a second emit() call. The route emails both kinds now, so it passes
    // `suppressInAppNotice: true` — this assertion is what proves that flag is actually wired,
    // and it must keep holding whatever else changes about the email channel.
    expect(mockEmit).not.toHaveBeenCalled();
    // Product-owner change, 2026-08-25 — the teammate gets the moved EMAIL, which no earlier
    // step in the drag ever sent (the PATCH carries no notify key at all).
    expect(mockMoved).toHaveBeenCalledTimes(2);
    expect(mockMoved.mock.calls.map((c) => c[0].to).sort())
      .toEqual([CUSTOMER_FIXTURE.email, TEST_USERS.sales.email].sort());
    expect(res.body.notify.users).toHaveLength(1);
    expect(res.body.notify.users[0]).toMatchObject({ user_id: USER_PARTICIPANT_ID, status: 'sent' });
  });

  it('404s for an entry outside the caller\'s org, same tenant scoping as every other route here', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = { ...ENTRY_FIXTURE, participants: [CUSTOMER_ROW(new Date())] };

    const res = await request(app)
      .post('/api/calendar-entries/ce1ffff0-0000-0000-0000-000000000000/notify-moved')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  // ─── Idempotency guard (post-QA finding) ──────────────────────────────────
  //
  // The route hardcodes `timeChanged: true` because there is no diff left to derive it from by
  // the time it runs — the drag's own PATCH already wrote the new start/end. Without a backstop,
  // a double-click on the toast, a retry, or a curl replay re-sends "your appointment moved" for
  // a move the customer already heard about. The fix: skip a customer participant whose
  // `notified_at` is already AT OR AFTER the entry's `updated_at` — they have been told about the
  // CURRENT state already.

  it('a participant already notified about the CURRENT state (notified_at >= updated_at) is skipped', async () => {
    mockAuthAs('dispatcher');
    const UPDATED_AT = new Date('2026-08-24T12:00:00.000Z');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      updated_at: UPDATED_AT,
      participants: [CUSTOMER_ROW(new Date(UPDATED_AT.getTime() + 1000))], // notified AFTER the last update
    };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockMoved).not.toHaveBeenCalled();
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockPrisma.calendarEntryParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('boundary: notified_at EXACTLY equal to updated_at is treated as already-current and skipped (>=, not >)', async () => {
    mockAuthAs('dispatcher');
    const SAME_INSTANT = new Date('2026-08-24T12:00:00.000Z');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      updated_at: SAME_INSTANT,
      participants: [CUSTOMER_ROW(new Date(SAME_INSTANT.getTime()))],
    };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('a NEVER-notified participant (notified_at null) is exempt from the idempotency filter and still gets SCHEDULED', async () => {
    mockAuthAs('dispatcher');
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      updated_at: new Date('2026-08-24T12:00:00.000Z'),
      participants: [CUSTOMER_ROW(null)],
    };

    const res = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(mockMoved).not.toHaveBeenCalled();
  });

  it('calling the route twice against an otherwise-unchanged entry sends the MOVED email only ONCE', async () => {
    mockAuthAs('dispatcher');
    const UPDATED_AT = new Date('2026-08-24T12:00:00.000Z');
    // Stale at call time: notified about an OLDER state, before the last update - eligible.
    CURRENT_FIXTURE = {
      ...ENTRY_FIXTURE,
      updated_at: UPDATED_AT,
      participants: [CUSTOMER_ROW(new Date('2026-08-20T00:00:00.000Z'))],
    };

    const res1 = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));
    expect(res1.status).toBe(200);
    expect(mockMoved).toHaveBeenCalledTimes(1);

    // The mocked Prisma client has no real write-back — `findFirst` always returns whatever
    // CURRENT_FIXTURE says, regardless of what `updateMany` was just called with. This second
    // assignment stands in for the real re-fetch a genuine second HTTP call would perform: the
    // first call's own successful send just stamped `notified_at` to a moment after
    // `updated_at`, exactly the state QA's report described as "a static, unchanged fixture"
    // producing a second send under the OLD (unguarded) code.
    CURRENT_FIXTURE = {
      ...CURRENT_FIXTURE,
      participants: [CUSTOMER_ROW(new Date(UPDATED_AT.getTime() + 1000))],
    };

    const res2 = await request(app)
      .post(`/api/calendar-entries/${ENTRY_ID}/notify-moved`)
      .set(authHeader('dispatcher'));
    expect(res2.status).toBe(200);

    // Still just the one send across both calls - the second call's participant is now
    // already-current and is skipped.
    expect(mockMoved).toHaveBeenCalledTimes(1);
  });
});
