import { jobCountsAsSaleWhere } from '../jobSale';
import { THROUGH_OWN_LEADS, type ScopedSubject } from './switches/catalog';

/**
 * M3 - the access resolver's view of a record's people (Roles & Permissions, PRD 1).
 *
 * "Attached" means the same for every role: the person is one of the people on the record, and
 * nothing else attaches them. Creating a record attaches nobody, and being attached to a lead does
 * not attach a person to the job converted from it. The answer is a Prisma `where` fragment, derived
 * from the people on the record as they stand now, so a person taken off a record loses it on the
 * very next request: nothing here is cached.
 *
 *   Job:  on the crew of any visit (past or upcoming), its Sold By, or its Dispatcher.
 *   Lead: an assignee, its Owner, its Dispatcher, or on the crew of one of its walkthrough visits.
 *   Estimate: attached to its lead or to its job.
 *   Invoice: attached through its job. Only an invoice with no job (a deposit invoice before the work is
 *     converted) is attached through its estimate: attached to that estimate's lead or job. Once an
 *     invoice has a job, the estimate's lead no longer reaches it.
 *
 * Their own for an estimate or invoice is attached, plus the documents the person made for a customer alone (P7): a
 * document with no lead and no job has nobody to be attached to, so who made it is the only link. There is no other
 * reach by who made a record, and no switch-free bypass: View is the single gate (see `ownedByMaker`).
 *
 * Team means someone attached to the record is in the person's department. A person with no department matches
 * nothing under that scope; the `{{teamId}}` token is what the fail-closed rule in `scopeWhereFor` and the
 * ability layer recognise. There is no location scope (P6): a scope is Their own, Their team's or All.
 *
 * Fragments carry `{{userId}}` / `{{teamId}}` tokens, substituted per request.
 */

export type DataScope = 'attached' | 'team' | 'all' | typeof THROUGH_OWN_LEADS;

type Fragment = Record<string, unknown>;

/** How a record's person slot is matched for a scope: the person themself, or someone in their team. */
type SlotMatcher = (userColumn: string, userRelation: string) => Fragment;

const matcherFor = (scope: 'attached' | 'team'): SlotMatcher => (userColumn, userRelation) => {
  if (scope === 'attached') return { [userColumn]: '{{userId}}' };
  return { [userRelation]: { department_id: '{{teamId}}' } };
};

// ─── The single seams for the people a record's slots name ─────────────────────────────────────────
// PRD 3 changes where each Dispatcher comes from (a lead Dispatcher column). That change is made here
// and nowhere else; the resolver below never names the columns itself.

/**
 * A job's Sold By: the one stored on the job (its salesperson column), which is empty when nobody is
 * credited. The Owner of the lead the job came from is not part of it: conversion copies the Owner onto the
 * job, and a later change on the lead does not move the job's Sold By.
 */
const jobSoldBy = (match: SlotMatcher): Fragment[] => [match('salesperson_id', 'salesperson')];

/** A job's Dispatcher. */
const jobDispatcher = (match: SlotMatcher): Fragment[] => [match('dispatcher_id', 'dispatcher')];

/** A lead's Dispatcher. */
const leadDispatcher = (match: SlotMatcher): Fragment[] => [match('dispatcher_id', 'dispatcher')];

const jobCrew = (match: SlotMatcher): Fragment => ({
  visits: { some: { assignees: { some: match('user_id', 'user') } } },
});

const jobAttached = (match: SlotMatcher): Fragment => ({
  OR: [jobCrew(match), ...jobSoldBy(match), ...jobDispatcher(match)],
});

/**
 * The jobs that are a sale, or that the person reaches through a crew visit or as the Dispatcher: every way into a job
 * except a Sold By copied from a service plan. A plan visit job copies the plan's Sold By, but the plan's sale is counted
 * once, through the plan (`lib/jobSale`), so a figure of a person's own work ANDs this onto the Attached reach to leave
 * out a plan visit job whose only link to the person is that copied Sold By.
 */
export function jobWorkReach(scope: 'attached' | 'team'): Fragment {
  const match = matcherFor(scope);
  return { OR: [jobCountsAsSaleWhere, jobCrew(match), ...jobDispatcher(match)] };
}

