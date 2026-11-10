import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { matchesWhere, type Row } from './whereMatcher';

/**
 * Roles & Permissions S08.5: the text inbox follows Communication scope. As in comm-call-log-scope.test.ts, every
 * assertion captures the `where` (and the nested messages filter) the handler handed the database and runs fixture
 * rows through it, never the rendered payload: the messages a person must not read have to be absent from the QUERY.
 * The stored switch values, not the role name, decide what each person sees.
 */

const mockPrisma = prisma as any;
const ME = TEST_USERS.dispatcher.id;
const LINKED = 'a1000000-0000-4000-8000-000000000001';
const UNLINKED = 'a1000000-0000-4000-8000-000000000002';
const MAIN_LINE = 'a1000000-0000-4000-8000-0000000000ff';
const MY_JOB = { id: 'ab000000-0000-0000-0000-00000000000a', visits: [{ assignees: [{ user_id: ME }] }] };
const OTHER_JOB = { id: 'ab000000-0000-0000-0000-00000000000b', visits: [{ assignees: [{ user_id: 'someone-else' }] }] };
const THREAD_ID = 'a9999999-9999-4999-8999-999999999999';

/** One text message; the customer tie sits on its conversation, so the fixture nests it the way the query reads it. */
function message(id: string, fields: Partial<Row> = {}, thread: Partial<Row> = {}): Row {
  return {
    id, organization_id: ALPHA_ORG_ID, direction: 'in', phone_number_id: null, sent_by_user_id: null,
    job_id: null, job: null, lead_id: null, lead: null,
    thread: { user_id: null, customer_id: null, customer: null, vendor_id: null, ...thread },
    ...fields,
  };
}
const ON_LINKED = message('d0000000-0000-4000-8000-000000000001', { phone_number_id: LINKED });
const ON_UNLINKED = message('d0000000-0000-4000-8000-000000000002', { phone_number_id: UNLINKED });
const SENT_BY_ME_ON_MAIN_LINE = message('d0000000-0000-4000-8000-000000000003', { direction: 'out', phone_number_id: MAIN_LINE, sent_by_user_id: ME });
const NO_NUMBER = message('d0000000-0000-4000-8000-000000000004');
const ON_MAIN_LINE = message('d0000000-0000-4000-8000-000000000005', { phone_number_id: MAIN_LINE });
const ON_MY_JOB_UNLINKED = message('d0000000-0000-4000-8000-000000000006', { phone_number_id: UNLINKED, job_id: MY_JOB.id, job: MY_JOB });
const ON_OTHER_JOB_UNLINKED = message('d0000000-0000-4000-8000-000000000007', { phone_number_id: UNLINKED, job_id: OTHER_JOB.id, job: OTHER_JOB });
const ALL = [ON_LINKED, ON_UNLINKED, SENT_BY_ME_ON_MAIN_LINE, NO_NUMBER, ON_MAIN_LINE, ON_MY_JOB_UNLINKED, ON_OTHER_JOB_UNLINKED];

const visible = (where: Record<string, unknown>) => ALL.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
const conversation = (...messages: Row[]): Row => ({ id: THREAD_ID, organization_id: ALPHA_ORG_ID, messages });

const firstArg = (fn: Mock, call = 0) => {
  expect(fn, 'expected the handler to query prisma').toHaveBeenCalled();
  return fn.mock.calls[call][0];
};
const capturedWhere = (fn: Mock, call = 0) => firstArg(fn, call).where as Record<string, unknown>;
/** The route's own read of one conversation: the last one. Before it, the read scope looks up the conversation's number (#3021). */
const lastCall = (fn: Mock) => fn.mock.calls.length - 1;
/** The filter the handler put on the nested `messages` of the conversation(s) it read. */
const nestedMessages = (fn: Mock, call = 0) => (firstArg(fn, call).include ?? firstArg(fn, call).select).messages.where as Record<string, unknown>;

/** The person's Settings > Caller ID links, as the database would answer them. */
function linkNumbers(...ids: string[]) {
  mockPrisma.userPhoneNumber.findMany.mockResolvedValue(ids.map((phone_number_id) => ({ phone_number_id })));
}

