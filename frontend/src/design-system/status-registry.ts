import type { LucideIcon } from 'lucide-react';
import { CheckCircle2, CircleSlash, AlertCircle, OctagonPause, ArrowRight, Clock, PenLine, PauseCircle } from 'lucide-react';

/**
 * Single source of truth for "what does this domain state mean, visually."
 * Every status/state badge in the app resolves through here - see
 * md_files/specs/frontend/2026-07-26-ui-single-source-of-truth-goal.md.
 *
 * A status VALUE can mean different things in different domains (SENT is
 * neutral-in-flight for an Estimate but the same amber "needs payment" as
 * every other in-flight Invoice state) so each domain gets its own complete
 * map. Nothing here falls back to a shared cross-domain default - that
 * fallback is exactly the collision hazard this registry replaces.
 *
 * INCLUSION RULE (applied to all 61 Prisma enums; 47 are deliberately absent,
 * leaving 14 enums across 13 domains in scope). Those three counts are not
 * decorative and nothing asserts them, so they are stated with their source:
 * `grep -cE '^enum ' backend/prisma/schema.prisma` = 61, and EXCLUDED_ENUMS in
 * design-system/__tests__/status-registry-schema-guard.test.ts = 47, each with a
 * written reason. Re-run both before editing this sentence.
 * A domain belongs here iff ALL THREE hold:
 *   (a) its values are a lifecycle-state or graded-severity vocabulary for one entity,
 *   (b) at least one live UI surface maps it to appearance today,
 *   (c) real duplication exists (two or more places spell the same mapping).
 * Taxonomies (InvoiceKind, AssetEventType, WorkflowStepType,
 * NotificationCategory), label-only vocabularies (PaymentMethod), and enums with
 * zero UI (PlanVisitStatus, StockSyncStatus, WorkflowEnrollmentStatus,
 * CopilotMsgStatus) are NOT states and must not be added. Report re-bucketings
 * (estimates-report-logic, InvoicesReport, CommissionsReport) are deliberate
 * reporting taxonomies, not enum labels, and must not be converted.
 *
 * Five domains are SYNTHETIC - they have no Prisma enum behind them (deposit,
 * approval, purchaseOrder, stage, estimateReservation) and two are
 * DERIVED (workflow, invoice.OVERDUE). A guard written as a plain schema
 * bijection would therefore pass vacuously over exactly the worst-duplicated
 * domains. The guard in design-system/__tests__/status-registry-schema-guard.test.ts
 * uses a declared domain -> enum map plus an explicit synthetic allowlist instead;
 * the domain -> enum map, the synthetic allowlist and the schema parser live in
 * design-system/__tests__/schema-enum-sources.ts; EXCLUDED_ENUMS lives in
 * design-system/__tests__/status-registry-schema-guard.test.ts.
 */

export type StatusIntent = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';

export interface StatusEntry {
  label: string;
  intent: StatusIntent;
  icon?: LucideIcon;
}

/**
 * Token classes per intent - the ONLY place a status's color is spelled out.
 *
 * Four ROLES, one intent vocabulary. A status has exactly one intent; how that
 * intent is painted depends on the element:
 *   CLASSES - the tinted chip (surface + text + border). The default.
 *   FILL    - a solid swatch that carries no text of its own (dots, bars).
 *   TEXT    - bare label text on the page background, no chip.
 *   HOVER   - the hover wash for a chip that is itself a click target.
 *             PARTIAL by design; see STATUS_INTENT_HOVER.
 * Deliberately NOT provided: a left-accent/border role (wanted by the schedule
 * boards and the dashboard's TodaySchedule - all deferred to the composition
 * migration, so adding it now would ship dead code) and a chart-series colour
 * (a chart palette is a different system from a badge palette).
 */
export const STATUS_INTENT_CLASSES: Record<StatusIntent, string> = {
  success: 'bg-success-surface text-success-text border-success-border',
  warning: 'bg-warning-surface text-warning-text border-warning-border',
  danger: 'bg-danger-surface text-danger-text border-danger-border',
  info: 'bg-info-surface text-info-text border-info-border',
  neutral: 'bg-neutral-surface text-neutral-text border-neutral-border',
  brand: 'bg-primary-subtle text-primary border-primary/20',
};

