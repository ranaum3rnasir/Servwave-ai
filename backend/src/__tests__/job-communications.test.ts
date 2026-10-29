import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import {
  mockAuthAs, authHeader,
  ALPHA_ORG_ID, ORG_B_ID,
  CUSTOMER_FIXTURE, JOB_FIXTURE,
} from './helpers';
import { getJobCommunications, getCustomerCommunications, getLeadCommunications } from '../lib/job-communications';
import type { CommItem } from '../lib/job-communications';
import { anchorInheritedWhere } from '../lib/permissions/anchorVisibility';
import { matchesWhere } from './whereMatcher';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) })
  );
}

// ─── Fixtures ───────────────────────────────────────────

const JOB_ID = JOB_FIXTURE.id;
const OTHER_JOB_ID = 'j0000000-0000-0000-0000-000000000099';
const CUSTOMER_ID = CUSTOMER_FIXTURE.id;
const OTHER_CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000099';

const COMM_CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'John',
  last_name: 'Doe',
  company_name: 'Doe HVAC',
};

const CALL_ROW = {
  id: 'ca000000-0000-0000-0000-000000000001',
  direction: 'in',
  from_number: '+12125551042',
  to_number: '+15125550100',
  status: 'completed',
  duration_sec: 247,
  started_at: new Date('2026-06-01T14:32:00Z'),
  disposition: 'Booked',
  summary: 'Confirmed Thursday 8am. Asked for COI before arrival.',
  customer_id: CUSTOMER_ID,
  job_id: JOB_ID,
  job_label: 'J00001',
  customer: COMM_CUSTOMER,
  organization_id: ALPHA_ORG_ID,
};

const SMS_ROW = {
  id: 'aa000000-0000-0000-0000-000000000001',
  thread_id: 'ab000000-0000-0000-0000-000000000001',
  direction: 'out',
  body: 'Confirming Thursday 8am for the vault corridor re-key. COI to follow.',
  ts: new Date('2026-06-01T14:40:00Z'),
  status: 'delivered',
  job_id: JOB_ID,
  job_label: 'J00001',
  thread: { customer_id: CUSTOMER_ID, title: null, customer: COMM_CUSTOMER },
  organization_id: ALPHA_ORG_ID,
};

const EMAIL_ROW = {
  id: 'ac000000-0000-0000-0000-000000000001',
  account: 'system',
  from: { name: 'ServWave', email: 'no-reply@servwave.com' },
  to: 'john@doe.com',
  subject: 'Estimate E00003 · Vault corridor re-key',
  snippet: '14 cylinders, restricted keyway. Approve to schedule.',
  body: {},
  at: 'Mon 9:12a',
  // Email.ts is now a Prisma BigInt (epoch-ms) — reads come back as JS bigint.
  // The aggregator must never feed it to Date()/JSON; `at` derives from created_at.
  ts: 1780000000000n,
  created_at: new Date('2026-06-01T09:12:00Z'),
  folder: 'sent',
  customer_id: CUSTOMER_ID,
  job_id: JOB_ID,
  job_label: 'J00001',
  customer: COMM_CUSTOMER,
  organization_id: ALPHA_ORG_ID,
};

const WA_ROW = {
  id: 'ad000000-0000-0000-0000-000000000001',
  chat_id: 'ae000000-0000-0000-0000-000000000001',
  from: 'them',
  text: 'Thursday works. See you then.',
  at: '2:44 PM',
  status: null,
  created_at: new Date('2026-06-01T18:44:00Z'),
  job_id: JOB_ID,
  job_label: 'J00001',
  chat: { customer_id: CUSTOMER_ID, name: 'Daniel Cohen', phone: '+12125551042', customer: COMM_CUSTOMER },
  organization_id: ALPHA_ORG_ID,
};

// A second job's SMS in the same customer thread — must be excluded from JOB_ID's timeline.
const OTHER_JOB_SMS_ROW = {
  ...SMS_ROW,
  id: 'aa000000-0000-0000-0000-000000000002',
  body: 'Opened a separate ticket for the lobby access control.',
  job_id: OTHER_JOB_ID,
  job_label: 'J00002',
};

// Another customer's rows — must be excluded from CUSTOMER_ID's roll-up.
const OTHER_CUSTOMER_CALL_ROW = {
  ...CALL_ROW,
  id: 'ca000000-0000-0000-0000-000000000002',
  customer_id: OTHER_CUSTOMER_ID,
  customer: { id: OTHER_CUSTOMER_ID, first_name: 'Jane', last_name: 'Roe', company_name: null },
};

// ─── Stub db (lib unit tests) ───────────────────────────

type Row = Record<string, any>;

/** findMany stub that actually applies the relevant where filters, so exclusion is tested. */
function filteringFindMany(rows: Row[]) {
  return vi.fn(async ({ where }: { where: Row }) =>
    rows.filter((r) =>
      r.organization_id === where.organization_id &&
      (where.job_id === undefined || r.job_id === where.job_id) &&
      (where.customer_id === undefined || r.customer_id === where.customer_id) &&
      (where.thread?.customer_id === undefined || r.thread?.customer_id === where.thread.customer_id) &&
      (where.chat?.customer_id === undefined || r.chat?.customer_id === where.chat.customer_id)
    )
  );
}

