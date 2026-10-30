import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * M11 asked for many people about one conversation (Roles & Permissions S08.21): which of these people may open this call,
 * this text conversation or this email conversation. The rule itself is `callReadWhere` / `textReadWhere` /
 * `emailReadWhere` (communicationScope.ts); what is proven here is that it is fed each person's inputs, run over the one
 * loaded conversation, and asked for everybody in a constant number of reads. The real-database suite
 * (permission-communication-conversation-readers-db.test.ts) holds it equal to the routes.
 *
 * The collaborators are the people's switches and abilities, the row scope a person holds on a record, the cohort look at a
 * record, and the reads of the conversation; the person's expected answer is derived from what the test gave them.
 */

const prismaMock = vi.hoisted(() => ({
  callSession: { findFirst: vi.fn() },
  messageThread: { findFirst: vi.fn() },
  emailThread: { findFirst: vi.fn() },
  userPhoneNumber: { findMany: vi.fn() },
  phoneNumber: { findFirst: vi.fn() },
  mailboxReader: { findMany: vi.fn() },
}));
vi.mock('../../prisma', () => ({ prisma: prismaMock }));

const switchesMock = vi.hoisted(() => ({ resolveSwitchesForPeople: vi.fn() }));
vi.mock('../../permissions/switches/store', () => switchesMock);

const enforceMock = vi.hoisted(() => ({ abilityForUser: vi.fn(), scopeWhereForUser: vi.fn() }));
vi.mock('../../permissions/enforce', () => enforceMock);

const cohortMock = vi.hoisted(() => ({ readersWithEntityAccess: vi.fn() }));
vi.mock('../../tasks/entityAccessCohort', () => cohortMock);

const featureMock = vi.hoisted(() => ({ orgEmailFeatureOn: vi.fn() }));
vi.mock('../emailFeature', () => featureMock);

import { readersOfConversation } from '../conversationReaders';

const ORG = 'org-1';

interface Spec {
  scope?: 'linked_to_me' | 'all';
  seeMainLine?: boolean;
  /** View communication / Access Communication / View vendors. */
  canRead?: boolean;
  canAccess?: boolean;
  canSeeVendors?: boolean;
  canManageRoles?: boolean;
  /** Holds an unrestricted row scope on every kind of record (so no look at the record is needed). */
  openScope?: boolean;
}

const specs = new Map<string, Spec>();
/** A person the test is about; returns the row the filter would hand over. */
function person(id: string, spec: Spec = {}) {
  specs.set(id, spec);
  return { id, role: 'DISPATCHER', organization_id: ORG, custom_role_id: null, custom_role: null, department_id: null, location_id: null };
}

/** Who the cohort look says can open each record, by `TYPE:id`. */
const opens = new Map<string, string[]>();

beforeEach(() => {
  vi.clearAllMocks();
  specs.clear();
  opens.clear();
  switchesMock.resolveSwitchesForPeople.mockImplementation(async (people: { id: string }[]) =>
    new Map(people.map((p) => {
      const s = specs.get(p.id) ?? {};
      return [p.id, { communication_scope: s.scope ?? 'linked_to_me', see_main_line_when_no_number: s.seeMainLine ?? false }];
    })));
  enforceMock.abilityForUser.mockImplementation(async (p: { id: string }) => {
    const s = specs.get(p.id) ?? {};
    return {
      can: (action: string, subject: string) => {
        if (subject === 'Communication') return action === 'read' ? s.canRead !== false : s.canAccess !== false;
        if (subject === 'Vendor') return s.canSeeVendors === true;
        if (subject === 'Role') return s.canManageRoles === true;
        return false;
      },
    };
  });
  enforceMock.scopeWhereForUser.mockImplementation(async (p: { id: string }) => (specs.get(p.id)?.openScope ? {} : { organization_id: ORG, restricted: true }));
  cohortMock.readersWithEntityAccess.mockImplementation(async (_people: unknown, ref: { type: string; id: string }) => ({
    withAccess: new Set(opens.get(`${ref.type}:${ref.id}`) ?? []), probes: 1, fallbacks: 0,
  }));
  prismaMock.userPhoneNumber.findMany.mockResolvedValue([]);
  prismaMock.phoneNumber.findFirst.mockResolvedValue(null);
  prismaMock.mailboxReader.findMany.mockResolvedValue([]);
  featureMock.orgEmailFeatureOn.mockResolvedValue(true);
});