/**
 * Solid fill per intent - dots, status bars, any swatch that carries no text.
 * `-strong` is the token role defined as "a solid fill that carries white"
 * (tokens.css), each verified >= 4.5:1 against white. `brand` has no
 * `--primary-strong`: the brand's solid fill IS `--primary`.
 */
export const STATUS_INTENT_FILL: Record<StatusIntent, string> = {
  success: 'bg-success-strong',
  warning: 'bg-warning-strong',
  danger: 'bg-danger-strong',
  info: 'bg-info-strong',
  neutral: 'bg-neutral-strong',
  brand: 'bg-primary',
};

/**
 * Bare label text per intent - no chip, no fill. The `-text` roles are tuned for
 * AA on a LIGHT surface; do not use these on the dark copilot surface (that is
 * what `--danger-on-dark` / `--warning-on-dark` exist for).
 */
export const STATUS_INTENT_TEXT: Record<StatusIntent, string> = {
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
  info: 'text-info-text',
  neutral: 'text-neutral-text',
  brand: 'text-primary',
};

/**
 * Hover wash per intent - for a chip that is itself a click target.
 *
 * WHY IT EXISTS. The task calendar's TaskChip carried its hover strings in a
 * local `Record<TaskStatus, string>`, i.e. a SECOND status -> appearance map,
 * which is the exact duplication this registry exists to delete. Keying the
 * wash off the resolved INTENT instead leaves the status -> intent decision in
 * one place. The four strings below are byte-identical to what that chip
 * already rendered at origin/staging, so this export changes no pixel.
 *
 * PARTIAL BY DESIGN, and typed that way rather than filled out. `danger` and
 * `brand` are ABSENT, not blank: no surface has ever hovered a danger or brand
 * status chip, so any value invented here would ship an undecided appearance as
 * if it had been ratified - the same reason the left-accent role above is
 * withheld. Consumers must carry their own fallback
 * (`STATUS_INTENT_HOVER[entry.intent] ?? ''`). Add an entry only together with
 * the surface that needs it, and record the decision the way this comment does.
 *
 * NOTE these are alpha washes over whatever the chip already paints, not the
 * ratified `-surface`/`-text`/`-strong` AA pairs the other three role maps use.
 * They are held at the incumbent values on purpose; do not read them as a
 * contrast-checked pairing, and do not "harmonise" them without a decision.
 */
export const STATUS_INTENT_HOVER: Partial<Record<StatusIntent, string>> = {
  neutral: 'hover:bg-neutral-strong/15',
  info: 'hover:bg-info/15',
  warning: 'hover:bg-warning/15',
  success: 'hover:bg-success/15',
};

// Prisma LeadStatus, 8/8, in pipeline order. Walkthrough Scheduled and Walkthrough Completed are
// real lead statuses: a lead moves onto them when a visit is booked / finished (see
// services/lead-stage.service.ts). Both are open, in-progress states, so both are `info`.
// status-registry-schema-guard.test.ts asserts this list stays a bijection with the live enum, so
// it will fail loudly the day schema.prisma drifts from this map again.
const LEAD_STATUS: Record<string, StatusEntry> = {
  NEW: { label: 'New', intent: 'warning' },
  CONTACTED: { label: 'Contacted', intent: 'warning' },
  WALKTHROUGH_SCHEDULED: { label: 'Walkthrough Scheduled', intent: 'info' },
  WALKTHROUGH_COMPLETED: { label: 'Walkthrough Completed', intent: 'info' },
  ESTIMATED: { label: 'Estimate Sent', intent: 'warning' },
  WON: { label: 'Won', intent: 'success' },
  LOST: { label: 'Lost', intent: 'danger' },
  CANCELLED: { label: 'Cancelled', intent: 'neutral' },
};