function signInNarrow(extra: Record<string, boolean | string> = {}) {
  mockAuthAs('dispatcher');
  mockRoleSwitches({
    communication_scope: 'attached', see_main_line_when_no_number: false, view_jobs: true, jobs_scope: 'attached', ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.messageThread.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.findFirst.mockResolvedValue(null);
  mockPrisma.messageThreadReadState.findMany.mockResolvedValue([]);
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.mailbox.findMany.mockResolvedValue([]);
  mockPrisma.phoneNumber.findFirst.mockResolvedValue({ id: MAIN_LINE });
  linkNumbers();
});

describe('GET /communication/threads on "Linked to me"', () => {
  beforeEach(() => signInNarrow());

  it('returns, for a conversation mixing a linked and an unlinked number, only the linked messages and the ones the person sent', async () => {
    linkNumbers(LINKED);
    const res = await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const nested = nestedMessages(mockPrisma.messageThread.findMany as Mock);
    expect(visible(nested)).toEqual([ON_LINKED.id, SENT_BY_ME_ON_MAIN_LINE.id]);
  });

  it('lists a conversation only when it holds at least one of the person\'s messages', async () => {
    linkNumbers(LINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.messageThread.findMany as Mock);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(matchesWhere(conversation(ON_UNLINKED, ON_LINKED), where)).toBe(true);
    expect(matchesWhere(conversation(ON_UNLINKED, ON_OTHER_JOB_UNLINKED), where)).toBe(false);
  });

  it('keeps a text the person sent from the Organization default number although no number is linked to them', async () => {
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).toEqual([SENT_BY_ME_ON_MAIN_LINE.id]);
  });

  it('lists a text from before the release that the fill-in placed on a number linked to the person', async () => {
    linkNumbers(UNLINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).toContain(ON_UNLINKED.id);
  });

  it('shows the main line\'s texts to a person with no number when the switch is on, and a text with no number never', async () => {
    signInNarrow({ see_main_line_when_no_number: true });
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    const ids = visible(nestedMessages(mockPrisma.messageThread.findMany as Mock));
    expect(ids).toEqual([SENT_BY_ME_ON_MAIN_LINE.id, ON_MAIN_LINE.id].sort((a, b) => ALL.findIndex((r) => r.id === a) - ALL.findIndex((r) => r.id === b)));
    expect(ids).not.toContain(NO_NUMBER.id);
  });

  it('shows no main-line text to a person with no number when the switch is off', async () => {
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).not.toContain(ON_MAIN_LINE.id);
  });

  it('gives no main-line text to a person with one linked number, whatever the switch says', async () => {
    signInNarrow({ see_main_line_when_no_number: true });
    linkNumbers(LINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).not.toContain(ON_MAIN_LINE.id);
  });

  it('reads the links afresh on every request', async () => {
    linkNumbers(LINKED, UNLINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock, 0))).toContain(ON_UNLINKED.id);

    linkNumbers(LINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock, 1))).not.toContain(ON_UNLINKED.id);
  });

  it('does not list a message because a job is tied to it: the list uses the section scope only', async () => {
    linkNumbers(LINKED);
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).not.toContain(ON_MY_JOB_UNLINKED.id);
  });
});

describe('reply attribution on the text inbox (S08.6)', () => {
  beforeEach(() => signInNarrow());

  // The customer's answer on the main line, and what the database holds of the conversation the person has sent in.
  const REPLY = message('d0000000-0000-4000-8000-0000000000a1', { phone_number_id: MAIN_LINE });
  const OTHER_MAIN_LINE_TEXT = message('d0000000-0000-4000-8000-0000000000a2', { phone_number_id: MAIN_LINE });
  const inThread = (id: string, fields: Record<string, unknown>) => ({
    id, thread_id: THREAD_ID, phone_number_id: MAIN_LINE, sent_by_user_id: null, created_at: new Date(0), ...fields,
  });
  const sendThenReply = [
    inThread(SENT_BY_ME_ON_MAIN_LINE.id as string, { direction: 'out', sent_by_user_id: ME, ts: new Date('2026-10-01T10:00:00Z') }),
    inThread(REPLY.id as string, { direction: 'in', ts: new Date('2026-10-01T10:05:00Z') }),
  ];
  const listedIds = (fn: Mock) =>
    [REPLY, OTHER_MAIN_LINE_TEXT, SENT_BY_ME_ON_MAIN_LINE].filter((r) => matchesWhere(r, nestedMessages(fn, lastCall(fn)))).map((r) => r.id);

  it('lists the reply to a text the person sent, and not another main-line text, in the list and the unread count', async () => {
    mockPrisma.message.findMany.mockResolvedValue(sendThenReply);
    for (const path of ['threads', 'unread-counts']) {
      mockPrisma.messageThread.findMany.mockClear();
      await request(app).get(`/api/communication/${path}`).set(authHeader('dispatcher'));
      expect(listedIds(mockPrisma.messageThread.findMany as Mock), path).toEqual([REPLY.id, SENT_BY_ME_ON_MAIN_LINE.id]);
    }
  });

  it('asks the database only for the conversations the person has sent in', async () => {
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.message.findMany as Mock);
    expect(where.thread).toEqual({ messages: { some: { sent_by_user_id: ME, phone_number_id: { not: null } } } });
  });

  it('opens the conversation with the reply in it, and not another main-line text', async () => {
    mockPrisma.message.findMany.mockResolvedValue(sendThenReply);
    await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('dispatcher'));
    expect(listedIds(mockPrisma.messageThread.findFirst as Mock)).toEqual([REPLY.id, SENT_BY_ME_ON_MAIN_LINE.id]);
  });

  it('adds nothing under "All"', async () => {
    mockRoleSwitches({ communication_scope: 'all' });
    mockPrisma.message.findMany.mockClear();
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /communication/threads on "All"', () => {
  it('applies no restriction to the conversations or to their messages', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.messageThread.findMany as Mock);
    expect(where).toEqual({ organization_id: ALPHA_ORG_ID });
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).toEqual(ALL.map((r) => r.id));
  });
});