/** The people who may read it, in the order they were asked about. */
const inOrder = (people: { id: string }[], readers: Set<string>) => people.map((p) => p.id).filter((id) => readers.has(id));
const link = (userId: string, numberId: string) => ({ user_id: userId, phone_number_id: numberId });
const call = (fields: Record<string, unknown> = {}) => ({
  phone_number_id: null, agent_id: null, job_id: null, lead_id: null, customer_id: null, vendor_id: null, ...fields,
});

describe('a call', () => {
  const ask = async (people: ReturnType<typeof person>[], id = 'call-1') => inOrder(people, await readersOfConversation(people, 'call', id, ORG));

  it('keeps who is linked to the number it came in on, who placed or answered it and who holds All, and drops the rest', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1', agent_id: 'u-agent' }));
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-linked', 'n-1'), link('u-other-number', 'n-2')]);
    const people = [
      person('u-linked'), person('u-other-number'), person('u-agent'), person('u-all', { scope: 'all' }), person('u-nobody'),
    ];

    expect(await ask(people)).toEqual(['u-linked', 'u-agent', 'u-all']);
  });

  it('drops a person without View communication or without Access Communication, even on All', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1' }));
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-no-view', 'n-1'), link('u-no-access', 'n-1'), link('u-ok', 'n-1')]);
    const people = [
      person('u-no-view', { canRead: false }), person('u-no-access', { canAccess: false }),
      person('u-all-no-access', { scope: 'all', canAccess: false }), person('u-ok'),
    ];

    expect(await ask(people)).toEqual(['u-ok']);
  });

  it('reads the main line as the person\'s own only when they have no number and hold the switch', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-main' }));
    prismaMock.phoneNumber.findFirst.mockResolvedValue({ id: 'n-main' });
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-has-own', 'n-2')]);
    const people = [person('u-fallback', { seeMainLine: true }), person('u-switch-off'), person('u-has-own', { seeMainLine: true })];

    expect(await ask(people)).toEqual(['u-fallback']);
  });

  it('keeps who can open the job it is tied to and drops who cannot, asking the record once for all of them', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1', job_id: 'job-1' }));
    opens.set('JOB:job-1', ['u-crew']);
    const people = [person('u-crew'), person('u-outsider'), person('u-open-scope', { openScope: true })];

    expect(await ask(people)).toEqual(['u-crew', 'u-open-scope']);
    expect(cohortMock.readersWithEntityAccess).toHaveBeenCalledOnce();
    expect(cohortMock.readersWithEntityAccess.mock.calls[0]![1]).toEqual({ type: 'JOB', id: 'job-1' });
  });

  it('follows the job over the lead over the customer, and the vendor only for who may view vendors', async () => {
    opens.set('JOB:job-1', []);
    opens.set('LEAD:lead-1', ['u-lead']);
    opens.set('CUSTOMER:cust-1', ['u-lead']);
    prismaMock.callSession.findFirst.mockResolvedValue(call({ job_id: 'job-1', lead_id: 'lead-1', customer_id: 'cust-1' }));
    expect(await ask([person('u-lead')])).toEqual([]);

    prismaMock.callSession.findFirst.mockResolvedValue(call({ lead_id: 'lead-1', customer_id: 'cust-1' }));
    expect(await ask([person('u-lead')])).toEqual(['u-lead']);

    prismaMock.callSession.findFirst.mockResolvedValue(call({ customer_id: 'cust-1' }));
    expect(await ask([person('u-lead')])).toEqual(['u-lead']);

    prismaMock.callSession.findFirst.mockResolvedValue(call({ vendor_id: 'vendor-1' }));
    expect(await ask([person('u-vendors', { canSeeVendors: true }), person('u-no-vendors')])).toEqual(['u-vendors']);
  });

  it('asks nothing about a record for people the call\'s own ties already settle', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1', job_id: 'job-1' }));
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-linked', 'n-1')]);

    expect(await ask([person('u-linked'), person('u-all', { scope: 'all' })])).toEqual(['u-linked', 'u-all']);
    expect(cohortMock.readersWithEntityAccess).not.toHaveBeenCalled();
  });

  it('answers a call that is not there, or not in the company, with nobody', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(null);
    expect(await ask([person('u-all', { scope: 'all' })])).toEqual([]);
    expect(prismaMock.callSession.findFirst.mock.calls[0]![0].where).toEqual({ id: 'call-1', organization_id: ORG });
  });

  it('reads the call, the number links and the main line once, however many people are asked', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-main', job_id: 'job-1' }));
    prismaMock.phoneNumber.findFirst.mockResolvedValue({ id: 'n-main' });
    const people = Array.from({ length: 150 }, (_, i) => person(`u-${i}`, { seeMainLine: true }));
    opens.set('JOB:job-1', ['u-3']);

    const kept = await ask(people);

    expect(kept).toHaveLength(150);
    expect(prismaMock.callSession.findFirst).toHaveBeenCalledOnce();
    expect(prismaMock.userPhoneNumber.findMany).toHaveBeenCalledOnce();
    expect(prismaMock.phoneNumber.findFirst).toHaveBeenCalledOnce();
    expect(cohortMock.readersWithEntityAccess).not.toHaveBeenCalled();
  });
});