// Prisma EstimateStatus, 8/8.
// §E-3 (estimate workspace redesign) - SENT/PENDING read as info/neutral, not "needs
// attention" amber. D6 (2026-07-21): PENDING means the customer HAS approved and signed;
// only the deposit is outstanding, so the label carries the acceptance rather than reading
// as "still deciding" (amber, not the neutral used for SENT, because an unpaid deposit is a
// real staff action item, not just an in-flight state).
//
// OPEN QUESTION (E1) - do NOT copy this label until it is adjudicated. A second decision
// also labelled D6, dated 2026-07-20, lives in lib/filters/registries/estimates.ts and
// asserts the opposite (PENDING = sent, awaiting approval, pre-acceptance), calling this
// very string stale copy. The two cannot both be true. The label below is left EXACTLY as
// it was, em dash included, because rewording it silently would bury the conflict.
const ESTIMATE_STATUS: Record<string, StatusEntry> = {
  DRAFT: { label: 'Draft', intent: 'neutral' },
  SENT: { label: 'Sent', intent: 'info' },
  PENDING: { label: 'Approved — Deposit Pending', intent: 'warning' },
  WON: { label: 'Won', intent: 'success' },
  DECLINED: { label: 'Declined', intent: 'danger' },
  EXPIRED: { label: 'Expired', intent: 'warning' },
  ARCHIVED: { label: 'Archived', intent: 'neutral' },
  SUPERSEDED: { label: 'Superseded', intent: 'neutral' },
};

// Prisma JobStatus (5/5 after multi-visit S4's D17 narrowing) PLUS the two values that retired
// from it into VisitStatus. EN_ROUTE and ON_SITE stay here deliberately: this block is what the
// Visits cards render a visit's status through, and dropping them would leave a crew on site
// showing a raw enum name.
const JOB_STATUS: Record<string, StatusEntry> = {
  // display "Unscheduled" (ratified rename; the enum VALUE stays UNSCHEDULED)
  UNSCHEDULED: { label: 'Unscheduled', intent: 'warning' },
  SCHEDULED: { label: 'Scheduled', intent: 'warning' },
  EN_ROUTE: { label: 'On the way', intent: 'warning' },
  ON_SITE: { label: 'On Site', intent: 'warning' },
  IN_PROGRESS: { label: 'In Progress', intent: 'warning' },
  COMPLETED: { label: 'Completed', intent: 'success' },
  CANCELLED: { label: 'Cancelled', intent: 'neutral' },
};

// Prisma InvoiceStatus, 8/8, plus one client-derived value.
const INVOICE_STATUS: Record<string, StatusEntry> = {
  DRAFT: { label: 'Draft', intent: 'neutral' },
  SENT: { label: 'Sent', intent: 'warning' },
  PARTIAL: { label: 'Partial', intent: 'warning' },
  PAID: { label: 'Paid', intent: 'success' },
  VOIDED: { label: 'Voided', intent: 'neutral' },
  REFUNDED: { label: 'Refunded', intent: 'danger' },
  PARTIALLY_REFUNDED: { label: 'Partially Refunded', intent: 'warning' },
  DISPUTED: { label: 'Disputed', intent: 'danger' },
  // client-derived: overdue is computed from due_date + status, not a backend enum value
  OVERDUE: { label: 'Overdue', intent: 'danger' },
};

// SYNTHETIC - no Prisma enum, and as of this audit NO PRODUCER EITHER.
// The standalone Deposit model was dissolved into a kind=DEPOSIT Invoice (see
// backend/src/lib/query/registries/estimate.filters.ts, whose own comment records that
// deposit_status "is NOT a column at all" - it is an inbound query parameter mapped onto
// invoice statuses). Neither backend select that feeds the two `domain="deposit"` call
// sites carries a deposit relation: estimateListSelect (estimate.controller.ts) and the
// lead detail `estimates` select (lead.controller.ts) both omit it, so
// `row.original.deposit` and `est.deposit` are always undefined and both badges are
// unreachable. These 4 entries are therefore DEAD until a producer exists.
// Kept, not deleted: removing them means deleting the two call sites and the local
// `Deposit` interface in EstimatesPage, which is a behaviour change in files this
// work package does not own, and the deposit FILTER facet is genuinely live. Filed as a
// follow-up. Recorded here so nobody reads a green guard as proof this domain works.
const DEPOSIT_STATUS: Record<string, StatusEntry> = {
  REQUESTED: { label: 'Requested', intent: 'warning' },
  PAID: { label: 'Paid', intent: 'success' },
  VOIDED: { label: 'Voided', intent: 'neutral' },
  REFUNDED: { label: 'Refunded', intent: 'danger' },
};

