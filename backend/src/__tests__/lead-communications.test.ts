// Slice E4 — lead communications aggregator (Communication ↔ Leads).
//
// Full job-parity ruling (2026-07-22, Ran): "The leads' communication should
// behave exactly like job does... The behavior should be the same." The lead
// timeline used to UNION lead_id-linked rows with the customer's entire comm
// history (Lead.customer_id is a required relation, so the customer arm alone
// pulled in every job/lead that customer ever had). It now scopes STRICTLY by
// lead_id, mirroring getJobCommunications' job_id scoping exactly — one direct
// query per channel, no OR/union:
//
//   callSession / message / email  →  { lead_id }               (direct FK — Message gained
//                                                                  its own lead_id column,
//                                                                  mirroring job_id, in this fix)
//   whatsapp                       →  chat: { lead_id }          (relation — WhatsAppMessage
//                                                                  has no lead_id of its own)
//
// Accepted consequence: a row whose lead_id is null (e.g. phone-matched to the
// customer but never explicitly attributed to THIS lead) no longer appears,
// even though it belongs to the same customer — same as an un-job-tagged row
// never appearing on a job's timeline. Not a bug; this is the ruling.
//
// Also covered: sendMessage leadId stamping — a created/found thread carries
// lead_id (unchanged); AND (new) the Message row itself now carries lead_id
// too, mirroring how job_id is stamped on the same create.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  mockAuthAs, authHeader, matchesScopeWhere,
  ALPHA_ORG_ID, ORG_B_ID,
  CUSTOMER_FIXTURE, LEAD_FIXTURE,
} from './helpers';
import { getLeadCommunications } from '../lib/job-communications';
import type { CommItem } from '../lib/job-communications';
import { anchorInheritedWhere } from '../lib/permissions/anchorVisibility';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) })
  );
}

// ─── Fixtures ───────────────────────────────────────────

const LEAD_ID = LEAD_FIXTURE.id;
const OTHER_LEAD_ID = 'e0000000-0000-0000-0000-000000000077';
const CUSTOMER_ID = CUSTOMER_FIXTURE.id;

const COMM_CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'John',
  last_name: 'Doe',
  company_name: 'Doe HVAC',
};

const LEAD_CALL = {
  id: 'ca000000-0000-0000-0000-000000000011',
  direction: 'out',
  from_number: '+15125550100',
  to_number: '+12125551042',
  status: 'completed',
  duration_sec: 61,
  started_at: new Date('2026-06-01T14:32:00Z'),
  disposition: null,
  summary: 'Intro call — walked through the service request.',
  lead_id: LEAD_ID,
  customer_id: CUSTOMER_ID,
  customer: COMM_CUSTOMER,
  job_id: null,
  job_label: null,
  organization_id: ALPHA_ORG_ID,
};

const LEAD_MESSAGE = {
  id: 'aa000000-0000-0000-0000-000000000011',
  thread_id: 'ab000000-0000-0000-0000-000000000011',
  direction: 'out',
  body: 'Confirming Thursday 8am for the walkthrough.',
  ts: new Date('2026-06-01T14:40:00Z'),
  status: 'delivered',
  job_id: null,
  job_label: null,
  lead_id: LEAD_ID,
  thread: { customer_id: CUSTOMER_ID, title: null, customer: COMM_CUSTOMER },
  organization_id: ALPHA_ORG_ID,
};

const LEAD_EMAIL = {
  id: 'ac000000-0000-0000-0000-000000000011',
  account: 'main',
  from: { name: 'John Doe', email: 'john@doe.com' },
  to: 'office@servwave.com',
  subject: 'Gate access for the visit',
  snippet: 'Use the side entrance, code 4411.',
  body: {},
  at: 'Mon 9:12a',
  ts: 1780000000000n,
  created_at: new Date('2026-06-01T09:12:00Z'),
  folder: 'inbox',
  customer_id: CUSTOMER_ID,
  lead_id: LEAD_ID,
  job_id: null,
  job_label: null,
  customer: COMM_CUSTOMER,
  organization_id: ALPHA_ORG_ID,
};

