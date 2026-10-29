/**
 * job-notify-customer.test.ts - SRVW-243
 *
 * POST /api/jobs/:id/assign grows an explicit `notify_customer` flag. Ticking it
 * IS the send: the customer email goes out directly, not by asking the automation
 * engine to maybe do it later.
 *
 * The contract under test:
 *   - notify_customer omitted / false  -> nothing sends, no `notify` on the response
 *   - notify_customer: true, first schedule -> sendJobScheduledEmail
 *   - notify_customer: true, real reschedule -> sendJobRescheduledEmail
 *   - the schedule change ALWAYS commits and 200s, whatever the send does
 *   - the outcome is reported back as `notify`, never swallowed
 *   - an explicit tick suppresses the matching automation dispatch (no double-send)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { sendJobScheduledEmail, sendJobRescheduledEmail } from '../lib/email';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const mockPrisma = prisma as any;
const mockScheduled = sendJobScheduledEmail as ReturnType<typeof vi.fn>;
const mockRescheduled = sendJobRescheduledEmail as ReturnType<typeof vi.fn>;
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

const TECH_ID = TEST_USERS.technician.id;

/** A job already on the calendar, with the customer previously told. */
const SCHEDULED_JOB_FIXTURE = {
  ...JOB_FIXTURE,
  status: 'SCHEDULED' as const,
  assignees: [{ user_id: TECH_ID }],
  // S8 (RATIFIED, A5): isReschedule now reads resolveJobScheduleWindow(existing.visits) - the
  // flat scheduled_start/scheduled_end fields this fixture used to carry no longer feed it at
  // all, so a real, matching, live visit is required for "already scheduled" to resolve true.
  visits: [{
    status: 'SCHEDULED', scheduled_at: new Date('2026-06-01T09:00:00Z'), scheduled_end: new Date('2026-06-01T11:00:00Z'),
    is_all_day: false, created_at: new Date('2026-05-01T00:00:00Z'),
    assignees: [{ user_id: TECH_ID }],
  }],
  customer_scheduled_email_sent_at: new Date('2026-06-01T00:00:00Z'),
};

/**
 * The same job, but a tech is already on it. Job status is UNORDERED (Spec B1) -
 * any milestone is reachable from any other - so a job can hold a scheduled time
 * while sitting at EN_ROUTE / ON_SITE / IN_PROGRESS / COMPLETED, and the calendar
 * still shows it at that time and still lets you drag it.
 *
 * Found in prod: J00005 on Servwave Demo moved Aug 18 -> Aug 19 from the board,
 * the dialog said "Reschedule Job?", and the customer was mailed "Service
 * Scheduled: J00005" / "Your Service Has Been Scheduled" with no mention that
 * anything had moved.
 */
const IN_PROGRESS_JOB_FIXTURE = {
  ...SCHEDULED_JOB_FIXTURE,
  status: 'IN_PROGRESS' as const,
};

function wireAssignTx(updatedJob: any, currentCrew: { user_id: string }[] = []) {
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
        // Multi-visit S2: /assign now keeps the job's ONE window in step with its visit set
        // (D14's mirror runs both ways), so the transaction touches `visits` too. Empty here -
        // these jobs hold no visit yet, which is the create branch.
        visit: {
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
          aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
        },
      // Multi-visit S3: replaceJobCrew now reads the job's VISIT crew inside this same
      // transaction, so the union it writes can never evict someone off another visit. Without
      // this delegate the read throws inside the tx and the route 500s opaquely.
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        // S3: /assign now restates the named crew on the visit it booked or moved, so this
        // tx client needs the WRITE delegates too, not just the union read.
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      jobAssignee: {
        findMany: vi.fn().mockResolvedValue(currentCrew),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { update: vi.fn().mockResolvedValue(updatedJob) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      planVisit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }),
  );
}