// Prisma TaskStatus, 5/5.
//
// CANCELLED is `danger`, matching SERVICE_PLAN_STATUS' cancelled entry - the registry answers
// "what does this state mean", and both mean the same thing: the thing was called off. It is
// also what keeps a cancelled task from reading as a completed one wherever the two sit in the
// same list (the History tab), where `success` green and `danger` red are the furthest apart
// two chips in the palette can be.
const TASK_STATUS: Record<string, StatusEntry> = {
  TODO: { label: 'To Do', intent: 'neutral' },
  IN_PROGRESS: { label: 'In Progress', intent: 'info' },
  BLOCKED: { label: 'Blocked', intent: 'warning' },
  DONE: { label: 'Done', intent: 'success' },
  CANCELLED: { label: 'Cancelled', intent: 'danger' },
};

// Prisma TaskPriority, 4/4. Graded severity rather than a lifecycle, but it is exactly
// "meaning -> intent" and PriorityDot spelled these four out locally. Dot colours are
// byte-identical to the previous local map; only LOW's bare text moves (text-text-secondary
// #667985 -> text-neutral-text #5E707B, the AA fix the token layer already ratified).
const TASK_PRIORITY: Record<string, StatusEntry> = {
  LOW: { label: 'Low', intent: 'neutral' },
  MEDIUM: { label: 'Medium', intent: 'info' },
  HIGH: { label: 'High', intent: 'warning' },
  URGENT: { label: 'Urgent', intent: 'danger' },
};

// Prisma ServicePlanStatus, 4/4.
const SERVICE_PLAN_STATUS: Record<string, StatusEntry> = {
  DRAFT: { label: 'Draft', intent: 'neutral' },
  ACTIVE: { label: 'Active', intent: 'success' },
  EXPIRED: { label: 'Expired', intent: 'warning' },
  CANCELLED: { label: 'Cancelled', intent: 'danger' },
};

// SYNTHETIC (lowercase, no Prisma enum). Inventory stock-approval workflow
// (consume/return/writeoff/transfer requests). Distinct from timeclockReview below:
// same three words, different lifecycle and different entity.
const APPROVAL_STATUS: Record<string, StatusEntry> = {
  pending: { label: 'Pending', intent: 'warning' },
  approved: { label: 'Approved', intent: 'success' },
  rejected: { label: 'Rejected', intent: 'danger' },
};

// SYNTHETIC (lowercase, no Prisma enum). The most-duplicated domain in the app - three
// separate copies existed before consolidation, which is precisely why the guard cannot
// be a schema bijection: a bijection would skip this map entirely.
// Purchasing Audit Verdict PR 2: `sent` is retired (ServWave never sends a PO); `ordered`
// takes its brand slot and `cancelled` joins as the exit that is not a delete.
const PURCHASE_ORDER_STATUS: Record<string, StatusEntry> = {
  draft: { label: 'Draft', intent: 'neutral' },
  ordered: { label: 'Ordered', intent: 'brand' },
  partial: { label: 'Partial', intent: 'warning' },
  received: { label: 'Received', intent: 'success' },
  closed: { label: 'Closed', intent: 'neutral' },
  cancelled: { label: 'Cancelled', intent: 'danger' },
};