/** A lead's Owner, its Dispatcher and the crew of its walkthrough visits: the people M6's first lane tells about a lead. */
const leadPeople = (match: SlotMatcher): Fragment[] => [
  match('commission_owner_id', 'commission_owner'),
  ...leadDispatcher(match),
  // A walkthrough is a visit on the lead; its crew is attached to the lead.
  { visits: { some: { assignees: { some: match('user_id', 'user') } } } },
];

const leadAttached = (match: SlotMatcher): Fragment => ({
  OR: [
    { lead_assignees: { some: match('user_id', 'user') } },
    ...leadPeople(match),
  ],
});

/** An estimate's lead or job: the job it produced, or the job it was attached to. */
const estimateAttached = (match: SlotMatcher): Fragment => ({
  OR: [
    { lead: leadAttached(match) },
    { job: jobAttached(match) },
    { job_link: jobAttached(match) },
  ],
});

const invoiceAttached = (match: SlotMatcher): Fragment => ({
  OR: [
    { job: jobAttached(match) },
    { AND: [{ job_id: null }, { estimate: estimateAttached(match) }] },
  ],
});

/**
 * The kept "Through own leads" value, as the PRD's three conditions state it (an assignee on a lead, as
 * Sales has today; no created-by path; a document made for a customer alone is its own arm, see `ownDocumentsReach`):
 *   Job:      jobs whose estimate's lead has the person as an assignee.
 *   Estimate: estimates whose lead has the person as an assignee.
 *   Invoice:  invoices whose job's estimate's lead has the person as an assignee.
 */
const assigneeOfLead = { lead_assignees: { some: { user_id: '{{userId}}' } } };
const THROUGH_OWN_LEADS_REACH: Partial<Record<ScopedSubject, Fragment>> = {
  Job: { estimate: { lead: assigneeOfLead } },
  Estimate: { lead: assigneeOfLead },
  Invoice: { job: { estimate: { lead: assigneeOfLead } } },
};

const ATTACHED_REACH: Record<ScopedSubject, (match: SlotMatcher) => Fragment> = {
  Lead: leadAttached,
  Job: jobAttached,
  Estimate: estimateAttached,
  Invoice: invoiceAttached,
};

/**
 * The reach of a Data Scope value over one kind of record:
 *  - `{ conditions }` the rows to keep (a Prisma `where` fragment with tokens);
 *  - `{}` for every row (scope All);
 *  - `null` for a value this resolver does not know, which reaches nothing (fail closed).
 */
export function scopeReach(subject: ScopedSubject, scope: unknown): { conditions?: Fragment } | null {
  if (scope === 'all') return {};
  if (scope === THROUGH_OWN_LEADS) {
    const conditions = THROUGH_OWN_LEADS_REACH[subject];
    // The kept value is not defined for Leads: it reaches nothing there (fail closed).
    return conditions ? { conditions } : null;
  }
  if (scope !== 'attached' && scope !== 'team') return null;
  return { conditions: ATTACHED_REACH[subject](matcherFor(scope)) };
}

/**
 * The estimates or invoices a person reaches from their Leads scope and Jobs scope (P6): a document has no scope of its own,
 * it is reached the way the lead or job it belongs to is, and only when the person can open that kind of record at all
 * (View leads, View jobs; spec story 50): a document is never reachable when its lead or job isn't. One `where` fragment
 * per arm, so a person with no department loses only the Team arm (fail closed) and keeps the rest.
 *
 *   Estimate: its lead, as the Leads scope reaches a lead (with View leads); or the job it produced or was attached to, as
 *             the Jobs scope reaches a job (with View jobs).
 *   Invoice:  its job, as the Jobs scope reaches a job (with View jobs); only an invoice with no job (a deposit invoice before
 *             the work is converted) is reached through its estimate, as above.
 *
 * Both scopes All reach the documents with no lead and no job (made for a customer alone): they hang off neither, so neither
 * View decides them. Both scopes All with both Views reach every document; nothing else does. The kept "Through own leads"
 * Jobs value keeps its own meaning (the lead's assignee): on an estimate it is a condition on the estimate's lead, so it
 * needs View leads; on an invoice it goes through the invoice's job, so it needs View jobs. Returns `null` when either scope
 * is a value this resolver does not know (reaches nothing), `[{}]` for every row.
 */
