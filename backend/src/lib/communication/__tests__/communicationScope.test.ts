import { describe, it, expect } from 'vitest';
import {
  callsInSectionWhere,
  callReadWhere,
  numbersInSectionWhere,
  emailsInSectionWhere,
  emailReadWhere,
  mailboxSelectionWhere,
  textsInSectionWhere,
  textReadWhere,
  textThreadHolding,
  replyAttributedMessageIds,
  replySendersOf,
  recordTabWhere,
  type CommunicationScopeInputs,
} from '../communicationScope';
import { MATCH_NOTHING } from '../../permissions/scopeWhereFor';
// Fixture rows are run through the real emitted `where`, as the anchor visibility suite does: asserting the shape
// would prove a filter was passed, not what it means.
import { matchesWhere, type Row } from '../../../__tests__/whereMatcher';

/**
 * M11 Communication scope, calls half (Roles & Permissions S08.2). The core is pure: the person, their scope value,
 * their linked company numbers and their record reach are injected, so nothing here touches a request.
 */

const ME = 'u-me';
const OTHER = 'u-other';
const LINKED = 'num-linked';
const UNLINKED = 'num-unlinked';
const ORG_DEFAULT = 'num-org-default';

const OPEN = {};
const NOTHING = { ...MATCH_NOTHING };
const OWN_JOB = { assignees: { some: { user_id: ME } } };
const OWN_CUSTOMER = { owner_id: ME };

const jobMine = { id: 'job-mine', assignees: [{ user_id: ME }] };
const jobTheirs = { id: 'job-theirs', assignees: [{ user_id: OTHER }] };
const customerMine = { id: 'cust-mine', owner_id: ME };
const customerTheirs = { id: 'cust-theirs', owner_id: OTHER };

function call(id: string, fields: Partial<Row> = {}): Row {
  return {
    id,
    phone_number_id: null,
    agent_id: null,
    job_id: null, job: null,
    lead_id: null, lead: null,
    customer_id: null, customer: null,
    vendor_id: null,
    ...fields,
  };
}

const onLinked = call('on-linked', { phone_number_id: LINKED });
const onUnlinked = call('on-unlinked', { phone_number_id: UNLINKED });
const onOrgDefault = call('on-org-default', { phone_number_id: ORG_DEFAULT });
const placedByMeOnUnlinked = call('placed-by-me', { phone_number_id: UNLINKED, agent_id: ME });
const answeredByOther = call('answered-by-other', { phone_number_id: UNLINKED, agent_id: OTHER });
const noNumber = call('no-number');
const jobTiedUnlinked = call('job-tied-unlinked', { phone_number_id: UNLINKED, job_id: jobMine.id, job: jobMine });
const otherJobTiedUnlinked = call('other-job-tied', { phone_number_id: UNLINKED, job_id: jobTheirs.id, job: jobTheirs });
const tiedToNothing = call('tied-to-nothing', { phone_number_id: UNLINKED });
const customerOnlyMine = call('customer-only-mine', { phone_number_id: UNLINKED, customer_id: customerMine.id, customer: customerMine });
const customerOnlyTheirs = call('customer-only-theirs', { phone_number_id: UNLINKED, customer_id: customerTheirs.id, customer: customerTheirs });
const vendorOnly = call('vendor-only', { phone_number_id: UNLINKED, vendor_id: 'vend-1' });
// The precedence row: a call stamped with a job AND a customer is governed by the job.
const otherJobAndMyCustomer = call('other-job-and-my-customer', {
  phone_number_id: UNLINKED, job_id: jobTheirs.id, job: jobTheirs, customer_id: customerMine.id, customer: customerMine,
});

const ALL_CALLS = [
  onLinked, onUnlinked, onOrgDefault, placedByMeOnUnlinked, answeredByOther, noNumber, jobTiedUnlinked,
  otherJobTiedUnlinked, tiedToNothing, customerOnlyMine, customerOnlyTheirs, vendorOnly, otherJobAndMyCustomer,
];

function inputs(over: Partial<CommunicationScopeInputs> = {}): CommunicationScopeInputs {
  return {
    personId: ME,
    scope: 'attached',
    linkedNumberIds: [LINKED],
    // The main-line fallback is off unless a test turns it on, so the S08.2 cases above read as they did.
    seeMainLineWhenNoNumber: false,
    orgDefaultNumberId: ORG_DEFAULT,
    // No mailbox unless a test gives one: the call cases above never read it.
    mailboxIds: [],
    // The main mailbox is read by nobody unless a test makes the person one of its readers.
    mainMailboxId: null,
    // No record conversation reached through its record unless a test gives one.
    recordThreadIds: [],
    // No attributed reply unless a test gives one.
    repliedMessageIds: [],
    reach: { job: OWN_JOB, lead: NOTHING, customer: OWN_CUSTOMER, vendors: false },
    ...over,
  };
}

const listed = (i: CommunicationScopeInputs) =>
  ALL_CALLS.filter((c) => matchesWhere(c, callsInSectionWhere(i))).map((c) => c.id);
const readable = (i: CommunicationScopeInputs) =>
  ALL_CALLS.filter((c) => matchesWhere(c, callReadWhere(i))).map((c) => c.id);

describe('the call log under "Linked to me"', () => {
  it('lists a call on a linked number and not one on an unlinked number', () => {
    expect(listed(inputs())).toContain(onLinked.id);
    expect(listed(inputs())).not.toContain(onUnlinked.id);
  });

  it('lists a call the person placed or answered on an unlinked number, and not another person\'s', () => {
    expect(listed(inputs())).toContain(placedByMeOnUnlinked.id);
    expect(listed(inputs())).not.toContain(answeredByOther.id);
  });

  it('does not list a call tied to nothing, on any number, when the person is not linked to it', () => {
    expect(listed(inputs())).not.toContain(tiedToNothing.id);
    expect(listed(inputs())).not.toContain(noNumber.id);
  });

  it('does not list a call because a job, customer or vendor is tied to it: the section list uses the scope only', () => {
    const ids = listed(inputs());
    for (const c of [jobTiedUnlinked, customerOnlyMine, vendorOnly]) expect(ids, String(c.id)).not.toContain(c.id);
  });

  it('does not treat the Organization default number as linked unless it is among the person\'s linked numbers', () => {
    expect(listed(inputs())).not.toContain(onOrgDefault.id);
    expect(listed(inputs({ linkedNumberIds: [LINKED, ORG_DEFAULT] }))).toContain(onOrgDefault.id);
  });

  it('shows a company number to everyone it is linked to', () => {
    const a = inputs({ personId: 'u-a', linkedNumberIds: [LINKED] });
    const b = inputs({ personId: 'u-b', linkedNumberIds: [LINKED, UNLINKED] });
    expect(listed(a)).toContain(onLinked.id);
    expect(listed(b)).toContain(onLinked.id);
  });

  it('lists only the person\'s own placed and answered calls when no number is linked to them', () => {
    expect(listed(inputs({ linkedNumberIds: [] }))).toEqual([placedByMeOnUnlinked.id]);
  });

  it('removes a number\'s calls on the next call once the number is no longer in the linked set', () => {
    expect(listed(inputs({ linkedNumberIds: [LINKED, UNLINKED] }))).toContain(onUnlinked.id);
    expect(listed(inputs({ linkedNumberIds: [LINKED] }))).not.toContain(onUnlinked.id);
  });
});