// Prisma LogisticOrderStatus, 6/6. Internal stock-movement between locations
// (job/invoice/estimate/lead/customer/service-plan anchored) - distinct from PurchaseOrder:
// no vendor, no cost, different enum casing.
const LOGISTIC_ORDER_STATUS: Record<string, StatusEntry> = {
  DRAFT: { label: 'Draft', intent: 'neutral' },
  PENDING_APPROVAL: { label: 'Pending approval', intent: 'warning' },
  APPROVED: { label: 'Approved', intent: 'info' },
  PROCESSED: { label: 'Processed', intent: 'success' },
  CANCELLED: { label: 'Cancelled', intent: 'danger' },
  RETURNED: { label: 'Returned', intent: 'brand' },
};

// SYNTHETIC (lowercase, no Prisma enum). Before consolidation there were FOUR chip
// surfaces plus TWO LABEL-ONLY sources, and the chips disagreed on ready_for_pickup
// and delivered:
//   StageDetailDialog.tsx:726  <StatusBadge domain="stage">  ready=brand  delivered=neutral
//   StagingView.tsx:678        <StatusBadge domain="stage">  ready=brand  delivered=neutral
//   StagePreviewDialog.tsx     local map                     ready=success delivered=brand
//   JobStagesSection.tsx       local map                     ready=info    delivered=success
//   StageDetailDialog.tsx:713-722  select options - LABELS ONLY, no appearance
//   StagingView.tsx:79-85          filterTabs     - LABELS ONLY, no appearance
// Three different colours for ready_for_pickup, three for delivered, so there is no
// "today's appearance" to preserve.
//
// WHY THE TWO HUE FLIPS ARE KEEP, not an invented repaint: the two values below were
// ALREADY the live appearance on 2 of the 4 chip surfaces at origin/staging, because
// those two surfaces already rendered through StatusBadge -> this registry. Migrating
// StagePreviewDialog and JobStagesSection moves the two MINORITY copies onto the
// incumbent MAJORITY; it does not introduce a third value. Per-surface before -> after
// is in md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md, section
// `## Appearance table`.
//
// `partial`'s label keeps its em dash pending E2, for the same reason as
// ESTIMATE_STATUS.PENDING: rewording user-facing copy silently is not this file's call
// to make. The StageDetailDialog select options above carry the same em dash in their
// own copy. StagingView's filterTabs use a terser vocabulary that diverges from these
// labels; that divergence is escalated, not reconciled here.
const STAGE_STATUS: Record<string, StatusEntry> = {
  awaiting: { label: 'Awaiting all parts', intent: 'neutral' },
  partial: { label: 'Partial — items pending', intent: 'warning' },
  complete: { label: 'All parts in', intent: 'success' },
  ready_for_pickup: { label: 'Ready for pickup', intent: 'brand' },
  delivered: { label: 'Delivered to tech', intent: 'neutral' },
};

// Prisma AssetStatus, 2/2.
const ASSET_STATUS: Record<string, StatusEntry> = {
  ACTIVE: { label: 'Active', intent: 'success' },
  RETIRED: { label: 'Retired', intent: 'neutral' },
};

// SYNTHETIC (lowercase, no Prisma enum). Pre-PO material reservations against an approved
// estimate.
const ESTIMATE_RESERVATION_STATUS: Record<string, StatusEntry> = {
  open: { label: 'Open', intent: 'info' },
  converted: { label: 'Converted', intent: 'success' },
  dismissed: { label: 'Dismissed', intent: 'neutral' },
};

// Workflow activity-feed outcomes. TWO backing Prisma enums, not one, because the feed is a
// union: workflow.controller.ts merges WorkflowStepRun rows (WorkflowStepRunStatus:
// SENT|SKIPPED|FAILED|STOPPED|CONTINUED) with legacy AutomationRun rows
// (AutomationRunStatus: PENDING|SENT|SKIPPED|FAILED) onto one `rows` array, and
// WorkflowActivity.tsx renders every row through this domain.
// PENDING IS NOT CLIENT-ONLY - it is AutomationRunStatus.PENDING off the wire. (The
// previous comment here claimed otherwise; it was wrong, and the guard was about to
// encode that mistake as a permanent fact.)
const WORKFLOW_STEP_STATUS: Record<string, StatusEntry> = {
  SENT: { label: 'Sent', intent: 'success', icon: CheckCircle2 },
  SKIPPED: { label: 'Skipped', intent: 'neutral', icon: CircleSlash },
  FAILED: { label: 'Failed', intent: 'danger', icon: AlertCircle },
  STOPPED: { label: 'Stopped', intent: 'warning', icon: OctagonPause },
  CONTINUED: { label: 'Continued', intent: 'neutral', icon: ArrowRight },
  PENDING: { label: 'Scheduled', intent: 'warning', icon: Clock },
};

