import { createMongoAbility, MongoAbility, RawRuleOf } from '@casl/ability';

export type AppSubject =
  | 'Dashboard' | 'Customer' | 'Lead' | 'Estimate' | 'Job' | 'Task'
  | 'Invoice' | 'User' | 'Department' | 'PriceBook' | 'Tag'
  | 'Report' | 'Organization' | 'StateTaxRate' | 'AppSetting'
  | 'Attachment' | 'Inventory' | 'Communication'
  // Inventory P0 purchasing subjects (kept in lockstep with backend permissions catalog)
  | 'PurchaseOrder' | 'Vendor'
  // Logistic Orders (LO-1) — kept in lockstep with backend permissions catalog
  | 'LogisticOrder'
  // Pricing (SRVW-140) - cost/price/margin visibility, written by the Roles UI "See financial
  // data" switch; kept in lockstep with backend permissions catalog. Deliberately distinct from
  // 'Invoice', which is about invoice RECORDS.
  | 'Pricing'
  | 'Location' | 'Role' | 'Timeclock' | 'AiCenter' | 'ServicePlan' | 'Automation'
  // Calendar Entries (Slice 01) - kept in lockstep with backend permissions catalog
  // (backend/src/lib/permissions/catalog.ts). No table/API/UI reads or writes one yet.
  | 'CalendarEntry'
  // Task categories (visits-and-task-categories slice 08) - kept in lockstep with the backend
  // catalog. Every role reads; create/update/delete are ADMIN-only (slice 09 gates on them).
  | 'TaskCategory' | 'all';

export type AppAction =
  | 'manage' | 'create' | 'read' | 'update' | 'delete'
  | 'send' | 'cancel' | 'duplicate' | 'revise'
  | 'manage_lines'
  | 'record_payment' | 'waive_deposit'
  | 'void' | 'refund' | 'credit' | 'void_payment'
  | 'assign' | 'unassign' | 'en_route' | 'arrive' | 'start' | 'complete' | 'reopen' | 'reschedule'
  | 'export' | 'mark_lost' | 'contact' | 'schedule_walkthrough' | 'perform_walkthrough'
  | 'perform' | 'be_assigned'
  // entity-redesign §10 lifecycle (kept in lockstep with backend permissions catalog)
  | 'archive' | 'force_purge' | 'anonymize'
  // Inventory P3 (D10/D13) — per-user restriction flag, not an access grant: a restricted
  // technician's stock deductions are server-forced to their own van.
  | 'location_restricted'
  // Logistic Orders (LO-1) lifecycle verbs — kept in lockstep with backend permissions catalog.
  // `approve` is a per-user capability only (never a role grant); `cancel` already exists above.
  | 'submit' | 'approve' | 'process'
  // R4 (2026-07-21) — Estimate lifecycle verbs (port-plan §10.3/§5), kept in lockstep with
  // backend permissions catalog. `approve` above is reused (real SALES+ADMIN grant on Estimate,
  // CASL keys off the (action,subject) pair). `void_approval` is D13's guarded unwind — ADMIN-only
  // by design, no role grant exists for it, so `ability.can('void_approval','Estimate')` is false
  // for every non-admin without a server round-trip.
  | 'decline' | 'void_approval'
  // Editable record IDs (2026-08-19 plan) - dedicated action gating the number-rename
  // endpoints (POST .../:id/number/preview, PATCH .../:id/number), kept in lockstep with
  // backend permissions catalog (backend/src/lib/permissions/catalog.ts).
  | 'renumber'
  // Manual Communication Log - "record a communication that already happened, by hand". A NEW
  // action on the existing Communication subject, kept in lockstep with the backend permissions
  // catalog. Deliberately NOT `create Communication`: that one is in the shared baseline and
  // gates click-to-call, texts, WhatsApp and email.
  | 'log_past'
  // #2046 - "open the org-wide Communication section" (sidebar group, /communication/* pages,
  // shell shortcuts). A NEW action on the existing Communication subject, kept in lockstep with
  // the backend permissions catalog (catalog.ts:54). Deliberately NOT `read Communication`: that
  // one is the shared baseline that also covers the per-record Communication tab on a lead/job/
  // customer, which must keep working for a role that lacks this action.
  | 'access_inbox';

export type AppAbility = MongoAbility<[AppAction, AppSubject]>;
export type AbilityRule = RawRuleOf<AppAbility>;

export function buildAbility(rules: AbilityRule[]): AppAbility {
  return createMongoAbility<AppAbility>(rules);
}

export const emptyAbility: AppAbility = createMongoAbility([]);

/**
 * Cost/price/margin visibility (SRVW-140), written by the Roles UI "See financial data" switch.
 * The single check every consumer should share - mirrors the backend's canSeePricing
 * (lib/permissions/enforce.ts), which exists for the same reason.
 */