const LEAD_WA_ROW = {
  id: 'ad000000-0000-0000-0000-000000000011',
  chat_id: 'ae000000-0000-0000-0000-000000000011',
  from: 'them',
  text: 'Thursday works for the walkthrough.',
  at: '6:44 PM',
  status: null,
  created_at: new Date('2026-06-01T18:44:00Z'),
  job_id: null,
  job_label: null,
  chat: { lead_id: LEAD_ID, customer_id: CUSTOMER_ID, name: 'Daniel Cohen', phone: '+12125551042', customer: COMM_CUSTOMER },
  organization_id: ALPHA_ORG_ID,
};

// Same customer, a DIFFERENT lead — must be excluded. This is the exact case
// the old customer-history union got wrong (it pulled in every lead the
// customer ever had); the fix is precisely to exclude these.
const SAME_CUSTOMER_OTHER_LEAD_CALL = { ...LEAD_CALL, id: 'ca000000-0000-0000-0000-000000000012', lead_id: OTHER_LEAD_ID };
const SAME_CUSTOMER_OTHER_LEAD_MESSAGE = { ...LEAD_MESSAGE, id: 'aa000000-0000-0000-0000-000000000012', lead_id: OTHER_LEAD_ID };
const SAME_CUSTOMER_OTHER_LEAD_EMAIL = { ...LEAD_EMAIL, id: 'ac000000-0000-0000-0000-000000000012', lead_id: OTHER_LEAD_ID };
const SAME_CUSTOMER_OTHER_LEAD_WA_ROW = {
  ...LEAD_WA_ROW, id: 'ad000000-0000-0000-0000-000000000012',
  chat: { ...LEAD_WA_ROW.chat, lead_id: OTHER_LEAD_ID },
};

// Same customer, NO lead link at all — the accepted behavioral consequence:
// a customer-linked row with lead_id NULL must also be excluded.
const SAME_CUSTOMER_NO_LEAD_CALL = { ...LEAD_CALL, id: 'ca000000-0000-0000-0000-000000000013', lead_id: null };
const SAME_CUSTOMER_NO_LEAD_MESSAGE = { ...LEAD_MESSAGE, id: 'aa000000-0000-0000-0000-000000000013', lead_id: null };
const SAME_CUSTOMER_NO_LEAD_EMAIL = { ...LEAD_EMAIL, id: 'ac000000-0000-0000-0000-000000000013', lead_id: null };
const SAME_CUSTOMER_NO_LEAD_WA_ROW = {
  ...LEAD_WA_ROW, id: 'ad000000-0000-0000-0000-000000000013',
  chat: { ...LEAD_WA_ROW.chat, lead_id: null },
};

// ─── Stub db (lib unit tests) ───────────────────────────

type Row = Record<string, any>;

/**
 * Evaluate the anchor-inherited visibility fragment (`anchorInheritedWhere`) against a fixture
 * row. It emits three mutually exclusive OR branches, each pinning job_id/lead_id nullness and
 * optionally nesting a row-scope under the `job` / `lead` relation — the nullness pins are
 * handled here (`{ not: null }` is not a scope fragment) and the nested scope is handed to
 * `matchesScopeWhere`, the shared evaluator the permissions suites already use.
 *
 * A `where` carrying no OR is unrestricted and matches everything, exactly as it would in SQL —
 * which is what makes this faithful enough to catch a DROPPED `...visibility` spread rather than
 * merely to describe one.
 */
function matchesVisibility(where: Row, row: Row): boolean {
  const branches = where.OR as Row[] | undefined;
  if (!branches) return true;
  return branches.some((branch) =>
    Object.entries(branch).every(([key, value]) => {
      if (key === 'job_id' || key === 'lead_id') {
        return value === null ? row[key] == null : row[key] != null;
      }
      return matchesScopeWhere({ [key]: value }, row);
    })
  );
}