describe('GET /communication/threads/:id on "Linked to me"', () => {
  beforeEach(() => signInNarrow());

  it('returns the person\'s own messages and the job\'s, and leaves out a message tied to a job they cannot open', async () => {
    linkNumbers(LINKED);
    await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('dispatcher'));
    const ids = visible(nestedMessages(mockPrisma.messageThread.findFirst as Mock, lastCall(mockPrisma.messageThread.findFirst as Mock)));
    expect(ids).toEqual(expect.arrayContaining([ON_LINKED.id, ON_MY_JOB_UNLINKED.id]));
    for (const m of [ON_UNLINKED, ON_OTHER_JOB_UNLINKED, NO_NUMBER]) expect(ids, String(m.id)).not.toContain(m.id);
  });

  it('opens the conversation when any one message in it is readable, and 404s when none is', async () => {
    linkNumbers(LINKED);
    await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.messageThread.findFirst as Mock, lastCall(mockPrisma.messageThread.findFirst as Mock));
    expect(matchesWhere(conversation(ON_MY_JOB_UNLINKED, ON_OTHER_JOB_UNLINKED), where)).toBe(true);
    expect(matchesWhere(conversation(ON_OTHER_JOB_UNLINKED, NO_NUMBER), where)).toBe(false);
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
  });

  it('returns every message under "All"', async () => {
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findFirst as Mock, lastCall(mockPrisma.messageThread.findFirst as Mock)))).toEqual(ALL.map((r) => r.id));
  });
});

describe('marking a text conversation read or unread', () => {
  it('needs a message in it that the person can read', async () => {
    signInNarrow();
    linkNumbers(LINKED);
    for (const path of ['read', 'unread']) {
      mockPrisma.messageThread.findFirst.mockClear();
      await request(app).patch(`/api/communication/threads/${THREAD_ID}/${path}`).set(authHeader('dispatcher'));
      const where = capturedWhere(mockPrisma.messageThread.findFirst as Mock, lastCall(mockPrisma.messageThread.findFirst as Mock));
      expect(matchesWhere(conversation(ON_LINKED), where), path).toBe(true);
      expect(matchesWhere(conversation(ON_UNLINKED), where), path).toBe(false);
    }
  });
});

describe('replying inside a conversation', () => {
  it('is refused with the conversation\'s own 404 when no message in it is readable, and looks the conversation up under the read scope', async () => {
    signInNarrow();
    linkNumbers(LINKED);
    const res = await request(app).post('/api/communication/sms').set(authHeader('dispatcher'))
      .send({ threadId: THREAD_ID, body: 'On my way' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Thread not found');
    const where = capturedWhere(mockPrisma.messageThread.findFirst as Mock, lastCall(mockPrisma.messageThread.findFirst as Mock));
    expect(matchesWhere(conversation(ON_LINKED), where)).toBe(true);
    expect(matchesWhere(conversation(ON_UNLINKED, ON_OTHER_JOB_UNLINKED), where)).toBe(false);
  });
});

/** A captured `where` without the key that names one specific row, so fixture rows can be run through the rest. */
const withoutId = ({ id: _id, ...rest }: Record<string, unknown>) => rest;

describe('re-attaching a text to a job or a lead', () => {
  it('finds the message under the read scope: a message the person cannot read is a 404', async () => {
    signInNarrow();
    linkNumbers(LINKED);
    mockPrisma.message.updateMany.mockResolvedValue({ count: 0 });
    const clear = await request(app).patch(`/api/communication/sms/${ON_UNLINKED.id}/job`).set(authHeader('dispatcher')).send({ job_id: null });
    expect(clear.status).toBe(404);
    const where = withoutId(capturedWhere(mockPrisma.message.updateMany as Mock));
    expect(matchesWhere(ON_UNLINKED, where)).toBe(false);
    expect(matchesWhere(ON_MY_JOB_UNLINKED, where)).toBe(true);
    expect(matchesWhere(ON_LINKED, where)).toBe(true);

    mockPrisma.message.updateMany.mockClear();
    await request(app).patch(`/api/communication/sms/${ON_UNLINKED.id}/lead`).set(authHeader('dispatcher')).send({ lead_id: null });
    expect(matchesWhere(ON_UNLINKED, withoutId(capturedWhere(mockPrisma.message.updateMany as Mock)))).toBe(false);
  });
});

describe('GET /communication/unread-counts (texts)', () => {
  it('counts only the conversations holding a message the person can read, and only their messages in them', async () => {
    signInNarrow();
    linkNumbers(LINKED);
    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const fn = mockPrisma.messageThread.findMany as Mock;
    expect(visible(nestedMessages(fn))).toEqual([ON_LINKED.id, SENT_BY_ME_ON_MAIN_LINE.id]);
    const where = capturedWhere(fn);
    expect(matchesWhere(conversation(ON_UNLINKED), where)).toBe(false);
    expect(matchesWhere(conversation(ON_LINKED), where)).toBe(true);
  });

  it('counts every message under "All"', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));
    expect(visible(nestedMessages(mockPrisma.messageThread.findMany as Mock))).toEqual(ALL.map((r) => r.id));
  });
});
