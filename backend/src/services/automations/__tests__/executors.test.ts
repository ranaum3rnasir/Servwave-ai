import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { executeAction, type ExecutionBundle } from '../executors';
import { renderTemplate, isKnownVerb, VERB_RULES } from '../../notifications/templates';
import { sendAutomationEmail } from '../../../lib/email';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import * as ctmClient from '../../../lib/ctm/client';
import { _resetCtmSmsDoubleFireGuard } from '../../../lib/ctm/sendSms';

vi.mock('../../notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../../notifications/notificationService';

const mockPrisma = prisma as any;
const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockSendEmail = sendAutomationEmail as ReturnType<typeof vi.fn>;
const mockCtmClient = ctmClient as any;

const ORG = '00000000-0000-0000-0000-000000000001';

function bundle(overrides: Partial<ExecutionBundle> = {}): ExecutionBundle {
  return {
    entityRef: { type: 'job', id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    organizationId: ORG,
    org: { name: 'Blue Ridge Plumbing', timezone: 'America/New_York' },
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    assignees: [
      { id: 'u0000000-0000-0000-0000-00000000000a', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres', phone: '+15559990001' },
    ],
    // Only a task has watchers; a job bundle's list is structurally empty.
    watchers: [],
    mergeCtx: { 'customer.first_name': 'Sarah', 'org.name': 'Blue Ridge Plumbing' },
    jobRef: { id: 'b0000000-0000-0000-0000-000000000001', label: 'J00042' },
    dedupeKey: 'TECH_ASSIGNED:b0000000-0000-0000-0000-000000000001:u-a',
    ...overrides,
  };
}

function rule(action_type: string, action_config: Record<string, unknown>) {
  return {
    id: 'a0000000-0000-0000-0000-0000000000aa',
    name: 'My automation',
    action_type,
    action_config,
    organization_id: ORG,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeAction — SEND_EMAIL', () => {
  it('renders merge fields and emails the customer', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 'Hi {{customer.first_name}}', body: 'From {{org.name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(res.recipientSummary).toBe('sarah@example.com');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const args = mockSendEmail.mock.calls[0][0];
    expect(args.to).toBe('sarah@example.com');
    expect(args.subject).toBe('Hi Sarah');
    expect(args.text).toContain('From Blue Ridge Plumbing');
  });

  it('escapes the ENTIRE body in the HTML part — staff literals AND merge values', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', {
        recipient: 'customer',
        subject: 's',
        body: 'Book before <May 1> for {{customer.first_name}}',
      }),
      bundle({
        customer: { id: 'c1', first_name: '<b>Sarah</b>', last_name: null, email: 'sarah@example.com', phone: null },
        mergeCtx: { 'customer.first_name': '<b>Sarah</b>' },
      }),
    );
    expect(res.status).toBe('SENT');
    const html = mockSendEmail.mock.calls[0][0].html as string;
    // staff-authored angle brackets must not become tags…
    expect(html).toContain('Book before &lt;May 1&gt;');
    // …and the customer-controlled merge value must be escaped too
    expect(html).toContain('&lt;b&gt;Sarah&lt;/b&gt;');
    expect(html).not.toContain('<b>Sarah</b>');
    // the plain-text part stays raw
    expect(mockSendEmail.mock.calls[0][0].text).toContain('Book before <May 1>');
  });

  // The bundle -> AudienceContext hop rebuilds the customer object field by field, so
  // it is the seam where opted-in extra addresses are easiest to silently drop.
  it('emails the customer AND their opted-in extra addresses', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle({
        customer: {
          id: 'c1',
          first_name: 'Sarah',
          last_name: null,
          email: 'sarah@example.com',
          phone: null,
          extra_emails: [{ email: 'ops@example.com' }],
        },
      }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual([
      'sarah@example.com',
      'ops@example.com',
    ]);
  });

  it('skips with a plain-English reason when the customer has no email', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no email/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends to a custom address', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'custom', custom_email: 'office@org.com', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('office@org.com');
  });

  it('emails every active dispatcher for all_dispatchers', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'u1', email: 'd1@org.com', first_name: 'D', last_name: 'One' },
      { id: 'u2', email: 'd2@org.com', first_name: 'D', last_name: 'Two' },
    ]);
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'all_dispatchers', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockPrisma.user.findMany.mock.calls[0][0]).toMatchObject({
      where: { organization_id: ORG, role: 'DISPATCHER', is_active: true },
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(res.recipientSummary).toBe('d1@org.com, d2@org.com');
  });

  it('emails assigned technicians', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'assigned_techs', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('mike@org.com');
  });

  /**
   * A fan-out is still ONE SEND PER ADDRESS, and this is what is left of the test that used
   * to prove it by giving each teammate their own name in the greeting.
   *
   * The names are gone (`{{recipient.first_name}}` was removed on 2026-09-15 - see `BASE` in
   * catalog.ts) but the addressing is not, and the addressing is the part that was always
   * load-bearing: one message, one recipient, one attribution. Asserting the BODIES as well as
   * the addresses is deliberate - it is what would catch a "no longer varies, so send once to
   * everybody" optimisation that quietly turned a fan-out into a shared To: line.
   */
  it('sends one email per resolved address, each carrying the same body', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'u1', email: 'd1@org.com', first_name: 'Dana', last_name: 'One' },
      { id: 'u2', email: 'd2@org.com', first_name: 'Priya', last_name: 'Two' },
    ]);
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'all_dispatchers', subject: 's', body: 'A note from {{org.name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const byTo = Object.fromEntries(mockSendEmail.mock.calls.map((c) => [c[0].to, c[0].text]));
    expect(Object.keys(byTo).sort()).toEqual(['d1@org.com', 'd2@org.com']);
    expect(byTo['d1@org.com']).toBe('A note from Blue Ridge Plumbing');
    expect(byTo['d2@org.com']).toBe('A note from Blue Ridge Plumbing');
  });

  /**
   * THE REASON THE REMOVAL OWED A DATA MIGRATION, asserted rather than described.
   *
   * `renderMergeFields` leaves an UNKNOWN field literal by design (it is what stops
   * {{constructor}} resolving to a function), so a body still carrying the retired token does
   * not degrade politely - it mails the raw braces to a real person. Every organisation had
   * nine seeded bodies containing it, which is what
   * 20260915170000_drop_recipient_first_name_from_saved_copy rewrites.
   *
   * Kept as a live assertion because it is the thing a future re-introduction would silently
   * rely on: anybody who puts the token back into a template without putting the value back
   * into the context gets this exact output, and this test names it.
   */
  it('leaves a body that still carries the retired recipient token as raw braces', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'Hi {{recipient.first_name}}, see you soon' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('Hi {{recipient.first_name}}, see you soon');
  });

  it('greets a customer through {{customer.first_name}}, which is the field that survived', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'Hi {{customer.first_name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('Hi Sarah');
  });

  // Phase 3 cutover: {{event.reason}} is request-time text (req.body.cancelled_reason)
  // carried on event_payload.mergeFields rather than a live DB column — the single most
  // likely place this migration silently degrades. Proves it end to end through the REAL
  // registry body (not a synthetic one) with a reason actually present in mergeCtx.
  it('default-walkthrough-cancelled renders the real cancellation reason from event.reason', async () => {
    const def = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-walkthrough-cancelled')!;
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: def.recipients, subject: def.subject, body: def.body }),
      bundle({
        mergeCtx: {
          'customer.first_name': 'Sarah',
          'customer.full_name': 'Sarah Mitchell',
          'lead.number': 'L00042',
          'event.reason': 'Customer had a scheduling conflict',
        },
      }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toContain('Customer had a scheduling conflict');
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('{{event.reason}}');
  });
});