export function documentReach(
  subject: 'Estimate' | 'Invoice',
  leadsScope: unknown,
  jobsScope: unknown,
  view: { leads: unknown; jobs: unknown },
): { conditions?: Fragment }[] | null {
  const leadsOpen = view.leads === true;
  const jobsOpen = view.jobs === true;
  const bothAll = leadsScope === 'all' && jobsScope === 'all';
  if (bothAll && leadsOpen && jobsOpen) return [{}];
  const lead = scopeReach('Lead', leadsScope);
  const job = scopeReach('Job', jobsScope);
  if (!lead || !job) return null;
  const jobArm = (relation: 'job' | 'job_link'): Fragment[] => {
    if (!jobsOpen || jobsScope === THROUGH_OWN_LEADS) return [];
    return [{ [relation]: job.conditions ?? { isNot: null } }];
  };
  // An estimate reaches through its lead, and through the job it produced or was attached to; the kept Through own leads value
  // is its own condition on the estimate's lead.
  const estimateArms: Fragment[] = [
    ...(leadsOpen ? [{ lead: lead.conditions ?? { isNot: null } }] : []),
    ...(jobsScope === THROUGH_OWN_LEADS ? (leadsOpen ? [THROUGH_OWN_LEADS_REACH.Estimate!] : []) : [...jobArm('job'), ...jobArm('job_link')]),
  ];
  // The documents made for a customer alone, whoever made them: reached by both scopes All.
  const customerOnly: Fragment[] = bothAll ? [subject === 'Estimate' ? customerOnlyEstimate : customerOnlyInvoice] : [];
  if (subject === 'Estimate') return [...estimateArms, ...customerOnly].map((conditions) => ({ conditions }));
  const invoiceJobArm: Fragment[] = !jobsOpen
    ? []
    : jobsScope === THROUGH_OWN_LEADS
      ? [THROUGH_OWN_LEADS_REACH.Invoice!]
      : [{ job: job.conditions ?? { isNot: null } }];
  return [
    ...invoiceJobArm,
    ...(estimateArms.length ? [{ AND: [{ job_id: null }, { estimate: { OR: estimateArms } }] }] : []),
    ...customerOnly,
  ].map((conditions) => ({ conditions }));
}

/**
 * The customers a person reaches through the leads and jobs they can open (their Data Scope for each) or
 * are attached to, one `where` fragment per arm. Each arm is its own reach, so a person with no department
 * loses only the Team arm (fail closed) and keeps the rest. Returns `null` when
 * either scope is a value this resolver does not know (reaches nothing).
 *
 * This is also the reach of "the record the customer comes with": a customer on a lead or job the person can
 * open is part of that record, whatever Customers View says.
 */
export function customerThroughRecordsReach(leadsScope: unknown, jobsScope: unknown): Fragment[] | null {
  const leads = scopeReach('Lead', leadsScope);
  const jobs = scopeReach('Job', jobsScope);
  if (!leads || !jobs) return null;
  const attached = matcherFor('attached');
  // A union under `some` is one arm per branch ("has a lead that is a or b" is "has an a lead or has a b lead"),
  // which keeps every arm a single path for the people lookups that follow a reach one relation at a time.
  const branches = (f: Fragment): Fragment[] => (Array.isArray(f.OR) ? (f.OR as Fragment[]) : [f]);
  const through = (relation: 'leads' | 'jobs', reach: Fragment | undefined, attachedReach: Fragment | null): Fragment[] => [
    ...branches(reach ?? {}), // `{}` is "any": the scope reaches every one
    ...(attachedReach ? branches(attachedReach) : []),
  ].map((f) => ({ [relation]: { some: f } }));
  const arms = [
    ...through('leads', leads.conditions, leadsScope === 'all' ? null : leadAttached(attached)),
    ...through('jobs', jobs.conditions, jobsScope === 'all' ? null : jobAttached(attached)),
  ];
  // Equal arms (on Attached scope, the scope is the attached arm) are one.
  const seen = new Set<string>();
  return arms.filter((a) => !seen.has(JSON.stringify(a)) && seen.add(JSON.stringify(a)));
}