/**
 * The manual source's stub, which evaluates the WHOLE `where` through the shared matcher rather
 * than the handful of keys `filteringFindMany` knows about.
 *
 * It has to: this is the only query in the module that combines an anchor disjunction of its own
 * (the customer roll-up reaches an entry THROUGH its lead or its job) with the anchor-inherited
 * visibility filter, which is itself an `OR` of nullness-pinned branches. Applying the real
 * fragment to real fixture rows is what turns "a filter was passed" into "this technician sees
 * the entry logged on their job and not the one logged on somebody else's".
 */
function manualFindMany(rows: Row[]) {
  return vi.fn(async ({ where, include }: { where: Row; include?: Row }) =>
    rows.filter((r) => matchesWhere(r, where)).map((r) => withIncludedRelations(r, include))
  );
}

/**
 * The relations a query ASKED FOR, and only those - the projection Prisma performs after the
 * filter.
 *
 * It matters because the fixtures carry every relation inline. A stub that handed all of them
 * back regardless made MANUAL_INCLUDE untestable: deleting its `job:` line left this whole file
 * green while `who` and `jobLabel` blanked on every job-anchored row in production. The filter
 * still runs against the FULL row, because that is where the database evaluates a join condition
 * (the customer roll-up's anchor disjunction is exactly such a condition); only what comes back
 * is trimmed.
 */
function withIncludedRelations(row: Row, include?: Row): Row {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { lead, job, customer, performer, logger, ...columns } = row;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return {
    ...columns,
    ...(include?.lead ? { lead } : {}),
    ...(include?.job ? { job } : {}),
    ...(include?.customer ? { customer } : {}),
    ...(include?.performer ? { performer } : {}),
    ...(include?.logger ? { logger } : {}),
  };
}

function stubDb(
  rows: { calls?: Row[]; messages?: Row[]; emails?: Row[]; whatsapps?: Row[]; manuals?: Row[] } = {}
) {
  return {
    callSession: { findMany: filteringFindMany(rows.calls ?? []) },
    message: { findMany: filteringFindMany(rows.messages ?? []) },
    email: { findMany: filteringFindMany(rows.emails ?? []) },
    whatsAppMessage: { findMany: filteringFindMany(rows.whatsapps ?? []) },
    // Fifth source (manual communication log), wired into BOTH aggregations here as of slice 5.
    manualCommunicationLog: { findMany: manualFindMany(rows.manuals ?? []) },
  };
}

// ─── Lib: getJobCommunications ──────────────────────────

