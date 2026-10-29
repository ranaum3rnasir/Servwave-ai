// Curated per-user capability toggles (RBAC Phase 2 → expanded in Phase B technician redesign).
// These are the ONLY (action, subject) pairs an admin may override per individual user.
//
// Per-user grants are FIXED own-scoped: the DB override row stays bare (action+subject+effect);
// the own-condition for each capability is looked up HERE at ability-build time (defineAbility.ts)
// and emitted as a CONDITIONAL `can`. There is NO scope column on the DB table.
//
// A WRITE toggle (`impliesRead: true`) also auto-enables the paired own-scoped `read <subject>`,
// because scopeWhereFor derives a subject's row-scope solely from its `read` grant — so a granted
// tech could not otherwise SEE the record they were just allowed to create/edit.
//
// The endpoint, the validation (isManagedCapability), and the GET view all read from this list.

// OWN_* condition templates — same shapes as defaultGrants.ts (re-declared so this module is
// self-contained). `{{userId}}` is substituted to the requester's id by substituteConditions.
const OWN_LEAD = { lead_assignees: { some: { user_id: '{{userId}}' } } } as const;
// Multi-visit S8 (D6): the visits path, kept byte-identical to defaultGrants.ts's OWN_JOB.
// These are never persisted (a UserPermissionOverride row is bare), so this file has no data
// component - but it builds live Prisma `where`s and breaks identically if left behind.
const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } as const;
// An Estimate row is owned via its parent Lead (its read-scope and its create/update both bind
// through the lead's assignees). Same shape powers the conditional write `can` and the paired read.
const OWN_ESTIMATE_VIA_LEAD = { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } as const;
const OWN_INVOICE_VIA_JOB = { job: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } } as const;
// Creation confers control (technician-ownership spec, Part B) - same shape as defaultGrants.ts's
// CREATED_BY_ME. A capability scoped this way reaches the rows the grantee MADE, which is a
// different set from the OWN_* shapes above (those are assignment/lead chains) and, for the money
// surface, deliberately so.
const CREATED_BY_ME = { created_by_id: '{{userId}}' } as const;
// Multi-visit S8 (D6): the READ a `create Job` grant has to imply. Same shape as
// defaultGrants.ts's OWN_OR_CREATED_JOB, and it exists for the same reason the role default does:
// with `job_assignees` dropped there is no self-assign row at create time any more, and a
// standalone (urgent) job has no visit either - so `visits.some.assignees.some` matches nothing
// and a granted creator would 403 on the job they just made. Before S8 the self-assign row
// carried this; now the created_by_id arm does. The arm is additive, so it widens nobody past
// their own rows.
const OWN_OR_CREATED_JOB = { OR: [OWN_JOB, CREATED_BY_ME] } as const;
// (A LogisticOrder anchored by job_id would be owned via that job — structurally identical to the
// invoice-via-job shape above, `LogisticOrder.job` being the `LogisticOrderJob` relation. No LO
// capability needs it in v1; see the LogisticOrder note at the bottom of USER_CAPABILITIES.)

export interface UserCapability {
  action: string;
  subject: string;
  label: string;
  description: string;
  // The OWN_* condition object applied (with {{userId}} substituted) to this capability's `can`.
  // OMITTED for an ORG-WIDE (non-row-scoped) capability — defineAbility then emits an
  // UNCONDITIONAL `can` (its existing no-conditions else branch).
  ownCondition?: Record<string, unknown>;
  // Write/advance actions auto-add the paired own-scoped `read <subject>` so the grantee can see
  // the records they may now act on. Read-only capabilities omit it.
  impliesRead?: boolean;
  // OPTIONAL role allow-list. When present, ONLY a user whose role is in this list may hold this
  // capability: the GET view omits it for other roles, the PUT endpoint 400s on it, and BOTH
  // ability builders (defineAbility.ts) and SQL scope builders (enforce.ts overrideReadGrants)
  // ignore an already-persisted allow row for an out-of-list role.
  //
  // WHY this exists: a capability with NO ownCondition emits an UNCONDITIONAL `can`, and for a
  // subject in ScopeResource that unconditional read makes scopeWhereFor return {} — i.e. EVERY
  // row in the org. That is fine for a role the org-wide surface was designed for, and a scope
  // blow-out for one it was not (a TECHNICIAN handed `approve LogisticOrder` would read every LO
  // in the org, contradicting the signed "no technician LO surface in v1" decision). Omit this
  // field for own-scoped capabilities — they cannot widen scope past the grantee's own rows.
  roles?: readonly string[];
}