describe('the call log under "All"', () => {
  it('lists every call, whatever the person\'s numbers and reach', () => {
    const everything = inputs({
      scope: 'all', linkedNumberIds: [], reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false },
    });
    expect(listed(everything)).toEqual(ALL_CALLS.map((c) => c.id));
    expect(callsInSectionWhere(everything)).toEqual({});
  });
});

describe('opening one call', () => {
  it('opens a call in the section list', () => {
    expect(readable(inputs())).toEqual(expect.arrayContaining([onLinked.id, placedByMeOnUnlinked.id]));
  });

  it('opens a job-tied call on an unlinked number for a person who can open the job, though the list leaves it out', () => {
    expect(listed(inputs())).not.toContain(jobTiedUnlinked.id);
    expect(readable(inputs())).toContain(jobTiedUnlinked.id);
    expect(readable(inputs())).not.toContain(otherJobTiedUnlinked.id);
  });

  it('opens a call tied to nothing only through the scope', () => {
    expect(readable(inputs())).not.toContain(tiedToNothing.id);
    expect(readable(inputs({ scope: 'all' }))).toContain(tiedToNothing.id);
  });

  it('opens a customer-only call for a person who can open that customer, and not for one with View customers off', () => {
    expect(readable(inputs())).toContain(customerOnlyMine.id);
    expect(readable(inputs())).not.toContain(customerOnlyTheirs.id);
    const noCustomers = inputs({ reach: { job: OWN_JOB, lead: NOTHING, customer: NOTHING, vendors: false } });
    expect(readable(noCustomers)).not.toContain(customerOnlyMine.id);
  });

  it('governs a call carrying a job and a customer by the job', () => {
    expect(readable(inputs())).not.toContain(otherJobAndMyCustomer.id);
    expect(matchesWhere({ ...otherJobAndMyCustomer, job_id: jobMine.id, job: jobMine }, callReadWhere(inputs()))).toBe(true);
  });

  it('opens a vendor-only call only for a person who can view vendors', () => {
    expect(readable(inputs())).not.toContain(vendorOnly.id);
    expect(readable(inputs({ reach: { job: OWN_JOB, lead: NOTHING, customer: OWN_CUSTOMER, vendors: true } }))).toContain(vendorOnly.id);
  });

  it('opens a call tied to a job for anyone with unrestricted job reach, without requiring the job relation to exist on a call that has none', () => {
    const open = inputs({ reach: { job: OPEN, lead: OPEN, customer: NOTHING, vendors: false } });
    expect(readable(open)).toContain(jobTiedUnlinked.id);
    expect(readable(open)).toContain(otherJobTiedUnlinked.id);
    expect(readable(open)).not.toContain(tiedToNothing.id);
  });

  it('opens every call under "All"', () => {
    expect(readable(inputs({ scope: 'all' }))).toEqual(ALL_CALLS.map((c) => c.id));
    expect(callReadWhere(inputs({ scope: 'all' }))).toEqual({});
  });
});

describe('the main-line fallback under "Linked to me"', () => {
  const noNumber_ = (over: Partial<CommunicationScopeInputs> = {}) => inputs({ linkedNumberIds: [], ...over });
  const onMainLineTiedToMyJob = call('main-line-job-tied', { phone_number_id: ORG_DEFAULT, job_id: jobMine.id, job: jobMine });

  it('lists the main line\'s calls for a person with no linked number who holds the switch', () => {
    const ids = [onOrgDefault, onMainLineTiedToMyJob].filter((c) => matchesWhere(c, callsInSectionWhere(noNumber_({ seeMainLineWhenNoNumber: true })))).map((c) => c.id);
    expect(ids).toEqual([onOrgDefault.id, onMainLineTiedToMyJob.id]);
    expect(listed(noNumber_({ seeMainLineWhenNoNumber: true }))).toContain(placedByMeOnUnlinked.id);
    expect(listed(noNumber_({ seeMainLineWhenNoNumber: true }))).not.toContain(onUnlinked.id);
  });

  it('lists only the calls the person placed or answered with the switch off, and a main-line call tied to a job they can open opens from that job', () => {
    expect(listed(noNumber_())).toEqual([placedByMeOnUnlinked.id]);
    const withSwitchOff = noNumber_();
    expect(matchesWhere(onMainLineTiedToMyJob, callsInSectionWhere(withSwitchOff))).toBe(false);
    expect(matchesWhere(onMainLineTiedToMyJob, callReadWhere(withSwitchOff))).toBe(true);
  });

  it('gives no main-line call to a person with one linked number, whatever the switch says', () => {
    const one = inputs({ seeMainLineWhenNoNumber: true });
    expect(listed(one)).toContain(onLinked.id);
    expect(listed(one)).not.toContain(onOrgDefault.id);
    expect(readable(one)).not.toContain(onOrgDefault.id);
  });

  it('ends the fallback the moment a first number is linked and restores it when that number is unlinked', () => {
    const base = { seeMainLineWhenNoNumber: true } as const;
    expect(listed(noNumber_(base))).toContain(onOrgDefault.id);
    expect(listed(inputs({ ...base, linkedNumberIds: [UNLINKED] }))).not.toContain(onOrgDefault.id);
    expect(listed(noNumber_(base))).toContain(onOrgDefault.id);
  });

  it('adds nothing when the organization has no default number', () => {
    expect(listed(noNumber_({ seeMainLineWhenNoNumber: true, orgDefaultNumberId: null }))).toEqual([placedByMeOnUnlinked.id]);
  });

  it('changes nothing under "All"', () => {
    for (const on of [true, false]) {
      const i = noNumber_({ scope: 'all', seeMainLineWhenNoNumber: on });
      expect(callsInSectionWhere(i)).toEqual({});
      expect(numbersInSectionWhere(i)).toEqual({});
    }
  });
});

describe('the company numbers list', () => {
  const rows = [LINKED, UNLINKED, ORG_DEFAULT].map((id) => ({ id }));
  const numbers = (i: CommunicationScopeInputs) => rows.filter((r) => matchesWhere(r, numbersInSectionWhere(i))).map((r) => r.id);

  it('returns only the linked numbers under "Linked to me"', () => {
    expect(numbers(inputs({ linkedNumberIds: [LINKED, UNLINKED] }))).toEqual([LINKED, UNLINKED]);
  });

  it('returns the main line alone for a person with no number who holds the switch, and nothing with it off', () => {
    expect(numbers(inputs({ linkedNumberIds: [], seeMainLineWhenNoNumber: true }))).toEqual([ORG_DEFAULT]);
    expect(numbers(inputs({ linkedNumberIds: [], seeMainLineWhenNoNumber: false }))).toEqual([]);
  });

  it('does not add the main line to a person who has a number', () => {
    expect(numbers(inputs({ seeMainLineWhenNoNumber: true }))).toEqual([LINKED]);
  });

  it('returns every number under "All"', () => {
    expect(numbers(inputs({ scope: 'all', linkedNumberIds: [] }))).toEqual([LINKED, UNLINKED, ORG_DEFAULT]);
  });
});