// A suppressed or failed send must not be indistinguishable from a real one - the
// Activity tab is the only place an admin can see what an unattended automation
// actually did. Verified live on staging: with email_sending_enabled=false the
// step run still read SENT (see md_files/plans/automations/2026-07-30-task-112-step-run-send-honesty.md).
describe('executeAction - SEND_EMAIL dispatch outcomes (send-run honesty)', () => {
  it('org kill switch (org_disabled) on the only recipient → SKIPPED, not SENT', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('Email sending is turned off for this organization');
  });

  it('missing provider key (no_api_key) on the only recipient → SKIPPED with a distinct, non-admin-actionable reason', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'no_api_key' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SKIPPED');
    // Distinct copy from the kill switch, and must not imply the org admin can fix it.
    expect(res.detail).not.toBe('Email sending is turned off for this organization');
    expect(res.detail).not.toMatch(/turn(ed)? on|admin|toggle|setting/i);
  });

  it('provider rejection on the only recipient → FAILED, detail carries the provider error', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'failed', error: 'Invalid `to` field' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('FAILED');
    expect(res.detail).toContain('Invalid `to` field');
  });

  it('two recipients, one sent + one provider-rejected → SENT overall, detail names the failed address', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ status: 'sent' })
      .mockResolvedValueOnce({ status: 'failed', error: 'blocked' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: { id: 'u2', email: 'sales@org.com', first_name: 'Sam', last_name: 'Lee', phone: '+15559990013' } }),
    );
    expect(res.status).toBe('SENT');
    expect(res.detail).toContain('sales@org.com');
    expect(res.detail).toContain('blocked');
  });

  it('every recipient suppressed by the kill switch → SKIPPED, never SENT', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' })
      .mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: { id: 'u2', email: 'sales@org.com', first_name: 'Sam', last_name: 'Lee', phone: '+15559990013' } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });
});

describe('executeAction — SEND_SMS', () => {
  it('records the text in the customer SMS thread with the automated flag + job stamp, even while delivery is gated off', async () => {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce(null);
    mockPrisma.messageThread.create.mockResolvedValueOnce({ id: 'thread-1', customer_id: 'c0000000-0000-0000-0000-000000000001' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });

    const res = await executeAction(
      rule('SEND_SMS', { recipient: 'customer', body: 'Hi {{customer.first_name}}' }),
      bundle(),
    );

    // The record is still written (Communication tab shows it), but nothing
    // left the building — the setup.ts global default is CTM-unconnected, so
    // this must not read SENT (the honesty defect this slice fixes).
    expect(res.status).toBe('SKIPPED');
    const msg = mockPrisma.message.create.mock.calls[0][0].data;
    expect(msg).toMatchObject({
      thread_id: 'thread-1',
      direction: 'out',
      body: 'Hi Sarah',
      automated: true,
      job_id: 'b0000000-0000-0000-0000-000000000001',
      job_label: 'J00042',
      organization_id: ORG,
    });
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalled();
  });

  it('reuses an existing sms thread', async () => {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce({ id: 'thread-9', customer_id: 'c1' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });
    await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'x y z' }), bundle());
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
  });

  it('skips when the customer has no phone number', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipient: 'customer', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: 'e@x.com', phone: null } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no.*phone/i);
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });
});

