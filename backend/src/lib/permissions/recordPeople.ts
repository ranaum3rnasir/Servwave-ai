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
 * The creator rule (estimates and invoices, every role) is the one thing that reaches a record by who made
 * it: see `creatorReach`. It never reaches a record the creator is not attached to, except one for a
 * customer alone.
 *
 * Team and Location mean someone attached to the record is in the person's department / at the
 * person's location. A person with no department or location matches nothing under that scope; the
 * `{{teamId}}` / `{{locationId}}` tokens are what the fail-closed rule in `scopeWhereFor` and the
 * ability layer recognise.
 *
 * Fragments carry `{{userId}}` / `{{teamId}}` / `{{locationId}}` tokens, substituted per request.
 */

export type DataScope = 'attached' | 'team' | 'location' | 'all' | typeof THROUGH_OWN_LEADS;

type Fragment = Record<string, unknown>;

/** How a record's person slot is matched for a scope: the person themself, or someone in their team / location. */
type SlotMatcher = (userColumn: string, userRelation: string) => Fragment;

const matcherFor = (scope: 'attached' | 'team' | 'location'): SlotMatcher => (userColumn, userRelation) => {
  if (scope === 'attached') return { [userColumn]: '{{userId}}' };
  return { [userRelation]: scope === 'team' ? { department_id: '{{teamId}}' } : { location_id: '{{locationId}}' } };
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
export function jobWorkReach(scope: 'attached' | 'team' | 'location'): Fragment {
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
 * Sales has today; no created-by path, which the creator rule covers instead):
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
  if (scope !== 'attached' && scope !== 'team' && scope !== 'location') return null;
  return { conditions: ATTACHED_REACH[subject](matcherFor(scope)) };
}

/**
 * The customers a person reaches through the leads and jobs they can open (their Data Scope for each) or
 * are attached to, one `where` fragment per arm. Each arm is its own reach, so a person with no department
 * or location loses only the Team or Location arm (fail closed) and keeps the rest. Returns `null` when
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
 * person with no department or location loses only the Team or Location arm (fail closed) and keeps the other.
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

// ─── The creator rule ───────────────────────────────────────────────────────────────────────────────

/** The column that names who made a record. */
export const CREATED_BY_COLUMN: Record<ScopedSubject, string> = {
  Lead: 'created_by_id', Job: 'created_by_id', Estimate: 'created_by', Invoice: 'created_by_id',
};

/** The person themself, as a record's people: the matcher "attached" uses. */
const attachedPerson = matcherFor('attached');

/** An estimate for a customer alone: no lead, no job it produced and no job it is linked to. */
const customerOnlyEstimate: Fragment = { lead_id: null, job_id: null, job: null };

/** An invoice for a customer alone: no job, and no estimate that belongs to a lead or a job. */
const customerOnlyInvoice: Fragment = {
  AND: [{ job_id: null }, { OR: [{ estimate_id: null }, { estimate: customerOnlyEstimate }] }],
};

/**
 * The records the creator rule reaches for the signed-in person, as a `where` fragment carrying `{{userId}}`:
 * an estimate or invoice they made, while they are attached to its lead or job, or for good while it is for a
 * customer alone (once it is linked to a job or lead, attachment applies from then on). It opens the record
 * whatever the module's View says, so a list is the union of this and the View scope's rows.
 */
export function creatorReach(subject: 'Estimate' | 'Invoice'): Fragment {
  return {
    [CREATED_BY_COLUMN[subject]]: '{{userId}}',
    OR: [
      subject === 'Estimate' ? customerOnlyEstimate : customerOnlyInvoice,
      ...(ATTACHED_REACH[subject](attachedPerson).OR as Fragment[]),
    ],
  };
}

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

/** Rows of this kind the person is attached to, and made: the fragment behind "is creator and still attached". */
export function createdAndAttachedReach(subject: ScopedSubject): Fragment {
  return { [CREATED_BY_COLUMN[subject]]: '{{userId}}', ...ATTACHED_REACH[subject](attachedPerson) };
}