export function canSeePricing(ability: AppAbility): boolean {
  return ability.can('read', 'Pricing');
}

/**
 * Does this ability permit `verb` on THIS job?
 *
 * DO NOT replace this with `ability.can(verb, subject('Job', job))`. That returns false for
 * every technician. The server builds abilities with @casl/prisma and ships the raw rules here,
 * where they are rebuilt with createMongoAbility — but the own-job condition is
 * `{ assignees: { some: { user_id } } }`, and `some` is a Prisma operator the Mongo/sift matcher
 * cannot evaluate. Conditional rules therefore never match an instance.
 *
 * Because ADMIN and DISPATCHER grants are UNCONDITIONAL, they match fine — so the naive version
 * passes an admin smoke test and ships silently broken for the one role it was written for.
 *
 * The split below mirrors what the backend hand-writes (job.controller.ts):
 * the type-level check answers "could you ever", the conjunct answers "on this one".
 */
export function canOnJob(
  ability: AppAbility,
  verb: AppAction,
  job: {
    // Multi-visit S8: crew lives on the VISIT. The job-level array is the visit-derived UNION
    // the API still serves under the same wire key, kept here so a caller that has only the job
    // payload (list rows before their visits arrive, the copilot's job tool) still answers
    // correctly. Either source satisfying the scope is the right rule: they describe one set.
    assignees?: { user: { id: string } }[] | null;
    visits?: { assignees?: { user_id: string }[] | null }[] | null;
    created_by_id?: string | null;
  },
  userId: string,
): boolean {
  // FIRST: the type-level check, which honours INVERTED (deny) rules. A per-user deny override
  // emits an unconditional `cannot(verb,'Job')` layered over the role's conditional `can`
  // (defineAbility.ts). Scanning rulesFor alone would see the allow rule and return true while
  // the API returns 403 — the exact button/API disagreement this helper exists to prevent.
  if (!ability.can(verb, 'Job')) return false;

  const rules = ability.rulesFor(verb, 'Job');
  if (!rules.length) return false;
  // An unconditional, non-inverted rule means org-wide authority (ADMIN via manage-all,
  // DISPATCHER via its flat grants).
  if (rules.some((r) => !r.inverted && !r.conditions)) return true;
  // Otherwise the verb is row-scoped, and there are now TWO shapes it can be scoped by
  // (technician-ownership spec, Part C): assignment and AUTHORSHIP. `update`/`complete` follow
  // assignment; `manage_lines`/`assign`/`unassign`/`delete` follow `created_by_id`; `read` follows
  // either. Answering all of them with "are you assigned" would hide the creator surface on a job
  // the technician made but was taken off, and OFFER it on every job they happen to be crewed on -
  // wrong in both directions, and the second is a button the API refuses.
  const facts = {
    assigned:
      (job.assignees?.some((a) => a.user.id === userId) ?? false) ||
      (job.visits?.some((v) => v.assignees?.some((a) => a.user_id === userId)) ?? false),
    // `!!created_by_id` first: a legacy row carries null, and null === undefined-userId would be a
    // false match on every pre-migration job.
    creator: !!job.created_by_id && job.created_by_id === userId,
  };
  return rules.some((r) => !r.inverted && r.conditions && satisfiesJobScope(r.conditions, facts));
}

/**
 * Does the row satisfy this grant's condition, given the two facts the client can actually check?
 *
 * Structural, not a general matcher: it reads the shapes `defaultGrants.ts` ships (`assignees.some`,
 * `created_by_id`, and OR/AND of those) and refuses anything else. Refusing is the safe direction -
 * an unrecognised condition hides a button rather than offering one the API will reject - and it
 * keeps this from quietly becoming a second, divergent authorization engine. @casl/ability cannot do
 * this itself: `some` is a Prisma operator its Mongo matcher does not implement (see canOnJob).
 */
function satisfiesJobScope(
  conditions: Record<string, unknown>,
  facts: { assigned: boolean; creator: boolean },
): boolean {
  const entries = Object.entries(conditions);
  if (!entries.length) return false;
  return entries.every(([key, value]) => {
    switch (key) {
      case 'assignees':
        return facts.assigned;
      // Multi-visit S8: the stored OWN_JOB condition is
      // `{ visits: { some: { assignees: { some: { user_id } } } } }`. Without this arm the
      // `default` below hides EVERY row-scoped technician control with no error, while an
      // admin-principal test stays green - see canOnJob's docstring.
      case 'visits':
        return facts.assigned;
      case 'created_by_id':
        return facts.creator;
      case 'OR':
        return (value as Record<string, unknown>[]).some((c) => satisfiesJobScope(c, facts));
      case 'AND':
        return (value as Record<string, unknown>[]).every((c) => satisfiesJobScope(c, facts));
      default:
        // Team/Location scopes and anything added later: not decidable here, so do not offer it.
        return false;
    }
  });
}