/** findMany stub that actually applies the strict lead_id filter (direct on
 *  the row, or through the chat relation for whatsapp) and the anchor-inherited
 *  visibility filter, so exclusion is genuinely exercised — same shape as
 *  job-communications.test.ts's stub. */
function filteringFindMany(rows: Row[]) {
  return vi.fn(async ({ where }: { where: Row }) =>
    rows.filter((r) =>
      r.organization_id === where.organization_id &&
      (where.lead_id === undefined || r.lead_id === where.lead_id) &&
      (where.chat?.lead_id === undefined || r.chat?.lead_id === where.chat.lead_id) &&
      matchesVisibility(where, r)
    )
  );
}

function stubDb(
  rows: { calls?: Row[]; messages?: Row[]; emails?: Row[]; whatsapps?: Row[]; manuals?: Row[] } = {}
) {
  return {
    callSession: { findMany: filteringFindMany(rows.calls ?? []) },
    message: { findMany: filteringFindMany(rows.messages ?? []) },
    email: { findMany: filteringFindMany(rows.emails ?? []) },
    whatsAppMessage: { findMany: filteringFindMany(rows.whatsapps ?? []) },
    // Fifth source (manual communication log). Empty unless a spec supplies rows: this suite is
    // about the four REAL channels, and the manual source has its own suite
    // (comm-manual-log.test.ts) — except for the visibility filter below, which is a property of
    // THIS aggregator's query and has nowhere else to live.
    manualCommunicationLog: { findMany: filteringFindMany(rows.manuals ?? []) },
  };
}

const LEAD_ARGS = { leadId: LEAD_ID, organizationId: ALPHA_ORG_ID };

// ─── Lib: getLeadCommunications ─────────────────────────