describe('getJobCommunications (lib)', () => {
  it('unions all four channels sorted ascending by at', async () => {
    const db = stubDb({ calls: [CALL_ROW], messages: [SMS_ROW], emails: [EMAIL_ROW], whatsapps: [WA_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items).toHaveLength(4);
    // email 09:12 < call 14:32 < sms 14:40 < whatsapp 18:44
    expect(items.map((i: CommItem) => i.channel)).toEqual(['email', 'call', 'sms', 'whatsapp']);
    const times = items.map((i: CommItem) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('maps rows to the frozen CommItem contract', async () => {
    const db = stubDb({ calls: [CALL_ROW], messages: [SMS_ROW], emails: [EMAIL_ROW], whatsapps: [WA_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    const call = items.find((i: CommItem) => i.channel === 'call')!;
    expect(call).toMatchObject({
      id: CALL_ROW.id,
      direction: 'in',
      who: 'Doe HVAC',
      title: 'Inbound call · 4m 07s',
      at: '2026-06-01T14:32:00.000Z',
      jobId: JOB_ID,
      jobLabel: 'J00001',
      meta: 'Booked',
    });
    expect(call.preview).toBe(CALL_ROW.summary);
    expect(call.state).toBeUndefined();

    const sms = items.find((i: CommItem) => i.channel === 'sms')!;
    expect(sms).toMatchObject({
      direction: 'out',
      who: 'Doe HVAC',
      title: 'Text message',
      preview: SMS_ROW.body,
      at: '2026-06-01T14:40:00.000Z',
    });

    const wa = items.find((i: CommItem) => i.channel === 'whatsapp')!;
    expect(wa).toMatchObject({
      direction: 'in',
      title: 'WhatsApp message',
      preview: WA_ROW.text,
      at: '2026-06-01T18:44:00.000Z',
    });
  });

  it('excludes a second job\'s rows from the timeline', async () => {
    const db = stubDb({ messages: [SMS_ROW, OTHER_JOB_SMS_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(SMS_ROW.id);
  });

  it('scopes every channel query by job_id AND organization_id', async () => {
    const db = stubDb();
    await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    for (const fn of [db.callSession.findMany, db.message.findMany, db.email.findMany, db.whatsAppMessage.findMany]) {
      expect(fn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ job_id: JOB_ID, organization_id: ALPHA_ORG_ID }),
        })
      );
    }
  });

  it('returns [] for a job with no communications', async () => {
    const db = stubDb();
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });
    expect(items).toEqual([]);
  });

  it('works with calls only (other channels absent)', async () => {
    const db = stubDb({ calls: [CALL_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items).toHaveLength(1);
    expect(items[0].channel).toBe('call');
    expect(items[0].title).toBe('Inbound call · 4m 07s');
  });

  it('derives email at from created_at — never from ts (BigInt; legacy rows hold small mock ints)', async () => {
    // Legacy mock-contract row: ts is a tiny int that would render as a 1970 date
    // and sort to the timeline's start. created_at is a DateTime that is always right.
    const legacy = { ...EMAIL_ROW, id: 'ac000000-0000-0000-0000-000000000003', ts: 3n };
    const db = stubDb({ emails: [EMAIL_ROW, legacy] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items.map((i: CommItem) => i.at)).toEqual([
      '2026-06-01T09:12:00.000Z',
      '2026-06-01T09:12:00.000Z',
    ]);
    // CommItems must survive res.json — no bigint may leak into the contract.
    expect(() => JSON.stringify(items)).not.toThrow();
  });

  it('flags transactional emails (account === "system") and maps email direction from folder', async () => {
    const inbound = {
      ...EMAIL_ROW,
      id: 'ac000000-0000-0000-0000-000000000002',
      account: 'main',
      folder: 'inbox',
      subject: '',
    };
    const db = stubDb({ emails: [EMAIL_ROW, inbound] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    const sent = items.find((i: CommItem) => i.id === EMAIL_ROW.id)!;
    expect(sent.transactional).toBe(true);
    expect(sent.direction).toBe('out');
    expect(sent.title).toBe(EMAIL_ROW.subject);

    const received = items.find((i: CommItem) => i.id === inbound.id)!;
    expect(received.transactional).toBeUndefined();
    expect(received.direction).toBe('in');
    expect(received.title).toBe('(no subject)');
  });

  it('surfaces email delivery_status/reason/bounce_kind (slice 5) and omits them when null', async () => {
    const bounced = {
      ...EMAIL_ROW,
      id: 'ac000000-0000-0000-0000-000000000003',
      delivery_status: 'BOUNCED',
      delivery_status_reason: '550 5.1.1 mailbox unavailable',
      bounce_kind: 'HARD',
    };
    const db = stubDb({ emails: [EMAIL_ROW, bounced] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    // EMAIL_ROW never sets delivery_status — a row nothing has reported on yet
    // (predates the webhook, or the webhook hasn't fired) must omit the field
    // rather than default to some value, mirroring the Prisma column's own
    // "null means nothing has ever reported on this row" contract.
    const neverReported = items.find((i: CommItem) => i.id === EMAIL_ROW.id)!;
    expect(neverReported.deliveryStatus).toBeUndefined();
    expect(neverReported.deliveryStatusReason).toBeUndefined();
    expect(neverReported.bounceKind).toBeUndefined();

    const hardBounce = items.find((i: CommItem) => i.id === bounced.id)!;
    expect(hardBounce.deliveryStatus).toBe('BOUNCED');
    expect(hardBounce.deliveryStatusReason).toBe('550 5.1.1 mailbox unavailable');
    expect(hardBounce.bounceKind).toBe('HARD');
  });

  it('omits jobId/jobLabel when null and falls back to phone for who when no customer', async () => {
    const unattributed = {
      ...CALL_ROW,
      id: 'ca000000-0000-0000-0000-000000000003',
      job_id: null,
      job_label: null,
      customer_id: null,
      customer: null,
      duration_sec: null,
    };
    // stub that returns the row directly (omit-if-null mapping check)
    const direct = {
      callSession: { findMany: vi.fn().mockResolvedValue([unattributed]) },
      message: { findMany: vi.fn().mockResolvedValue([]) },
      email: { findMany: vi.fn().mockResolvedValue([]) },
      whatsAppMessage: { findMany: vi.fn().mockResolvedValue([]) },
      manualCommunicationLog: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const [item] = await getJobCommunications(direct, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect('jobId' in item).toBe(false);
    expect('jobLabel' in item).toBe(false);
    expect(item.who).toBe('+12125551042'); // inbound → counterparty is from_number
    expect(item.title).toBe('Inbound call'); // no duration suffix
  });

  it('falls back to the job relation job_number for calls stamped before job_label existed', async () => {
    // CallSession rows created before job_label stamping: job_id set, job_label NULL.
    const legacyCall = {
      ...CALL_ROW,
      id: 'ca000000-0000-0000-0000-000000000004',
      job_label: null,
      job: { job_number: 'J00001' },
    };
    const db = stubDb({ calls: [legacyCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.jobId).toBe(JOB_ID);
    expect(item.jobLabel).toBe('J00001');
    // Only the call query pays for the join — message/email/whatsapp rows are
    // stamped at write time and don't need it.
    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ job: { select: { job_number: true } } }) })
    );
    for (const fn of [db.message.findMany, db.email.findMany, db.whatsAppMessage.findMany]) {
      expect(fn).not.toHaveBeenCalledWith(
        expect.objectContaining({ include: expect.objectContaining({ job: expect.anything() }) })
      );
    }
  });

  it('truncates preview to ~160 chars', async () => {
    const longBody = 'x'.repeat(400);
    const db = stubDb({ messages: [{ ...SMS_ROW, body: longBody }] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items[0].preview.length).toBeLessThanOrEqual(160);
    expect(items[0].preview.startsWith('xxxx')).toBe(true);
  });
});

// ─── Lib: CommItem additive fields (slice E3/E6) ────────
// leadId/leadLabel per channel + answeredBy on calls. ADDITIVE optional fields
// (precedent: meta?/transactional?) — absent, never null, when unlinked.

describe('CommItem additive fields — leadId/leadLabel + answeredBy', () => {
  const LEAD_ID = 'e0000000-0000-0000-0000-000000000042';
  const LEAD_JOIN = { lead_number: 'L00007' };

  it('populates leadId/leadLabel per channel: call/email/sms from lead_id, whatsapp via chat.lead', async () => {
    const db = stubDb({
      calls: [{ ...CALL_ROW, lead_id: LEAD_ID, lead: LEAD_JOIN }],
      messages: [{ ...SMS_ROW, lead_id: LEAD_ID, lead: LEAD_JOIN }],
      emails: [{ ...EMAIL_ROW, lead_id: LEAD_ID, lead: LEAD_JOIN }],
      whatsapps: [{ ...WA_ROW, chat: { ...WA_ROW.chat, lead_id: LEAD_ID, lead: LEAD_JOIN } }],
    });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.leadId).toBe(LEAD_ID);
      expect(item.leadLabel).toBe('L00007');
    }
  });

  it('omits leadId/leadLabel when the row has no lead linkage', async () => {
    const db = stubDb({ calls: [CALL_ROW], messages: [SMS_ROW], emails: [EMAIL_ROW], whatsapps: [WA_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    for (const item of items) {
      expect('leadId' in item).toBe(false);
      expect('leadLabel' in item).toBe(false);
    }
  });

  // #2046 R1 — the record tabs' SMS drawer needs a thread id to re-source itself off the
  // by-id anchor-filtered `GET /threads/:id` instead of the org-wide list this fix now gates.
  it('sms carries threadId equal to the row\'s thread_id (#2046 R1)', async () => {
    const db = stubDb({ messages: [SMS_ROW] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.channel).toBe('sms');
    expect(item.threadId).toBe(SMS_ROW.thread_id);
  });

  it('call answered_by csr with a name → answeredBy is that name', async () => {
    const csrCall = {
      ...CALL_ROW,
      answered_by: { kind: 'csr', ctm_agent_id: '12', name: 'Dana Reyes', email: 'dana@alpha.com' },
    };
    const db = stubDb({ calls: [csrCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.answeredBy).toBe('Dana Reyes');
  });

  it('call answered_by csr without a name falls back to the joined agent user name', async () => {
    const agentCall = {
      ...CALL_ROW,
      answered_by: { kind: 'csr', ctm_agent_id: null, name: null, email: null },
      agent: { first_name: 'Avi', last_name: 'Levi' },
    };
    const db = stubDb({ calls: [agentCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.answeredBy).toBe('Avi Levi');
  });

  it('call answered_by external (forwarded phone, no agent payload) → "Forwarded phone"', async () => {
    const externalCall = {
      ...CALL_ROW,
      answered_by: { kind: 'external', receiving_number_id: '99' },
    };
    const db = stubDb({ calls: [externalCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.answeredBy).toBe('Forwarded phone');
  });

  it('call answered_by voicemail → answeredBy is "Voicemail"', async () => {
    const voicemailCall = {
      ...CALL_ROW,
      answered_by: { kind: 'voicemail', ctm_agent_id: null, name: null, email: null },
    };
    const db = stubDb({ calls: [voicemailCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(item.answeredBy).toBe('Voicemail');
  });

  it('call answered_by none → answeredBy absent; rows without answered_by tolerate it', async () => {
    const noneCall = {
      ...CALL_ROW,
      answered_by: { kind: 'none', ctm_agent_id: null, name: null, email: null },
    };
    const db = stubDb({ calls: [noneCall] });
    const [item] = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect('answeredBy' in item).toBe(false);
  });

  it('non-call channels never carry answeredBy', async () => {
    const db = stubDb({ messages: [SMS_ROW], emails: [EMAIL_ROW], whatsapps: [WA_ROW] });
    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    for (const item of items) {
      expect('answeredBy' in item).toBe(false);
    }
  });

  it('joins stay lean: call gets lead{lead_number}+agent{first,last}; sms/whatsapp lead rides the thread/chat select; email joins lead only', async () => {
    const db = stubDb();
    await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          lead: { select: { lead_number: true } },
          agent: { select: { first_name: true, last_name: true } },
        }),
      })
    );
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          thread: { select: expect.objectContaining({ title: true }) },
          lead: { select: { lead_number: true } },
        },
      })
    );
    expect(db.email.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ lead: { select: { lead_number: true } } }),
      })
    );
    expect(db.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          chat: {
            select: expect.objectContaining({
              lead_id: true,
              lead: { select: { lead_number: true } },
            }),
          },
        },
      })
    );
  });
});

// ─── Lib: getCustomerCommunications ─────────────────────

describe('getCustomerCommunications (lib)', () => {
  it('returns all four channels for the customer and excludes other customers', async () => {
    const db = stubDb({
      calls: [CALL_ROW, OTHER_CUSTOMER_CALL_ROW],
      messages: [SMS_ROW],
      emails: [EMAIL_ROW],
      whatsapps: [WA_ROW],
    });
    const items = await getCustomerCommunications(db, { customerId: CUSTOMER_ID, organizationId: ALPHA_ORG_ID });

    expect(items).toHaveLength(4);
    expect(items.map((i: CommItem) => i.channel).sort()).toEqual(['call', 'email', 'sms', 'whatsapp']);
    expect(items.find((i: CommItem) => i.id === OTHER_CUSTOMER_CALL_ROW.id)).toBeUndefined();
    // ascending
    const times = items.map((i: CommItem) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('queries by customer linkage: direct FK for calls/emails, thread/chat relation for sms/whatsapp', async () => {
    const db = stubDb();
    await getCustomerCommunications(db, { customerId: CUSTOMER_ID, organizationId: ALPHA_ORG_ID });

    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ customer_id: CUSTOMER_ID, organization_id: ALPHA_ORG_ID }) })
    );
    // job_number fallback join rides along on the customer roll-up too.
    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ job: { select: { job_number: true } } }) })
    );
    expect(db.email.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ customer_id: CUSTOMER_ID, organization_id: ALPHA_ORG_ID }) })
    );
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID, thread: { customer_id: CUSTOMER_ID } }) })
    );
    expect(db.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organization_id: ALPHA_ORG_ID, chat: { customer_id: CUSTOMER_ID } }) })
    );
  });
});

