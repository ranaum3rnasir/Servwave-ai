/**
 * walkthrough-notify-customer.test.ts - SRVW-243
 *
 * The walkthrough half of the direct notify action. Same contract as the job
 * side (job-notify-customer.test.ts): ticking notify_customer IS the send, and
 * it replaces the matching automation dispatch for that one occurrence.
 *
 * Note `send_email` is a DIFFERENT, older flag on this endpoint - it gates the
 * whole automation block, including the internal performer notices. The two must
 * not be conflated, so the last case here pins that send_email:false still keeps
 * an explicit notify_customer honest.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID, withLeadStatusSync } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { sendWalkthroughScheduledEmail, sendWalkthroughRescheduledEmail } from '../lib/email';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const mockPrisma = prisma as any;
const mockScheduled = sendWalkthroughScheduledEmail as ReturnType<typeof vi.fn>;
const mockRescheduled = sendWalkthroughRescheduledEmail as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const TECH_ID = TEST_USERS.technician.id;
const SCHEDULED_AT = '2026-08-01T09:00:00Z';

function wireScheduleTx(updatedLead: any, currentPerformers: { user_id: string }[] = []) {
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue(currentPerformers),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      visit: { aggregate: mockPrisma.visit.aggregate,
        create: vi.fn().mockResolvedValue({ id: 'wt-new-1', visit_seq: 1 }),
        update: vi.fn().mockResolvedValue({ id: 'wt-active-1', visit_seq: 1 }),
      },
      // Spec #1751 D2: the walkthrough booking clock is a CONDITIONAL write of its own
      // (stampLeadClock -> lead.updateMany), so a double wiring only `update` 500s the door.
      lead: { update: vi.fn().mockResolvedValue(updatedLead), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    })),
  );
}

function schedule(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
    .set(authHeader('admin'))
    .send({
      walkthrough_scheduled_at: SCHEDULED_AT,
      performer_ids: [TECH_ID],
      walkthrough_duration_minutes: 60,
      ...body,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  // findActiveWalkthrough - the lead's earliest LIVE visit. Reset EXPLICITLY: clearAllMocks
  // wipes recorded calls but keeps implementations, so the one reschedule case below would
  // otherwise hand every later test a pre-existing live visit.
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.lead.findUnique.mockResolvedValue({
    ...LEAD_FIXTURE,
    status: 'CONTACTED',
    visit_assignees: [],
  });
  mockScheduled.mockResolvedValue({ status: 'sent' });
  mockRescheduled.mockResolvedValue({ status: 'sent' });
  wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });
});

describe('POST /api/leads/:id/walkthrough/schedule - notify_customer', () => {
  it('sends nothing and reports nothing when notify_customer is omitted', async () => {
    mockAuthAs('admin');

    const res = await schedule();

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
  });

  it('sends the site-visit scheduled email on a first booking', async () => {
    mockAuthAs('admin');

    const res = await schedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    const args = mockScheduled.mock.calls[0][0];
    expect(args.to).toBe(LEAD_FIXTURE.customer.email);
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.scheduledDate).toEqual(new Date(SCHEDULED_AT));
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'sent' });
  });

  it('sends the rescheduled email when an already-booked visit moves', async () => {
    mockAuthAs('admin');
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1',
      status: 'SCHEDULED',
      visit_seq: 1,
      scheduled_at: new Date('2026-07-01T09:00:00Z'),
      customer_email_sent_at: new Date('2026-07-01T00:00:00Z'),
      assignees: [{ user_id: TECH_ID }],
    });

    const res = await schedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockRescheduled.mock.calls[0][0].newDate).toEqual(new Date(SCHEDULED_AT));
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'sent' });
  });

  it('still commits the booking and 200s when the send fails', async () => {
    mockAuthAs('admin');
    mockScheduled.mockResolvedValue({ status: 'failed', error: 'provider down' });

    const res = await schedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(res.body.lead).toBeDefined();
    expect(res.body.notify).toEqual({ status: 'failed', error: 'provider down' });
  });

  it('reports a skip rather than sending when the customer has no email on file', async () => {
    mockAuthAs('admin');
    wireScheduleTx({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      customer: { ...LEAD_FIXTURE.customer, email: null },
    });

    const res = await schedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'skipped', reason: 'no_recipient' });
  });

  it('suppresses the WALKTHROUGH_SCHEDULED automation dispatch when the user notified directly', async () => {
    mockAuthAs('admin');

    await schedule({ notify_customer: true });

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('WALKTHROUGH_SCHEDULED');
    // The internal performer notice is a different audience and is NOT the
    // customer email the tick replaced - it must survive.
    expect(types).toContain('WALKTHROUGH_PERFORMER_ASSIGNED');
  });

  it('leaves the WALKTHROUGH_SCHEDULED automation dispatch alone when notify_customer is absent', async () => {
    mockAuthAs('admin');

    await schedule();

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toContain('WALKTHROUGH_SCHEDULED');
  });

  it('honours notify_customer even when send_email:false silences the automation block', async () => {
    mockAuthAs('admin');

    const res = await schedule({ notify_customer: true, send_email: false });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    expect(res.body.notify).toEqual({ status: 'sent' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  // Q1: bare `!notify_customer` was true for BOTH "not mentioned" (fire, tested above) and
  // "explicitly declined" (must NOT fire - the caller said not to tell the customer, and letting
  // the workflow do it anyway is exactly what the decline was supposed to prevent).
  it('Q1: an explicit decline (false) ALSO suppresses WALKTHROUGH_SCHEDULED, not just the direct send', async () => {
    mockAuthAs('admin');

    const res = await schedule({ notify_customer: false });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('WALKTHROUGH_SCHEDULED');
    // The performer notice is a different audience and is untouched by the customer-facing decline.
    expect(types).toContain('WALKTHROUGH_PERFORMER_ASSIGNED');
  });

  // The `hasPerformers` half of the guard is a SEPARATE, deliberate rule (the state-4
  // zero-performer schedule) and must survive this fix untouched.
  it('Q1: a zero-performer schedule still dispatches nothing customer-facing, decline or not', async () => {
    mockAuthAs('admin');

    const res = await schedule({ performer_ids: [], notify_customer: false });

    expect(res.status).toBe(200);
    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('WALKTHROUGH_SCHEDULED');
  });
});

// ─── Q1 (multi-visit close-out) - the customer_email_sent_at stamp follows the OUTCOME ──────
// The legacy door used to stamp on CREW EXISTENCE (`hasPerformers && not-yet-stamped`), decoupled
// from whether anything was actually sent. Two bugs, opposite directions: a genuinely-sent trip
// (tick, no performers - notifyCustomerOfWalkthrough does not require any) was never stamped
// because hasPerformers was false; and a trip with performers but send_email:false and no tick -
// nobody told at all - WAS stamped, because hasPerformers was true. Both are fixed by the same
// change: stamp only as the outcome of a confirmed send, exactly like POST /api/leads/:id/visits.
describe('POST /api/leads/:id/walkthrough/schedule - the customer_email_sent_at stamp (Q1)', () => {
  it('a successful send stamps the walkthrough it just booked', async () => {
    mockAuthAs('admin');

    const res = await schedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.visit.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.visit.updateMany.mock.calls[0][0];
    expect(call.where.id).toBe('wt-new-1');
    expect(call.data.customer_email_sent_at).toBeInstanceOf(Date);
  });

  it('notify omitted (automation left to fire) leaves the stamp NULL', async () => {
    mockAuthAs('admin');

    await schedule();

    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });

  it('a failed send leaves the stamp NULL', async () => {
    mockAuthAs('admin');
    mockScheduled.mockResolvedValue({ status: 'failed', error: 'provider down' });

    await schedule({ notify_customer: true });

    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });

  // The OVER-stamp direction nobody had noticed until it was pointed out: performers are present,
  // but send_email:false silences the automation block entirely and notify_customer is not ticked
  // either, so NOTHING was sent through any channel - yet the old `hasPerformers`-gated stamp
  // would have marked this trip as announced anyway.
  it('performers present but NOTHING sent (send_email:false, no tick) leaves the stamp NULL', async () => {
    mockAuthAs('admin');

    const res = await schedule({ send_email: false });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });

  it('does not re-stamp an already-announced walkthrough on a later move', async () => {
    mockAuthAs('admin');
    mockPrisma.visit.findFirst.mockResolvedValue({
      id: 'wt-active-1',
      status: 'SCHEDULED',
      visit_seq: 1,
      scheduled_at: new Date('2026-07-01T09:00:00Z'),
      customer_email_sent_at: new Date('2026-07-01T00:00:00Z'),
      assignees: [{ user_id: TECH_ID }],
    });

    await schedule({ notify_customer: true });

    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
  });
});

// ─── compose fields (To / CC / message) ──────────────────────────────────────

describe('POST /api/leads/:id/walkthrough/schedule - notify compose fields', () => {
  it('sends to the override address instead of the customer on file', async () => {
    mockAuthAs('admin');

    await schedule({ notify_customer: true, notify_recipient_email: 'office@acme.test' });

    expect(mockScheduled.mock.calls[0][0].to).toBe('office@acme.test');
  });

  it('carries cc addresses and the edited message through to the sender', async () => {
    mockAuthAs('admin');

    await schedule({
      notify_customer: true,
      notify_cc_emails: ['pm@acme.test'],
      notify_message: 'Hi John, our surveyor will be with you Friday morning.',
    });

    const args = mockScheduled.mock.calls[0][0];
    expect(args.cc).toEqual(['pm@acme.test']);
    expect(args.message).toBe('Hi John, our surveyor will be with you Friday morning.');
  });

  it('rejects an invalid recipient address rather than sending somewhere wrong', async () => {
    mockAuthAs('admin');

    const res = await schedule({ notify_customer: true, notify_recipient_email: 'nope' });

    expect(res.status).toBe(400);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('ignores the compose fields entirely when notify_customer is not set', async () => {
    mockAuthAs('admin');

    const res = await schedule({
      notify_recipient_email: 'office@acme.test',
      notify_message: 'should never be sent',
    });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
  });
});

// ─── SRVW-243 header-brand fix ──────────────────────────────────────────────
//
// Same fix as job-notify-customer.test.ts's own block: notifyCustomerOfWalkthrough already
// queried the org row for its timezone and companyName, but never carried the branding
// (logo/brand color) forward to the sender, so the walkthrough notice's header also read
// the ServWave fallback. See email-record-matches-send.test.ts for the rendering half.
describe('POST /api/leads/:id/walkthrough/schedule - notify_customer carries the org branding', () => {
  it('passes the org row (name/logo/brand color) to the sender when it loads', async () => {
    mockAuthAs('admin');
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A', timezone: 'America/New_York',
    });

    await schedule({ notify_customer: true });

    expect(mockScheduled.mock.calls[0][0].org).toEqual({
      id: ALPHA_ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A',
    });
  });

  // vi.clearAllMocks() (beforeEach) resets calls but not a prior mockResolvedValue, so this
  // stubs the miss explicitly rather than relying on running before the "loads" case above.
  it('passes org: undefined, never a guessed name, when the org row does not load', async () => {
    mockAuthAs('admin');
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    await schedule({ notify_customer: true });

    expect(mockScheduled.mock.calls[0][0].org).toBeUndefined();
  });
});