describe('getLeadCommunications (lib)', () => {
  it('returns only lead_id-matched rows across all four channels, sorted ascending', async () => {
    const db = stubDb({
      calls: [LEAD_CALL, SAME_CUSTOMER_OTHER_LEAD_CALL, SAME_CUSTOMER_NO_LEAD_CALL],
      messages: [LEAD_MESSAGE, SAME_CUSTOMER_OTHER_LEAD_MESSAGE, SAME_CUSTOMER_NO_LEAD_MESSAGE],
      emails: [LEAD_EMAIL, SAME_CUSTOMER_OTHER_LEAD_EMAIL, SAME_CUSTOMER_NO_LEAD_EMAIL],
      whatsapps: [LEAD_WA_ROW, SAME_CUSTOMER_OTHER_LEAD_WA_ROW, SAME_CUSTOMER_NO_LEAD_WA_ROW],
    });
    const items = await getLeadCommunications(db, LEAD_ARGS);

    expect(items).toHaveLength(4);
    expect(items.map((i: CommItem) => i.id)).toEqual([
      LEAD_EMAIL.id,   // 09:12
      LEAD_CALL.id,    // 14:32
      LEAD_MESSAGE.id, // 14:40
      LEAD_WA_ROW.id,  // 18:44
    ]);
    expect(items.map((i: CommItem) => i.channel)).toEqual(['email', 'call', 'sms', 'whatsapp']);
    const times = items.map((i: CommItem) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("excludes a customer-but-not-this-lead row (same customer, DIFFERENT lead) across every channel", async () => {
    const db = stubDb({
      calls: [SAME_CUSTOMER_OTHER_LEAD_CALL],
      messages: [SAME_CUSTOMER_OTHER_LEAD_MESSAGE],
      emails: [SAME_CUSTOMER_OTHER_LEAD_EMAIL],
      whatsapps: [SAME_CUSTOMER_OTHER_LEAD_WA_ROW],
    });
    const items = await getLeadCommunications(db, LEAD_ARGS);
    expect(items).toEqual([]);
  });

  it('excludes a same-customer row with NO lead link at all (accepted consequence — no customer-history fallback)', async () => {
    const db = stubDb({
      calls: [SAME_CUSTOMER_NO_LEAD_CALL],
      messages: [SAME_CUSTOMER_NO_LEAD_MESSAGE],
      emails: [SAME_CUSTOMER_NO_LEAD_EMAIL],
      whatsapps: [SAME_CUSTOMER_NO_LEAD_WA_ROW],
    });
    const items = await getLeadCommunications(db, LEAD_ARGS);
    expect(items).toEqual([]);
  });

  it('queries each channel org-scoped by lead_id ONLY — no customer_id arm, direct FK for call/message/email, chat relation for whatsapp', async () => {
    const db = stubDb();
    await getLeadCommunications(db, LEAD_ARGS);

    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(db.email.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(db.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(db.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ALPHA_ORG_ID, chat: { lead_id: LEAD_ID } } })
    );
    // Same CommItem pipeline as the job/customer aggregators — the call query
    // keeps the job join (job_number fallback for pre-job_label rows).
    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ job: { select: { job_number: true } } }) })
    );
  });

  it('returns [] for a lead with no communications', async () => {
    const items = await getLeadCommunications(stubDb(), LEAD_ARGS);
    expect(items).toEqual([]);
  });

  // Closes the loop with ctm-webhook.test.ts's "lands lead_id on the created
  // MESSAGE itself" test: once ingestSms stamps lead_id on a phone-matched
  // inbound webhook row, getLeadCommunications (which filters strictly on
  // Message.lead_id) must actually surface it — an inbound CTM reply, not
  // just an outbound compose, appears on the lead's Communication tab.
  it('surfaces an inbound CTM-webhook message once it carries lead_id (the row shape ingestSms now produces)', async () => {
    const inboundWebhookMessage = {
      id: 'aa000000-0000-0000-0000-000000000099',
      thread_id: 'ab000000-0000-0000-0000-000000000099',
      direction: 'in',
      body: 'Sounds good',
      ts: new Date('2026-06-02T09:00:00Z'),
      status: 'received',
      ctm_sms_id: 'MSG9001',
      job_id: null,
      job_label: null,
      lead_id: LEAD_ID,
      thread: { customer_id: CUSTOMER_ID, title: null, customer: COMM_CUSTOMER },
      organization_id: ALPHA_ORG_ID,
    };
    const db = stubDb({ messages: [inboundWebhookMessage] });
    const items = await getLeadCommunications(db, LEAD_ARGS);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(inboundWebhookMessage.id);
    expect(items[0].direction).toBe('in');
  });

  // ── Additive CommItem fields (slice E3/E6) on the lead-scoped query ──────

  it('stamps leadId/leadLabel on every matched row (message now reads its own lead_id, not thread.lead_id)', async () => {
    const db = stubDb({
      calls: [{ ...LEAD_CALL, lead: { lead_number: 'L00001' }, answered_by: { kind: 'csr', ctm_agent_id: '7', name: 'Dana Reyes', email: 'dana@alpha.com' } }],
      messages: [{ ...LEAD_MESSAGE, lead: { lead_number: 'L00001' } }],
      emails: [{ ...LEAD_EMAIL, lead: { lead_number: 'L00001' } }],
      whatsapps: [{ ...LEAD_WA_ROW, chat: { ...LEAD_WA_ROW.chat, lead: { lead_number: 'L00001' } } }],
    });
    const items = await getLeadCommunications(db, LEAD_ARGS);

    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.leadId).toBe(LEAD_ID);
      expect(item.leadLabel).toBe('L00001');
    }
    const call = items.find((i: CommItem) => i.channel === 'call')!;
    expect(call.answeredBy).toBe('Dana Reyes');
    const wa = items.find((i: CommItem) => i.channel === 'whatsapp')!;
    expect('answeredBy' in wa).toBe(false);
  });

  it('carries the lean lead/agent joins on every channel query, including a top-level lead join on message (mirrors job_id being message-level)', async () => {
    const db = stubDb();
    await getLeadCommunications(db, LEAD_ARGS);

    expect(db.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          lead: { select: { lead_number: true } },
          agent: { select: { first_name: true, last_name: true } },
        }),
      })
    );
    expect(db.email.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ lead: { select: { lead_number: true } } }),
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
    expect(db.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          chat: {
            select: expect.objectContaining({ lead_id: true, lead: { select: { lead_number: true } } }),
          },
        },
      })
    );
  });
});