// ─── The manual log inherits its anchor's visibility, on BOTH new aggregations ──────────────
//
// A logged entry is queried with the SAME `...visibility` spread as the four real channels, so
// whoever can see the job (or the lead) can see what was logged on it, and whoever cannot,
// cannot. Delete that spread from either arm below and every other spec in this file stays green
// while a technician who was never on the job starts reading its hand-typed history - a
// cross-tenant-shaped read, not a cosmetic defect.
//
// Slice 1's remediation proved this for the lead arm (lead-communications.test.ts); these are the
// job and customer arms, which slice 5 added. The fragment is built by the REAL
// anchorInheritedWhere and really evaluated by the stub, so both outcomes are behaviour.

const TECH_ID = '00000000-0000-0000-0000-000000000004';
const SOMEONE_ELSE = '00000000-0000-0000-0000-0000000000ff';
const MATCH_NOTHING = { id: { in: [] as string[] } };   // no read grant on that anchor
const ownJob = (userId: string) => ({ assignees: { some: { user_id: userId } } });
const ownLead = (userId: string) => ({ lead_assignees: { some: { user_id: userId } } });

/** What the include resolves for each anchor - plus the assignee rows the scope fragment probes. */
const JOB_ANCHOR = {
  job_number: 'J00001',
  customer_id: CUSTOMER_ID,
  customer: COMM_CUSTOMER,
  assignees: [{ user_id: TECH_ID }],
};
const LEAD_ANCHOR = {
  lead_number: 'L00007',
  customer_id: CUSTOMER_ID,
  customer: COMM_CUSTOMER,
  lead_assignees: [{ user_id: TECH_ID }],
};

