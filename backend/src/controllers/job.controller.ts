import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, JobStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { JOB_SORT_FIELDS } from '../lib/sortFields';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { applyFilters } from '../lib/query/filterEngine';
import { jobFacets } from '../lib/query/registries/job.filters';
import { tenantWhere } from '../lib/tenant';
import { isBareOrgDay, orgDayRange, orgDayStart, addOrgDays } from '../lib/orgDayRange';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { computeJobBilling } from '../lib/jobBilling';
import { recomputeInvoiceTotals, countsTowardTotals } from '../lib/invoice-totals';
import { asScopeArray, toScopeForTotals } from '../lib/scopes';
import { findDuplicateCustomer, duplicateConflictBody } from '../lib/customer-duplicate';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany } from '../lib/customer-kind';
import { accreteContactMethods } from '../lib/customer-accretion';
import { resolveOrAccreteLocation, buildLocationTaxWarning, LocationResolutionError } from '../lib/service-location';
import { loadTagsByEntity, loadTagsForEntity, type TagSummary } from '../lib/tags';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { signAvatarPaths, resolveAvatarUrl } from '../lib/avatar';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
// job-owns-tax-discount (E1) - the job stamps its own tax_rate at create time, the same
// state-lookup estimate.controller.ts uses.
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
// Inventory P1 (§4.2/§4.3) — job cancel/delete auto-return SYNCED lines through the shared
// inv-stock return loop (applyStockMovement stays the only StockBalance write path).
import { returnSyncedLines } from './inv-stock.controller';
// Logistic Orders (spec §14 C1) — job cancel/delete unwind the LOs anchored to the job: resolve
// them pre-tx (pool discipline), then return/cancel them inside the existing transaction.
import { collectAnchoredLoUnwind, applyAnchoredLoUnwind } from '../lib/logisticOrders';
// SERV10X-38 Task 5 — createInvoiceFromJob() reuses these to draw down a paid estimate
// deposit as credit onto a job-owned-items invoice (see invoice.controller.create() ~L610-650).
import {
  DEPOSIT_CREDIT_REFERENCE,
  resolvePaidDepositInvoices,
  computeDepositCredit,
  applyDepositCreditsWithPayments,
  depositEstimateIds,
} from '../lib/deposit-credit';
// SRVW-84 (#1169) - credits-aware cash derivation for the job-financials aggregate below.
import { amountPaidOf, creditsTotalOf } from '../lib/invoice-editable';
import { jobLineToInvoiceLineCreate } from '../lib/invoice-lines-from-job';
import type { Action, Subject } from '../lib/permissions/catalog';
import { isAssignable, isDispatcherEligible } from '../lib/permissions/assignableRoles';
import { canAccessRow, canActOnRow, scopeWhereForReq, canSeePricing } from '../lib/permissions/enforce';
import { isCustomerReadableRow, CUSTOMER_PROOF_SELECT } from '../lib/permissions/customerScope';
import { redactCustomerRowUnless, redactServiceLocationRowUnless } from '../lib/permissions/customerContact';
// Scoped assignee pool (md_files/plans/permissions/2026-08-31-assignee-pool/): WHOSE names this
// requester may put on a job's crew. Shared with the walkthrough performer validator - the module
// deliberately exports no error string, so the twins keep their own wording.
// `assigneeSetChanged` comes from there too: the twins keep their own MESSAGES, but they must
// not disagree about what "unchanged" means.
import { resolveAssigneePoolForRequest, isAssigneeSetPermitted, assigneeSetChanged } from '../lib/permissions/assigneePool';
import { jobCrewIds, isOnJobCrew, projectJobCrewUnion } from '../lib/job-crew';
import { isLiveVisit } from '../lib/visit-status';
import { projectJobScheduleFields, resolveJobScheduleWindow, jobWindowMoved, sameScheduleMinute } from '../lib/job-schedule-projection';
import { validationFailure, zodValidationFailure } from '../middleware/validate';
import { sendJobScheduledEmail, sendJobRescheduledEmail, sendJobVisitCancelledEmail, type EmailDispatchResult, type OrganizationBrandingSubset } from '../lib/email';
import { getOrgTimezone, DEFAULT_TIMEZONE, getRequestOrgTimezone, formatShortDateInZone } from '../lib/timezone';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { decideScheduleDispatch, type ScheduleDispatchDecision } from '../lib/schedule-dispatch';
import { rearmAnchoredWaits } from '../services/automations/enrollment';
import { visitMergeFields, type VisitCrewMember } from '../services/automations/context';
import {
  visitLocationField, visitLocationSelect, formatVisitLocation, resolveVisitLocationWrite,
  projectJobVisitLocations, loadVisitLocation,
  type VisitLocationInput,
} from '../services/visitLocation';
import { performerPhoneSelect, getOrgMainLine, resolveServWavePhones } from '../services/performerPhone';
import { resolveScheduleJobNotifications } from '../services/notifications/resolveNotifications';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { logAudit } from '../lib/audit';
// Editable record IDs (plan decision #7) - the shared rename engine (record-renumber.ts). Read
// vs. write split: computeRenumber is safe outside a transaction (preview), applyRenumber must
// run inside the same locked transaction that holds the parent row lock (rename).
import { computeRenumber, applyRenumber, type RenumberComputation } from '../lib/record-renumber';
import { milestoneClears, clearsCompletion } from '../lib/job-milestones';
import { subStatusClears } from '../lib/job-sub-status';
import { deriveJobStatusFromVisits } from '../lib/job-status';
import { walkthroughSnapshotSelect, projectLeadWalkthroughFields, projectLeadVisitCrew, createJobVisit, syncJobFromVisits, stampVisitMilestone, stampCurrentJobVisitMilestone, cancelWalkthroughRow, LIVE_VISIT_STATUSES, type VisitMilestone, nextVisitSeqForJob, withVisitSeqRetry, rescheduleVisitRow, listJobVisits, syncJobWindowOntoVisits, applyJobCrewStatementToVisit, resolveCurrentJobVisit } from '../services/walkthrough.service';
import { replaceVisitCrew } from '../services/visitCrew';

// ─── Select Objects ────────────────────────────────────

async function revertPlanVisitOnUncomplete(
  req: Request,
  jobId: string,
  sourcePlanId: string | null | undefined,
) {
  if (!sourcePlanId) return;
  await prisma.planVisit.updateMany({
    where: { job_id: jobId, status: 'COMPLETED', ...tenantWhere(req) },
    data: { status: 'SCHEDULED', completed_at: null },
  });
}

const jobListSelect = {
  id: true,
  job_number: true,
  status: true,
  // Creation confers control (technician-ownership spec, Part C). The LIST needs it for the same
  // reason the detail payload does: the bulk Assign action is offered from here, and `assign Job` is
  // creator-scoped for a technician - without this the page can only ask the subject-level question,
  // which is true for every technician, and would offer a bulk action the API refuses per row.
  created_by_id: true,
  // SRVW-112 - the org-defined label rendered inside the list's existing Status cell.
  sub_status: { select: { id: true, label: true } },
  job_type: true,
  scope_notes: true,
  // Multi-visit S6: the board fans one job row out into one card per trip, so the trips have to
  // travel with the row - the per-job GET /api/jobs/:id/visits cannot serve a 500-job board.
  // No `orderBy`: the house rule (listJobVisits, syncJobFromVisits) is that ordering is applied
  // in CODE, because a delegated orderBy is invisible to the mocked-Prisma seam - and the board
  // sorts by time itself anyway. This also lands on exportAll(), which shares this select; that
  // is additive and the CSV builder reads named columns.
  // Multi-visit S8: NO `where` on the status. The visit set is now the SOURCE of the derived
  // `assignees` wire key, and a technician crewed only on a called-off trip must still appear -
  // the row scope admits them, so the payload must not hide them. The board is unaffected:
  // frontend/src/components/schedule/eventAdapters.ts already filters CANCELLED in code.
  // S8 (A5, RATIFIED): also the SOURCE of the derived `scheduled_start`/`scheduled_end`/
  // `is_all_day` wire keys - the stored mirror is gone, so `created_at` rides along for
  // projectJobScheduleFields' tie-break (see lib/job-schedule-projection.ts).
  visits: {
    select: {
      id: true,
      visit_seq: true,
      status: true,
      scheduled_at: true,
      scheduled_end: true,
      is_all_day: true,
      created_at: true,
      // S7 (user story 40): "what did we tell the customer, and when". This select names its
      // fields, so unlike the per-job visits route - findMany with `include` and no select, which
      // ships every column automatically - a new column never reaches the board unless it is
      // added HERE. That asymmetry is the trap this line exists to close.
      customer_email_sent_at: true,
      // Slice 6: where THIS trip is. The board reads its cards and opens its visit detail off this
      // response, and until now both read the customer's address off the job - which is the wrong
      // side of town for a trip booked at the yard. `...visitLocationSelect` is the six columns
      // plus the relation they point at; `projectJobVisitLocations` collapses the relation into one
      // resolved line on the way out, so no copy of a Settings row reaches the wire (D2).
      ...visitLocationSelect,
      assignees: {
        select: {
          user_id: true,
          // `phone` is the CREW CONTACT the schedule board's event editor offers call/text on.
          // It rides on the RECORD, deliberately: `GET /api/users/assignable` (the picker roster)
          // is gated on `assign User` and no longer carries contact fields, so a viewer who owns
          // the job but may not change its crew would otherwise lose the affordance entirely.
          // Who you may ADD is gated; who is ALREADY ON the record is not.
          user: { select: { id: true, first_name: true, last_name: true, phone: true } },
        },
      },
    },
  },
  created_at: true,
  // email joins phone here for SRVW-243: the schedule board's reschedule composer
  // shows the address it is about to mail, and it builds that from these list rows.
  customer: { select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true, phone: true, email: true } },
  service_location: { select: { id: true, address_line1: true, city: true, state: true } },
  estimate: { select: { lead: { select: { commission_owner: { select: { id: true, first_name: true, last_name: true } } } } } },
  // Money-not-status reschedule gate (Spec B1, B-2): the schedule board needs to know whether
  // a job has been invoiced yet, without fetching full invoice detail. One row is enough.
  invoices: {
    where: { sent_at: { not: null } },
    select: { sent_at: true },
    orderBy: { sent_at: 'asc' as const },
    take: 1,
  },
};

const jobDetailSelect = {
  id: true,
  job_number: true,
  status: true,
  // SRVW-112 - `parent` travels too: the detail page only offers sub-statuses of the current
  // parent, and the setter rejects a mismatch.
  sub_status: { select: { id: true, label: true, parent: true } },
  amount_invoiced: true,
  scope_notes: true,
  job_type: true,
  // R3b (2026-07-21) — cost model (D2/D8/D18). Staff-only — stripJobPricingForRequester deletes
  // these three for a requester who can't see pricing (canSeePricing gates read Invoice).
  labor_hours: true,
  overhead_mode: true,
  overhead_value: true,
  estimated_duration: true,
  completion_notes: true,
  // S8 (A5, RATIFIED): scheduled_start/scheduled_end/is_all_day are DROPPED as stored columns.
  // The wire keys are served on read - projectJobScheduleFields computes them off `visits[]`
  // below (see lib/job-schedule-projection.ts). en_route_at/on_site_at are dropped outright with
  // no replacement: every reader of those two names is on the VISIT, never the job.
  started_at: true,
  completed_at: true,
  cancelled_at: true,
  cancelled_reason: true,
  signature_data: true,
  signature_ip: true,
  signature_at: true,
  created_at: true,
  updated_at: true,
  // Creation confers control (technician-ownership spec, Part C), so this is not audit trivia on the
  // detail payload - it is the fact `canOnJob` needs to decide whether to OFFER the creator-only
  // actions (line items, assign/unassign, delete). Without it the client cannot evaluate a
  // creator-scoped grant and hides every one of them.
  created_by_id: true,
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
    },
  },
  dispatcher: {
    select: {
      id: true, first_name: true, last_name: true, email: true, phone: true, role: true, avatar_path: true,
      department: { select: { id: true, name: true } },
    },
  },
  // Job crew (multi-visit S8, D6). The job-assignee join table is GONE - crew lives on the visit,
  // and "the job's crew" is the derived UNION across every trip. The WIRE KEY `assignees` is
  // unchanged: projectJobCrewUnion below rebuilds it from these rows, which is what keeps every
  // client reader (TeamCard, the board's technician lanes, insights, the copilot tools) working
  // untouched. NO status filter - a called-off trip's crew still reaches the job, matching the
  // row scope, which has no status filter either. Narrowing here would offer a technician a job
  // the API then 403s, or the reverse.
  // S8 (A5, RATIFIED): also the source of `scheduled_start`/`scheduled_end`/`is_all_day` -
  // `created_at` rides along for projectJobScheduleFields' tie-break.
  visits: {
    select: {
      id: true,
      visit_seq: true,
      status: true,
      scheduled_at: true,
      scheduled_end: true,
      is_all_day: true,
      created_at: true,
      assignees: {
        select: {
          user_id: true,
          user: {
            select: {
              id: true, first_name: true, last_name: true, role: true, phone: true, email: true, avatar_path: true,
              department: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  },
  service_location: {
    select: {
      id: true,
      address_line1: true,
      address_line2: true,
      city: true,
      state: true,
      zip: true,
    },
  },
  estimate: {
    select: {
      id: true,
      estimate_number: true,
      total_amount: true,
      status: true,
      lead_id: true,
      lead: {
        select: {
          id: true,
          lead_number: true,
          status: true,
          // Walkthrough-as-entity redesign, PR-B2: the three walkthrough_* fields below are no
          // longer raw legacy columns - presentJobDetail's projectLeadWalkthroughFields call
          // sources them from this relation instead, resolving D15's "current visit".
          // S8 (D6): the crew rides on the trips - `visit_assignees.lead_id` is dropped.
          visits: { select: { ...walkthroughSnapshotSelect, assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } } } },
          commission_owner: { select: { id: true, first_name: true, last_name: true, email: true, avatar_path: true } },
        },
      },
      line_items: {
        select: {
          id: true,
          sequence: true,
          description: true,
          quantity: true,
          unit_price: true,
          is_taxable: true,
          line_total: true,
          item_type: true,
        },
        orderBy: { sequence: 'asc' as const },
      },
    },
  },
  invoices: {
    select: { id: true, invoice_number: true, status: true, total_amount: true, amount_due: true, created_at: true, sent_at: true, paid_at: true, kind: true },
    orderBy: { created_at: 'asc' as const },
  },
  // SRVW-96 - estimates attached to this job via the R6 EstimateJobLink (Estimate.job_id) that
  // are NOT this job's provenance estimate (`estimate` above). Surfaces both shapes the deposit
  // guard in estimate.controller.ts refuses: the job anchor and a multi-estimate conversion.
  linked_estimates: {
    select: { id: true, estimate_number: true, total_amount: true, status: true },
    orderBy: { created_at: 'asc' as const },
  },
  // Service-plan provenance: when set, this job is a (non-billable) plan visit. Drives the
  // "Plan Visit" badge + link-back on the job page; the plan owns the contract/billing.
  source_plan_id: true,
  source_plan: { select: { id: true, service_plan_number: true, name: true } },
  // SRVW-114 slice 1 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // straight off the job detail payload; without it a saved value never reappears after refresh.
  custom_fields: true,
  // Annotated with `satisfies` so excess-property checking fires on this literal: a stale
  // relation key (e.g. a dropped `deposit`) is a tsc error here, not a runtime 500. Without
  // the annotation, passing this const to `select` skips the check and the bug ships silently.
} satisfies Prisma.JobSelect;

// ─── Zod Schemas ───────────────────────────────────────

// Mirrors lead.controller.ts locationSchema (kept local to avoid touching the lead controller).
const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
});

// Mirrors lead.controller.ts newCustomerSchema.
const newCustomerSchema = z.object({
  first_name: z.string().max(100).optional(),
  // Last name + company are optional; the customer needs a first name OR a company
  // name (unified-client-creation §2), and at least one of phone/email (SERV10X-35).
  last_name: z.string().max(100).optional(),
  company_name: z.string().max(200).optional(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  ad_source: z.string().max(100).optional().nullable(),
  location: locationSchema,
}).refine(hasNameOrCompany, {
  message: 'Provide a first name or a company name',
  path: ['first_name'],
}).refine(hasPhoneOrEmail, {
  message: CONTACT_REQUIRED_MSG,
  path: ['phone'],
});

export const createJobSchema = z.object({
  estimate_id: z.string().uuid().optional(),
  // SERV10X-61 Task 9 (MONEY PATH) - convert MULTIPLE WON estimates into one job. When present it
  // supersedes estimate_id; every id must be a WON estimate on the SAME lead + customer, and ALL of
  // them get attached to the new job (Estimate.job_id). A length-1 estimate_ids collapses to the
  // single-estimate provenance path (Job.estimate_id set), byte-identical to passing estimate_id.
  // Capped: the id set drives an IN clause and a createMany of the whole line UNION, both inside
  // one transaction. 50 is far above any real selection (the picker is per-lead/customer).
  estimate_ids: z.array(z.string().uuid()).min(1).max(50, 'Select at most 50 estimates').optional(),
  customer_id: z.string().uuid().optional(),
  new_customer: newCustomerSchema.optional(),
  // Existing-customer accretion (§5.3) — mirrors lead.controller.ts.
  phone: optionalCustomerPhone,
  email: optionalCustomerEmail,
  service_location_id: z.string().uuid().optional(),
  new_location: locationSchema.optional(),
  scope_notes: z.string().max(5000).optional(),
  job_type: z.string().max(100).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  estimated_duration: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  // A job is created EITHER from approved estimate(s), OR standalone from a customer + location.
  // The estimate flow is "has estimate_id OR estimate_ids" - the customer/location refine below
  // only applies when NEITHER is present.
  const hasEstimate = Boolean(data.estimate_id) || Boolean(data.estimate_ids?.length);
  if (!hasEstimate) {
    const hasCustomer = Boolean(data.customer_id);
    const hasNewCustomer = Boolean(data.new_customer);
    if (hasCustomer === hasNewCustomer) {
      // neither (need one) OR both (not allowed)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either customer_id or new_customer (exactly one) when no estimate_id is provided', path: ['customer_id'] });
    }
    // An EXISTING customer needs a location source; a new_customer carries its own primary location.
    if (hasCustomer && !data.service_location_id && !data.new_location) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'service_location_id or new_location is required when no estimate_id is provided', path: ['service_location_id'] });
    }
  }
});

export const updateJobSchema = z.object({
  scope_notes: z.string().max(5000).optional(),
  job_type: z.string().max(100).optional().nullable(),
  // §10 — re-point the job to a different service location: pick an existing one by id,
  // or accrete a new one from an address (resolveOrAccreteLocation). customer_id is LOCKED
  // (re-pointing the customer = cancel + create).
  service_location_id: z.string().uuid().optional(),
  address: z.object({
    address_line1: z.string().min(1),
    address_line2: z.string().optional().nullable(),
    city: z.string().min(1),
    state: z.string().min(1),
    zip: z.string().min(1),
  }).optional(),
  estimated_duration: z.number().int().positive().optional(),
  scheduled_start: z.string().datetime({ offset: true }).optional().nullable(),
  scheduled_end: z.string().datetime({ offset: true }).optional().nullable(),
  // R3b (2026-07-21) — cost model (D2/D8). Nullable overhead_mode/value mirror deposit_type/value
  // (both must be set for an override; null falls back to the org default) — see resolveOverhead.
  labor_hours: z.number().min(0).max(99999).nullable().optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  overhead_value: z.number().min(0).nullable().optional(),
  // E1/E2 (job-owns-tax-discount) - the job's own editable tax rate + discount (Items tab).
  // discount_amount is NOT accepted here: it is always SERVER-resolved from discount_type/value
  // against the job's current subtotal, never trusted from the client.
  tax_rate: z.number().min(0).max(1).optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  // D14 (Spec A) — genuinely editable so the reschedule guard below has something to guard.
  // Previously absent, so validate() (a bare zod .parse()) silently stripped it before the
  // controller ever saw it — the field-level guard would have been unreachable dead code.
  is_all_day: z.boolean().optional(),
  // SRVW-87 - the double-book override, mirroring assignJobSchema's `force` below. Same trap as
  // is_all_day above: without the key here, validate()'s bare .parse() strips it and the override
  // is unreachable dead code. Deliberately NO start/end pairing refine on this schema - the
  // reschedule guard's own test sends a lone scheduled_start and expects 403, not 400.
  force: z.boolean().optional(),
  // SRVW-114 slice 1 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid. Same
  // trap as is_all_day/force above: without a key here, validate() strips it before the
  // controller ever sees it and the PATCH silently no-ops. Values are `unknown` here - shape is
  // enforced downstream by validateCustomFieldValues, not by this schema, since the allowed
  // shape depends on each definition's own `type`. An explicit `null` value deletes that key
  // (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

/**
 * The PATCH /api/jobs/:id fields that require `manage_lines Job` (technician-ownership spec, Part
 * C), derived from `updateJobSchema` BY EXCLUSION so the default for a new field is GUARDED.
 *
 * The money fields ride the same PATCH as harmless ones, so the split cannot be made at the route -
 * it needs the field-level check inside `update()`, mirroring the D14 reschedule guard there.
 *
 * Inverted on purpose. The first version of this hand-listed the money fields and missed
 * `labor_hours`/`overhead_mode`/`overhead_value`; with the list inverted, forgetting to classify a
 * new schema key makes the API over-REFUSE (a visible 403 someone reports) instead of silently
 * letting an unauthorised write through. `permissions-job-manage-lines.test.ts` asserts every key of
 * updateJobSchema is classified, so adding one without a decision is a red test either way.
 */
const NOT_MANAGE_LINES_FIELDS = new Set([
  // Plain job fields - the assignee's work surface, gated by `update Job`.
  'scope_notes', 'job_type', 'service_location_id', 'address', 'estimated_duration',
  // Schedule - gated by its own `reschedule Job` check (D14) a few lines below, not by this one.
  'scheduled_start', 'scheduled_end', 'is_all_day', 'force',
  // SRVW-114 slice 1 - Extra Info values are org-admin-defined metadata, not money. Gated by the
  // route's own `update Job` + the per-instance canAccessRow check, same as scope_notes.
  'custom_fields',
]);

export const MANAGE_LINES_FIELDS: readonly string[] = [
  ...Object.keys(updateJobSchema.shape).filter((k) => !NOT_MANAGE_LINES_FIELDS.has(k)),
  // Named by the spec but NOT keys on updateJobSchema, so validate()'s bare .parse() strips them
  // before the guard runs - they cannot reach it today. Listed so that adding either key to the
  // schema cannot silently open a money door; do NOT read this as "they are gated today".
  'discount_name', 'estimate_id',
];

// Crew ⟂ schedule: assignee_ids is the FULL new crew (REPLACE semantics; [] is valid).
// status derives from a MOVED window only — see assign() and jobWindowMoved().
export const assignJobSchema = z.object({
  assignee_ids: z.array(z.string().uuid()),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  is_all_day: z.boolean().optional(),
  force: z.boolean().optional(),
  // SRVW-243 - "tell the customer", as an ACTION rather than a prediction. The
  // confirm dialog used to assert that notification emails were going out while
  // nothing sent at all; this flag is what makes the assertion true, and its
  // absence is what makes the silence honest. Default-off deliberately: an org
  // whose customers are realtors does not want a mail every time a slot shifts.
  // Declared BEFORE the .refine() below - a ZodEffects has no .shape, so a key
  // added after it is invisible to anything that introspects this schema.
  notify_customer: z.boolean().optional(),
  // SRVW-243 compose fields, mirroring sendEstimateSchema's contract
  // (recipient_email / cc_emails max 5 / message_body max 5000). Prefixed
  // `notify_` because this endpoint's subject is scheduling - the compose rides
  // along with it.
  //
  // notify_recipient_email is a ONE-OFF override and is deliberately never
  // written back to the customer row: sending today's notice to the office
  // manager is not the same statement as changing where all future mail goes.
  notify_recipient_email: z.string().email().optional(),
  notify_cc_emails: z.array(z.string().email()).max(5).optional(),
  notify_message: z.string().max(5000).optional(),
}).refine(
  // #1626: a lone `scheduled_end` is still nonsense - there is nothing for it to be the end OF.
  // A lone `scheduled_start` is not, and this refine used to 400 on it: a job holding a start
  // with NO end - a state `updateJobSchema` deliberately permits a PATCH to create - could not be
  // reassigned at all, because the dialog seeded the start it could see and had no end to pair
  // with it. assign() now resolves an omitted end against the job's CURRENT window (see
  // `effectiveEnd` there), which is the same "omitted = unchanged" rule
  // `rescheduleJobVisitSchema` already carries on the visit door (S8 §2b).
  (data) => !data.scheduled_end || Boolean(data.scheduled_start),
  { message: 'scheduled_end requires scheduled_start', path: ['scheduled_start'] },
);

// Crew-only REPLACE (no schedule/status side effects). See setAssignees().
// notify (#361, optional): the assign popover's channel toggles. in_app:false suppresses the
// added-crew dispatch.job_assigned emit; email:false suppresses the added-crew assignment
// email. Removal notices stay unconditional. Omitted → today's behavior (backward compat).
export const setAssigneesSchema = z.object({
  assignee_ids: z.array(z.string().uuid()),
  notify: z.object({ in_app: z.boolean().optional(), email: z.boolean().optional() }).optional(),
});

// #291 — set or clear the job's dispatcher from the JCC Team card.
export const setDispatcherSchema = z.object({
  dispatcher_id: z.string().uuid().nullable(),
});

// SRVW-112 - set or clear the job's org-defined sub-status. A DEDICATED door rather than a key on
// updateJobSchema: it keeps this out of update() (which SRVW-87 also rewrites) and removes the
// ordering trap of validating a sub-status parent against a status the same PATCH is changing.
export const setSubStatusSchema = z.object({
  sub_status_id: z.string().uuid().nullable(),
});

export const completeJobSchema = z.object({
  completion_notes: z.string().max(5000).optional(),
  // Cap at 500KB for parity with the estimate approve signature (estimate.controller.ts).
  // A real signature PNG is tens of KB; this bounds storage / PDF-render amplification (F-48).
  signature_data: z.string().max(500000).optional(),
  signature_ip: z.string().optional(),
  signature_at: z.string().datetime().optional(),
});

export const cancelJobSchema = z.object({
  cancelled_reason: z.string().min(1, 'Cancellation reason is required').max(2000),
});

export const noteSchema = z.object({
  content: z.string().min(1).max(5000),
});

// SRVW-104 - Jobs list bulk actions. `en_route` is deliberately absent from the enum:
// `default-job-en-route` is a seeded, enabled, customer-recipient automation in every org
// (recipients: ['customer']) and enRoute() dispatches it whenever the job has crew, so a bulk
// en-route would message every selected job's customer "we're on the way" with no technician
// actually driving. SCHEDULED/UNSCHEDULED are absent too - those are schedule writes, not status
// changes. The duplicate-ids refine matters because the API (unlike the UI) can be sent one:
// without it a repeated id would run the verb twice, doubling its TimelineEvent/emit/dispatch.
export const bulkStatusJobsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(['arrive', 'start', 'complete', 'cancel']),
    cancelled_reason: z.string().min(1).max(2000).optional(),
  })
  .refine((d) => new Set(d.ids).size === d.ids.length, { message: 'Duplicate job ids', path: ['ids'] })
  .refine((d) => d.action !== 'cancel' || Boolean(d.cancelled_reason?.trim()), {
    message: 'Cancellation reason is required',
    path: ['cancelled_reason'],
  });

export const bulkAssignJobsSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    assignee_ids: z.array(z.string().uuid()),
    notify: z.object({ in_app: z.boolean().optional(), email: z.boolean().optional() }).optional(),
  })
  .refine((d) => new Set(d.ids).size === d.ids.length, { message: 'Duplicate job ids', path: ['ids'] });

// Editable record IDs (plan decision #7) - shared by both the preview and rename doors below.
// The charset/length/numeric-cap rules live in record-renumber.ts's own validateNumberFormat
// (called from computeRenumber) - this schema only needs `number` present and a string.
export const jobNumberSchema = z.object({ number: z.string() }).strict();

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

async function withTags<T extends { id: string }>(req: Request, job: T | null): Promise<(T & { tags: TagSummary[] }) | null> {
  if (!job) return null;
  const tags = await loadTagsForEntity(req, 'JOB', job.id);
  return { ...job, tags };
}

async function withTagsMany<T extends { id: string }>(req: Request, jobs: T[]): Promise<Array<T & { tags: TagSummary[] }>> {
  const grouped = await loadTagsByEntity(req, 'JOB', jobs.map((j) => j.id));
  return jobs.map((j) => ({ ...j, tags: grouped.get(j.id) ?? [] }));
}

/**
 * §5/§10 — surface the remaining un-billed balance against the as-sold estimate total.
 * `remaining_unbilled = estimate.total_amount − amount_invoiced` (a derived read, not a
 * column). Goes negative when change-orders push total billed past the estimate — the
 * intended over-billing signal. Returns the job unchanged when there is no estimate.
 */
function withRemainingUnbilled<
  T extends { amount_invoiced?: unknown; estimate?: { total_amount?: unknown } | null },
>(job: T): T & { remaining_unbilled: number | null } {
  const estimateTotal = job.estimate?.total_amount;
  if (estimateTotal == null) return { ...job, remaining_unbilled: null };
  const billed = Number(job.amount_invoiced ?? 0);
  return { ...job, remaining_unbilled: Math.round((Number(estimateTotal) - billed) * 100) / 100 };
}

// Phase B (§E) — strip the estimate's as-sold dollar figures from a job-detail payload for a
// requester who cannot `read Invoice`. A field technician reaches their OWN job (read Job OWN_JOB)
// and the estimate total + per-line unit_price/line_total leak through the job payload independent
// of invoice read. We keep line DESCRIPTIONS + QUANTITIES (needed to do the work) but remove
// total_amount, unit_price, line_total, and the job's amount_invoiced; the derived
// remaining_unbilled then resolves to null in withRemainingUnbilled (it reads estimate.total_amount).
// QA-B2 leak 2: jobDetailSelect also embeds invoices[] with each invoice's total_amount/amount_due,
// which leaked the same dollar figures a second way; we project those out too (keeping
// invoice_number/status so the tech still knows an invoice exists).
// Mirrors lead.controller's stripEstimateMonetaryFields. ADMIN/DISPATCHER/invoice-readers keep it.
// canSeePricing() itself now lives in ../lib/permissions/enforce.ts (job-lines pricing-leak
// follow-up — job-lines.controller.ts's unit_cost/markup_percent strip needed the same check).

// GAP-5 — money keys that cancel() writes into a JOB timeline event's metadata. getTimeline returns
// metadata raw, so for a requester who cannot see pricing these are redacted (the row/event stays,
// only the monetary fields are removed). Mirrors the job-detail pricing strip.
const TIMELINE_MONEY_METADATA_KEYS = ['collected_total', 'refund_suggested'] as const;

function redactTimelineMoneyForRequester<
  T extends { metadata?: unknown },
>(events: T[], req: Request): T[] {
  if (canSeePricing(req)) return events;
  return events.map((ev) => {
    const meta = ev.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ev;
    const metaObj = meta as Record<string, unknown>;
    if (!TIMELINE_MONEY_METADATA_KEYS.some((k) => k in metaObj)) return ev;
    const cleaned: Record<string, unknown> = { ...metaObj };
    for (const k of TIMELINE_MONEY_METADATA_KEYS) delete cleaned[k];
    return { ...ev, metadata: cleaned };
  });
}

function stripJobPricingForRequester<T extends Record<string, unknown>>(job: T, req: Request): T {
  if (canSeePricing(req)) return job;
  // Clone the branches we redact (rather than mutating in place) so the strip never leaks into a
  // shared object reference. Returns a new job with the monetary fields omitted.
  const out: Record<string, unknown> = { ...job };
  delete out.amount_invoiced;
  // R3b (2026-07-21) — cost model (D2/D8/D18). Same staff-only fields as Estimate's.
  delete out.labor_hours;
  delete out.overhead_mode;
  delete out.overhead_value;
  const estimate = job.estimate as { total_amount?: unknown; line_items?: Array<Record<string, unknown>> } | null | undefined;
  if (estimate) {
    const { total_amount: _omitTotal, line_items, ...estRest } = estimate;
    out.estimate = {
      ...estRest,
      line_items: (line_items ?? []).map(({ unit_price: _u, line_total: _l, ...liRest }) => liRest),
    };
  }
  const invoices = job.invoices as Array<Record<string, unknown>> | null | undefined;
  if (Array.isArray(invoices)) {
    out.invoices = invoices.map(({ total_amount: _t, amount_due: _d, ...invRest }) => invRest);
  }
  // SRVW-96 - same strip on the job's attached (linked) estimates. Array.isArray, not a bare map,
  // because many existing tests mock a jobDetailSelect-shaped job without the new key.
  const linked = job.linked_estimates as Array<Record<string, unknown>> | null | undefined;
  if (Array.isArray(linked)) {
    out.linked_estimates = linked.map(({ total_amount: _t, ...rest }) => rest);
  }
  return out as T;
}

/**
 * Phase B (§E) — the canonical "present a jobDetailSelect job to the requester" pipeline, mirroring
 * getById exactly: attach tags → ability-gated pricing strip → derive remaining_unbilled (which
 * resolves to null once total_amount is stripped). Every handler that responds with a
 * jobDetailSelect-shaped job (the action handlers — update/assign/setAssignees/unassign/enRoute/
 * arrive/start/complete/cancel/reopen — and create) routes through this so a requester who cannot
 * `read Invoice` never gets estimate/invoice pricing echoed back in an action response. Phase B now
 * lets an admin grant a technician an advance verb (or update/create Job) per-user WITHOUT read
 * Invoice, which is exactly that leak. A no-op for invoice readers (the strip early-returns).
 */
// Walkthrough-as-entity redesign, PR-B2: jobDetailSelect's nested `estimate.lead.visits`
// relation (see the select above) needs projecting onto the legacy walkthrough_* field NAMES the
// job detail page already reads off `job.estimate.lead`. A no-op for a standalone (lead-less)
// job, whose `estimate`/`estimate.lead` is null.
function projectJobEstimateLeadWalkthrough<T extends { estimate?: { lead?: unknown } | null }>(job: T): T {
  const lead = job.estimate?.lead;
  if (!lead) return job;
  // S8: the crew flatten runs FIRST - projectLeadWalkthroughFields strips `visits`.
  return { ...job, estimate: { ...job.estimate, lead: projectLeadWalkthroughFields(projectLeadVisitCrew(lead as never), { full: true }) } } as T;
}

type PersonWithAvatarPath = { avatar_path?: string | null } & Record<string, unknown>;

/** Swap `avatar_path` for a response-safe signed `avatar_url` on the three person shapes
 *  jobDetailSelect embeds: the dispatcher, each crew assignee's user, and the estimate's lead
 *  commission_owner. One batched signAvatarPaths call for all three, same as
 *  user.controller.ts's withAvatarUrls but shaped for this nesting instead of a flat row list. */
async function withPersonAvatars<T extends Record<string, unknown>>(job: T): Promise<T> {
  const dispatcher = job.dispatcher as PersonWithAvatarPath | null | undefined;
  const assignees = job.assignees as Array<{ user: PersonWithAvatarPath }> | null | undefined;
  const estimate = job.estimate as { lead?: { commission_owner?: PersonWithAvatarPath | null } | null } | null | undefined;
  const commissionOwner = estimate?.lead?.commission_owner;

  const signed = await signAvatarPaths([
    dispatcher?.avatar_path,
    ...(assignees ?? []).map((a) => a.user?.avatar_path),
    commissionOwner?.avatar_path,
  ]);

  const swap = (person: PersonWithAvatarPath | null | undefined) => {
    if (!person) return person;
    const { avatar_path, ...rest } = person;
    return { ...rest, avatar_url: resolveAvatarUrl(avatar_path, signed) };
  };

  return {
    ...job,
    dispatcher: swap(dispatcher),
    assignees: assignees ? assignees.map((a) => ({ ...a, user: swap(a.user) })) : assignees,
    estimate: estimate
      ? { ...estimate, lead: estimate.lead ? { ...estimate.lead, commission_owner: swap(commissionOwner) } : estimate.lead }
      : estimate,
  };
}

async function presentJobDetail<
  T extends { id: string; amount_invoiced?: unknown; estimate?: { total_amount?: unknown; lead?: unknown } | null },
>(req: Request, job: T | null) {
  const tagged = await withTags(req, job);
  if (!tagged) return null;
  // BEFORE withPersonAvatars: that helper signs every crew member's avatar off `job.assignees`,
  // so the union has to exist by then. S8 (A5, RATIFIED): schedule projection composes with crew
  // projection in the SAME order presentJobDetail always ran them in - crew first (it needs the
  // raw `visits[].assignees` shape), schedule second (a pure read of `visits[]`, order-agnostic
  // with crew but kept after it for one clear pipeline).
  const withCrewAndSchedule = projectJobScheduleFields(projectJobCrewUnion(tagged as Record<string, unknown>)) as typeof tagged;
  const withAvatars = await withPersonAvatars(withCrewAndSchedule);
  return withRemainingUnbilled(stripJobPricingForRequester(projectJobEstimateLeadWalkthrough(withAvatars), req));
}


// GAP-1 — the role-literal `canAccessJob` (ADMIN||DISPATCHER → true, ignoring the CASL
// ability/override engine) was REMOVED. getById/getNotes/addNote/getTimeline now use the
// canonical grant/override-aware canAccessRow, the same per-instance gate as update/remove.

// ─── Crew assignment helpers (scheduler redesign) ──────

// `phone` rides along because this shape becomes an automation event payload's
// RecipientUser (services/automations/executors.ts) - a text step addressed to the
// person just assigned needs their number, and there is no second lookup later.
// `phone_ext` rides beside `phone` (slice 5): the resolved crew is handed straight to
// `visitMergeFields`, and a number with no way through the switchboard behind it reads in a
// customer's inbox as a working contact.
type CrewMember = {
  id: string; email: string | null; first_name: string; last_name: string;
  phone: string | null; phone_ext: string | null;
};

/**
 * Multi-visit S8 (D6): a JOB-LEVEL crew statement, landed on the job's CURRENT visit.
 *
 * `job_assignees` is dropped, so "the job's crew" has no storage of its own - crew lives on the
 * trip. resolveCurrentJobVisit answers the question the office is actually asking ("the trip the
 * crew is standing at"), and applyJobCrewStatementToVisit applies the statement as a DELTA on
 * that one trip rather than as a wholesale restatement, because a job can have several trips with
 * different crews.
 *
 * THE HONEST CONSEQUENCE: a job with NO trip at all cannot hold crew, and this throws rather than
 * writing nothing. It is a visible product change, not a refactor, and it is the direct
 * consequence of D6 plus D16 - the only alternative, an untimed live visit created to hold the
 * crew, would make deriveJobStatusFromVisits answer SCHEDULED for a job with no date.
 *
 * REJECTED ALTERNATIVE: create the trip here, untimed, so the statement always succeeds. That is
 * exactly the D16 violation above, and it would also invent a trip the customer was never told
 * about - D19 keeps visit rows forever, so an invented one is permanent.
 */
export class NoVisitForCrewError extends Error {}

async function setJobCrewOnCurrentVisit(
  tx: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; previousJobCrew: string[]; statedCrew: string[] },
): Promise<{ added: string[]; removed: string[] }> {
  // LIVE trips only, exactly as this function's twin stampCurrentJobVisitMilestone does.
  // resolveCurrentJobVisit's `begun` predicate is "not SCHEDULED, or already started", which a
  // COMPLETED or CANCELLED row satisfies - and being the later row it then WINS the reduce. Handed
  // the whole set, a crew statement lands on yesterday's finished trip: it rewrites the record of
  // who did that work (D19 keeps the row as history), leaves next week's trip on the old crew, and
  // tells a technician they were dropped from a job they are still booked on.
  const visits = await tx.visit.findMany({
    where: { job_id: opts.jobId, organization_id: opts.orgId, status: { in: [...LIVE_VISIT_STATUSES] } },
    select: { id: true, status: true, scheduled_at: true, scheduled_end: true, created_at: true },
  });
  const current = resolveCurrentJobVisit(visits as never[]);
  if (!current) throw new NoVisitForCrewError('This job has no upcoming visit, so crew cannot be assigned to it. Schedule a visit first.');
  return applyJobCrewStatementToVisit(tx, {
    visitId: (current as { id: string }).id,
    orgId: opts.orgId,
    isNewVisit: false,
    previousJobCrew: opts.previousJobCrew,
    statedCrew: opts.statedCrew,
  });
}

/**
 * Slice 2's refusal (assignee-pool plan §"Refusal is 403, not 400"). Deliberately NOT the string
 * the walkthrough twin uses: the two validators are twins, not duplicates, and this one has to
 * name crew. Every job crew door shares it because they all funnel through validateCrew - the
 * same reason the eligibility strings below cannot drift between doors.
 */
const ASSIGN_CREW_SELF_ONLY = 'You can only assign yourself as job crew.';

/**
 * Per-member eligibility: every assignee_id must resolve to an ACTIVE in-org user whose role
 * `isAssignable`. Returns the resolved crew on success, or a {status, error} to send on failure.
 *
 * EXPORTED rather than module-private because it is the tenant check standing between a bare
 * `uuid` off the wire and `visit_assignees`, and the job routes are not the only door onto that
 * table: service-plan.controller's scheduleVisit writes crew onto a plan visit too. Sharing the
 * one function is what keeps the error strings identical across those doors - the thing the
 * callers' comments below say must not drift - and, more importantly, keeps a second door from
 * being written without the tenant clause at all.
 *
 * SINCE SLICE 2, ALSO THE ASSIGNEE-POOL GATE, and it runs FIRST. A requester who does not hold
 * `assign User` may name only themselves. Three things about that placement are load-bearing:
 *
 *  - INSIDE this validator, not at the call sites. Six doors write job crew - /assign,
 *    /assignees, POST and PATCH on visits, plus /status and /bulk-assign, which reach the write
 *    by dispatching into the first two and never call this function's name. A check written at
 *    the four literal call sites would leave those last two unguarded.
 *    SEVEN doors since #1942: service-plan.controller.ts's `scheduleVisit` writes a job
 *    visit's crew directly (`replaceVisitCrew` with `[body.assigned_to]`) and used
 *    to bypass this validator entirely - no tenant clause on the id, so an out-of-org user was
 *    written into `visit_assignees` stamped with THIS org's `organization_id`, satisfying
 *    OWN_JOB scope on this org's job. It now calls this function like the rest.
 *  - BEFORE the per-member loop. A self-only requester naming a fabricated id must be told 403,
 *    not the loop's 404 'User not found', or these doors answer differently for a real
 *    colleague's id than for an invented one and become a user-id oracle.
 *  - Only when the SET CHANGES. `currentCrewIds` is the crew this request would be replacing,
 *    and an unchanged restatement is not a crew statement: VisitScheduleDialog and the Assign
 *    dialog re-send `assignee_ids` on every save whether or not the picker was touched, so
 *    refusing a restatement would stop a non-holder from rescheduling any trip they do not
 *    personally staff. Same exemption `sameSet` gives the task doors, expressed through the
 *    `assigneeSetChanged` comparison this file already uses for the `assign Job` gate.
 *
 * `currentCrewIds` is OPTIONAL, and OMITTING IT IS THE STRICT PATH: an undefined current set
 * means "I cannot vouch that this is a restatement", so the pool rule applies in full. A door
 * added later therefore fails CLOSED if its author does not think about the exemption, and a
 * caller that only ever creates crew from nothing (there is no set to restate) can simply not
 * pass it. Same contract as `validatePerformers`' third parameter - the twins must not disagree
 * about what "unchanged" means.
 */
export async function validateCrew(
  req: Request,
  assigneeIds: string[],
  currentCrewIds?: string[],
): Promise<{ ok: true; users: CrewMember[] } | { ok: false; status: number; error: string }> {
  if (currentCrewIds === undefined || assigneeSetChanged(currentCrewIds, assigneeIds)) {
    const pool = resolveAssigneePoolForRequest(req, 'jobCrew');
    if (!isAssigneeSetPermitted(pool, assigneeIds)) {
      return { ok: false, status: 403, error: ASSIGN_CREW_SELF_ONLY };
    }
  }

  const users: CrewMember[] = [];
  for (const userId of assigneeIds) {
    const tech = await prisma.user.findUnique({
      where: { id: userId, ...tenantWhere(req) },
      select: {
        id: true, role: true, is_active: true, email: true, first_name: true, last_name: true,
        ...performerPhoneSelect,
      },
    });
    if (!tech) return { ok: false, status: 404, error: 'User not found' };
    if (!isAssignable(tech.role)) return { ok: false, status: 400, error: 'This user is not eligible to be assigned as job crew' };
    if (!tech.is_active) return { ok: false, status: 400, error: 'Cannot assign job to an inactive technician' };
    users.push({
      id: tech.id, email: tech.email, first_name: tech.first_name, last_name: tech.last_name,
      phone: tech.phone, phone_ext: tech.phone_ext,
    });
  }
  return { ok: true, users };
}

/** Q6: who is actually double-booked, and on what job/lead. */
type ConflictCrewMember = { id: string; name: string };

type ScheduleConflict =
  | { type: 'job'; id: string; number: string; start: Date | null; end: Date | null; crew: ConflictCrewMember[]; customer_name: string | null }
  | { type: 'walkthrough'; id: string; number: string; start: Date | null; end: Date; crew: ConflictCrewMember[]; customer_name: string | null };

// Q6: the SAME "first + last, else company, else nothing" convention notifyCustomerOfSchedule uses
// for the outgoing email, reused here so the 409 body names the customer the same way the email a
// moment later will.
function conflictCustomerName(
  c: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null | undefined,
): string | null {
  if (!c) return null;
  return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.company_name || null;
}

// Q6: the INTERSECTION of the candidate ids and the crew actually on THIS record - the people who
// are double-booked, not the record's whole crew. `crewOnRecord` may be undefined against an older
// mock/fixture that has not been widened for this select; treated as empty rather than throwing.
function conflictingCrew(
  candidateIds: string[],
  crewOnRecord: { user_id: string; user: { first_name: string; last_name: string } | null }[] | undefined,
): ConflictCrewMember[] {
  const byId = new Map((crewOnRecord ?? []).map((a) => [a.user_id, a.user]));
  return candidateIds.flatMap((id) => {
    const user = byId.get(id);
    return user ? [{ id, name: `${user.first_name} ${user.last_name}`.trim() }] : [];
  });
}

/**
 * Per-member conflict detection. For each candidate user, finds overlapping SCHEDULED/IN_PROGRESS
 * jobs (crew M2M) and scheduled walkthroughs (walkthrough-performer M2M) in the same time window.
 * Returns the conflicts in the EXISTING 409 entry shape (type/id/number/start/end) PLUS Q6's
 * additive `crew`/`customer_name` — the FE retry path + the jobs.test.ts conflict assertion read
 * the original keys verbatim, so those stay byte-stable; only new keys were added.
 */
async function detectCrewConflicts(
  req: Request,
  opts: { jobId: string; userIds: string[]; schedStart: Date; schedEnd: Date },
): Promise<ScheduleConflict[]> {
  if (opts.userIds.length === 0) return [];
  const { schedStart, schedEnd } = opts;

  // Multi-visit S6 (B7): the window this query asks about is the job's VISIT set, not the
  // Job.scheduled_start mirror. The mirror only ever holds the NEXT upcoming trip, so a clash
  // against another job's SECOND visit - at a window the mirror does not hold - went unwarned.
  // That residual gap was written down in this function's own comment and assigned to S6.
  //
  // Multi-visit S8 (D6): crew is matched through the VISITS relation, because `job_assignees` is
  // gone and the visit crew is now the only crew there is. S6's note that the job-level rows were
  // the superset expired with the table. The crew predicate and the window predicate are two
  // SEPARATE `visits: { some: ... }` clauses composed under AND, deliberately: merging them into
  // one `some` would ask "is there a trip that BOTH overlaps this window AND carries this person",
  // which silently stops warning about a person on the job's other trip.
  const jobVisitOverlap = {
    status: { not: 'CANCELLED' as const },
    scheduled_at: { lt: schedEnd },
    scheduled_end: { gt: schedStart },
  };

  const [jobConflicts, walkthroughConflicts] = await Promise.all([
    prisma.job.findMany({
      where: {
        ...tenantWhere(req),
        id: { not: opts.jobId },
        AND: [{ visits: { some: { assignees: { some: { user_id: { in: opts.userIds } } } } } }],
        // Spec B1 (Task 5): a technician physically on site still occupies the slot -- this
        // previously only checked SCHEDULED/IN_PROGRESS, so a double-booking check missed a crew
        // member who had already advanced past SCHEDULED for the conflicting job. S4 retires
        // EN_ROUTE/ON_SITE from JobStatus (they are VisitStatus values now), and a job whose crew
        // is en route or on site reads SCHEDULED or IN_PROGRESS, so both are still covered here.
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
        visits: { some: jobVisitOverlap },
      },
      // The SAME predicate on the nested read, so each overlapping trip maps to exactly one
      // 409 entry - and a job whose other trips sit elsewhere contributes only the clashing one.
      // Q6: widened with the customer's display-name fields and the OVERLAPPING visit's own
      // assignees, so the entry can name who is actually double-booked and whose job it is,
      // without a second round-trip.
      select: {
        id: true,
        job_number: true,
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        visits: {
          where: jobVisitOverlap,
          select: {
            id: true,
            scheduled_at: true,
            scheduled_end: true,
            assignees: { select: { user_id: true, user: { select: { first_name: true, last_name: true } } } },
          },
        },
      },
    }),
    // Walkthrough-as-entity redesign, PR-B2: repointed from Lead.status/walkthrough_scheduled_at
    // onto the Walkthrough row's own status/scheduled_at.
    //
    // Multi-visit S3: `lead_id: { not: null }` means this query is about WALKTHROUGH conflicts
    // specifically. `visits` is now shared by lead walkthroughs and job visits (D5: exactly one
    // parent), and from S3 a job visit carries crew, so without this predicate a crewed job visit
    // matches `assignees.some` and then has no lead to name below - a 500 out of the two most-used
    // scheduling endpoints, which is the one outcome D21's "warn, never block" definitely forbids.
    // Same guard, same reason, as dashboard.controller.ts:318 and dateAnchorSweep.ts.
    //
    // Deliberately NOT widened to report job-visit clashes as well: doing that means reading the
    // visit set as the job's schedule of record (S6), and the job query above already reports the
    // same clash through the job's own visit set, so it would emit a duplicate entry into a 409
    // body the frontend retry path reads byte-for-byte.
    prisma.visit.findMany({
      where: {
        ...tenantWhere(req),
        lead_id: { not: null },
        assignees: { some: { user_id: { in: opts.userIds } } },
        // Q7: the JOB arm above matches `status: { not: 'CANCELLED' }` on the overlapping visit,
        // so a crew member EN_ROUTE/ON_SITE/IN_PROGRESS on another job still clashes. This arm
        // matched `'SCHEDULED'` only, so the identical situation on a WALKTHROUGH - a performer
        // already on site for one appointment - never raised a conflict for a second one booked
        // on top of it. Aligned to the same live-status set the rest of this file uses.
        status: { in: [...LIVE_VISIT_STATUSES] },
        scheduled_at: { not: null },
      },
      // Q6: widened the same way as the job arm - this row's own assignees (the crew match is on
      // THIS visit, unlike the job arm, so there is no separate "which visit" question here) and
      // the lead's customer, for the display name.
      select: {
        id: true,
        scheduled_at: true,
        duration_minutes: true,
        assignees: { select: { user_id: true, user: { select: { first_name: true, last_name: true } } } },
        lead: { select: { id: true, lead_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } } },
      },
    }),
  ]);

  // Filter walkthrough conflicts by time overlap (same window math as the legacy single-tech path).
  // The `wt.lead` narrowing is real, not a `!` assertion: the query above is what guarantees a lead
  // is present, so a future edit that drops the predicate must fail the TYPECHECK rather than throw
  // at runtime on whichever unlucky org double-books first.
  const wtConflicts = walkthroughConflicts.filter(
    (wt): wt is typeof wt & { scheduled_at: Date; lead: { id: string; lead_number: string } } => {
      if (!wt.scheduled_at || !wt.lead) return false;
      const wtStart = new Date(wt.scheduled_at);
      const wtEnd = new Date(wtStart.getTime() + (wt.duration_minutes || 60) * 60_000);
      return wtStart < schedEnd && wtEnd > schedStart;
    },
  );

  return [
    // The entry keeps the PARENT's id and number and the VISIT's times - the 409 body is read
    // byte-for-byte by the frontend retry path and by jobs.test.ts, so those keys are unchanged.
    // Q6 adds `crew` (the intersection of the candidates and THIS visit's own assignees - which
    // can be empty under Q7's deliberate over-warn, when the overlapping visit is not the one
    // that carries the matching crew member) and `customer_name`.
    ...jobConflicts.flatMap((j) =>
      j.visits.map((v) => ({
        type: 'job' as const,
        id: j.id,
        number: j.job_number,
        start: v.scheduled_at,
        end: v.scheduled_end as Date,
        crew: conflictingCrew(opts.userIds, v.assignees),
        customer_name: conflictCustomerName(j.customer),
      })),
    ),
    // `id`/`number` are the LEAD's (not the Walkthrough row's) — the FE retry path and the
    // /leads/{id} link expect the lead, same as before this redesign.
    ...wtConflicts.map((w) => ({
      type: 'walkthrough' as const, id: w.lead.id, number: w.lead.lead_number,
      start: w.scheduled_at,
      end: new Date(new Date(w.scheduled_at).getTime() + (w.duration_minutes || 60) * 60_000),
      crew: conflictingCrew(opts.userIds, w.assignees),
      customer_name: conflictCustomerName(w.lead.customer),
    })),
  ];
}

// ─── Handlers ──────────────────────────────────────────

/**
 * The org clock for a `scheduled_after`/`scheduled_before` pair, resolved ONLY when one of
 * the bounds is a bare org-zone day that actually needs it. The schedule board sends full
 * ISO instants, which are zone-independent - it must not pay for an `organization` lookup on
 * every calendar paint. Shared with the filter engine's memo, so the two never make two
 * lookups inside one request.
 */
async function timezoneForBounds(
  req: Request,
  after: unknown,
  before: unknown,
): Promise<string> {
  if (!isBareOrgDay(after) && !isBareOrgDay(before)) return DEFAULT_TIMEZONE;
  return getRequestOrgTimezone(req as { user?: { organization_id?: string } });
}

/**
 * The current calendar MONTH on the org's clock, as a half-open instant window
 * `[first day 00:00 org, first day of next month 00:00 org)`.
 *
 * Was `new Date(now.getFullYear(), now.getMonth(), 1)` - the server's own month, which is
 * UTC in production. That put the tile counts on a different clock from both the Scheduled
 * column and (now) the "Completed"/"Cancelled" tiles' own click-through filter, which sends
 * org-zone month-day strings. The tile and the list it opened disagreed by the UTC offset
 * plus the month's last day. Half-open for the same DST reason as `orgDayRange`.
 */
function orgMonthWindow(timeZone: string, at: Date = new Date()): { gte: Date; lt: Date } {
  const today = at.toLocaleDateString('en-CA', { timeZone }); // en-CA renders ISO 'YYYY-MM-DD'
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  // Step a full 31 days off the 1st and snap back to that month's 1st: lands on the next
  // month for every month length without any month-arithmetic special cases.
  const firstOfNextMonth = `${addOrgDays(firstOfMonth, 31).slice(0, 7)}-01`;
  return {
    gte: orgDayStart(firstOfMonth, timeZone),
    lt: orgDayStart(firstOfNextMonth, timeZone),
  };
}

/**
 * Build the `where` clause (and the underlying grant-driven `rowScope`) for the job
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `rowScope` too because `list()` reuses it
 * to build the separate stats `scopeWhere`.
 */
export async function buildJobListWhere(req: Request): Promise<{ where: Record<string, unknown>; rowScope: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';

  // #106 — grant-driven row scope (replaces the hand-rolled SALES/TECHNICIAN if-block,
  // which hardcoded two roles + the literal owner field and let every OTHER non-ADMIN role
  // see the whole org). scopeWhereForReq returns {} for ADMIN/unconditional-read, the
  // owner/team/location condition for a conditional read grant, or MATCH_NOTHING
  // (fail-closed) when there is no read grant. Spread as the OUTERMOST base of every
  // where/count/aggregate so a MATCH_NOTHING `id` key can't be overwritten by a filter.
  const rowScope = await scopeWhereForReq(req, 'Job');
  const where: Record<string, unknown> = { ...tenantWhere(req), ...rowScope };

  // Service-plan visit-jobs are managed inside the Service Plans module, so the office Jobs
  // list (and its KPI tiles) exclude them when asked. The calendar and tech app call the same
  // endpoint WITHOUT this flag, so they still see visit-jobs — they must, to execute them.
  if (req.query.exclude_plan_visits === 'true') {
    where.source_plan_id = null;
  }

  // Generalized filter engine (Task 10): status (enum-validated), customer_id,
  // scheduled_after/before (-> scheduled_start), created_after/before (-> created_at). See
  // job.filters.ts's file-level comment for why the crew filters (assigned_to/department_id)
  // are NOT part of this registry.
  await applyFilters(where, req, jobFacets);

  // Multi-visit S6: the board's date window. Hand-rolled here rather than as a `dateRange` facet
  // for the same reason the crew filters below are hand-rolled - it must compose under AND and
  // must never assign `where.visits`. S8 repoints the stored OWN_JOB row scope at the visits
  // relation, at which point a bare assignment here would silently overwrite a technician's row
  // scope: an RBAC bypass. Semantics: "this job has a trip inside the window", measured on the
  // visit's own `scheduled_at`, NOT on the `Job.scheduled_start` mirror, which by D14 only holds
  // the NEXT upcoming visit and therefore hid every later trip from the board.
  //
  // The two bounds arrive in TWO shapes and mean different things (see lib/orgDayRange.ts).
  // The schedule board sends full ISO instants and is unchanged byte-for-byte. The list
  // FILTER chip sends bare org-zone 'YYYY-MM-DD' days, which `new Date(...)` used to read as
  // midnight UTC - so the inclusive "to" day was cut at its own start ("Today" was a
  // zero-width window that could never match) and both edges sat on UTC's midnight rather
  // than the org's, 8:00 PM the previous evening in America/New_York. The Scheduled column
  // renders on the org clock, so the column and the filter disagreed about the day.
  const scheduledAfter = req.query.scheduled_after as string | undefined;
  const scheduledBefore = req.query.scheduled_before as string | undefined;
  const scheduledWindow = (scheduledAfter || scheduledBefore)
    ? orgDayRange(scheduledAfter, scheduledBefore, await timezoneForBounds(req, scheduledAfter, scheduledBefore))
    : null;
  if (scheduledWindow) {
    (where.AND ??= [] as unknown[]);
    // Deliberately NOT `status: { in: LIVE_VISIT_STATUSES }`: that list excludes COMPLETED, and
    // the board asks for COMPLETED work on purpose (it paints finished cards faded). Only a
    // called-off trip is hidden - keeping it would occupy a crew lane with work nobody is doing.
    //
    // The second arm is not the board's: a job that was CALLED OFF holds nothing but cancelled
    // trips (D19 keeps the rows), so the first arm alone deletes every cancelled job from every
    // date-range question - 263 rows on staging - and this same `where` feeds the office Jobs
    // list, its CSV export and the copilot job tool, not only the calendar. "Show me the jobs we
    // cancelled in March" answered "none". The arm is keyed on the JOB's own status, so it can
    // never widen the board: the board's request pins status to SCHEDULED/IN_PROGRESS/COMPLETED
    // at the top level, and that ANDs with this clause.
    (where.AND as unknown[]).push({
      OR: [
        { visits: { some: { scheduled_at: scheduledWindow, status: { not: 'CANCELLED' } } } },
        { status: 'CANCELLED' as const, visits: { some: { scheduled_at: scheduledWindow } } },
      ],
    });
  }

  // Crew (M2M) filters: assignee user and/or assignee department. SECURITY: kept hand-rolled
  // here rather than as generic engine facets - see job.filters.ts's file-level comment.
  //
  // Multi-visit S8 (D6): crew is reached THROUGH THE TRIPS. `Job.assignees` is gone with
  // `job_assignees`, so the pre-S8 `{ assignees: { some } }` shape is not a narrower filter here,
  // it is a `PrismaClientValidationError` - and `where` is a `Record<string, unknown>`, so tsc
  // cannot see it and the mocked-Prisma suite never validates it. Both live callers (the Jobs
  // list "Assigned to" chip and the schedule board's department filter) 500'd wholesale.
  //
  // ALWAYS composed under AND, never assigned onto `where.visits`. Two reasons, and the first is
  // the security one: `scopeWhereForReq` may already have narrowed this requester to their own
  // trips (TECHNICIAN's OWN_JOB is `visits.some.assignees.some.user_id: <self>`, and since the
  // technician-ownership spec widened `read Job` it arrives wrapped in `{ OR: [...] }`). Merging
  // attacker-supplied `assigned_to` into that SAME `.some` would OVERWRITE `user_id: <self>` and
  // widen a row-scoped user onto somebody else's jobs. The second is plain collision: the board's
  // date window above is also a `visits: { some: ... }` clause, and a bare assignment would drop
  // it. Under AND both survive as separate, additive constraints.
  //
  // The two params still merge into ONE `assignees.some`, so `assigned_to=X&department_id=D`
  // asks "a trip crewed by X, who is in D" rather than "a trip with X on it and a trip with
  // anyone from D on it" - the pre-S8 meaning, kept.
  const assignedTo = parseArrayParam(req.query.assigned_to);
  const departmentId = parseArrayParam(req.query.department_id);
  if (assignedTo.length || departmentId.length) {
    const assigneeSome: Record<string, unknown> = {};
    if (assignedTo.length) assigneeSome.user_id = assignedTo.length === 1 ? assignedTo[0] : { in: assignedTo };
    if (departmentId.length) assigneeSome.user = { department_id: departmentId.length === 1 ? departmentId[0] : { in: departmentId } };
    (where.AND ??= [] as unknown[]);
    (where.AND as unknown[]).push({ visits: { some: { assignees: { some: assigneeSome } } } });
  }

  const needsInvoice = req.query.needs_invoice as string | undefined;
  if (needsInvoice === 'true') {
    where.status = 'COMPLETED';
    where.NOT = { invoices: { some: { status: { not: 'VOIDED' } } } };
  }

  if (search) {
    // Clobber-safe: for a MULTI-READ user the spread-in `rowScope` is itself `{ OR: [...] }`
    // (e.g. SALES role read OWN_JOB_VIA_ESTIMATE + a `create/update Job` override implying OWN_JOB
    // → two distinct conditions → scope OR). A bare `where.OR = [...search...]` would silently drop
    // that scope OR = a row-scope LEAK. addOrFilter demotes a pre-existing scope OR under AND
    // alongside the search OR (`AND: [{OR: scope}, {OR: search}]`) so neither is lost; with no scope
    // OR it's the unchanged cheap `where.OR =` path. Mirrors the lead/invoice/estimate list fix.
    addOrFilter(where, [
      { job_number: { contains: search, mode: 'insensitive' } },
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      { customer: { company_name: { contains: search, mode: 'insensitive' } } },
    ]);
  }

  return { where, rowScope };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, JOB_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const { where, rowScope } = await buildJobListWhere(req);
    const scopeWhere: Record<string, unknown> = { ...tenantWhere(req), ...rowScope };
    // exclude_plan_visits also scopes the stats tiles (mirrors the list `where`).
    if (req.query.exclude_plan_visits === 'true') {
      scopeWhere.source_plan_id = null;
    }

    // Monthly window for completed/cancelled status tiles (a visit scheduled ∈ current month),
    // measured on the ORG's calendar month - see `orgMonthWindow`.
    const monthWindow = orgMonthWindow(
      await getRequestOrgTimezone(req as { user?: { organization_id?: string } }),
    );
    const needInvoiceWhere: Prisma.JobWhereInput = {
      ...scopeWhere,
      status: 'COMPLETED',
      NOT: { invoices: { some: { status: { not: 'VOIDED' } } } },
    };

    // S8 (RATIFIED): these two tiles filtered `Job.scheduled_start` directly, which is DROPPED.
    // Repointed to the VISIT SET using the identical pattern `buildJobListWhere` already proves
    // (the board's date-range filter, above) - BACKWARD-LOOKING (a visit that WAS scheduled this
    // month), never `resolveNextJobVisit`/`first_visit_start` (those answer "what's next", not
    // "what happened/was due this month"). The headline case this must not regress: a COMPLETED
    // job whose only visit already left the live set still counts (7,495 staging jobs carry a
    // non-null legacy mirror with no live visit - the dominant population, not an edge case).
    //
    // Composed under `AND`, never assigned onto `completedThisMonthWhere.OR` /
    // `where.visits` directly - `scopeWhere` may already carry a technician's row-scope OR (or,
    // for a future grant shape, a `visits.some` clause of its own), and overwriting either is an
    // RBAC bypass. Mirrors buildJobListWhere's own `where.AND ??= []` idiom exactly.
    const completedThisMonthWhere: Record<string, unknown> = { ...scopeWhere, status: 'COMPLETED' };
    (completedThisMonthWhere.AND ??= [] as unknown[]);
    (completedThisMonthWhere.AND as unknown[]).push({
      OR: [
        { visits: { some: { scheduled_at: monthWindow, status: { not: 'CANCELLED' } } } },
        { status: 'CANCELLED' as const, visits: { some: { scheduled_at: monthWindow } } },
      ],
    });
    const cancelledThisMonthWhere: Record<string, unknown> = { ...scopeWhere, status: 'CANCELLED' };
    (cancelledThisMonthWhere.AND ??= [] as unknown[]);
    (cancelledThisMonthWhere.AND as unknown[]).push({
      OR: [
        { visits: { some: { scheduled_at: monthWindow, status: { not: 'CANCELLED' } } } },
        { status: 'CANCELLED' as const, visits: { some: { scheduled_at: monthWindow } } },
      ],
    });

    const [
      jobs, total,
      statusGroups,
      completedThisMonth, cancelledThisMonth, needInvoicesCount,
    ] = await Promise.all([
      prisma.job.findMany({
        where,
        select: jobListSelect,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.job.count({ where }),
      prisma.job.groupBy({
        by: ['status'],
        where: scopeWhere,
        _count: true,
      }),
      prisma.job.count({ where: completedThisMonthWhere }),
      prisma.job.count({ where: cancelledThisMonthWhere }),
      prisma.job.count({ where: needInvoiceWhere }),
    ]);

    const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count]));

    res.json({
      // S8: same projectors as the detail pipeline, so the list's `assignees`/`scheduled_start`
      // and the detail's cannot disagree about who is on a job or when it is next due.
      jobs: (await withTagsMany(req, jobs)).map((j) =>
        projectJobVisitLocations(projectJobScheduleFields(projectJobCrewUnion(j as Record<string, unknown>)))),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        unassigned:    byStatus['UNSCHEDULED']  ?? 0,
        scheduled:     byStatus['SCHEDULED']   ?? 0,
        // S4 (D17): EN_ROUTE and ON_SITE no longer exist on JobStatus, so there is nothing left
        // to fold - a job whose crew is on the way or on site derives SCHEDULED or IN_PROGRESS.
        in_progress:   byStatus['IN_PROGRESS'] ?? 0,
        completed:     completedThisMonth,
        cancelled:     cancelledThisMonth,
        need_invoices: needInvoicesCount,
      },
    });
  } catch (err) {
    logger.error('List jobs error:', err);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
}

const EXPORT_ROW_CAP = 50_000;

/**
 * Export every job matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV
 * the frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildJobListWhere(req);
    const jobs = await prisma.job.findMany({
      where,
      select: jobListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (jobs.length === EXPORT_ROW_CAP) {
      logger.warn(`Job export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    void logAudit({ req, action: 'job.exported', resourceType: 'Job', resourceId: null, metadata: { count: jobs.length } });
    // S8: the CSV builder reads the `assignees` and `scheduled_start` columns by name, so the
    // export needs the SAME derived projections the list serves - no forks (A5 condition (iii)).
    res.json({ jobs: jobs.map((j) =>
      projectJobVisitLocations(projectJobScheduleFields(projectJobCrewUnion(j as Record<string, unknown>)))) });
  } catch (err) {
    logger.error('Export jobs error:', err);
    res.status(500).json({ error: 'Failed to export jobs' });
  }
}

/**
 * SERV10X-61 - thrown inside the multi-estimate transaction when the conditional attach matched
 * fewer estimates than were requested, i.e. a concurrent create attached one of them first.
 * Rolls the transaction back and surfaces as a 409 (see create()'s catch), not a 500.
 */
class EstimateAttachRaceError extends Error {}

/**
 * Book the trip a create said it booked (MV-BOARD-15, section 4.3 of the multi-visit QA run).
 *
 * POST /api/jobs writes scheduled_start straight onto the job row and flips it to SCHEDULED.
 * Before this, it made no visit - so the job read "Scheduled, Aug 22, 9:00 AM" on its own page,
 * showed "No visits booked yet" on its Visits tab, painted no board card, returned 0 rows from
 * the board's date-range query, and was absent from the Unscheduled bucket because its status
 * was SCHEDULED. A missed-appointment class defect: scheduled to whoever opens it, non-existent
 * to anyone working the board.
 *
 * Conditional on a time being given, and that is the whole of D16's rule: a create WITHOUT a
 * scheduled_start still makes no visit and the job is correctly UNSCHEDULED, because inventing
 * an untimed trip is the thing D16 forbids. `syncJobWindowOntoVisits` is the same writer /assign
 * already uses for exactly this - one job-level window landing on one visit - so the two doors
 * cannot disagree about what a single-window booking means.
 *
 * The end falls back to the org's own default_job_duration_min when the caller gave only a
 * start - the same setting the board's adapters fall back to when a visit carries no end - and
 * to two hours when the org has not set one. The org row is read only when a time was actually
 * given, so an unscheduled create costs no extra query.
 *
 * Scheduling-notifications PRD (user story 1): this is the THIRD booking door, and it states its
 * facts to the same decideScheduleDispatch the other two ask. They are the simplest facts a door
 * can state - the job was just created, so it had no start and no announcement before this write,
 * and it books the job's own window, not a further trip - and the answer is JOB_SCHEDULED, crew
 * or no crew. Before this the create door never asked, so a job booked with a date on /jobs/new
 * enrolled nothing, and with the once-per-job guard left NULL every later move through /assign
 * asked the decision on stale facts and fired nothing either. Returns what the post-commit
 * dispatch needs (dispatchScheduledOnCreate below), or null when no trip was booked.
 */
type BookedInitialVisit = { visitId: string; scheduledAt: Date; decision: ScheduleDispatchDecision };

async function bookInitialVisitIfScheduled(
  tx: Prisma.TransactionClient,
  opts: { jobId: string; orgId: string; scheduledStart?: string | null; scheduledEnd?: string | null; isAllDay?: boolean },
): Promise<BookedInitialVisit | null> {
  if (!opts.scheduledStart) return null;
  const scheduledAt = new Date(opts.scheduledStart);
  let scheduledEnd: Date;
  if (opts.scheduledEnd) {
    scheduledEnd = new Date(opts.scheduledEnd);
  } else {
    const org = await tx.organization.findUnique({
      where: { id: opts.orgId },
      select: { default_job_duration_min: true },
    });
    scheduledEnd = new Date(scheduledAt.getTime() + (org?.default_job_duration_min ?? 120) * 60_000);
  }
  const booked = await syncJobWindowOntoVisits(tx, {
    jobId: opts.jobId,
    orgId: opts.orgId,
    scheduledAt,
    scheduledEnd,
    isAllDay: opts.isAllDay ?? false,
  });
  const decision = decideScheduleDispatch({
    startBefore: null,
    startAfter: scheduledAt,
    additionalTrip: false,
    scheduledDispatchedAt: null,
    crewCount: 0,
  });
  // The once-per-job guard, written in the SAME transaction as the trip (a rolled-back create
  // leaves it unset) and as its own write, exactly as /visits stamps it. This is what lets the
  // job's later doors answer correctly: with it set, a crew change is TECH_ASSIGNED only and a
  // move is JOB_RESCHEDULED; left NULL, both read "never announced" and fire nothing.
  // `organization_id: opts.orgId` is the caller's tenantWhere(req) - every create branch passes
  // req.user's organization_id in - so the write is tenant-scoped the same way.
  if (decision.stampScheduledDispatched) {
    await tx.job.update({
      where: { id: opts.jobId, organization_id: opts.orgId },
      data: { customer_scheduled_email_sent_at: new Date() },
    });
  }
  return { visitId: booked.id, scheduledAt, decision };
}

/**
 * The create door's half of the post-commit dispatch the two other doors make: "Job is scheduled",
 * keyed to the trip the create just booked, rendering that trip. Post-commit for the same reason
 * /assign's and /visits' are - a job that was genuinely created must not be rolled back by the
 * automation layer - and, like everything else after the create's commit (#375), a failure here
 * is logged rather than turned into a 500 for a job that exists.
 *
 * No crew: this door names nobody (the visit it booked has no assignees), so {{technician.*}}
 * renders through the template's fallbacks, exactly as /assign's crewless first booking does.
 * No notify override either: POST /api/jobs never carried the notify fields, so there is nothing
 * to suppress on.
 */
async function dispatchScheduledOnCreate(
  req: Request,
  job: { id: string; job_number: string; service_location: ServiceLocationParts },
  booked: BookedInitialVisit | null,
): Promise<void> {
  if (!booked || booked.decision.event !== 'JOB_SCHEDULED') return;
  const orgId = req.user!.organization_id;
  try {
    // Read once and handed to both phone fields below, the rule this file already applies at the
    // JOB_SCHEDULED door: two reads of Organization.phone building one message are two chances
    // for one email to quote two different main lines.
    const mainLine = await getOrgMainLine(orgId);
    dispatchAutomationEvent({
      type: 'JOB_SCHEDULED',
      organizationId: orgId,
      entity: { type: 'job', id: job.id, label: job.job_number },
      visitId: booked.visitId,
      actorId: req.user?.id ?? null,
      eventPayload: {
        mergeFields: visitMergeFields(
          { scheduled_at: booked.scheduledAt },
          [],
          await getOrgTimezone(orgId),
          await visitLocationForOccurrence(req, booked.visitId, job.service_location),
          // This door dispatches with NO crew (the initial booking names nobody), so
          // {{technician.phones}} has no mobile to offer and falls through to the organisation's
          // main line - the same number the email renders under {{org.phone}}, never '' (D7).
          // Stated rather than defaulted: the parameter is required so each site answers aloud.
          mainLine,
          // Slice 7: this door dispatches with NO crew (the initial booking names nobody), so
          // there is no user whose ServWave number could be resolved and this falls through to
          // the same main line {{technician.phones}} uses. Stated rather than defaulted, because
          // the parameter is required precisely so each site answers out loud.
          await resolveServWavePhones(orgId, [], mainLine),
        ),
      },
    });
  } catch (e) {
    logger.error('Post-commit JOB_SCHEDULED dispatch failed (job WAS created):', e);
  }
}

export async function create(req: Request, res: Response) {
  try {
    const {
      estimate_id: singleEstimateId, estimate_ids, customer_id, service_location_id, new_location,
      scope_notes, job_type, ad_source,
      scheduled_start, scheduled_end, estimated_duration,
      phone, email,
    } = req.body;

    // SERV10X-61 Task 9 - normalize the single/multi estimate inputs into ONE array. estimate_ids
    // (multi) wins when present; else a lone estimate_id becomes a length-1 array; else [] (the
    // standalone/customer flow). Length 0 → standalone branch; length 1 → the UNCHANGED single-
    // estimate branch (byte-identical provenance + idempotency); length > 1 → the new multi branch.
    const estimateIds: string[] = estimate_ids ?? (singleEstimateId ? [singleEstimateId] : []);

    // #375: once the job is committed, post-commit presentation (which loads tags) must
    // never turn success into a 500 "Failed to create job". Present defensively — on a
    // post-commit failure, log it and return a minimal payload (the FE navigates on id and
    // the detail page refetches).
    const safePresentJob = async <T extends { id: string; job_number: string }>(j: T) => {
      try {
        return await presentJobDetail(req, j);
      } catch (e) {
        logger.error('Post-commit job presentation failed (job WAS created; returning minimal payload):', e);
        return { id: j.id, job_number: j.job_number };
      }
    };

    // Phase B — row-scoped creators (a per-user OWN-scoped `create Job` grantee, e.g. a technician)
    // must end up OWNING the job they create, else they can't read it afterwards (#232). Detect via
    // the Job read-scope: a row-scoped grantee's paired `read Job` is conditioned (OWN_JOB) so the
    // fragment is non-empty; an unconditional creator (dispatcher/admin) yields {} and is NOT
    // auto-assigned. The route guard `canDo('create','Job')` already gated entry.
    const jobScope = await scopeWhereForReq(req, 'Job');
    const isRowScopedCreator = Object.keys(jobScope).length > 0;
    const orgId = req.user!.organization_id;
    // Scheduling-notifications PRD (user story 1): the trip this create booked, if any, and the
    // shared decision's answer for it - set by whichever branch runs, read post-commit below.
    let bookedVisit: BookedInitialVisit | null = null;

    if (estimateIds.length === 0) {
      // Fields written onto every standalone job (the estimate branch builds its own).
      // S8 (RATIFIED, A5): scheduled_start/scheduled_end are DROPPED as job columns - the real
      // write is bookInitialVisitIfScheduled below, which books the matching VISIT in the same
      // transaction. Writing them here too would be a Prisma error (the field no longer exists).
      const jobExtra = {
        scope_notes: scope_notes || null,
        job_type: job_type || null,
        estimated_duration: estimated_duration || null,
        ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
        // Audit: both standalone branches (new customer / existing customer) spread this.
        ...createdByUser(req),
      };

      // ── Inline new customer (mirrors POST /api/leads new_customer path) ──
      const { new_customer } = req.body;
      if (new_customer) {
        const override = req.query.override === 'true';
        const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
          email: new_customer.email,
          phone: new_customer.phone,
        }, { requester: req });
        if (duplicateMatch && !override) {
          res.status(409).json(duplicateConflictBody(duplicateMatch));
          return;
        }

        const job = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
          const { location, email, ad_source: newCustomerSource, ...customerData } = new_customer;
          const newCust = await tx.customer.create({
            data: {
              ...(await withRequiredCustomerFields(tx, orgId, {
                ...customerData,
                // Email is optional — omitted/blank persists as NULL.
                email: email?.trim() || null,
                ad_source: newCustomerSource || ad_source || null,
              })),
              service_locations: { create: { ...location, is_primary: true } },
              // Audit: the user creating the job also authored the customer this path mints. LAST
              // so it wins over the body-derived spread above.
              ...createdByUser(req),
            },
            select: { id: true, service_locations: { where: { is_primary: true }, take: 1, select: { id: true } } },
          });

          // Forward audit of a knowingly-duplicate create (no merge tool yet) — mirrors POST /api/leads.
          // #1996: a requester who could not read the matched row gets a neutral description and
          // no `matched_customer_number` in the metadata.
          if (override && duplicateMatch) {
            await tx.timelineEvent.create({
              data: {
                organization_id: orgId,
                entity_type: 'CUSTOMER',
                entity_id: newCust.id,
                event_type: 'CUSTOMER_CREATED',
                description: duplicateMatch.readable
                  ? `Customer created (duplicate of ${duplicateMatch.match.customer_number} bypassed)`
                  : 'Customer created (duplicate of an existing customer bypassed)',
                metadata: duplicateMatch.readable
                  ? {
                      duplicate_override: true,
                      matched_customer_id: duplicateMatch.match.id,
                      matched_customer_number: duplicateMatch.match.customer_number,
                    }
                  : {
                      duplicate_override: true,
                      matched_customer_id: duplicateMatch.match.id,
                    },
                created_by: req.user!.id,
              },
            });
          }

          const primaryLocationId = newCust.service_locations[0]?.id ?? null;
          const jobNumber = await allocateNumber(tx, 'job', orgId);
          // E1 (job-owns-tax-discount) - a standalone job has no estimate to inherit from, so it
          // stamps tax_rate from its own service location, same lookup estimate.controller.ts
          // uses. Must run on `tx`: a read on the outer `prisma` client here would ask the pooler
          // for a 2nd connection while this transaction is still open.
          const taxRate = await resolveTaxRateForState(tx, orgId, location?.state ?? null);
          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: orgId,
              customer_id: newCust.id,
              service_location_id: primaryLocationId,
              tax_rate: taxRate,
              ...jobExtra,
            },
            select: jobDetailSelect,
          });

          // Phase B (#232) / S8 (D6): the self-assign row is GONE with the table. A create path
          // that made no visit has no trip for the creator to be on, and D16 forbids inventing an
          // untimed one. Nothing is lost: TECHNICIAN's `read Job` is OWN_OR_CREATED_JOB, so the
          // creator reaches their own job through the created_by_id arm either way.

          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created`,
              created_by: req.user!.id,
            },
          });

          // The trip this create just said it booked - see bookInitialVisitIfScheduled.
          bookedVisit = await bookInitialVisitIfScheduled(tx, {
            jobId: j.id,
            orgId,
            scheduledStart: scheduled_start,
            scheduledEnd: scheduled_end,
          });

          return j;
        }), { label: 'job.create.new_customer' });

        void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
        await dispatchScheduledOnCreate(req, job, bookedVisit);
        res.status(201).json({ job: await safePresentJob(job) });
        return;
      }

      // Existing customer — verify it exists in the requesting org. Selects the #2041 proof
      // relations too (the row is otherwise used only for this existence + readability check).
      const customer = await prisma.customer.findUnique({
        where: { id: customer_id, ...tenantWhere(req) },
        select: { id: true, organization_id: true, ...CUSTOMER_PROOF_SELECT },
      });
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }

      // Cross-customer accretion guard (#800 follow-up) — mirrors the new_customer path and
      // POST /api/leads. A typed phone/email belonging to a DIFFERENT customer must not
      // silently accrete onto the linked one. `?override=true` bypasses (Create anyway); the
      // linked customer is EXCLUDED so its own prefilled contact never trips this (that
      // same-customer case is deduped inside accreteContactMethods). This guard's own 409 is
      // ALREADY redacted per-requester by findDuplicateCustomer/duplicateConflictBody (#1996) —
      // it never depends on whether the requester can read the LINKED customer, only the
      // cross-matched one, so it runs before the #1996 follow-up gate below.
      if (phone || email) {
        const override = req.query.override === 'true';
        const crossMatch = await findDuplicateCustomer(prisma, orgId, { phone, email }, {
          requester: req,
          excludeCustomerId: customer_id,
        });
        if (crossMatch && !override) {
          res.status(409).json(duplicateConflictBody(crossMatch));
          return;
        }
      }

      // #2041 decision 8 (was #1996's refusal): the create Job grant the route already enforced
      // is the authority; a picker-visible customer the requester is not otherwise associated
      // with may still be booked. `customerReadable` instead gates the ad_source/accretion writes
      // below and the response redaction after the write.
      const customerReadable = isCustomerReadableRow(req, customer);

      // Validate an explicitly-picked location up front (preserves the BUG #20 query
      // shape + 404). A new_location is accreted inside the transaction instead.
      let resolvedLocationId: string | null = null;
      let resolvedLocationState: string | null = null;
      if (service_location_id) {
        const location = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id, is_active: { not: false } },
          select: { id: true, state: true },
        });
        if (!location) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
        resolvedLocationId = location.id;
        resolvedLocationState = location.state;
      }

      // Retry-safety: `resolvedLocationId`/`resolvedLocationState` are ASSIGNED inside the
      // transaction below, and a location accreted by an attempt that then collided on the job
      // number rolls back with it. Every attempt therefore has to start from these
      // pre-transaction values, or attempt 2 would write an FK to a row that no longer exists.
      const pickedLocationId = resolvedLocationId;
      const pickedLocationState = resolvedLocationState;

      let job;
      try {
        job = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
          resolvedLocationId = pickedLocationId;
          resolvedLocationState = pickedLocationState;

          // Source lives on the customer — update it when supplied. #2041 decision 8: only when
          // the requester can read the row — a rep must not relabel another rep's customer.
          if (customerReadable && ad_source !== undefined) {
            await tx.customer.update({ where: { id: customer_id }, data: { ad_source: ad_source || null } });
          }

          // Workiz-style accretion (spec §3/§5.3): a typed phone/email adds a new
          // secondary contact method on the customer; the primary is never touched. #2041
          // decision 8: only when readable.
          if (customerReadable) {
            await accreteContactMethods(tx, customer_id, { phone, email });
          }

          // No id picked → accrete the new_location onto the customer. #2041 decision 8: this is
          // a WRITE (find-or-create a ServiceLocation on the customer, same hazard as the
          // ad_source/accreteContactMethods writes above), so it only runs when the requester can
          // read the row — a rep must not insert an address onto a customer they cannot read (and
          // learn from the dedupe find-or-create whether that address already exists there).
          // Job.service_location_id is NOT NULL (unlike Lead's), so there is no silent-skip
          // fallback here: refuse with the same 400 shape a bad service_location_id already gets.
          if (!resolvedLocationId && !customerReadable) {
            throw new LocationResolutionError(
              'You do not have access to this customer to add a new service location — pick an existing one instead',
            );
          }
          if (!resolvedLocationId) {
            const resolved = await resolveOrAccreteLocation(tx, {
              customerId: customer_id,
              orgId,
              service_location_id: null,
              address: new_location ?? null,
            });
            resolvedLocationId = resolved.id;
            resolvedLocationState = resolved.state;
          }

          // E1 (job-owns-tax-discount) - see the new_customer branch above for why this must run
          // on `tx`.
          const taxRate = await resolveTaxRateForState(tx, orgId, resolvedLocationState);

          const jobNumber = await allocateNumber(tx, 'job', orgId);
          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: orgId,
              customer_id,
              service_location_id: resolvedLocationId,
              tax_rate: taxRate,
              ...jobExtra,
            },
            select: jobDetailSelect,
          });

          // Phase B (#232) / S8 (D6): the self-assign row is GONE with the table. A create path
          // that made no visit has no trip for the creator to be on, and D16 forbids inventing an
          // untimed one. Nothing is lost: TECHNICIAN's `read Job` is OWN_OR_CREATED_JOB, so the
          // creator reaches their own job through the created_by_id arm either way.

          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created`,
              created_by: req.user!.id,
            },
          });

          // The trip this create just said it booked - see bookInitialVisitIfScheduled.
          bookedVisit = await bookInitialVisitIfScheduled(tx, {
            jobId: j.id,
            orgId,
            scheduledStart: scheduled_start,
            scheduledEnd: scheduled_end,
          });

          return j;
        }), { label: 'job.create.existing_customer' });
      } catch (e) {
        if (e instanceof LocationResolutionError) {
          res.status(400).json({ error: (e as Error).message });
          return;
        }
        throw e;
      }

      // ─── In-app notification hook ───────────────────────────────────────────
      // Job created directly (no estimate): notify dispatchers.
      await emit({
        verb: 'dispatch.job_created',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id: job.id, label: job.job_number },
        entity: { assignee_ids: [] },
        data: { object_label: job.job_number },
      });

      // Phase B (§E) — a row-scoped creator (e.g. a technician creating an urgent standalone job,
      // #232) who lacks read Invoice shouldn't get pricing echoed back; no-op for invoice readers.
      void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
      await dispatchScheduledOnCreate(req, job, bookedVisit);
      // #2041 decision 8 — redact the response through the same contact strip evaluated AFTER
      // the write, for a requester who is still not associated with the linked customer. Findings
      // 1/6: the job's OWN `service_location` (jobDetailSelect) is the SAME customer's street
      // address one key over from `customer` — strip it with the same verdict.
      {
        const presentedJob = (await safePresentJob(job)) as unknown as {
          customer?: Record<string, unknown> | null;
          service_location?: Record<string, unknown> | null;
        };
        res.status(201).json({
          job: {
            ...presentedJob,
            customer: redactCustomerRowUnless(presentedJob.customer, customerReadable),
            service_location: redactServiceLocationRowUnless(presentedJob.service_location, customerReadable),
          },
        });
      }
    } else if (estimateIds.length === 1) {
      // SERV10X-61 Task 9 - LENGTH 1: the UNCHANGED single-estimate branch (byte-identical
      // provenance, idempotent find-or-create, cost-basis copy, P2002 race fallback). `estimate_id`
      // is the one selected id, whether the request used `estimate_id:X` or `estimate_ids:[X]`.
      const estimate_id = estimateIds[0];
      // Standard flow: validate estimate exists in requesting org. The route guard
      // `canDo('create','Job')` already gated entry; ownership is narrowed below (Phase B —
      // replaces the old blanket `role === 'TECHNICIAN'` 403, which a per-user grant couldn't
      // override). lead_assignees is loaded so a row-scoped creator can be checked against the
      // parent lead's ownership.
      const estimate = await prisma.estimate.findUnique({
        where: { id: estimate_id, ...tenantWhere(req) },
        select: {
          id: true,
          status: true,
          estimate_number: true,
          lead_id: true,
          // SERV10X-61 - the estimate's OWN denormalized anchors, read as the fallback for a
          // lead-less (customer-anchored) estimate. Same resolution the multi branch does.
          customer_id: true,
          service_location_id: true,
          // job_id = attachment (EstimateJobLink); job = provenance reverse (JobPrimaryEstimate).
          // Both are read so a JOB-anchored estimate (job_id set, nothing pointing back) can be
          // told apart from a plain re-conversion of an estimate that owns its own job.
          job_id: true,
          job: { select: { id: true } },
          job_type: true,
          // R3b (2026-07-21) — cost model (D2/D8/D18): copied onto the new Job below so its cost
          // basis starts where the estimate left off, not the org default (that fallback is only
          // for a Job created from scratch, e.g. an urgent job with no estimate_id).
          labor_hours: true,
          overhead_mode: true,
          overhead_value: true,
          // E1/E2 (job-owns-tax-discount) - copied onto the new Job below, same "no information
          // loss on conversion" precedent as the cost basis above: the job inherits the numbers
          // the estimate was actually agreed at, then owns them independently from that point on.
          tax_rate: true,
          discount_type: true,
          discount_value: true,
          discount_amount: true,
          lead: {
            select: {
              customer_id: true,
              service_location_id: true,
              service_address_line1: true,
              job_type: true,
              customer: { select: { id: true } },
              lead_assignees: { select: { user_id: true } },
            },
          },
          // SERV10X-38 Task 6b — loaded so the estimate's line items can be copied onto the
          // new job's own JobLineItem rows at conversion (no information loss, Ran's lead→job
          // principle). job_line_items was a new table (Task 3); nothing populated it before.
          line_items: {
            select: {
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              unit_cost: true,
              is_taxable: true,
              line_total: true,
              discount_type: true,
              discount_value: true,
              discount_amount: true,
              item_type: true,
              price_book_item_id: true,
              // #2090 - the conversion carries SELECTED lines only, so it has to be able to see
              // what the customer chose. JobLineItem has neither column; these are read, filtered
              // on, and never written.
              is_optional: true,
              is_selected: true,
            },
            orderBy: { sequence: 'asc' },
          },
        },
      });

      if (!estimate) {
        res.status(404).json({ error: 'Estimate not found' });
        return;
      }

      // Phase B — a row-scoped creator may only create a job from an estimate on a lead they OWN
      // (parent-ownership; the SALES create-estimate precedent). Unconditional creators skip this.
      if (isRowScopedCreator && !(estimate.lead?.lead_assignees?.some((a) => a.user_id === req.user!.id) ?? false)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      if (estimate.status !== ESTIMATE_STATUS.WON) {
        res.status(400).json({ error: 'Estimate must be WON to create a job' });
        return;
      }

      // SERV10X-61 - already ATTACHED to a job that is not its own (mirrors the multi branch's
      // check). Since Task 3, Estimate.job_id is settable at create time, so it is no longer a
      // pure mirror of Job.estimate_id: a JOB-anchored estimate carries job_id with NO Job
      // pointing back, which the idempotency probe below cannot see. Converting it anyway
      // re-pointed the estimate off its anchor job - the anchor job silently lost that
      // estimate's paid deposit credit and its line items got billed a second time. A plain
      // re-conversion (job_id === the provenance job's id) is NOT rejected: it falls through to
      // the idempotent find-or-create, which returns the existing job.
      if (estimate.job_id != null && estimate.job_id !== estimate.job?.id) {
        res.status(400).json({ error: `Estimate ${estimate.estimate_number} is already attached to a job` });
        return;
      }

      // Deposit gate (§5/§6) — keyed to the kind=DEPOSIT Invoice (the SOLE deposit document).
      // Block creation while a configured deposit invoice is still pre-payment (DRAFT/SENT/PARTIAL).
      // PAID or VOIDED(waived) — and post-payment REFUNDED states — pass. No deposit invoice ⇒ no gate.
      const DEPOSIT_OK = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
      const depInv = await prisma.invoice.findFirst({
        where: { estimate_id, kind: 'DEPOSIT', ...tenantWhere(req) },
        select: { id: true, status: true },
      });
      if (depInv && !DEPOSIT_OK.includes(depInv.status)) {
        res.status(400).json({ error: 'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.' });
        return;
      }

      // Resolve the customer anchor-aware (SERV10X-61 Task 7, same as the multi branch): the
      // lead's customer when the estimate hangs off a lead, else the estimate's own customer_id
      // (NOT NULL in schema.prisma) for a lead-less, customer-anchored estimate.
      const customerId = estimate.lead?.customer_id ?? estimate.customer_id;
      if (!customerId) {
        res.status(400).json({ error: 'Estimate has no associated customer' });
        return;
      }

      // #180 fix: when the body supplies an explicit service_location_id, it wins the
      // precedence below and is written verbatim — so validate ownership/existence the SAME
      // way the standalone branch does (job.controller.ts:507-514), BEFORE the transaction.
      // ServiceLocation has no organization_id column; `customer: tenantWhere(req)` is the org
      // guard. The lead-anchor + primary fallbacks below are already customer+org scoped.
      if (service_location_id) {
        const ownedLocation = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id: customerId, customer: tenantWhere(req) },
          select: { id: true },
        });
        if (!ownedLocation) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
      }

      // Resolve the as-executed service location (§4a/§4c): an explicit body override wins,
      // then the lead's anchored service_location_id (Phase 4a), then - for a lead-less estimate
      // - the estimate's OWN denormalized anchor, then the customer's primary location as a
      // fallback for legacy leads lacking an anchored location.
      const primaryLocation = await prisma.serviceLocation.findFirst({
        where: { customer_id: customerId, is_primary: true, customer: tenantWhere(req) },
        select: { id: true },
      });

      const locationId = service_location_id
        || estimate.lead?.service_location_id
        || estimate.service_location_id
        || primaryLocation?.id;
      if (!locationId) {
        res.status(400).json({ error: 'No service location found for customer' });
        return;
      }

      // Idempotent find-or-create (Bug #23): estimate_id is @unique, so an estimate has at most
      // one job. If it already exists, return it (200) instead of failing — the prior behavior
      // 409'd with no job, so the UI saw "a job already exists" but couldn't navigate to it.
      const existingJob = await prisma.job.findFirst({
        where: { estimate_id, ...tenantWhere(req) },
        select: jobDetailSelect,
      });
      if (existingJob) {
        res.status(200).json({ job: await safePresentJob(existingJob) });
        return;
      }

      try {
        const job = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
          const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);

          const j = await tx.job.create({
            data: {
              job_number: jobNumber,
              organization_id: req.user!.organization_id,
              estimate_id,
              // Direct lead provenance (see Job.lead_id). Mirrors estimate.lead_id at
              // conversion so job->lead never has to be re-derived through the estimate.
              lead_id: estimate.lead_id ?? null,
              customer_id: customerId,
              service_location_id: locationId,
              scope_notes: scope_notes || null,
              // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the
              // real write is bookInitialVisitIfScheduled below, in the same transaction.
              estimated_duration: estimated_duration || null,
              job_type: estimate.job_type ?? estimate.lead?.job_type ?? null,
              // E1/E2 (job-owns-tax-discount) - inherit the estimate's tax rate and discount
              // one time, at conversion; see the select comment above.
              tax_rate: estimate.tax_rate,
              discount_type: estimate.discount_type,
              discount_value: estimate.discount_value,
              discount_amount: estimate.discount_amount,
              // SRVW-87 - mirrors the standalone branch's jobExtra: a conversion that lands the
              // job straight on the calendar must not create it as UNSCHEDULED.
              ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
              // R3b (2026-07-21) — copy the estimate's cost basis onto the new job (D18); a job
              // created from scratch (no estimate_id, see the standalone branch above) leaves
              // these null, falling back to the org default via resolveOverhead.
              labor_hours: estimate.labor_hours,
              overhead_mode: estimate.overhead_mode,
              overhead_value: estimate.overhead_value,
              // Audit: the user performing the conversion, never the estimate's own author.
              ...createdByUser(req),
            },
            select: jobDetailSelect,
          });

          // R6 (2026-07-22) — M4: keep Estimate.job_id (the new reverse-lookup mirror) in sync
          // with Job.estimate_id (the pre-existing provenance FK) at the one site that sets the
          // latter, so the denormalized column never starts drifting the moment it ships. This
          // is the only write path for Job.estimate_id today — the standalone branch above never
          // sets it, and this whole block only runs on a BRAND NEW job (the idempotent
          // find-or-create above already returned early otherwise).
          await tx.estimate.update({ where: { id: estimate_id, ...tenantWhere(req) }, data: { job_id: j.id } });

          // SERV10X-38 Task 6b — copy the estimate's line items onto the job's OWN JobLineItem
          // rows so an estimate-backed job's Items tab isn't empty (no information loss). Safe
          // to run unconditionally here: this transaction only runs when `j` is a BRAND NEW job
          // (the idempotent find-or-create above already returned early for an existing job), so
          // there is no existing-lines case to guard against / no risk of duplicating rows.
          //
          // #2090 slice 3d - SELECTED lines only. A declined optional line is work the customer
          // said no to, and JobLineItem carries neither flag, so copying it made it silently and
          // fully billable with nothing left on the job to say otherwise. The estimate keeps it,
          // with its "Declined" caption. The union branch below applies the identical filter.
          const estimateLineItems = (estimate.line_items ?? []).filter(countsTowardTotals);
          if (estimateLineItems.length > 0) {
            // LO-4: estimate→job lines are stamped NOT_TRACKED unconditionally. Logistic Orders
            // now own all stock deduction, so the legacy tracked→UNSYNCED stamp (which fed the
            // retired "Sync with inventory" flow) is gone — no catalog lookup here anymore.
            await tx.jobLineItem.createMany({
              data: estimateLineItems.map((li) => ({
                job_id: j.id,
                organization_id: req.user!.organization_id,
                sequence: li.sequence,
                description: li.description,
                quantity: li.quantity,
                unit_price: li.unit_price,
                unit_cost: li.unit_cost,
                markup_percent: null,
                is_taxable: li.is_taxable,
                line_total: li.line_total,
                discount_type: li.discount_type,
                discount_value: li.discount_value,
                discount_amount: li.discount_amount,
                item_type: li.item_type,
                price_book_item_id: li.price_book_item_id,
                stock_status: 'NOT_TRACKED' as const,
                // stock_location_id stays null (DB default).
              })),
            });
          }

          // Phase B (#232) / S8 (D6): no self-assign row - the creator's access comes from
          // OWN_OR_CREATED_JOB's created_by_id arm, not from a crew row.

          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'JOB',
              entity_id: j.id,
              event_type: 'CREATED',
              description: `Job ${j.job_number} created from estimate ${estimate.estimate_number}`,
              created_by: req.user!.id,
            },
          });

          // The trip this create just said it booked - see bookInitialVisitIfScheduled.
          bookedVisit = await bookInitialVisitIfScheduled(tx, {
            jobId: j.id,
            orgId: req.user!.organization_id,
            scheduledStart: scheduled_start,
            scheduledEnd: scheduled_end,
          });

          return j;
        }), { label: 'job.create.from_estimate' });

        // Communication ↔ Jobs (story 5) — estimate-time transactional emails predate their
        // job (attach-by-origin persists them with customer/lead only, since no job exists
        // yet), so attribution completes here, the moment the job materializes. Scoped tight:
        // system-account rows only (transactional), job_id NULL only (never re-attribute),
        // and only this estimate's lead. Fire-and-forget: a backfill failure must never fail
        // job creation (same contract as the email sends around it).
        if (estimate.lead_id) {
          try {
            await prisma.email.updateMany({
              where: {
                ...tenantWhere(req),
                account: 'system',
                job_id: null,
                lead_id: estimate.lead_id,
              },
              data: { job_id: job.id, job_label: job.job_number },
            });
          } catch (backfillErr) {
            logger.error('Estimate-email job backfill error:', backfillErr);
          }
        }

        // Clear the Dispatcher's pinned "Schedule job" notification now that the job exists.
        // Best-effort, post-commit — never blocks the response. The idempotent early-return
        // branches intentionally skip this (the first conversion already resolved it; a
        // swallowed first-resolve failure is an accepted low-probability stale-pin).
        if (estimate_id) {
          try {
            await resolveScheduleJobNotifications(estimate_id, req.user!.organization_id);
          } catch (notifyErr) {
            // #375: truly best-effort — a post-commit notification failure must not 500 a created job.
            logger.error('Post-commit schedule-notification resolve failed (job WAS created):', notifyErr);
          }
        }

        // Phase B (§E) — a row-scoped creator who lacks read Invoice shouldn't see estimate/invoice
        // pricing on the job they just made; no-op for invoice-capable creators.
        void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
        await dispatchScheduledOnCreate(req, job, bookedVisit);
        res.status(201).json({ job: await safePresentJob(job) });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') {
          // Race fallback (Bug #23): a concurrent create won the @unique estimate_id. Re-query
          // and return the now-existing job (200) rather than a dead-end 409.
          const racedJob = await prisma.job.findFirst({
            where: { estimate_id, ...tenantWhere(req) },
            select: jobDetailSelect,
          });
          if (racedJob) {
            res.status(200).json({ job: await safePresentJob(racedJob) });
            return;
          }
        }
        throw err;
      }
    } else {
      // ── SERV10X-61 Task 9 (MONEY PATH) - LENGTH > 1: multiple WON estimates → ONE job ─────────
      // ALL selected estimates are ATTACHED to the new job (Estimate.job_id - the R6 EstimateJobLink
      // 1:N relation) and their line items feed the job's item list. Job.estimate_id (the 1:1
      // JobPrimaryEstimate provenance FK) is left NULL for multi - it is set ONLY when exactly one
      // estimate is selected (the single-estimate branch above). This branch only runs at length > 1.
      const estimates = await prisma.estimate.findMany({
        where: { id: { in: estimateIds }, ...tenantWhere(req) },
        select: {
          id: true,
          status: true,
          estimate_number: true,
          lead_id: true,
          // Anchor-aware customer/location resolution (Task 7): the lead's anchors when the
          // estimate hangs off a lead, else the estimate's own denormalized columns.
          customer_id: true,
          service_location_id: true,
          // Task 10b / E1 (job-owns-tax-discount): every estimate on one job must share ONE tax
          // rate - the new job stamps ITS OWN tax_rate from this set (validated below), so an
          // ambiguous set would silently pick one estimate's rate over another's.
          tax_rate: true,
          // job_id = attachment (EstimateJobLink); job = provenance reverse (JobPrimaryEstimate).
          // Both are read so an already-attached OR already-converted estimate is rejected (no
          // idempotent find-or-create for multi, unlike the single branch).
          job_id: true,
          job: { select: { id: true } },
          job_type: true,
          labor_hours: true,
          overhead_mode: true,
          overhead_value: true,
          // Union ordering: estimate created_at asc, then line sequence asc.
          created_at: true,
          lead: {
            select: {
              customer_id: true,
              service_location_id: true,
              service_address_line1: true,
              job_type: true,
              customer: { select: { id: true } },
              lead_assignees: { select: { user_id: true } },
            },
          },
          line_items: {
            select: {
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              unit_cost: true,
              is_taxable: true,
              line_total: true,
              discount_type: true,
              discount_value: true,
              discount_amount: true,
              item_type: true,
              price_book_item_id: true,
              // #2090 - the conversion carries SELECTED lines only, so it has to be able to see
              // what the customer chose. JobLineItem has neither column; these are read, filtered
              // on, and never written.
              is_optional: true,
              is_selected: true,
            },
            orderBy: { sequence: 'asc' },
          },
        },
        orderBy: { created_at: 'asc' },
      });

      // 1. All found - a missing/cross-org id shortens the list.
      if (estimates.length !== estimateIds.length) {
        res.status(404).json({ error: 'One or more estimates not found' });
        return;
      }

      // 2. Row-scope (Phase B) - a row-scoped creator may only convert estimates on leads they OWN,
      //    and here that must hold for EVERY selected estimate (generalizes the single branch's gate).
      if (isRowScopedCreator && !estimates.every((e) => e.lead?.lead_assignees?.some((a) => a.user_id === req.user!.id) ?? false)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      // 3. All WON.
      if (!estimates.every((e) => e.status === ESTIMATE_STATUS.WON)) {
        res.status(400).json({ error: 'All estimates must be WON to create a job' });
        return;
      }

      // 4. Same lead (from-lead flow) - every selected estimate must share ONE lead_id. A null
      //    lead_id is a valid Set member (no crash); a genuinely lead-less estimate is a length-1
      //    concern handled by the single branch above.
      if (new Set(estimates.map((e) => e.lead_id)).size > 1) {
        res.status(400).json({ error: 'All estimates must belong to the same lead' });
        return;
      }

      // 5. Unattached + unconverted - reject if ANY estimate is already attached (job_id) or already
      //    converted (job). No idempotent return for multi.
      const alreadyLinked = estimates.find((e) => e.job_id != null || e.job != null);
      if (alreadyLinked) {
        res.status(400).json({ error: `Estimate ${alreadyLinked.estimate_number} is already attached to a job` });
        return;
      }

      // 6. Deposit gate (per estimate) - block while ANY configured kind=DEPOSIT invoice is still
      //    pre-payment. PAID/VOIDED(waived) + refunded states pass; an estimate with no deposit
      //    invoice passes. Same block message as the single branch.
      const DEPOSIT_OK = ['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
      const depositInvoices = await prisma.invoice.findMany({
        where: { estimate_id: { in: estimateIds }, kind: 'DEPOSIT', ...tenantWhere(req) },
        select: { estimate_id: true, status: true },
      });
      if (depositInvoices.some((inv) => !DEPOSIT_OK.includes(inv.status))) {
        res.status(400).json({ error: 'Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first.' });
        return;
      }

      // ── Customer (anchor-aware) - all selected estimates must resolve the SAME customer. ──
      const customerId = estimates[0].lead?.customer_id ?? estimates[0].customer_id;
      if (!customerId) {
        res.status(400).json({ error: 'Estimate has no associated customer' });
        return;
      }
      if (!estimates.every((e) => (e.lead?.customer_id ?? e.customer_id) === customerId)) {
        res.status(400).json({ error: 'All estimates must belong to the same customer' });
        return;
      }

      // ── Same tax rate. Task 10b's createInvoiceFromJob picks ONE of the job's estimates as the
      //    invoice's tax source, which is only sound if they all agree - this is the only site
      //    that can put several estimates on one job, so enforce it here. tax_rate is a Prisma
      //    Decimal (object identity, never ===), so compare by numeric value. ──
      const taxRate = Number(estimates[0].tax_rate);
      if (!estimates.every((e) => Number(e.tax_rate) === taxRate)) {
        res.status(400).json({ error: 'All estimates must have the same tax rate' });
        return;
      }

      // ── Location precedence: body override (validate ownership, same shape as the single branch) →
      //    lead anchor → customer primary. ──
      if (service_location_id) {
        const ownedLocation = await prisma.serviceLocation.findFirst({
          where: { id: service_location_id, customer_id: customerId, customer: tenantWhere(req) },
          select: { id: true },
        });
        if (!ownedLocation) {
          res.status(404).json({ error: 'Service location not found or does not belong to customer' });
          return;
        }
      }
      const primaryLocation = await prisma.serviceLocation.findFirst({
        where: { customer_id: customerId, is_primary: true, customer: tenantWhere(req) },
        select: { id: true },
      });
      const locationId = service_location_id
        || estimates[0].lead?.service_location_id
        || estimates[0].service_location_id
        || primaryLocation?.id;
      if (!locationId) {
        res.status(400).json({ error: 'No service location found for customer' });
        return;
      }

      const job = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
        const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);

        const j = await tx.job.create({
          data: {
            job_number: jobNumber,
            organization_id: req.user!.organization_id,
            // Provenance (1:1) is set ONLY for a single-estimate conversion; NULL for multi.
            estimate_id: estimateIds.length === 1 ? estimateIds[0] : null,
            // Direct lead provenance (see Job.lead_id). Unambiguous here: check #4 above
            // already rejected a selection whose estimates span more than one lead, so
            // estimates[0].lead_id IS the whole set's lead. This is the case estimate_id
            // cannot express — a multi-estimate job has no provenance FK at all.
            lead_id: estimates[0].lead_id ?? null,
            customer_id: customerId,
            service_location_id: locationId,
            scope_notes: scope_notes || null,
            // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the
            // real write is bookInitialVisitIfScheduled below, in the same transaction.
            estimated_duration: estimated_duration || null,
            job_type: estimates[0].job_type ?? estimates[0].lead?.job_type ?? null,
            // SRVW-87 - mirrors the standalone branch's jobExtra: a conversion that lands the
            // job straight on the calendar must not create it as UNSCHEDULED.
            ...(scheduled_start ? { status: 'SCHEDULED' as const } : {}),
            // Cost basis (D18) - a multi-estimate job has no single labor/overhead source of truth
            // (estimates may disagree), so leave all three NULL: resolveOverhead falls back to the
            // org default. Only a single-estimate conversion copies the estimate's basis (above).
            labor_hours: null,
            overhead_mode: null,
            overhead_value: null,
            // E1 (job-owns-tax-discount) - the set's single shared rate, already validated above.
            tax_rate: taxRate,
            // E2 - no single-discount invariant is enforced across the set (unlike tax_rate), so
            // this mirrors the cost-basis NULL treatment just above rather than guessing which
            // estimate's discount wins.
            discount_type: null,
            discount_value: null,
            discount_amount: 0,
            // Audit: the user performing the conversion, never any estimate's own author.
            ...createdByUser(req),
          },
          select: jobDetailSelect,
        });

        // Attach ALL selected estimates to the new job (Estimate.job_id / EstimateJobLink 1:N) -
        // generalizes the single branch's `estimate.update` to the whole set. The write is
        // CONDITIONAL on job_id still being null: the pre-flight "unattached" check above is
        // check-then-act and Estimate.job_id is deliberately not @unique (schema.prisma), so two
        // concurrent POSTs can both pass it and each end up with a job carrying the full union of
        // line items - one of them orphaned, drawing zero deposit credit. A short count means we
        // lost that race; throwing here rolls the whole job back.
        const attached = await tx.estimate.updateMany({
          where: { id: { in: estimateIds }, ...tenantWhere(req), job_id: null },
          data: { job_id: j.id },
        });
        if (attached.count !== estimateIds.length) {
          throw new EstimateAttachRaceError();
        }

        // Line union - estimates already come back ordered by created_at asc, each with its lines
        // ordered by sequence asc, so flatMap preserves (estimate, line) order. Re-sequence 1..N
        // CONTINUOUSLY across the whole union; per-line field mapping is identical to the single
        // branch (incl. stock_status NOT_TRACKED).
        //
        // #2090 slice 3d - the union's half of the same rule. The filter runs BEFORE the
        // continuous 1..N re-sequence below, so a declined add-on leaves no hole in the job's
        // sequence numbers.
        const unionLines = estimates.flatMap((e) => (e.line_items ?? []).filter(countsTowardTotals));
        if (unionLines.length > 0) {
          await tx.jobLineItem.createMany({
            data: unionLines.map((li, idx) => ({
              job_id: j.id,
              organization_id: req.user!.organization_id,
              sequence: idx + 1,
              description: li.description,
              quantity: li.quantity,
              unit_price: li.unit_price,
              unit_cost: li.unit_cost,
              markup_percent: null,
              is_taxable: li.is_taxable,
              line_total: li.line_total,
              discount_type: li.discount_type,
              discount_value: li.discount_value,
              discount_amount: li.discount_amount,
              item_type: li.item_type,
              price_book_item_id: li.price_book_item_id,
              stock_status: 'NOT_TRACKED' as const,
            })),
          });
        }

        // Phase B (#232) / S8 (D6): no self-assign row - the creator's access comes from
        // OWN_OR_CREATED_JOB's created_by_id arm, not from a crew row.

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: j.id,
            event_type: 'CREATED',
            description: `Job ${j.job_number} created from estimate(s) ${estimates.map((e) => e.estimate_number).join(', ')}`,
            created_by: req.user!.id,
          },
        });

        // The trip this create just said it booked - see bookInitialVisitIfScheduled.
        bookedVisit = await bookInitialVisitIfScheduled(tx, {
          jobId: j.id,
          orgId: req.user!.organization_id,
          scheduledStart: scheduled_start,
          scheduledEnd: scheduled_end,
        });

        return j;
      }), { label: 'job.create.from_estimates' });

      // Post-commit (best-effort, never fails a committed job) - estimate-email backfill keys on the
      // shared lead; schedule-notification resolve loops per selected estimate. Same fire-and-forget
      // contract as the single branch.
      const backfillLeadId = estimates[0].lead_id;
      if (backfillLeadId) {
        try {
          await prisma.email.updateMany({
            where: { ...tenantWhere(req), account: 'system', job_id: null, lead_id: backfillLeadId },
            data: { job_id: job.id, job_label: job.job_number },
          });
        } catch (backfillErr) {
          logger.error('Estimate-email job backfill error:', backfillErr);
        }
      }
      for (const eid of estimateIds) {
        try {
          await resolveScheduleJobNotifications(eid, req.user!.organization_id);
        } catch (notifyErr) {
          logger.error('Post-commit schedule-notification resolve failed (job WAS created):', notifyErr);
        }
      }

      void logAudit({ req, action: 'job.created', resourceType: 'Job', resourceId: job.id, metadata: { job_number: job.job_number } });
      await dispatchScheduledOnCreate(req, job, bookedVisit);
      res.status(201).json({ job: await safePresentJob(job) });
    }
  } catch (err) {
    if (err instanceof EstimateAttachRaceError) {
      // Lost the attach race - nothing was committed. A conflict the caller can retry after a
      // refresh, not a server fault.
      res.status(409).json({ error: 'One or more estimates were attached to another job while this job was being created. Refresh and try again.' });
      return;
    }
    logger.error('Create job error:', err);
    res.status(500).json({ error: 'Failed to create job' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Existence (+ tenant) probe → 404 a missing/cross-org id.
    const accessCheck = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!accessCheck) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (one scoped findFirst),
    // NOT the role-literal canAccessJob which hardcoded ADMIN||DISPATCHER → true and ignored a
    // narrowed read-Job grant or a per-user DENY. Mirrors update/remove. ADMIN/unconditional-read
    // → no query (visible); a conditional read grant → the row must match the owner condition.
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const job = await prisma.job.findUnique({ where: { id }, select: jobDetailSelect });

    // Phase B (§E) — strip estimate pricing for non-invoice readers BEFORE deriving remaining_unbilled
    // (so the derived figure also resolves to null once total_amount is gone). Same pipeline reused
    // by every action handler below via presentJobDetail.
    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Get job error:', err);
    res.status(500).json({ error: 'Failed to get job' });
  }
}

/**
 * D13 (Spec A) — pricing strip for GET /api/jobs/:id/financials.
 *
 * The route is gated `read Job` only, and JobDetailPage fetches it on mount, so admitting a
 * technician to the main app without this hands them the job's full money picture. Strips the
 * KEYS rather than nulling them, matching stripJobPricingForRequester's convention.
 *
 * DELIBERATELY NOT a 403: the lifecycle bar reads final_invoice.sent_at / paid_at from this
 * payload (Spec B2's Invoice Sent and Payment Received nodes), so a price-blind requester must
 * still get a well-formed answer — one without money in it. Line description and quantity also
 * survive: a technician needs to know WHAT is on the job, just not what it costs.
 *
 * Exported for unit test only.
 */
export function stripFinancialsForRequester<T extends Record<string, unknown>>(payload: T, req: Request): T {
  if (canSeePricing(req)) return payload;

  const finalInvoice = payload.final_invoice as Record<string, unknown> | null | undefined;
  const invoices = payload.invoices as Array<Record<string, unknown>> | undefined;

  return {
    ...payload,
    final_invoice: finalInvoice
      ? (({ total_amount: _t, amount_due: _d, ...rest }) => rest)(finalInvoice)
      : finalInvoice,
    invoices: (invoices ?? []).map(
      ({
        total_amount: _t, amount_due: _d, tip: _tip, tax_rate: _tr, tax_amount: _ta,
        discount_amount: _da, subtotal: _s, line_items, ...invRest
      }) => ({
        ...invRest,
        line_items: ((line_items as Array<Record<string, unknown>>) ?? []).map(
          ({
            unit_price: _u, line_total: _l, discount_type: _dt,
            discount_value: _dv, discount_amount: _lda, ...liRest
          }) => liRest,
        ),
      }),
    ),
    // Every field on a payment is about money. Return an empty array rather than omitting the
    // key so existing consumers keep mapping over an array.
    payments: [],
    // Money. `first_sent_at` is a date, not an amount, and the lifecycle bar needs it — it stays.
    total_invoiced: undefined,
    total_paid: undefined,
  } as unknown as T;
}

export async function getFinancials(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Only estimate_id is read below; ownership is gated by canAccessRow (its own scoped query),
    // so the assignee / lead-assignee relations the old canAccessJob needed are no longer fetched.
    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // SRVW-96 - linked_estimates (the R6 EstimateJobLink back-relation) is the set
      // createInvoiceFromJob is already capable of drawing a deposit credit from
      // (job.controller.ts depositEstimateIds); surface those DEPOSIT invoices here too so the
      // credit is visible on the job before it is spent.
      select: { estimate_id: true, linked_estimates: { select: { id: true } } },
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (replaces the old
    // role-literal canAccessJob, which hardcoded ADMIN||DISPATCHER → true and ignored grants).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const orClauses: Prisma.InvoiceWhereInput[] = [{ job_id: id }];
    if (job.estimate_id) orClauses.push({ estimate_id: job.estimate_id });
    // `?? []` defends a shape mismatch (a stale mock, a future select drift) into today's
    // behaviour instead of a 500 on every GET /api/jobs/:id/financials - it does not mask a
    // forgotten select, which the dedicated select assertion above catches directly.
    //
    // NOT scoped to kind DEPOSIT. SRVW-96 added this clause DEPOSIT-only, which left the two link
    // directions asymmetric: the legacy provenance pointer (`{ estimate_id: job.estimate_id }`
    // above) admits every kind, while the R6 EstimateJobLink admitted only deposits. A job linked
    // ONLY via Estimate.job_id - which is exactly what the estimate-anchored conversion writes,
    // leaving jobs.estimate_id null - therefore could never resolve a `final_invoice` (derived
    // from kind STANDARD below), so its Invoice card rendered "No invoice yet" and its Balance
    // card stayed empty even with a paid deposit visible in the same tab. Widening it does move
    // total_invoiced/total_paid/first_sent_at once such a job is invoiced; that is the point, and
    // it is the same figure the provenance path has always reported for the identical shape.
    // Double-counting a drawn-down deposit stays guarded by total_paid's back-derivation from
    // total_amount - amount_due rather than from summing Payment rows.
    const linkedEstimateIds = (job.linked_estimates ?? []).map((e) => e.id).filter((eid) => eid !== job.estimate_id);
    if (linkedEstimateIds.length) orClauses.push({ estimate_id: { in: linkedEstimateIds } });

    const invoices = await prisma.invoice.findMany({
      where: { ...tenantWhere(req), OR: orClauses },
      select: {
        id: true, invoice_number: true, kind: true, status: true,
        total_amount: true, amount_due: true, sent_at: true, paid_at: true, voided_at: true,
        tip: true, tax_rate: true, tax_amount: true, discount_amount: true, subtotal: true,
        line_items: {
          select: {
            id: true, sequence: true, description: true, quantity: true,
            unit_price: true, is_taxable: true, line_total: true,
            discount_type: true, discount_value: true, discount_amount: true,
            item_type: true, price_book_item_id: true,
            // Photo for the Items-tab editor — from the linked catalog item (null for custom lines).
            price_book_item: { select: { image_url: true, photo_url: true } },
          },
          orderBy: { sequence: 'asc' as const },
        },
        payments: {
          where: { voided_at: null },
          select: {
            id: true, amount: true, method: true, paid_at: true, voided_at: true, reference_number: true,
            // Task 3.4 (spec §7.3) — per-payment fee breakdown for the job PaymentsTab; null
            // until Stripe reconciliation lands (Task 3.3) or for non-CARD payments.
            stripe_fee_amount: true, platform_fee_amount: true, net_amount: true,
            // net_amount is measured against face + service fee + tip (reconcile-stripe-fees.ts
            // reads Stripe's charge.amount) while `amount` is face only, so the breakdown needs
            // both additive terms or it renders a Net larger than its own Gross.
            service_fee_amount: true, tip_amount: true,
          },
          orderBy: { paid_at: 'asc' as const },
        },
        // SRVW-84 - total_paid below back-derives cash from total_amount - amount_due, so it needs
        // the credit notes to net out. Rides this query's existing tenantWhere(req) scope.
        credits: { select: { amount: true } },
      },
      orderBy: { created_at: 'asc' as const },
    });

    const finalInvoice = [...invoices]
      .filter((i) => i.kind === 'STANDARD' && !i.voided_at)
      .sort((a, b) => (a.invoice_number < b.invoice_number ? 1 : -1))[0] ?? null;

    // Multi-draw aggregates (Spec B2). The bar summarises the JOB, not the latest invoice.
    // `final_invoice` stays in the payload — PaymentsTab and the invoice links use it.
    //
    // `invoices` (via `orClauses` above) can include BOTH the job's STANDARD draws AND, when the
    // job came from an estimate, that estimate's kind=DEPOSIT invoice. A paid deposit's credit is
    // applied to a STANDARD invoice as a SEPARATE, real Payment row (tagged DEPOSIT-CREDIT) while
    // the deposit invoice keeps its own original Payment — the same money is then backed by two
    // live Payment rows. Summing raw `payments` across the whole set (deposit + STANDARD) would
    // double-count it, so `first_sent_at`/`total_paid` are scoped to STANDARD invoices only
    // (matching `total_invoiced`'s existing scope), and `total_paid` is derived from each
    // STANDARD invoice's own `total_amount - amount_due` (which already nets out cash payments
    // AND deposit credit, exactly once) rather than from summing Payment rows across the set.
    //
    // SRVW-84 - a credit note lowers `amount_due` without any cash being collected, so it is
    // subtracted here too; otherwise a write-off reports as money received. The per-invoice
    // Math.max is a SECOND, distinct correction: this line carried no clamp at all, so an invoice
    // with amount_due > total_amount contributed a negative figure that offset a sibling invoice's
    // real cash (0 such rows on staging today, so it is inert).
    const live = invoices.filter((i) => !i.voided_at);
    const standardLive = live.filter((i) => i.kind === 'STANDARD');
    const sentDates = standardLive.map((i) => i.sent_at).filter((d): d is Date => d != null);
    const firstSentAt = sentDates.length ? sentDates.reduce((a, b) => (a < b ? a : b)) : null;
    const totalInvoiced = Math.round(
      standardLive.reduce((s, i) => s + Number(i.total_amount), 0) * 100,
    ) / 100;
    const totalPaid = Math.round(
      standardLive.reduce(
        (s, i) => s + amountPaidOf(Number(i.total_amount), 0, Number(i.amount_due), creditsTotalOf(i.credits)),
        0,
      ) * 100,
    ) / 100;

    const payments = invoices.flatMap((inv) =>
      inv.payments.map((p) => ({
        id: p.id, invoice_id: inv.id, invoice_number: inv.invoice_number, invoice_kind: inv.kind,
        amount: p.amount, method: p.method, paid_at: p.paid_at, voided_at: p.voided_at, reference_number: p.reference_number,
        // Task 3.4 — carry the reconciled fee breakdown through (null for cash/check/legacy or
        // not-yet-reconciled CARD payments; PaymentsTab renders nothing in that case).
        stripe_fee_amount: p.stripe_fee_amount, platform_fee_amount: p.platform_fee_amount, net_amount: p.net_amount,
        service_fee_amount: p.service_fee_amount, tip_amount: p.tip_amount,
      })),
    );

    res.json(stripFinancialsForRequester({
      final_invoice: finalInvoice && {
        id: finalInvoice.id, invoice_number: finalInvoice.invoice_number, status: finalInvoice.status,
        total_amount: finalInvoice.total_amount, amount_due: finalInvoice.amount_due,
        sent_at: finalInvoice.sent_at, paid_at: finalInvoice.paid_at,
      },
      // `credits` is dropped alongside payments/voided_at: it is an input to total_paid above,
      // not a payload field. stripFinancialsForRequester removes money from invoices[] by NAME,
      // so leaving it in would leak credit amounts to a price-blind requester (SRVW-84).
      invoices: invoices.map(({ payments, voided_at, credits, ...rest }) => rest),
      payments,
      first_sent_at: firstSentAt,
      total_invoiced: totalInvoiced,
      total_paid: totalPaid,
    }, req));
  } catch (err) {
    logger.error('Get job financials error:', err);
    res.status(500).json({ error: 'Failed to get job financials' });
  }
}

/**
 * D14 (Spec A) — does this PATCH body actually move the job on the calendar?
 *
 * `update Job` became a TECHNICIAN role default in D3, and updateJobSchema accepts the schedule
 * fields, so without this the OFF-by-default `reschedule` toggle could never bite. Compares
 * VALUES rather than key presence: a client that round-trips the whole job object sends
 * scheduled_start unchanged, and that is not a reschedule.
 *
 * `existing` is now the CURRENT WINDOW as `resolveJobScheduleWindow` projects it (S8, A5,
 * RATIFIED) - `scheduled_start`/`scheduled_end`/`is_all_day` are no longer stored columns, so the
 * caller passes the computed projection here rather than a raw DB row. `is_all_day: boolean |
 * null` (widened from a plain `boolean`) is the zero-visit case; the `!==` comparison below is
 * correct unchanged for it (`true !== null` and `false !== null` both correctly read as "changed").
 *
 * Exported for unit test only.
 */
export function changesSchedule(
  body: Record<string, unknown>,
  existing: { scheduled_start: Date | null; scheduled_end: Date | null; is_all_day: boolean | null },
): boolean {
  const sameInstant = (a: unknown, b: Date | null) => {
    if (a === undefined) return true;              // absent → not a change
    if (a === null || b === null) return a === null && b === null;
    return new Date(a as string).getTime() === b.getTime();
  };
  if (!sameInstant(body.scheduled_start, existing.scheduled_start)) return true;
  if (!sameInstant(body.scheduled_end, existing.scheduled_end)) return true;
  if (body.is_all_day !== undefined && body.is_all_day !== existing.is_all_day) return true;
  return false;
}

/**
 * SRVW-87 - the status a PATCH-reschedule writes, or `undefined` for "leave the status alone"
 * (Prisma treats an undefined data key as a no-op, so a non-schedule PATCH writes no status).
 *
 * This deliberately does NOT reuse assign()'s `status: scheduled_start ? 'SCHEDULED' :
 * existing.status`. That derivation is paired there with `milestoneClears('scheduled')` and a
 * post-commit `revertPlanVisitOnUncomplete`, so copying it here would mean that correcting a typo
 * in a COMPLETED job's date silently demotes the job, nulls completed_at/on_site_at/started_at,
 * and flips the linked PlanVisit back to SCHEDULED. COMPLETED feeds the dashboard's
 * completed-this-month KPI, so that is a reporting corruption, not a cosmetic one.
 *
 * PATCH is the EDIT door, not the scheduler: it moves a job only between the two states that are
 * defined purely by whether a time exists, and never touches EN_ROUTE / ON_SITE / IN_PROGRESS /
 * COMPLETED / CANCELLED. A caller who genuinely wants the milestone rewind uses POST /:id/assign.
 *
 * The demote branch fires regardless of crew, mirroring unassign(), which drops to UNSCHEDULED and
 * KEEPS the crew: the codebase's stated invariant is that status derives from TIME, not crew, and
 * leaving a timeless job SCHEDULED would reproduce the badge-vs-lifecycle-bar disagreement in the
 * opposite direction.
 *
 * Exported for unit test only.
 */
export function deriveStatusOnReschedule(
  current: JobStatus,
  startTouched: boolean,
  nextStart: Date | null,
): JobStatus | undefined {
  if (!startTouched) return undefined;
  if (nextStart && current === 'UNSCHEDULED') return 'SCHEDULED';
  if (!nextStart && current === 'SCHEDULED') return 'UNSCHEDULED';
  return undefined;
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.job.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, customer_id: true, source_plan_id: true,
        service_location: { select: { state: true } },
        // #106 ownership relations the role's grant condition references (OWN_JOB /
        // OWN_JOB_VIA_ESTIMATE) — required for the per-instance can() to bind.
        // S8 (A5, RATIFIED): also the source of the CURRENT schedule changesSchedule/timeMoved
        // compare the PATCH body against - scheduled_start/scheduled_end/is_all_day are no longer
        // stored columns, so resolveJobScheduleWindow(existing.visits) replaces the flat select
        // below.
        visits: {
          select: {
            status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
            assignees: { select: { user_id: true } },
          },
        },
        estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } },
        // E1/E2 (job-owns-tax-discount) - customer.tax_exempt clamps an incoming tax_rate;
        // job_line_items/scopes give the CURRENT subtotal a discount edit resolves against;
        // discount_type is read as the pre-edit fallback when only discount_value is sent.
        customer: { select: { tax_exempt: true } },
        job_line_items: { select: { quantity: true, unit_price: true, is_taxable: true } },
        scopes: true,
        discount_type: true,
        discount_value: true,
        // SRVW-114 slice 1 - the pre-edit bag a custom_fields patch merges onto.
        custom_fields: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // S8 (A5, RATIFIED): the CURRENT window, computed off the visit set - the flat
    // scheduled_start/scheduled_end/is_all_day columns this used to read are dropped. Every
    // `existing.scheduled_start`-shaped reference below now reads off this instead.
    const currentWindow = resolveJobScheduleWindow(existing.visits);

    // #106 — base update must do a PER-INSTANCE owner check, not rely on the subject-level
    // route guard (a conditional `update Job` grant passes the guard for ANY job). 403 a job
    // the requester does not own under their grant condition. Uses the SQL-based canAccessRow
    // (one scoped findFirst) rather than the in-memory CASL matcher: a NESTED Team/Location
    // grant (assignees.some.user.department_id) makes `can()` THROW → 500; the where-fragment
    // compiles to SQL and is nested-safe.
    if (!(await canAccessRow(req, 'Job', prisma.job, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // D14 — rescheduling is a distinct capability from editing a job. A technician holds
    // `update Job` by role default (D3) but `reschedule Job` only if an admin granted the
    // per-user toggle. ADMIN/DISPATCHER pass on their unconditional grant.
    if (
      changesSchedule(req.body as Record<string, unknown>, currentWindow) &&
      !req.ability?.can('reschedule', 'Job')
    ) {
      res.status(403).json({ error: 'You do not have permission to reschedule this job' });
      return;
    }

    // Technician-ownership spec, Part C - the job's money fields ride the SAME PATCH as harmless
    // ones like scope_notes, so `manage_lines Job` cannot be enforced at the route the way it is
    // for the line-item and scope routes. Field-level check here, same shape as D14 above.
    //
    // Deliberately PRESENCE-based, not value-based like changesSchedule: a caller sending a
    // discount at all is asserting authority over the money, and a "same value" carve-out would
    // let a round-tripping client re-assert a discount it may not set. Cheap, and the failure
    // direction is refusal rather than a silent write.
    //
    // PER-INSTANCE, not `req.ability.can('manage_lines','Job')`. A bare ability check is
    // subject-level: it answers "could you ever", which is TRUE for every technician now that the
    // role holds a creator-conditioned `manage_lines Job`. canActOnRow asks the row.
    //
    // The list is DERIVED from updateJobSchema by exclusion (see MANAGE_LINES_FIELDS above) rather
    // than hand-written. A hand-written list is what failed review: `labor_hours`, `overhead_mode`
    // and `overhead_value` - the job COST MODEL, the margin side of the very surface the spec says
    // follows creation - were omitted, and their only other guard was canSeePricing, which had been
    // fail-closed for technicians purely because the role held no `read Pricing`. This PR grants it,
    // so an assigned non-creator could have set the job's labour and overhead.
    const body = req.body as Record<string, unknown>;
    if (
      MANAGE_LINES_FIELDS.some((field) => body[field] !== undefined) &&
      !(await canActOnRow(req, 'Job', prisma.job, existing.id, 'manage_lines'))
    ) {
      res.status(403).json({ error: 'You do not have permission to edit this job\'s pricing' });
      return;
    }

    // customer_id is intentionally NOT in updateJobSchema — re-pointing the customer is a
    // cancel + create, not an edit. address/service_location_id drive the §10 location re-point.
    const { scope_notes, job_type, service_location_id, address, estimated_duration, scheduled_start, scheduled_end, labor_hours, overhead_mode, overhead_value, tax_rate, discount_type, discount_value, force, custom_fields } = req.body;

    // SRVW-114 slice 1 - validate BEFORE merging/writing anything: an unknown/cross-org/archived
    // definition id or a value that doesn't match its definition's type 400s here rather than
    // landing in the job's custom_fields bag.
    let nextCustomFields: Record<string, unknown> | undefined;
    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'JOB', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      nextCustomFields = mergeCustomFields(existing.custom_fields as Record<string, unknown> | null, custom_fields);
    }

    // Spec B1 (free status transitions) — no status-ordering gate here. A job in any status
    // stays editable; the reschedule guard above and the cost-field guard below are the real
    // (ability-based) authorization checks, not the job's current status.

    // R3b (2026-07-21) — labor_hours/overhead_mode/overhead_value are staff-only cost-model
    // inputs (D2/D8). A requester who can't see pricing (canSeePricing gates read Invoice) must
    // not be able to blindly set them either — mirrors the read-side strip in
    // stripJobPricingForRequester and Estimate's identical guard in estimate.controller.ts.
    // E1/E2 (job-owns-tax-discount) - tax_rate/discount_* are money edits too, same gate.
    if (
      (labor_hours !== undefined || overhead_mode !== undefined || overhead_value !== undefined
        || tax_rate !== undefined || discount_type !== undefined || discount_value !== undefined)
      && !canSeePricing(req)
    ) {
      res.status(403).json({ error: 'Insufficient permissions to edit cost fields' });
      return;
    }

    // E1 (job-owns-tax-discount) - SRVW-82's exemption clamp, mirroring estimate.controller.ts:
    // a tax-exempt customer owes no sales tax, so the exemption is applied to the RATE, not just
    // the computed amount.
    const requestedTaxRate = tax_rate !== undefined
      ? (existing.customer?.tax_exempt ? 0 : tax_rate)
      : undefined;

    // E2 - discount_amount is ALWAYS server-resolved, never trusted from the client (the schema
    // doesn't even accept it). Resolved as a RATE against the job's CURRENT subtotal at the
    // moment of this edit, then frozen (billingFor reads it back as-is) - the whole point being
    // that it must not silently drift as the item set changes AFTER this PATCH (see the
    // migration's rationale). Only recomputed when the discount is actually touched.
    let discountUpdate: { discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null; discount_value: number | null; discount_amount: number } | undefined;
    if (discount_type !== undefined || discount_value !== undefined) {
      const effectiveDiscountType = discount_type !== undefined ? discount_type : existing.discount_type;
      const effectiveDiscountValue = discount_value !== undefined
        ? discount_value
        : (existing.discount_value != null ? Number(existing.discount_value) : null);
      const totals = recomputeInvoiceTotals({
        lines: (existing.job_line_items ?? []).map((l) => ({
          quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable,
        })),
        scopes: toScopeForTotals(asScopeArray(existing.scopes)),
        taxRate: 0,
        taxExempt: false,
        discountType: effectiveDiscountType,
        discountValue: effectiveDiscountValue,
      });
      discountUpdate = {
        discount_type: effectiveDiscountType ?? null,
        discount_value: effectiveDiscountValue,
        discount_amount: totals.discount_amount,
      };
    }

    // SRVW-87 - resolve the window this PATCH LANDS ON (body value where the key is present,
    // current row value where it is absent), then run the same crew-conflict detection assign()
    // runs. Before this, a PATCH-reschedule was the one door that could silently double-book a
    // crew. Three deliberate details, so none of them gets "fixed" later by mistake:
    //  (i)   the gate is `timeMoved` - the resolved window actually moving - NOT changesSchedule.
    //        changesSchedule is also true for an is_all_day-only body, and that must not newly
    //        409 a job that already overlapped something at a window nobody is changing.
    //  (ii)  `existing.assignees ?? []` is defensive on purpose: the select above always asks for
    //        assignees, but several test fixtures build the row without the key, and today only
    //        the timeMoved gate keeps that undefined from being dereferenced.
    //  (iii) a start with a null end skips detection. That is reachable, because updateJobSchema
    //        deliberately has no start/end pairing refine (see the schema comment).
    const startTouched = scheduled_start !== undefined;
    const nextStart = startTouched ? (scheduled_start ? new Date(scheduled_start) : null) : currentWindow.scheduled_start;
    const nextEnd = scheduled_end !== undefined ? (scheduled_end ? new Date(scheduled_end) : null) : currentWindow.scheduled_end;
    const timeMoved =
      (nextStart?.getTime() ?? null) !== (currentWindow.scheduled_start?.getTime() ?? null)
      || (nextEnd?.getTime() ?? null) !== (currentWindow.scheduled_end?.getTime() ?? null);
    // SRVW-112 - hoisted out of the data object below so the status write and the sub-status
    // clear read ONE value. Still `undefined` on a non-schedule PATCH, which Prisma no-ops.
    const derivedStatus = deriveStatusOnReschedule(existing.status, startTouched, nextStart);

    if (timeMoved && !force && nextStart && nextEnd) {
      const conflicts = await detectCrewConflicts(req, {
        jobId: existing.id,
        userIds: jobCrewIds(existing),
        schedStart: nextStart,
        schedEnd: nextEnd,
      });
      if (conflicts.length > 0) {
        // Byte-stable with assign()'s 409 - the FE retry path reads this exact shape.
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    const wantsLocationChange = Boolean(service_location_id) || Boolean(address);
    let taxWarning: ReturnType<typeof buildLocationTaxWarning> = null;

    try {
      const job = await prisma.$transaction(async (tx) => {
        let resolvedLocationId: string | undefined = undefined;

        if (wantsLocationChange) {
          // Pick-existing or accrete the location on THIS job's customer (forward-only —
          // the lead is never touched; lead = as-sold, job = as-executed).
          const resolved = await resolveOrAccreteLocation(tx, {
            customerId: existing.customer_id,
            orgId: req.user!.organization_id,
            service_location_id: service_location_id ?? null,
            address: address ?? null,
          });
          resolvedLocationId = resolved.id;
          taxWarning = buildLocationTaxWarning(existing.service_location?.state ?? null, resolved.state);
        }

        // Multi-visit S6 (D14, the mirror's other direction): a PATCH-reschedule is a real move,
        // so the TRIP moves with it. Before this slice only assign() had this branch, so a PATCH
        // wrote the three schedule columns and left the visit set holding the old time - the next
        // visit write then recomputed the mirror from the visits alone and silently deleted the
        // PATCH's booking. Now that the board reads visits, the same divergence would also show
        // the card at the time nobody moved it to.
        //
        // Deliberately NOT followed by syncJobFromVisits: like assign(), this handler writes the
        // job row itself in the same transaction, which is exactly why syncJobWindowOntoVisits is
        // documented as not re-deriving.
        if (startTouched && nextStart) {
          await syncJobWindowOntoVisits(tx, {
            jobId: existing.id,
            orgId: req.user!.organization_id,
            scheduledAt: nextStart,
            scheduledEnd: nextEnd ?? new Date(nextStart.getTime() + 60 * 60 * 1000),
            isAllDay: currentWindow.is_all_day ?? false,
          });
        }

        const j = await tx.job.update({
          where: { id: existing.id },
          data: {
            scope_notes: scope_notes !== undefined ? scope_notes : undefined,
            job_type: job_type !== undefined ? job_type : undefined,
            service_location_id: resolvedLocationId,
            estimated_duration: estimated_duration !== undefined ? estimated_duration : undefined,
            // SRVW-87 - UNSCHEDULED <-> SCHEDULED only, and NO milestoneClears / no
            // revertPlanVisitOnUncomplete: see deriveStatusOnReschedule for why PATCH must not
            // adopt assign()'s pairing.
            status: derivedStatus,
            // SRVW-112 - reuses SRVW-87's own derived status rather than recomputing it. undefined
            // means "leave the status alone", which is also exactly when a set sub-status stays
            // valid, so the ?? existing.status collapses that case to {}.
            ...subStatusClears(existing.status, derivedStatus ?? existing.status),
            // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns. The real
            // write is syncJobWindowOntoVisits above (in the SAME transaction, before this
            // statement), so `j.visits` below already reflects the new window when this select
            // runs - the response's computed projection cannot read stale.
            labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
            overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
            overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
            tax_rate: requestedTaxRate,
            ...(discountUpdate ?? {}),
            // SRVW-114 slice 1 - already the FULL merged bag (existing + patch), not the raw
            // patch: a bare overwrite here would drop every field the patch didn't mention.
            custom_fields: nextCustomFields !== undefined ? (nextCustomFields as Prisma.InputJsonValue) : undefined,
          },
          select: jobDetailSelect,
        });

        if (resolvedLocationId) {
          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'JOB',
              entity_id: existing.id,
              event_type: 'JOB_LOCATION_CHANGED',
              description: `Service location updated for job ${j.job_number}`,
              metadata: {
                to_location_id: resolvedLocationId,
                old_state: existing.service_location?.state ?? null,
                new_state: taxWarning?.new_state ?? null,
              },
              created_by: req.user!.id,
            },
          });
        }

        // Keep the linked service-plan visit's date in sync when a visit-job is rescheduled —
        // the plan's next-due / scheduler bucket read PlanVisit, so a Job-only date change would
        // leave them stale. Gated on source_plan_id, so it's a no-op for normal jobs.
        if (existing.source_plan_id && scheduled_start) {
          await tx.planVisit.updateMany({
            where: { job_id: existing.id, ...tenantWhere(req) },
            data: { scheduled_date: new Date(scheduled_start) },
          });
        }

        return j;
      });

      // Phase B (§E) — strip pricing for a non-invoice-reader (e.g. a tech granted `update Job`
      // per-user without read Invoice); no-op for invoice readers.
      const presented = await presentJobDetail(req, job);
      void logAudit({ req, action: 'job.updated', resourceType: 'Job', resourceId: existing.id, metadata: { fields: Object.keys(req.body) } });
      res.json({ job: presented, ...(taxWarning ? { tax_warning: taxWarning } : {}) });
    } catch (err) {
      if (err instanceof LocationResolutionError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error('Update job error:', err);
    res.status(500).json({ error: 'Failed to update job' });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    const existing = await prisma.job.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true, invoices: { select: { id: true, status: true } },
        // #106 ownership relations (OWN_JOB / OWN_JOB_VIA_ESTIMATE) for the per-instance check.
        visits: { select: { assignees: { select: { user_id: true } } } },
        estimate: { select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // #106 — base delete must do a PER-INSTANCE owner check (the subject-level route guard
    // passes for ANY job under a conditional `delete Job` grant). 403 a job the requester
    // does not own under their grant condition. SQL-based (one scoped findFirst) rather than the
    // in-memory CASL matcher: a NESTED Team/Location grant (assignees.some.user.department_id)
    // makes `can()` THROW → 500; the where-fragment is nested-safe.
    //
    // canActOnRow, NOT canAccessRow: `delete Job` is creator-scoped for a technician while
    // `read Job` is assigned-OR-created, so the read fragment alone would let every assignee
    // delete the job (technician-ownership spec, Part C).
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'delete'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-12 (Spec B1): `Invoice.job_id` is `onDelete: Restrict` regardless of the invoice's
    // status, so a job whose only invoice is VOIDED still throws a Prisma P2003 → generic 500
    // if this only checked for a non-voided invoice. Block on ANY invoice existing at all.
    if (existing.invoices.length > 0) {
      res.status(400).json({ error: 'Cannot delete a job that has an invoice' });
      return;
    }

    // Inventory P1 (§4.3 / QA-416): auto-return SYNCED lines BEFORE the job row (and its
    // cascading JobLineItem rows, onDelete: Cascade) die. Movement inserts must precede the
    // delete — the line FKs must exist at insert; SetNull then keeps the ledger rows with the
    // reference string. No UNSYNCED stamping — the rows die with the job.
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';
    // Logistic Orders (spec §14 C1): resolve the job's LOs PRE-TX (pool discipline). The job's
    // invoices are all VOIDED by the delete guard, so their invoice-anchored LOs were already
    // unwound by the void verb (the CAS no-ops them here) — the job anchor is all this needs.
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: { job_id: existing.id },
      actor,
      actorUserId: req.user!.id,
    });
    await prisma.$transaction(async (tx) => {
      const syncedLines = await tx.jobLineItem.findMany({
        where: { job_id: existing.id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      await returnSyncedLines(tx, syncedLines, {
        orgId: req.user!.organization_id,
        reference: `${existing.job_number} deleted`,
        actor,
        actorUserId: req.user!.id,
        jobId: existing.id,
        lineRef: 'job',
      });
      // Return PROCESSED LOs and cancel open ones BEFORE the job row dies — the return movement's
      // logistic_order_line_id FK must exist at insert. The LO row itself SURVIVES the delete
      // unanchored (job_id SetNull) as a historical document (E10).
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: true });
      await tx.job.delete({ where: { id: existing.id } });
    });

    void logAudit({ req, action: 'job.deleted', resourceType: 'Job', resourceId: existing.id });
    res.json({ message: 'Job deleted' });
  } catch (err) {
    logger.error('Delete job error:', err);
    res.status(500).json({ error: 'Failed to delete job' });
  }
}

// ─── Status Actions ─────────────────────────────────────

/**
 * SRVW-243 - the customer-facing half of `notify_customer: true` on assign().
 *
 * One job: turn "the user asked us to tell the customer" into a single
 * EmailDispatchResult the caller can be shown. It never throws and never
 * decides anything about the schedule write, which has already committed by the
 * time this runs.
 *
 * `no_recipient` is reported rather than sent-and-swallowed. A customer with no
 * address on file is the commonest reason a "notify" silently does nothing, and
 * a caller who ticked the box is owed that answer instead of a success it did
 * not get.
 */
async function notifyCustomerOfSchedule(
  req: Request,
  args: {
    jobId: string;
    jobNumber: string;
    customer: { id: string; first_name: string | null; last_name: string | null; company_name: string | null; email: string | null } | null;
    serviceLocation: { address_line1: string; city: string; state: string } | null;
    /**
     * The ONE trip this notice is about, when the caller has one (#2175).
     *
     * A visit carries its own location - the showroom, the yard - and `serviceLocation` above is
     * the JOB's, which is the customer's own address. Handing the id over is what lets the address
     * in this email be the trip's, and it is an id rather than a resolved string deliberately: the
     * resolution is a pointer-follow that has exactly one correct implementation, and a caller
     * passing its own string would be free to drift from what the automation engine renders for
     * the same booking under {{job.visit_location}}. Those two CAN both fire - the notify_customer
     * tick is independent of the engine - so they must not be able to name two different places.
     *
     * Null / omitted means "no one trip", which resolves to the job's service address exactly as
     * before: a crew-only assign that booked nothing, or an unschedule that called off several
     * trips at once and therefore names none of them.
     */
    visitId?: string | null;
    crew: { first_name: string; last_name: string }[];
    newStart: Date | null;
    /** The far end of the window, so a cancellation names the slot the customer was holding. */
    newEnd?: Date | null;
    /**
     * WHICH template. A discriminant rather than a boolean, because S7 adds a third case
     * (a cancelled trip) and because #1550 was a template chosen off a STATUS: job status is
     * derived and unordered and VisitStatus looks reassuring, so neither is evidence. Every
     * caller derives this from what actually happened to the row and hoists it into ONE const
     * that feeds the send, the timeline row and the automation gate together.
     */
    kind: 'scheduled' | 'rescheduled' | 'cancelled';
    /** Multi-visit D13 - the trip's own number, taken off the row the transaction wrote. */
    visitSeq?: number | null;
    /** The trip's cancellation reason, for kind: 'cancelled'. */
    cancelledReason?: string;
    /** Compose-dialog overrides. A one-off recipient, extra addressees, and the
     *  admin's own wording - none of it written back to the customer record. */
    recipientEmail?: string;
    cc?: string[];
    message?: string;
  },
): Promise<EmailDispatchResult> {
  // The typed override wins; the customer's saved address is the fallback, not
  // the other way round. Trimmed because an all-whitespace field is not an
  // address and must fall through to no_recipient rather than reach Resend.
  const to = args.recipientEmail?.trim() || args.customer?.email;
  if (!to) return { status: 'skipped', reason: 'no_recipient' };

  const organizationId = req.user!.organization_id;
  const customerName =
    [args.customer?.first_name, args.customer?.last_name].filter(Boolean).join(' ')
    || args.customer?.company_name
    || 'there';
  // The crew is what the customer is being told to expect at their door, so an
  // empty crew says "our team" rather than naming nobody.
  const technicianName =
    args.crew.map((u) => `${u.first_name} ${u.last_name}`.trim()).filter(Boolean).join(', ')
    || 'Our team';
  // One row for the zone the time renders in AND the header brand the customer sees -
  // SRVW-243 header-brand fix. Two lookups could not disagree, but one is cheaper and
  // this runs on the response path (mirrors notifyCustomerOfWalkthrough's own query).
  const orgRow = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, logo_url: true, brand_color: true, timezone: true },
  });
  const timezone = orgRow?.timezone || DEFAULT_TIMEZONE;
  // Undefined, never a guessed name, when the org row itself is missing - wrapHtml's own
  // 'ServWave' fallback exists for exactly that case (see email.ts:55, 639-640).
  const org: OrganizationBrandingSubset | undefined = orgRow
    ? { id: organizationId, name: orgRow.name, logo_url: orgRow.logo_url, brand_color: orgRow.brand_color }
    : undefined;
  const record = {
    organizationId,
    customerId: args.customer?.id ?? null,
    jobId: args.jobId,
    jobLabel: args.jobNumber,
    // The reply anchor: the scheduled notice, every reschedule after it and the
    // customer's reply all resolve to one address - see lib/reply-token.ts.
    entityType: 'job',
    entityId: args.jobId,
  };

  const compose = { cc: args.cc, message: args.message };

  if (args.kind === 'cancelled') {
    // RESOLVED BELOW THIS BRANCH, not above it: the cancellation notice names no place at all -
    // it says which trip is off and why - so resolving the trip's location for it would be a read
    // whose answer is thrown away. Should that copy ever gain an address, move the two lines
    // beneath this block above it; the id is already passed in by the cancelling callers.
    return sendJobVisitCancelledEmail({
      organizationId, org, to, customerName, jobNumber: args.jobNumber, visitSeq: args.visitSeq,
      // technicianName was computed above and never handed over, so the notice rendered no
      // Technician row at all - not even the "Our team" the crewless case resolves to
      // (MV-NOTIF-10).
      cancelledStart: args.newStart, cancelledEnd: args.newEnd ?? null, technicianName,
      reason: args.cancelledReason ?? '', timezone, record, ...compose,
    });
  }
  // #2175: the TRIP's place when this notice is about one, the job's service address when it is
  // not. `visitLocationForOccurrence` is the same resolution the visit-scoped automation
  // occurrences make, so one booking cannot be announced twice naming two different places.
  const serviceAddress = args.visitId
    ? await visitLocationForOccurrence(req, args.visitId, args.serviceLocation)
    : serviceAddressOf(args.serviceLocation);

  if (args.kind === 'rescheduled' && args.newStart) {
    return sendJobRescheduledEmail({
      organizationId, org, to, customerName, jobNumber: args.jobNumber, visitSeq: args.visitSeq,
      newScheduledStart: args.newStart, technicianName, serviceAddress, timezone, record, ...compose,
    });
  }
  return sendJobScheduledEmail({
    organizationId, org, to, customerName, jobNumber: args.jobNumber, visitSeq: args.visitSeq,
    technicianName, scheduledStart: args.newStart, serviceAddress, timezone, record, ...compose,
  });
}

/**
 * Dispatch TECH_UNASSIGNED for each removed crew member, carrying their
 * identity as eventPayload.recipient — by the time an automation fires
 * they're already off the crew, so nothing downstream can re-derive who they
 * were from the job row. Never throws: a lookup failure must not turn an
 * otherwise-successful crew change into a 500; the event still dispatches,
 * just without a captured recipient (falls back to "no one to notify" at the
 * removed_user audience, same as any other unresolvable audience).
 */
async function dispatchTechUnassigned(
  req: Request,
  removedIds: string[],
  job: { id: string; label: string },
  /**
   * The trip they came off, when the door re-crews ONE trip (slice 02): the occurrence is keyed to
   * it (D18) and renders it, from `tripMergeFields` - built by crewNoticeTripFields, like TECH_ASSIGNED's.
   */
  tripVisitId?: string,
  tripMergeFields?: Record<string, string> | null,
): Promise<void> {
  if (removedIds.length === 0) return;
  let removedUsers: { id: string; email: string | null; first_name: string; last_name: string; phone: string | null }[] = [];
  try {
    removedUsers = (await prisma.user.findMany({
      where: { id: { in: removedIds }, ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, last_name: true, phone: true },
    })) ?? [];
  } catch (err) {
    logger.warn('Failed to resolve removed technicians for TECH_UNASSIGNED — dispatching without a recipient', err);
  }
  for (const uid of removedIds) {
    const u = removedUsers.find((x) => x.id === uid);
    dispatchAutomationEvent({
      type: 'TECH_UNASSIGNED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id: job.id, label: job.label },
      occurrenceKey: uid,
      ...(tripVisitId ? { visitId: tripVisitId } : {}),
      actorId: req.user?.id ?? null,
      ...(u || tripMergeFields
        ? { eventPayload: { ...(u ? { recipient: u } : {}), ...(tripMergeFields ? { mergeFields: tripMergeFields } : {}) } }
        : {}),
    });
  }
}

/**
 * What a crew notice from the per-visit crew door renders about its trip (slice 02): the trip's
 * own date, place and crew, through visitMergeFields like every visit-scoped dispatch. `crew` is
 * the trip's crew AFTER the write.
 */
async function crewNoticeTripFields(
  req: Request,
  visit: { id: string; scheduled_at: Date | null },
  crew: CrewMember[],
  serviceLocation: ServiceLocationParts,
): Promise<Record<string, string>> {
  const orgId = req.user!.organization_id;
  const mainLine = await getOrgMainLine(orgId);
  return visitMergeFields(
    { scheduled_at: visit.scheduled_at },
    crew,
    await getOrgTimezone(orgId),
    await visitLocationForOccurrence(req, visit.id, serviceLocation),
    mainLine,
    await resolveServWavePhones(orgId, crew.map((u) => u.id), mainLine),
  );
}

export async function assign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    // assignee_ids is the FULL new crew (REPLACE semantics; [] is a valid state-4 schedule).
    const {
      assignee_ids, scheduled_start, scheduled_end, is_all_day, force,
      notify_customer, notify_recipient_email, notify_cc_emails, notify_message,
    } = req.body as {
      assignee_ids: string[];
      scheduled_start?: string;
      scheduled_end?: string;
      is_all_day?: boolean;
      force?: boolean;
      notify_customer?: boolean;
      notify_recipient_email?: string;
      notify_cc_emails?: string[];
      notify_message?: string;
    };
    // Q1: this door's `notify_customer` is a flat, three-state-capable boolean (undefined/true/
    // false), not the nested `notify` object the visit doors use, but the same three states apply.
    // `undefined` -> unchanged, back-compat: the automation fires. `true` -> unchanged: the direct
    // send below fires and the automation is suppressed for this occurrence. `false` -> NEITHER
    // fires: the caller explicitly declined telling the customer, and the automation gates below
    // used to test bare `!notify_customer`, which is also true when the caller declined -
    // silently mailing the customer through the workflow anyway.
    const notifyDeclined = notify_customer === false;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true, source_plan_id: true,
        // The once-per-job "scheduled announcement already happened" guard that
        // decideScheduleDispatch reads. Despite its column name it says nothing about whether the
        // customer received anything; the automation ledger answers that.
        customer_scheduled_email_sent_at: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
        scope_notes: true,
        // S8 (D6): the job's crew is the union across its trips - `job_assignees` is gone.
        // S8 (A5, RATIFIED): also the source of the CURRENT window (isReschedule/timeChanged
        // below) - scheduled_start is no longer a stored column.
        visits: {
          select: {
            status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
            assignees: { select: { user_id: true } },
          },
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // S8 (A5, RATIFIED): the CURRENT window, computed off the visit set.
    const currentWindow = resolveJobScheduleWindow(existing.visits);

    // ─── #1626 (spec #1751, D9): the window this request STATES, against the one it holds ──
    //
    // The ratified product rule is that adding crew - to a job or to a walkthrough - never changes
    // status and never clears a milestone. Honouring it HERE, rather than only in the dialog, means
    // this handler must stop inferring "the job is being booked" from the mere PRESENCE of a
    // schedule field and compare against the stored window instead. See jobWindowMoved() for the
    // two rules (omitted is not stated; the grain is a minute) and for why the client half alone
    // leaves the next caller free to walk in through the same door - which is exactly what #1621
    // did to the contract already written in a comment further down this handler.
    const newStart = scheduled_start ? new Date(scheduled_start) : null;
    // The job's current LENGTH, carried forward when a request names a start and no end. Falls
    // back to the 60 minutes the S8 migration backfill and detectPerformerConflicts also give an
    // open-ended job. Preserving the LENGTH (rather than reusing the current END instant) is what
    // keeps a lone start from inverting the window when it genuinely moves.
    const currentDurationMs =
      currentWindow.scheduled_start && currentWindow.scheduled_end
        ? Math.max(0, currentWindow.scheduled_end.getTime() - currentWindow.scheduled_start.getTime())
        : 0;
    // The end this request lands on: the body's, or - for an all-day body - the day-long span, or
    // the job's own length carried forward. Null only when no start was named at all.
    const effectiveEnd: Date | null = scheduled_end
      ? new Date(scheduled_end)
      : newStart
        ? new Date(newStart.getTime() + (
            is_all_day ? 24 * 60 * 60 * 1000 : (currentDurationMs || 60 * 60 * 1000)
          ))
        : null;
    // Omitted means unchanged - the same rule rescheduleVisitRow applies to this very flag:
    // writing `false` for "the request did not mention it" silently converts an all-day job into a
    // timed one. Kept in step with jobWindowMoved(), which likewise only compares a STATED flag.
    const effectiveIsAllDay = is_all_day ?? (currentWindow.is_all_day ?? false);
    // THE const. Everything that used to ask `scheduled_start ?` in order to decide "is this a
    // booking" asks this instead: the status write, the milestone rewind, the PlanVisit re-date,
    // revertPlanVisitOnUncomplete, and which of the two visit writers runs below.
    const windowMoved = jobWindowMoved(currentWindow, { scheduled_start, scheduled_end, is_all_day });

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Eligibility, and since slice 2 the assignee pool. The third argument is the crew this
    // request would be replacing - the job-level union across its trips, the same set the
    // `currentIds` diff below reads - so restating the crew the Assign dialog was already showing
    // is not treated as naming anybody.
    //
    // EXCEPT WHEN THERE IS NO LIVE TRIP, and then it is not a restatement at all. `jobCrewIds` is
    // the union across EVERY visit with no status filter (lib/job-crew.ts says so deliberately -
    // the row scope has none either), so a job whose only trip is CANCELLED or COMPLETED still
    // reports that trip's crew. If this request also moves the window, syncJobWindowOntoVisits
    // CREATES a visit, and a created visit takes the stated crew WHOLESALE rather than by delta
    // (walkthrough.service.ts, `isNewVisit`). "Unchanged at the union" would then mean "wrote a
    // colleague onto a brand-new trip on a new date, and notified them" - for a caller who may
    // name only themselves. No live trip means there is no roster to restate, so pass undefined
    // and take the strict path, which is exactly what the omitted third argument is for.
    const hasLiveVisit = existing.visits.some(isLiveVisit);
    const crew = await validateCrew(req, assignee_ids, hasLiveVisit ? jobCrewIds(existing) : undefined);
    if (!crew.ok) {
      res.status(crew.status).json({ error: crew.error });
      return;
    }

    // Crew diff vs the CURRENT crew (drives conflict scope + diff-emails).
    const currentIds = new Set(existing.visits.flatMap((v) => v.assignees.map((a) => a.user_id)));
    const addedIds = assignee_ids.filter((uid) => !currentIds.has(uid));
    const keptIds = assignee_ids.filter((uid) => currentIds.has(uid));
    // No `removedIds` here on purpose: removal is a fact about what the WRITE did, and under the
    // union the request's omissions are not it. See crewDelta below.

    // Did the START move? #1626: compared at MINUTE grain, and only against a start this request
    // actually named. The old test was `(current?.getTime() ?? null) !== (newStart?.getTime() ??
    // null)` and had two defects. A stored start carrying seconds never compared equal to the
    // `:00` the pickers hand back, so an untouched window announced itself as a move for ever; and
    // a crew-only assign (newStart null) on a scheduled job read as `X !== null` = CHANGED, which
    // is what fired `dispatch.job_rescheduled` at the whole crew when nothing had moved.
    const timeChanged = newStart != null && !sameScheduleMinute(currentWindow.scheduled_start, newStart);

    // Conflict detection: PER added member; plus KEPT members only when the window also changed
    // (a kept member at a brand-new slot can newly collide elsewhere). Keyed on `windowMoved`
    // rather than `timeChanged`, because a member kept through a changed END is newly collidable
    // too. Runs whenever a window is NAMED, moved or not: a restatement that adds someone already
    // booked elsewhere at that hour still has to raise its 409.
    if (!force && newStart && effectiveEnd) {
      const conflictUserIds = windowMoved ? [...addedIds, ...keptIds] : addedIds;
      const conflicts = await detectCrewConflicts(req, {
        jobId: id,
        userIds: conflictUserIds,
        schedStart: newStart,
        schedEnd: effectiveEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    // status derives from a MOVED window - not from crew, and not from the mere MENTION of a time:
    // SCHEDULED iff this request actually books or moves the job, else keep current (#1626).
    // SRVW-112 - hoisted to ONE const so the status write and subStatusClears below cannot drift
    // apart: an assign that moves nothing keeps existing.status and must therefore leave a
    // still-valid sub-status alone.
    const nextStatus: JobStatus = windowMoved ? 'SCHEDULED' : existing.status;
    // A job already sitting on the calendar is MOVING; anything else is being booked.
    // Deliberately NOT coupled to status. Job status is UNORDERED (Spec B1), so a job
    // can hold a scheduled time while sitting at EN_ROUTE / ON_SITE / IN_PROGRESS /
    // COMPLETED, and the board still lets you drag it. The older `status === 'SCHEDULED'
    // && scheduled_start != null` test mailed those a "Your Service Has Been Scheduled"
    // notice with no mention that anything had moved - seen in prod on Servwave Demo
    // (J00005, Aug 18 -> Aug 19, dialog headed "Reschedule Job?"). One const so the
    // customer-facing send and the automation dispatch below cannot drift apart on it.
    const isReschedule = currentWindow.scheduled_start != null;
    // Scheduling-notifications PRD ("Job is scheduled fires on the date"): what this write
    // announces to the customer is decided by decideScheduleDispatch, the SAME function the
    // Visits-tab door consults, off the facts this door holds. It used to be decided here as
    // "left UNSCHEDULED with a crew in the same save", which told nobody about a job dated on
    // Monday and crewed on Thursday. This door states THE job's window (`additionalTrip: false`):
    // whether the sync below moves a live row or mints one for a job whose only live trip's date
    // has passed, the customer's job moved. The guard stamp rides the job update in the
    // transaction, and the post-commit dispatch reads the same value.
    const scheduleDecision: ScheduleDispatchDecision = decideScheduleDispatch({
      startBefore: currentWindow.scheduled_start,
      startAfter: windowMoved && newStart ? newStart : currentWindow.scheduled_start,
      additionalTrip: false,
      scheduledDispatchedAt: existing.customer_scheduled_email_sent_at,
      crewCount: assignee_ids.length,
    });

    // Multi-visit S3: TWO diffs, and they now genuinely differ, so which one feeds what is
    // written down rather than left to be rediscovered.
    //
    //  - addedIds / keptIds above are the PRE-read diff (request body vs the job as it was). They
    //    scope conflict detection, which has to run BEFORE the write, so they cannot come from the
    //    writer's return value.
    //  - crewDelta below is what the write ACTUALLY did. Under the union a member the request
    //    omitted can still be kept, because they are crewed on another of the job's visits, so the
    //    pre-read diff would tell them they were removed from a job whose row they still hold.
    //    Timeline events and the diff-emails therefore read the real delta, never the intent.
    let crewDelta: { added: string[]; removed: string[] } = { added: [], removed: [] };
    // S7 (D18): the ONE visit this call booked or moved - syncJobWindowOntoVisits' documented
    // return value, which the call site used to discard. Both doors onto a trip (this one and
    // POST /:id/visits) must key their automation events on the same visit, or one trip enrols
    // twice under two different keys.
    let touchedVisitId: string | null = null;

    const job = await prisma.$transaction(async (tx) => {
      // S8 (RATIFIED, A5): this handler used to ALSO write the job's three schedule columns
      // directly as a CACHE of the visit it books/moves below - that mirror is DROPPED. The
      // visit write below is now the only write; the response's `scheduled_start`/`scheduled_end`/
      // `is_all_day` are computed on read from `job.visits[]` by presentJobDetail. 60 minutes when
      // no end was given is the same default the migration's backfill and
      // detectPerformerConflicts apply to an open-ended job.
      //
      // S8 (D6): there is no second, job-level crew write to order against any more - the crew
      // statement lands on the trip this branch books or moves, and that IS the write. The job
      // read below still runs last, because its derived `assignees` projection is the payload the
      // Team card renders and it must show what the visit write did.
      if (windowMoved && newStart) {
        const visitStart = newStart;
        const touched = await syncJobWindowOntoVisits(tx, {
          jobId: id,
          orgId: req.user!.organization_id,
          scheduledAt: visitStart,
          scheduledEnd: effectiveEnd ?? new Date(visitStart.getTime() + 60 * 60 * 1000),
          isAllDay: effectiveIsAllDay,
        });
        // Multi-visit S3 (D6): the crew has to land on the visit, or the Assign Technician dialog
        // books a crewless trip beside a populated Team card and "crew lives on the visit" is true
        // for the rows the migration folded and false for everything written afterwards.
        //
        // Scoped to the ONE visit syncJobWindowOntoVisits touched, and applied as the CHANGE
        // against the crew the dialog was showing rather than as a wholesale restatement - this is
        // a job-level statement, and a job can have several trips with different crews. See
        // applyJobCrewStatementToVisit for why the two are not the same fact.
        //
        // A crew-only assign falls outside this branch on purpose: no visit was booked or moved,
        // so there is no trip for the crew to be on. #1626 widens what "crew-only" means from "no
        // scheduled_start in the body" to "no MOVE in the body" - a restatement of the window the
        // job already holds must not reach this writer either, or a job whose only trip has been
        // completed gets a brand-new SCHEDULED trip invented for it by an act of adding crew.
        touchedVisitId = touched.id;
        crewDelta = await applyJobCrewStatementToVisit(tx, {
          visitId: touched.id,
          orgId: req.user!.organization_id,
          isNewVisit: touched.created,
          previousJobCrew: [...currentIds],
          statedCrew: assignee_ids,
        });
      } else {
        // S8 (D6): a crew-only assign - no window named, or one that moves nothing (#1626). There
        // is no trip being booked, so the statement lands on the job's CURRENT visit - the trip
        // the crew is standing at. When the job has no LIVE trip at all the statement is
        // unexpressible and setJobCrewOnCurrentVisit throws NoVisitForCrewError, which the catch
        // below turns into a 400. That refusal is the honest answer for a finished job, and is
        // the same one the crew-only door (POST /:id/assignees) already gives.
        crewDelta = await setJobCrewOnCurrentVisit(tx, {
          jobId: id,
          orgId: req.user!.organization_id,
          previousJobCrew: [...currentIds],
          statedCrew: assignee_ids,
        });
      }

      const updated = await tx.job.update({
        where: { id },
        data: {
          status: nextStatus,
          ...subStatusClears(existing.status, nextStatus),
          // S8 (RATIFIED, A5): scheduled_start/scheduled_end/is_all_day DROPPED as job columns -
          // syncJobWindowOntoVisits above already wrote the real visit; this select's `visits[]`
          // reflects that write, and the projection computes the wire keys off it.
          // The once-per-job guard: "the scheduling announcement for this job has happened".
          // Not evidence that the customer received anything.
          ...(scheduleDecision.stampScheduledDispatched ? { customer_scheduled_email_sent_at: new Date() } : {}),
          // Only a real reschedule rewinds the milestones (Spec B1, Step 6b). A crew-only
          // assign must not null completed_at while leaving status COMPLETED -- that row would
          // report as not-completed and, because canComplete excludes COMPLETED, could not be
          // re-completed from the UI.
          //
          // #1626: this contract used to be written here as "no scheduled_start in the body" and
          // was therefore only as strong as the client's willingness to omit the field. It is now
          // ENFORCED, against the stored window, by `windowMoved` - the body may restate the
          // schedule as often as it likes.
          ...(windowMoved ? milestoneClears('scheduled') : {}),
        },
        select: jobDetailSelect,
      });

      // Reschedule sync: a calendar drag re-dates the Job here, so mirror the new date onto the
      // linked service-plan visit (the plan's next-due / bucket read PlanVisit). No-op for normal jobs.
      if (existing.source_plan_id && windowMoved && newStart) {
        await tx.planVisit.updateMany({
          where: { job_id: id, ...tenantWhere(req) },
          data: { scheduled_date: newStart },
        });
      }

      // Diff TimelineEvents: one per crew change (replaces the single ASSIGNED event). Read off
      // the real delta, so nobody the union kept is announced as removed.
      for (const uid of crewDelta.added) {
        const u = crew.users.find((x) => x.id === uid);
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_ADDED',
            description: `${u ? `${u.first_name} ${u.last_name}` : 'A crew member'} added to job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }
      for (const _uid of crewDelta.removed) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_REMOVED',
            description: `A crew member removed from job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }

      if (newStart && timeChanged) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: currentWindow.scheduled_start ? 'RESCHEDULED' : 'SCHEDULED',
            description: currentWindow.scheduled_start
              ? `Job ${existing.job_number} rescheduled`
              : `Job ${existing.job_number} scheduled`,
            metadata: { from: currentWindow.scheduled_start?.toISOString() ?? null, to: newStart.toISOString() },
            created_by: req.user!.id,
          },
        });
      }

      return updated;
    });

    // #1626: gated on `windowMoved`, in step with the milestoneClears spread above - this exists
    // to undo a completion the write just erased, so it must fire on exactly the same condition.
    if (windowMoved && clearsCompletion('scheduled')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    // ─── In-app notification hooks — POST-COMMIT (must NOT run inside the txn; #271) ──
    // Best-effort: emit() never throws.
    if (crewDelta.added.length > 0) {
      await emit({
        verb: 'dispatch.job_assigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: crewDelta.added },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? currentWindow.scheduled_start)?.toISOString() ?? null,
        },
      });
    }
    if (crewDelta.removed.length > 0) {
      await emit({
        verb: 'dispatch.job_unassigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: crewDelta.removed },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? currentWindow.scheduled_start)?.toISOString() ?? null,
        },
      });
    }
    if (timeChanged && crewDelta.added.length === 0) {
      // Reschedule with no crew change: notify all kept/current assignees.
      await emit({
        verb: 'dispatch.job_rescheduled',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: keptIds },
        data: {
          object_label: existing.job_number,
          scheduled_start: (newStart ?? currentWindow.scheduled_start)?.toISOString() ?? null,
        },
      });
    }

    // ─── Automation Center events — post-commit, fire-and-forget (#271) ──────
    for (const uid of crewDelta.added) {
      const addedUser = crew.users.find((x) => x.id === uid);
      dispatchAutomationEvent({
        type: 'TECH_ASSIGNED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: uid,
        actorId: req.user?.id ?? null,
        ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
      });
    }
    await dispatchTechUnassigned(req, crewDelta.removed, { id, label: existing.job_number });

    // D18 + visit-location slice 4: BOTH dispatches below key their occurrence to the one trip
    // this request booked or moved (`touchedVisitId`), so what they RENDER has to be that trip.
    //
    // Without this they carry no override at all and fall back to context.ts's per-ENTITY
    // resolution - the job's NEXT upcoming live visit. On a job holding a later trip at the
    // showroom, moving the earlier one through this door mails the customer the showroom's
    // address AND the showroom's date for a trip that is happening at their house, on a
    // different day. The date half of that is older than this feature and travels out with the
    // same fix; it is the same defect family as a moved job telling the customer the old time.
    //
    // `crew.users` is the SAME crew the direct send below hands to notifyCustomerOfSchedule for
    // this very occurrence, so the automation and the hard-coded email cannot name two different
    // crews for one trip. `newStart` is the ONE Date the visit write used - `touchedVisitId` is
    // only ever set on the branch that passed it to syncJobWindowOntoVisits - so the rendered
    // date is the persisted one rather than a second reading of the request.
    let touchedVisitMergeFields: Record<string, string> | null = null;
    if (touchedVisitId && newStart) {
      // Slice 5: what {{technician.phones}} falls back to when nobody on this trip has a number on
      // file. Resolved at the dispatch site for the same reason the location is - the override
      // REPLACES the per-entity resolution, so anything it leaves out keeps the job-level union's
      // answer.
      //
      // Read ONCE into a const and used twice (slice 7 gave it a second reader), because it is
      // also the bottom of the ServWave chain: two reads of Organization.phone building one
      // message are two chances for one email to quote two different main lines.
      const mainLine = await getOrgMainLine(req.user!.organization_id);
      touchedVisitMergeFields = visitMergeFields(
        { scheduled_at: newStart },
        crew.users,
        await getOrgTimezone(req.user!.organization_id),
        await visitLocationForOccurrence(req, touchedVisitId, existing.service_location),
        mainLine,
        // Slice 7: {{technician.servwave_phones}} - the ORGANISATION'S number for the same people,
        // for the template that declines to publish mobiles. `crew.users` is the crew this request
        // named, so the numbers and the names below come off one list.
        await resolveServWavePhones(
          req.user!.organization_id, crew.users.map((u) => u.id), mainLine,
        ),
      );
    }

    // Which of the two customer-facing events this write is, if either, is scheduleDecision's
    // answer (decideScheduleDispatch, shared with POST /:id/visits): JOB_SCHEDULED once per job
    // on its first scheduled start whether or not a crew was named, JOB_RESCHEDULED on a later
    // move of an announced job, nothing for a crew-only write or a restated window.
    //
    // SRVW-243 - an explicit tick REPLACES the automation for this occurrence
    // rather than joining it. Two reasons the direct send has to win outright:
    // a workflow can carry a send_window that defers delivery by hours, which is
    // not what someone who just pressed "notify the customer" is asking for; and
    // an org holding the default job-scheduled workflow would otherwise mail the
    // customer twice for one action. Only THIS occurrence is suppressed - the
    // workflow stays enabled for every untick.
    //
    // Q1: `&& !notifyDeclined` is the fix. Bare `!notify_customer` is true for BOTH "not
    // mentioned" (fire the automation, back-compat) and "explicitly false" (the caller declined -
    // firing the automation anyway mails the customer through the workflow, defeating the decline).
    if (scheduleDecision.event === 'JOB_SCHEDULED' && !notify_customer && !notifyDeclined) {
      dispatchAutomationEvent({
        type: 'JOB_SCHEDULED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        ...(touchedVisitId ? { visitId: touchedVisitId } : {}),
        // Gated on the SAME condition as the visit id above, deliberately: an occurrence that
        // names no visit is not visit-scoped, and overriding its fields with one trip's answers
        // would be the inverse of this fix.
        ...(touchedVisitMergeFields ? { eventPayload: { mergeFields: touchedVisitMergeFields } } : {}),
        actorId: req.user?.id ?? null,
      });
    }
    if (scheduleDecision.event === 'JOB_RESCHEDULED' && !notify_customer && !notifyDeclined && newStart) {
      dispatchAutomationEvent({
        type: 'JOB_RESCHEDULED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: newStart.toISOString(),
        ...(touchedVisitId ? { visitId: touchedVisitId } : {}),
        // See the JOB_SCHEDULED dispatch above: same override, same gate, same reason.
        ...(touchedVisitMergeFields ? { eventPayload: { mergeFields: touchedVisitMergeFields } } : {}),
        actorId: req.user?.id ?? null,
      });
    }
    if (newStart && timeChanged && currentWindow.scheduled_start) {
      void rearmAnchoredWaits('job', id);
    }

    // The send is AWAITED and post-commit. Awaited because the caller is told the
    // outcome and cannot be told what has not happened yet; post-commit because a
    // job that genuinely moved must not be rolled back by a mail provider. So a
    // failure here is reported, never thrown - the response stays 200 and carries
    // `notify`, and the UI says "rescheduled, but the customer email did not go
    // out" instead of the older choice between a silent success and a false 502.
    const notify = notify_customer
      ? await notifyCustomerOfSchedule(req, {
          jobId: id,
          jobNumber: existing.job_number,
          customer: existing.customer,
          serviceLocation: existing.service_location,
          // #2175: the trip this call booked or moved - the SAME one the two dispatches above
          // key their occurrence to, so the direct email and the workflow cannot name two
          // different places for one booking. Null on a crew-only assign, which booked no trip
          // and therefore states nothing about where one is.
          visitId: touchedVisitId,
          crew: crew.users,
          newStart,
          kind: isReschedule ? 'rescheduled' : 'scheduled',
          recipientEmail: notify_recipient_email,
          cc: notify_cc_emails,
          message: notify_message,
        })
      : undefined;

    res.json({ job: await presentJobDetail(req, job), ...(notify ? { notify } : {}) });
  } catch (err) {
    // S8 (D6): a crew statement on a job with no trip is not a server fault - it is a
    // request the model cannot express. Surfaced as a 400 carrying the reason so the
    // client can say it, rather than a silent no-op or an opaque 500.
    if (err instanceof NoVisitForCrewError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Assign job error:', err);
    res.status(500).json({ error: 'Failed to assign job' });
  }
}

// Crew-only REPLACE (Step 5.6): never reads/writes status or scheduling fields. Per-member
// eligibility + diff TimelineEvents + diff-emails (assignment per added, unassigned per removed).
// No customer email, no flag change.
//
// Two doors share this handler: POST /:id/assignees states the JOB's crew and lands it on the
// job's current visit (setJobCrewOnCurrentVisit); POST /:id/visits/:visitId/assignees (slice 02)
// states ONE trip's crew and replaces exactly that trip's - the scheduler's per-visit cards re-crew
// through it, so dragging visit 2 between lanes no longer re-crews visit 1. Same gate, eligibility
// rules and notices either way; only the target differs.
export async function setAssignees(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    // Present only on the per-visit door.
    const visitId = req.params.visitId as string | undefined;
    const { assignee_ids, notify } = req.body as {
      assignee_ids: string[];
      notify?: { in_app?: boolean; email?: boolean };
    };

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, job_number: true,
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
        scope_notes: true,
        // S8 (D6): crew through the trips.
        // S8 (A5, RATIFIED): also the source of the CURRENT window (the two emit() payloads
        // below) - scheduled_start is no longer a stored column.
        visits: {
          select: {
            // `id`: the per-visit door tells a trip's siblings apart from the trip it re-crews.
            id: true,
            status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
            assignees: { select: { user_id: true } },
          },
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // S8 (A5, RATIFIED): the CURRENT window, computed off the visit set.
    const currentWindow = resolveJobScheduleWindow(existing.visits);

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // The per-visit door's target, read only AFTER the job-level authorization above so a refused
    // caller learns nothing about the job's trips. Scoped to BOTH this job and this tenant: a
    // visitId from another job, or another organization, is not reachable through this URL.
    const targetVisit = visitId
      ? await prisma.visit.findFirst({
          where: { id: visitId, job_id: id, ...tenantWhere(req) },
          select: { id: true, visit_seq: true, status: true, scheduled_at: true, assignees: { select: { user_id: true } } },
        })
      : null;
    if (visitId && !targetVisit) {
      res.status(404).json({ error: 'Visit not found' });
      return;
    }
    // Q4's rule, as on PATCH /:id/visits/:visitId: a called-off trip is immutable at the API.
    if (targetVisit?.status === 'CANCELLED') {
      res.status(409).json({ error: 'Visit is cancelled' });
      return;
    }

    // The crew being replaced: the named trip's own, or (job-level door) the job-level union -
    // identical to `previousCrew` below, read through the one helper rather than a second flatten.
    const crew = await validateCrew(
      req,
      assignee_ids,
      targetVisit ? targetVisit.assignees.map((a) => a.user_id) : jobCrewIds(existing),
    );
    if (!crew.ok) {
      res.status(crew.status).json({ error: crew.error });
      return;
    }

    // Same two-diff rule as assign(): the intent diff is not the delta. Under the union a member
    // the request omitted can still be kept because they are crewed on one of the job's visits, so
    // the timeline events and the dispatches below read what the write actually did.
    let crewDelta: { added: string[]; removed: string[] } = { added: [], removed: [] };

    const previousCrew = [...new Set(existing.visits.flatMap((v) => v.assignees.map((a) => a.user_id)))];

    // Per-visit door (slice 02): who is on the job through ANOTHER of its trips. Every trip that
    // is not CANCELLED counts - a COMPLETED sibling included, since that person has worked this
    // job (conductor ruling) - so "live" would be the wrong word for it. Such a person joining
    // this trip has joined a trip, not the job, and leaving it does not take them off the job.
    // Empty on the job-level door, whose statement is about the job as a whole.
    const onNonCancelledSiblingTrip = new Set(
      targetVisit
        ? existing.visits
            .filter((v) => v.id !== targetVisit.id && v.status !== 'CANCELLED')
            .flatMap((v) => v.assignees.map((a) => a.user_id))
        : [],
    );

    const job = await prisma.$transaction(async (tx) => {
      // S8 (D6): `job_assignees` is gone, so the office's crew statement lands on the job's
      // CURRENT visit. A job with no trip at all cannot hold crew - see setJobCrewOnCurrentVisit.
      // The per-visit door REPLACES the named trip's crew - the statement is that trip's whole crew.
      crewDelta = targetVisit
        ? await replaceVisitCrew(tx, { visitId: targetVisit.id, orgId: req.user!.organization_id, userIds: assignee_ids })
        : await setJobCrewOnCurrentVisit(tx, {
            jobId: id,
            orgId: req.user!.organization_id,
            previousJobCrew: previousCrew,
            statedCrew: assignee_ids,
          });

      for (const uid of crewDelta.added) {
        const u = crew.users.find((x) => x.id === uid);
        // Already on the job through a sibling trip: they joined THIS trip, so the entry names it.
        const joined = targetVisit && onNonCancelledSiblingTrip.has(uid)
          ? `Visit ${targetVisit.visit_seq} of job ${existing.job_number}`
          : `job ${existing.job_number}`;
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_ADDED',
            description: `${u ? `${u.first_name} ${u.last_name}` : 'A crew member'} added to ${joined}`,
            created_by: req.user!.id,
          },
        });
      }
      for (const _uid of crewDelta.removed) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'CREW_MEMBER_REMOVED',
            description: `A crew member removed from job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });
      }

      // Re-read via the detail select (crew-only mutation; status/schedule untouched).
      return tx.job.findUnique({ where: { id }, select: jobDetailSelect });
    });

    // The trip the notices are about: the named one on the per-visit door, else the job's current.
    const noticeStart = targetVisit ? targetVisit.scheduled_at : currentWindow.scheduled_start;

    // Per-visit door (slice 02): somebody taken off THIS trip who is still crewed on another
    // non-cancelled trip of the job (scheduled, under way or completed) has not left the job. They
    // get no "removed from the job" email, and their in-app notice names the trip they came off.
    // Everyone else - and everyone on the job-level door - gets today's job-level unassign.
    const removedFromJob = crewDelta.removed.filter((uid) => !onNonCancelledSiblingTrip.has(uid));
    const removedFromTripOnly = crewDelta.removed.filter((uid) => onNonCancelledSiblingTrip.has(uid));
    // The trip's own date, place and crew for the per-visit door's TECH_ASSIGNED/UNASSIGNED
    // occurrences, which are keyed to it - so the email renders this trip, not the job's current one.
    const tripMergeFields =
      targetVisit && (crewDelta.added.length > 0 || removedFromJob.length > 0)
        ? await crewNoticeTripFields(req, targetVisit, crew.users, existing.service_location)
        : null;

    // ─── In-app notification hooks — POST-COMMIT (must NOT run inside the txn; #271) ──
    // #361: notify.in_app:false suppresses ONLY the added-crew emit; removal stays unconditional.
    if (crewDelta.added.length > 0 && notify?.in_app !== false) {
      await emit({
        verb: 'dispatch.job_assigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: crewDelta.added },
        data: {
          object_label: existing.job_number,
          scheduled_start: noticeStart?.toISOString() ?? null,
        },
      });
    }
    if (removedFromJob.length > 0) {
      await emit({
        verb: 'dispatch.job_unassigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: removedFromJob },
        data: {
          object_label: existing.job_number,
          scheduled_start: noticeStart?.toISOString() ?? null,
        },
      });
    }
    if (targetVisit && removedFromTripOnly.length > 0) {
      const day = targetVisit.scheduled_at
        ? ` on ${formatShortDateInZone(targetVisit.scheduled_at, await getOrgTimezone(req.user!.organization_id))}`
        : '';
      await emit({
        verb: 'dispatch.job_unassigned',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'JOB', id, label: existing.job_number },
        entity: { assignee_ids: removedFromTripOnly },
        data: {
          object_label: existing.job_number,
          scheduled_start: noticeStart?.toISOString() ?? null,
          // Renders "J00178 Visit 2 on Wed, Sep 30 - you were removed from this visit".
          visit_label: `Visit ${targetVisit.visit_seq}${day}`,
        },
      });
    }

    // ─── Automation Center events — post-commit, fire-and-forget (#271) ──────
    // #361: notify.email:false suppresses ONLY the added-crew TECH_ASSIGNED dispatch —
    // parity with the (now-deleted) sendJobAssignmentEmail gate at the bottom of this
    // function. Removal (TECH_UNASSIGNED) stays unconditional, same as today.
    if (notify?.email !== false) {
      for (const uid of crewDelta.added) {
        const addedUser = crew.users.find((x) => x.id === uid);
        dispatchAutomationEvent({
          type: 'TECH_ASSIGNED',
          organizationId: req.user!.organization_id,
          entity: { type: 'job', id, label: existing.job_number },
          occurrenceKey: uid,
          // Per-visit door: the occurrence is about THIS trip (D18) - keyed per visit, so being put
          // on a job's second trip is not swallowed as a duplicate of the first, and rendered from
          // this trip, so the email names its own date.
          ...(targetVisit ? { visitId: targetVisit.id } : {}),
          actorId: req.user?.id ?? null,
          ...(addedUser || tripMergeFields
            ? { eventPayload: { ...(addedUser ? { recipient: addedUser } : {}), ...(tripMergeFields ? { mergeFields: tripMergeFields } : {}) } }
            : {}),
        });
      }
    }
    await dispatchTechUnassigned(req, removedFromJob, { id, label: existing.job_number }, targetVisit?.id, tripMergeFields);

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    // S8 (D6): a crew statement on a job with no trip is not a server fault - it is a
    // request the model cannot express. Surfaced as a 400 carrying the reason so the
    // client can say it, rather than a silent no-op or an opaque 500.
    if (err instanceof NoVisitForCrewError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Set assignees error:', err);
    res.status(500).json({ error: 'Failed to set job assignees' });
  }
}

// #291 — set or clear Job.dispatcher_id (JCC Team card). Only ADMIN/DISPATCHER-role,
// active, same-org users are eligible. Never touches status/schedule/crew.
export async function setDispatcher(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { dispatcher_id } = req.body as { dispatcher_id: string | null };

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, job_number: true, dispatcher_id: true, estimate: { select: { lead_id: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('assign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let targetName: string | null = null;
    if (dispatcher_id !== null) {
      const target = await prisma.user.findUnique({
        where: { id: dispatcher_id, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true, first_name: true, last_name: true },
      });
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!isDispatcherEligible(target.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as dispatcher' });
        return;
      }
      if (!target.is_active) {
        res.status(400).json({ error: 'Cannot assign an inactive user as dispatcher' });
        return;
      }
      targetName = `${target.first_name} ${target.last_name}`;
    }

    const changed = existing.dispatcher_id !== dispatcher_id;

    const job = await prisma.$transaction(async (tx) => {
      await tx.job.update({ where: { id }, data: { dispatcher_id } });

      if (changed) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'JOB',
            entity_id: id,
            event_type: 'DISPATCHER_CHANGED',
            description: dispatcher_id
              ? `${targetName} set as dispatcher on job ${existing.job_number}`
              : `Dispatcher cleared on job ${existing.job_number}`,
            created_by: req.user!.id,
          },
        });

        // #585 — mirror the change onto the originating lead's timeline (traceability).
        if (existing.estimate?.lead_id) {
          await tx.timelineEvent.create({
            data: {
              organization_id: req.user!.organization_id,
              entity_type: 'LEAD',
              entity_id: existing.estimate.lead_id,
              event_type: 'DISPATCHER_CHANGED',
              description: dispatcher_id
                ? `${targetName} set as dispatcher on job ${existing.job_number}`
                : `Dispatcher cleared on job ${existing.job_number}`,
              created_by: req.user!.id,
            },
          });
        }
      }

      // Re-read via the detail select (dispatcher-only mutation; status/schedule untouched).
      return tx.job.findUnique({ where: { id }, select: jobDetailSelect });
    });

    void logAudit({
      req,
      action: 'job.dispatcher_set',
      resourceType: 'Job',
      resourceId: id,
      metadata: { dispatcher_id },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Set job dispatcher error:', err);
    res.status(500).json({ error: 'Failed to set job dispatcher' });
  }
}

/**
 * SRVW-112 - POST /api/jobs/:id/sub-status. The ONLY writer of a non-null Job.sub_status_id.
 * (The eight status verbs also write the column, but only ever to null - see subStatusClears.)
 *
 * Two guards, in this order:
 *  1. TENANCY. The incoming id is resolved through a tenant-scoped findFirst BEFORE it is written
 *     as an FK, so a guessed uuid can never attach another org's label to a job and have it
 *     rendered on the detail page and the list. A miss answers 404, not 403, so the endpoint is
 *     not an existence oracle for other tenants' rows.
 *  2. PARENT MATCH. A sub-status whose parent differs from the job's CURRENT status is a 400.
 *     Picking a sub-status deliberately does not move the parent (unlike Workiz) - the user moves
 *     the job first, then labels it. That is what lets every status handler clear the label on a
 *     status change without ever reading sub_status.parent.
 */
export async function setSubStatus(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { sub_status_id } = req.body as z.infer<typeof setSubStatusSchema>;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, job_number: true, sub_status_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Same per-instance owner gate update() uses (#106b) - a technician with `update Job` may
    // label their OWN job, not any job in the org.
    if (!(await canAccessRow(req, 'Job', prisma.job, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let sub: { id: string; label: string; parent: JobStatus } | null = null;
    if (sub_status_id !== null) {
      sub = await prisma.jobSubStatus.findFirst({
        where: { id: sub_status_id, ...tenantWhere(req) },
        select: { id: true, label: true, parent: true },
      });
      if (!sub) {
        res.status(404).json({ error: 'Sub-status not found' });
        return;
      }
      if (sub.parent !== existing.status) {
        res.status(400).json({ error: 'That sub-status belongs to a different job status' });
        return;
      }
    }

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: { sub_status_id: sub?.id ?? null },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        // event_type is a plain String column - no enum migration needed for a new kind.
        event_type: 'JOB_SUB_STATUS_CHANGED',
        description: sub
          ? `Sub-status set to "${sub.label}" on job ${existing.job_number}`
          : `Sub-status cleared on job ${existing.job_number}`,
        metadata: { from: existing.sub_status_id, to: sub?.id ?? null },
        created_by: req.user!.id,
      },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ────────
    // "Entered" must mean a deliberate label, never the implicit clear
    // subStatusClears performs during a status change - only the SET path
    // (sub !== null) fires this, never the clear path above.
    if (sub) {
      dispatchAutomationEvent({
        type: 'JOB_SUB_STATUS_ENTERED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: sub.id,
        actorId: req.user?.id ?? null,
      });
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Set job sub-status error:', err);
    res.status(500).json({ error: 'Failed to set job sub-status' });
  }
}

/**
 * S7 (D19, D23, user story 39): the opt-out this gesture can now carry.
 *
 * The nested `notify` object, byte-identical to the three visit schemas - this route calls trips
 * off exactly as `/visits/:visitId/cancel` does, so it takes the same shape rather than /assign's
 * flat keys. Optional throughout: omitting the object preserves this endpoint's original silence,
 * which is what every non-dialog caller (the status dispatcher included) relies on.
 */
export const unassignJobSchema = z.object({
  notify: z
    .object({
      notify_customer: z.boolean().optional(),
      notify_recipient_email: z.string().email().optional(),
      notify_cc_emails: z.array(z.string().email()).max(5).optional(),
      notify_message: z.string().max(5000).optional(),
    })
    .optional(),
});

export async function unassign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { notify } = (req.body ?? {}) as {
      notify?: {
        notify_customer?: boolean;
        notify_recipient_email?: string;
        notify_cc_emails?: string[];
        notify_message?: string;
      };
    };
    const notifyCustomer = notify?.notify_customer === true;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // S7 widens this with the customer email's own fields, the same set the three visit
      // writers read. Nothing else about the select changes.
      select: {
        id: true,
        status: true,
        job_number: true,
        source_plan_id: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Per-instance crew-authority check (technician-ownership spec, Part C). The route guard
    // `canDo('unassign','Job')` is SUBJECT-level, and until this PR only DISPATCHER/ADMIN held the
    // action - both unconditionally - so no handler here ever needed a row check. A technician now
    // holds it conditioned on `created_by_id`, so without this every technician could re-crew every
    // job in the org. canActOnRow intersects that verb scope with the read scope.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'unassign'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Multi-visit S6 (D16, D19): "unscheduled" means the job has no LIVE visit left. Before this
    // slice the handler cleared the Job.scheduled_start mirror and touched no visit row at all,
    // which was invisible only because the board read the mirror - now that the board reads the
    // visit set, a surviving live trip would keep painting a card for a job the dispatcher just
    // removed, and the next syncJobFromVisits would restore the mirror from it. The row is kept
    // as CANCELLED (D19: rows are never deleted). Plain prisma, no transaction, matching the
    // PlanVisit hook below in this same handler.
    //
    // Deliberately NOT routed through syncJobFromVisits: this handler writes the job row itself,
    // by hand, and the re-derivation would fight the status it is deliberately setting.
    // Read BEFORE the write, because the write is what makes them not-live: the trip the customer
    // is about to be told about is the trip this request calls off, and after the updateMany
    // there is nothing left to name (#1522's rule - the emailed row is the persisted row).
    const cancelledTrips = await prisma.visit.findMany({
      where: { job_id: id, ...tenantWhere(req), status: { in: [...LIVE_VISIT_STATUSES] } },
      select: { id: true, visit_seq: true, scheduled_at: true, scheduled_end: true },
      orderBy: { scheduled_at: 'asc' },
    });

    await prisma.visit.updateMany({
      where: { job_id: id, ...tenantWhere(req), status: { in: [...LIVE_VISIT_STATUSES] } },
      data: {
        status: 'CANCELLED',
        cancelled_at: new Date(),
        cancelled_by: req.user!.id,
        cancelled_reason: 'Removed from schedule',
      },
    });

    // UNSCHEDULE (crew ⟂ schedule): clear the TIME only and drop to UNSCHEDULED. The crew is KEPT
    // (state 3: crewed-unscheduled). No customer email.
    // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - nothing to null
    // here any more. The live visits were already cancelled above (BEFORE this statement), so
    // this select's `visits[]` already shows no qualifying live visit and the response's computed
    // projection reads null on its own.
    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'UNSCHEDULED',
        ...subStatusClears(existing.status, 'UNSCHEDULED'),
      },
      select: jobDetailSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'UNSCHEDULED',
        description: `Job ${existing.job_number} moved to Unassigned (crew kept)`,
        created_by: req.user!.id,
      },
    });

    // Service-plan visit hook: unscheduling the visit-job frees its PlanVisit slot back to the
    // plan (CANCELLED visits are excluded from the term-scoped remaining count), so the plan
    // reappears in the scheduler bucket. Mirrors complete()'s PlanVisit hook — plain prisma (no surrounding transaction).
    //
    // B-3 (Spec B1): gated on the job NOT being COMPLETED. Free status transitions make
    // `unassign` reachable from COMPLETED — without this gate, unassigning a finished visit-job
    // as housekeeping would free its slot back to the plan (derive.ts's ACTIONED excludes
    // CANCELLED from the consumed count), handing the customer an extra visit on a fixed-visit
    // contract. The crew/schedule are still cleared either way; only the plan-visit cascade
    // is skipped for a completed visit.
    if (existing.source_plan_id && existing.status !== 'COMPLETED') {
      await prisma.planVisit.updateMany({
        where: { job_id: id, ...tenantWhere(req) },
        data: { status: 'CANCELLED' },
      });
    }

    // AWAITED and post-commit, never fatal - the same contract every other notify site has.
    // Only when there was a trip to call off: on a job whose visits were already cancelled there
    // is nothing the customer could be waiting in for, and "your visit is cancelled" naming no
    // visit at all would be a notice about nothing.
    //
    // ONE trip means the copy can name it. Several means this one gesture called off the whole
    // set, and picking one of them to name would be a lie about the other two - so the trip
    // number and its slot are left out and the notice reads as the job-wide message it is.
    const notifyResult = notifyCustomer && cancelledTrips.length > 0
      ? await notifyCustomerOfSchedule(req, {
          jobId: id,
          jobNumber: existing.job_number,
          customer: existing.customer,
          serviceLocation: existing.service_location,
          // #2175: named only when there is ONE trip to name - the same rule the slot and the
          // trip number above follow, and for the same reason: picking one of several to speak
          // for the rest would be a lie about the others.
          visitId: cancelledTrips.length === 1 ? cancelledTrips[0]!.id : null,
          crew: [],
          newStart: cancelledTrips.length === 1 ? cancelledTrips[0]!.scheduled_at : null,
          newEnd: cancelledTrips.length === 1 ? cancelledTrips[0]!.scheduled_end : null,
          kind: 'cancelled',
          visitSeq: cancelledTrips.length === 1 ? cancelledTrips[0]!.visit_seq : null,
          cancelledReason: 'Removed from schedule',
          recipientEmail: notify?.notify_recipient_email,
          cc: notify?.notify_cc_emails,
          message: notify?.notify_message,
        })
      : undefined;

    res.json({ job: await presentJobDetail(req, job), ...(notifyResult ? { notify: notifyResult } : {}) });
  } catch (err) {
    logger.error('Unassign job error:', err);
    res.status(500).json({ error: 'Failed to unassign job' });
  }
}

export async function start(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, visits: { select: { assignees: { select: { user_id: true } } } }, job_number: true, source_plan_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may start any job in their org; a technician may only start a job
    // they are assigned to (the route guard already verified the `start Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !isOnJobCrew(existing, req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // S4 (B9): the milestone is a fact about the TRIP, so the job's current visit is stamped
    // through the same writer the per-visit route uses. The job row keeps its own copy below,
    // and keeps it past S8: the bar no longer reads job.started_at, but deriveJobStatusFromVisits
    // opens with `if (jobStartedAt != null) return 'IN_PROGRESS'` for the urgent workflow - a job
    // started on the spot with no visit at all.
    const startedAt = new Date();
    await stampCurrentJobVisitMilestone(prisma, {
      jobId: id,
      orgId: req.user!.organization_id,
      milestone: 'started',
      at: startedAt,
      actorId: req.user!.id,
    });

    // B-9 (Spec B1): timeline event written BEFORE the update -- see arrive() for why.
    const clears = milestoneClears('started');
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STARTED',
        description: `Job ${existing.job_number} started`,
        metadata: Object.keys(clears).length ? { cleared: Object.keys(clears) } : undefined,
        created_by: req.user!.id,
      },
    });

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'IN_PROGRESS',
        ...subStatusClears(existing.status, 'IN_PROGRESS'),
        started_at: startedAt,
        ...clears,
      },
      select: jobDetailSelect,
    });

    if (clearsCompletion('started')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.started',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: jobCrewIds(existing),
        sold_by_id: (job as any).estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Start job error:', err);
    res.status(500).json({ error: 'Failed to start job' });
  }
}

export async function complete(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { completion_notes, signature_data, signature_ip, signature_at } = req.body;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        started_at: true,
        visits: { select: { assignees: { select: { user_id: true } } } },
        job_number: true,
        source_plan_id: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may complete any job in their org; a technician may only complete a
    // job they are assigned to (the route guard already verified the `complete Job` capability).
    const isAssignedToJob = isOnJobCrew(existing, req.user!.id);
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !isAssignedToJob) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-9 (Spec B1): timeline event written BEFORE the update -- see arrive() for why. complete()
    // moves FORWARD -- milestoneClears('completed') only un-cancels, nothing to report as cleared.
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'COMPLETED',
        description: `Job ${existing.job_number} completed`,
        created_by: req.user!.id,
      },
    });

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'COMPLETED',
        ...subStatusClears(existing.status, 'COMPLETED'),
        completed_at: new Date(),
        // A job closed out directly from a pre-IN_PROGRESS status was never `start()`ed, so
        // started_at would otherwise stay null forever — backfill it to the completion time
        // (zero duration) so duration reporting never has to handle a null start.
        started_at: existing.started_at ?? new Date(),
        // Preserve-on-omission. These are WORK PRODUCT: a signature captured on the first
        // completion is still valid on a re-completion, and the client sends no body at all
        // (JobDetailPage.tsx posts /complete with an empty body). Null-on-omission was safe
        // only while re-completing was impossible (isJobCompletable excluded COMPLETED); Spec
        // B1 removed that guard, making an empty-body re-completion a one-click way to erase a
        // signed record if this stayed null-on-omission.
        completion_notes: completion_notes !== undefined ? (completion_notes || null) : undefined,
        signature_data: signature_data !== undefined ? (signature_data || null) : undefined,
        signature_ip: signature_ip !== undefined ? (signature_ip || null) : undefined,
        signature_at: signature_at !== undefined ? (signature_at ? new Date(signature_at) : null) : undefined,
        ...milestoneClears('completed'),
      },
      select: jobDetailSelect,
    });

    // Service-plan visit hook: completing the visit-job moves its PlanVisit into History.
    // Status-only and payment-irrelevant (the plan was paid upfront).
    if (existing.source_plan_id) {
      await prisma.planVisit.updateMany({
        where: { job_id: id, ...tenantWhere(req) },
        data: { status: 'COMPLETED', completed_at: new Date() },
      });
    }

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.completed',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        assignee_ids: jobCrewIds(existing),
        sold_by_id: (job as any).estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ───────
    dispatchAutomationEvent({
      type: 'JOB_COMPLETED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id, label: existing.job_number },
      actorId: req.user?.id ?? null,
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Complete job error:', err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
}

export async function cancel(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { cancelled_reason } = req.body;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        job_number: true,
        source_plan_id: true,
        // §8 cascade inputs: the job's open invoices to void + collected money to surface.
        invoices: {
          select: {
            id: true,
            status: true,
            kind: true,
            amount_due: true,
            total_amount: true,
            payments: { where: { voided_at: null }, select: { amount: true, reference_number: true } },
            refunds: { select: { amount: true } },
          },
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Spec B1: cancellation is not terminal and every status is reachable from every state, so
    // a COMPLETED job may now be cancelled (and a CANCELLED job re-cancelled). This still
    // unconditionally voids every open invoice below with no confirmation of amounts/counts —
    // that is a KNOWN, PRE-EXISTING defect, tracked separately as #891, deliberately NOT fixed
    // in this PR. This PR only widens who can reach the existing cascade; it does not touch it.
    const invoices = existing.invoices ?? [];
    // OPEN/billable, non-terminal invoices get voided to $0 (DRAFT is delete-able, not voidable;
    // PAID/VOIDED/REFUNDED are terminal and intentionally left for the admin's §8 refund).
    const openToVoid = invoices.filter((inv) => inv.status === 'SENT' || inv.status === 'PARTIAL');
    // Collected money across ALL the job's invoices = Σ REAL non-voided payments − Σ refunds.
    // Synthetic DEPOSIT-CREDIT rows (the non-cash credit transfer invoice.create writes onto a
    // STANDARD invoice when a deposit is drawn down) are NOT new money — mirror refundInvoice's
    // NON_CREDIT_PAYMENT_FILTER and drop them, else collected_total / refund_suggested inflate by
    // the applied deposit amount. Surfaced for the admin's separate §8 refund action (default
    // refund-all) — NEVER auto-refunded here.
    const collectedTotal = Math.round(
      invoices.reduce((sum, inv) => {
        const paid = (inv.payments ?? [])
          .filter((p) => p.reference_number !== DEPOSIT_CREDIT_REFERENCE)
          .reduce((s, p) => s + Number(p.amount), 0);
        const refunded = (inv.refunds ?? []).reduce((s, r) => s + Number(r.amount), 0);
        return sum + paid - refunded;
      }, 0) * 100,
    ) / 100;
    const voidedInvoiceIds = openToVoid.map((inv) => inv.id);
    const actor = `${req.user!.first_name ?? ''} ${req.user!.last_name ?? ''}`.trim() || 'Unknown';

    // Logistic Orders (spec §14 C1/H1): resolve — PRE-TX, on the global client (pool discipline) —
    // every LO anchored to this job OR to one of the cascade-voided invoices. A DRAFT invoice is
    // NOT in openToVoid, so its LO is intentionally excluded here and unwound later by the invoice's
    // own verb (E11). A multi-anchor (job + voided-invoice) LO is surfaced by both clauses and
    // de-duplicated by returnProcessedLo's compare-and-set, never a special case (E7/E8).
    const loUnwind = await collectAnchoredLoUnwind(prisma, {
      orgId: req.user!.organization_id,
      where: voidedInvoiceIds.length
        ? [{ job_id: id }, { invoice_id: { in: voidedInvoiceIds } }]
        : { job_id: id },
      actor,
      actorUserId: req.user!.id,
    });

    const job = await prisma.$transaction(async (tx) => {
      for (const inv of openToVoid) {
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            status: 'VOIDED',
            voided_at: new Date(),
            voided_reason: 'Job cancelled',
            amount_due: 0,
          },
        });
        // Inventory P1 (§4.2): a cascade-voided invoice returns its invoice-BORN synced lines
        // in this same tx — otherwise cancelling a job with an ad-hoc-deducted invoice line
        // strands that deduction (D2). Job-copied lines on these invoices are NOT_TRACKED by
        // §5.2 construction and stay silent; the SYNCED filter IS the scope rule.
        const invSyncedLines = await tx.invoiceLineItem.findMany({
          where: { invoice_id: inv.id, stock_status: 'SYNCED' },
          select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
        });
        if (invSyncedLines.length > 0) {
          await returnSyncedLines(tx, invSyncedLines, {
            orgId: req.user!.organization_id,
            reference: `${existing.job_number} cancelled — invoice voided`,
            actor,
            actorUserId: req.user!.id,
            jobId: id,
            lineRef: 'invoice',
          });
          await tx.invoiceLineItem.updateMany({
            where: { invoice_id: inv.id, stock_status: 'SYNCED' },
            data: { stock_status: 'UNSYNCED' },
          });
        }
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'INVOICE',
            entity_id: inv.id,
            event_type: 'INVOICE_VOIDED',
            description: `Invoice voided: job ${existing.job_number} cancelled`,
            created_by: req.user!.id,
          },
        });
        // Mirror the amount_invoiced decrement for each STANDARD invoice voided (cached billing
        // tracker — only a STANDARD bill counts as billed).
        if (inv.kind === 'STANDARD') {
          await tx.job.update({
            where: { id },
            data: { amount_invoiced: { decrement: Number(inv.total_amount) } },
          });
        }
      }

      // Inventory P1 (D2 / QA-413): auto-return every SYNCED job line inside the same tx.
      // Lines stay rows; stock_status→UNSYNCED after the return so ledger + UI agree. Cancel
      // is terminal (no un-cancel verb) — sync/deduct on CANCELLED jobs is refused, so
      // UNSYNCED here can never silently re-deduct.
      const syncedLines = await tx.jobLineItem.findMany({
        where: { job_id: id, stock_status: 'SYNCED' },
        select: { id: true, quantity: true, price_book_item_id: true, stock_location_id: true },
      });
      if (syncedLines.length > 0) {
        await returnSyncedLines(tx, syncedLines, {
          orgId: req.user!.organization_id,
          reference: `${existing.job_number} cancelled`,
          actor,
          actorUserId: req.user!.id,
          jobId: id,
          lineRef: 'job',
        });
        await tx.jobLineItem.updateMany({
          where: { job_id: id, stock_status: 'SYNCED' },
          data: { stock_status: 'UNSYNCED' },
        });
      }

      // Logistic Orders (spec §14 C1/H1): PROCESSED LOs auto-return their stock and flip to
      // RETURNED; open LOs (DRAFT/PENDING_APPROVAL/APPROVED) flip to CANCELLED. returnProcessedLo
      // is the ONLY unwind path, and its CAS is what makes a multi-anchor LO return exactly once.
      await applyAnchoredLoUnwind(tx, loUnwind, { cancelOpen: true });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'JOB',
          entity_id: id,
          event_type: 'CANCELLED',
          description: `Job ${existing.job_number} cancelled`,
          metadata: { reason: cancelled_reason, collected_total: collectedTotal, voided_invoice_ids: voidedInvoiceIds },
          created_by: req.user!.id,
        },
      });

      // D19: cancelling the JOB calls off its not-yet-completed trips and leaves the completed
      // ones as history. Scoped by tenant AND job AND the live statuses - the predicate IS the
      // rule, so a completed visit's completed_at is never overwritten by a later cancellation.
      // Un-cancelling the job deliberately does NOT revive them.
      //
      // S8 (RATIFIED, A5): this now has to run BEFORE the tx.job.update below (it did not,
      // before this PR - order did not matter while the job carried its own scheduled_start/
      // scheduled_end mirror, cleared in that same write). Now that the wire keys are a
      // COMPUTED PROJECTION of `job.visits[]` read off the row `tx.job.update`'s own `select`
      // returns, that select has to run AFTER the visits it reads are already cancelled, or the
      // response served for THIS request - the one the job page hero renders - would compute the
      // projection off the pre-cancellation visit set and show a real appointment on a job that
      // was just cancelled (section 4.2 of the multi-visit QA run named this exact hazard against
      // the old mirror; the projection carries the identical risk if read at the wrong point).
      await tx.visit.updateMany({
        where: {
          ...tenantWhere(req),
          job_id: id,
          status: { in: [...LIVE_VISIT_STATUSES] },
        },
        data: {
          status: 'CANCELLED',
          cancelled_at: new Date(),
          cancelled_reason,
          cancelled_by: req.user!.id,
        },
      });

      // Service-plan visit hook: cancelling the visit-job frees its PlanVisit slot back to the
      // plan (CANCELLED visits are excluded from the term-scoped remaining count).
      if (existing.source_plan_id) {
        await tx.planVisit.updateMany({
          where: { job_id: id, ...tenantWhere(req) },
          data: { status: 'CANCELLED' },
        });
      }

      // MUST run last: its `select: jobDetailSelect` re-reads `visits[]`, and the response's
      // computed schedule projection has to see the just-cancelled state above, not a stale
      // snapshot from before this transaction's own writes.
      const updated = await tx.job.update({
        where: { id, ...tenantWhere(req) },
        data: {
          status: 'CANCELLED',
          ...subStatusClears(existing.status, 'CANCELLED'),
          cancelled_at: new Date(),
          cancelled_reason,
        },
        select: jobDetailSelect,
      });

      return updated;
    });

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.cancelled',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        // S8 (D6): `job` is the RAW jobDetailSelect row, not the presented payload - the derived
        // `assignees` wire key is added later, by presentJobDetail. Crew comes off the trips.
        assignee_ids: jobCrewIds(job),
        sold_by_id: (job as any)?.estimate?.lead?.commission_owner?.id as string | undefined,
      },
      data: { object_label: existing.job_number, cancelled_reason },
    });

    // ─── Automation Center event — post-commit, fire-and-forget (#271) ───────
    dispatchAutomationEvent({
      type: 'JOB_CANCELLED',
      organizationId: req.user!.organization_id,
      entity: { type: 'job', id, label: existing.job_number },
      actorId: req.user?.id ?? null,
      eventPayload: { mergeFields: { 'event.reason': cancelled_reason } },
    });

    // GAP-5 — collected_total/refund_suggested are money figures and live OUTSIDE the
    // presentJobDetail pricing strip; gate them behind the same read-Invoice check so a
    // pricing-restricted role (a tech granted cancel, or a DISPATCHER narrowed off Invoice) does
    // not receive them. voided_invoice_ids (operational, non-money) is always returned.
    res.json({
      job: await presentJobDetail(req, job),
      ...(canSeePricing(req) ? { collected_total: collectedTotal, refund_suggested: collectedTotal > 0 } : {}),
      voided_invoice_ids: voidedInvoiceIds,
    });
  } catch (err) {
    logger.error('Cancel job error:', err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
}

export async function reopen(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // S4: source_plan_id joins the select so the PlanVisit revert below can run.
      select: { id: true, status: true, job_number: true, source_plan_id: true, invoices: { select: { status: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Spec B1: job state and invoice state are independent under the backward-clearing rule —
    // a sent invoice stays sent when the job reopens (invoice/payment state is never touched by
    // a job-status click; it only reverses through void/refund). Every status is reachable from
    // every other, so reopen no longer requires COMPLETED nor an absent issued invoice.
    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        status: 'IN_PROGRESS',
        ...subStatusClears(existing.status, 'IN_PROGRESS'),
        completed_at: null,
        // The evidence of the terminal state goes with it. Leaving these set produced a job
        // reading In Progress while still carrying a full cancellation record, which every
        // report keyed on cancelled_at still counted as cancelled (section 4.2).
        cancelled_at: null,
        cancelled_reason: null,
      },
      select: jobDetailSelect,
    });

    // The window has to be re-derived off the visit set, or the mirror keeps pointing at a
    // trip that is still CANCELLED - J00260 read IN_PROGRESS with scheduled_start still on
    // 2026-09-21T13:00Z and its only visit called off. `deriveStatus: false` because THIS
    // handler is the human deciding the status: re-deriving would answer UNSCHEDULED off an
    // all-cancelled visit set and immediately undo the reopen.
    await syncJobFromVisits(prisma, {
      jobId: id,
      orgId: req.user!.organization_id,
      deriveStatus: false,
    });

    // Reopening CLEARS completion, so the linked service-plan visit has to come back with it -
    // exactly what start() and arrive() already do through clearsCompletion. reopen() never did,
    // so a reopened plan job left its PlanVisit COMPLETED and the plan's visits_remaining
    // permanently decremented. lib/job-milestones.ts documented this as a live bug; it is fixed
    // here because per-visit completion runs the path far more often.
    await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'JOB_REOPENED',
        description: `Job ${existing.job_number} reopened`,
        created_by: req.user!.id,
      },
    });

    // ─── In-app notification hook ───────────────────────────────────────────
    await emit({
      verb: 'job.reopened',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'JOB', id, label: existing.job_number },
      entity: {
        // S8 (D6): `job` is the RAW jobDetailSelect row, not the presented payload - the derived
        // `assignees` wire key is added later, by presentJobDetail. Crew comes off the trips.
        assignee_ids: jobCrewIds(job),
      },
      data: { object_label: existing.job_number },
    });

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Reopen job error:', err);
    res.status(500).json({ error: 'Failed to reopen job' });
  }
}

// ─── SRVW-87: one set-status door ──────────────────────

/**
 * Outer contract for POST /:id/status. Deliberately a SUPERSET of the verb schemas it feeds, and
 * deliberately NOT a superset of completeJobSchema: signature_data / signature_ip / signature_at
 * are omitted, so validate()'s bare .parse() strips them before setStatus ever runs and a
 * COMPLETED driven through this door can never carry a signature. If a technician sign-off ever
 * needs to travel this way, add the fields here on purpose - do not assume they pass through.
 */
export const setStatusSchema = z.object({
  status: z.nativeEnum(JobStatus),
  assignee_ids: z.array(z.string().uuid()).optional(),
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  is_all_day: z.boolean().optional(),
  force: z.boolean().optional(),
  completion_notes: z.string().max(5000).optional(),
  cancelled_reason: z.string().max(2000).optional(),
});

type StatusVerb = {
  action: Action;
  handler: (req: Request, res: Response) => Promise<void>;
  // Optional because unassign/en-route/arrive/start carry no validate() on their routes and have
  // no schema to name (job.routes.ts) - a required field would not compile.
  schema?: z.ZodTypeAny;
};

/**
 * Target status -> the verb that owns it. `reopen` is deliberately unmapped: IN_PROGRESS routes
 * into start(), which already nulls completed_at via milestoneClears('started') AND reverts the
 * linked PlanVisit, which reopen() does not - strictly the more correct of the two doors. A
 * caller who needs reopen()'s exact semantics keeps using POST /:id/reopen.
 */
const STATUS_VERBS: Record<JobStatus, StatusVerb> = {
  SCHEDULED: { action: 'assign', handler: assign, schema: assignJobSchema },
  UNSCHEDULED: { action: 'unassign', handler: unassign },
  IN_PROGRESS: { action: 'start', handler: start },
  COMPLETED: { action: 'complete', handler: complete, schema: completeJobSchema },
  CANCELLED: { action: 'cancel', handler: cancel, schema: cancelJobSchema },
};

/**
 * POST /api/jobs/:id/status - set a job's status through ONE endpoint instead of eight verb
 * routes. It is a pure DISPATCHER: it contains no job.update of its own, so every milestone
 * stamp, timeline event, notification emit and automation dispatch fires exactly as it does
 * through the verb route, including start()'s own per-instance crew check.
 *
 * Authorization is per verb, not per endpoint. The route's outer gate is the coarse `read Job`
 * (every role default and per-user capability that grants a Job verb also implies read, so a
 * stricter outer gate would falsely 403 a holder of a verb without `update Job`); the REAL check
 * is the can(spec.action, 'Job') below, reproducing canGuard exactly. This endpoint can therefore
 * never be a permission-escalation shortcut around the verb routes.
 *
 * Two target statuses have consequences worth stating before anyone uses them:
 *
 *  - SCHEDULED routes into assign(), and the window is NEVER inherited from the job row. A body
 *    with no `scheduled_start` 400s. That is required for SAFETY - inheriting the job's own
 *    window would hand assign() a truthy scheduled_start, firing milestoneClears('scheduled')
 *    (nulling en_route_at/on_site_at/started_at/completed_at/cancelled_at/cancelled_reason) plus
 *    revertPlanVisitOnUncomplete, so `{"status":"SCHEDULED"}` - a body that reads like a label
 *    change - would silently un-complete a finished, paid job. It is also required for HONESTY:
 *    without a scheduled_start, assign() keeps `existing.status`, so a 200 would be a lie.
 *    WITH an explicit window, SCHEDULED is byte-identical to POST /:id/assign with the same body,
 *    milestone rewind included - Spec B1's documented backward-move policy, not new capability
 *    (both doors gate on `assign Job`), and deliberately NOT the PATCH semantics of
 *    deriveStatusOnReschedule. `assignee_ids` defaults to the job's CURRENT crew, because
 *    assignJobSchema requires the array and it is REPLACE semantics - omitting it must not empty
 *    the crew.
 *
 *  - UNSCHEDULED routes into unassign(), which nulls scheduled_start/scheduled_end. Callers get
 *    UNSCHEDULE semantics (crew kept), not a bare relabel.
 */
export async function setStatus(req: Request, res: Response) {
  try {
    const {
      status, assignee_ids, scheduled_start, scheduled_end, is_all_day, force,
      completion_notes, cancelled_reason,
    } = req.body as z.infer<typeof setStatusSchema>;

    const spec = STATUS_VERBS[status];

    // The real authorization: the target VERB's own action, not this endpoint's.
    if (!req.ability?.can(spec.action, 'Job')) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let verbBody: Record<string, unknown> = {};

    if (status === 'SCHEDULED') {
      if (!scheduled_start) {
        res.status(400).json(validationFailure([{
          field: 'scheduled_start',
          message: 'scheduled_start is required to set a job SCHEDULED (the job current window is never reused)',
        }]));
        return;
      }

      let crew = assignee_ids;
      if (crew === undefined) {
        const existing = await prisma.job.findUnique({
          where: { id: param(req, 'id'), ...tenantWhere(req) },
          select: { id: true, visits: { select: { assignees: { select: { user_id: true } } } } },
        });
        if (!existing) {
          res.status(404).json({ error: 'Job not found' });
          return;
        }
        crew = jobCrewIds(existing);
      }

      verbBody = {
        assignee_ids: crew,
        scheduled_start,
        ...(scheduled_end !== undefined ? { scheduled_end } : {}),
        ...(is_all_day !== undefined ? { is_all_day } : {}),
        ...(force !== undefined ? { force } : {}),
      };
    } else if (status === 'COMPLETED') {
      verbBody = completion_notes !== undefined ? { completion_notes } : {};
    } else if (status === 'CANCELLED') {
      // Left undefined when omitted so cancelJobSchema produces its own "reason is required" 400.
      verbBody = { cancelled_reason };
    }

    if (spec.schema) {
      const parsed = spec.schema.safeParse(verbBody);
      if (!parsed.success) {
        res.status(400).json(zodValidationFailure(parsed.error));
        return;
      }
      verbBody = parsed.data as Record<string, unknown>;
    }

    req.body = verbBody;
    await spec.handler(req, res);
  } catch (err) {
    logger.error('Set job status error:', err);
    res.status(500).json({ error: 'Failed to set job status' });
  }
}

// ─── Technician Mobile Status Actions ─────────────────

export async function enRoute(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        // Crew (M2M): user_id for the access check + first member's name for the email.
        // S8 (D6): crew through the trips.
        visits: { select: { assignees: { select: { user_id: true, user: { select: { first_name: true } } } } } },
        job_number: true,
        customer: { select: { id: true, email: true, first_name: true, company_name: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may advance any job in their org; a technician may only advance a job
    // they are assigned to (the route guard already verified the `en_route Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !isOnJobCrew(existing, req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const enRouteAt = new Date();
    // S4 (B9): stamp the job's current visit, same writer as the per-visit /en-route route. The
    // automation's occurrenceKey below is this same instant, so the emitted key IS the persisted
    // stamp on both rows.
    //
    // The RETURN VALUE is the trip that was stamped, and the dispatch below needs it: this writer
    // resolves the job's CURRENT trip and the automation context resolves the job's NEXT one. See
    // stampedVisitOccurrence.
    const stampedVisitId = await stampCurrentJobVisitMilestone(prisma, {
      jobId: id,
      orgId: req.user!.organization_id,
      milestone: 'en_route',
      at: enRouteAt,
      actorId: req.user!.id,
    });

    // S4 (D12/D17): being on the way is a fact about the TRIP, stamped on the visit above. The
    // job's OWN status does not move - EN_ROUTE has retired from JobStatus, and D12 makes
    // IN_PROGRESS mean "any visit STARTED", which this is not. S8 (RATIFIED): the job row's OWN
    // en_route_at mirror is DROPPED outright (S5 already repointed the lifecycle bar onto the
    // visit set, leaving it with no reader anywhere) - there is nothing left to write at the job
    // level, so this is a plain re-read for the response, not an update.
    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: jobDetailSelect,
    });
    // Defensive: the row existed a moment ago (`existing`, above) and nothing here can delete it,
    // but a bare re-read (unlike the .update() this replaced) fails silently on a vanished row
    // rather than throwing - keep the same 404 shape every other handler in this file gives a
    // gone-between-reads job, rather than trusting presentJobDetail's null path to a 200.
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STATUS_CHANGED',
        description: `Technician is on the way for job ${existing.job_number}`,
        created_by: req.user!.id,
      },
    });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    // Crew-gated to match the hard-coded sender this replaced, which required a
    // named technician to send at all. The default automation tells the customer
    // who is on the way, so dispatching with an empty crew would email them a
    // notification naming nobody.
    //
    // THE CREW GATE IS THE JOB'S UNION, not the stamped trip's crew, and that is deliberate - the
    // per-visit door next to it gates on the one trip. Narrowing it here would SILENCE an email
    // that sends today for any organisation that books trips without per-visit crew, which is a
    // behaviour change for live automations rather than a fix. What the override below does change
    // is that a crewless current trip now renders "Our team" instead of naming a technician who is
    // on a different one - more honest than today, and it silences nothing.
    if (jobCrewIds(existing).length > 0) {
      // D18 + visit-location slice 4, extended to the JOB-LEVEL door - the half #2082's structural
      // test could not reach, because this dispatch named no visit at all.
      //
      // Without the override this occurrence falls back to context.ts's per-ENTITY resolution:
      // `resolveNextJobVisit`, the earliest still-UPCOMING trip. The stamp above used
      // `resolveCurrentJobVisit`, "already begun beats not-yet-begun". A crew running past their
      // slot - visit 1 booked 09:00-11:30 and visit 2 next week, pressed at 11:45 - stamps visit 1
      // and used to mail visit 2's date; and since {{job.visit_location}} rides the same
      // resolution, that is the wrong ADDRESS beside the wrong time.
      //
      // BOTH OR NEITHER, on one gate. Naming the visit in the dedupe key and then rendering the
      // JOB's fields is the inverse of this fix, and is exactly what job-visit-location.test.ts's
      // enumeration fails on. A job holding no live visit resolves to null and dispatches as it
      // always did - per entity, which is the right answer when there is no trip to be about.
      //
      // The visit id rides the DEDUPE key only (dedupe.ts), leaving occurrence_key the bare ISO
      // the stale-checks read it as. Nothing in flight moves: JOB_EN_ROUTE's occurrence is a
      // millisecond stamp minted at press time, so a new key cannot collide with a historical one
      // under either format - the reasoning dedupe.ts records for this trigger by name.
      const stamped = stampedVisitId
        ? await stampedVisitOccurrence(req, stampedVisitId, existing.service_location)
        : null;
      dispatchAutomationEvent({
        type: 'JOB_EN_ROUTE',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: enRouteAt.toISOString(),
        ...(stamped
          ? { visitId: stamped.visitId, eventPayload: { mergeFields: stamped.mergeFields } }
          : {}),
        actorId: req.user?.id ?? null,
      });
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('On-the-way job error:', err);
    res.status(500).json({ error: 'Failed to mark job on the way' });
  }
}

export async function arrive(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, status: true, visits: { select: { assignees: { select: { user_id: true } } } }, job_number: true, source_plan_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Admins/dispatchers may advance any job in their org; a technician may only advance a job
    // they are assigned to (the route guard already verified the `arrive Job` capability).
    const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
    if (!isOrgManager && !isOnJobCrew(existing, req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // B-9 (Spec B1): the timeline event is written BEFORE the update, not after -- so a crash
    // between the two never leaves a status change with no audit trail. Its metadata records
    // what a backward move actually cleared (the spec's own ask), empty for a forward move.
    // S4 (B9): stamp the job's current visit, same writer as the per-visit /arrive route.
    const onSiteAt = new Date();
    await stampCurrentJobVisitMilestone(prisma, {
      jobId: id,
      orgId: req.user!.organization_id,
      milestone: 'on_site',
      at: onSiteAt,
      actorId: req.user!.id,
    });

    const clears = milestoneClears('on_site');
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'JOB',
        entity_id: id,
        event_type: 'STATUS_CHANGED',
        description: `Technician arrived on site for job ${existing.job_number}`,
        metadata: Object.keys(clears).length ? { cleared: Object.keys(clears) } : undefined,
        created_by: req.user!.id,
      },
    });

    // S4 (D12): `clears` is erasing the job's own started_at / completed_at / cancelled_at, so the
    // status those columns justified has to be re-derived from what is left - the visit set, with
    // the job's start stamp gone. Without this a backward move off a terminal state clears
    // cancelled_reason and leaves `status` at CANCELLED (a job reading Cancelled with no record of
    // why, which nothing re-derives), and a backward move off IN_PROGRESS leaves the board
    // colouring the job in flight after the dispatcher corrected it.
    //
    // Read AFTER the visit stamp above, so the rewind that stamp performs is already in the set.
    // A job holding no visits at all keeps its status untouched unless it is leaving a terminal
    // one: there is nothing to derive from, and demoting a legacy row to UNSCHEDULED on an
    // arrival press would drop it off the board.
    const visitsAfterStamp = await prisma.visit.findMany({
      where: { organization_id: req.user!.organization_id, job_id: id },
      select: { status: true, started_at: true },
    });
    const leavingTerminal = existing.status === 'COMPLETED' || existing.status === 'CANCELLED';
    const derivedStatus =
      visitsAfterStamp.length > 0 || leavingTerminal
        ? deriveJobStatusFromVisits(visitsAfterStamp, null)
        : undefined;

    const job = await prisma.job.update({
      where: { id, ...tenantWhere(req) },
      data: {
        // S4 (D12/D17): arriving is a fact about the TRIP, stamped on the visit above. ON_SITE has
        // retired from JobStatus and arriving is not starting, so the job never reads ON_SITE -
        // whatever it reads now comes from the derivation above. `clears` rewinds HISTORY on top
        // of that: the later stamps go, and the job is un-cancelled. S8 (RATIFIED): the job row's
        // OWN on_site_at mirror is DROPPED outright - nothing writes it here any more.
        ...clears,
        ...(derivedStatus !== undefined
          ? { status: derivedStatus, ...subStatusClears(existing.status, derivedStatus) }
          : {}),
      },
      select: jobDetailSelect,
    });

    if (clearsCompletion('on_site')) {
      await revertPlanVisitOnUncomplete(req, id, existing.source_plan_id);
    }

    res.json({ job: await presentJobDetail(req, job) });
  } catch (err) {
    logger.error('Arrive job error:', err);
    res.status(500).json({ error: 'Failed to mark job on-site' });
  }
}

// ─── Bulk actions (SRVW-104) ────────────────────────────
//
// Both endpoints are a sequential per-id loop invoking the EXISTING single-job verb handlers
// in-process (never Promise.all - cancel() opens a $transaction and resolves its Logistic Order
// unwind pre-transaction on the global client, for pool discipline). TimelineEvent,
// milestoneClears, revertPlanVisitOnUncomplete, PlanVisit cascades, emit() and
// dispatchAutomationEvent are reproduced BY CONSTRUCTION - zero lines inside those handlers
// change. No prisma.job.updateMany anywhere in this file.

/**
 * Run `handler` once per id, in-process, reusing its entire guard sequence, business rules and
 * side effects. Each id gets its own canAccessRow('Job') check FIRST (tighter than some of the
 * single-job doors - cancel() and setAssignees() have no per-instance check at all - deliberate
 * hardening, not a bug) and its own try/catch (isolation contract from estimate.controller.ts's
 * bulkRemove: one id's failure never aborts the rest of the batch).
 */
async function runJobVerbBatch(
  req: Request,
  ids: string[],
  body: Record<string, unknown>,
  handler: (req: Request, res: Response) => Promise<void>,
  fallbackError: string,
): Promise<{ updated: { id: string; payload: any }[]; failed: { id: string; error: string }[] }> {
  const updated: { id: string; payload: any }[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of ids) {
    try {
      if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
        failed.push({ id, error: 'Insufficient permissions' });
        continue;
      }

      const subReq = Object.assign(Object.create(req) as Request, {
        params: { ...req.params, id },
        body,
      });
      // `code` MUST initialise to 200 - every success path in the six handlers calls
      // `res.json()` with NO preceding `res.status()`, so an uninitialised code would
      // classify every success as a failure.
      let code = 200;
      let payload: any;
      const subRes = {
        status(c: number) { code = c; return this; },
        json(b: any) { payload = b; return this; },
      } as unknown as Response;

      await handler(subReq, subRes);

      if (code >= 200 && code < 300) {
        updated.push({ id, payload });
      } else {
        failed.push({ id, error: payload?.error ?? fallbackError });
      }
    } catch (err) {
      logger.error(`Bulk job action error for ${id}:`, err);
      failed.push({ id, error: fallbackError });
    }
  }

  return { updated, failed };
}

const BULK_STATUS_VERBS: Record<string, { action: Action; handler: (req: Request, res: Response) => Promise<void> }> = {
  // IN_PROGRESS maps to start(), not reopen(): milestoneClears('started') nulls completed_at and
  // start() then calls revertPlanVisitOnUncomplete, which reopen() does not (job-milestones.ts).
  arrive: { action: 'arrive', handler: arrive },
  start: { action: 'start', handler: start },
  complete: { action: 'complete', handler: complete },
  cancel: { action: 'cancel', handler: cancel },
};

export async function bulkStatus(req: Request, res: Response) {
  try {
    const { ids, action, cancelled_reason } = req.body as z.infer<typeof bulkStatusJobsSchema>;
    const verb = BULK_STATUS_VERBS[action];

    // The authoritative verb gate lives HERE, not on the route: the route is gated `read Job`
    // (coarse, needed because the ability varies per request body), and canGuard.ts's canDo is a
    // bare `req.ability!.can(action, subject)` - this is byte-equivalent to a route gate on the
    // verb's own action.
    if (!req.ability!.can(verb.action, 'Job' as Subject)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const body = action === 'cancel' ? { cancelled_reason } : {};
    const { updated, failed } = await runJobVerbBatch(req, ids, body, verb.handler, `Failed to ${action} job`);

    const responseBody: Record<string, unknown> = {
      updated: updated.map((u) => u.id),
      failed,
    };

    // Reviewer objection 3 fix: cancel() already returns voided_invoice_ids unconditionally and
    // collected_total/refund_suggested behind canSeePricing(req) - the shim already holds that
    // payload, so aggregate it across the batch rather than discarding it on success. The money
    // gate is preserved because every call in the batch shares one `req`.
    if (action === 'cancel') {
      responseBody.voided_invoice_ids = updated.flatMap((u) => u.payload?.voided_invoice_ids ?? []);
      if (canSeePricing(req)) {
        responseBody.collected_total = updated.reduce((sum, u) => sum + Number(u.payload?.collected_total ?? 0), 0);
      }
    }

    res.json(responseBody);
  } catch (err) {
    logger.error('Bulk job status error:', err);
    res.status(500).json({ error: 'Failed to update job status' });
  }
}

export async function bulkAssign(req: Request, res: Response) {
  try {
    const { ids, assignee_ids, notify } = req.body as z.infer<typeof bulkAssignJobsSchema>;
    const { updated, failed } = await runJobVerbBatch(
      req,
      ids,
      { assignee_ids, notify },
      setAssignees,
      'Failed to assign job',
    );
    res.json({ updated: updated.map((u) => u.id), failed });
  } catch (err) {
    logger.error('Bulk job assign error:', err);
    res.status(500).json({ error: 'Failed to assign jobs' });
  }
}

// ─── Notes ─────────────────────────────────────────────

export async function getNotes(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'JOB', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // `include_lead` is the current name; `include_walkthrough` stays as a working alias.
    const includeLead = req.query.include_lead === 'true' || req.query.include_walkthrough === 'true';

    if (!includeLead) {
      res.json({ notes });
      return;
    }

    // Tag existing job notes with source
    const jobNotes = notes.map((n) => ({ ...n, source: 'JOB' as const }));

    // Resolve the originating lead. Job.lead_id is the direct pointer written at conversion;
    // the estimate hop remains as a fallback for pre-column jobs. Same resolution as
    // attachment.controller.ts listAttachments — the two must not drift apart.
    const jobRow = await prisma.job.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { lead_id: true, estimate: { select: { lead_id: true } } },
    });
    const leadId = jobRow?.lead_id ?? jobRow?.estimate?.lead_id ?? null;

    if (!leadId) {
      res.json({ notes: jobNotes });
      return;
    }

    const wtNotes = await prisma.note.findMany({
      where: { entity_type: 'LEAD', entity_id: leadId, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes: [...jobNotes, ...wtNotes.map((n) => ({ ...n, source: 'LEAD' as const }))] });
  } catch (err) {
    logger.error('Get job notes error:', err);
    res.status(500).json({ error: 'Failed to get notes' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById). NOTE: the route guard for
    // addNote is canDo('update','Job'); the per-instance scope is still derived from the read-Job
    // grant (canAccessRow), matching how update()/the lifecycle verbs bind ownership.
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'JOB',
        entity_id: id,
        content: req.body.content,
        created_by: req.user!.id,
        organization_id: req.user!.organization_id,
      },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    res.status(201).json({ note });
  } catch (err) {
    logger.error('Add job note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}

// ─── Timeline ──────────────────────────────────────────

export async function getTimeline(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // GAP-1 — grant/override-aware per-instance gate (see getById).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Spec B2 N6 — the job's story includes what happened to its invoices. Sending an invoice and
    // recording a payment both write entity_type 'INVOICE' (invoice.controller.ts:666, :1534),
    // so a JOB-only filter left every money event invisible on the job. Widening the read beats
    // writing duplicate JOB-entity events, which would double-count on the invoice's timeline.
    //
    // Gated on canSeePricing: these descriptions embed dollar figures — "Payment of $900.00
    // received via CASH" — and redactTimelineMoneyForRequester only strips METADATA keys, never
    // prose. For a price-blind requester the events are not fetched at all (Spec A D13).
    const invoiceIds = canSeePricing(req)
      ? (await prisma.invoice.findMany({
          where: { job_id: id, ...tenantWhere(req) },
          select: { id: true },
        })).map((i) => i.id)
      : [];

    const events = await prisma.timelineEvent.findMany({
      where: {
        ...tenantWhere(req),
        OR: [
          { entity_type: 'JOB', entity_id: id },
          ...(invoiceIds.length ? [{ entity_type: 'INVOICE', entity_id: { in: invoiceIds } }] : []),
        ],
      },
      select: {
        id: true,
        event_type: true,
        description: true,
        metadata: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // GAP-5 — strip monetary metadata (e.g. cancel()'s collected_total) for a non-pricing reader.
    res.json({ events: redactTimelineMoneyForRequester(events, req) });
  } catch (err) {
    logger.error('Get job timeline error:', err);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
}

// ─── Stats ─────────────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    // GAP-3 — the status counts must be scoped to the requester the SAME way the job LIST is, or a
    // row-scoped role (TECHNICIAN/SALES) reads ORG-WIDE counts here while the list shows only its
    // own. scopeWhereForReq returns {} for ADMIN/unconditional-read (counts stay org-wide), the
    // owner/team/location condition for a conditional read grant, or MATCH_NOTHING (fail-closed).
    const rowScope = await scopeWhereForReq(req, 'Job');
    const orgWhere = { ...tenantWhere(req), ...rowScope };
    const [unassignedCount, scheduledCount, inProgressCount, completedCount, cancelledCount] = await Promise.all([
      prisma.job.count({ where: { ...orgWhere, status: 'UNSCHEDULED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'SCHEDULED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'IN_PROGRESS' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'COMPLETED' } }),
      prisma.job.count({ where: { ...orgWhere, status: 'CANCELLED' } }),
    ]);

    res.json({
      unassigned: unassignedCount,
      scheduled: scheduledCount,
      // S4 (D17): EN_ROUTE/ON_SITE are gone from JobStatus, so there is nothing left to fold -
      // a job whose crew is on the way or on site derives SCHEDULED or IN_PROGRESS on its own.
      in_progress: inProgressCount,
      completed: completedCount,
      cancelled: cancelledCount,
    });
  } catch (err) {
    logger.error('Get job stats error:', err);
    res.status(500).json({ error: 'Failed to get job stats' });
  }
}

// Job-level walkthrough REMOVED (scheduler redesign §5.8): it was the sole writer of
// the legacy job walkthrough FK (dropped in TG7). No replacement — walkthroughs live on the lead.

// ─── Duplicate ─────────────────────────────────────────

export async function duplicate(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const source = await prisma.job.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        job_number: true,
        customer_id: true,
        service_location_id: true,
        scope_notes: true,
        job_type: true,
        estimated_duration: true,
        // job-owns-tax-discount (E1) - the duplicate is a fresh standalone job (see "NOT copied"
        // below), so its tax_rate is looked up fresh too, not copied from the source.
        service_location: { select: { state: true } },
        // ownership relations are no longer fetched here — canAccessRow gates access via its own
        // scoped query, and the duplicate explicitly does NOT copy assignees (see below).
      },
    });
    if (!source) { res.status(404).json({ error: 'Job not found' }); return; }
    // GAP-1 — per-instance gate via the grant/override-aware canAccessRow (replaces the old
    // role-literal canAccessJob, which hardcoded ADMIN||DISPATCHER → true and ignored grants).
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const job = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const jobNumber = await allocateNumber(tx, 'job', req.user!.organization_id);
      const taxRate = await resolveTaxRateForState(tx, req.user!.organization_id, source.service_location?.state ?? null);
      const j = await tx.job.create({
        data: {
          job_number: jobNumber,
          organization_id: req.user!.organization_id,
          customer_id: source.customer_id,
          service_location_id: source.service_location_id,
          scope_notes: source.scope_notes,
          job_type: source.job_type,
          estimated_duration: source.estimated_duration,
          status: 'UNSCHEDULED',
          tax_rate: taxRate,
          // NOT copied: estimate_id (standalone), discount, schedule, assignees, invoices.
          // Audit: whoever pressed Duplicate owns the new row's provenance, not the source's creator.
          ...createdByUser(req),
        },
        select: jobDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'JOB',
          entity_id: j.id,
          event_type: 'CREATED',
          description: `Job ${jobNumber} created (duplicated from ${source.job_number})`,
          created_by: req.user!.id,
        },
      });
      return j;
    }), { label: 'job.duplicate' });
    res.status(201).json({ job: await withTags(req, job) });
  } catch (err) {
    logger.error('Duplicate job error:', err);
    res.status(500).json({ error: 'Failed to duplicate job' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/jobs/:id/invoices — SERV10X-38 Task 5: explicit "Create Invoice" from a
// job's owned items (JobLineItem). Bills the job's line-item total either as a flat
// DRAW (amount/percent → one summary line) or ITEMIZED (lineIds → copies job lines onto
// the new invoice's InvoiceLineItem rows with a job_line_item_id back-pointer). Multiple
// invoices per job are allowed and over-billing is allowed too: Spec B1 (afdc77e0d) deleted
// BOTH the "one active invoice" guard and the over-bill guard on purpose, because this door
// bills PART of a job and is repeatable by design. The only dedupe here is SRVW-85's
// already-billed-line 409 on the ITEMIZED path (a draw line carries no job_line_item_id, so
// draws can never trip it). The whole-job door, POST /api/invoices { job_id }, keeps its own
// one-active 409 precisely because it bills everything in one document. A PAID estimate deposit
// is drawn down as credit through lib/deposit-credit, shared with that door; the single-credit
// guard is INHERENT (remainingDepositCredit only ever returns unapplied credit).
// Gate: canDo('create','Invoice') at the route + per-instance canAccessRow(Job) here.
// ════════════════════════════════════════════════════════════════════════════
export const createInvoiceFromJobSchema = z.object({
  amount: z.number().positive().optional(),
  percent: z.number().positive().max(100).optional(),
  lineIds: z.array(z.string().uuid()).nonempty().optional(),
  description: z.string().max(5000).optional(),
}).refine(
  (b) => [b.amount, b.percent, b.lineIds].filter((v) => v !== undefined).length === 1,
  { message: 'Provide exactly one of amount, percent, or lineIds' },
);

// Parent-job select: billing inputs (job_line_items/scopes/invoices, for computeJobBilling's
// over-bill guard) + the estimate id (to look up a PAID deposit invoice to draw down).
const jobInvoiceGuardSelect = {
  id: true,
  job_number: true,
  status: true,
  source_plan_id: true,
  customer: { select: { id: true, tax_exempt: true } },
  job_line_items: {
    select: {
      id: true,
      description: true,
      quantity: true,
      unit_price: true,
      is_taxable: true,
      line_total: true,
      item_type: true,
      price_book_item_id: true,
      // SRVW-85: the invoice cost basis. Both doors copy these onto the InvoiceLineItem so the
      // same work billed either way carries the same cost/margin.
      unit_cost: true,
      markup_percent: true,
    },
    // Without an orderBy Postgres returns physical row order, so the `sequence: idx + 1`
    // renumbering below would differ between two identical requests - the same class of bug the
    // linked_estimates orderBy already fixes.
    orderBy: { sequence: 'asc' },
  },
  // Flat-priced, non-line-item scope-of-work blocks (scopes.ts) — folded into the over-bill
  // guard below so a job with priced scope-of-work can't be drawn down past its true total.
  scopes: true,
  invoices: { select: { total_amount: true, voided_at: true } },
  // E1/E2 (job-owns-tax-discount) - the from-job invoice inherits tax/discount straight off the
  // JOB now, not through an attached estimate. discount_type/discount_value (not the frozen
  // discount_amount) because this door can bill an ITEMIZED SUBSET of the job's items - the
  // discount is resolved as a RATE against THAT subtotal, same as tax_rate. See the derivation
  // below.
  tax_rate: true,
  discount_type: true,
  discount_value: true,
  // SERV10X-61 Task 10: a job can have MULTIPLE attached estimates (EstimateJobLink), each with
  // its own PAID deposit, IN ADDITION TO its 1:1 provenance estimate (JobPrimaryEstimate above).
  // Both feed the deposit draw-down; loaded here so the union is resolved from a single query.
  // Tax/discount role retired (E5) - id only.
  estimate: { select: { id: true } },
  linked_estimates: { select: { id: true } },
} as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function createInvoiceFromJob(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const body = req.body as z.infer<typeof createInvoiceFromJobSchema>;

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: jobInvoiceGuardSelect,
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    // Spec B1: cancellation is not terminal, so a cancelled job that gets revived — or one
    // cancelled after work was genuinely done — still bills. Every job status can be invoiced.
    if (job.source_plan_id) {
      res.status(400).json({ error: 'This job is a service plan visit and cannot be invoiced — the plan was already paid upfront.' });
      return;
    }
    // Per-instance owner check (grant-driven SQL scope) — the route's canDo is subject-level only.
    if (!(await canAccessRow(req, 'Job', prisma.job, job.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // {total, invoiced, remaining} against the job's line-item total (untaxed — tax is a
    // per-invoice add-on that doesn't shrink how much of the underlying work is left to bill).
    const billing = computeJobBilling({
      lines: job.job_line_items.map((l) => ({
        quantity: Number(l.quantity),
        unit_price: Number(l.unit_price),
        is_taxable: l.is_taxable,
      })),
      scopes: toScopeForTotals(asScopeArray(job.scopes)),
      // Task 10b + D2: stays PRE-TAX and PRE-DISCOUNT on purpose. This drives the over-bill basis
      // + the percent-draw basis; tax and discount are both added once to the invoice totals
      // below (step 3), itemized-only. Applying either here too would double-count it against the
      // now-taxed/discounted invoice - the percent draw is a percent of the pre-tax, pre-discount
      // job total, then tax/discount are layered on top only for an itemized bill.
      taxRate: 0,
      taxExempt: job.customer?.tax_exempt ?? false,
      discountType: null,
      discountValue: null,
      invoices: job.invoices.map((i) => ({ total_amount: Number(i.total_amount), voided_at: i.voided_at })),
    });

    // Flat draw (amount/percent of the job total) OR itemized (lineIds → copy those job
    // lines onto the invoice with a job_line_item_id back-pointer). The schema's refine
    // already guarantees exactly one of the three is present.
    const drawAmount = body.amount != null
      ? body.amount
      : body.percent != null
        ? round2(billing.total * (body.percent / 100))
        : null;

    const pickedLines = body.lineIds
      ? job.job_line_items.filter((l) => body.lineIds!.includes(l.id))
      : [];
    if (body.lineIds && pickedLines.length !== body.lineIds.length) {
      res.status(400).json({ error: 'One or more lineIds do not belong to this job' });
      return;
    }

    // SRVW-85 - ALREADY-BILLED LINE GUARD, itemized path only. Both doors now bill the same
    // JobLineItem rows, so without this the same line could sit on two live invoices at once.
    // Deliberately NOT the one-active-invoice guard Spec B1 removed: it keys on job_line_item_id,
    // which a flat/percent DRAW line never carries, so progress draws are untouched and
    // over-billing stays legal. VOIDED invoices are excluded, so void-and-reissue still works.
    // InvoiceLineItem has NO organization_id column, so the tenancy anchor is the nested `invoice`
    // relation - that is where the org lives.
    // Disclosed, not fixed: this read is pre-transaction, so two concurrent itemized requests for
    // the same lineIds can both pass. That matches the shape of this door's other pre-tx checks
    // and respects Spec B1's deliberate removal of the in-tx TOCTOU re-check.
    if (body.lineIds) {
      const alreadyBilled = await prisma.invoiceLineItem.findMany({
        where: {
          job_line_item_id: { in: body.lineIds },
          invoice: { job_id: job.id, status: { not: 'VOIDED' }, ...tenantWhere(req) },
        },
        select: { job_line_item_id: true, invoice: { select: { invoice_number: true } } },
      });
      if (alreadyBilled.length > 0) {
        const numbers = [...new Set(alreadyBilled.map((l) => l.invoice.invoice_number))].join(', ');
        res.status(409).json({
          error: `One or more of these lines are already billed on invoice ${numbers}. Void that invoice or pick different lines.`,
        });
        return;
      }
    }

    const itemizedTotal = round2(pickedLines.reduce((sum, l) => sum + Number(l.line_total), 0));
    const proposedTotal = drawAmount != null ? drawAmount : itemizedTotal;

    // Over-billing is deliberately NOT blocked (Spec B1). A job's billable-line total is an
    // estimate of the work, not a ceiling on what may be invoiced: work grows on site, change
    // orders happen verbally, and an invoice raised outside the system has no arithmetic
    // relationship to the job's lines at all. `billing.remaining` is still returned and is shown
    // in the UI as a default and a reference — it just never blocks a submit.

    const invoice = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);

      let lineData: Prisma.InvoiceLineItemCreateWithoutInvoiceInput[];
      if (drawAmount != null) {
        const drawTotal: number = drawAmount;
        lineData = [{
          sequence: 1,
          description: body.description || 'Progress payment',
          quantity: 1,
          unit_price: drawTotal,
          is_taxable: false,
          line_total: drawTotal,
        }];
      } else {
        // SRVW-85: shared with invoice.controller.create()'s itemized path, so the two doors write
        // identical InvoiceLineItem rows for the same JobLineItem.
        lineData = pickedLines.map(jobLineToInvoiceLineCreate);
      }

      // E1 (job-owns-tax-discount): the from-job invoice inherits the JOB's own tax rate -
      // still editable on the invoice afterward. Applies to both the draw and itemized paths:
      // a tax RATE is subset-agnostic, so the same rate is correct whether this bills the whole
      // job or a lineIds subset of it.
      const taxRate = Number(job.tax_rate);

      // E2: the discount carries the SAME way as tax, itemized-only. A flat/percent DRAW is a
      // user-specified amount, orthogonal to the underlying items' pricing - it must not be
      // discounted a second time on top of whatever the user already typed. Resolved as a RATE
      // (discount_type/discount_value) against THIS itemized subtotal, not the job's frozen
      // discount_amount - this door can bill a SUBSET of the job's items, and the frozen
      // whole-job amount could exceed a small subset's subtotal.
      const discountType = drawAmount == null ? job.discount_type : null;
      const discountValue = drawAmount == null && job.discount_value != null
        ? Number(job.discount_value)
        : null;

      // Taxed + discounted totals via the shared calculator (mirrors invoice.controller.create()).
      // Itemized picked lines keep their copied is_taxable, so they carry the estimate's tax per
      // line; the flat/percent DRAW line is is_taxable:false, so a flat progress draw shows the
      // rate but taxes $0 (intended, editable). subtotal (pre-tax, pre-discount) == the old
      // untaxed/undiscounted total.
      const totals = recomputeInvoiceTotals({
        // lineData always sets is_taxable (false for the DRAW line, the copied flag for itemized);
        // `?? false` only narrows the Prisma create-input's optional type - never hit at runtime.
        lines: lineData.map((l) => ({ quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable ?? false })),
        taxRate,
        taxExempt: job.customer?.tax_exempt ?? false,
        discountType,
        discountValue,
      });
      const subtotal = totals.subtotal;
      const discountAmount = totals.discount_amount;
      const taxAmount = totals.tax_amount;
      const invoiceTotal = totals.total_amount; // subtotal - discount + tax (tax-inclusive) - what the customer owes

      // Deposit draw-down - SERV10X-61 Task 10: a job's deposit credit is now sourced from ALL
      // its attached estimates (linked_estimates / EstimateJobLink) UNION its 1:1 provenance
      // estimate (job.estimate / JobPrimaryEstimate), deduped by estimate id. A legacy/single-
      // estimate job has the same estimate in both (or only provenance set) → dedupes to one →
      // this stays BYTE-IDENTICAL to the pre-Task-10 single-deposit path. Resolve the PAID
      // deposit invoices ONCE, in a deterministic (created_at) order so the drawdown is stable.
      // SRVW-85: the union + resolution + both drawdown passes now live in lib/deposit-credit so
      // this door and the whole-job door share ONE clamp and cannot drift apart again.
      // Behaviour-identical - the helpers were lifted from the code that used to sit here.
      const paidDeposits = await resolvePaidDepositInvoices(tx, depositEstimateIds(job), req.user!.organization_id);

      // PASS 1 (read-only) - the invoice's deposit_credit, under a DECREASING `room` that starts
      // at the TAX-INCLUSIVE `invoiceTotal` (Task 10b) so two deposits cannot over-credit it.
      const depositCredit = await computeDepositCredit(tx, paidDeposits, invoiceTotal);
      const amountDue = round2(invoiceTotal - depositCredit);

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          organization_id: req.user!.organization_id,
          job_id: job.id,
          customer_id: job.customer!.id,
          kind: 'STANDARD',
          status: 'DRAFT',
          subtotal,
          discount_amount: discountAmount,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          deposit_credit: depositCredit,
          total_amount: invoiceTotal,
          amount_due: amountDue,
          // R3b (2026-07-21) — deliberately NOT copying the job's labor_hours/overhead here: this
          // is a partial/progress DRAW invoice (possibly one of several against the same job), and
          // copying the job's whole-job cost basis onto every draw would overstate cost on each
          // one. Left null — falls back to the org default, same as any other from-scratch
          // document — rather than misrepresenting a partial bill as carrying the full job cost.
          line_items: { create: lineData },
          // Audit: the user raising this draw invoice off the job, never the job's own creator.
          ...createdByUser(req),
        },
      });

      // PASS 2 (post-create) - ONE DepositCreditApplication ledger row + ONE post-tax
      // DEPOSIT-CREDIT Payment per deposit that draws > 0, under the same decreasing-room clamp
      // Pass 1 used, so the invoice's deposit_credit and Σ(ledger rows) stay consistent.
      await applyDepositCreditsWithPayments(tx, paidDeposits, created.id, invoiceTotal, req.user!.organization_id);

      // Task 10b: track the TAX-INCLUSIVE total, mirroring invoice.controller (increments by
      // total_amount, void/delete decrement by total_amount) so the cached billed total nets out.
      await tx.job.update({ where: { id: job.id }, data: { amount_invoiced: { increment: invoiceTotal } } });

      // Spec B2 — the lifecycle bar creates invoices, so the job's story must record it. Mirrors
      // invoice.controller.create()'s INVOICE_CREATED write (:666-675). entity_type is INVOICE
      // (not JOB) so it lands on the invoice's own timeline too; Task 3 is what makes it
      // reachable from the job.
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${created.invoice_number} created from job ${job.job_number}`,
          created_by: req.user?.id,
        },
      });

      return created;
    }), { label: 'job.invoice.create' });

    // Audit the Invoice that was actually created, not the parent Job — consistent with
    // invoice.controller.ts's create() (resourceType: 'Invoice', resourceId: invoice.id).
    void logAudit({
      req, action: 'job.invoice_created', resourceType: 'Invoice', resourceId: invoice.id,
      metadata: { job_id: job.id },
    });
    res.status(201).json({ invoice });
  } catch (err) {
    logger.error('Error creating invoice from job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Visits collection (multi-visit S2) ────────────────────────────────────
//
// The job twin of the lead visits collection shipped in S1. Per the spec's API contract, visits
// are a NESTED COLLECTION on their parent. POST books an ADDITIONAL trip on the job; it never
// collapses onto an existing row, which is the whole invariant this slice lifts for jobs.
//
// Deliberately NOT part of updateJobSchema: MANAGE_LINES_FIELDS is derived BY EXCLUSION from that
// schema's shape, so any key added there without being classified silently becomes a
// `manage_lines Job` money field and reddens permissions-job-manage-lines.test.ts.
//
// Multi-visit S3 (D6): `assignee_ids` lands here, on the VISIT, now that visit_assignees.lead_id
// is nullable. Crew is per-visit from this slice on; `job_assignees` stays as the derived UNION
// its many readers (CASL's OWN_JOB row-scope, TeamCard, the schedule board, copilot) still read.
/**
 * A visit's window has to be a real one. Neither dialog can be trusted to hold this on its own -
 * the client is a client - and the consequences are silent rather than cosmetic: the mirror copies
 * the window onto the job, and detectCrewConflicts tests overlap with
 * `scheduled_start < end AND scheduled_end > start`, which no zero-width or inverted block can
 * satisfy, so double-booking checks on that job quietly stop finding anything.
 */
function endAfterStart(v: { scheduled_start: string; scheduled_end: string }): boolean {
  return new Date(v.scheduled_end).getTime() > new Date(v.scheduled_start).getTime();
}
const END_AFTER_START = {
  message: 'scheduled_end must be after scheduled_start',
  path: ['scheduled_end'],
};

type ServiceLocationParts = {
  address_line1: string | null;
  city: string | null;
  state: string | null;
} | null;

/**
 * The job's service address, joined the way `{{job.address}}` joins it in context.ts - same three
 * fields, same order, same separator.
 *
 * Stated once in code rather than three times in comments, because the visit-scoped dispatch
 * sites come in two shapes - the ones that must re-read the row, and the one that already holds a
 * fresh read of it - and the no-location fallback has to be the SAME string for both.
 */
function serviceAddressOf(serviceLocation: ServiceLocationParts): string {
  return serviceLocation
    ? [serviceLocation.address_line1, serviceLocation.city, serviceLocation.state].filter(Boolean).join(', ')
    : '';
}

/**
 * What `{{job.visit_location}}` must render for the ONE trip a visit-scoped occurrence is about
 * (visit-location spec, slice 4; multi-visit D18).
 *
 * D18 already routes `job.scheduled_date` through `visitMergeFields` because the job branch of
 * `loadExecutionBundle` used to resolve per JOB - the next upcoming live visit - so an enrollment
 * created by visit 3 would otherwise render visit 2's date. The location has to travel the same way
 * for the same reason, and the cost of it not doing so is strictly worse than the date's: an email
 * naming visit 3's date beside visit 2's address sends the customer to the wrong place, which is
 * the failure the whole feature exists to remove.
 *
 * SINCE THE PER-VISIT-ENROLLMENT SPEC (2026-09-14) the enrollment also persists the visit id and
 * the loader resolves THAT trip, so the override and the resolution now agree rather than the
 * override having to correct the resolution. It is kept - deliberately, that spec's D11 - because
 * it is what the dispatch sites depend on and because these two must never disagree; what changed
 * is that a site which somehow lost the override would now still render the right trip instead of
 * the parent's next one.
 *
 * IT IS A RE-READ, AND IT HAS TO BE - see `loadVisitLocation`, which is that read and which this
 * is now a thin naming of. What this function adds is `serviceAddressOf`: the fallback expressed
 * as the job's own three columns rather than as a string, which is the shape every caller here
 * holds.
 *
 * The visit-scoped en-route dispatch does NOT come through here and does not need to: it already
 * holds a `findFirst` on the visit - job-scoped and tenant-scoped - taken before its write, so it
 * asks that read for the relation instead of making a second one. Both shapes format through
 * `formatVisitLocation` over `serviceAddressOf`, which is what stops the two answering
 * differently.
 *
 * `serviceLocation` is passed in rather than re-read for the same reason the automation context
 * passes it into the formatter: the no-location fallback has to be the SAME string this email
 * renders under {{job.address}}, and a second derivation would be free to drift from it.
 */
async function visitLocationForOccurrence(
  req: Request,
  visitId: string,
  serviceLocation: ServiceLocationParts,
): Promise<string> {
  return loadVisitLocation(req, visitId, serviceAddressOf(serviceLocation));
}

/**
 * Everything a JOB-LEVEL milestone door's occurrence must render about the trip it just stamped.
 *
 * `visitLocationForOccurrence` above serves the four sites that already HOLD the trip - they
 * booked it, moved it, or read it before writing it - and lack only the place. This serves the
 * ones that hold nothing but an id, because the trip was chosen for them: `/en-route`, `/start`
 * and `/arrive` press `stampCurrentJobVisitMilestone`, which resolves the job's CURRENT trip
 * ("already begun beats not-yet-begun") and hands back the id it stamped.
 *
 * That resolution is NOT the one `context.ts`'s job arm makes. The job arm answers per ENTITY -
 * `resolveNextJobVisit`, the earliest still-UPCOMING trip - and the two disagree the moment a crew
 * runs past their slot, which is the ordinary case these doors exist for. Without this read the
 * stamp lands on today's trip and the customer is mailed next week's date beside next week's
 * ADDRESS. See md_files/plans/scheduling/2026-09-13-job-door-stamps-one-visit-describes-another.md.
 *
 * ONE read, asking for all three things the override needs, and each of the three is load-bearing:
 *  - `scheduled_at` is the trip's own slot, which is the whole of {{job.scheduled_date}}/_time;
 *  - the `location` RELATION, never `location_id` alone - `formatVisitLocation` handed a pointer
 *    with nothing behind it falls through to the service address, a real address in the right
 *    format and the wrong place (the failure `visitLocationForOccurrence` documents at length);
 *  - the crew's `...performerPhoneSelect` pair, because a number with no extension behind it
 *    reads in an inbox as a working contact.
 *
 * Tenant-scoped like its sibling: the id came from this request's own write, but it is still a
 * read, and another organisation's visit must not be reachable through it.
 *
 * Returns null when the row cannot be resolved, which the caller must treat as "dispatch exactly
 * as before" - per entity, naming no visit. A partial override is the one answer worse than
 * either: an occurrence that names a trip and renders the job's fields is the inverse of this fix.
 */
async function stampedVisitOccurrence(
  req: Request,
  visitId: string,
  serviceLocation: ServiceLocationParts,
): Promise<{ visitId: string; mergeFields: Record<string, string> } | null> {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, ...tenantWhere(req) },
    select: {
      scheduled_at: true,
      ...visitLocationSelect,
      assignees: {
        select: {
          // `id` rides with the names for slice 7: resolveServWavePhones reads the crew's
          // ServWave links by user id, and this select is the only source for them here.
          user: { select: { id: true, first_name: true, last_name: true, ...performerPhoneSelect } },
        },
      },
    },
  });
  if (!visit) return null;
  // One read, both phone fields - see the note at the JOB_SCHEDULED door.
  const stampedMainLine = await getOrgMainLine(req.user!.organization_id);
  return {
    visitId,
    mergeFields: visitMergeFields(
      visit,
      visit.assignees.flatMap((a) => (a.user ? [a.user] : [])),
      await getRequestOrgTimezone(req),
      formatVisitLocation(visit, serviceAddressOf(serviceLocation)),
      // Slice 5: what {{technician.phones}} falls back to when nobody on THIS trip has a number on
      // file. Resolved here for the same reason the location is - the override REPLACES the
      // per-entity resolution, so anything it leaves out keeps the job-level union's answer.
      stampedMainLine,
      // Slice 7: the ORGANISATION'S number for the same people, off the same crew and the same
      // main line, so one email cannot quote a personal number beside a mismatched fallback.
      await resolveServWavePhones(
        req.user!.organization_id,
        visit.assignees.flatMap((a) => (a.user ? [a.user.id] : [])),
        stampedMainLine,
      ),
    ),
  };
}

export const createJobVisitSchema = z.object({
  scheduled_start: z.string().datetime({ offset: true }),
  scheduled_end: z.string().datetime({ offset: true }),
  is_all_day: z.boolean().optional().default(false),
  // The crew going on THIS trip. A default of [] is correct on the POST (a booking that names
  // nobody genuinely has no crew) and is emphatically NOT correct on the PATCH twin below - see
  // the comment there.
  assignee_ids: z.array(z.string().uuid()).default([]),
  notes: z.string().max(5000).optional(),
  // Accepted and ignored: the API contract says omitting the notify object "preserves today's
  // behaviour", and per-visit customer email is S7 (which lands on top of SRVW-243, not racing it).
  notify: z
    .object({
      notify_customer: z.boolean().optional(),
      // `.email()` and the capped cc array match assignJobSchema (:432) exactly. Before S7 this
      // was a bare z.string() with no cc at all, so a malformed address reached the provider
      // through the visit door and Zod SILENTLY STRIPPED the composer's CC list - a success
      // toast and no mail to the person who was copied.
      notify_recipient_email: z.string().email().optional(),
      notify_cc_emails: z.array(z.string().email()).max(5).optional(),
      notify_message: z.string().max(5000).optional(),
    })
    .optional(),
  // Where this trip is happening - THE SAME FIELD the two lead-side doors take, from the same
  // module, not a job-side declaration of the same shape (visit-location spec, slice 4). A job at
  // a customer's house whose pre-build measure happens at the showroom is the case; the trade
  // that needs it is the one with a yard, a workshop or a studio, where roughly half of a job's
  // trips start somewhere the customer never goes.
  //
  // Three-state, and on a CREATE only two of the three are reachable: omitted writes no location
  // column at all and `null` writes six explicit nulls, which on a fresh row mean the same thing -
  // the job's service address. It stays the shared three-state field rather than being narrowed
  // per door, because narrowing it per door is how the four doors start to differ.
  location: visitLocationField,
}).refine(endAfterStart, END_AFTER_START);

/** Every visit on the job, earliest scheduled first. */
export async function listVisits(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const job = await prisma.job.findUnique({ where: { id, ...tenantWhere(req) }, select: { id: true } });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    // tenantWhere above is a TENANCY check, not a row-scope one. `read Job` is CONDITIONAL for a
    // technician (OWN_OR_CREATED_JOB), and the route gate is subject-level, so without this a
    // technician reads every crew's itinerary and per-visit notes in the org - while GET
    // /api/jobs/:id on the same row 403s. Same check getById and the other nested job
    // collections apply; the two write paths below already had it.
    if (!(await canActOnRow(req, 'Job', prisma.job, job.id, 'read'))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json({ visits: await listJobVisits(req, id) });
  } catch (err) {
    logger.error('List job visits error:', err);
    res.status(500).json({ error: 'Failed to list visits' });
  }
}

/** Book a NEW visit on the job, leaving any existing ones untouched. */
export async function createVisit(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { scheduled_start, scheduled_end, is_all_day, notes, assignee_ids, notify, location } = req.body as {
      scheduled_start: string;
      scheduled_end: string;
      is_all_day: boolean;
      notes?: string;
      assignee_ids: string[];
      notify?: {
        notify_customer?: boolean;
        notify_recipient_email?: string;
        notify_cc_emails?: string[];
        notify_message?: string;
      };
      // Absent when the caller said nothing about where, which on a create is the service address
      // - the same type the three sibling doors destructure, from the same module.
      location?: VisitLocationInput | null;
    };
    const notifyCustomer = notify?.notify_customer === true;
    // Q1: the third state. `notify` absent -> unchanged (fire the automation, the back-compat path
    // every non-dialog caller relies on). `notify.notify_customer === true` -> unchanged (send
    // directly below, suppress the automation). `notify.notify_customer === false` -> NEITHER: the
    // caller explicitly declined telling the customer, and the automation must not do it instead.
    const notifyDeclined = notify !== undefined && notify.notify_customer === false;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // S7: job_number labels the automation event and the customer email. Widened here rather
      // than re-read after the commit, so the label and the row this handler authorised are the
      // same read.
      select: {
        id: true,
        status: true,
        job_number: true,
        // S7: the customer email's own fields. The address the composer offers and the address
        // this handler mails are therefore the same read.
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
        // Scheduling-notifications PRD: the two facts decideScheduleDispatch needs from this door.
        // The once-per-job "scheduled announcement already happened" guard (its column name
        // notwithstanding, it is not evidence the customer received anything), and the visit set
        // the job's window is read off - the SAME read /assign makes - so "did the job already
        // hold a scheduled start" is answered identically at both doors.
        customer_scheduled_email_sent_at: true,
        visits: {
          select: { status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true },
        },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // The route gate only asks whether this principal may EVER reschedule. canActOnRow asks the
    // row, the same per-instance check assign() applies - without it a technician granted
    // `reschedule Job` could add visits to every job in the org.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'reschedule'))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Multi-visit S3: booking TIME is a `reschedule Job` fact; naming CREW is an `assign Job` one,
    // wherever it is written. The visit routes are gated `reschedule Job` (see job.routes.ts's S2
    // comment on that deliberate asymmetry with POST /:id/assign, which first-books under `assign
    // Job`), and canDo is subject-level, so without this second per-instance check hanging crew
    // off these routes hands every reschedule-only grantee the ability to re-crew jobs - a route
    // around the very gate that comment says must not be routed around. Moving the ROUTE gate to
    // `assign` instead is the wrong fix: it would break plain drag-to-reschedule for exactly those
    // people.
    //
    // Q3: gated on whether the crew SET changed, the identical rule rescheduleVisit applies below.
    // On a create the "current" set is always empty, so this reduces to "any non-empty incoming
    // set gates" - same behaviour as before, just expressed through the one comparison both doors
    // share instead of two independently-maintained tests that can drift.
    if (assigneeSetChanged([], assignee_ids) && !(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Eligibility: every crew member must be an active, assignable in-org user. Byte-identical to
    // the check assign() runs, so the two crew doors cannot drift on their error strings. It sits
    // OUTSIDE the transaction deliberately: an ineligible member must leave nothing written, and
    // validateCrew issues its own top-level tenant-scoped user reads rather than tx ones.
    // A brand-new trip replaces nobody, so the pool question is asked about the whole incoming
    // set - the same empty "current" the assigneeSetChanged gate above uses.
    const crew = await validateCrew(req, assignee_ids, []);
    if (!crew.ok) {
      res.status(crew.status).json({ error: crew.error });
      return;
    }

    // D8, through the SAME helper the two lead-side doors call, which is the whole of "reuse, do
    // not re-implement": a second copy of the tenant check is a second place for it to drift, and
    // what it protects is another organisation's address landing in this organisation's customer
    // email. The foreign key constrains `location_id` to a REAL location, not to one this caller
    // may see. Slice 2's archived-location refusal (D9) rides along for free, which is the point -
    // a booking door added later cannot forget a rule it never restated.
    //
    // `currentLocationId: null` because this door CREATES: the visit stands nowhere yet, so the
    // "a visit may stay at a location archived since it was booked" exception cannot apply, and a
    // new booking into a closed branch is refused here exactly as it is on the lead side.
    const locationWrite = await resolveVisitLocationWrite(req, location, { currentLocationId: null });
    if (!locationWrite.ok) {
      res.status(locationWrite.status).json({ error: locationWrite.error });
      return;
    }

    const orgId = req.user!.organization_id;
    const scheduledAt = new Date(scheduled_start);
    const scheduledEnd = new Date(scheduled_end);

    // Scheduling-notifications PRD ("Job is scheduled fires on the date"): this door BOOKS A
    // FURTHER TRIP beside whatever the job holds (`additionalTrip: true`), so the shared decision
    // answers JOB_SCHEDULED only when the job had no scheduled start before this trip and its
    // announcement never happened - the first visit on an unscheduled job, crew or no crew.
    // Visit 2 beside a live visit 1 announces nothing: the job is already on the calendar, and a
    // move of a trip is the PATCH door's JOB_RESCHEDULED. This used to fire on EVERY new trip
    // (S7 D18), which disagreed with /assign; both doors now ask decideScheduleDispatch.
    const scheduleDecision = decideScheduleDispatch({
      startBefore: resolveJobScheduleWindow(existing.visits).scheduled_start,
      startAfter: scheduledAt,
      additionalTrip: true,
      scheduledDispatchedAt: existing.customer_scheduled_email_sent_at,
      crewCount: assignee_ids.length,
    });

    // Retried as a WHOLE unit: visit_seq is allocated from MAX + 1 with no lock, so a
    // concurrent create can take the number this transaction is about to write. The unique
    // index turns that into a failed write rather than two trips sharing one number in two
    // customer emails; this re-reads the MAX in a fresh transaction (section 4.4).
    const visit = await withVisitSeqRetry(() => prisma.$transaction(async (tx) => {
      const created = await createJobVisit(tx, {
        jobId: id,
        orgId,
        visitSeq: await nextVisitSeqForJob(tx, orgId, id),
        scheduledAt,
        scheduledEnd,
        isAllDay: is_all_day,
        notes: notes ?? null,
        // NOT stamped here. The visit-level stamp is the direct-send path's own "this trip has
        // been announced" marker (it picks the PATCH door's template and is never surfaced to
        // users; the automation ledger is what says whether the customer was reached). At this
        // point in the request nothing has been sent - the send is post-commit and can come back
        // skipped or failed - so the stamp lands below, on the outcome.
        stampCustomerEmailSentAt: false,
        // Already tenant-checked and reduced to columns above. EMPTY when the caller said nothing
        // about where, and it stays empty into the create: no location column is written, the six
        // stay at their NULL default, and the trip is at the job's service address - today's
        // behaviour for every job visit booked through this door before now.
        locationData: locationWrite.data,
      });
      // Multi-visit S3: the SAME writer the lead side uses, passed a null lead - not a job-side
      // fork. A job visit has no lead, so the row carries no lead_id at all.
      await replaceVisitCrew(tx, { visitId: created.id, orgId, userIds: assignee_ids });
      // D14: the mirror is a cache, written in the SAME transaction as the visit itself.
      await syncJobFromVisits(tx, { jobId: id, orgId });
      // The once-per-job guard: "the scheduling announcement for this job has happened". Its own
      // write, never a passenger on the mirror's data fragment (which must stay free of anything
      // /assign's milestone clears could be confused with), and in the SAME transaction as the
      // trip, so a rolled-back booking leaves the guard unset.
      if (scheduleDecision.stampScheduledDispatched) {
        await tx.job.update({
          where: { id, ...tenantWhere(req) },
          data: { customer_scheduled_email_sent_at: new Date() },
        });
      }
      // The sibling audit row the lead-side create has always written. 'SCHEDULED' is the same
      // event_type assign() uses, so ActivityPanel's from/to renderer works rather than falling
      // through to bare description text.
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: id,
          event_type: 'SCHEDULED',
          // No instant in the prose. This string renders verbatim on the job page's
          // Activity panel, so an ISO here is a bare UTC timestamp shown to every viewer
          // in every zone (MV-TZ-07). The time belongs in `metadata`, which the renderer
          // localises to the org clock.
          description: `Visit ${created.visit_seq} scheduled`,
          metadata: { visit_id: created.id, visit_seq: created.visit_seq, from: null, to: scheduledAt.toISOString() },
          created_by: req.user!.id,
        },
      });
      return created;
    }));

    // ─── Automation Center - post-commit, fire-and-forget (#271) ─────────────
    // Gated on scheduleDecision (see above): the job's FIRST scheduled start, once. visitId comes
    // off the row the transaction RETURNED, never a re-read, so the enrolled occurrence and the
    // persisted trip cannot be two different rows.
    //
    // assign()'s SRVW-243 rule, reproduced per visit: an explicit tick REPLACES the workflow for
    // this occurrence rather than joining it, because a send_window can defer a workflow by hours
    // and because an org holding the seeded default would otherwise mail the customer twice for
    // one gesture. Only THIS occurrence is suppressed - the workflow stays enabled for every untick.
    //
    // Q1: `&& !notifyDeclined` is the fix - bare `!notifyCustomer` is true both when `notify` was
    // never mentioned (correct: fire) and when it explicitly declined (wrong: firing anyway mails
    // the customer through the workflow the decline was supposed to stop).
    if (scheduleDecision.event === 'JOB_SCHEDULED' && !notifyCustomer && !notifyDeclined) {
      // Read once, handed to both phone fields below (slice 5's fallback and the bottom of slice
      // 7's chain). Two reads of Organization.phone building one message are two chances for one
      // email to quote two different main lines.
      const occurrenceMainLine = await getOrgMainLine(orgId);
      dispatchAutomationEvent({
        type: 'JOB_SCHEDULED',
        organizationId: orgId,
        entity: { type: 'job', id, label: existing.job_number },
        visitId: visit.id,
        actorId: req.user?.id ?? null,
        // D18's other half: the enrollment is scoped to this trip, so what it RENDERS has to be
        // this trip. Without the override {{job.scheduled_date}} resolves through the D14 mirror -
        // the job's NEXT upcoming visit - and a workflow enrolled by visit 3 tells the customer
        // visit 2's date. {{job.visit_location}} rides the same channel for the same reason, and
        // the cost of it not doing so is worse: a date the customer can query beside an address
        // they cannot. See visitMergeFields for what is and is not covered.
        eventPayload: {
          mergeFields: visitMergeFields(
            visit,
            crew.users,
            await getOrgTimezone(orgId),
            await visitLocationForOccurrence(req, visit.id, existing.service_location),
            // Slice 5: the fallback for a trip whose crew have no numbers on file. See /assign.
            // One read, two readers - slice 7's chain ends on the same string. See /assign.
            occurrenceMainLine,
            // Slice 7: the organisation's own number for the crew on this trip. See /assign.
            await resolveServWavePhones(orgId, crew.users.map((u) => u.id), occurrenceMainLine),
          ),
        },
      });
    }

    // AWAITED and post-commit, exactly as /assign's is: the caller is told the outcome and
    // cannot be told what has not happened yet, and a trip that genuinely got booked must not be
    // rolled back by a mail provider. visitSeq and scheduledStart come off the row the
    // transaction RETURNED, so the emailed trip and the persisted trip are one row (#1522).
    const notifyResult = notifyCustomer
      ? await notifyCustomerOfSchedule(req, {
          jobId: id,
          jobNumber: existing.job_number,
          customer: existing.customer,
          serviceLocation: existing.service_location,
          // #2175: the trip the transaction RETURNED, so the emailed place and the persisted
          // place are one row - the same rule visitSeq and the slot below already follow.
          visitId: visit.id,
          crew: crew.users,
          newStart: visit.scheduled_at,
          kind: 'scheduled',
          visitSeq: visit.visit_seq,
          recipientEmail: notify?.notify_recipient_email,
          cc: notify?.notify_cc_emails,
          message: notify?.notify_message,
        })
      : undefined;

    // The stamp is the OUTCOME of the send, never the intent behind it - see the create above.
    // updateMany rather than update so the tenant predicate rides along on the write.
    const announcedAt = notifyResult?.status === 'sent' ? new Date() : null;
    if (announcedAt) {
      await prisma.visit.updateMany({
        where: { id: visit.id, ...tenantWhere(req) },
        data: { customer_email_sent_at: announcedAt },
      });
    }

    res.status(201).json({
      visit: announcedAt ? { ...visit, customer_email_sent_at: announcedAt } : visit,
      ...(notifyResult ? { notify: notifyResult } : {}),
    });
  } catch (err) {
    logger.error('Create job visit error:', err);
    res.status(500).json({ error: 'Failed to create visit' });
  }
}

// Reschedule ONE visit. Separate from the collection POST because they are different actions
// (D19): this moves an existing row, and never mints a second one.
export const rescheduleJobVisitSchema = z.object({
  // S8 §2b (RATIFIED, section-9 item #6, PREVIOUSLY ORPHANED): both now `.optional()`. Before
  // this they had no `.optional()` at all, unlike `is_all_day`/`assignee_ids` on this same
  // schema - so there was no way to change only a visit's crew: a crew-only PATCH 400'd and the
  // caller had to re-send the unchanged window just to move crew. Omitted means "keep the
  // visit's CURRENT value", the identical "omitted = unchanged" meaning `assignee_ids` and
  // `is_all_day` already carry on this schema - see rescheduleVisit(), which resolves the
  // EFFECTIVE window (current values where omitted) before writing, checking conflicts, or
  // building the customer email/timeline metadata. Both interactions #1706 shipped keep working
  // unmodified: the crew gate still keys on whether the crew SET changes, and the conflict check
  // still runs against the EFFECTIVE window - "window omitted" is never "skip the conflict check".
  scheduled_start: z.string().datetime({ offset: true }).optional(),
  scheduled_end: z.string().datetime({ offset: true }).optional(),
  // NO `.default(false)` here, unlike the create schema. validate() replaces req.body with the
  // parse result, so a default turns "the request did not mention the flag" into an explicit
  // false on a PATCH - and no dialog sends it (ScheduleTimeFields has no all-day control). An
  // all-day job whose visit was simply moved a day would come back a timed 24h block, off the
  // board's all-day strip. Omitted means unchanged; only an explicit false clears it.
  is_all_day: z.boolean().optional(),
  // `.optional()` with NO `.default([])`, and this is the forward reference createJobVisitSchema
  // points at. The mechanism is the one the is_all_day comment eight lines above already
  // documents: validate() replaces req.body with the parse result, so a default converts "the
  // request did not mention crew" into "the crew is now empty" - and a plain drag-to-reschedule,
  // which is the exact body both VisitScheduleDialog trees send, would silently strip the visit's
  // crew. Omitted means unchanged; only an explicit array restates the crew.
  assignee_ids: z.array(z.string().uuid()).optional(),
  notes: z.string().max(5000).optional(),
  // D21 - warn, never block. Same wire name and same meaning as `/assign`'s: the FIRST request
  // 409s with the clashing trips, and the "Schedule Anyway" retry restates the move with this
  // set. `.default(false)` is safe here in a way it is not for the two fields above, because
  // "the request did not mention force" and "force is off" ARE the same fact.
  force: z.boolean().optional().default(false),
  notify: z
    .object({
      notify_customer: z.boolean().optional(),
      // `.email()` and the capped cc array match assignJobSchema (:432) exactly. Before S7 this
      // was a bare z.string() with no cc at all, so a malformed address reached the provider
      // through the visit door and Zod SILENTLY STRIPPED the composer's CC list - a success
      // toast and no mail to the person who was copied.
      notify_recipient_email: z.string().email().optional(),
      notify_cc_emails: z.array(z.string().email()).max(5).optional(),
      notify_message: z.string().max(5000).optional(),
    })
    .optional(),
  // Where the trip is happening (visit-location spec, slice 4), and THIS is the door the
  // three-state field was designed for.
  //
  // Every earlier caller of `visitLocationField` is a create or an upsert onto a fresh row, where
  // writing nothing and writing six explicit nulls leave the same row behind - so "omitted" and
  // "null" were indistinguishable and the distinction was carried on trust. Here the row already
  // holds an answer and the board's main gesture is a drag that sends a window and nothing else:
  // omitted has to mean UNCHANGED, or moving a job visit by an hour silently sends the crew to
  // the customer's address instead of the yard, after the customer has been told otherwise.
  //
  // The mechanism is the one the `is_all_day` and `assignee_ids` comments above already describe:
  // validate() replaces req.body with the parse result, so a `.default()` here would convert "the
  // request did not mention where" into a statement. There is deliberately none.
  location: visitLocationField,
}).refine(
  // S8 §2b: the invariant is only expressible when BOTH sides of THIS request state a window.
  // An omitted field is not a stated bound - it is "unchanged" - and the visit's CURRENT value is
  // trusted to already satisfy end-after-start (nothing here can have written an inverted one).
  (data) => {
    if (data.scheduled_start === undefined || data.scheduled_end === undefined) return true;
    return endAfterStart({ scheduled_start: data.scheduled_start, scheduled_end: data.scheduled_end });
  },
  END_AFTER_START,
);

export async function rescheduleVisit(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const visitId = param(req, 'visitId');
    const { scheduled_start, scheduled_end, is_all_day, notes, assignee_ids, force, notify, location } = req.body as {
      // S8 §2b (RATIFIED): both optional now - omitted means "keep the visit's current value",
      // resolved into effectiveStart/effectiveEnd below.
      scheduled_start?: string;
      scheduled_end?: string;
      is_all_day?: boolean;
      notes?: string;
      assignee_ids?: string[];
      force?: boolean;
      notify?: {
        notify_customer?: boolean;
        notify_recipient_email?: string;
        notify_cc_emails?: string[];
        notify_message?: string;
      };
      // THREE distinct values here, unlike anywhere else this field is read: `undefined` is "the
      // request did not mention where" (the board's drag), `null` is "move it back to the service
      // address", and a value is "move it here". Typed as the union rather than narrowed, so the
      // handler below cannot collapse the first two by accident.
      location?: VisitLocationInput | null;
    };
    const notifyCustomer = notify?.notify_customer === true;
    // Q1: the third state - see createVisit's identical comment. `notify` absent -> unchanged
    // (automation fires); `notify_customer: true` -> unchanged (direct send, automation
    // suppressed); `notify_customer: false` -> NEITHER sends.
    const notifyDeclined = notify !== undefined && notify.notify_customer === false;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      // `assignees` is read for the conflict scope below, not for the write - see the fallback
      // note there for why the job-level union is the right answer when the trip carries no crew.
      select: {
        id: true,
        status: true,
        job_number: true,
        visits: { select: { assignees: { select: { user_id: true } } } },
        // S7: the customer email's own fields, same widening as the collection POST.
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'reschedule'))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Scoped to BOTH this job and this tenant: a visitId belonging to another job, or to another
    // organization, must not be reachable through this job's URL.
    const visitRow = await prisma.visit.findFirst({
      where: { id: visitId, job_id: id, ...tenantWhere(req) },
      // S7 widens this select and keeps all three predicates above. customer_email_sent_at is the
      // trip's "already announced by the direct-send path" marker: the discriminator for WHICH
      // template a ticked move sends, never surfaced to users and never read as evidence that the
      // customer was reached (the automation ledger answers that). visit_seq is the number the
      // customer reads.
      // Q4: `status` was missing entirely, so a CANCELLED visit could be silently moved.
      select: {
        id: true,
        visit_seq: true,
        status: true,
        customer_email_sent_at: true,
        // The window this move is coming FROM, for the timeline row's `from` (MV-TZ-07) - and,
        // since S8 §2b, also the EFFECTIVE window when this request omits one or both fields.
        scheduled_at: true,
        scheduled_end: true,
        is_all_day: true,
        // Visit-location slice 4: the location this trip ALREADY stands at, which is what
        // `resolveVisitLocationWrite`'s `currentLocationId` needs below. Read here, on the row
        // this handler has already authorised, rather than in a second query - and it is the one
        // field of the six this door needs, because the other five are never compared against
        // anything.
        location_id: true,
        // Slice 5: `...performerPhoneSelect` is how the crew already on this trip reaches
        // {{technician.phones}} when the PATCH re-crews nothing. Without it the occurrence renders
        // the main line for a crew who are perfectly reachable.
        //
        // AND THE COMPILER WILL NOT STOP YOU DELETING IT. These rows reach
        // `formatPerformerPhones` through `(u): u is VisitCrewMember` below, and a type predicate
        // is a cast, not a check - it accepts the two names alone. This is the one crew read in
        // the feature `tsc` does not hold; `job-visit-location.test.ts` asserts this select
        // instead ("a move that re-crews nobody…"). See `PerformerPhoneRow` for the other four.
        assignees: {
          select: {
            user_id: true,
            user: { select: { first_name: true, last_name: true, ...performerPhoneSelect } },
          },
        },
      },
    });
    if (!visitRow) {
      res.status(404).json({ error: 'Visit not found' });
      return;
    }

    // Q4: a called-off trip is immutable at the API. Refused EARLY, before any read or write below
    // has a chance to act on it - neither a bare move (this door) nor its sibling milestone routes
    // have ever checked this, so a CANCELLED visit could be rescheduled right back onto the board.
    if (visitRow.status === 'CANCELLED') {
      res.status(409).json({ error: 'Visit is cancelled' });
      return;
    }

    // S8 §2b (RATIFIED): the EFFECTIVE window this request lands on - the body's value where
    // given, the visit's CURRENT value where omitted. A crew-only PATCH (both omitted) therefore
    // resolves to the visit's unchanged window, which is what makes the two guarantees below hold
    // without a special case: the conflict check just below still runs against a real window (a
    // crew-only PATCH that books a double-booked person at the visit's EXISTING time still 409s -
    // "window omitted" must never mean "skip the conflict check"), and rescheduleVisitRow's own
    // write is a no-op on time when nothing about the window changed.
    if (visitRow.scheduled_at === null || visitRow.scheduled_end === null) {
      // Defensive, not reachable in practice: every visit created through createJobVisit/
      // createVisit always carries a time. A visit with neither its own window NOR one supplied
      // by this request has nothing to reschedule onto.
      res.status(400).json(validationFailure([{
        field: 'scheduled_start',
        message: 'scheduled_start and scheduled_end are required - this visit has no existing window to keep',
      }]));
      return;
    }
    const effectiveStart = scheduled_start !== undefined ? new Date(scheduled_start) : visitRow.scheduled_at;
    const effectiveEnd = scheduled_end !== undefined ? new Date(scheduled_end) : visitRow.scheduled_end;

    // ONE hoisted const, feeding the send below and nothing else in this handler decides it
    // separately - the same discipline assign() applies to isReschedule, and the reason #1550
    // could be PROVED from prod data rather than inferred.
    //
    // "Has the direct-send path ever announced THIS trip" is the row fact that answers the question
    // the template asks. Emphatically NOT a status test: job status is derived and unordered, and
    // a visit sitting at IN_PROGRESS on a COMPLETED job is still a trip that moved. scheduled_at
    // is useless here too - create requires one, so every row has one.
    const kind: 'scheduled' | 'rescheduled' = visitRow.customer_email_sent_at == null ? 'scheduled' : 'rescheduled';

    // `visitRow.assignees` is already selected above - the CURRENT crew set, read once and reused
    // both by the gate below and by the conflict scope further down.
    const visitCrewIds = visitRow.assignees.map((a) => a.user_id);

    // The collection POST's guard, generalised. Booking TIME is a `reschedule Job` fact and naming
    // CREW is an `assign Job` one wherever it is written, so the two visit routes must apply the
    // same per-instance check - otherwise crew reaches the DB through the weaker of the two doors.
    // The `!== undefined` half is load-bearing: an omitted field is not an empty crew and must not
    // trip the gate, or plain drag-to-reschedule 403s for exactly the reschedule-only grantees the
    // route gate at job.routes.ts:67-69 was written to keep working.
    //
    // Q3: gated on the crew SET changing, not on `assignee_ids.length > 0`. That test had two
    // defects in opposite directions: `assignee_ids: []` on a crewed visit skipped the gate and
    // wiped the crew, and a reschedule-only grantee RESTATING the visit's unchanged crew was
    // false-403'd - VisitScheduleDialog sends `assignee_ids` on every save the picker is shown for,
    // whether or not the user touched it. assigneeSetChanged makes both cases behave: an empty
    // restatement over a crewed visit IS a change (gated, refuses before anything is written), and
    // an identical restatement is NOT (never even reaches the `assign` check).
    if (
      assignee_ids !== undefined &&
      assigneeSetChanged(visitCrewIds, assignee_ids) &&
      !(await canActOnRow(req, 'Job', prisma.job, existing.id, 'assign'))
    ) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Same eligibility rule, same placement, same error strings as the collection POST: outside
    // the transaction, so an ineligible member leaves nothing written. The resolved users are
    // KEPT rather than discarded: when this request also re-crews the trip, they are the people
    // going on it, and the customer email below must name them and not the crew being replaced.
    let incomingCrew: CrewMember[] | null = null;
    if (assignee_ids !== undefined) {
      // `visitCrewIds` - the SAME hoisted read the assign-gate above uses, not a second one. An
      // omitted `assignee_ids` never reaches here at all (unchanged), and a restatement of this
      // set is not a crew statement, so neither can be refused by the pool rule.
      const crew = await validateCrew(req, assignee_ids, visitCrewIds);
      if (!crew.ok) {
        res.status(crew.status).json({ error: crew.error });
        return;
      }
      incomingCrew = crew.users;
    }

    // D8, through the SAME helper the other three booking doors call. Ahead of the conflict check
    // below for the reason the lead doors put it there: a body naming a location it may not have
    // is wrong whether or not the slot is free, and answering 409 first would tell the caller
    // about somebody else's calendar before refusing them.
    //
    // `currentLocationId` IS THE STORED ID, NOT `null`, and that is what this argument was made
    // required for. Null here typechecks, passes every test that does not look, and 400s every
    // reschedule of a visit standing at a since-archived branch - the one caller with no way
    // through at all, because D9's own note is explicit that a visit's own location stays editable
    // for its life. With the stored id threaded, that visit may stay where it is while nothing new
    // can be moved onto a closed branch.
    const locationWrite = await resolveVisitLocationWrite(req, location, {
      currentLocationId: visitRow.location_id,
    });
    if (!locationWrite.ok) {
      res.status(locationWrite.status).json({ error: locationWrite.error });
      return;
    }

    // Multi-visit S6 (D21, user stories 12-14): the SAME double-booking warning `/assign` and
    // PATCH /api/jobs/:id raise. This route is the board's main gesture now - dragging a card
    // moves the trip through here, not through `/assign` - so leaving it out would have deleted
    // the crew warning from the one surface dispatchers actually schedule on.
    //
    // WHOSE calendar is being asked about: the TRIP's own crew, because that is who is going.
    // The job-level union is the fallback, not the rule - a three-trip job where Alice takes
    // trip 1 and Bob takes trip 2 must not warn about Alice when trip 2 moves. It IS the right
    // answer when the visit carries no crew row of its own (a job crewed only at job level, e.g.
    // the row-scoped creator's self-assign): those people are the ones who will turn up.
    // An explicit `assignee_ids` restates the crew, so it wins over both. `visitCrewIds` is the
    // SAME hoisted read the gate above uses - not a second one.
    const conflictUserIds =
      assignee_ids ?? (visitCrewIds.length > 0 ? visitCrewIds : jobCrewIds(existing));

    // S8 §2b: EFFECTIVE window, always - a crew-only PATCH (both fields omitted) still checks the
    // visit's CURRENT window, never skipped. This is the interaction #1706 shipped that must not
    // regress: a crew-only PATCH that books a double-booked person at the visit's existing time
    // still has to raise its 409.
    if (!force) {
      const conflicts = await detectCrewConflicts(req, {
        jobId: id,
        userIds: conflictUserIds,
        schedStart: effectiveStart,
        schedEnd: effectiveEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    const orgId = req.user!.organization_id;

    const visit = await prisma.$transaction(async (tx) => {
      // EFFECTIVE window: a no-op time-wise when both fields were omitted (rescheduleVisitRow
      // still writes the SAME scheduled_at/scheduled_end it already held), which is what makes a
      // crew-only PATCH "succeed and leave crew alone" / "move nothing but crew" - see the schema
      // comment for the full S8 §2b rationale.
      const moved = await rescheduleVisitRow(tx, visitRow.id, {
        scheduledAt: effectiveStart,
        scheduledEnd: effectiveEnd,
        isAllDay: is_all_day,
        notes: notes ?? null,
        // Only ever set, never cleared, and only on the first announce: it records that this trip
        // was told to the customer, which stays true afterwards. NOT written here though - the
        // send has not happened yet and may come back skipped or failed. See the stamp below.
        stampCustomerEmailSentAt: false,
        // Already tenant-checked and reduced to columns above, and EMPTY when the caller said
        // nothing about where. Empty has to stay empty all the way into the update payload: this
        // is the one writer in the feature where the difference is observable, and writing six
        // nulls instead is precisely how a reschedule of the TIME would send the crew back to the
        // customer's address.
        locationData: locationWrite.data,
      });
      // Only when the request actually named crew. The SAME writers the POST and the lead side
      // use - a visit is a visit (D3), so there is no job-side fork here.
      if (assignee_ids !== undefined) {
        await replaceVisitCrew(tx, { visitId: visitRow.id, orgId, userIds: assignee_ids });
      }
      // AFTER the write, so the mirror re-resolves over the POST-update state: pushing the current
      // visit later must hand the mirror to the next one, not follow the row that moved.
      await syncJobFromVisits(tx, { jobId: id, orgId });
      // The SAME const the send below reads. Not a second decision - that is the whole point:
      // #1550 was a customer email and its sibling timeline row disagreeing.
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: id,
          event_type: kind === 'rescheduled' ? 'RESCHEDULED' : 'SCHEDULED',
          description: `Visit ${moved.visit_seq} ${kind}`,
          // `from` was omitted entirely here while the create writer sends `from: null`, so a
          // renderer told to read the structured from/to had only half of it - and the
          // Activity panel's guard read the absence as malformed and suppressed the schedule
          // line altogether. visitRow is the pre-transaction read, so this is the window the
          // move is coming FROM.
          metadata: {
            visit_id: moved.id,
            visit_seq: moved.visit_seq,
            from: visitRow.scheduled_at ? visitRow.scheduled_at.toISOString() : null,
            to: effectiveStart.toISOString(),
          },
          created_by: req.user!.id,
        },
      });
      return moved;
    });

    // Same alternative-not-both rule as the collection POST above. The occurrence key stays the
    // BARE new-start ISO: stopIf.ts and terminalStale.ts compare it against
    // someDate.toISOString() and return a stale-reason (killing the run silently) on a mismatch,
    // so the visit id goes into the dedupe key only. rearmAnchoredWaits writes occurrence_key and
    // never dedupe_key, so it cannot clobber the visit scoping either.
    //
    // Q1: `&& !notifyDeclined` - see createVisit's identical fix above.
    if (!notifyCustomer && !notifyDeclined) {
      // Read once, handed to both phone fields below - see createVisit above for why one message
      // must not read Organization.phone twice.
      const occurrenceMainLine = await getOrgMainLine(req.user!.organization_id);
      // The SAME people the two crew expressions below resolve to, as ids.
      //
      // Taken from `user_id` rather than from the narrowed rows because the pre-read's `user`
      // select carries the two names and the two phone columns and no id - and it is filtered by
      // the same `user != null` the narrowing applies, so the list of ids and the list of people
      // are the same list. A deleted user dropped from the names is dropped from the numbers too.
      const occurrenceCrewIds = incomingCrew
        ? incomingCrew.map((u) => u.id)
        : visitRow.assignees.filter((a) => a.user != null).map((a) => a.user_id);
      dispatchAutomationEvent({
        type: 'JOB_RESCHEDULED',
        organizationId: req.user!.organization_id,
        entity: { type: 'job', id, label: existing.job_number },
        occurrenceKey: effectiveStart.toISOString(),
        visitId: visitRow.id,
        actorId: req.user?.id ?? null,
        // The moved trip's own slot, crew and place - see the collection POST for why the job's
        // mirror is the wrong answer for a per-visit occurrence. The location is read back AFTER
        // the write, so a move that changed it renders the new place and a move that said nothing
        // about it renders the place the trip has not left.
        eventPayload: {
          mergeFields: visitMergeFields(
            visit,
            incomingCrew
              ?? visitRow.assignees.map((a) => a.user).filter((u): u is VisitCrewMember => u != null),
            await getOrgTimezone(req.user!.organization_id),
            await visitLocationForOccurrence(req, visit.id, existing.service_location),
            // Slice 5: the fallback for a trip whose crew have no numbers on file. See /assign.
            occurrenceMainLine,
            // Slice 7: the organisation's own number for whoever is on the trip AFTER this move -
            // the incoming crew when the request re-crewed it, the standing crew when it did not.
            await resolveServWavePhones(
              req.user!.organization_id, occurrenceCrewIds, occurrenceMainLine,
            ),
          ),
        },
      });
    }

    // AWAITED and post-commit, never fatal - the same contract /assign's send has.
    const notifyResult = notifyCustomer
      ? await notifyCustomerOfSchedule(req, {
          jobId: id,
          jobNumber: existing.job_number,
          customer: existing.customer,
          serviceLocation: existing.service_location,
          // #2175: the moved trip, read back AFTER the write - so a move that also changed where
          // renders the new place, and one that said nothing about it renders the place the trip
          // has not left. Same row, same rule as the crew below.
          visitId: visit.id,
          // The people going on THIS trip, not the job-level union - and AFTER this request's own
          // crew write, not before it. `visitRow` was read before the transaction, so on a PATCH
          // that moves the trip and swaps its crew in one go (the body VisitScheduleDialog sends
          // whenever the picker is shown) it holds the OUTGOING people. An omitted assignee_ids
          // means "crew unchanged", and there the pre-read row is still the right answer.
          // The predicate is only here to drop a null relation, so it names the row's own shape
          // (`VisitCrewMember` since slice 5) rather than a narrower hand-written copy - this
          // send reads the names off it and the dispatch above reads the numbers.
          crew: incomingCrew
            ?? visitRow.assignees.map((a) => a.user).filter((u): u is VisitCrewMember => u != null),
          newStart: visit.scheduled_at,
          kind,
          visitSeq: visit.visit_seq,
          recipientEmail: notify?.notify_recipient_email,
          cc: notify?.notify_cc_emails,
          message: notify?.notify_message,
        })
      : undefined;

    // First announce, and only once it actually went: a move whose send failed leaves the trip
    // unannounced, so the next ticked move is still a 'scheduled' rather than telling a customer
    // who has heard nothing that their visit "has been rescheduled".
    const announcedAt = kind === 'scheduled' && notifyResult?.status === 'sent' ? new Date() : null;
    if (announcedAt) {
      await prisma.visit.updateMany({
        where: { id: visit.id, ...tenantWhere(req) },
        data: { customer_email_sent_at: announcedAt },
      });
    }

    res.json({
      visit: announcedAt ? { ...visit, customer_email_sent_at: announcedAt } : visit,
      ...(notifyResult ? { notify: notifyResult } : {}),
    });
  } catch (err) {
    logger.error('Reschedule job visit error:', err);
    res.status(500).json({ error: 'Failed to reschedule visit' });
  }
}

// ─── Visit lifecycle (multi-visit S4, D7/D7a/D12) ────────────────────────────
//
// The four milestone timestamps are facts about a TRIP, so these routes address a named visit and
// the job's own status is DERIVED from the resulting visit set (lib/job-status.ts) rather than
// written here. The job-level /:id/start, /:id/arrive and /:id/en-route routes survive unchanged
// as the old door and now act on the job's current visit through the same writers.

/**
 * One handler shape for every per-visit milestone, built once rather than copied per verb.
 *
 * Four near-identical handlers is how the job-level and visit-level halves drift apart, which is
 * the drift #1551 spent a PR undoing. The only thing that varies between the verbs is which
 * milestone is stamped and what runs after the transaction, so those are the parameters.
 */
function visitMilestoneHandler(
  milestone: VisitMilestone,
  label: string,
  after?: (
    req: Request,
    ctx: {
      jobId: string;
      visitId: string;
      at: Date;
      jobNumber: string;
      crew: { user_id: string; user: VisitCrewMember | null }[];
      /**
       * The trip itself, for a callback that dispatches a VISIT-SCOPED occurrence (D18): its own
       * slot, not the job's mirror. `scheduled_at` and the location columns are untouched by
       * every one of the four milestone writes, so the row read before the transaction is still
       * the row afterwards.
       */
      visit: { scheduled_at: Date | null };
      /**
       * Where this trip is happening, already formatted (visit-location slice 4). Resolved in the
       * handler rather than here because the callback is synchronous and post-commit: an await in
       * it would turn a mail-field lookup into a 500 on a milestone that already landed.
       */
      visitLocation: string;
      /** The org clock the occurrence's date and time render in. */
      timeZone: string;
      /**
       * The organisation's main line, for the occurrence's {{technician.phones}} to fall back to
       * when nobody on the trip has a number (slice 5). Resolved in the handler for the same
       * reason `timeZone` and `visitLocation` are: this callback cannot await.
       */
      mainLine: string;
      /**
       * The organisation's own number for the crew on this trip - {{technician.servwave_phones}},
       * the whole of D7's chain already walked (slice 7). Resolved in the handler for the same
       * reason `mainLine` is: `resolveServWavePhones` reads the database and this callback is
       * synchronous and post-commit, so an await in it would turn a merge-field lookup into a 500
       * on a milestone that already landed.
       */
      servwavePhones: string;
    },
  ) => void,
) {
  return async function handler(req: Request, res: Response) {
    try {
      const id = param(req, 'id');
      const visitId = param(req, 'visitId');

      const existing = await prisma.job.findUnique({
        where: { id, ...tenantWhere(req) },
        select: {
          id: true, status: true, job_number: true,
          // Visit-location slice 4: the string `{{job.visit_location}}` falls back to when the
          // trip names no location of its own. The SAME three fields `{{job.address}}` renders,
          // joined by the same helper, because the two appear side by side in one email.
          service_location: { select: { address_line1: true, city: true, state: true } },
        },
      });
      if (!existing) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      // Scoped to BOTH this job and this tenant, the same way rescheduleVisit is: a visitId
      // belonging to another job, or to another organization, must not be reachable through this
      // job's URL.
      const visitRow = await prisma.visit.findFirst({
        where: { id: visitId, job_id: id, ...tenantWhere(req) },
        // D7a: the crew read comes off THIS VISIT, not off the job. The job-level question -
        // "are you on any of its trips", which is what OWN_JOB asks since S8 - would let a
        // technician crewed on visit 3 start visit 1.
        // Q4: `status` was missing entirely - worse than a bare immutability gap, because
        // stampVisitMilestone below writes the visit's STATUS as well as its timestamp
        // (VISIT_MILESTONE_COLUMNS), so POSTing e.g. /start on a CANCELLED visit RESURRECTS it:
        // a called-off trip comes back IN_PROGRESS and reappears on the dispatcher's board.
        //
        // Visit-location slice 4 widens this read rather than adding a second one. A visit-scoped
        // occurrence has to render THIS trip's slot, crew and place (D18), and this is already a
        // genuine `findFirst` on the visit - scoped to the job AND the tenant - so the location
        // RELATION `formatVisitLocation` needs can simply be asked for here. That is what the
        // booking doors' post-write re-read exists to obtain; their row comes back from
        // `visit.create`/`visit.update` carrying `location_id` and no relation, and this one does
        // not. Spread from the one exported select so every reader of the feature asks for the
        // same set.
        select: {
          id: true,
          status: true,
          scheduled_at: true,
          // Scheduling-notifications slice 08: the writer stamps every EARLIER milestone that is
          // still unstamped with this tap's instant (marked skipped) and rewinds every LATER one,
          // so it has to see the four stamps as they stand. Same read as the status above.
          en_route_at: true,
          on_site_at: true,
          started_at: true,
          completed_at: true,
          // The log rows are org-scoped like the visit; the writer stamps them from this read.
          organization_id: true,
          ...visitLocationSelect,
          // Slice 5: the crew driving to this trip, and the two columns that say how to reach
          // them. The en-route occurrence is the one that most needs it - an "on our way" naming
          // somebody the customer then cannot phone is the front-desk relay this field removes.
          assignees: {
            select: {
              user_id: true,
              user: { select: { first_name: true, last_name: true, ...performerPhoneSelect } },
            },
          },
        },
      });
      if (!visitRow) {
        res.status(404).json({ error: 'Visit not found' });
        return;
      }

      // D7a: any crew member ON THIS VISIT may drive it, with admins and dispatchers as the
      // fallback for when the tech on site cannot press the button - the org-manager clause is
      // preserved verbatim from the four job verbs.
      //
      // Deliberately NOT routed through canActOnRow, and S8's repoint does not change that:
      // OWN_JOB is now `{visits:{some:{assignees:{some:{user_id}}}}}`, which asks the JOB-level
      // question ("are you on ANY of this job's trips"). These four doors need the per-visit one,
      // so a technician crewed on visit 3 cannot drive visit 1.
      const isOrgManager = req.ability!.can('manage', 'all' as Subject) || req.user!.role === 'DISPATCHER';
      if (!isOrgManager && !visitRow.assignees.some((a) => a.user_id === req.user!.id)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      // Q4: refused EARLY, before the transaction, and after the per-instance authorization check
      // above (a caller with no business on this visit gets 403, not a status leak). None of
      // start/en-route/arrive/complete ever read `status` before this - see the resurrection note
      // on the select above.
      if (visitRow.status === 'CANCELLED') {
        res.status(409).json({ error: 'Visit is cancelled' });
        return;
      }

      const orgId = req.user!.organization_id;
      // ONE Date for both the column and anything keyed off it downstream. Two separate new Date()
      // calls are how a dedupe key stops matching the row it claims to describe (#1522's class).
      const at = new Date();
      const visit = await prisma.$transaction(async (tx) => {
        const moved = await stampVisitMilestone(tx, { visit: visitRow, milestone, at, actorId: req.user!.id });
        // D12: the job's status and its mirror columns are a CACHE of the visit set, recomputed in
        // the SAME transaction as the visit write.
        await syncJobFromVisits(tx, { jobId: id, orgId });
        return moved;
      });

      if (after) {
        // Everything the callback's visit-scoped occurrence renders, resolved HERE rather than
        // inside it: the callback is synchronous and runs post-commit, so an await in there would
        // let a merge-field lookup turn a milestone that already landed into a 500. Only the verbs
        // that actually dispatch pay for the timezone lookup, which is memoized per request and
        // never throws.
        const timeZone = await getRequestOrgTimezone(req);
        const mainLine = await getOrgMainLine(orgId);
        // Slice 7. Off `visitRow.assignees` - the crew ON THIS VISIT, the same rows the callback
        // names and the same ones its own crew gate counts - so an "on our way" cannot name one
        // person and offer another's number. `user_id` is the id; the nested `user` select carries
        // the names and the phone columns and no id, and a null relation is dropped from both
        // lists by the same filter.
        const servwavePhones = await resolveServWavePhones(
          orgId,
          visitRow.assignees.filter((a) => a.user != null).map((a) => a.user_id),
          mainLine,
        );
        after(req, {
          jobId: id,
          visitId: visitRow.id,
          at,
          jobNumber: existing.job_number,
          crew: visitRow.assignees,
          visit: visitRow,
          visitLocation: formatVisitLocation(visitRow, serviceAddressOf(existing.service_location)),
          timeZone,
          mainLine,
          servwavePhones,
        });
      }

      res.json({ visit });
    } catch (err) {
      logger.error(`${label} visit error:`, err);
      // The label names the milestone for the log line only. The body reaches the UI verbatim
      // through extractApiError, and "on the way" is a state rather than a verb, so the copy
      // does not try to conjugate it.
      res.status(500).json({ error: 'Failed to update visit' });
    }
  };
}

/** Move one visit to IN_PROGRESS and re-derive the job from its visits. */
export const startVisit = visitMilestoneHandler('started', 'Start');

/**
 * Move one visit to COMPLETED and re-derive the job from its visits.
 *
 * D7: this is NOT the job completing. Job.completed_at stays an explicitly-set job-level fact and
 * is never written from here - a job can be closed with a trip still on the books, and a job whose
 * last trip just finished is still IN_PROGRESS until somebody closes it.
 */
export const completeVisit = visitMilestoneHandler('completed', 'Complete');

/**
 * Move one visit to ON_SITE and re-derive the job from its visits.
 *
 * A technician being on site no longer moves the job's OWN status: EN_ROUTE and ON_SITE retire
 * from JobStatus and live on VisitStatus (D12/D17), and D12 defines IN_PROGRESS as "any visit
 * STARTED". So the job reads SCHEDULED with a crew on site, and the in-flight state is visible on
 * the visit chip. That is a deliberate, spec-mandated change to what the board colours in flight,
 * not an oversight. Job.on_site_at is still mirrored, but S5 repointed the lifecycle bar onto the
 * visit set, so that column now has NO reader anywhere in the tree - dropping it is S8's.
 */
export const arriveVisit = visitMilestoneHandler('on_site', 'Arrive');

/**
 * Move one visit to EN_ROUTE and re-derive the job from its visits.
 *
 * The JOB_EN_ROUTE automation keeps firing job-keyed with the visit's en_route_at as its
 * occurrence - the same contract dedupe.ts's OCCURRENCE_SCOPED map already records. Re-keying the
 * dedupe per visit is D18 and belongs to S7. `at` is the ONE Date the column was written with, so
 * the emitted key IS the persisted stamp rather than a second reading of the clock.
 */
export const enRouteVisit = visitMilestoneHandler('en_route', 'On the way', (req, ctx) => {
  // Crew-gated exactly as the job-level enRoute() is: the default automation tells the customer
  // who is on the way, so dispatching with an empty crew emails a notification naming nobody.
  if (ctx.crew.length === 0) return;
  dispatchAutomationEvent({
    type: 'JOB_EN_ROUTE',
    organizationId: req.user!.organization_id,
    entity: { type: 'job', id: ctx.jobId, label: ctx.jobNumber },
    occurrenceKey: ctx.at.toISOString(),
    // S7 (D18): two crews leaving for two trips on one job are two occurrences. This closes the
    // deferral this handler's own docstring recorded. `ctx.at` is still the ONE Date the column
    // was written with, so the emitted key IS the persisted stamp - and the visit id rides the
    // DEDUPE key only, leaving occurrence_key the bare ISO the stale-checks read it as.
    visitId: ctx.visitId,
    actorId: req.user?.id ?? null,
    // Visit-location slice 4: naming the visit in the dedupe key and then rendering the JOB's
    // fields is the mismatch `visitMergeFields` exists to remove. A crew leaving for the yard on
    // a job whose next upcoming trip is at the customer's house would otherwise mail "on our way"
    // beside that trip's date and that trip's address. The crew is the one ON THIS VISIT, exactly
    // as the gate above reads it.
    eventPayload: {
      mergeFields: visitMergeFields(
        ctx.visit,
        ctx.crew.map((a) => a.user).filter((u): u is VisitCrewMember => u != null),
        ctx.timeZone,
        ctx.visitLocation,
        // Slice 5: resolved in the handler with the timezone, not here - this callback is
        // synchronous and post-commit, so an await in it would turn a merge-field lookup into a
        // 500 on a milestone that already landed.
        ctx.mainLine,
        // Slice 7, resolved in the handler for the same reason and off the same crew rows.
        ctx.servwavePhones,
      ),
    },
  });
});

/**
 * Cancel ONE visit (D19). The row is KEPT as CANCELLED - never deleted - and it keeps its
 * visit_seq, because the number has already been in a customer's inbox (D13).
 *
 * D16: cancelling a visit unschedules that visit. It does NOT cancel the job; only a dispatcher
 * cancelling the job itself does that. If this was the job's last live trip the derivation
 * answers UNSCHEDULED and the schedule mirror collapses to null.
 */
export const cancelVisitSchema = z.object({
  // Q4: trimmed BEFORE the length check, and the TRIMMED value is what validate() replaces
  // req.body with - so a whitespace-only reason 400s instead of passing min(1) and landing,
  // verbatim, in the customer-facing cancellation history and the timeline description below.
  cancelled_reason: z.string().trim().min(1).max(5000),
  // Accepted and ignored, exactly as createJobVisitSchema and rescheduleJobVisitSchema already do:
  // per-visit customer email is S7, which lands on top of SRVW-243 rather than racing it. No
  // `.default()` on anything here - validate() replaces req.body with the parse result, so a
  // default would turn "not mentioned" into an explicit value.
  notify: z
    .object({
      notify_customer: z.boolean().optional(),
      // `.email()` and the capped cc array match assignJobSchema (:432) exactly. Before S7 this
      // was a bare z.string() with no cc at all, so a malformed address reached the provider
      // through the visit door and Zod SILENTLY STRIPPED the composer's CC list - a success
      // toast and no mail to the person who was copied.
      notify_recipient_email: z.string().email().optional(),
      notify_cc_emails: z.array(z.string().email()).max(5).optional(),
      notify_message: z.string().max(5000).optional(),
    })
    .optional(),
});

/**
 * Q4's "a trip already called off cannot be called off again", written as an accept-set so the
 * guarded writer can enforce it against the row it is about to touch rather than against a
 * snapshot read moments earlier.
 *
 * Everything except CANCELLED, COMPLETED included. Cancelling a trip the crew already finished is
 * something this door has always permitted, and closing a race is not the place to quietly take
 * that away - the pre-check being relocated here refused exactly one status, and so does this.
 */
const CANCELLABLE_VISIT_STATUSES = [...LIVE_VISIT_STATUSES, 'COMPLETED'] as const;

/**
 * Internal sentinel: the visit was cancellable in the pre-transaction read but another request had
 * already cancelled it by the time the guarded write ran. Thrown INSIDE the transaction so the
 * loser rolls back with the no-op write - its VISIT_CANCELLED timeline row and the job-status
 * derivation included - and so the winner's reason stands. Never escapes this module; cancelVisit
 * maps it to the SAME 409 the sequential second call already gets a few lines above.
 */
class VisitAlreadyCancelledError extends Error {}

export async function cancelVisit(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const visitId = param(req, 'visitId');
    const { cancelled_reason, notify } = req.body as {
      cancelled_reason: string;
      notify?: {
        notify_customer?: boolean;
        notify_recipient_email?: string;
        notify_cc_emails?: string[];
        notify_message?: string;
      };
    };
    const notifyCustomer = notify?.notify_customer === true;

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        job_number: true,
        // S7: the customer email's own fields, same widening as the two schedule-changing writers.
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, city: true, state: true } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // The route gate only asks whether this principal may EVER reschedule, and `reschedule Job` is
    // an OWN_JOB-scoped per-user capability - so without the per-instance check its holder could
    // call off a trip on ANY job in the org, and if that was the job's last live visit the
    // derivation unschedules it off the dispatcher's board. Its three sibling visit routes all
    // apply this; cancel is not the weaker door.
    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'reschedule'))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const visitRow = await prisma.visit.findFirst({
      where: { id: visitId, job_id: id, ...tenantWhere(req) },
      // S7 widens this select and keeps all three predicates. The trip's own number and the slot
      // it WAS in are what the cancellation notice is about. Q4: `status` was missing entirely, so
      // an already-cancelled visit could be re-cancelled with its reason silently overwritten.
      select: {
        id: true, visit_seq: true, status: true, scheduled_at: true,
        // The window the customer was holding, and who they were expecting (MV-NOTIF-10).
        scheduled_end: true,
        assignees: { select: { user: { select: { first_name: true, last_name: true } } } },
      },
    });
    if (!visitRow) {
      res.status(404).json({ error: 'Visit not found' });
      return;
    }

    // Q4: refused EARLY, before the transaction - a trip already called off cannot be called off
    // again, and re-cancelling it would silently overwrite the FIRST reason with whatever this
    // request sent, which is the customer-facing history #1550's class taught us to protect.
    if (visitRow.status === 'CANCELLED') {
      res.status(409).json({ error: 'Visit is cancelled' });
      return;
    }

    const orgId = req.user!.organization_id;
    const visit = await prisma.$transaction(async (tx) => {
      // The SAME writer the lead side uses, passed no lead - not a job-side fork (D3).
      //
      // `visitRow` was read BEFORE this transaction opened, so the Q4 check above tested a
      // snapshot, not a lock: two requests arriving together both saw it uncancelled and, with an
      // unconditional write, the second silently overwrote the first one's reason. The accept-set
      // moves that same check into the WHERE, where Postgres settles it.
      const { cancelled } = await cancelWalkthroughRow(tx, {
        walkthroughId: visitRow.id,
        orgId,
        cancelledAt: new Date(),
        reason: cancelled_reason,
        cancelledBy: req.user!.id,
        acceptStatuses: CANCELLABLE_VISIT_STATUSES,
      });
      if (!cancelled) throw new VisitAlreadyCancelledError();
      await syncJobFromVisits(tx, { jobId: id, orgId });
      // D16: the TRIP is off. Deliberately not the 'CANCELLED' event_type the job-level cancel
      // writes - that would read as the job having been called off. ActivityPanel falls through
      // to the description for any unrecognised type, which is what this row wants.
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'JOB',
          entity_id: id,
          event_type: 'VISIT_CANCELLED',
          description: `Visit ${cancelled.visit_seq} cancelled: ${cancelled_reason}`,
          metadata: { visit_id: cancelled.id, visit_seq: cancelled.visit_seq, reason: cancelled_reason },
          created_by: req.user!.id,
        },
      });
      return cancelled;
    });

    // D16: this trip is off; the JOB is not cancelled, even when the derivation just took it to
    // UNSCHEDULED because that was its last live visit. customer_email_sent_at is neither stamped
    // nor cleared here - it records that the trip WAS announced, and it was.
    //
    // No automation event: there is no cancelled-visit member in AutomationTriggerType, and
    // adding one needs a schema enum value, a portable enum migration, a TRIGGERS entry, a
    // merge-field set and an audiencesFor entry, or catalog.test.ts's exhaustiveness check
    // reddens. Out of scope for this slice.
    const notifyResult = notifyCustomer
      ? await notifyCustomerOfSchedule(req, {
          jobId: id,
          jobNumber: existing.job_number,
          customer: existing.customer,
          serviceLocation: existing.service_location,
          // #2175: the cancelled trip. The cancellation copy names no place today, so nothing is
          // resolved for it - see notifyCustomerOfSchedule - but the caller states which trip it
          // is about either way, the way every other door here does.
          visitId: visitRow.id,
          crew: visitRow.assignees.map((a) => a.user).filter((u): u is { first_name: string; last_name: string } => u != null),
          newStart: visitRow.scheduled_at,
          newEnd: visitRow.scheduled_end,
          kind: 'cancelled',
          visitSeq: visitRow.visit_seq,
          cancelledReason: cancelled_reason,
          recipientEmail: notify?.notify_recipient_email,
          cc: notify?.notify_cc_emails,
          message: notify?.notify_message,
        })
      : undefined;

    res.json({ visit, ...(notifyResult ? { notify: notifyResult } : {}) });
  } catch (err) {
    // Raced with another cancellation: the transaction rolled back with the no-op write, so this
    // request wrote nothing at all and never reached the customer notice.
    if (err instanceof VisitAlreadyCancelledError) {
      res.status(409).json({ error: 'Visit is cancelled' });
      return;
    }
    logger.error('Cancel visit error:', err);
    res.status(500).json({ error: 'Failed to cancel visit' });
  }
}

// ─── Editable record IDs (plan decision #7) ─────────────────────────────

/**
 * Read-only preview of a job renumber - no lock, no writes, matching computeRenumber's own
 * contract. Gated `renumber Job` at the route (DISPATCHER by default, ADMIN via manage-all);
 * canActOnRow mirrors the per-verb pattern the other job actions use (D14 reschedule,
 * manage_lines, delete, assign) for a grant condition distinct from plain `read`/`update`.
 */
export async function previewNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'renumber'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { number } = req.body as { number: string };

    try {
      const computation = await computeRenumber(prisma, 'job', existing.id, req.user!.organization_id, number);
      res.json(computation);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid record number')) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error('Preview job number error:', err);
    res.status(500).json({ error: 'Failed to preview job number change' });
  }
}

/**
 * Carries a conflict-bearing RenumberComputation out of the rename transaction to the HTTP
 * layer. applyRenumber itself throws only a plain, message-only Error on conflict (see
 * record-renumber.ts) - never a caller-supplied computation, by design, since it always
 * re-derives its own. So the 409 body's structured conflict list is built by computing the
 * SAME thing ourselves, fresh, inside the SAME locked transaction applyRenumber would
 * otherwise redo internally - not by guessing at an error shape the engine doesn't have.
 */
class RenumberConflictError extends Error {
  constructor(public readonly computation: RenumberComputation) {
    super('Number change has conflicts');
  }
}

/**
 * The real write. Gated `renumber Job` + the same per-instance canActOnRow as preview above.
 * Existence/ownership/format are all cheap to check before ever opening a transaction; only the
 * write itself needs the lock. Mirrors updateOrganization's `SELECT ... FOR UPDATE` row-lock
 * pattern, but at `FOR NO KEY UPDATE` strength: `jobs` is numbering.ts's default anchor and its
 * allocateAnchoredNumber already locks this exact row that way for the same reason (a plain
 * `FOR UPDATE` would conflict with the `FOR KEY SHARE` Postgres takes on `jobs` for every
 * FK-carrying insert - line items, invoices, stock movements, logistic orders - blocking all of
 * them for the life of this transaction; `FOR NO KEY UPDATE` still serializes against a
 * concurrent renumber/allocation on this same row without that collateral blocking).
 */
export async function renumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, job_number: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (!(await canActOnRow(req, 'Job', prisma.job, existing.id, 'renumber'))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { number } = req.body as { number: string };
    const orgId = req.user!.organization_id;

    let result: RenumberComputation;
    try {
      result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM jobs WHERE id = ${existing.id}::uuid AND organization_id = ${orgId}::uuid FOR NO KEY UPDATE`;

        const preview = await computeRenumber(tx, 'job', existing.id, orgId, number);
        if (preview.hasConflicts) {
          throw new RenumberConflictError(preview);
        }
        return applyRenumber(tx, 'job', existing.id, orgId, number);
      });
    } catch (err) {
      if (err instanceof RenumberConflictError) {
        res.status(409).json({ error: 'Number change has conflicts', ...err.computation });
        return;
      }
      if (err instanceof Error && err.message.startsWith('Invalid record number')) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Post-commit side effects, mirroring update()/cancel()'s ordering: the write is already
    // durable, so a timeline/audit failure here must not roll it back or fail the request.
    const derivedCount = result.derived.length + result.labelRefreshes.length;
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: existing.id,
        event_type: 'JOB_RENUMBERED',
        description: `Job number changed from ${result.oldNumber} to ${result.newNumber} (${derivedCount} related record${derivedCount === 1 ? '' : 's'} updated)`,
        metadata: { old_number: result.oldNumber, new_number: result.newNumber, derived_count: derivedCount },
        created_by: req.user!.id,
      },
    });
    void logAudit({
      req,
      action: 'job.renumbered',
      resourceType: 'Job',
      resourceId: existing.id,
      metadata: { old_number: result.oldNumber, new_number: result.newNumber },
    });

    // Built from the RenumberComputation itself (no extra re-select) - the frontend confirmation
    // dialog (a later PR) gets the full derived-change list in the same round trip.
    res.status(200).json({
      job: { id: existing.id, job_number: result.newNumber },
      ...result,
    });
  } catch (err) {
    logger.error('Rename job number error:', err);
    res.status(500).json({ error: 'Failed to change job number' });
  }
}
