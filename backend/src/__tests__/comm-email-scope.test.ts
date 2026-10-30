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
 * Roles & Permissions S08.7: the Email page follows Communication scope through the mailbox input. As in
 * comm-call-log-scope.test.ts, every assertion captures the `where` the handler handed the database and runs fixture
 * rows through it, never the rendered payload. The stored switch values, not the role name, decide what each person
 * sees, and the mailboxes the person holds are read from the database on each request.
 */

const mockPrisma = prisma as any;
const ME = TEST_USERS.dispatcher.id;
const MY_BOX = 'b1000000-0000-4000-8000-000000000001';
const COLLEAGUE_BOX = 'b1000000-0000-4000-8000-000000000002';
const MY_JOB = { id: 'ab000000-0000-0000-0000-00000000000a', visits: [{ assignees: [{ user_id: ME }] }] };
const OTHER_JOB = { id: 'ab000000-0000-0000-0000-00000000000b', visits: [{ assignees: [{ user_id: 'someone-else' }] }] };
const THREAD_ID = 'a9999999-9999-4999-8999-999999999999';

function emailRow(id: string, mailbox: string | null, fields: Partial<Row> = {}): Row {
  return {
    id, organization_id: ALPHA_ORG_ID, folder: 'inbox',
    thread_id: mailbox ? `t-${id}` : null, thread: mailbox ? { mailbox_id: mailbox } : null,
    job_id: null, job: null, lead_id: null, lead: null, customer_id: null, customer: null, vendor_id: null, ...fields,
  };
}
const IN_MY_BOX = emailRow('e0000000-0000-4000-8000-000000000001', MY_BOX);
const IN_COLLEAGUE_BOX = emailRow('e0000000-0000-4000-8000-000000000002', COLLEAGUE_BOX);
const CUSTOMER_ONLY = emailRow('e0000000-0000-4000-8000-000000000003', COLLEAGUE_BOX, { customer_id: 'cust-1', customer: { id: 'cust-1' } });
const LOOSE = emailRow('e0000000-0000-4000-8000-000000000004', null);
const MY_JOB_OUTSIDE = emailRow('e0000000-0000-4000-8000-000000000005', COLLEAGUE_BOX, { job_id: MY_JOB.id, job: MY_JOB });
const OTHER_JOB_OUTSIDE = emailRow('e0000000-0000-4000-8000-000000000006', COLLEAGUE_BOX, { job_id: OTHER_JOB.id, job: OTHER_JOB });
const MY_BOX_OTHER_JOB = emailRow('e0000000-0000-4000-8000-000000000007', MY_BOX, { job_id: OTHER_JOB.id, job: OTHER_JOB });
const ALL = [IN_MY_BOX, IN_COLLEAGUE_BOX, CUSTOMER_ONLY, LOOSE, MY_JOB_OUTSIDE, OTHER_JOB_OUTSIDE, MY_BOX_OTHER_JOB];

const visible = (where: Record<string, unknown>) => ALL.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
const capturedWhere = (fn: Mock, call = 0) => {
  expect(fn, 'expected the handler to query prisma').toHaveBeenCalled();
  return fn.mock.calls[call][0].where as Record<string, unknown>;
};

/** A captured `where` without the keys that name one specific row, so fixture rows can be run through the rest. */
const without = (where: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(where).filter(([k]) => !keys.includes(k)));

/** The mailboxes the person holds, as the database would answer them. */
function holdMailboxes(...ids: string[]) {
  mockPrisma.mailbox.findMany.mockResolvedValue(ids.map((id) => ({ id })));
}

/** A person on "Linked to me" who can reach their own job only: the narrowest section reader. */
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
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.email.findFirst.mockResolvedValue(null);
  mockPrisma.email.count.mockResolvedValue(0);
  mockPrisma.userPhoneNumber.findMany.mockResolvedValue([]);
  holdMailboxes();
});