describe('email under "Linked to me"', () => {
  const MY_BOX = 'box-mine';
  const COLLEAGUE_BOX = 'box-colleague';
  const MAIN_BOX = 'box-main';

  type Thread = {
    mailbox_id: string; origin: string; record_type: string | null; assigned_to_user_id: string | null; emails: Row[];
  };
  const thread = (mailbox: string, over: Partial<Thread> = {}): Thread => ({
    mailbox_id: mailbox, origin: 'started', record_type: null, assigned_to_user_id: null, emails: [], ...over,
  });

  /** One email message: its conversation (`thread`) carries the mailbox, the message carries the record ties. */
  function email(id: string, conversation: Thread | null, fields: Partial<Row> = {}): Row {
    return {
      id,
      thread_id: conversation ? `thread-${id}` : null,
      thread: conversation ? { id: `thread-${id}`, ...conversation } : null,
      job_id: null, job: null,
      lead_id: null, lead: null,
      customer_id: null, customer: null,
      vendor_id: null,
      ...fields,
    };
  }

  const inMyBox = email('in-my-box', thread(MY_BOX));
  const inColleagueBox = email('in-colleague-box', thread(COLLEAGUE_BOX));
  const inMainBox = email('in-main-box', thread(MAIN_BOX));
  const loose = email('loose-system-mail', null);
  const customerOnlyOutside = email('customer-only-outside', thread(COLLEAGUE_BOX), { customer_id: customerMine.id, customer: customerMine });
  const myJobOutside = email('my-job-outside', thread(COLLEAGUE_BOX), { job_id: jobMine.id, job: jobMine });
  const otherJobOutside = email('other-job-outside', thread(COLLEAGUE_BOX), { job_id: jobTheirs.id, job: jobTheirs });
  // Two messages of ONE conversation in my mailbox, tied to jobs I can and cannot open.
  const myBoxOtherJob = email('my-box-other-job', thread(MY_BOX), { job_id: jobTheirs.id, job: jobTheirs });
  // Assigned to me, or one I wrote in, while sitting in a colleague's mailbox.
  const assignedToMe = email('assigned-to-me', thread(COLLEAGUE_BOX, { assigned_to_user_id: ME }));
  const iWroteIn = email('i-wrote-in', thread(COLLEAGUE_BOX, { emails: [{ sent_by_user_id: ME }] }));
  const colleagueWroteIn = email('colleague-wrote-in', thread(COLLEAGUE_BOX, { emails: [{ sent_by_user_id: 'someone-else' }] }));
  // Record conversations: one in my mailbox, one in the main mailbox assigned to me, one in a colleague's.
  const recordInMyBox = email('record-in-my-box', thread(MY_BOX, { origin: 'record', record_type: 'invoice' }), { job_id: jobMine.id, job: jobMine });
  const recordAssigned = email('record-assigned', thread(MAIN_BOX, { origin: 'record', record_type: 'invoice', assigned_to_user_id: ME }), { job_id: jobMine.id, job: jobMine });
  const recordOfAJob = email('record-of-a-job', thread(COLLEAGUE_BOX, { origin: 'record', record_type: 'job' }), { job_id: jobMine.id, job: jobMine });
  // A calendar entry notice follows its record like the others: the mailbox, assignment and authorship never list it.
  const recordOfACalendarEntry = email('record-of-a-calendar-entry', thread(MY_BOX, { origin: 'record', record_type: 'calendar_entry' }));
  // A record conversation opened about a kind of record with no rule of its own is ordinary.
  const recordOfAnOtherKind = email('record-other-kind', thread(MY_BOX, { origin: 'record', record_type: 'purchase_order' }));
  // Before go-live: placed in the main mailbox, owned by nobody.
  const migrated = email('migrated', thread(MAIN_BOX, { origin: 'migrated' }), { job_id: jobMine.id, job: jobMine });
  const ALL_EMAIL = [
    inMyBox, inColleagueBox, inMainBox, loose, customerOnlyOutside, myJobOutside, otherJobOutside, myBoxOtherJob,
    assignedToMe, iWroteIn, colleagueWroteIn, recordInMyBox, recordAssigned, recordOfAJob, recordOfACalendarEntry, recordOfAnOtherKind, migrated,
  ];

  const mine = (over: Partial<CommunicationScopeInputs> = {}) => inputs({ mailboxIds: [MY_BOX], ...over });
  const emailListed = (i: CommunicationScopeInputs) =>
    ALL_EMAIL.filter((e) => matchesWhere(e, emailsInSectionWhere(i))).map((e) => e.id);
  const emailReadable = (i: CommunicationScopeInputs) =>
    ALL_EMAIL.filter((e) => matchesWhere(e, emailReadWhere(i))).map((e) => e.id);

  it('lists a conversation in one of the injected mailboxes, and never one only assigned to the person or written in by them (M1)', () => {
    expect(emailListed(mine())).toEqual([inMyBox.id, myBoxOtherJob.id, recordOfAnOtherKind.id]);
    expect(emailListed(mine({ mailboxIds: [MY_BOX, MAIN_BOX] }))).toEqual([
      inMyBox.id, inMainBox.id, myBoxOtherJob.id, recordOfAnOtherKind.id, migrated.id,
    ]);
    // Neither listed nor opened: assignment and authorship are not reach.
    for (const e of [assignedToMe, iWroteIn]) {
      expect(emailListed(mine()), String(e.id)).not.toContain(e.id);
      expect(emailReadable(mine()), String(e.id)).not.toContain(e.id);
    }
  });

  it('drops a mailbox the moment it leaves the input, and keeps nothing for being assigned or having written in it (M1)', () => {
    expect(emailListed(mine({ mailboxIds: [] }))).toEqual([]);
    expect(emailReadable(mine({ mailboxIds: [] }))).not.toEqual(expect.arrayContaining([assignedToMe.id]));
    expect(emailReadable(mine({ mailboxIds: [] }))).not.toEqual(expect.arrayContaining([iWroteIn.id]));
    expect(emailListed(mine({ mailboxIds: [MY_BOX, COLLEAGUE_BOX] }))).toContain(inColleagueBox.id);
    expect(emailListed(mine({ mailboxIds: [MY_BOX] }))).not.toContain(inColleagueBox.id);
  });

  it('does not list a colleague\'s conversation because a colleague wrote in it', () => {
    expect(emailListed(mine())).not.toContain(colleagueWroteIn.id);
  });

  it('does not list a customer-only, job-tied or loose email: a tie plays no part in the section list', () => {
    const ids = emailListed(mine());
    for (const e of [customerOnlyOutside, myJobOutside, loose]) expect(ids, String(e.id)).not.toContain(e.id);
  });

  it('lists no record conversation by mailbox, assignment or writing: only one whose record the person can open', () => {
    expect(emailListed(mine())).not.toContain(recordInMyBox.id);
    expect(emailListed(mine())).not.toContain(recordAssigned.id);
    const reached = mine({ recordThreadIds: ['thread-record-in-my-box', 'thread-record-assigned'] });
    expect(emailListed(reached)).toEqual(expect.arrayContaining([recordInMyBox.id, recordAssigned.id]));
    expect(emailListed(reached)).not.toContain(recordOfAJob.id);
  });

  it('treats a calendar entry notice as a record conversation: listed only once its customer is reached', () => {
    expect(emailListed(mine())).not.toContain(recordOfACalendarEntry.id);
    expect(emailReadable(mine())).not.toContain(recordOfACalendarEntry.id);
    const reached = mine({ recordThreadIds: ['thread-record-of-a-calendar-entry'] });
    expect(emailListed(reached)).toContain(recordOfACalendarEntry.id);
    expect(emailReadable(reached)).toContain(recordOfACalendarEntry.id);
  });

  it('adds no email conversation through the main-line fallback, with the switch on or off', () => {
    for (const on of [true, false]) {
      const i = mine({ linkedNumberIds: [], seeMainLineWhenNoNumber: on, orgDefaultNumberId: ORG_DEFAULT });
      expect(emailListed(i)).toEqual(emailListed(mine()));
    }
  });

  it('is not widened by the person\'s linked numbers or call reach', () => {
    const wideReach = mine({ linkedNumberIds: [LINKED, UNLINKED], reach: { job: OPEN, lead: OPEN, customer: OPEN, vendors: true } });
    expect(emailListed(wideReach)).toEqual(emailListed(mine()));
  });

  it('lists every email conversation under "All"', () => {
    const everything = mine({ scope: 'all', mailboxIds: [], reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false } });
    expect(emailListed(everything)).toEqual(ALL_EMAIL.map((e) => e.id));
    expect(emailsInSectionWhere(everything)).toEqual({});
  });

  describe('opening one', () => {
    it('opens every message of a conversation in the person\'s mailbox, whatever job each message is tied to', () => {
      const ids = emailReadable(mine());
      expect(ids).toEqual(expect.arrayContaining([inMyBox.id, myBoxOtherJob.id]));
    });

    it('opens a job-tied conversation outside the person\'s mailboxes message by message through the job record rule', () => {
      const ids = emailReadable(mine());
      expect(emailListed(mine())).not.toContain(myJobOutside.id);
      expect(ids).toContain(myJobOutside.id);
      expect(ids).not.toContain(otherJobOutside.id);
      expect(ids).not.toContain(inColleagueBox.id);
    });

    it('opens a customer-only email only for a person who can open that customer, and loose mail the same way', () => {
      expect(emailReadable(mine())).toContain(customerOnlyOutside.id);
      const noCustomers = mine({ reach: { job: OWN_JOB, lead: NOTHING, customer: NOTHING, vendors: false } });
      expect(emailReadable(noCustomers)).not.toContain(customerOnlyOutside.id);
      expect(emailReadable(mine())).not.toContain(loose.id);
    });

    it('opens a pre-migration conversation through a job the person can open, and not through the mailbox it was placed in', () => {
      expect(emailReadable(mine())).toContain(migrated.id);
      expect(emailReadable(mine({ reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false } }))).not.toContain(migrated.id);
    });

    it('opens a record conversation through its record alone: never message by message, never because its mailbox is the person\'s', () => {
      const none = mine({ reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false } });
      expect(emailReadable(none)).not.toContain(recordInMyBox.id);
      // Reaching the job of one of its messages does not open an invoice conversation ...
      expect(emailReadable(mine())).not.toContain(recordInMyBox.id);
      expect(emailReadable(mine())).not.toContain(recordOfAJob.id);
      // ... the record does.
      const reached = mine({ recordThreadIds: ['thread-record-in-my-box', 'thread-record-of-a-job'] });
      expect(emailReadable(reached)).toEqual(expect.arrayContaining([recordInMyBox.id, recordOfAJob.id]));
    });

    it('opens everything under "All"', () => {
      expect(emailReadable(mine({ scope: 'all', mailboxIds: [] }))).toEqual(ALL_EMAIL.map((e) => e.id));
      expect(emailReadWhere(mine({ scope: 'all' }))).toEqual({});
    });
  });
});