describe('a text conversation', () => {
  const message = (fields: Record<string, unknown> = {}) => ({ id: `m-${Math.random()}`, phone_number_id: null, sent_by_user_id: null, job_id: null, lead_id: null, ...fields });
  const thread = (messages: ReturnType<typeof message>[], fields: Record<string, unknown> = {}) => ({
    customer_id: null, vendor_id: null, user_id: null, messages, ...fields,
  });
  const ask = async (people: ReturnType<typeof person>[], id = 'thread-1') => inOrder(people, await readersOfConversation(people, 'text', id, ORG));

  it('keeps who is linked to a number a message went through, who sent one, the person a staff conversation is keyed to and who holds All', async () => {
    prismaMock.messageThread.findFirst.mockResolvedValue(
      thread([message({ phone_number_id: 'n-1' }), message({ sent_by_user_id: 'u-sender' })], { user_id: 'u-staff' }),
    );
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-linked', 'n-1'), link('u-elsewhere', 'n-2')]);
    const people = [person('u-linked'), person('u-elsewhere'), person('u-sender'), person('u-staff'), person('u-all', { scope: 'all' }), person('u-nobody')];

    expect(await ask(people)).toEqual(['u-linked', 'u-sender', 'u-staff', 'u-all']);
  });

  it('drops a person without View communication or Access Communication', async () => {
    prismaMock.messageThread.findFirst.mockResolvedValue(thread([message({ phone_number_id: 'n-1' })]));
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-no-view', 'n-1'), link('u-no-access', 'n-1'), link('u-ok', 'n-1')]);

    expect(await ask([person('u-no-view', { canRead: false }), person('u-no-access', { canAccess: false }), person('u-ok')])).toEqual(['u-ok']);
  });

  it('opens when any one message does: a message tied to a job the person can open', async () => {
    prismaMock.messageThread.findFirst.mockResolvedValue(
      thread([message({ phone_number_id: 'n-2' }), message({ phone_number_id: 'n-2', job_id: 'job-1' })], { customer_id: 'cust-1' }),
    );
    opens.set('JOB:job-1', ['u-crew']);
    opens.set('CUSTOMER:cust-1', ['u-customer']);

    // The first message has no job, so the customer on the conversation reaches it for u-customer.
    expect(await ask([person('u-crew'), person('u-customer'), person('u-outsider')])).toEqual(['u-crew', 'u-customer']);
  });

  it('follows the message\'s job, then its lead, then the conversation\'s customer, then its vendor', async () => {
    opens.set('LEAD:lead-1', ['u-lead']);
    prismaMock.messageThread.findFirst.mockResolvedValue(thread([message({ lead_id: 'lead-1' })], { customer_id: 'cust-1' }));
    expect(await ask([person('u-lead'), person('u-other')])).toEqual(['u-lead']);

    prismaMock.messageThread.findFirst.mockResolvedValue(thread([message()], { vendor_id: 'vendor-1' }));
    expect(await ask([person('u-vendors', { canSeeVendors: true }), person('u-no-vendors')])).toEqual(['u-vendors']);
  });

  describe('asked about one message of it (the text an alert quotes)', () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const asked = (people: ReturnType<typeof person>[], messageId: string) =>
      readersOfConversation(people, 'text', 'thread-1', ORG, { messageId }).then((set) => people.map((p) => p.id).filter((id) => set.has(id)));

    it('keeps who reads THAT message, not who reads some other message of the conversation', async () => {
      prismaMock.messageThread.findFirst.mockResolvedValue(thread([
        message({ id: 'm-own-number', phone_number_id: 'n-1', thread_id: 'thread-1', direction: 'out', ts: at(60), created_at: at(60) }),
        message({ id: 'm-quoted', phone_number_id: 'n-2', thread_id: 'thread-1', direction: 'in', ts: at(5), created_at: at(5), job_id: 'job-1' }),
      ]));
      prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-number-1', 'n-1'), link('u-crew', 'n-1')]);
      opens.set('JOB:job-1', ['u-crew-opens']);
      const people = [person('u-number-1'), person('u-crew'), person('u-crew-opens'), person('u-all', { scope: 'all' })];

      // The conversation opens for u-number-1 (its message on their number), the quoted text does not: it is on another number
      // and about a job they cannot open.
      expect(await ask(people)).toEqual(['u-number-1', 'u-crew', 'u-crew-opens', 'u-all']);
      expect(await asked(people, 'm-quoted')).toEqual(['u-crew-opens', 'u-all']);
    });

    it('keeps the person the reply is attributed to, who has no number linked', async () => {
      prismaMock.messageThread.findFirst.mockResolvedValue(thread([
        message({ id: 'm-out', phone_number_id: 'n-2', thread_id: 'thread-1', direction: 'out', sent_by_user_id: 'u-sender', ts: at(30), created_at: at(30) }),
        message({ id: 'm-reply', phone_number_id: 'n-2', thread_id: 'thread-1', direction: 'in', ts: at(5), created_at: at(5) }),
      ]));

      expect(await asked([person('u-sender'), person('u-bystander')], 'm-reply')).toEqual(['u-sender']);
    });

    it('answers nobody on a narrow scope for a message that is not in the conversation', async () => {
      prismaMock.messageThread.findFirst.mockResolvedValue(thread([message({ id: 'm-1', phone_number_id: 'n-1' })]));
      prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-linked', 'n-1')]);

      expect(await asked([person('u-linked')], 'm-elsewhere')).toEqual([]);
    });
  });

  it('answers a conversation that is not there with nobody, and reads it once however many people are asked', async () => {
    prismaMock.messageThread.findFirst.mockResolvedValue(null);
    expect(await ask([person('u-all', { scope: 'all' })])).toEqual([]);

    prismaMock.messageThread.findFirst.mockResolvedValue(thread([message({ phone_number_id: 'n-1', job_id: 'job-1' })]));
    const people = Array.from({ length: 120 }, (_, i) => person(`u-${i}`));
    opens.set('JOB:job-1', ['u-5']);
    expect(await ask(people)).toEqual(['u-5']);
    expect(prismaMock.messageThread.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.userPhoneNumber.findMany).toHaveBeenCalledTimes(1);
    expect(cohortMock.readersWithEntityAccess).toHaveBeenCalledOnce();
  });
});