describe('GET /communication/emails on "Linked to me"', () => {
  beforeEach(() => signInNarrow());

  it('lists the messages of the conversations in a mailbox the person holds, and nothing else', async () => {
    holdMailboxes(MY_BOX);
    const res = await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(visible(where)).toEqual([IN_MY_BOX.id, MY_BOX_OTHER_JOB.id]);
  });

  it('asks the database for the mailboxes the person holds, in their own company', async () => {
    holdMailboxes(MY_BOX);
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(mockPrisma.mailbox.findMany.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID, holder_user_id: ME });
  });

  it('no longer lists a customer-only email, nor a loose one, nor a job-tied one outside the mailbox', async () => {
    holdMailboxes(MY_BOX);
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    const ids = visible(capturedWhere(mockPrisma.email.findMany as Mock));
    for (const row of [CUSTOMER_ONLY, LOOSE, MY_JOB_OUTSIDE, OTHER_JOB_OUTSIDE]) expect(ids, String(row.id)).not.toContain(row.id);
  });

  it('lists nothing for a person who holds no mailbox', async () => {
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.email.findMany as Mock))).toEqual([]);
  });

  it('adds no conversation through the main-line fallback, with the switch on and no linked number', async () => {
    signInNarrow({ see_main_line_when_no_number: true });
    mockPrisma.phoneNumber.findFirst.mockResolvedValue({ id: 'a1000000-0000-4000-8000-0000000000ff' });
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.email.findMany as Mock))).toEqual([]);
  });

  it('reads the mailboxes afresh on every request: a mailbox handed away leaves the list on the next one', async () => {
    holdMailboxes(MY_BOX, COLLEAGUE_BOX);
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.email.findMany as Mock, 0))).toContain(IN_COLLEAGUE_BOX.id);

    holdMailboxes(MY_BOX);
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.email.findMany as Mock, 1))).not.toContain(IN_COLLEAGUE_BOX.id);
  });

  it('keeps the assignment view an extra narrowing, never a widening', async () => {
    holdMailboxes(MY_BOX);
    await request(app).get('/api/communication/emails?assignment=unassigned').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    const unassigned = { ...IN_COLLEAGUE_BOX, thread: { mailbox_id: COLLEAGUE_BOX, assigned_to_user_id: null } };
    expect(matchesWhere(unassigned, where)).toBe(false);
    expect(matchesWhere({ ...IN_MY_BOX, thread: { mailbox_id: MY_BOX, assigned_to_user_id: null } }, where)).toBe(true);
  });
});

describe('GET /communication/emails on "All"', () => {
  it('lists every email conversation for a person on All, whatever mailboxes they hold', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get('/api/communication/emails').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.OR).toBeUndefined();
    expect(visible(where)).toEqual(ALL.map((r) => r.id));
  });

  it('lists every email conversation for the built-in Admin, as before', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/communication/emails').set(authHeader('admin'));
    expect(visible(capturedWhere(mockPrisma.email.findMany as Mock))).toEqual(ALL.map((r) => r.id));
  });
});

describe('GET /communication/emails/:id', () => {
  beforeEach(() => {
    signInNarrow();
    holdMailboxes(MY_BOX);
  });

  async function opens(row: Row): Promise<boolean> {
    mockPrisma.email.findFirst.mockClear();
    await request(app).get(`/api/communication/emails/${row.id}`).set(authHeader('dispatcher'));
    return matchesWhere(row, capturedWhere(mockPrisma.email.findFirst as Mock));
  }

  it('opens every message of a conversation in the person\'s mailbox, whatever job it is tied to', async () => {
    expect(await opens(IN_MY_BOX)).toBe(true);
    expect(await opens(MY_BOX_OTHER_JOB)).toBe(true);
  });

  it('opens a job-tied conversation outside the mailbox for a person who can open the job, message by message', async () => {
    expect(await opens(MY_JOB_OUTSIDE)).toBe(true);
    expect(await opens(OTHER_JOB_OUTSIDE)).toBe(false);
  });

  it('refuses a colleague\'s mailbox and a loose email', async () => {
    expect(await opens(IN_COLLEAGUE_BOX)).toBe(false);
    expect(await opens(LOOSE)).toBe(false);
  });

  it('opens a customer-only email for a person who can open that customer, and not for one with View customers off', async () => {
    mockRoleSwitches({ communication_scope: 'attached', view_customers: true, customers_scope: 'all' });
    expect(await opens(CUSTOMER_ONLY)).toBe(true);
    mockRoleSwitches({ communication_scope: 'attached', view_customers: false });
    expect(await opens(CUSTOMER_ONLY)).toBe(false);
  });

  it('opens any email for a person on All', async () => {
    mockRoleSwitches({ communication_scope: 'all' });
    expect(await opens(IN_COLLEAGUE_BOX)).toBe(true);
    expect(await opens(LOOSE)).toBe(true);
  });
});