describe('the main mailbox under "Linked to me" (S10.8)', () => {
  const MAIN_BOX = 'box-main';
  const OTHER_BOX = 'box-other';
  type Thread = { mailbox_id: string; origin: string; record_type: string | null; assigned_to_user_id: string | null; emails: Row[] };
  const thread = (mailbox: string, over: Partial<Thread> = {}): Thread => ({
    mailbox_id: mailbox, origin: 'started', record_type: null, assigned_to_user_id: null, emails: [], ...over,
  });
  const email = (id: string, conversation: Thread, vendorId: string | null = null): Row => ({
    id, thread_id: `thread-${id}`, thread: { id: `thread-${id}`, ...conversation },
    job_id: null, job: null, lead_id: null, lead: null, customer_id: null, customer: null, vendor_id: vendorId,
  });

  const started = email('started', thread(MAIN_BOX, { emails: [{ vendor_id: null }] }));
  const migrated = email('migrated', thread(MAIN_BOX, { origin: 'migrated' }));
  const moved = email('moved', thread(MAIN_BOX, { origin: 'moved' }));
  const record = email('record', thread(MAIN_BOX, { origin: 'record', record_type: 'job' }));
  const assignedMigrated = email('assigned-migrated', thread(MAIN_BOX, { origin: 'migrated', assigned_to_user_id: ME }));
  const vendorTied = email('vendor-tied', thread(MAIN_BOX, { emails: [{ vendor_id: 'vend-1' }] }), 'vend-1');
  const elsewhere = email('elsewhere', thread(OTHER_BOX));
  const ALL = [started, migrated, moved, record, assignedMigrated, vendorTied, elsewhere];

  const reader = (over: Partial<CommunicationScopeInputs> = {}) => inputs({ mainMailboxId: MAIN_BOX, reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: true }, ...over });
  const listedFor = (i: CommunicationScopeInputs) => ALL.filter((e) => matchesWhere(e, emailsInSectionWhere(i))).map((e) => e.id);
  const readableFor = (i: CommunicationScopeInputs) => ALL.filter((e) => matchesWhere(e, emailReadWhere(i))).map((e) => e.id);

  it('lists to a reader only what was started in it, with the vendor-tied one for a person who holds View vendors, and not a migrated one assigned to them (M1)', () => {
    expect(listedFor(reader())).toEqual([started.id, vendorTied.id]);
    expect(readableFor(reader())).toEqual([started.id, vendorTied.id]);
  });

  it('keeps a vendor-tied conversation from a person without View vendors', () => {
    const noVendors = reader({ reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false } });
    expect(listedFor(noVendors)).toEqual([started.id]);
    expect(readableFor(noVendors)).not.toContain(vendorTied.id);
  });

  it('lists and opens nothing of it to a person who does not read it, even what is assigned to them (M1)', () => {
    expect(listedFor(reader({ mainMailboxId: null }))).toEqual([]);
    // Only the vendor-tied message opens, through its own tie (the person holds View vendors), never through assignment.
    expect(readableFor(reader({ mainMailboxId: null }))).toEqual([vendorTied.id]);
  });
});