// A suppressed, gated, or failed SMS delivery must not be indistinguishable
// from a real one — same defect class as #1068 (send-run honesty), now for
// SEND_SMS. mockConnectedSmsOrg() wires a fully connected+ready+entitled org
// so `deliverViaCtm` reaches the real sendCtmSms gates.
describe('executeAction — SEND_SMS dispatch outcomes (send-run honesty)', () => {
  beforeEach(() => {
    // mockReturnValue survives vi.clearAllMocks() (that only clears call
    // history) — reset explicitly so a prior test's "connected" override
    // never leaks into a test relying on the disconnected default.
    mockCtmClient.isCtmConfigured.mockReturnValue(false);
    // Every test in this block reuses the same org/thread/body — reset the
    // module-level double-fire guard or a later test reads DUPLICATE_SEND.
    _resetCtmSmsDoubleFireGuard();
  });

  function mockConnectedSmsOrg() {
    mockCtmClient.isCtmConfigured.mockReturnValue(true);
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });
    mockPrisma.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
    mockPrisma.customer.findFirst.mockResolvedValue({ phone: '+15551234567' });
    mockCtmClient.isOptedOut.mockResolvedValue(false);
    mockPrisma.auditLog.create.mockResolvedValue({});
  }

  function mockSmsRecordWrites() {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce({ id: 'thread-1', customer_id: 'c0000000-0000-0000-0000-000000000001' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });
  }

  it('delivered: true → SENT', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.sendSms.mockResolvedValue({ id: 'MSG123' });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SENT');
    expect(res.recipientSummary).toBe('+15551234567');
  });

  it('org kill switch (ORG_SMS_DISABLED) → SKIPPED, not SENT', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: false,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('Text messaging is turned off for this organization');
  });

  it('not entitled to phone (NOT_ENTITLED) → SKIPPED with a distinct, non-admin-actionable reason', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: 'STARTER',
      trial_ends_at: null,
      feature_overrides: {},
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).not.toBe('Text messaging is turned off for this organization');
  });

  it('recipient opted out (RECIPIENT_OPTED_OUT) → SKIPPED, a compliance outcome, not a defect', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.isOptedOut.mockResolvedValue(true);

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/opted out/i);
  });

  it('A2P pending (SMS_NOT_READY) → SKIPPED', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockPrisma.organization.findUnique.mockResolvedValue({
      ctm_account_id: '500001',
      ctm_sms_ready: false,
      sms_sending_enabled: true,
      plan: 'PRO',
      trial_ends_at: null,
      feature_overrides: { phone: true },
    });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
  });

  it('provider rejection (CTM_ERROR) → FAILED, not SENT and not silently SKIPPED', async () => {
    mockSmsRecordWrites();
    mockConnectedSmsOrg();
    mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));
    mockPrisma.message.update.mockResolvedValue({ id: 'msg-1' });

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('FAILED');
  });

  it('not connected at all (NOT_CONNECTED — the common default, CTM never wired for this org) → SKIPPED, not SENT', async () => {
    mockSmsRecordWrites();
    // No mockConnectedSmsOrg(): global setup.ts default is CTM-unconfigured.

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(mockCtmClient.sendSms).not.toHaveBeenCalled();
  });
});

// Two team members, shared by the audience-union cases below.
const uA = { id: 'ua', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee', phone: '+15559990010' };
const uB = { id: 'ub', email: 'bob@org.com', first_name: 'Bob', last_name: 'Fox', phone: '+15559990011' };

// ── the retired in-app action ─────────────────────────────────────────────────
// Spec A slice 4 deleted notifyTeamAction and its executeAction case: the bell is
// hardcoded and the Automation Center owns email and text. The engine intercepts a
// legacy in-app step before dispatch (enrollment.ts), so nothing reaches here in
// practice; these pin that even a direct call cannot notify in-app. They replace
// the SENT-asserting NOTIFY_TEAM describes this file used to carry.
describe('executeAction - the retired in-app action', () => {
  it('emits no notification and reports SKIPPED rather than SENT', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipient: 'assigned_techs', body: 'Job for {{customer.first_name}}' }),
      bundle(),
    );
    expect(res.status).toBe('SKIPPED');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits nothing even when a full audience resolves', async () => {
    const res = await executeAction(
      rule('NOTIFY_TEAM', { recipients: ['assigned_team', 'dispatcher'], body: 'Heads up' }),
      bundle({ assignees: [uA, uB], dispatcher: uA }),
    );
    expect(res.status).not.toBe('SENT');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ── what must NOT die with the in-app action ──────────────────────────────────
// notifyTeamAction and the Test dialog's send-to-me receipt shared the
// automation.message verb, and only one of them was dying. Asserted here, next to
// the deletion, so a future tidy-up of "the unused automation verb" fails loudly.
// The resolver half of the same guard is in resolveRecipients.test.ts.
describe('automation.message outlives the in-app action', () => {
  it('is still a registered verb, still renders, and is still classified self', () => {
    expect(isKnownVerb('automation.message')).toBe(true);
    const t = renderTemplate('automation.message', {
      title: 'My automation',
      body: 'Heads up',
      object_type: 'AUTOMATION',
    });
    expect(t).toMatchObject({ category: 'TEAM', priority: 'INTERRUPT', object_type: 'AUTOMATION' });
    expect(t.title).toBe('My automation');
    expect(VERB_RULES['automation.message'].family).toBe('self');
  });
});

describe('executeAction — SEND_EMAIL union + dedupe + partial skip', () => {
  it('unions customer email + team emails and dedupes case-insensitively → one send per address', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'custom'], custom_emails: ['SARAH@example.com'], subject: 's', body: 'b' }),
      bundle(), // customer email = sarah@example.com
    );
    expect(res.status).toBe('SENT');
    // sarah@example.com and SARAH@example.com are the same address — send ONCE.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('partial skip: [customer, salesperson] with no salesperson → SENT to the customer, detail notes the skip', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({ salesperson: null }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('sarah@example.com');
    expect(res.detail).toMatch(/salesperson/i);
  });

  it('empty union → SKIPPED with joined reasons and ZERO sends (never emails nobody)', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'salesperson'], subject: 's', body: 'b' }),
      bundle({
        customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null },
        salesperson: null,
      }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toMatch(/no email/i);
    expect(res.detail).toMatch(/salesperson/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('legacy singular { recipient } still parses and sends (back-compat)', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 'Hi {{customer.first_name}}', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('sarah@example.com');
  });

  // The person a TECH_UNASSIGNED/WALKTHROUGH_PERFORMER_REMOVED automation is
  // MOST likely to message is the one who was just removed — not derivable
  // from the live entity (they're off it), so this comes from bundle.eventRecipient
  // (set from the enrollment's event_payload — context.ts) rather than a resolver DB call.
  it('removed_user resolves from bundle.eventRecipient — the one person no entity load can name', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair', phone: '+15559990012' };
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'removed_user', subject: 's', body: 'You are off the job at {{org.name}}' }),
      bundle({ eventRecipient: removed }),
    );
    expect(res.status).toBe('SENT');
    // The ADDRESS is the proof the captured recipient was reached. It used to be proved by
    // greeting them with {{recipient.first_name}}; that field is gone and the address is the
    // assertion that never depended on it - nobody else in this bundle has this mailbox.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('removed@org.com');
    expect(mockSendEmail.mock.calls[0][0].text).toBe('You are off the job at Blue Ridge Plumbing');
  });

  it('removed_user with no captured recipient → SKIPPED, not silently unsent', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'removed_user', subject: 's', body: 'b' }),
      bundle({ eventRecipient: null }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// The hard-coded walkthrough senders this replaced (retired Phase 3, 2026-07-27)
// persisted a Communication-tab row ONLY for the customer recipient — team/performer
// fan-out sends never persisted. The generic engine scopes it differently: every
// recipient gets a `record` passed to sendAutomationEmail (which is what actually
// persists), but `customerId` is populated ONLY for the customer's own address —
// pinned here so the scoping doesn't silently drift.
describe('executeAction — SEND_EMAIL Communication-tab persistence scoping', () => {
  it('passes customerId only on the record for the customer address; team recipients get customerId: null', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'assigned_team'], subject: 's', body: 'b' }),
      bundle(),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const byTo = Object.fromEntries(mockSendEmail.mock.calls.map((c) => [c[0].to, c[0].record]));
    expect(byTo['sarah@example.com']).toMatchObject({ customerId: 'c0000000-0000-0000-0000-000000000001' });
    expect(byTo['mike@org.com']).toMatchObject({ customerId: null });
  });
});