/**
 * The customers a person reaches (M3, "Modules with no scope switch"). A customer has no scope of its own:
 *  - every customer when Leads scope and Jobs scope are both All;
 *  - otherwise the customers of the leads and jobs the person can open or is attached to, plus the customers
 *    they created.
 *
 * Returns `[{}]` for every customer, the arms otherwise, or `null` when either scope is a value this
 * resolver does not know (reaches nothing).
 */
export function customerReach(leadsScope: unknown, jobsScope: unknown): { conditions?: Fragment }[] | null {
  if (leadsScope === 'all' && jobsScope === 'all') return [{}];
  const throughRecords = customerThroughRecordsReach(leadsScope, jobsScope);
  if (!throughRecords) return null;
  return [...throughRecords, { created_by_id: '{{userId}}' }].map((conditions) => ({ conditions }));
}

/**
 * The purchase orders a person reaches (M3, "Modules with no scope switch"): orders on jobs they can open,
 * which is to say View jobs on and the orders of the jobs their Jobs scope reaches. An order with no job needs
 * Jobs scope All, since only that scope reaches every order.
 *
 * Returns `[{}]` for every order, the one arm otherwise, `[]` when View jobs is off (no job can be opened) and
 * `null` when Jobs scope is a value this resolver does not know (reaches nothing).
 */
export function orderOnJobReach(viewJobs: unknown, jobsScope: unknown): { conditions?: Fragment }[] | null {
  if (viewJobs !== true) return [];
  const jobs = scopeReach('Job', jobsScope);
  if (!jobs) return null;
  return [jobs.conditions ? { conditions: { job: jobs.conditions } } : {}];
}

/**
 * The logistic orders a person reaches (M3): orders on jobs and leads they can open. An order on neither a job
 * nor a lead (for example on a customer or a service plan) needs Jobs scope All. Each arm is its own reach, so a
 * person with no department loses only the Team arm (fail closed) and keeps the other.
 *
 * Returns `[{}]` for every order (Jobs scope and Leads scope both All, with both viewable), the arms otherwise,
 * `[]` when neither a job nor a lead can be opened, and `null` when a scope is a value this resolver does not
 * know (reaches nothing).
 */
export function logisticOrderReach(
  view: { jobs: unknown; leads: unknown },
  scope: { jobs: unknown; leads: unknown },
): { conditions?: Fragment }[] | null {
  if (view.jobs === true && view.leads === true && scope.jobs === 'all' && scope.leads === 'all') return [{}];
  const arms: { conditions: Fragment }[] = [];
  if (view.jobs === true) {
    const jobs = scopeReach('Job', scope.jobs);
    if (!jobs) return null;
    arms.push({ conditions: jobs.conditions ? { job: jobs.conditions } : { job_id: { not: null } } });
    // Jobs scope All is the one scope that reaches an order on neither a job nor a lead.
    if (!jobs.conditions) arms.push({ conditions: { job_id: null, lead_id: null } });
  }
  if (view.leads === true) {
    const leads = scopeReach('Lead', scope.leads);
    if (!leads) return null;
    arms.push({ conditions: leads.conditions ? { lead: leads.conditions } : { lead_id: { not: null } } });
  }
  return arms;
}

/**
 * The jobs whose staging a person reaches through the job (M3, PRD 7): every job they are attached to, whatever
 * their switches, plus, with View stock, the jobs they can open (View jobs on and the jobs their Jobs scope
 * reaches). Each arm is a `where` fragment over a Job, `{}` meaning every job; an arm `null` scope drops out, so
 * a Jobs scope the resolver does not know reaches nothing beyond the attached jobs.
 */
export function stageJobReach(values: { view_stock?: unknown; view_jobs?: unknown; jobs_scope?: unknown }): { conditions?: Fragment }[] {
  const arms: { conditions?: Fragment }[] = [{ conditions: jobAttached(matcherFor('attached')) }];
  if (values.view_stock === true && values.view_jobs === true) {
    const jobs = scopeReach('Job', values.jobs_scope);
    if (jobs) arms.push(jobs);
  }
  return arms;
}

/**
 * The stages a person reaches (M3, PRD 7): the stages of the jobs in `stageJobReach`, and with View stock the
 * stages assigned to them. A stage with no job is reached only by an arm that reaches every job, which is View
 * stock with View jobs and Jobs scope All (the one scope that reaches a stage on no job).
 */