describe('which mailbox the Email page shows', () => {
  const self = { id: ME, ownMailboxId: 'box-mine' };
  const rows = [
    { id: 'own', thread: { mailbox_id: 'box-mine', assigned_to_user_id: null, emails: [] } },
    { id: 'handed', thread: { mailbox_id: 'box-handed', assigned_to_user_id: null, emails: [] } },
    { id: 'assigned', thread: { mailbox_id: 'box-colleague', assigned_to_user_id: ME, emails: [] } },
    { id: 'wrote', thread: { mailbox_id: 'box-colleague', assigned_to_user_id: null, emails: [{ sent_by_user_id: ME }] } },
    { id: 'theirs', thread: { mailbox_id: 'box-colleague', assigned_to_user_id: null, emails: [] } },
  ];
  const shown = (selection: Parameters<typeof mailboxSelectionWhere>[0]) =>
    rows.filter((r) => matchesWhere(r, mailboxSelectionWhere(selection, self))).map((r) => r.id);

  it('shows my own mailbox, what is assigned to me and what I wrote in under "My mailbox"', () => {
    expect(shown({ kind: 'mine' })).toEqual(['own', 'assigned', 'wrote']);
  });

  it('shows one mailbox and only that one when it is picked', () => {
    expect(shown({ kind: 'mailbox', id: 'box-handed' })).toEqual(['handed']);
  });

  it('narrows nothing for all mailboxes', () => {
    expect(mailboxSelectionWhere({ kind: 'all' }, self)).toEqual({});
  });

  it('shows no mailbox of its own for a person who has none, only what is assigned to them or written by them', () => {
    const ids = rows.filter((r) => matchesWhere(r, mailboxSelectionWhere({ kind: 'mine' }, { id: ME, ownMailboxId: null }))).map((r) => r.id);
    expect(ids).toEqual(['assigned', 'wrote']);
  });
});

describe('text messages under "Linked to me"', () => {
  /**
   * One text message. The message carries the company number, the sender and the job/lead ties; the customer and vendor
   * ties sit on its conversation (`thread`), and a staff conversation names its person there.
   */
  function text(id: string, fields: Partial<Row> = {}, thread: Partial<Row> = {}): Row {
    return {
      id,
      direction: 'in',
      phone_number_id: null,
      sent_by_user_id: null,
      job_id: null, job: null,
      lead_id: null, lead: null,
      thread: { user_id: null, customer_id: null, customer: null, vendor_id: null, ...thread },
      ...fields,
    };
  }

  const inOnLinked = text('in-on-linked', { phone_number_id: LINKED });
  const outOnLinked = text('out-on-linked', { direction: 'out', phone_number_id: LINKED, sent_by_user_id: OTHER });
  const inOnUnlinked = text('in-on-unlinked', { phone_number_id: UNLINKED });
  const outOnUnlinked = text('out-on-unlinked', { direction: 'out', phone_number_id: UNLINKED, sent_by_user_id: OTHER });
  const sentByMeOnMainLine = text('sent-by-me-on-main-line', { direction: 'out', phone_number_id: ORG_DEFAULT, sent_by_user_id: ME });
  const sentByMeNoNumber = text('sent-by-me-no-number', { direction: 'out', sent_by_user_id: ME });
  const onMainLine = text('on-main-line', { phone_number_id: ORG_DEFAULT });
  const noNumber = text('no-number');
  const myStaffThread = text('my-staff-thread', { direction: 'in' }, { user_id: ME });
  const theirStaffThread = text('their-staff-thread', { direction: 'in' }, { user_id: OTHER });
  const jobTiedUnlinked = text('job-tied-unlinked', { phone_number_id: UNLINKED, job_id: jobMine.id, job: jobMine });
  const otherJobTiedUnlinked = text('other-job-tied-unlinked', { phone_number_id: UNLINKED, job_id: jobTheirs.id, job: jobTheirs });
  const customerOnlyMine = text('customer-only-mine', { phone_number_id: UNLINKED }, { customer_id: customerMine.id, customer: customerMine });
  const customerOnlyTheirs = text('customer-only-theirs', { phone_number_id: UNLINKED }, { customer_id: customerTheirs.id, customer: customerTheirs });
  const vendorOnly = text('vendor-only', { phone_number_id: UNLINKED }, { vendor_id: 'vend-1' });
  // The precedence row: a text stamped with a job AND on a conversation of my customer is governed by the job.
  const otherJobOnMyCustomer = text('other-job-on-my-customer', { phone_number_id: UNLINKED, job_id: jobTheirs.id, job: jobTheirs }, { customer_id: customerMine.id, customer: customerMine });
  const ALL_TEXTS = [
    inOnLinked, outOnLinked, inOnUnlinked, outOnUnlinked, sentByMeOnMainLine, sentByMeNoNumber, onMainLine, noNumber,
    myStaffThread, theirStaffThread, jobTiedUnlinked, otherJobTiedUnlinked, customerOnlyMine, customerOnlyTheirs,
    vendorOnly, otherJobOnMyCustomer,
  ];

  const textListed = (i: CommunicationScopeInputs) =>
    ALL_TEXTS.filter((t) => matchesWhere(t, textsInSectionWhere(i))).map((t) => t.id);
  const textReadable = (i: CommunicationScopeInputs) =>
    ALL_TEXTS.filter((t) => matchesWhere(t, textReadWhere(i))).map((t) => t.id);

  it('lists a message on a linked number, inbound or outbound, and not one on an unlinked number', () => {
    const ids = textListed(inputs());
    expect(ids).toEqual(expect.arrayContaining([inOnLinked.id, outOnLinked.id]));
    expect(ids).not.toContain(inOnUnlinked.id);
    expect(ids).not.toContain(outOnUnlinked.id);
  });

  it('keeps a text the person sent from the app, even from the Organization default number or with no number', () => {
    const noLinkedNumber = inputs({ linkedNumberIds: [] });
    expect(textListed(noLinkedNumber)).toEqual(
      expect.arrayContaining([sentByMeOnMainLine.id, sentByMeNoNumber.id]),
    );
    expect(textListed(noLinkedNumber)).not.toContain(onMainLine.id);
  });

  it('counts the person\'s own staff conversation as theirs, and not another person\'s', () => {
    expect(textListed(inputs())).toContain(myStaffThread.id);
    expect(textListed(inputs())).not.toContain(theirStaffThread.id);
  });

  it('lists a text with no company number under "All" only, even through the main-line fallback', () => {
    expect(textListed(inputs({ linkedNumberIds: [], seeMainLineWhenNoNumber: true }))).not.toContain(noNumber.id);
    expect(textListed(inputs({ linkedNumberIds: [LINKED] }))).not.toContain(noNumber.id);
    expect(textListed(inputs({ scope: 'all' }))).toContain(noNumber.id);
  });

  it('shows the main line\'s texts to a person with no number who holds the switch, and not with it off', () => {
    const noNumberOn = inputs({ linkedNumberIds: [], seeMainLineWhenNoNumber: true });
    expect(textListed(noNumberOn)).toContain(onMainLine.id);
    expect(textListed(inputs({ linkedNumberIds: [], seeMainLineWhenNoNumber: false }))).not.toContain(onMainLine.id);
    // One linked number: no fallback, whatever the switch says.
    expect(textListed(inputs({ seeMainLineWhenNoNumber: true }))).not.toContain(onMainLine.id);
  });

  it('does not list a text because a job, customer or vendor is tied to it: the section list uses the scope only', () => {
    const ids = textListed(inputs());
    for (const t of [jobTiedUnlinked, customerOnlyMine, vendorOnly]) expect(ids, String(t.id)).not.toContain(t.id);
  });

  it('lists every message under "All", whatever the person\'s numbers and reach', () => {
    const everything = inputs({
      scope: 'all', linkedNumberIds: [], reach: { job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false },
    });
    expect(textListed(everything)).toEqual(ALL_TEXTS.map((t) => t.id));
    expect(textsInSectionWhere(everything)).toEqual({});
  });

  it('lists a conversation when it holds at least one of the person\'s messages, and no conversation otherwise', () => {
    const conversation = (messages: Row[]): Row => ({ id: 'c', messages });
    const holding = textThreadHolding(textsInSectionWhere(inputs()));
    expect(matchesWhere(conversation([inOnUnlinked, inOnLinked]), holding)).toBe(true);
    expect(matchesWhere(conversation([inOnUnlinked, outOnUnlinked]), holding)).toBe(false);
    expect(matchesWhere(conversation([]), holding)).toBe(false);
    expect(textThreadHolding({})).toEqual({});
  });

  describe('opening one', () => {
    it('opens every message in the section list', () => {
      expect(textReadable(inputs())).toEqual(expect.arrayContaining(textListed(inputs())));
    });

    it('opens a job-tied message on an unlinked number for a person who can open the job, and not another job\'s', () => {
      expect(textListed(inputs())).not.toContain(jobTiedUnlinked.id);
      expect(textReadable(inputs())).toContain(jobTiedUnlinked.id);
      expect(textReadable(inputs())).not.toContain(otherJobTiedUnlinked.id);
    });

    it('opens a customer-only message only for a person who can open that customer', () => {
      expect(textReadable(inputs())).toContain(customerOnlyMine.id);
      expect(textReadable(inputs())).not.toContain(customerOnlyTheirs.id);
      const noCustomers = inputs({ reach: { job: OWN_JOB, lead: NOTHING, customer: NOTHING, vendors: false } });
      expect(textReadable(noCustomers)).not.toContain(customerOnlyMine.id);
    });

    it('governs a message carrying a job and a customer by the job', () => {
      expect(textReadable(inputs())).not.toContain(otherJobOnMyCustomer.id);
    });

    it('opens a vendor-only message only for a person who can view vendors, and one tied to nothing never', () => {
      expect(textReadable(inputs())).not.toContain(vendorOnly.id);
      const withVendors = inputs({ reach: { job: OWN_JOB, lead: NOTHING, customer: OWN_CUSTOMER, vendors: true } });
      expect(textReadable(withVendors)).toContain(vendorOnly.id);
      expect(textReadable(withVendors)).not.toContain(noNumber.id);
    });

    it('returns the person\'s own messages and the job\'s, and leaves out another job\'s on an unlinked number', () => {
      const ids = textReadable(inputs());
      expect(ids).toEqual(expect.arrayContaining([inOnLinked.id, jobTiedUnlinked.id]));
      expect(ids).not.toContain(otherJobTiedUnlinked.id);
      expect(ids).not.toContain(inOnUnlinked.id);
    });

    it('returns every message under "All"', () => {
      expect(textReadable(inputs({ scope: 'all' }))).toEqual(ALL_TEXTS.map((t) => t.id));
      expect(textReadWhere(inputs({ scope: 'all' }))).toEqual({});
    });
  });
});