const MANUAL_ON_JOB = {
  id: '11110000-0000-0000-0000-000000000021',
  channel: 'CALL',
  direction: 'OUT',
  occurred_at: new Date('2026-06-01T15:00:00Z'),
  notes: 'Rang the customer from my mobile about the install window.',
  duration_minutes: null,
  lead_id: null,
  job_id: JOB_ID,
  lead: null,
  job: JOB_ANCHOR,
  organization_id: ALPHA_ORG_ID,
};

const MANUAL_ON_LEAD = {
  ...MANUAL_ON_JOB,
  id: '11110000-0000-0000-0000-000000000022',
  notes: 'Intro call before this ever became a job.',
  occurred_at: new Date('2026-06-01T13:00:00Z'),
  lead_id: 'e0000000-0000-0000-0000-000000000042',
  job_id: null,
  lead: LEAD_ANCHOR,
  job: null,
};

describe("getJobCommunications - a logged entry inherits the job's visibility", () => {
  it('reaches a requester whose Job scope covers the job it hangs off', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_JOB] });

    const items = await getJobCommunications(db, {
      jobId: JOB_ID,
      organizationId: ALPHA_ORG_ID,
      visibility: anchorInheritedWhere(ownJob(TECH_ID), { ...MATCH_NOTHING }),
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_JOB.id]);
    expect(items[0].manuallyLogged).toBe(true);
    // The job chip and the counterparty both come from the anchor - the entry stores neither.
    expect(items[0]).toMatchObject({ jobId: JOB_ID, jobLabel: 'J00001', who: 'Doe HVAC' });
  });

  it('is withheld from a requester whose Job scope does not', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_JOB] });

    const items = await getJobCommunications(db, {
      jobId: JOB_ID,
      organizationId: ALPHA_ORG_ID,
      // Same job, same entry - a technician assigned to somebody else's work.
      visibility: anchorInheritedWhere(ownJob(SOMEONE_ELSE), { ...MATCH_NOTHING }),
    });

    expect(items).toEqual([]);
  });
});