// ── Rule 0 through the executor ───────────────────────────────────────────────
// The drop itself is proved key-by-key in recipients.test.ts. What can ONLY be
// proved here is the hop: audienceContext() rebuilds the resolver context field
// by field, so an omitted actorId is silently dropped and every resolver-level
// test stays green while the engine keeps emailing the person who acted.
describe('executeAction - the acting user is excluded from every audience', () => {
  const MIKE = 'u0000000-0000-0000-0000-00000000000a';

  it('a send excludes the acting user from a resolved audience (SKIPPED, nothing sent)', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['assigned_team'], subject: 's', body: 'b' }),
      bundle({ actorId: MIKE }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBeTruthy();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('a send still reaches the audience when the actor is not one of them', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['assigned_team'], subject: 's', body: 'b' }),
      bundle({ actorId: 'someone-else' }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('mike@org.com');
  });

  it('a null actor (Stripe webhook, public door, cron sweep) sends to the full audience', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['assigned_team'], subject: 's', body: 'b' }),
      bundle({ actorId: null }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  // The NOTIFY_TEAM case that used to sit here is gone with the action itself
  // (Spec A slice 4). It would still report SKIPPED, but for the wrong reason -
  // no audience is resolved at all now - so it no longer demonstrates that one
  // filter covers every action type, and a vacuous green is worse than no test.

  // The most-used shipped default, and the behaviour change an admin notices
  // first: TECH_ASSIGNED dispatches once per added person, so a self-assignment
  // empties the audience entirely. It must SKIP with a reason, not FAIL.
  it('a technician who assigns themselves receives no default-tech-assigned email', async () => {
    const def = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-tech-assigned')!;
    const priya = { id: 'tech-priya', email: 'priya@org.com', first_name: 'Priya', last_name: 'Nair', phone: '+15559990012' };
    const selfAssigned = await executeAction(
      rule('SEND_EMAIL', { recipients: def.recipients, subject: def.subject, body: def.body }),
      bundle({ eventRecipient: priya, actorId: priya.id }),
    );
    expect(selfAssigned.status).toBe('SKIPPED');
    expect(selfAssigned.detail).toBeTruthy();
    expect(mockSendEmail).not.toHaveBeenCalled();

    // …and a dispatcher assigning Priya still emails Priya.
    const assignedByOther = await executeAction(
      rule('SEND_EMAIL', { recipients: def.recipients, subject: def.subject, body: def.body }),
      bundle({ eventRecipient: priya, actorId: 'dispatcher-1' }),
    );
    expect(assignedByOther.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe('priya@org.com');
  });

  it('the customer is emailed even when the customer-facing action was the acting user’s', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'assigned_team'], subject: 's', body: 'b' }),
      bundle({ actorId: MIKE }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(['sarah@example.com']);
  });
});

// ── Spec C: a text step addressed to STAFF ────────────────────────────────────
//
// Until Spec C the text action never read its configured recipients at all - it went
// straight to the bundle's customer. These cases are the audience half of the rewrite:
// the same audiences an email step offers, a per-person thread and message row, and one
// composed step result covering a mixed outcome.

const staffOrgRow = {
  ctm_account_id: '500001',
  ctm_sms_ready: true,
  sms_sending_enabled: true,
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: { phone: true },
};

/** A task bundle: no customer at all, and every audience it offers is staff. */
function taskBundle(overrides: Partial<ExecutionBundle> = {}): ExecutionBundle {
  return bundle({
    entityRef: { type: 'task', id: 'e0000000-0000-0000-0000-000000000001', label: 'Order the parts' },
    customer: null,
    jobRef: null,
    assignees: [],
    watchers: [],
    mergeCtx: { 'task.title': 'Order the parts', 'org.name': 'Blue Ridge Plumbing' },
    ...overrides,
  });
}