describe('what a conversation action needs: the conversation must be readable', () => {
  beforeEach(() => {
    signInNarrow();
    holdMailboxes(MY_BOX);
  });

  it('PATCH /emails/thread-read marks read only the messages the person may read', async () => {
    await request(app).patch('/api/communication/emails/thread-read').set(authHeader('dispatcher')).send({ thread_id: THREAD_ID });
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.thread_id).toBe(THREAD_ID);
    expect(visible(without(where, 'thread_id'))).toEqual([IN_MY_BOX.id, MY_JOB_OUTSIDE.id, MY_BOX_OTHER_JOB.id]);
  });

  it('PATCH /emails/thread-unread is scoped the same way', async () => {
    await request(app).patch('/api/communication/emails/thread-unread').set(authHeader('dispatcher')).send({ thread_id: THREAD_ID });
    const where = without(capturedWhere(mockPrisma.email.findMany as Mock), 'thread_id');
    expect(visible(where)).not.toContain(IN_COLLEAGUE_BOX.id);
    expect(visible(where)).toContain(IN_MY_BOX.id);
  });

  it('GET /emails/:id/attachments/:index mints a link only for a readable message', async () => {
    await request(app).get(`/api/communication/emails/${IN_COLLEAGUE_BOX.id}/attachments/0`).set(authHeader('dispatcher'));
    expect(matchesWhere(IN_COLLEAGUE_BOX, capturedWhere(mockPrisma.email.findFirst as Mock))).toBe(false);
    mockPrisma.email.findFirst.mockClear();
    await request(app).get(`/api/communication/emails/${IN_MY_BOX.id}/attachments/0`).set(authHeader('dispatcher'));
    expect(matchesWhere(IN_MY_BOX, capturedWhere(mockPrisma.email.findFirst as Mock))).toBe(true);
  });

  // Re-audit N16: a conversation is changed as a whole only when it is the person's (in a mailbox they hold or read, or a record
  // conversation they open). One readable message of a conversation in a colleague's mailbox is not enough.
  const thread = (mailbox: string, messages: Row[]) => ({ id: THREAD_ID, organization_id: ALPHA_ORG_ID, mailbox_id: mailbox, emails: messages });

  it('PATCH /emails/threads/:id/assign reaches only a conversation that is the person\'s, and answers 404 before writing anything otherwise', async () => {
    // The caller's own reach is asked first (M1: before the assignee is looked at), so a miss writes nothing.
    mockPrisma.emailThread.findFirst.mockResolvedValue(null);
    const res = await request(app).patch(`/api/communication/emails/threads/${THREAD_ID}/assign`).set(authHeader('dispatcher')).send({ user_id: null });
    expect(res.status).toBe(404);
    expect(mockPrisma.emailThread.updateMany).not.toHaveBeenCalled();
    const where = capturedWhere(mockPrisma.emailThread.findFirst as Mock);
    expect(matchesWhere(thread(MY_BOX, [IN_MY_BOX]), where)).toBe(true);
    expect(matchesWhere(thread(COLLEAGUE_BOX, [MY_JOB_OUTSIDE]), where)).toBe(false);
    expect(matchesWhere(thread(COLLEAGUE_BOX, [IN_COLLEAGUE_BOX, OTHER_JOB_OUTSIDE]), where)).toBe(false);
  });

  it('PATCH /emails/threads/:id/archive and /snooze write only a conversation that is the person\'s', async () => {
    for (const [action, body] of [['archive', { archived: true }], ['snooze', { snoozed_until: null }]] as const) {
      mockPrisma.emailThread.updateMany.mockClear();
      mockPrisma.emailThread.updateMany.mockResolvedValue({ count: 0 });
      const res = await request(app).patch(`/api/communication/emails/threads/${THREAD_ID}/${action}`).set(authHeader('dispatcher')).send(body);
      expect(res.status, action).toBe(404);
      // The write itself carries the reach filter: a conversation with nothing readable in it is never written.
      const where = capturedWhere(mockPrisma.emailThread.updateMany as Mock);
      expect(where.id, action).toBe(THREAD_ID);
      expect(matchesWhere(thread(MY_BOX, [IN_MY_BOX]), where), action).toBe(true);
      expect(matchesWhere(thread(COLLEAGUE_BOX, [MY_JOB_OUTSIDE]), where), action).toBe(false);
      expect(matchesWhere(thread(COLLEAGUE_BOX, [IN_COLLEAGUE_BOX, OTHER_JOB_OUTSIDE]), where), action).toBe(false);
    }
  });

  it('a reply resolves its conversation only when the conversation is readable', async () => {
    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('dispatcher'))
      .field('to', 'angel@example.com')
      .field('subject', 'Re: Quote')
      .field('thread_id', THREAD_ID)
      .field('body', JSON.stringify(['Sounds good.']));
    const where = capturedWhere(mockPrisma.email.findFirst as Mock);
    expect(where.thread_id).toBe(THREAD_ID);
    const rest = without(where, 'thread_id');
    expect(matchesWhere(IN_COLLEAGUE_BOX, rest)).toBe(false);
    expect(matchesWhere(IN_MY_BOX, rest)).toBe(true);
  });
});