/** A first-time schedule of the UNSCHEDULED fixture. */
function firstSchedule(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/jobs/${JOB_FIXTURE.id}/assign`)
    .set(authHeader('admin'))
    .send({
      assignee_ids: [TECH_ID],
      scheduled_start: '2026-08-01T09:00:00Z',
      scheduled_end: '2026-08-01T11:00:00Z',
      ...body,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
  mockScheduled.mockResolvedValue({ status: 'sent' });
  mockRescheduled.mockResolvedValue({ status: 'sent' });
});

describe('POST /api/jobs/:id/assign - notify_customer', () => {
  it('sends nothing and reports nothing when notify_customer is omitted', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule();

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
  });

  it('sends nothing when notify_customer is explicitly false', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({ notify_customer: false });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
    // Q1: a decline must not be quietly honoured by the direct send and then undone by the
    // automation engine mailing the customer anyway. TECH_ASSIGNED is a DIFFERENT audience (the
    // technician being crewed on, not the customer) and is correctly unconditional - only the
    // customer-facing occurrence must be gone.
    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('JOB_SCHEDULED');
  });

  it('sends the scheduled email to the customer on a first schedule', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).toHaveBeenCalledTimes(1);
    const args = mockScheduled.mock.calls[0][0];
    expect(args.to).toBe(JOB_FIXTURE.customer.email);
    expect(args.jobNumber).toBe(JOB_FIXTURE.job_number);
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.scheduledStart).toEqual(new Date('2026-08-01T09:00:00Z'));
    expect(mockRescheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'sent' });
  });

  it('sends the rescheduled email when an already-scheduled job moves', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    const res = await firstSchedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    const args = mockRescheduled.mock.calls[0][0];
    expect(args.to).toBe(JOB_FIXTURE.customer.email);
    expect(args.newScheduledStart).toEqual(new Date('2026-08-01T09:00:00Z'));
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'sent' });
  });

  it('sends the rescheduled email when a job already under way moves', async () => {
    // "Already on the calendar" is about having a TIME, not about holding one
    // particular status. Anything else mails a customer whose appointment moved
    // an email announcing it as newly booked.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(IN_PROGRESS_JOB_FIXTURE);
    wireAssignTx({ ...IN_PROGRESS_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    const res = await firstSchedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockRescheduled).toHaveBeenCalledTimes(1);
    expect(mockRescheduled.mock.calls[0][0].newScheduledStart).toEqual(
      new Date('2026-08-01T09:00:00Z'),
    );
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('still commits the reschedule and 200s when the send fails', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockScheduled.mockResolvedValue({ status: 'failed', error: 'provider down' });

    const res = await firstSchedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(res.body.notify).toEqual({ status: 'failed', error: 'provider down' });
  });

  it('reports a skip rather than sending when the customer has no email on file', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      customer: { ...JOB_FIXTURE.customer, email: null },
    });
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({ notify_customer: true });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toEqual({ status: 'skipped', reason: 'no_recipient' });
  });

  it('suppresses the JOB_SCHEDULED automation dispatch when the user notified directly', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule({ notify_customer: true });

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('JOB_SCHEDULED');
  });

  it('leaves the JOB_SCHEDULED automation dispatch alone when notify_customer is absent', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule();

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toContain('JOB_SCHEDULED');
  });

  it('suppresses the JOB_RESCHEDULED automation dispatch when the user notified directly', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    await firstSchedule({ notify_customer: true });

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('JOB_RESCHEDULED');
  });

  it('dispatches JOB_RESCHEDULED for a job already under way, not nothing', async () => {
    // The automation gate is deliberately kept in step with the customer-facing
    // send above, so it has to lose the same status coupling: an untick on a job
    // a tech has started must still be a reschedule to the engine.
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(IN_PROGRESS_JOB_FIXTURE);
    wireAssignTx({ ...IN_PROGRESS_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    await firstSchedule();

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toContain('JOB_RESCHEDULED');
  });

  // ─── Q1 (multi-visit close-out) - a decline is a decline, not "let the workflow do it" ───────
  // Bare `!notify_customer` was true for BOTH "not mentioned" (correct: fire the automation) and
  // "explicitly false" (wrong: the caller declined telling the customer, and firing the automation
  // anyway silently mails them through the workflow instead).
  it('Q1: an explicit decline (false) ALSO suppresses JOB_SCHEDULED, not just the direct send', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule({ notify_customer: false });

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('JOB_SCHEDULED');
  });

  it('Q1: an explicit decline (false) ALSO suppresses JOB_RESCHEDULED, not just the direct send', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    await firstSchedule({ notify_customer: false });

    const types = mockDispatch.mock.calls.map((c: any[]) => c[0].type);
    expect(types).not.toContain('JOB_RESCHEDULED');
  });
});

// ─── compose fields (To / CC / message) ──────────────────────────────────────
//
// Parity with the estimate send (sendEstimateSchema: recipient_email, cc_emails
// max 5, message_body max 5000), prefixed `notify_` because this endpoint's job
// is scheduling and the compose fields are a rider on it.

describe('POST /api/jobs/:id/assign - notify compose fields', () => {
  it('sends to the customer on file when no recipient override is given', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule({ notify_customer: true });

    expect(mockScheduled.mock.calls[0][0].to).toBe(JOB_FIXTURE.customer.email);
  });

  it('sends to the override address instead, without rewriting the customer record', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule({ notify_customer: true, notify_recipient_email: 'office@acme.test' });

    expect(mockScheduled.mock.calls[0][0].to).toBe('office@acme.test');
    // A one-off recipient is NOT a customer edit - same rule the estimate send holds.
    expect(mockPrisma.customer.update).not.toHaveBeenCalled();
  });

  it('carries cc addresses through to the sender', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    await firstSchedule({
      notify_customer: true,
      notify_cc_emails: ['pm@acme.test', 'owner@acme.test'],
    });

    expect(mockScheduled.mock.calls[0][0].cc).toEqual(['pm@acme.test', 'owner@acme.test']);
  });

  it('carries the edited message through to the sender', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(SCHEDULED_JOB_FIXTURE);
    wireAssignTx({ ...SCHEDULED_JOB_FIXTURE }, [{ user_id: TECH_ID }]);

    await firstSchedule({
      notify_customer: true,
      notify_message: 'Hi John, we had to move you to Friday morning. Sorry for the shuffle.',
    });

    expect(mockRescheduled.mock.calls[0][0].message).toBe(
      'Hi John, we had to move you to Friday morning. Sorry for the shuffle.',
    );
  });

  it('rejects an invalid recipient address rather than sending somewhere wrong', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({ notify_customer: true, notify_recipient_email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('rejects more than five cc addresses', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({
      notify_customer: true,
      notify_cc_emails: ['a@t.test', 'b@t.test', 'c@t.test', 'd@t.test', 'e@t.test', 'f@t.test'],
    });

    expect(res.status).toBe(400);
    expect(mockScheduled).not.toHaveBeenCalled();
  });

  it('ignores the compose fields entirely when notify_customer is not set', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({
      notify_recipient_email: 'office@acme.test',
      notify_cc_emails: ['pm@acme.test'],
      notify_message: 'should never be sent',
    });

    expect(res.status).toBe(200);
    expect(mockScheduled).not.toHaveBeenCalled();
    expect(res.body.notify).toBeUndefined();
  });

  it('still reports no_recipient when neither an override nor a customer address exists', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({
      ...JOB_FIXTURE,
      customer: { ...JOB_FIXTURE.customer, email: null },
    });
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });

    const res = await firstSchedule({ notify_customer: true, notify_message: 'hello' });

    expect(res.body.notify).toEqual({ status: 'skipped', reason: 'no_recipient' });
  });
});

// ─── SRVW-243 header-brand fix ──────────────────────────────────────────────
//
// A founder acceptance run on org "ServWave Test" got a schedule email whose HEADER read
// "ServWave" - the literal wrapHtml fallback - because notifyCustomerOfSchedule never
// loaded the org row at all, so none of the three senders it calls ever had one to pass
// along. See email-record-matches-send.test.ts for the header-rendering half of this fix;
// this pins the WIRING half - that notifyCustomerOfSchedule actually fetches and forwards it.
describe('POST /api/jobs/:id/assign - notify_customer carries the org branding', () => {
  it('passes the org row (name/logo/brand color) to the sender when it loads', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A', timezone: 'America/New_York',
    });

    await firstSchedule({ notify_customer: true });

    expect(mockScheduled.mock.calls[0][0].org).toEqual({
      id: ALPHA_ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A',
    });
  });

  // vi.clearAllMocks() (beforeEach) resets calls but not a prior mockResolvedValue, so this
  // stubs the miss explicitly rather than relying on running before the "loads" case above -
  // it must not invent a name rather than send none.
  it('passes org: undefined, never a guessed name, when the org row does not load', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue(JOB_FIXTURE);
    wireAssignTx({ ...JOB_FIXTURE, status: 'SCHEDULED' });
    mockPrisma.organization.findUnique.mockResolvedValue(null);

    await firstSchedule({ notify_customer: true });

    expect(mockScheduled.mock.calls[0][0].org).toBeUndefined();
  });
});