describe('executeAction - SEND_SMS addressed to staff', () => {
  beforeEach(() => {
    _resetCtmSmsDoubleFireGuard();
    mockCtmClient.isCtmConfigured.mockReturnValue(true);
    mockCtmClient.isOptedOut.mockResolvedValue(false);
    mockCtmClient.sendSms.mockResolvedValue({ id: 'MSG123' });
    mockPrisma.organization.findUnique.mockResolvedValue({ ...staffOrgRow });
    mockPrisma.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.message.update.mockResolvedValue({});
    mockPrisma.timelineEvent.create.mockResolvedValue({});
    // Set HERE rather than inherited from an earlier describe: mockResolvedValue survives
    // vi.clearAllMocks(), so a customer case in this block would otherwise depend on a
    // mock another block happened to leave behind.
    mockPrisma.customer.findFirst.mockResolvedValue({ phone: '+15551234567' });
    // A fresh thread per counterparty. The ids must DIFFER: the delivery path's
    // double-fire guard is keyed on (org, thread, body), so one shared id would make
    // the second recipient in a fan-out read DUPLICATE_SEND.
    let n = 0;
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);
    mockPrisma.messageThread.create.mockImplementation(async () => ({ id: `thread-${++n}` }));
    mockPrisma.message.create.mockImplementation(async () => ({ id: `msg-${n}` }));
  });

  /** Every to-number handed to the provider, in send order. */
  const sentTo = () => mockCtmClient.sendSms.mock.calls.map((c: any[]) => c[1].to);

  it('texts the assigned crew and names the PEOPLE in the run-history summary, never their numbers', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'A note from {{org.name}}' }),
      bundle({ assignees: [uA, uB] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone, uB.phone]);
    // The Activity feed renders "· To {recipient_summary}" to anyone with read access to
    // Automations - a joined list of personal mobile numbers would publish them.
    expect(res.recipientSummary).toBe('Ann Lee, Bob Fox');
    expect(res.recipientSummary).not.toMatch(/\d{4}/);
  });

  // THE IMPORTANT ONE. A missing number is one person's problem, not the step's: the
  // pre-Spec-C shape returned on the first failing condition, and that shape carried
  // straight into "the first crew member with no phone kills the whole send".
  it('a mixed audience produces BOTH outcomes in one step and does not short-circuit on the missing number', async () => {
    const noPhone = { ...uB, phone: null };

    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'Heads up' }),
      // The person WITHOUT a number is listed FIRST - a short-circuit would stop here.
      bundle({ assignees: [noPhone, uA] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone]);
    expect(res.detail).toMatch(/Sent to 1/);
    expect(res.detail).toContain('No phone number on file for Bob Fox');
    // Only the reachable person is claimed as a recipient.
    expect(res.recipientSummary).toBe('Ann Lee');
  });

  it('texts a person named by TWO audiences exactly once', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(uA);

    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team', 'specific_user'], user_ids: [uA.id], body: 'b' }),
      bundle({ assignees: [uA] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone]);
    expect(res.recipientSummary).toBe('Ann Lee');
  });

  it('SKIPS with a readable reason - and does not throw, so the run advances - when nobody addressed has a phone', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'Heads up' }),
      bundle({ assignees: [{ ...uA, phone: null }, { ...uB, phone: null }] }),
    );

    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('No phone number on file for Ann Lee · No phone number on file for Bob Fox');
    expect(mockCtmClient.sendSms).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  // The customer guard used to be an early return at the top of the action, so a text
  // step addressed only to staff aborted on any record with no customer. A task has no
  // customer at all and every one of its audiences is staff, which makes it the cleanest
  // possible exercise of this.
  it('a staff-only audience on a record with NO customer still sends', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assignees'], body: 'Task {{task.title}} is yours' }),
      taskBundle({ assignees: [uA] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone]);
    expect(res.detail).not.toMatch(/no customer/i);
  });

  // Story 5: the person just assigned to a task. `assigned_user` resolves from the
  // event payload, not the live roster, so an addition texts the one person added.
  it('TASK_ASSIGNED addressed to assigned_user texts the person just added, and nobody else', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_user'], body: 'You picked up {{task.title}}' }),
      taskBundle({ assignees: [uA, uB], eventRecipient: uB }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uB.phone]);
    expect(res.recipientSummary).toBe('Bob Fox');
  });

  it('a text step on a task addressed to assignees reaches every person on it', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assignees'], body: 'Standup at 8' }),
      taskBundle({ assignees: [uA, uB] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone, uB.phone]);
    expect(res.recipientSummary).toBe('Ann Lee, Bob Fox');
  });

  it('files each person under their OWN team thread - two people, two threads, no job attribution', async () => {
    await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'Heads up' }),
      bundle({ assignees: [uA, uB] }),
    );

    const threads = mockPrisma.messageThread.create.mock.calls.map((c: any[]) => c[0].data);
    expect(threads).toHaveLength(2);
    expect(threads.map((t: any) => t.user_id)).toEqual([uA.id, uB.id]);
    expect(threads.every((t: any) => t.kind === 'team' && t.campaign_type === 'tech_ops')).toBe(true);
    expect(threads.map((t: any) => t.title)).toEqual(['Ann Lee', 'Bob Fox']);

    for (const call of mockPrisma.message.create.mock.calls) {
      expect(call[0].data).not.toHaveProperty('job_id');
      expect(call[0].data).not.toHaveProperty('job_label');
    }
    // A staff send is not a customer event.
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  // One text PER HANDSET, which is what the per-name test here used to prove as a side
  // effect. The bodies are identical now and are still asserted one by one, because a
  // single text sent to two numbers at once would be a different (and wrong) shape that
  // "two calls happened" alone would not catch.
  it('texts each handset separately, every body fully rendered', async () => {
    await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'A note from {{org.name}}' }),
      bundle({ assignees: [uA, uB] }),
    );

    const bodies = mockCtmClient.sendSms.mock.calls.map((c: any[]) => c[1].msg);
    expect(bodies).toEqual(['A note from Blue Ridge Plumbing', 'A note from Blue Ridge Plumbing']);
    expect(bodies.join(' ')).not.toContain('{{');
  });

  it('greets a texted customer through {{customer.first_name}}, which is the field that survived', async () => {
    await executeAction(
      rule('SEND_SMS', { recipients: ['customer'], body: 'Hi {{customer.first_name}}' }),
      bundle(),
    );

    expect(mockCtmClient.sendSms.mock.calls[0][1].msg).toBe('Hi Sarah');
  });

  /**
   * A COMPANY customer: `first_name` and `last_name` are null on the row - that is what a B2B
   * customer IS, not a degenerate record - and context.ts has already resolved
   * {{customer.first_name}} to the company name. The handset path must read that RESOLVED value
   * off the bundle rather than the customer COLUMN, or a company gets "Hi ," in a text while the
   * email beside it says "Harbor Cabinet Co".
   *
   * Its own test even though the email path has one: the two paths render at two different sites,
   * so fixing one proves nothing about the other. Written against {{customer.first_name}}, which
   * is the field that survived - {{recipient.first_name}} was removed outright on 2026-09-15.
   */
  it('texts a COMPANY customer its own name, never "Hi ,"', async () => {
    await executeAction(
      rule('SEND_SMS', { recipients: ['customer'], body: 'Hi {{customer.first_name}},' }),
      bundle({
        customer: {
          id: 'c0000000-0000-0000-0000-0000000000c0',
          first_name: null,
          last_name: null,
          email: 'sarah@example.com',
          phone: '+15551234567',
        },
        mergeCtx: { 'customer.first_name': 'Harbor Cabinet Co', 'org.name': 'Blue Ridge Plumbing' },
      }),
    );
    const msg = mockCtmClient.sendSms.mock.calls[0][1].msg;
    expect(msg).toBe('Hi Harbor Cabinet Co,');
    expect(msg).not.toBe('Hi ,');
  });

  it('texts a staff member from the ORG default number - an automation has no sending user', async () => {
    await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'b' }),
      bundle({ assignees: [uA] }),
    );

    // The per-user caller-ID branches of resolveOutboundNumber are reached only when a
    // userId is passed; they must never run for an automation.
    expect(mockPrisma.userPhoneNumber.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.phoneNumber.findFirst.mock.calls[0][0].where.is_org_default).toBe(true);
  });

  it('records a FAILED step on a provider error, not a skip, and still returns rather than throwing', async () => {
    mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));

    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'b' }),
      bundle({ assignees: [uA] }),
    );

    expect(res.status).toBe('FAILED');
    // Names the handset it lost, the way the email path names the address it lost.
    expect(res.detail).toBe('Text delivery to Ann Lee failed');
    expect(res.recipientSummary).toBe('Ann Lee');
  });

  // The gates are keyed on org + destination and are counterparty-agnostic, so a staff
  // text must report the SAME copy an admin already knows from a customer text. These are
  // assertions on behaviour that falls out for free, not on new code.
  const GATED: Array<[string, () => void, string]> = [
    [
      'NOT_CONNECTED',
      () => mockCtmClient.isCtmConfigured.mockReturnValue(false),
      'Text messaging is not connected for this organization',
    ],
    [
      'SMS_NOT_READY',
      () => mockPrisma.organization.findUnique.mockResolvedValue({ ...staffOrgRow, ctm_sms_ready: false }),
      'Text messaging is not active yet — A2P registration is pending approval',
    ],
    [
      'ORG_SMS_DISABLED',
      () => mockPrisma.organization.findUnique.mockResolvedValue({ ...staffOrgRow, sms_sending_enabled: false }),
      'Text messaging is turned off for this organization',
    ],
  ];

  for (const [name, arrange, copy] of GATED) {
    it(`${name} skips a STAFF text with the same reason string a customer text already gets`, async () => {
      arrange();

      const res = await executeAction(
        rule('SEND_SMS', { recipients: ['assigned_team'], body: 'b' }),
        bundle({ assignees: [uA] }),
      );

      expect(res.status).toBe('SKIPPED');
      expect(res.detail).toBe(copy);
      // A skipped step carries no recipient summary, exactly as before the rewrite.
      expect(res.recipientSummary).toBeUndefined();
      // Same string the customer branch reports for the same gate.
      const customerRes = await executeAction(rule('SEND_SMS', { recipients: ['customer'], body: 'b' }), bundle());
      expect(customerRes.detail).toBe(copy);
      expect(customerRes.recipientSummary).toBeUndefined();
    });
  }

  it('skips an opted-out staff member silently, while an email step in the same workflow still reaches them', async () => {
    mockCtmClient.isOptedOut.mockResolvedValue(true);

    const text = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'b' }),
      bundle({ assignees: [uA] }),
    );
    expect(text.status).toBe('SKIPPED');
    expect(text.detail).toBe('This recipient has opted out of text messages');
    expect(mockCtmClient.sendSms).not.toHaveBeenCalled();

    // Text and email are separate steps: opting out of texts is not opting out of email.
    const email = await executeAction(
      rule('SEND_EMAIL', { recipients: ['assigned_team'], subject: 's', body: 'b' }),
      bundle({ assignees: [uA] }),
    );
    expect(email.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].to).toBe(uA.email);
  });

  // ── the customer branch, after the rewrite ─────────────────────────────────
  // The action was replaced wholesale, so every customer behaviour has to be
  // re-asserted end to end rather than assumed.

  it('a customer-addressed text step behaves exactly as before: customer thread, customer_care, timeline event, job stamp', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipient: 'customer', body: 'Hi {{customer.first_name}}' }),
      bundle(),
    );

    expect(res.status).toBe('SENT');
    // The customer summary is still the NUMBER, not a name.
    expect(res.recipientSummary).toBe('+15551234567');
    expect(mockPrisma.messageThread.create.mock.calls[0][0].data).toEqual({
      channel: 'sms',
      campaign_type: 'customer_care',
      customer_id: 'c0000000-0000-0000-0000-000000000001',
      organization_id: ORG,
    });
    expect(mockPrisma.message.create.mock.calls[0][0].data).toMatchObject({
      direction: 'out',
      body: 'Hi Sarah',
      status: 'queued',
      automated: true,
      job_id: 'b0000000-0000-0000-0000-000000000001',
      job_label: 'J00042',
    });
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalled();
    expect(mockCtmClient.sendSms.mock.calls[0][1].to).toBe('+15551234567');
  });

  // These two strings had ZERO coverage anywhere before this slice, and they are the two
  // conditions the rewrite had to stop treating as early returns.
  it('reports "This record has no customer to text" when the step names the customer and there is none', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['customer'], body: 'b' }),
      bundle({ customer: null }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('This record has no customer to text');
  });

  it('reports "Customer has no phone number on file" when the customer has none', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['customer'], body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: 'e@x.com', phone: null } }),
    );
    expect(res.status).toBe('SKIPPED');
    expect(res.detail).toBe('Customer has no phone number on file');
  });

  it('a customer-less record still texts the crew when the step names BOTH - the customer reason is collected, not fatal', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['customer', 'assigned_team'], body: 'b' }),
      bundle({ customer: null, assignees: [uA] }),
    );

    expect(res.status).toBe('SENT');
    expect(sentTo()).toEqual([uA.phone]);
    expect(res.detail).toContain('This record has no customer to text');
  });

  // Slice 6 made the STAFF failure detail name PEOPLE rather than numbers, because the
  // Activity feed is readable by anyone with read access to Automations. The same
  // reasoning covers the customer: a failed customer text must not print their mobile.
  it('a failed customer text does NOT publish the number in the detail - it says only that delivery failed', async () => {
    mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));

    const res = await executeAction(rule('SEND_SMS', { recipient: 'customer', body: 'b' }), bundle());

    expect(res.status).toBe('FAILED');
    expect(res.detail).toBe('Text delivery failed');
    expect(res.detail).not.toMatch(/\d{4}/);
    // recipientSummary is unchanged - the customer path has always carried the number there.
    expect(res.recipientSummary).toBe('+15551234567');
  });

  it('a fan-out that loses BOTH names the staff handset and still keeps the customer number out of it', async () => {
    mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));

    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['customer', 'assigned_team'], body: 'b' }),
      bundle({ assignees: [uA] }),
    );

    expect(res.status).toBe('FAILED');
    expect(res.detail).toBe('Text delivery failed \u00b7 Text delivery to Ann Lee failed');
  });

  // The run-history preview is what an admin reads to see WHAT went out. It must be a
  // body a handset really received - not a rendering nobody got.
  it('previews the text the customer actually received, merge fields resolved', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['customer'], body: 'Hi {{customer.first_name}}, see you soon' }),
      bundle(),
    );

    expect(res.status).toBe('SENT');
    expect(res.detail).toBe('Hi Sarah, see you soon');
    // The invariant, not just the string: the preview IS what left the building.
    expect(mockCtmClient.sendSms.mock.calls[0][1].msg).toBe(res.detail);
  });

  it('previews a staff fan-out with one of the bodies that was really sent', async () => {
    const res = await executeAction(
      rule('SEND_SMS', { recipients: ['assigned_team'], body: 'A note from {{org.name}}' }),
      bundle({ assignees: [uA, uB] }),
    );

    expect(res.status).toBe('SENT');
    const bodies = mockCtmClient.sendSms.mock.calls.map((c: any[]) => c[1].msg);
    expect(bodies).toEqual(['A note from Blue Ridge Plumbing', 'A note from Blue Ridge Plumbing']);
    // Still the first DELIVERED body rather than a re-render nobody got - the bodies no
    // longer differ, but the preview must keep coming from what was actually dispatched.
    expect(res.detail).toBe('A note from Blue Ridge Plumbing');
    expect(bodies).toContain(res.detail);
  });
});