// ─── Anchor-inherited visibility over the manual communication log ───────────
//
// A logged entry is queried with the SAME `...visibility` spread as the four real channels, so
// it inherits the anchor rule: whoever can see the lead can see what was logged on it, and
// whoever cannot, cannot. Nothing asserted that until now — delete the spread from the manual
// arm of getLeadCommunications and every other suite stays green while a technician who never
// walked the lead starts reading its hand-typed history.
//
// The fragment is built by the REAL anchorInheritedWhere and really evaluated by the stub, so
// both outcomes below are behaviour rather than a canned empty result.

const WALKER_ID = '00000000-0000-0000-0000-000000000004';
const NO_JOB_GRANT = { id: { in: [] as string[] } };          // MATCH_NOTHING — no read Job
const OWN_LEAD = { lead_assignees: { some: { user_id: WALKER_ID } } };

/** A logged entry hanging off LEAD_ID. `lead` carries what the mapper reads AND what the
 *  visibility fragment probes — the same relation, read by both. */
const MANUAL_ENTRY = {
  id: '11110000-0000-0000-0000-000000000011',
  channel: 'CALL',
  direction: 'OUT',
  occurred_at: new Date('2026-06-01T15:00:00Z'),
  notes: 'Called from my mobile — he wants a quote for the two garage doors.',
  lead_id: LEAD_ID,
  job_id: null,
  organization_id: ALPHA_ORG_ID,
  lead: {
    id: LEAD_ID,
    lead_number: LEAD_FIXTURE.lead_number,
    customer: COMM_CUSTOMER,
    lead_assignees: [{ user_id: WALKER_ID }],
  },
};

describe('getLeadCommunications — a manually logged entry inherits the lead\'s visibility', () => {
  it('reaches a requester whose Lead scope covers the lead it hangs off', async () => {
    const db = stubDb({ manuals: [MANUAL_ENTRY] });

    const items = await getLeadCommunications(db, {
      ...LEAD_ARGS,
      visibility: anchorInheritedWhere(NO_JOB_GRANT, OWN_LEAD),
    });

    expect(items.map((i: CommItem) => i.id)).toEqual([MANUAL_ENTRY.id]);
    expect(items[0].manuallyLogged).toBe(true);
  });

  it('is withheld from a requester whose Lead scope does not', async () => {
    const db = stubDb({ manuals: [MANUAL_ENTRY] });
    // Same entry, same lead — a rep assigned to somebody else's leads.
    const someoneElse = { lead_assignees: { some: { user_id: '00000000-0000-0000-0000-0000000000ff' } } };

    const items = await getLeadCommunications(db, {
      ...LEAD_ARGS,
      visibility: anchorInheritedWhere(NO_JOB_GRANT, someoneElse),
    });

    expect(items).toEqual([]);
  });
});

// ─── Route: GET /api/leads/:id/communications ───────────