describe('sending a new email', () => {
  it('needs only Contact customers: a person on "Linked to me" who holds no mailbox can send to any recipient', async () => {
    signInNarrow({ contact_customers: true });
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'sent', providerMessageId: 're_test', fromAddress: 'no-reply@mail.test.com', fromName: null });
    mockPrisma.email.create.mockResolvedValue({ id: 'sent-1', ts: 1n, folder: 'sent', body: [], customer: null, lead: null, vendor: null });
    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('dispatcher'))
      .field('to', 'angel@example.com')
      .field('subject', 'Hello')
      .field('body', JSON.stringify(['Hi there.']));
    expect(res.status).toBe(201);
  });

  it('is refused without Contact customers', async () => {
    signInNarrow({ contact_customers: false });
    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('dispatcher'))
      .field('to', 'angel@example.com')
      .field('subject', 'Hello')
      .field('body', JSON.stringify(['Hi there.']));
    expect(res.status).toBe(403);
  });
});

describe('GET /communication/unread-counts', () => {
  it('counts only the email the Email page would list for a person on "Linked to me"', async () => {
    signInNarrow();
    holdMailboxes(MY_BOX);
    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.count as Mock);
    expect(where.folder).toBe('inbox');
    expect(visible(without(where, 'email_read_states'))).toEqual([IN_MY_BOX.id, MY_BOX_OTHER_JOB.id]);
  });

  it('counts every email for a person on All', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));
    expect(visible(without(capturedWhere(mockPrisma.email.count as Mock), 'email_read_states'))).toEqual(ALL.map((r) => r.id));
  });

  it('issues no email count for a company without email', async () => {
    mockAuthAs('dispatcher', { plan: 'PRO', feature_overrides: { email: false } });
    mockRoleSwitches({ communication_scope: 'attached' });
    await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));
    expect(mockPrisma.email.count).not.toHaveBeenCalled();
  });
});