// ── "If empty, fill with" ────────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// The context builders resolve a crewless job's `technician.names` to ''. What the customer reads
// instead is the step's own fallback map, and a step stored before the map existed (no
// `fallbacks` key) renders the seeded defaults so nothing already published changes.

describe('executeAction - merge-field fallbacks', () => {
  it("SEND_EMAIL renders the author's fallback where the crew field is empty", async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', {
        recipient: 'customer',
        subject: 'Visit',
        body: "Who's coming: {{technician.names}}.",
        fallbacks: { 'technician.names': 'a member of the crew' },
      }),
      bundle({ mergeCtx: { 'technician.names': '' } }),
    );
    expect(res.status).toBe('SENT');
    const args = mockSendEmail.mock.calls[0][0];
    expect(args.text).toBe("Who's coming: a member of the crew.");
    // The fragment escapes the whole rendered string (the apostrophe becomes &#39;), so match past it.
    expect(args.html).toContain('coming: a member of the crew.');
  });

  it('SEND_SMS renders the author\'s fallback where the crew field is empty', async () => {
    mockPrisma.messageThread.findFirst.mockResolvedValueOnce(null);
    mockPrisma.messageThread.create.mockResolvedValueOnce({ id: 'thread-1', customer_id: 'c0000000-0000-0000-0000-000000000001' });
    mockPrisma.message.create.mockResolvedValueOnce({ id: 'msg-1' });
    const res = await executeAction(
      rule('SEND_SMS', {
        recipient: 'customer',
        body: '{{technician.names}} will be there.',
        fallbacks: { 'technician.names': 'Your installer' },
      }),
      bundle({ mergeCtx: { 'technician.names': '' } }),
    );
    expect(res.status).not.toBe('FAILED');
    const created = mockPrisma.message.create.mock.calls[0][0];
    expect(created.data.body).toBe('Your installer will be there.');
  });

  it('a step stored before fallbacks existed (no key) renders the seeded default', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipient: 'customer', subject: 's', body: "Who's coming: {{technician.names}}." }),
      bundle({ mergeCtx: { 'technician.names': '' } }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe("Who's coming: Our team.");
  });

  it('a fallback the author cleared renders the field empty, not the seeded default', async () => {
    // The customer field beside it is declared and applied, so an executor that ignores the
    // map fails here, and so does one that merges the seeded defaults over the cleared entry.
    const res = await executeAction(
      rule('SEND_EMAIL', {
        recipient: 'customer',
        subject: 's',
        body: "Hi {{customer.first_name}}, who's coming: {{technician.names}}.",
        fallbacks: { 'technician.names': '', 'customer.first_name': 'there' },
      }),
      bundle({ mergeCtx: { 'customer.first_name': '', 'technician.names': '' } }),
    );
    expect(res.status).toBe('SENT');
    expect(mockSendEmail.mock.calls[0][0].text).toBe("Hi there, who's coming: .");
  });
});