describe('an email conversation', () => {
  const email = (fields: Record<string, unknown> = {}) => ({
    id: `e-${Math.random()}`, thread_id: 'thread-1', job_id: null, lead_id: null, customer_id: null, vendor_id: null, sent_by_user_id: null, ...fields,
  });
  const thread = (fields: Record<string, unknown> = {}) => ({
    id: 'thread-1', mailbox_id: 'mb-1', origin: 'started', record_type: null, record_id: null, assigned_to_user_id: null,
    mailbox: { kind: 'user', holder_user_id: null, status: 'active' }, emails: [email()], ...fields,
  });
  const ask = async (people: ReturnType<typeof person>[], id = 'thread-1') => inOrder(people, await readersOfConversation(people, 'email', id, ORG));

  it('keeps who holds the mailbox it sits in, who it is assigned to, who wrote in it and who holds All', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({
      assigned_to_user_id: 'u-assignee',
      mailbox: { kind: 'user', holder_user_id: 'u-holder', status: 'active' },
      emails: [email(), email({ sent_by_user_id: 'u-writer' })],
    }));
    const people = [person('u-holder'), person('u-assignee'), person('u-writer'), person('u-all', { scope: 'all' }), person('u-nobody')];

    expect(await ask(people)).toEqual(['u-holder', 'u-assignee', 'u-writer', 'u-all']);
  });

  it('drops everyone while the company\'s Email plan feature is off, without reading the conversation', async () => {
    featureMock.orgEmailFeatureOn.mockResolvedValue(false);
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ assigned_to_user_id: 'u-assignee' }));

    expect(await ask([person('u-assignee'), person('u-all', { scope: 'all' })])).toEqual([]);
    expect(prismaMock.emailThread.findFirst).not.toHaveBeenCalled();
    expect(featureMock.orgEmailFeatureOn).toHaveBeenCalledOnce();
  });

  it('drops a person without View communication or Access Communication', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ assigned_to_user_id: 'u-no-view' }));
    expect(await ask([person('u-no-view', { canRead: false }), person('u-all', { scope: 'all', canAccess: false })])).toEqual([]);
  });

  it('does not count a mailbox merged into the main one as held', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ mailbox: { kind: 'user', holder_user_id: 'u-holder', status: 'merged' } }));
    expect(await ask([person('u-holder')])).toEqual([]);
  });

  it('keeps the people linked to the main mailbox for a conversation started in it, and the Manage roles holders only while nobody active is linked', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ mailbox: { kind: 'main', holder_user_id: null, status: 'active' } }));
    const people = () => [person('u-linked'), person('u-manager', { canManageRoles: true }), person('u-plain')];

    prismaMock.mailboxReader.findMany.mockResolvedValue([{ user_id: 'u-linked', user: { is_active: true } }]);
    expect(await ask(people())).toEqual(['u-linked']);

    prismaMock.mailboxReader.findMany.mockResolvedValue([{ user_id: 'u-gone', user: { is_active: false } }]);
    expect(await ask(people())).toEqual(['u-manager']);
  });

  it('does not list a migrated conversation in the main mailbox, nor a vendor one to a person without View vendors', async () => {
    prismaMock.mailboxReader.findMany.mockResolvedValue([{ user_id: 'u-linked', user: { is_active: true } }]);
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ origin: 'migrated', mailbox: { kind: 'main', holder_user_id: null, status: 'active' } }));
    expect(await ask([person('u-linked')])).toEqual([]);

    prismaMock.mailboxReader.findMany.mockResolvedValue([
      { user_id: 'u-linked', user: { is_active: true } }, { user_id: 'u-linked-vendors', user: { is_active: true } },
    ]);
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({
      mailbox: { kind: 'main', holder_user_id: null, status: 'active' }, emails: [email({ vendor_id: 'vendor-1' })],
    }));
    expect(await ask([person('u-linked'), person('u-linked-vendors', { canSeeVendors: true })])).toEqual(['u-linked-vendors']);
  });

  it('opens a conversation about a record only for who can open the record, whoever holds the mailbox or is assigned', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({
      origin: 'record', record_type: 'job', record_id: 'job-1', assigned_to_user_id: 'u-assignee',
      mailbox: { kind: 'user', holder_user_id: 'u-holder', status: 'active' },
    }));
    opens.set('JOB:job-1', ['u-crew']);

    expect(await ask([person('u-holder'), person('u-assignee'), person('u-crew'), person('u-all', { scope: 'all' })])).toEqual(['u-crew', 'u-all']);
  });

  it('reaches the records of an estimate, an invoice, a lead and a customer conversation the same way', async () => {
    const kinds: [string, string][] = [['estimate', 'ESTIMATE'], ['invoice', 'INVOICE'], ['lead', 'LEAD'], ['customer', 'CUSTOMER']];
    for (const [recordType, cohortType] of kinds) {
      prismaMock.emailThread.findFirst.mockResolvedValue(thread({ origin: 'record', record_type: recordType, record_id: 'rec-1' }));
      opens.set(`${cohortType}:rec-1`, ['u-reach']);
      expect(await ask([person('u-reach'), person('u-out')]), recordType).toEqual(['u-reach']);
    }
  });

  it('reaches a calendar entry conversation through every customer it names, and through none when it names none', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({
      origin: 'record', record_type: 'calendar_entry', record_id: 'cal-1',
      emails: [email({ customer_id: 'cust-1' }), email({ customer_id: 'cust-2' })],
    }));
    opens.set('CUSTOMER:cust-1', ['u-both', 'u-one']);
    opens.set('CUSTOMER:cust-2', ['u-both']);
    expect(await ask([person('u-both'), person('u-one')])).toEqual(['u-both']);

    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ origin: 'record', record_type: 'calendar_entry', record_id: 'cal-1' }));
    expect(await ask([person('u-both')])).toEqual([]);
  });

  it('opens an ordinary conversation through a message tied to a job the person can open', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ emails: [email({ job_id: 'job-1' })] }));
    opens.set('JOB:job-1', ['u-crew']);
    expect(await ask([person('u-crew'), person('u-out')])).toEqual(['u-crew']);
  });

  it('reads the plan, the conversation and the main mailbox\'s readers once, however many people are asked', async () => {
    prismaMock.emailThread.findFirst.mockResolvedValue(thread({ mailbox: { kind: 'main', holder_user_id: null, status: 'active' } }));
    prismaMock.mailboxReader.findMany.mockResolvedValue([{ user_id: 'u-3', user: { is_active: true } }]);
    const people = Array.from({ length: 150 }, (_, i) => person(`u-${i}`));

    expect(await ask(people)).toEqual(['u-3']);
    expect(featureMock.orgEmailFeatureOn).toHaveBeenCalledOnce();
    expect(prismaMock.emailThread.findFirst).toHaveBeenCalledOnce();
    expect(prismaMock.mailboxReader.findMany).toHaveBeenCalledOnce();
  });
});

describe('a person from another company', () => {
  it('never reads the conversation, even on All, and the conversation is not even looked for when nobody is left', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1' }));
    const stranger = { ...person('u-stranger', { scope: 'all' }), organization_id: 'org-2' };

    expect([...(await readersOfConversation([stranger], 'call', 'call-1', ORG))]).toEqual([]);
    expect(prismaMock.callSession.findFirst).not.toHaveBeenCalled();
  });
});

describe('a person whose permissions cannot be worked out', () => {
  it('is left out, and the rest are still answered', async () => {
    prismaMock.callSession.findFirst.mockResolvedValue(call({ phone_number_id: 'n-1' }));
    prismaMock.userPhoneNumber.findMany.mockResolvedValue([link('u-broken', 'n-1'), link('u-ok', 'n-1')]);
    enforceMock.abilityForUser.mockImplementation(async (p: { id: string }) => {
      if (p.id === 'u-broken') throw new Error('custom role missing');
      return { can: () => true };
    });

    expect([...(await readersOfConversation([person('u-broken'), person('u-ok')], 'call', 'call-1', ORG))]).toEqual(['u-ok']);
  });
});