describe('reply attribution for texts (S08.6)', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z');
  const minute = (n: number) => new Date(T0 + n * 60_000);

  /** One message of a conversation, with the fields the attribution reads. */
  function msg(id: string, fields: Partial<Row> & { threadId?: string }): Row {
    const { threadId, ...rest } = fields;
    return {
      id, thread_id: threadId ?? 'thread-1', direction: 'in', phone_number_id: ORG_DEFAULT, sent_by_user_id: null,
      ts: minute(0), job_id: null, job: null, lead_id: null, lead: null,
      thread: { user_id: null, customer_id: null, customer: null, vendor_id: null },
      ...rest,
    };
  }

  /** What the person's inbox lists when `conversation` is all that exists: the attribution feeds the scope's input. */
  function listedFor(conversation: Row[], over: Partial<CommunicationScopeInputs> = {}) {
    const i = inputs({ linkedNumberIds: [], ...over });
    const withReplies = { ...i, repliedMessageIds: replyAttributedMessageIds(ME, conversation as never) };
    return conversation.filter((m) => matchesWhere(m, textsInSectionWhere(withReplies))).map((m) => m.id);
  }

  const mySend = msg('my-send', { direction: 'out', sent_by_user_id: ME, ts: minute(0) });

  it('lists the customer\'s reply on the Organization default number for a person with no linked number who sent from it', () => {
    const reply = msg('reply', { ts: minute(5) });
    expect(listedFor([mySend, reply])).toEqual(['my-send', 'reply']);
  });

  it('leaves a reply that nobody in the conversation is waiting on out of the list', () => {
    expect(listedFor([msg('unprompted', { ts: minute(5) })])).toEqual([]);
  });

  it('attributes the following reply to whoever sent the next outbound message on that number, not to the first person', () => {
    const conversation = [
      mySend,
      msg('first-reply', { ts: minute(5) }),
      msg('colleague-send', { direction: 'out', sent_by_user_id: OTHER, ts: minute(10) }),
      msg('second-reply', { ts: minute(15) }),
    ];
    expect(listedFor(conversation)).toEqual(['my-send', 'first-reply']);
    const theirs = replyAttributedMessageIds(OTHER, conversation as never);
    expect(theirs).toEqual(['second-reply']);
  });

  it('does not attribute a reply on a different company number than the person\'s last outbound', () => {
    const conversation = [mySend, msg('reply-elsewhere', { phone_number_id: UNLINKED, ts: minute(5) })];
    expect(listedFor(conversation)).toEqual(['my-send']);
  });

  it('does not carry a send across conversations', () => {
    const conversation = [mySend, msg('other-thread-reply', { threadId: 'thread-2', ts: minute(5) })];
    expect(listedFor(conversation)).toEqual(['my-send']);
  });

  it('does not attribute a reply when an automated text went out after the person\'s own', () => {
    const conversation = [
      mySend,
      msg('automated', { direction: 'out', sent_by_user_id: null, ts: minute(2) }),
      msg('reply', { ts: minute(5) }),
    ];
    expect(listedFor(conversation)).toEqual(['my-send']);
  });

  it('ignores a send that carries no company number, and replies with none', () => {
    const conversation = [
      msg('old-send', { direction: 'out', sent_by_user_id: ME, phone_number_id: null, ts: minute(0) }),
      msg('reply-no-number', { phone_number_id: null, ts: minute(5) }),
    ];
    expect(replyAttributedMessageIds(ME, conversation as never)).toEqual([]);
  });

  it('keeps attributing after the person is also linked to some number', () => {
    const reply = msg('reply', { ts: minute(5) });
    expect(listedFor([mySend, reply], { linkedNumberIds: [LINKED] })).toEqual(['my-send', 'reply']);
  });

  it('opens an attributed reply the same way it lists it, and adds nothing under "All"', () => {
    const reply = msg('reply', { ts: minute(5) });
    const i = { ...inputs({ linkedNumberIds: [] }), repliedMessageIds: replyAttributedMessageIds(ME, [mySend, reply] as never) };
    expect(matchesWhere(reply, textReadWhere(i))).toBe(true);
    expect(textsInSectionWhere({ ...i, scope: 'all' })).toEqual({});
  });
});