export function stageReach(values: { view_stock?: unknown; view_jobs?: unknown; jobs_scope?: unknown }): { conditions?: Fragment }[] {
  const arms: { conditions?: Fragment }[] = stageJobReach(values).map((arm) => (arm.conditions ? { conditions: { job: arm.conditions } } : {}));
  if (values.view_stock === true) arms.push({ conditions: { assigned_tech_id: '{{userId}}' } });
  return arms;
}

// ─── Documents made for a customer alone ────────────────────────────────────────────────────────────

/** An estimate for a customer alone: no lead, no job it produced and no job it is linked to. */
const customerOnlyEstimate: Fragment = { lead_id: null, job_id: null, job: null };

/** An invoice for a customer alone: no job, and no estimate that belongs to a lead or a job. */
const customerOnlyInvoice: Fragment = {
  AND: [{ job_id: null }, { OR: [{ estimate_id: null }, { estimate: customerOnlyEstimate }] }],
};

/**
 * The estimates and invoices the signed-in person made for a customer alone, as a `where` fragment carrying
 * `{{userId}}` (P7). Such a document has no lead or job to be attached to, so who made it is its only link: it is
 * part of Their own, and of every wider scope, which never reaches less than a narrower one. An estimate or invoice
 * the person made on a lead or job needs no arm of its own, because they are attached to it or they are not.
 */
const ownedByMaker = (subject: 'Estimate' | 'Invoice'): Fragment => ({
  [subject === 'Estimate' ? 'created_by' : 'created_by_id']: '{{userId}}',
  ...(subject === 'Estimate' ? customerOnlyEstimate : customerOnlyInvoice),
});

/**
 * The reach a scope adds for the documents the person made for a customer alone (P7): its own arm beside the scope's
 * reach, never inside it, so a scope that fails closed (Team, for a person with no department) drops only its own
 * arm and the person keeps their own documents. `null` for any other kind of record, and for a scope that already
 * reaches every row.
 */
export function ownDocumentsReach(subject: ScopedSubject, scope: unknown): { conditions: Fragment } | null {
  if (subject !== 'Estimate' && subject !== 'Invoice') return null;
  if (scope === 'all') return null;
  // A scope value the resolver does not know reaches nothing, this arm included (fail closed).
  if (scope !== 'attached' && scope !== 'team' && scope !== THROUGH_OWN_LEADS) return null;
  return { conditions: ownedByMaker(subject) };
}

/** The person themself, as a record's people: the matcher "attached" uses. */
const attachedPerson = matcherFor('attached');

/**
 * The record's people (PRD 10, S10.9; the people M6's first lane tells and its Dispatcher): the people a customer's reply
 * to an email about the record goes to. For a job its Sold By, its crew and its Dispatcher; for a lead its Owner, the crew of
 * its walkthroughs and its Dispatcher. These are the Attached people without a lead's assignees: an assignee is not told
 * about the lead's mail. A `where` fragment on a job or lead carrying `{{userId}}`.
 *
 * The Email page asks the same question from the person's side, in one statement (`recordPeopleThreads`,
 * lib/communication/recordPeopleThreads.ts), which restates this rule in SQL; permission-email-record-people-sql-db.test.ts
 * proves the two agree, so a change here is a change there.
 */
export function recordPeopleReach(subject: 'Job' | 'Lead'): Fragment {
  return subject === 'Job' ? jobAttached(attachedPerson) : { OR: leadPeople(attachedPerson) };
}

/**
 * Rows of this kind the person is attached to, as a `where` fragment carrying `{{userId}}`: the same answer for
 * every role, with nothing else attaching them (creating a record does not).
 */
export function attachedReach(subject: ScopedSubject): Fragment {
  return ATTACHED_REACH[subject](attachedPerson);
}

/**
 * Their own (P7) over one kind of record: the rows the person is attached to and, for an estimate or invoice, the
 * documents they made for a customer alone. `attachedReach` stays the people-only answer that jobs and leads use.
 */
export function ownReach(subject: ScopedSubject): Fragment {
  const attached = ATTACHED_REACH[subject](attachedPerson);
  return subject === 'Estimate' || subject === 'Invoice' ? { OR: [attached, ownedByMaker(subject)] } : attached;
}