// ─── The title follows the CHANNEL (slice 6) ────────────────────────────────
//
// `mapManual` used to hardcode the noun "call" while reading the row's `channel` column, which
// was harmless only for as long as CALL was the only value anything could write. These drive the
// aggregator directly with rows as the DATABASE holds them, which is the only way to reach a
// pairing the API refuses to create - and refusing to create one is not a reason for the mapper
// to read it as a call.
describe('getJobCommunications - a logged entry reads as the channel it was logged on', () => {
  const on = (row: Record<string, any>) => ({ ...MANUAL_ON_JOB, ...row });

  it.each([
    ['CALL', 'Outbound call'],
    ['SMS', 'Outbound text'],
    ['EMAIL', 'Outbound email'],
  ])('titles a %s entry "%s"', async (channel, title) => {
    const db = stubDb({ manuals: [on({ channel })] });

    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items[0].title).toBe(title);
    expect(items[0].channel).toBe(channel.toLowerCase());
  });

  it('appends the subject of a logged email, and nothing when it has none', async () => {
    const withSubject = await getJobCommunications(
      stubDb({ manuals: [on({ channel: 'EMAIL', subject: 'Revised scope' })] }),
      { jobId: JOB_ID, organizationId: ALPHA_ORG_ID },
    );
    expect(withSubject[0].title).toBe('Outbound email · Revised scope');

    const without = await getJobCommunications(
      stubDb({ manuals: [on({ channel: 'EMAIL', subject: null })] }),
      { jobId: JOB_ID, organizationId: ALPHA_ORG_ID },
    );
    expect(without[0].title).toBe('Outbound email');
  });

  // A SUBJECT ON A CALL IS NOT A TITLE. The API refuses that pairing, but a column can still hold
  // one - a row written before the rule, or by a future path that forgets it - and the mapper's
  // answer must not be "call · <whatever was in the subject column>".
  it('ignores a subject sitting on a non-email row', async () => {
    const db = stubDb({ manuals: [on({ channel: 'CALL', subject: 'Revised scope' })] });

    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items[0].title).toBe('Outbound call');
  });
});

describe("getCustomerCommunications - a logged entry inherits its anchor's visibility", () => {
  const CUSTOMER_ARGS = { customerId: CUSTOMER_ID, organizationId: ALPHA_ORG_ID };

  it('reaches a requester whose scopes cover both the job and the lead the entries hang off', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, MANUAL_ON_JOB] });

    const items = await getCustomerCommunications(db, {
      ...CUSTOMER_ARGS,
      visibility: anchorInheritedWhere(ownJob(TECH_ID), ownLead(TECH_ID)),
    });

    // Ascending: the lead entry at 13:00, the job entry at 15:00.
    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_LEAD.id, MANUAL_ON_JOB.id]);
  });

  it('withholds the entry whose anchor the requester cannot see, and keeps the one they can', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, MANUAL_ON_JOB] });

    const items = await getCustomerCommunications(db, {
      ...CUSTOMER_ARGS,
      // On this customer's leads, on none of their jobs. Anchor precedence decides per entry, so
      // this must be a PARTIAL result - "all" and "none" would both pass a broken filter.
      visibility: anchorInheritedWhere(ownJob(SOMEONE_ELSE), ownLead(TECH_ID)),
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_LEAD.id]);
  });

  // THE CLOBBER. `visibility` is `{ OR: [...] }` for any row-restricted requester and is spread
  // LAST, so an anchor disjunction written as a top-level `OR` here is silently overwritten by
  // it - the customer filter vanishes and the roll-up hands back every logged entry the
  // requester can see, on whoever's customer page they happen to be standing.
  //
  // It takes BOTH halves to catch: a restricted requester (so `visibility` really carries an OR)
  // AND an entry on another customer that this requester is otherwise allowed to see. With
  // either half missing, the clobbered query answers correctly by accident.
  it('keeps the customer filter even for a row-restricted requester, whose visibility filter is itself an OR', async () => {
    // Another customer's lead - but one THIS technician walked, so nothing in the visibility
    // filter stops it. Only the customer filter can.
    const otherCustomersEntry = {
      ...MANUAL_ON_LEAD,
      id: '11110000-0000-0000-0000-000000000024',
      lead_id: 'e0000000-0000-0000-0000-000000000043',
      notes: "Another customer's lead entirely.",
      lead: { ...LEAD_ANCHOR, lead_number: 'L00099', customer_id: OTHER_CUSTOMER_ID, customer: null },
    };
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, MANUAL_ON_JOB, otherCustomersEntry] });

    const items = await getCustomerCommunications(db, {
      ...CUSTOMER_ARGS,
      visibility: anchorInheritedWhere(ownJob(TECH_ID), ownLead(TECH_ID)),
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_LEAD.id, MANUAL_ON_JOB.id]);
    expect(items.map((i: CommItem) => i.id)).not.toContain(otherCustomersEntry.id);
  });

  it('reaches the entry THROUGH its anchor, never by a customer column it does not have', async () => {
    // The entry names a lead belonging to ANOTHER customer. There is no customer_id on the row
    // for a query to fall back on, so if the anchor disjunction were dropped this would surface
    // on the wrong customer's roll-up.
    const elsewhere = {
      ...MANUAL_ON_LEAD,
      id: '11110000-0000-0000-0000-000000000023',
      lead: { ...LEAD_ANCHOR, customer_id: OTHER_CUSTOMER_ID, customer: null },
    };
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, elsewhere] });

    const items = await getCustomerCommunications(db, CUSTOMER_ARGS);

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_LEAD.id]);
  });
});