describe('who a reply is attributed to (S08.23)', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z');
  const minute = (n: number) => new Date(T0 + n * 60_000);
  const text = (id: string, direction: 'in' | 'out', n: number, over: Record<string, unknown> = {}) => ({
    id, thread_id: 'thread-1', direction, phone_number_id: ORG_DEFAULT, sent_by_user_id: direction === 'out' ? ME : null, ts: minute(n), ...over,
  });

  it('names, for each inbound text, the sender of the latest outbound text before it on the same number', () => {
    const senders = replySendersOf([
      text('first-send', 'out', 0), text('reply-1', 'in', 5),
      text('colleague-send', 'out', 10, { sent_by_user_id: OTHER }), text('reply-2', 'in', 15),
    ]);
    expect(senders.get('reply-1')).toBe(ME);
    expect(senders.get('reply-2')).toBe(OTHER);
  });

  it('names nobody for a reply nobody is waiting on, an automated text, another number or another conversation', () => {
    const senders = replySendersOf([
      text('unprompted', 'in', 1),
      text('sent', 'out', 2), text('automated', 'out', 3, { sent_by_user_id: null }), text('after-automated', 'in', 4),
      text('other-number-reply', 'in', 5, { phone_number_id: UNLINKED }),
      text('other-thread-reply', 'in', 6, { thread_id: 'thread-2' }),
      text('no-number-reply', 'in', 7, { phone_number_id: null }),
    ]);
    for (const id of ['unprompted', 'after-automated', 'other-number-reply', 'other-thread-reply', 'no-number-reply']) {
      expect(senders.get(id) ?? null, id).toBeNull();
    }
  });

  it('is the very rule that lists a reply for a person: they agree on every inbound text', () => {
    const conversation = [
      text('s1', 'out', 0), text('r1', 'in', 5), text('s2', 'out', 10, { sent_by_user_id: OTHER }), text('r2', 'in', 15),
      text('s3', 'out', 20), text('s4', 'out', 21, { sent_by_user_id: null }), text('r3', 'in', 25),
    ];
    const senders = replySendersOf(conversation);
    for (const person of [ME, OTHER]) {
      const listed = replyAttributedMessageIds(person, conversation);
      const named = ['r1', 'r2', 'r3'].filter((id) => senders.get(id) === person);
      expect(listed).toEqual(named);
    }
  });
});

describe('the record Communication tabs (S08.8)', () => {
  // A tab lists the rows tied to its own record, so these rows are all tied to something. What they prove is the
  // per-row rule on the customer's tab; the section scope (numbers, mailboxes) is not even an input to the tab's rule.
  const reach = inputs().reach;
  const tab = recordTabWhere(reach, OPEN, OPEN);

  function row(id: string, fields: Partial<Row> = {}): Row {
    return {
      id,
      phone_number_id: UNLINKED, // never a linked number: the tab does not ask
      job_id: null, job: null,
      lead_id: null, lead: null,
      customer_id: null, customer: null,
      vendor_id: null,
      ...fields,
    };
  }
  const leadMine = { id: 'lead-mine', assignees: [{ user_id: ME }] };
  const onMyJob = row('on-my-job', { job_id: jobMine.id, job: jobMine });
  const onOtherJob = row('on-other-job', { job_id: jobTheirs.id, job: jobTheirs });
  const onLeadReach = recordTabWhere({ ...reach, lead: { assignees: { some: { user_id: ME } } } }, OPEN, OPEN);
  const onMyLead = row('on-my-lead', { lead_id: leadMine.id, lead: leadMine });
  const customerOnly = row('customer-only', { customer_id: customerMine.id, customer: customerMine });
  const customerOnlyTheirs = row('customer-only-theirs', { customer_id: customerTheirs.id, customer: customerTheirs });
  const otherJobOnMyCustomer = row('other-job-on-my-customer', { job_id: jobTheirs.id, job: jobTheirs, customer_id: customerMine.id, customer: customerMine });
  const tiedToNothing = row('tied-to-nothing');
  const idsIn = (rows: Row[], where: Record<string, unknown>) => rows.filter((r) => matchesWhere(r, where)).map((r) => r.id);

  it('opens a job-tied row through the job, a lead-tied row through the lead, and a customer-only row through the customer', () => {
    const rows = [onMyJob, onOtherJob, onMyLead, customerOnly, customerOnlyTheirs];
    expect(idsIn(rows, tab.calls)).toEqual(['on-my-job', 'customer-only']);
    expect(idsIn(rows, onLeadReach.calls)).toEqual(['on-my-job', 'on-my-lead', 'customer-only']);
    expect(idsIn(rows, tab.emails)).toEqual(idsIn(rows, tab.calls));
  });

  it('lets the job decide a row that also names a customer the person can open, and keeps a row tied to nothing out', () => {
    expect(idsIn([otherJobOnMyCustomer, tiedToNothing], tab.calls)).toEqual([]);
  });

  it('gives a person who can open everything every tied row, and nothing with no reach at all', () => {
    const open = recordTabWhere({ job: OPEN, lead: OPEN, customer: OPEN, vendors: false }, OPEN, OPEN);
    expect(idsIn([onMyJob, onOtherJob, onMyLead, customerOnlyTheirs], open.calls)).toHaveLength(4);
    // Nothing to filter by: the query is left as the record's own tie alone.
    expect([open.calls, open.emails, open.messages, open.whatsapps, open.manuals, open.estimates]).toEqual([{}, {}, {}, {}, {}, {}]);
    const none = recordTabWhere({ job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false }, NOTHING, NOTHING);
    expect(idsIn([onMyJob, onOtherJob, onMyLead, customerOnly], none.calls)).toEqual([]);
  });

  it('puts the customer tie of a text on its conversation, and a logged entry has no vendor tie', () => {
    const text = (id: string, fields: Partial<Row>, thread: Partial<Row> = {}): Row => ({
      id, job_id: null, job: null, lead_id: null, lead: null, thread: { customer_id: null, customer: null, vendor_id: null, ...thread }, ...fields,
    });
    const messages = [
      text('text-my-job', { job_id: jobMine.id, job: jobMine }),
      text('text-other-job-my-customer', { job_id: jobTheirs.id, job: jobTheirs }, { customer_id: customerMine.id, customer: customerMine }),
      text('text-customer-only', {}, { customer_id: customerMine.id, customer: customerMine }),
      text('text-their-customer', {}, { customer_id: customerTheirs.id, customer: customerTheirs }),
    ];
    expect(idsIn(messages, tab.messages)).toEqual(['text-my-job', 'text-customer-only']);
    // A logged entry names exactly one of job, lead and customer, and the model has no vendor column: the filter must
    // not mention one, or the query would not run.
    expect(JSON.stringify(recordTabWhere({ ...reach, vendors: true }, OPEN, OPEN).manuals)).not.toContain('vendor');
    expect(idsIn([onMyJob, onOtherJob, customerOnly, customerOnlyTheirs], tab.manuals)).toEqual(['on-my-job', 'customer-only']);
  });

  it('leaves WhatsApp on the job and lead rule it has always had', () => {
    const wa = (id: string, fields: Partial<Row> = {}): Row => ({ id, job_id: null, job: null, lead_id: null, lead: null, ...fields });
    expect(idsIn([wa('mine', { job_id: jobMine.id, job: jobMine }), wa('theirs', { job_id: jobTheirs.id, job: jobTheirs }), wa('chat-only')], tab.whatsapps))
      .toEqual(['mine', 'chat-only']);
  });
});