describe('GET /api/leads/:id/communications', () => {
  function mockChannels(rows: { calls?: Row[]; messages?: Row[]; emails?: Row[]; whatsapps?: Row[] } = {}) {
    mockPrisma.callSession.findMany.mockResolvedValue(rows.calls ?? []);
    mockPrisma.message.findMany.mockResolvedValue(rows.messages ?? []);
    mockPrisma.email.findMany.mockResolvedValue(rows.emails ?? []);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue(rows.whatsapps ?? []);
  }

  it('returns the strictly lead-scoped ascending timeline (no customer_id arm in any query)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockChannels({
      calls: [LEAD_CALL],
      messages: [LEAD_MESSAGE],
      emails: [LEAD_EMAIL],
      whatsapps: [LEAD_WA_ROW],
    });

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items.map((i: CommItem) => i.channel)).toEqual(['email', 'call', 'sms', 'whatsapp']);

    expect(mockPrisma.callSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(mockPrisma.email.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(mockPrisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lead_id: LEAD_ID, organization_id: ALPHA_ORG_ID } })
    );
    expect(mockPrisma.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ALPHA_ORG_ID, chat: { lead_id: LEAD_ID } } })
    );
  });

  it('returns 404 for a cross-org/unknown lead — no aggregation queries fired', async () => {
    mockAuthAs('orgB_admin');
    mockPrisma.lead.findUnique.mockResolvedValue(null);
    mockChannels();

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expectOrgScoped(mockPrisma.lead.findUnique as Mock, ORG_B_ID);
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  // Email slice 8a gave TECHNICIAN `read Communication`, so the ROUTE guard no
  // longer stops them here - the ROW gate does. A technician who did not walk
  // this lead still gets 403 and the aggregator is still never queried; what
  // changed is which check refuses, not whether one does.
  it('TECHNICIAN on a lead they did not walk → 403 (aggregator never queried)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // canAccessRow probes the OWN_WALKTHROUGH scope via lead.findFirst.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('SALES requesting comms on a lead they do NOT own → 403 (aggregator never queried)', async () => {
    mockAuthAs('sales');
    // Lead exists in-tenant (existence load) …
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // … but canAccessRow probes the OWN_LEAD scope via lead.findFirst → not visible.
    mockPrisma.lead.findFirst.mockResolvedValue(null);
    mockChannels();

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 200 + the comms timeline for their own lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // Owner → canAccessRow's scoped findFirst matches.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockChannels({ calls: [LEAD_CALL] });

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].channel).toBe('call');
  });
});

// ─── sendMessage: leadId stamping ───────────────────────