// ─── The CUSTOMER anchor (#2021) ────────────────────────────────────────────────────────────
//
// An entry can now be anchored on the customer ITSELF - no lead, no job. The roll-up gains a
// third disjunct, and it has to go INSIDE the existing conjunction for the reason the clobber
// test above spells out. This is the same trap one row further on, so it is tested the same way:
// a row-restricted requester, and another customer's entry that nothing but the customer filter
// excludes.
//
// The entry is one-directional by design: it is on the customer's timeline and on no lead's or
// job's. Both halves of that are asserted, because a later change to the aggregators could
// reverse it silently.

const MANUAL_ON_CUSTOMER = {
  ...MANUAL_ON_JOB,
  id: '11110000-0000-0000-0000-000000000025',
  notes: 'Rang Linda to check she was happy with the work. Nothing outstanding.',
  occurred_at: new Date('2026-06-01T17:00:00Z'),
  lead_id: null,
  job_id: null,
  customer_id: CUSTOMER_ID,
  lead: null,
  job: null,
  customer: COMM_CUSTOMER,
};

describe('getCustomerCommunications - an entry anchored on the customer itself', () => {
  const CUSTOMER_ARGS = { customerId: CUSTOMER_ID, organizationId: ALPHA_ORG_ID };

  it('appears on that customer\'s timeline, beside the entries reached through a lead and a job', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, MANUAL_ON_JOB, MANUAL_ON_CUSTOMER] });

    const items = await getCustomerCommunications(db, CUSTOMER_ARGS);

    // Ascending: lead 13:00, job 15:00, customer 17:00.
    expect(items.map((i: CommItem) => i.id)).toEqual([
      MANUAL_ON_LEAD.id,
      MANUAL_ON_JOB.id,
      MANUAL_ON_CUSTOMER.id,
    ]);
    const own = items.find((i: CommItem) => i.id === MANUAL_ON_CUSTOMER.id)!;
    expect(own.manuallyLogged).toBe(true);
    // The counterparty comes off the anchor, which here IS the customer - no lead or job stands
    // between them. A row that resolved `who` only through the other two would blank it.
    expect(own.who).toBe('Doe HVAC');
    // …and it carries no job or lead chip, because it hangs off neither.
    expect(own.jobId).toBeUndefined();
    expect(own.leadId).toBeUndefined();
  });

  it('does not surface on ANOTHER customer\'s roll-up', async () => {
    const elsewhere = {
      ...MANUAL_ON_CUSTOMER,
      id: '11110000-0000-0000-0000-000000000026',
      customer_id: OTHER_CUSTOMER_ID,
      customer: null,
    };
    const db = stubDb({ manuals: [MANUAL_ON_CUSTOMER, elsewhere] });

    const items = await getCustomerCommunications(db, CUSTOMER_ARGS);

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_CUSTOMER.id]);
  });

  // THE CLOBBER, one disjunct further on. A customer-anchored row has lead_id AND job_id null,
  // so it lands in anchorInheritedWhere's unconditional third branch and NOTHING in the
  // visibility filter excludes it - the customer filter is the only thing standing between this
  // requester and every customer-anchored entry in the organisation. Hoist the new disjunct out
  // of the AND and the spread below overwrites it.
  it('keeps the customer filter for a row-restricted requester, whose visibility filter is itself an OR', async () => {
    const elsewhere = {
      ...MANUAL_ON_CUSTOMER,
      id: '11110000-0000-0000-0000-000000000027',
      customer_id: OTHER_CUSTOMER_ID,
      customer: null,
      notes: "Another customer's account call entirely.",
    };
    const db = stubDb({ manuals: [MANUAL_ON_CUSTOMER, elsewhere] });

    const items = await getCustomerCommunications(db, {
      ...CUSTOMER_ARGS,
      visibility: anchorInheritedWhere(ownJob(TECH_ID), ownLead(TECH_ID)),
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_CUSTOMER.id]);
    expect(items.map((i: CommItem) => i.id)).not.toContain(elsewhere.id);
  });
});