// DERIVED, not a Prisma enum: backend WorkflowStatus DRAFT|PUBLISHED plus the is_enabled
// flag collapse into DRAFT|LIVE|PAUSED. The derivation itself stays at the call site
// (workflowDisplayStatus in workflow-visuals.tsx); only the rendering funnels here.
// PublishControl's LivePill splits LIVE again along a different axis (has-unpublished-
// changes) and is deliberately NOT modelled here - see
// md_files/plans/frontend/workflows/2026-07-27-wp-status-registry.md, section `## Deferred`.
const WORKFLOW_STATUS: Record<string, StatusEntry> = {
  DRAFT: { label: 'Draft', intent: 'neutral', icon: PenLine },
  LIVE: { label: 'Live', intent: 'success', icon: CheckCircle2 },
  PAUSED: { label: 'Paused', intent: 'neutral', icon: PauseCircle },
};

// Prisma EmailDeliveryStatus, 7/7 (email slice 5 - the delivery-state surface
// this domain was withheld pending; see EXCLUDED_ENUMS's former entry in
// status-registry-schema-guard.test.ts for the "not before" note this closes).
//
// OPENED IS DELIBERATELY ABSENT - not omitted by oversight. Apple Mail Privacy
// Protection prefetches tracking pixels for roughly half of all recipients,
// which makes "opened" meaningless as a signal of the recipient actually
// having read the message; the backing enum itself has no such value (the
// Resend webhook handler maps email.opened/email.clicked to nothing - see
// resend-webhook.controller.ts's mapEventToUpdate) so there is structurally
// nothing here to render as that claim. Do not add one.
//
// Tone contract: DELIVERED is the only success. BOUNCED/FAILED/COMPLAINED are
// all danger - a bounce or a spam complaint is never "fine", regardless of
// bounce_kind (HARD vs SOFT annotates BOUNCED via the separate EmailBounceKind
// enum - excluded from this registry, see EXCLUDED_ENUMS - it is not a second
// state to render). SENT and DEFERRED are in-flight, not yet a verdict either
// way, so neither reads as success or danger.
const MESSAGE_DELIVERY_STATUS: Record<string, StatusEntry> = {
  QUEUED: { label: 'Queued', intent: 'neutral' },
  SENT: { label: 'Sent — awaiting confirmation', intent: 'info' },
  DEFERRED: { label: 'Delivery delayed', intent: 'warning' },
  DELIVERED: { label: 'Delivered', intent: 'success' },
  BOUNCED: { label: 'Bounced', intent: 'danger' },
  FAILED: { label: 'Failed to send', intent: 'danger' },
  COMPLAINED: { label: 'Marked as spam', intent: 'danger' },
};

// Inbound sender verification (email slice 6) - what the receiving MTA's DMARC
// evaluation said about a reply's From header. A 4/4 mirror of Prisma
// InboundAuthVerdict.
//
// THE POINT OF THIS DOMAIN IS THAT THREE OF THE FOUR ARE NOT "VERIFIED". Only
// PASS means the From domain was cryptographically authenticated. NO_POLICY and
// UNAVAILABLE mean the address matched a stored string and nothing further was
// provable, and painting those as success is the exact dishonesty this plan
// exists to remove - a reader would take an unproven sender for a proven one.
// They are `neutral`, not `success`, and their labels name what is missing
// rather than implying a verdict was reached.
const INBOUND_SENDER_STATUS: Record<string, StatusEntry> = {
  PASS: { label: 'Verified sender', intent: 'success' },
  FAIL: { label: 'Failed verification', intent: 'danger' },
  NO_POLICY: { label: 'Unverified - no DMARC on sender domain', intent: 'neutral' },
  UNAVAILABLE: { label: 'Unverified - no sender check available', intent: 'neutral' },
};