describe('POST /api/communication/sms — leadId stamping', () => {
  const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000002';
  const MSG_ID = '99990000-0000-0000-0000-000000000011';

  function mockLeadLookup(customerId: string = CUSTOMER_ID) {
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID, customer_id: customerId });
  }

  function mockFoundThread(overrides: Record<string, unknown> = {}) {
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, channel: 'sms', campaign_type: 'customer_care', unread: 0,
      customer_id: CUSTOMER_ID, lead_id: null, vendor_id: null, kind: null, title: null,
      organization_id: ALPHA_ORG_ID, ...overrides,
    });
  }

  function mockMessageCreate() {
    mockPrisma.message.create.mockImplementation((a: any) =>
      Promise.resolve({ id: MSG_ID, ts: new Date(), ...a.data }));
  }

  function mockThreadCreate() {
    mockPrisma.messageThread.create.mockImplementation((a: any) =>
      Promise.resolve({ id: THREAD_ID, unread: 0, ...a.data }));
  }

  it('stamps lead_id on the thread AND the message row itself on the customerId path (full job-parity — mirrors job_id)', async () => {
    mockAuthAs('dispatcher');
    mockLeadLookup();
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null); // no existing thread
    mockThreadCreate();
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_ID, body: 'Following up on your request', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    expectOrgScoped(mockPrisma.lead.findFirst as Mock, ALPHA_ORG_ID);
    const threadData = mockPrisma.messageThread.create.mock.calls[0][0].data;
    expect(threadData.customer_id).toBe(CUSTOMER_ID);
    expect(threadData.lead_id).toBe(LEAD_ID);
    // The freshly created thread already carries the link — no backfill update.
    expect(mockPrisma.messageThread.update).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    // NEW: the Message row itself carries lead_id — verified against the DB
    // write, not just the response shape (mirrors job_id on the same create).
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBe(LEAD_ID);
    expect(res.body.message.leadId).toBe(LEAD_ID);
  });

  it('backfills lead_id on an existing lead-less thread found on the customerId path, and stamps the message too', async () => {
    mockAuthAs('dispatcher');
    mockLeadLookup();
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockFoundThread(); // existing customer thread, lead_id NULL
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_ID, body: 'Following up', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
    expect(mockPrisma.messageThread.update).toHaveBeenCalledWith({
      where: { id: THREAD_ID },
      data: { lead_id: LEAD_ID },
    });
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBe(LEAD_ID);
  });

  it('404s a cross-org/unknown leadId — no thread or message created', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.lead.findFirst.mockResolvedValue(null); // tenant-scoped lookup misses
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_ID, body: 'hi', leadId: LEAD_ID });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Lead not found' });
    expect(mockPrisma.messageThread.create).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
  });

  it('backfills lead_id on a found lead-less same-customer thread (threadId path), and stamps the message too', async () => {
    mockAuthAs('dispatcher');
    mockLeadLookup();
    mockFoundThread();
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'About your walkthrough', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.update).toHaveBeenCalledWith({
      where: { id: THREAD_ID },
      data: { lead_id: LEAD_ID },
    });
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBe(LEAD_ID);
  });

  it('NEVER overwrites a different existing lead_id on the thread, but still stamps the message with the requested leadId', async () => {
    mockAuthAs('dispatcher');
    mockLeadLookup();
    mockFoundThread({ lead_id: OTHER_LEAD_ID });
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello again', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.update).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBe(LEAD_ID);
  });

  it('does not backfill a lead-less thread owned by a DIFFERENT customer, and does NOT stamp the mismatched lead_id on the message either (cross-entity guard)', async () => {
    mockAuthAs('dispatcher');
    mockLeadLookup(CUSTOMER_ID); // lead belongs to CUSTOMER_ID …
    mockFoundThread({ customer_id: 'c0000000-0000-0000-0000-000000000099' }); // … thread to another customer
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'hello', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.messageThread.update).not.toHaveBeenCalled();
    // The bug this guards: without a same-customer check on the message stamp
    // itself, this mismatched lead_id would still land on the message row and
    // leak onto Lead A's Communication tab even though the thread belongs to
    // an unrelated customer.
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBeFalsy();
    expect(res.body.message).not.toHaveProperty('leadId');
  });

  it('a mismatched customerId/leadId pair on a BRAND NEW thread never stamps lead_id on the thread OR the message (cross-entity guard, mirrors jobStamp)', async () => {
    mockAuthAs('dispatcher');
    // Lead belongs to a DIFFERENT customer than the one this send targets.
    mockLeadLookup('c0000000-0000-0000-0000-000000000099');
    mockPrisma.customer.findFirst.mockResolvedValue(CUSTOMER_FIXTURE); // customerId = CUSTOMER_ID
    mockPrisma.messageThread.findFirst.mockResolvedValue(null); // no existing thread
    mockThreadCreate();
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ customerId: CUSTOMER_ID, body: 'Following up on your request', leadId: LEAD_ID });

    expect(res.status).toBe(201);
    const threadData = mockPrisma.messageThread.create.mock.calls[0][0].data;
    expect(threadData.lead_id).toBeFalsy();
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBeFalsy();
    expect(res.body.message).not.toHaveProperty('leadId');
  });

  it('omitted leadId → no lead lookups, thread untouched, message carries no lead_id (regression)', async () => {
    mockAuthAs('dispatcher');
    mockFoundThread();
    mockMessageCreate();

    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'plain send, no lead context' });

    expect(res.status).toBe(201);
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.messageThread.update).not.toHaveBeenCalled();
    expect(mockPrisma.message.create).toHaveBeenCalledTimes(1);
    const messageData = mockPrisma.message.create.mock.calls[0][0].data;
    expect(messageData.lead_id).toBeUndefined();
    expect(res.body.message).not.toHaveProperty('leadId');
  });
});
