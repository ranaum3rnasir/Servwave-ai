import { createMongoAbility, MongoAbility, RawRuleOf } from '@casl/ability';

export type AppSubject =
  | 'Dashboard' | 'Customer' | 'Lead' | 'Estimate' | 'Job' | 'Task'
  | 'Invoice' | 'User' | 'Department' | 'PriceBook' | 'Tag'
  | 'Report' | 'Organization' | 'StateTaxRate' | 'AppSetting'
  // Roles & Permissions S01.14 - the pages opened by their own "Access" switch (Access Schedule, Access Billing), kept in
  // lockstep with the backend permissions catalog.
  | 'Schedule' | 'Billing'
  // Roles & Permissions S01.16 - company-wide money (the "See company figures" switch), kept in lockstep with the backend
  // permissions catalog.
  | 'CompanyFigures'
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
  // Roles & Permissions S01.17 - creating a payable link for an invoice (the "Send payment links" switch), kept in
  // lockstep with the backend permissions catalog.
  | 'send_payment_link'
  // Roles & Permissions S01.18 - making an estimate with no lead or job, or an invoice with no job (the "Standalone
  // estimates" and "Standalone invoices" switches), kept in lockstep with the backend permissions catalog.
  | 'create_standalone'
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
  // Roles & Permissions S01.5 - backdating a customer's created date (the "Change customer created date"
  // switch), kept in lockstep with the backend permissions catalog.
  | 'change_created_date'
  // Roles & Permissions S01.7 - setting a lead's status from its status menu (the "Change lead status by hand"
  // switch), kept in lockstep with the backend permissions catalog.
  | 'change_status'
  // Roles & Permissions S01.8 - stepping a visit or job's status (on my way, arrived, start, finish) on one the
  // person is not crew on (the "Update any visit's status" switch), kept in lockstep with the backend catalog.
  | 'update_any_visit_status'
  // Roles & Permissions S04.22 - changing anything about a locked job (Completed or later, or Cancelled) (the "Change
  // locked jobs" switch), kept in lockstep with the backend catalog.
  | 'change_locked'
  // Roles & Permissions S01.10 - attaching or re-pointing a call, text or email to a job or lead (the "Attach
  // conversations to jobs and leads" switch) and editing someone else's hand-logged entry (the "Edit other people's
  // logged communications" switch), kept in lockstep with the backend permissions catalog.
  | 'attach' | 'edit_others_log'
  // Roles & Permissions S01.11 - seeing every task in the company (the "See all tasks" switch) and adding a note to a
  // job or lead (the "Add notes" switch), kept in lockstep with the backend permissions catalog.
  | 'see_all' | 'add_note'
  // Roles & Permissions S04.25 - deleting a note someone else wrote on a job or lead (the "Delete other people's notes"
  // switch), kept in lockstep with the backend permissions catalog.
  | 'delete_others_note'
  // Roles & Permissions S05.7 - adding or changing a job-only or lead-only phone or email with the pencil (the "Edit job
  // and lead contact details" switch), kept in lockstep with the backend permissions catalog.
  | 'edit_contact_details'
  // Roles & Permissions S01.12 - sending or resending an invitation (the "Invite users" switch) and setting which role a
  // user is on (the "Manage roles and permissions" switch, on the Role subject), kept in lockstep with the backend
  // permissions catalog.
  | 'invite' | 'manage_roles'
  // Roles & Permissions S07.1 - seeing every asset, not only the ones the person holds (the "See all assets"
  // switch), kept in lockstep with the backend permissions catalog.
  | 'see_all_assets'
  // Roles & Permissions S07.12 - reading the stock movement history: the Activity tab, its count and an item's movement
  // history (the "See inventory activity" switch), kept in lockstep with the backend permissions catalog.
  | 'see_inventory_activity'
  // Roles & Permissions S07.6 - marking a stage as taken by the person (the "Pick up staged items" switch), kept in
  // lockstep with the backend permissions catalog.
  | 'pick_up_staged'
  // Roles & Permissions S07.7 - recording that someone else took a stage's parts (the "Record pickup for someone else"
  // switch), kept in lockstep with the backend permissions catalog.
  | 'record_pickup_for_other'
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
  | 'access_inbox'
  // Roles & Permissions S01.14 - opening a page that is not one record type (the "Access Schedule" and "Access Billing"
  // switches, on the Schedule and Billing subjects), kept in lockstep with the backend permissions catalog.
  | 'access'
  // Roles & Permissions S08.18 - the office phone in the browser (the "Office phone in the browser" switch): the server
  // refuses a phone token without it, and the browser phone is offered only with it. Kept in lockstep with the backend
  // permissions catalog.
  | 'use_browser_phone'
  // Roles & Permissions S08.11 - the call player (the "Play recording" switch): the server refuses the playback link
  // without it, and the drawer shows the player only with it. Kept in lockstep with the backend permissions catalog.
  | 'play_recording'
  // Roles & Permissions S08.11 - the download control (the "Download recording" switch): the server refuses the
  // download link without it, and the drawer shows the control only with it. Kept in lockstep with the backend catalog.
  | 'download_recording'
  // Roles & Permissions S08.12 - the transcript and the call summary (the "View transcript" switch): the server refuses
  // the transcript route and leaves both out of every call response without it, and no screen shows either without it.
  // Kept in lockstep with the backend permissions catalog.
  | 'view_transcript'
  // Roles & Permissions S08.13 - call insights (the "See call insights" switch): the sentiment and the "needs review" flag
  // on a call, the Insights column, the Performance & QA sub-tab and the agents' scorecard metrics. The server leaves them
  // out without it, and no screen shows them either. Kept in lockstep with the backend permissions catalog.
  | 'see_call_insights'
  // Roles & Permissions S08.15 - the Phone page's tabs and usage bar, one action per switch (Phone numbers tab, Call flows tab,
  // Call masking tab, Call groups tab, Training tab, Blocked callers tab, Phone usage bar): the page draws a tab or the bar only
  // for the holder of its action. Kept in lockstep with the backend permissions catalog.
  | 'phone_numbers_tab'
  | 'call_flows_tab'
  | 'call_masking_tab'
  | 'call_groups_tab'
  | 'training_tab'
  | 'blocked_callers_tab'
  | 'phone_usage_bar'
  // Payments go-live slice 34 - the "Manage payout account" switch: shows the owner-only Payout account page.
  // Kept in lockstep with the backend permissions catalog.
  | 'manage_payout_account'
  | 'view_payments';

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
 * May this person start a purchase order (the Purchase Orders page's New PO, Generate PO, the job page's Create PO)?
 * Every one of those flows asks for a vendor and the only vendor list is behind View vendors, which PRD 7 keeps whole
 * (no contact-only or names-only vendor access). So Create purchase orders alone offers a control with nobody to pick;
 * the control needs both.
 */
export function canStartPurchaseOrder(ability: AppAbility): boolean {
  return ability.can('create', 'PurchaseOrder') && ability.can('read', 'Vendor');
}

/**
 * Company-wide money (Roles & Permissions S01.16, the "See company figures" switch): dashboard money tiles, chart
 * amounts, scoreboard revenue, report totals. The server leaves these out of a response for a person without it, so
 * this only decides whether a screen offers a place for them; it is never what keeps them hidden.
 */
export function canSeeCompanyFigures(ability: AppAbility): boolean {
  return ability.can('read', 'CompanyFigures');
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