export const USER_CAPABILITIES: UserCapability[] = [
  // ─── Lead ────────────────────────────────────────────────────────────
  {
    action: 'create',
    subject: 'Lead',
    label: 'Create leads',
    description: 'Create leads (auto-assigned to them, so they own what they create).',
    ownCondition: OWN_LEAD,
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'Lead',
    label: 'Edit own leads',
    description: 'Edit leads they own (assigned to them).',
    ownCondition: OWN_LEAD,
    impliesRead: true,
  },

  // ─── Estimate (owned via parent lead) ─────────────────────────────────
  {
    action: 'create',
    subject: 'Estimate',
    label: 'Create estimates',
    description: 'Create estimates on leads they own.',
    ownCondition: OWN_ESTIMATE_VIA_LEAD,
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'Estimate',
    label: 'Edit own estimates',
    description: 'Edit estimates on leads they own.',
    ownCondition: OWN_ESTIMATE_VIA_LEAD,
    impliesRead: true,
  },

  // ─── Job ──────────────────────────────────────────────────────────────
  // KEPT, though `create Job` became a TECHNICIAN role default in PR 3 of the technician-ownership
  // spec. It is redundant only for that one role: SALES holds no `create Job` at all, and the
  // toggle is the only way to hand it to an individual salesperson. Removing it would silently
  // strip that, and would also delete every existing allow row (the GET view stops rendering an
  // unmanaged pair and the PUT endpoint 400s on it). For a technician an allow row now simply
  // re-grants what the role already gives - no effect, no harm.
  {
    action: 'create',
    subject: 'Job',
    label: 'Create jobs',
    description: 'Create jobs from estimates on leads they own.',
    // OWN_OR_CREATED_JOB, not the bare OWN_JOB: the paired read this emits is the ONLY thing
    // standing between a granted salesperson and a 403 on the job they just created. See the
    // const's comment - S8 removed the self-assign crew row that used to answer for it.
    ownCondition: OWN_OR_CREATED_JOB,
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'Job',
    label: 'Edit own jobs',
    description: 'Edit jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },
  // Split out of `update Job` above (technician-ownership spec, Part C) and, in PR 3, RE-POINTED at
  // the creator. PR 2 gave it OWN_JOB purely so the split itself changed nobody's access; this is
  // the meaning it was created for. It now agrees with the role default in defaultGrants.ts -
  // money follows CREATION, not assignment - so an admin granting this toggle is opening the
  // line-item, scope and job-pricing surface on the jobs that user MADE, not on every job they
  // happen to be crewed on.
  //
  // Consequence, and it is the intended behaviour change of PR 3 rather than a migration bug: a
  // user who held this toggle before the merge (copied off their `update Job` override by
  // 20260805130000) keeps it, but it now reaches a different, narrower row set.
  {
    action: 'manage_lines',
    subject: 'Job',
    label: 'Edit line items on jobs they created',
    description: 'Add, edit and remove line items, scopes of work and pricing on jobs they created themselves.',
    ownCondition: CREATED_BY_ME,
    impliesRead: true,
  },
  {
    action: 'en_route',
    subject: 'Job',
    label: 'Mark own jobs on the way',
    description: 'Set on-the-way status on jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },
  {
    action: 'arrive',
    subject: 'Job',
    label: 'Mark own jobs on-site',
    description: 'Set on-site status on jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },
  {
    action: 'start',
    subject: 'Job',
    label: 'Start own jobs',
    description: 'Start jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },
  {
    action: 'complete',
    subject: 'Job',
    label: 'Complete own jobs',
    description: 'Complete jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },
  {
    action: 'reschedule',
    subject: 'Job',
    label: 'Reschedule own jobs',
    description: 'Change the date and time of jobs they are assigned to.',
    ownCondition: OWN_JOB,
    impliesRead: true,
  },

  // ─── Invoice (owned via parent job) ───────────────────────────────────
  {
    action: 'create',
    subject: 'Invoice',
    label: 'Create invoices',
    description: 'Create invoices on jobs they are assigned to (shows the "New Invoice" quick action).',
    ownCondition: OWN_INVOICE_VIA_JOB,
    impliesRead: true,
  },
  {
    action: 'send',
    subject: 'Invoice',
    label: 'Send invoices',
    description: 'Email invoices to customers for jobs they are assigned to. Pair with "Create invoices" — the lifecycle bar creates and sends in one step, and a user with create but not send is stranded on a draft they cannot deliver.',
    ownCondition: OWN_INVOICE_VIA_JOB,
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'Invoice',
    label: 'Edit own invoices',
    description: 'Edit invoices on jobs they are assigned to.',
    ownCondition: OWN_INVOICE_VIA_JOB,
    impliesRead: true,
  },
  {
    action: 'record_payment',
    subject: 'Invoice',
    label: 'Record payments',
    description: 'Record on-site payments on invoices for jobs they are assigned to.',
    ownCondition: OWN_INVOICE_VIA_JOB,
    impliesRead: true,
  },

  // ─── Price Book (org-wide reference data — no own-scope) ─────────────
  // The shared catalog has no per-row owner, so these grants are org-wide: no ownCondition,
  // emitted as an UNCONDITIONAL can. impliesRead lets a grantee of any role (incl. TECHNICIAN,
  // which lacks role-level read PriceBook) browse/search the catalog they may now write to.
  {
    action: 'create',
    subject: 'PriceBook',
    label: 'Add to the shared Price Book',
    description: 'Save new items and categories into the shared Price Book.',
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'PriceBook',
    label: 'Edit the shared Price Book',
    description: 'Edit items and categories in the shared Price Book.',
    impliesRead: true,
  },
  {
    action: 'delete',
    subject: 'PriceBook',
    label: 'Delete from the shared Price Book',
    description: 'Delete items and categories from the shared Price Book.',
    impliesRead: true,
  },

  // ─── Inventory (P3 D10/D13 — a restriction toggle, not an access grant) ──
  // Allow = restriction ON (Deny ≡ Inherit — no role ever grants this, so there is nothing to
  // revoke). Enforcement is server-side at every forward-deduction seam (resolveRestrictedVan,
  // inv-stock.controller.ts) and role-gated to TECHNICIAN there.
  {
    action: 'location_restricted',
    subject: 'Inventory',
    label: 'Restrict inventory to their van',
    description:
      "When on, this technician's stock deductions are locked to their assigned van — any other location is refused.",
    // No ownCondition (org-wide flag → unconditional `can`, defineAbility.ts's no-conditions branch).
    // NO impliesRead — it must NOT grant `read Inventory` (defineAbility + enforce.ts
    // overrideReadGrants both key off impliesRead; omitting it means zero scope widening).
  },

  // ─── Logistic Orders (LO-1) ───────────────────────────────────────────
  // `approve` is capability-ONLY: no role holds it in DEFAULT_GRANTS and the Roles editor cannot
  // create it (see the gate note in catalog.ts), so every user renders roleDefault:'not-in-role'.
  // ADMIN approves via the `manage all` short-circuit (defineAbility.ts:59-62) — no ADMIN row.
  {
    action: 'approve',
    subject: 'LogisticOrder',
    label: 'Approve logistic orders',
    description:
      'Approve submitted logistic orders, releasing them to be processed against stock.',
    // No ownCondition — approval is an ORG-WIDE authority (an approver reviews other people's
    // requests, so an own-row scope would defeat the purpose). defineAbility emits an
    // unconditional `can` via its no-conditions branch.
    // impliesRead so an approver can actually see the pending queue they are meant to act on —
    // it also feeds the synthesized SQL-side read in enforce.ts's overrideReadGrants, keeping
    // list scope and CASL ability in agreement.
    impliesRead: true,
    // ROLE-GATED (see `roles` on the interface above). #2042 security fix round 1 (F2) — the
    // implied read no longer always widens to {} (every LO in the org). It inherits whichever
    // role holds the override's OWN `read LogisticOrder` condition (enforce.ts's
    // overrideReadGrants / defineAbility.ts's per-user-override loop): DISPATCHER's read is
    // unconditional (owns fulfilment), so its implied read stays org-wide; SALES's read is
    // job-scoped (#2042, OWN_VIA_JOB), so a SALES approver's implied read stays job-scoped too —
    // approving does not hand them visibility into every rep's logistic orders. TECHNICIAN
    // remains excluded by signed decision (spec §12 rec 5; see the LO note in defaultGrants.ts)
    // and has NO LogisticOrder surface in v1. Do NOT add TECHNICIAN here when the tech app lands
    // — give the tech app an own-job-scoped capability instead.
    roles: ['SALES', 'DISPATCHER'],
  },
  // NOTE — a `process LogisticOrder` per-user capability was considered for LO-1 and deliberately
  // NOT shipped. It would have been dormant (LO-3 mounts the processing route; nothing reads a
  // capability today), it duplicates DISPATCHER's unconditional `process` role default, and for a
  // TECHNICIAN it would silently confer stock-deducting power the moment LO-3 mounts its route —
  // authority granted through a toggle whose surface did not exist when it was flipped. Add it in
  // LO-3, alongside the route it gates, where its blast radius can actually be reviewed.

  // ─── Calendar Entries (Slice 01, spec §4) ─────────────────────────────
  // Org-wide, exactly like PriceBook above: CalendarEntry has no ownership chain (ADR 0002 - no
  // per-row owner, visibility is org-wide by design), so these carry NO ownCondition. Per
  // defineAbility.ts's per-user-override loop, an omitted ownCondition emits an UNCONDITIONAL
  // `can` (not an own-scoped one) - confirmed by driving defineAbilityFor directly rather than
  // assumed, per the slice's own instruction. This is what lets a SALES user granted one of
  // these actually reach §4's "a SALES user who needs it gets it through UserPermissionOverride"
  // — an own-scoped grant would be meaningless for a subject with no owner column to scope on.
  // `delete` is deliberately NOT a per-user capability - the slice names only create+update as
  // individually grantable; a SALES user who needs to remove an event goes through DISPATCHER/ADMIN.
  {
    action: 'create',
    subject: 'CalendarEntry',
    label: 'Create events',
    description: 'Create calendar events (org-wide - an event has no owner to scope this to).',
    impliesRead: true,
  },
  {
    action: 'update',
    subject: 'CalendarEntry',
    label: 'Edit events',
    description: 'Edit calendar events (org-wide - an event has no owner to scope this to).',
    impliesRead: true,
  },

  // ─── Naming other people on work (scoped assignee pool, slice 1) ──────────────────────────
  // The individual escape hatch for the role default: one salesperson who books work for a crew
  // gets this, without handing `assign User` to every SALES user in the org.
  //
  // NO ownCondition - deliberately, and safely. An omitted ownCondition emits an UNCONDITIONAL
  // `can` (defineAbility.ts), which for a subject in ScopeResource would make scopeWhereFor
  // return {} and blow the grantee's row scope open. `User` is not in that union
  // (scopeWhereFor.ts: Lead | Job | Estimate | Invoice | LogisticOrder), and this is not a read
  // in the first place - so there is no scope to widen. It also needs no `roles` allow-list for
  // the same reason: WHICH work the holder may re-crew is still answered by that work's own
  // grant, which carries its own row scope. This only ever answers "whose names".
  //
  // No impliesRead: the paired read this would want is `read User`, and that is the org
  // directory - a different decision, already made per role, and not one to make as a side
  // effect. Without it the holder simply sees the same people-pool they saw before.
  {
    action: 'assign',
    subject: 'User',
    label: 'Assign work to other people',
    description:
      'Put someone other than themselves on a job crew or a walkthrough performer list (org-wide - which work they may re-crew is still bounded by their own job and lead grants).',
  },
];

const CAPABILITY_KEYS = new Set(USER_CAPABILITIES.map((c) => `${c.action}:${c.subject}`));
const CAPABILITY_BY_KEY = new Map(USER_CAPABILITIES.map((c) => [`${c.action}:${c.subject}`, c]));

export function isManagedCapability(action: string, subject: string): boolean {
  return CAPABILITY_KEYS.has(`${action}:${subject}`);
}

// Look up the managed capability descriptor (own-condition + impliesRead) for an (action, subject).
// Returns undefined if the pair is not a managed capability.
export function getManagedCapability(action: string, subject: string): UserCapability | undefined {
  return CAPABILITY_BY_KEY.get(`${action}:${subject}`);
}

// May a user of `role` hold this capability? A capability with no `roles` allow-list is open to
// every non-ADMIN role (the pre-existing behaviour — ADMIN never carries overrides at all).
// Enforced in FOUR places so the property holds no matter which layer is entered:
//   user.controller.ts getPermissions — omit it from the rendered toggle list
//   user.controller.ts putPermissions — 400 on an attempt to persist it
//   defineAbility.ts                  — ignore an already-persisted allow row (CASL side)
//   enforce.ts overrideReadGrants     — ignore it when synthesizing SQL read scope
export function capabilityAllowsRole(cap: UserCapability, role: string): boolean {
  return !cap.roles || cap.roles.includes(role);
}

// Convenience for the endpoints: is (action, subject) a managed capability this role may hold?
export function isManagedCapabilityForRole(action: string, subject: string, role: string): boolean {
  const cap = CAPABILITY_BY_KEY.get(`${action}:${subject}`);
  return !!cap && capabilityAllowsRole(cap, role);
}