describe('the customer\'s estimate decisions on the record tabs (S08.9)', () => {
  // An estimate carries its own job, lead and customer, and the person must be able to open the estimate itself.
  const reach = inputs().reach;
  const estimate = (id: string, fields: Partial<Row> = {}): Row => ({
    id, job_id: null, job_link: null, lead_id: null, lead: null, customer_id: customerMine.id, customer: customerMine, created_by: OTHER, ...fields,
  });
  const onMyJob = estimate('on-my-job', { job_id: jobMine.id, job_link: jobMine });
  const onOtherJob = estimate('on-other-job', { job_id: jobTheirs.id, job_link: jobTheirs });
  const forMyCustomer = estimate('for-my-customer');
  const forTheirCustomer = estimate('for-their-customer', { customer_id: customerTheirs.id, customer: customerTheirs });
  const all = [onMyJob, onOtherJob, forMyCustomer, forTheirCustomer];
  const idsIn = (where: Record<string, unknown>) => all.filter((r) => matchesWhere(r, where)).map((r) => r.id);

  it('judges an estimate by its job, else its lead, else its customer', () => {
    expect(idsIn(recordTabWhere(reach, OPEN, OPEN).estimates)).toEqual(['on-my-job', 'for-my-customer']);
  });

  it('also needs the estimate itself to be one the person can open, whatever the record rule says', () => {
    const onlyMine = recordTabWhere(reach, { created_by: ME }, OPEN).estimates;
    expect(idsIn(onlyMine)).toEqual([]);
    const mine: Row[] = all.map((r) => ({ ...r, created_by: ME }));
    expect(mine.filter((r) => matchesWhere(r, onlyMine)).map((r) => r.id)).toEqual(['on-my-job', 'for-my-customer']);
    expect(idsIn(recordTabWhere({ job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false }, OPEN, OPEN).estimates)).toEqual([]);
  });

  it('adds nothing for a person who can open everything and every estimate', () => {
    expect(recordTabWhere({ job: OPEN, lead: OPEN, customer: OPEN, vendors: false }, OPEN, OPEN).estimates).toEqual({});
  });
});

describe('the payments received on the record tabs (S08.10)', () => {
  // A payment hangs off an invoice, which carries its own job, its estimate's job and lead, and its customer; the person
  // must be able to open the invoice itself (the creator rule is part of that answer).
  const reach = inputs().reach;
  const noEstimate = { estimate_id: null, estimate: null };
  const payment = (id: string, invoice: Partial<Row> = {}): Row => ({
    id,
    invoice: { job_id: null, job: null, ...noEstimate, customer_id: customerMine.id, customer: customerMine, created_by_id: OTHER, ...invoice },
  });
  const onMyJob = payment('on-my-job', { job_id: jobMine.id, job: jobMine });
  const onOtherJob = payment('on-other-job', { job_id: jobTheirs.id, job: jobTheirs });
  const viaMyJobEstimate = payment('via-my-job-estimate', {
    estimate_id: 'e1', estimate: { job_id: jobMine.id, job_link: jobMine, lead_id: null, lead: null },
  });
  const viaOtherJobEstimate = payment('via-other-job-estimate', {
    estimate_id: 'e2', estimate: { job_id: jobTheirs.id, job_link: jobTheirs, lead_id: null, lead: null },
  });
  const onMyLeadDeposit = payment('lead-deposit-mine', {
    estimate_id: 'e3', estimate: { job_id: null, job_link: null, lead_id: 'lead-mine', lead: { id: 'lead-mine', assignees: [{ user_id: ME }] } },
  });
  const forMyCustomer = payment('for-my-customer');
  const forTheirCustomer = payment('for-their-customer', { customer_id: customerTheirs.id, customer: customerTheirs });
  const all = [onMyJob, onOtherJob, viaMyJobEstimate, viaOtherJobEstimate, onMyLeadDeposit, forMyCustomer, forTheirCustomer];
  const idsIn = (rows: Row[], where: Record<string, unknown>) => rows.filter((r) => matchesWhere(r, where)).map((r) => r.id);

  it('judges a payment by its invoice\'s job (or its estimate\'s job), else the estimate\'s lead, else the customer', () => {
    const onLeadReach = recordTabWhere({ ...reach, lead: { assignees: { some: { user_id: ME } } } }, OPEN, OPEN);
    expect(idsIn(all, recordTabWhere(reach, OPEN, OPEN).payments)).toEqual(['on-my-job', 'via-my-job-estimate', 'for-my-customer']);
    expect(idsIn(all, onLeadReach.payments)).toEqual(['on-my-job', 'via-my-job-estimate', 'lead-deposit-mine', 'for-my-customer']);
  });

  it('also needs the invoice itself to be one the person can open, whatever the record rule says', () => {
    const creatorOnly = recordTabWhere(reach, OPEN, { created_by_id: ME }).payments;
    expect(idsIn(all, creatorOnly)).toEqual([]);
    const mine: Row[] = all.map((r) => ({ ...r, invoice: { ...(r.invoice as Row), created_by_id: ME } }));
    expect(idsIn(mine, creatorOnly)).toEqual(['on-my-job', 'via-my-job-estimate', 'for-my-customer']);
    expect(idsIn(all, recordTabWhere({ job: NOTHING, lead: NOTHING, customer: NOTHING, vendors: false }, OPEN, OPEN).payments)).toEqual([]);
  });

  it('adds nothing for a person who can open everything and every invoice, and keeps the invoice rule alone otherwise', () => {
    const everything = { job: OPEN, lead: OPEN, customer: OPEN, vendors: false };
    expect(recordTabWhere(everything, OPEN, OPEN).payments).toEqual({});
    expect(idsIn(all, recordTabWhere(everything, OPEN, { created_by_id: OTHER }).payments)).toEqual(all.map((r) => r.id));
    expect(idsIn(all, recordTabWhere(everything, OPEN, { created_by_id: ME }).payments)).toEqual([]);
  });
});