// Timeclock review state. Lowercase to match the client vocabulary `ReviewState`
// (lib/timeclock/types.ts), which is a 4/4 mirror of Prisma PunchReview
// (NONE|PENDING|APPROVED|REJECTED) lowercased on the wire by timeclock.controller.ts.
// TWO surfaces render it, and only one of them is the OT-week review:
//   - punch override review (TimesheetsReport log table) - the real PunchReview column,
//     where all four values including `none` are reachable;
//   - weekly-OT review (EmployeePayrollCard) - reaches the same client vocabulary through
//     OtReviewState (APPROVED|REJECTED, a strict subset) plus a client `pending` default.
// Named for the shared vocabulary rather than for either surface. Do NOT source this from
// OtReviewState: that enum has only two values and would make `none`/`pending` look
// client-invented, which is how the duplicate maps drifted in the first place.
const TIMECLOCK_REVIEW_STATUS: Record<string, StatusEntry> = {
  none: { label: 'Pending', intent: 'warning' },
  pending: { label: 'Pending', intent: 'warning' },
  approved: { label: 'Approved', intent: 'success' },
  rejected: { label: 'Rejected', intent: 'danger' },
};

/**
 * WARNING - these maps are not appearance-only. Four of them feed an API contract.
 *
 * statusVocabulary() in components/copilot/tools/toolRegistry.ts builds the LLM's
 * advertised status filter vocabulary as
 * `Object.keys(STATUS_REGISTRY[domain]).filter(...).join('|')`
 * for `lead`, `job`, `estimate` and `invoice`. Both the key SET and the key ORDER
 * are load-bearing there: the set is what Servy will send to `GET /api/{resource}`,
 * and the order is what the tool description reads like to the model.
 *
 * The consequence, which is easy to miss: a CLIENT-DERIVED key added here for
 * rendering (the `invoice.OVERDUE` pattern - computed from due_date, not an
 * InvoiceStatus value) is silently advertised as a real filter value unless it is
 * also added to that call's `exclude` array, and the list endpoint validates the
 * facet against the Prisma enum, so the model gets a 400 on a value this file told
 * it existed. Conversely a key REMOVED here silently disappears from the model's
 * vocabulary. Rules for these four domains:
 *   - adding a real enum value: no action, the vocabulary widens correctly;
 *   - adding a client-derived key: add it to `exclude` in the same change;
 *   - reordering keys: keep the Prisma declaration order, that is the invariant
 *     toolRegistry's comment relies on.
 */
export const STATUS_REGISTRY = {
  lead: LEAD_STATUS,
  estimate: ESTIMATE_STATUS,
  job: JOB_STATUS,
  invoice: INVOICE_STATUS,
  deposit: DEPOSIT_STATUS,
  task: TASK_STATUS,
  taskPriority: TASK_PRIORITY,
  servicePlan: SERVICE_PLAN_STATUS,
  approval: APPROVAL_STATUS,
  purchaseOrder: PURCHASE_ORDER_STATUS,
  logisticOrder: LOGISTIC_ORDER_STATUS,
  stage: STAGE_STATUS,
  asset: ASSET_STATUS,
  estimateReservation: ESTIMATE_RESERVATION_STATUS,
  workflowStep: WORKFLOW_STEP_STATUS,
  workflow: WORKFLOW_STATUS,
  timeclockReview: TIMECLOCK_REVIEW_STATUS,
  messageDelivery: MESSAGE_DELIVERY_STATUS,
  inboundSender: INBOUND_SENDER_STATUS,
} as const;

export type StatusDomain = keyof typeof STATUS_REGISTRY;