// ── Per-audience outcomes (scheduling-notifications slice 03) ─────────────────
//
// A step aimed at several audiences used to record ONE status for the whole step: SENT
// if anyone got it. The step-level status keeps that meaning; what is new is that every
// resolved audience carries its own outcome and a plain-English summary, so the ledger
// can say whether the CUSTOMER was reached and not only that somebody was.

describe('executeAction - per-audience outcomes', () => {
  it('email: customer without an address is skipped with the reason while the crew is sent, step stays SENT', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'assigned_team'], subject: 's', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null } }),
    );

    expect(res.status).toBe('SENT');
    expect(res.audienceOutcomes).toEqual([
      {
        audience: 'customer',
        label: 'the customer',
        outcome: 'skipped',
        summary: 'The customer has no email address on file',
      },
      { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
    ]);
  });

  it('email: a customer-only step whose customer has no address still records the customer as skipped, step SKIPPED', async () => {
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer'], subject: 's', body: 'b' }),
      bundle({ customer: { id: 'c1', first_name: 'S', last_name: null, email: null, phone: null } }),
    );

    expect(res.status).toBe('SKIPPED');
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(res.audienceOutcomes).toEqual([
      {
        audience: 'customer',
        label: 'the customer',
        outcome: 'skipped',
        summary: 'The customer has no email address on file',
      },
    ]);
  });

  it('email: sending turned off for the org records the customer as skipped with that reason, step stays SKIPPED', async () => {
    mockSendEmail.mockResolvedValueOnce({ status: 'skipped', reason: 'org_disabled' });
    const res = await executeAction(rule('SEND_EMAIL', { recipients: ['customer'], subject: 's', body: 'b' }), bundle());

    expect(res.status).toBe('SKIPPED');
    expect(res.audienceOutcomes).toEqual([
      {
        audience: 'customer',
        label: 'the customer',
        outcome: 'skipped',
        summary: 'Email sending is turned off for this organization',
      },
    ]);
  });

  it('email: a provider rejection records the audience as failed with the provider reason', async () => {
    mockSendEmail
      .mockResolvedValueOnce({ status: 'failed', error: 'Invalid `to` field' })
      .mockResolvedValueOnce({ status: 'sent' });
    const res = await executeAction(
      rule('SEND_EMAIL', { recipients: ['customer', 'assigned_team'], subject: 's', body: 'b' }),
      bundle(),
    );

    expect(res.status).toBe('SENT');
    expect(res.audienceOutcomes).toEqual([
      {
        audience: 'customer',
        label: 'the customer',
        outcome: 'failed',
        summary: 'delivery to sarah@example.com failed: Invalid `to` field',
      },
      { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
    ]);
  });

  describe('text', () => {
    beforeEach(() => {
      _resetCtmSmsDoubleFireGuard();
      mockCtmClient.isCtmConfigured.mockReturnValue(true);
      mockCtmClient.isOptedOut.mockResolvedValue(false);
      mockCtmClient.sendSms.mockResolvedValue({ id: 'MSG123' });
      mockPrisma.organization.findUnique.mockResolvedValue({ ...staffOrgRow });
      mockPrisma.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
      mockPrisma.auditLog.create.mockResolvedValue({});
      mockPrisma.message.update.mockResolvedValue({});
      mockPrisma.timelineEvent.create.mockResolvedValue({});
      mockPrisma.customer.findFirst.mockResolvedValue({ phone: '+15551234567' });
      let n = 0;
      mockPrisma.messageThread.findFirst.mockResolvedValue(null);
      mockPrisma.messageThread.create.mockImplementation(async () => ({ id: `thread-${++n}` }));
      mockPrisma.message.create.mockImplementation(async () => ({ id: `msg-${n}` }));
    });

    it('customer without a number is skipped with the reason while the crew is sent, step stays SENT', async () => {
      const res = await executeAction(
        rule('SEND_SMS', { recipients: ['customer', 'assigned_team'], body: 'b' }),
        bundle({
          customer: { id: 'c1', first_name: 'S', last_name: null, email: 'e@x.com', phone: null },
          assignees: [uA],
        }),
      );

      expect(res.status).toBe('SENT');
      expect(res.audienceOutcomes).toEqual([
        { audience: 'customer', label: 'the customer', outcome: 'skipped', summary: 'Customer has no phone number on file' },
        { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to Ann Lee' },
      ]);
    });

    it('sending turned off for the org records the customer as skipped with that reason, step stays SKIPPED', async () => {
      mockPrisma.organization.findUnique.mockResolvedValue({ ...staffOrgRow, sms_sending_enabled: false });
      const res = await executeAction(rule('SEND_SMS', { recipients: ['customer'], body: 'b' }), bundle());

      expect(res.status).toBe('SKIPPED');
      expect(res.audienceOutcomes).toEqual([
        {
          audience: 'customer',
          label: 'the customer',
          outcome: 'skipped',
          summary: 'Text messaging is turned off for this organization',
        },
      ]);
    });

    it('a provider rejection records each audience as failed with its own number-free reason', async () => {
      mockCtmClient.sendSms.mockRejectedValue(new mockCtmClient.CtmApiError('CTM API error 500: boom'));
      const res = await executeAction(
        rule('SEND_SMS', { recipients: ['customer', 'assigned_team'], body: 'b' }),
        bundle({ assignees: [uA] }),
      );

      expect(res.status).toBe('FAILED');
      expect(res.audienceOutcomes).toEqual([
        { audience: 'customer', label: 'the customer', outcome: 'failed', summary: 'Text delivery failed' },
        { audience: 'assigned_team', label: 'the assigned crew', outcome: 'failed', summary: 'Text delivery to Ann Lee failed' },
      ]);
    });

    it('a person named by two audiences reads as sent under both, from the one text they got', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce(uA);
      const res = await executeAction(
        rule('SEND_SMS', { recipients: ['assigned_team', 'specific_user'], user_ids: [uA.id], body: 'b' }),
        bundle({ assignees: [uA] }),
      );

      expect(mockCtmClient.sendSms).toHaveBeenCalledTimes(1);
      expect(res.audienceOutcomes).toEqual([
        { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to Ann Lee' },
        { audience: 'specific_user', label: 'a specific person', outcome: 'sent', summary: 'Sent to Ann Lee' },
      ]);
    });
  });
});