describe('a customer-anchored entry stays OFF the lead and job timelines', () => {
  it('is absent from the timeline of a job belonging to that same customer', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_JOB, MANUAL_ON_CUSTOMER] });

    const items = await getJobCommunications(db, { jobId: JOB_ID, organizationId: ALPHA_ORG_ID });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_JOB.id]);
  });

  it('is absent from the timeline of a lead belonging to that same customer', async () => {
    const db = stubDb({ manuals: [MANUAL_ON_LEAD, MANUAL_ON_CUSTOMER] });

    const items = await getLeadCommunications(db, {
      leadId: MANUAL_ON_LEAD.lead_id,
      organizationId: ALPHA_ORG_ID,
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ON_LEAD.id]);
  });
});

// ─── Route: GET /api/jobs/:id/communications ────────────

describe('GET /api/jobs/:id/communications', () => {
  it('returns the unioned ascending timeline for the job', async () => {
    mockAuthAs('admin');
    (prisma.job.findUnique as Mock).mockResolvedValue({ id: JOB_ID });
    (prisma.callSession.findMany as Mock).mockResolvedValue([CALL_ROW]);
    (prisma.message.findMany as Mock).mockResolvedValue([SMS_ROW]);
    (prisma.email.findMany as Mock).mockResolvedValue([EMAIL_ROW]);
    (prisma.whatsAppMessage.findMany as Mock).mockResolvedValue([WA_ROW]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items.map((i: CommItem) => i.channel)).toEqual(['email', 'call', 'sms', 'whatsapp']);
    expect(res.body.items[1]).toMatchObject({ jobId: JOB_ID, jobLabel: 'J00001', who: 'Doe HVAC' });
  });

  it('returns 404 for a cross-org job (org-B admin)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Job not found' });
    expectOrgScoped(prisma.job.findUnique as Mock, ORG_B_ID);
    expect(prisma.callSession.findMany as Mock).not.toHaveBeenCalled();
  });

  it('returns { items: [] } for a job with no communications', async () => {
    mockAuthAs('admin');
    (prisma.job.findUnique as Mock).mockResolvedValue({ id: JOB_ID });
    (prisma.callSession.findMany as Mock).mockResolvedValue([]);
    (prisma.message.findMany as Mock).mockResolvedValue([]);
    (prisma.email.findMany as Mock).mockResolvedValue([]);
    (prisma.whatsAppMessage.findMany as Mock).mockResolvedValue([]);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  // Email slice 8a gave TECHNICIAN `read Communication`, so the ROUTE guard no
  // longer stops them here - the ROW gate does. A technician who is not assigned
  // to this job still gets 403 and the aggregator is still never queried; what
  // changed is which check refuses, not whether one does. (The point of the
  // grant is the OTHER case: a technician CAN now read the history on a job they
  // are on, which is the whole reason anchor inheritance exists.)
  it('TECHNICIAN on a job they are not assigned to → 403 (aggregator never queried)', async () => {
    mockAuthAs('technician');
    (prisma.job.findUnique as Mock).mockResolvedValue({ id: JOB_ID });
    // canAccessRow probes the OWN_JOB scope via job.findFirst.
    (prisma.job.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(prisma.callSession.findMany as Mock).not.toHaveBeenCalled();
    expect(prisma.message.findMany as Mock).not.toHaveBeenCalled();
    expect(prisma.email.findMany as Mock).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.findMany as Mock).not.toHaveBeenCalled();
  });
});

// ─── Route: GET /api/customers/:id/communications ───────

describe('GET /api/customers/:id/communications', () => {
  it('returns all four channels for the customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue({ id: CUSTOMER_ID });
    (prisma.callSession.findMany as Mock).mockResolvedValue([CALL_ROW]);
    (prisma.message.findMany as Mock).mockResolvedValue([SMS_ROW]);
    (prisma.email.findMany as Mock).mockResolvedValue([EMAIL_ROW]);
    (prisma.whatsAppMessage.findMany as Mock).mockResolvedValue([WA_ROW]);

    const res = await request(app).get(`/api/customers/${CUSTOMER_ID}/communications`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items.map((i: CommItem) => i.channel)).toEqual(['email', 'call', 'sms', 'whatsapp']);
    // customer linkage wiring: sms via thread, whatsapp via chat
    expect(prisma.message.findMany as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ thread: { customer_id: CUSTOMER_ID } }) })
    );
    expect(prisma.whatsAppMessage.findMany as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ chat: { customer_id: CUSTOMER_ID } }) })
    );
  });

  it('returns 404 for a cross-org customer (org-B admin)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app).get(`/api/customers/${CUSTOMER_ID}/communications`).set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
    expectOrgScoped(prisma.customer.findUnique as Mock, ORG_B_ID);
    expect(prisma.callSession.findMany as Mock).not.toHaveBeenCalled();
  });

  it('returns 403 when the role lacks read Communication (technician)', async () => {
    mockAuthAs('technician');

    const res = await request(app).get(`/api/customers/${CUSTOMER_ID}/communications`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(prisma.customer.findUnique as Mock).not.toHaveBeenCalled();
  });
});
