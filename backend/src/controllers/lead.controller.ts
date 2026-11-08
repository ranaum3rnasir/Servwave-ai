import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { LEAD_SORT_FIELDS } from '../lib/sortFields';
import { applyFilters } from '../lib/query/filterEngine';
import { leadFacets } from '../lib/query/registries/lead.filters';
import { tenantWhere } from '../lib/tenant';
import { allocateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { computeRenumber, applyRenumber, validateNumberFormat, type RenumberComputation } from '../lib/record-renumber';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { findDuplicateCustomer, duplicateConflictBody } from '../lib/customer-duplicate';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany } from '../lib/customer-kind';
import { accreteContactMethods } from '../lib/customer-accretion';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import { loadTagsByEntity, loadTagsForEntity, type TagSummary } from '../lib/tags';
import {
  resolveOrAccreteLocation,
  buildLocationTaxWarning,
  LocationResolutionError,
  type LocationAddress,
} from '../lib/service-location';
import type { Subject } from '../lib/permissions/catalog';
import { isOwnerEligible } from '../lib/permissions/assignableRoles';
import { scopeWhereForReq, canAccessRow, canActOnRow } from '../lib/permissions/enforce';
import { isCustomerReadableRow, CUSTOMER_PROOF_SELECT } from '../lib/permissions/customerScope';
import { redactCustomerRowUnless, redactServiceLocationRowUnless } from '../lib/permissions/customerContact';
import { sendWalkthroughScheduledEmail, sendWalkthroughRescheduledEmail, type EmailDispatchResult, type OrganizationBrandingSubset } from '../lib/email';
import { DEFAULT_TIMEZONE } from '../lib/timezone';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { rearmAnchoredWaits } from '../services/automations/enrollment';
import { addOrFilter, addAndClause } from '../lib/permissions/whereCompose';
import { logAudit } from '../lib/audit';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';
import {
  projectLeadWalkthroughFields,
  projectLeadListWalkthroughFields,
  projectBoardWalkthroughVisits,
  projectCustomerTabWalkthrough,
  projectLeadVisitCrew,
  walkthroughSnapshotSelect,
  validatePerformers,
  detectPerformerConflicts,
  findActiveWalkthrough,
  findLeadVisit,
  findScheduledWalkthrough,
  findCurrentWalkthroughForLead,
  listLeadVisits,
  nextVisitSeqForLead,
  withVisitSeqRetry,
  createLeadVisit,
  scheduleActiveWalkthrough,
  unscheduleWalkthroughRow,
  completeWalkthroughRow,
  cancelWalkthroughRow,
  cancelLiveWalkthroughsOnLeadExit,
  LEAD_EXIT_WALKTHROUGH_REASON,
  LIVE_VISIT_STATUSES,
  type PerformerMember,
  type WalkthroughSnapshotRow,
} from '../services/walkthrough.service';
import { replaceVisitCrew } from '../services/visitCrew';
import { visitLocationField, visitLocationSelect, resolveVisitLocationWrite, loadVisitLocation, type VisitLocationInput } from '../services/visitLocation';
import { transitionLeadStatus, leadClockPatch, stampLeadClock, syncLeadWalkthroughStatus, LEAD_STATUS_LABEL } from '../services/lead-stage.service';
import { leadStatusOptions, loadLeadStatusFacts } from '../services/lead-status-options';

// ─── Select Objects ────────────────────────────────────

const leadListSelect = {
  id: true,
  lead_number: true,
  customer_id: true,
  status: true,
  service_request: true,
  job_type: true,
  scheduled_start: true,
  scheduled_end: true,
  service_city: true,
  service_state: true,
  notes: true,
  created_at: true,
  updated_at: true,
  // Walkthrough-as-entity redesign, PR-B2: walkthrough_scheduled_at/completed_at/
  // duration_minutes are no longer selected as raw legacy columns - projectLeadWalkthroughFields
  // (called from withTagsMany/exportAll) sources them from this relation instead, resolving
  // D15's "current visit" so they stay coherent under multiple visits.
  //
  // S8 (D6): `assignees` joins the snapshot here because `visit_assignees.lead_id` is dropped -
  // the lead's walkthrough crew is now reached through its trips. projectLeadVisitCrew flattens
  // it onto the INTERNAL `visit_assignees` key, which projectLeadWalkthroughFields then renames
  // to `walkthrough_performers` on the way out (#1637/#1642). The wire key readers see is the
  // latter; `visit_assignees` never reaches a client.
  // `phone` mirrors the job list select: it is the walkthrough crew's CONTACT, and the schedule
  // board's event editor offers call/text off it. It rides on the RECORD because the picker
  // roster (`GET /api/users/assignable`, gated on `assign User`) no longer carries contact
  // fields - who you may ADD is gated, who is ALREADY ON the record is not.
  // Slice 6: the location columns AND the relation, on the LIST as well as the detail, because the
  // scheduler board reads a walkthrough off this response. `projectLegacyWalkthroughFields`
  // collapses the relation into one resolved `walkthrough_location_label` and drops it, so nothing
  // here ships a copy of a Settings row (D2).
  // Slice 03 (visits-and-task-categories): `scheduled_end`, `is_all_day` and the crew's `user_id`
  // ride along for `walkthrough_visits`, the per-trip key the board draws one card per visit from
  // (projectBoardWalkthroughVisits). List-only, so the shared snapshot select stays as it is.
  visits: { select: { ...walkthroughSnapshotSelect, ...visitLocationSelect, scheduled_end: true, is_all_day: true, assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true, phone: true } } } } } },
  contacted_at: true,
  // email: see the job list select - the walkthrough composer needs it too (SRVW-243).
  customer: { select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true, phone: true, email: true, ad_source: true, service_locations: { where: { is_primary: true }, take: 1, select: { city: true, state: true } } } },
  // Scheduler redesign: the SINGLE owner (commission_owner) + the MULTI performer set.
  commission_owner: { select: { id: true, first_name: true, last_name: true } },
  lead_assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } } },

  estimates: {
    select: { id: true, total_amount: true },
  },
} satisfies Prisma.LeadSelect;

const leadDetailSelect = {
  id: true,
  lead_number: true,
  customer_id: true,
  status: true,
  service_request: true,
  job_type: true,
  scheduled_start: true,
  scheduled_end: true,
  service_address_line1: true,
  service_address_line2: true,
  service_city: true,
  service_state: true,
  service_zip: true,
  // Entity-redesign §3/§10: the lead's OWN anchored ServiceLocation. Every lead is created for
  // exactly ONE location, and this is it - the address the walkthrough happens at, the estimate
  // is priced against, and the crew eventually drives to. Without it the detail page had only
  // the customer's roster (selected below) to render, so on a multi-site account the address the
  // lead is actually about was indistinguishable from the ones it is not.
  service_location_id: true,
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
  // Walkthrough-as-entity redesign, PR-B2: every walkthrough_* field below is no longer a raw
  // legacy column read - projectLeadWalkthroughFields (called from withTags) sources them from
  // this relation, resolving D15's "current visit" so they stay coherent under multiple visits
  // (the raw columns' old incoherence bug - e.g. rescheduling never clearing
  // walkthrough_completed_at - is what this structurally fixes).
  //
  // S8 (D6): see the list select above - `assignees` rides along, projectLeadVisitCrew flattens
  // it onto the internal `visit_assignees`, and the last-mile projection renames that to the
  // `walkthrough_performers` wire key.
  // The six location COLUMNS *and*, since slice 6, the relation they point at.
  //
  // The COLUMNS are what the booking form seeds its "where" control off (projectVisitLocation) -
  // the picker already holds the organisation's locations and resolves the name from the id, so a
  // copy of the location's address would be the snapshot D2 exists to refuse. The RELATION is
  // followed server-side to render `walkthrough_location_label` for the visit cards and is dropped
  // by the projection, so it never reaches the wire and no client ever holds that copy.
  visits: { select: { ...walkthroughSnapshotSelect, ...visitLocationSelect, assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true, email: true } } } } } },
  contacted_at: true,
  contacted_note: true,
  notes: true,
  lost_at: true,
  lost_reason: true,
  cancelled_at: true,
  cancelled_reason: true,
  // SRVW-114 slice 3 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // bag off the detail payload; without it the panel renders every field blank.
  custom_fields: true,
  created_at: true,
  updated_at: true,
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
      phone_ext: true,
      ad_source: true,
      service_locations: {
        select: {
          id: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
          is_primary: true,
        },
        orderBy: { is_primary: 'desc' as const },
      },
    },
  },
  // walkthrough_canceller (the old direct Lead -> User relation) is superseded by the
  // `canceller` nested inside walkthroughs above - walkthrough_cancelled_by's PROJECTED value
  // now sources from the CURRENT visit's own canceller, not necessarily the lead's last-ever one.
  // Scheduler redesign: the SINGLE owner (commission_owner + the mirrored lead_assignees row)
  // and the MULTI walkthrough performer set.
  commission_owner: { select: { id: true, first_name: true, last_name: true, email: true } },
  lead_assignees: { select: { user_id: true, user: { select: { id: true, first_name: true, last_name: true } } } },

  estimates: {
    select: {
      id: true, estimate_number: true, status: true, total_amount: true, created_at: true,
      creator: { select: { id: true, first_name: true, last_name: true } },
      job: { select: { id: true, job_number: true, status: true } },
      // #2048 — the OTHER job pointer. `job` above is PROVENANCE (Job.estimate_id); `job_id` /
      // `job_link` is the ANCHOR (Estimate.job_id). The multi-estimate convert path deliberately
      // leaves `Job.estimate_id` NULL and attaches through this pointer instead
      // (job.controller.ts:2292-2340), so without it a folded estimate still reported as
      // convertible. Mirrors estimate.controller.ts's leadDetailSelect precedent (`job_link`).
      job_id: true,
      job_link: { select: { id: true, job_number: true, status: true } },
    },
    orderBy: { created_at: 'desc' as const },
  },
} satisfies Prisma.LeadSelect;

// ─── Zod Schemas ───────────────────────────────────────

const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
});

const newCustomerSchema = z.object({
  first_name: z.string().max(100).optional(),
  // Last name + company are optional; the customer needs a first name OR a company
  // name (unified-client-creation §2), and at least one of phone/email (SERV10X-35).
  last_name: z.string().max(100).optional(),
  company_name: z.string().max(200).optional(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  // #530 - the New Lead form's optional "Ext" beside Phone. Mirrors the
  // customer-controller shape so both create paths persist it identically.
  phone_ext: z.string().max(10).optional().nullable(),
  secondary_phone: optionalCustomerPhone,
  ad_source: z.string().max(100).optional().nullable(),
  location: locationSchema.optional(),
}).refine(hasNameOrCompany, {
  message: 'Provide a first name or a company name',
  path: ['first_name'],
}).refine(hasPhoneOrEmail, {
  message: CONTACT_REQUIRED_MSG,
  path: ['phone'],
});

const leadExtraFields = {
  job_type: z.string().max(100).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  scheduled_start: z.string().datetime().optional().nullable(),
  scheduled_end: z.string().datetime().optional().nullable(),
  // Entity-redesign §3: anchor the lead to one of the customer's ServiceLocations.
  // Precedence: service_location_id > new_location > legacy service_address_*.
  service_location_id: z.string().uuid().optional().nullable(),
  new_location: locationSchema.optional(),
  // Legacy denormalized address (backward-compat; dropped in Phase D).
  service_address_line1: z.string().max(200).optional().nullable(),
  service_address_line2: z.string().max(200).optional().nullable(),
  service_city: z.string().max(100).optional().nullable(),
  service_state: z.string().max(2).optional().nullable(),
  service_zip: z.string().max(10).optional().nullable(),
};

export const createLeadSchema = z
  .object({
    customer_id: z.string().uuid().optional(),
    new_customer: newCustomerSchema.optional(),
    // Existing-customer accretion (§5.3): a phone/email typed while linking to an
    // existing customer is added as a new secondary contact method, never overwriting
    // the primary. Only meaningful alongside customer_id; ignored on the new_customer path.
    phone: optionalCustomerPhone,
    email: optionalCustomerEmail,
    // Owner chosen at creation by a non-SALES creator (SALES always self-assigns).
    assigned_to: z.string().uuid().optional().nullable(),
    service_request: z.string().min(1).max(2000),
    notes: z.string().max(5000).optional(),
    ...leadExtraFields,
  })
  .refine(
    (data) => Boolean(data.customer_id) !== Boolean(data.new_customer),
    { message: 'Provide either customer_id or new_customer, not both' }
  );

export const updateLeadSchema = z.object({
  service_request: z.string().min(1).max(2000).optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.nativeEnum(LeadStatus).optional(),
  ...leadExtraFields,
  // SRVW-114 slice 3 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid, same
  // shape the job PATCH already accepts. Deliberately `unknown` per value: which values are
  // legal depends on the org's own definitions, so it is enforced downstream by
  // validateCustomFieldValues rather than by this schema. An explicit null clears a key
  // (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

// Lead owner is SINGLE (Decision: Ran). `null` clears the owner. Mirrored to
// commission_owner_id + exactly one lead_assignees row. (Walkthrough performers + job
// crews are MULTI; the owner is the off-board single picker.)
export const assignLeadSchema = z.object({
  assigned_to: z.string().uuid().nullable(),
  // #361: the assign popover's channel toggle. in_app:false suppresses ONLY the lead.assigned
  // emit to the new owner; lead.reassigned_away stays unconditional. Omitted → today's behavior.
  notify: z.object({ in_app: z.boolean().optional() }).optional(),
});

export const walkthroughSchema = z.object({
  walkthrough_scheduled_at: z.string().datetime().optional().nullable(),
  walkthrough_completed_at: z.string().datetime().optional().nullable(),
  walkthrough_notes: z.string().max(5000).optional().nullable(),
  walkthrough_duration_minutes: z.number().int().min(15).max(480).optional().nullable(),
});

export const markLostSchema = z.object({
  lost_reason: z.string().min(1).max(2000),
});

// contactLeadSchema was removed with contactLead (D6, PR-B2). The comment that replaced it
// claimed contacted_at was "inferred from outbound activity"; spec #1751 established that the
// inference never existed - between PR-B2 and now, the ONLY writer of contacted_at anywhere in
// the product was the demo seeder, which is why the dashboard's "needs follow-up" tile equals the
// open-lead count on every real org. D5 gives the column real writers (human-originated outbound
// call, text or email) and reinstates a hand-correction door scoped as a CORRECTION - below.
//
// `contacted_at` is required, not optional: this door exists to state a moment, and a body that
// named none would be asking the server to guess which of "now" and "leave it alone" was meant.
// It is deliberately NOT clearable (no `.nullable()`) - nothing in this spec un-sets a clock, and
// a door that could would let a missed response-time breach be erased.
export const contactLeadSchema = z.object({
  contacted_at: z.string().datetime(),
  contacted_note: z.string().max(5000).optional(),
});

// Walkthrough performers are MULTI (REPLACE semantics, like job crew). Crew ⟂ schedule:
// scheduling sets the time + the visit's own SCHEDULED status; performers are independent.
export const scheduleWalkthroughSchema = z.object({
  walkthrough_scheduled_at: z.string().datetime(),
  performer_ids: z.array(z.string().uuid()),
  walkthrough_duration_minutes: z.number().int().min(15).max(480).default(60),
  send_email: z.boolean().optional().default(true),
  force: z.boolean().optional().default(false),
  // SRVW-243 - "tell the customer", as a direct action. Deliberately SEPARATE
  // from send_email above, which gates the whole automation block (the customer
  // copy AND the internal performer notices) and defaults ON. This one is the
  // customer-facing send only, defaults OFF, and when set it REPLACES the
  // customer automation for this occurrence rather than adding to it.
  notify_customer: z.boolean().optional(),
  // SRVW-243 compose fields - same contract as assignJobSchema and the estimate
  // send. The recipient override is one-off and never written back to the customer.
  notify_recipient_email: z.string().email().optional(),
  notify_cc_emails: z.array(z.string().email()).max(5).optional(),
  notify_message: z.string().max(5000).optional(),
  // Where the walkthrough is actually happening (visit-location spec, slice 1). Three-state:
  // omitted leaves the stored location alone, `null` clears it back to the customer's service
  // address, and a value sets it. Refusing "a saved location AND a one-off address at once" is
  // this schema's job, not something the handler discovers when the DB CHECK fires - see
  // services/visitLocation.ts, which owns the shape so the three doors this slice leaves for
  // later add a DOOR rather than a second copy of the rules.
  location: visitLocationField,
});

// Performer-only REPLACE (no status/time change). See setPerformers().
export const setPerformersSchema = z.object({
  performer_ids: z.array(z.string().uuid()),
});

export const completeWalkthroughSchema = z.object({});

export const cancelWalkthroughSchema = z.object({
  cancelled_reason: z.string().min(1).max(2000),
});

export const cancelLeadSchema = z.object({
  cancelled_reason: z.string().min(1).max(2000),
});

// Editable record IDs (decision #7) - preview + rename share this body shape. The
// charset/length/numeric-cap rules live in validateNumberFormat inside record-renumber.ts
// (invoked by computeRenumber/applyRenumber), NOT duplicated here - this schema only
// guarantees `number` is present and a string.
export const leadNumberSchema = z.object({
  number: z.string(),
}).strict();

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

/**
 * Build a LocationAddress from a new_location object or the legacy
 * service_address_* fields (precedence: new_location > legacy). Returns null when
 * neither carries a usable address (line1 + zip).
 */
function pickLocationAddress(body: {
  new_location?: LocationAddress | null;
  service_address_line1?: string | null;
  service_address_line2?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
}): LocationAddress | null {
  if (body.new_location && body.new_location.address_line1 && body.new_location.zip) {
    return body.new_location;
  }
  if (body.service_address_line1 && body.service_zip) {
    return {
      address_line1: body.service_address_line1,
      address_line2: body.service_address_line2 ?? null,
      city: body.service_city ?? '',
      state: body.service_state ?? '',
      zip: body.service_zip,
    };
  }
  return null;
}

/**
 * Entity-redesign §8/§10 cascade: void UNPAID kind=DEPOSIT Invoices on the given
 * estimates. "Unpaid" = InvoiceStatus ∈ {DRAFT, SENT} with no non-voided Payment.
 * A deposit invoice carrying real money (any non-voided Payment) is NOT voided —
 * its money routes through refund (§8), never cancel.
 */
async function voidUnpaidDepositInvoices(req: Request, estimateIds: string[]): Promise<void> {
  if (estimateIds.length === 0) return;
  const depInvoices = await prisma.invoice.findMany({
    where: {
      ...tenantWhere(req),
      estimate_id: { in: estimateIds },
      kind: 'DEPOSIT',
      status: { in: ['DRAFT', 'SENT'] },
    },
    select: { id: true, payments: { where: { voided_at: null }, select: { id: true } } },
  });
  const voidIds = depInvoices.filter(i => i.payments.length === 0).map(i => i.id);
  if (voidIds.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: voidIds } },
      data: { status: 'VOIDED', voided_at: new Date() },
    });
  }
}

/** True when the request body attempts to change the lead's service location. */
function requestsLocationChange(body: {
  service_location_id?: unknown;
  new_location?: unknown;
  service_address_line1?: unknown;
  service_address_line2?: unknown;
  service_city?: unknown;
  service_state?: unknown;
  service_zip?: unknown;
}): boolean {
  return (
    body.service_location_id !== undefined ||
    body.new_location !== undefined ||
    body.service_address_line1 !== undefined ||
    body.service_address_line2 !== undefined ||
    body.service_city !== undefined ||
    body.service_state !== undefined ||
    body.service_zip !== undefined
  );
}

// Walkthrough-as-entity redesign, PR-B2: withTags/withTagsMany are the universal last-mile
// funnel every lead-returning handler already routes through, so this is where
// projectLeadWalkthroughFields runs - sourcing the walkthrough_* JSON fields from the lead's
// `walkthroughs` relation (D15's current visit) instead of the raw legacy columns, and renaming
// `visit_assignees` back to `walkthrough_performers` (#1637), while keeping the response field
// NAMES unchanged. withTags always carries a leadDetailSelect-shaped row
// (full field set); withTagsMany is list()'s leadListSelect-shaped rows (narrower set).
async function withTags<T extends { id: string; visits?: WalkthroughSnapshotRow[]; visit_assignees?: unknown }>(
  req: Request,
  lead: T,
): Promise<Omit<T, 'visits' | 'visit_assignees'> & { tags: TagSummary[] }> {
  const tags = await loadTagsForEntity(req, 'LEAD', lead.id);
  return { ...projectLeadWalkthroughFields(projectLeadVisitCrew(lead), { full: true }), tags };
}

async function withTagsMany<T extends { id: string; visits?: WalkthroughSnapshotRow[]; visit_assignees?: unknown }>(
  req: Request,
  leads: T[],
): Promise<Array<Omit<T, 'visits' | 'visit_assignees'> & { tags: TagSummary[] }>> {
  const grouped = await loadTagsByEntity(req, 'LEAD', leads.map((l) => l.id));
  return leads.map((l) => ({
    ...projectLeadListWalkthroughFields(l),
    // Slice 03: every non-cancelled trip, for the scheduler's one-card-per-visit board. The flat
    // walkthrough_* fields above stay for the list's other readers.
    walkthrough_visits: projectBoardWalkthroughVisits(l.visits),
    // Slice 05: the trip the customer page's Leads tab shows (next upcoming, else latest past,
    // never cancelled), resolved here so the tab needs no per-visit feed. The flat fields keep
    // the leads list's own rule.
    next_walkthrough: projectCustomerTabWalkthrough(l.visits),
    tags: grouped.get(l.id) ?? [],
  }));
}

// #233 / audit F-012: monetary summary fields embedded on a lead's estimate(s). Stripped
// in-place from the lead-detail payload when the requester cannot `read Estimate`, so a
// walkthrough-only technician sees an estimate exists (id/number/status) but not its dollars.
// (leadDetailSelect only selects total_amount today; the rest are guarded defensively in case
// the sub-select grows — and no estimate line items are embedded, so there's nothing per-line.)
const ESTIMATE_MONETARY_FIELDS = ['total_amount', 'subtotal', 'tax_amount', 'discount_amount', 'deposit_amount'] as const;

function stripEstimateMonetaryFields(lead: { estimates?: Array<Record<string, unknown>> | null }): void {
  for (const estimate of lead.estimates ?? []) {
    for (const field of ESTIMATE_MONETARY_FIELDS) {
      delete estimate[field];
    }
  }
}

/**
 * #233 / audit F-012, extended by the technician-ownership spec (2026-08-05, live QA): TECHNICIAN
 * and SALES both hold a CONDITIONAL `read Estimate` grant (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR), so
 * `req.ability!.can('read', 'Estimate')` is a SUBJECT-level CASL check - it is true whenever the
 * role holds ANY read grant, regardless of whether THIS row matches it. A lead's embedded
 * estimates are always lead-anchored (their `lead_id` is this lead's id), so only the
 * lead-anchored arm of that condition (`lead.lead_assignees.some`) can ever apply - the
 * lead-less/creator arm is structurally impossible here.
 *
 * For SALES this is a no-op: its Lead-read condition (OWN_LEAD) is the SAME `lead_assignees`
 * relation the estimate condition checks, so a lead SALES can read always satisfies it too. For
 * TECHNICIAN it is NOT a no-op: its Lead-read condition (OWN_WALKTHROUGH) is a DIFFERENT relation
 * (walkthrough performer) - a walkthrough-only technician can read a lead they are not a
 * lead_assignee on, and without this per-lead check they would see that lead's estimate dollars
 * too, purely because the subject-level ability check can't tell the rows apart.
 */
async function canSeeLeadEstimateMoney(
  req: Request,
  lead: { lead_assignees?: Array<{ user_id: string }> | null },
): Promise<boolean> {
  if (!req.ability!.can('read', 'Estimate' as Subject)) return false;
  const scope = await scopeWhereForReq(req, 'Estimate');
  if (Object.keys(scope).length === 0) return true; // ADMIN / unconditional reader
  return lead.lead_assignees?.some((a) => a.user_id === req.user?.id) ?? false;
}

async function stripEstimateMoneyUnlessVisible(
  req: Request,
  lead: { lead_assignees?: Array<{ user_id: string }> | null; estimates?: Array<Record<string, unknown>> | null },
): Promise<void> {
  if (!(await canSeeLeadEstimateMoney(req, lead))) stripEstimateMonetaryFields(lead);
}

// Walkthrough-as-entity redesign, PR-B2: replaceVisitCrew (services/visitCrew.ts) / validatePerformers /
// detectPerformerConflicts moved to services/walkthrough.service.ts, now keyed by walkthrough_id
// instead of lead_id (a lead can have many walkthroughs, each with its own crew) — imported
// above. PerformerMember is re-exported from there too.

// ─── Handlers ──────────────────────────────────────────

/**
 * Build the `where` clause (and the underlying grant-driven `scopeWhere`) for the lead
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `scopeWhere` too because `list()` reuses it
 * for the stats counts.
 */
export async function buildLeadListWhere(req: Request): Promise<{ where: Record<string, unknown>; scopeWhere: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';

  // #106: grant-DRIVEN row-scope (replaces the fail-open hand-rolled SALES-only block,
  // which let every other non-ADMIN role see the whole org). scopeWhereForReq resolves the
  // requesting role's Lead read grant → {} (ADMIN/unconditional), the owner/team/location
  // condition, or MATCH_NOTHING (no read grant = fail-closed). It is the OUTERMOST spread so
  // a per-request filter can't overwrite its keys (e.g. the MATCH_NOTHING `id`).
  const scopeWhere: Record<string, unknown> = await scopeWhereForReq(req, 'Lead');

  // Build where clause (org-scoped + grant-scoped). tenant first, scope outermost — so a
  // per-request filter can't overwrite the scope keys (e.g. MATCH_NOTHING's id). Matches the
  // spread order in the other 3 controllers.
  const where: Record<string, unknown> = { ...tenantWhere(req), ...scopeWhere };

  // Walkthrough-as-entity redesign, PR-B2: repointed from the legacy walkthrough_scheduled_at
  // column onto the relation.
  //
  // COMPOSED UNDER AND, NEVER ON `where.visits` (visits slice 03 - parity with job.controller's
  // window). SECURITY first: `scopeWhere.visits` may already hold a TECHNICIAN's OWN_WALKTHROUGH
  // read condition (defaultGrants.ts), and assigning over it is an RBAC bypass - so that key is
  // left exactly as the scope wrote it. And the two are SEPARATE questions: the scope asks "is
  // this tech on ANY trip of the lead?", the window asks "is ANY live trip of the lead in view?".
  // Merged into one `some` they became "is the tech's OWN trip in view", so a tech whose own trip
  // fell outside the week lost the lead - and the sibling trip's card with it - until they
  // switched to Month view. A tech on no trip of the lead still never matches: the scope clause
  // is untouched and ANDs with this one.
  const walkthroughAfter  = req.query.walkthrough_after  as string | undefined;
  const walkthroughBefore = req.query.walkthrough_before as string | undefined;
  if (walkthroughAfter || walkthroughBefore) {
    addAndClause(where, {
      visits: {
        some: {
          scheduled_at: {
            ...(walkthroughAfter  ? { gte: new Date(walkthroughAfter)  } : {}),
            ...(walkthroughBefore ? { lte: new Date(walkthroughBefore) } : {}),
          },
          // Multi-visit S6: a called-off trip is not on the board. Without this a lead whose ONLY
          // in-window walkthrough was cancelled still matched, and then rendered whatever
          // resolveCurrentWalkthrough picked - a time that need not be inside the window at all.
          status: { not: 'CANCELLED' },
        },
      },
    });
  }

  // Generalized filter engine (Task 4): status (enum-validated), job_type, ad_source
  // (Customer relation), walkthrough_status (synthetic — Walkthrough-as-entity redesign, PR-B2:
  // no longer touches `status` at all, so unlike before it has no ordering dependency on the
  // `status` facet above), assigned_to (scope-guarded — see lead.filters.ts), customer_id,
  // created_after/before, and estimates_min/estimates_max (countRange). leadFacets is a function of
  // scopeWhere so the assigned_to facet can enforce its RBAC no-op gate without any change to
  // the shared filterEngine.ts.
  await applyFilters(where, req, leadFacets(scopeWhere));

  if (search) {
    // Clobber-safe: a multi-read user's row-scope can itself be an `OR` (spread in above from
    // scopeWhereForReq). Assigning `where.OR` directly would silently drop it (row-scope LEAK),
    // so AND-merge the search OR onto any existing scope OR. See lib/permissions/whereCompose.
    addOrFilter(where, [
      // The Lead # rendered in the list must be typeable back into the search box. Every other
      // list controller already matches its own number (customer_number/job_number/
      // estimate_number/invoice_number), and global search matches lead_number since #1234 -
      // this list was the last surface where a number the user can plainly see returned nothing.
      { lead_number: { contains: search, mode: 'insensitive' } },
      { service_request: { contains: search, mode: 'insensitive' } },
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      { customer: { company_name: { contains: search, mode: 'insensitive' } } },
      // #352 — digit-normalized phone search on BOTH the legacy scalar Customer.phone
      // and the phones[] relation (CustomerPhone), matching customer.controller.ts /
      // global search parity (#350/#460). Both helpers return [] for digit-less terms,
      // so non-phone searches add no clauses.
      ...phoneSearchClauses(search).map((c) => ({ customer: c })),
      ...phoneRelationSearchClauses(search).map((c) => ({ customer: c })),
    ]);
  }

  return { where, scopeWhere };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, LEAD_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    // The id breaks ties (created_at from one import, or a status sort) so a page boundary never
    // repeats or skips a lead - the customer page pages a customer's leads through this list.
    const orderBy: Prisma.LeadOrderByWithRelationInput[] = [...sort.orderBy, { id: 'asc' }];

    const { where, scopeWhere } = await buildLeadListWhere(req);

    // Date boundaries for stats / "New This Week" (matches the client's created_after preset).
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [leads, total, statTotal, statNewThisWeek, statUnassigned, statWon, statLost] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: leadListSelect,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, created_at: { gte: startOfWeek } } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, AND: [{ lead_assignees: { none: {} } }] } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, status: 'WON' } }),
      prisma.lead.count({ where: { ...tenantWhere(req), ...scopeWhere, status: 'LOST' } }),
    ]);

    // #233 / audit F-012: leadListSelect embeds estimates { id, total_amount }. A requester
    // who can read these leads (e.g. a walkthrough-only TECHNICIAN via OWN_WALKTHROUGH) but
    // has NO `read Estimate` grant must NOT see the estimate's dollars. Same ABILITY-driven
    // gate + helper as getById (never a role literal). Per-lead, not per-request: a conditional
    // reader's Estimate scope depends on THIS lead's own assignees (canSeeLeadEstimateMoney).
    for (const lead of leads) {
      await stripEstimateMoneyUnlessVisible(req, lead);
    }

    res.json({
      leads: await withTagsMany(req, leads),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        total: statTotal,
        new_this_week: statNewThisWeek,
        unassigned: statUnassigned,
        won: statWon,
        lost: statLost,
      },
    });
  } catch (err) {
    logger.error('List leads error:', err);
    res.status(500).json({ error: 'Failed to list leads' });
  }
}

const EXPORT_ROW_CAP = 50_000;

// The leads still waiting on someone: an unassigned lead with a walkthrough booked or done needs an
// owner just as much as a new one, so both walkthrough statuses count in the "unassigned" tile.
const UNASSIGNED_COUNT_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED'];

/**
 * Export every lead matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV
 * the frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildLeadListWhere(req);
    const leads = await prisma.lead.findMany({
      where,
      select: leadListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (leads.length === EXPORT_ROW_CAP) {
      logger.warn(`Lead export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    // #233 / audit F-012: same embedded-estimate leak as list() — the export shares
    // leadListSelect, so strip estimate monetary fields from the CSV payload when the
    // requester can't `read Estimate` (ABILITY-driven, never a role literal). Per-lead - see
    // canSeeLeadEstimateMoney for why a subject-level check alone is not enough.
    for (const lead of leads) {
      await stripEstimateMoneyUnlessVisible(req, lead);
    }
    void logAudit({ req, action: 'lead.exported', resourceType: 'Lead', resourceId: null });
    // Walkthrough-as-entity redesign, PR-B2: exportAll bypasses withTagsMany (no tag
    // enrichment on the CSV path), so it needs its own projectLeadWalkthroughFields call to
    // source the walkthrough_* columns from the relation rather than the raw legacy ones.
    res.json({ leads: leads.map((lead) => projectLeadListWalkthroughFields(lead)) });
  } catch (err) {
    logger.error('Export leads error:', err);
    res.status(500).json({ error: 'Failed to export leads' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const {
      customer_id, new_customer, service_request, notes,
      job_type, ad_source, scheduled_start, scheduled_end,
      service_location_id, new_location,
      service_address_line1, service_address_line2, service_city, service_state, service_zip,
      phone, email,
    } = req.body;

    // Sales auto-assign to self; all other roles may pick an owner via the body.
    // SALES NEVER honors a body value and skips the eligibility guard (SALES is
    // owner-eligible by definition). bodyAssignee gates the guard so it runs ONLY
    // on a non-SALES, owner-supplied request — no extra DB read otherwise.
    const bodyAssignee = req.user?.role === 'SALES' ? null : (req.body.assigned_to ?? null);
    const assigned_to = req.user?.role === 'SALES' ? req.user.id : (bodyAssignee ?? undefined);

    if (bodyAssignee) {
      const targetUser = await prisma.user.findUnique({
        where: { id: bodyAssignee, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true },
      });
      if (!targetUser || !targetUser.is_active) {
        res.status(400).json({ error: 'Target user not found or inactive' });
        return;
      }
      if (!isOwnerEligible(targetUser.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as a lead owner' });
        return;
      }
    }

    // ad_source is NOT included here — it belongs on the customer row, not the lead
    const extraData = {
      job_type: job_type || null,
      scheduled_start: scheduled_start ? new Date(scheduled_start) : null,
      scheduled_end: scheduled_end ? new Date(scheduled_end) : null,
      service_address_line1: service_address_line1 || null,
      service_address_line2: service_address_line2 || null,
      service_city: service_city || null,
      service_state: service_state || null,
      service_zip: service_zip || null,
    };

    // Address resolved from new_location > legacy service_address_* (for accretion).
    const addressForResolve = pickLocationAddress(req.body);

    let finalCustomerId = customer_id;
    const orgId = req.user!.organization_id;
    // No status is passed on create: lead statuses are fixed, so the column's database default
    // (NEW) applies to every new lead.

    if (new_customer) {
      // Duplicate-customer guard (Fixes #42) — same check as POST /api/customers.
      // Runs before the transaction; `?override=true` bypasses it.
      const override = req.query.override === 'true';
      const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
        email: new_customer.email,
        phone: new_customer.phone,
      }, { requester: req });
      if (duplicateMatch && !override) {
        res.status(409).json(duplicateConflictBody(duplicateMatch));
        return;
      }

      // Inline customer creation via transaction
      // ad_source from new_customer schema is written to the customer row directly
      const result = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
        const { location, email, ad_source: newCustomerSource, ...customerData } = new_customer;
        // customer_number/kind/segment are NOT-NULL with no DB default — the shared
        // helper guarantees them (and organization_id) so this path can't drift
        // from POST /api/customers and silently 500 on a missing required column.
        const customer = await tx.customer.create({
          data: {
            ...(await withRequiredCustomerFields(tx, orgId, {
              ...customerData,
              // Email is optional — omitted/blank persists as NULL.
              email: email?.trim() || null,
              ad_source: newCustomerSource || ad_source || null,
            })),
            // Location is OPTIONAL — only seed a primary ServiceLocation when an address was given.
            ...(location ? { service_locations: { create: { ...location, is_primary: true } } } : {}),
            // Audit: the user who filed the lead also authored the customer this path mints. LAST
            // so it wins over the body-derived spread above.
            ...createdByUser(req),
          },
          select: { id: true, service_locations: { where: { is_primary: true }, take: 1, select: { id: true } } },
        });

        // On an override-create, record the bypassed duplicate on a CUSTOMER_CREATED
        // timeline event — the only forward audit trail for #42 (no merge tool yet).
        // Mirrors POST /api/customers; emitted only when a match was actually bypassed.
        // #1996: a requester who could not read the matched row gets a neutral description
        // and no `matched_customer_number` in the metadata.
        if (override && duplicateMatch) {
          await tx.timelineEvent.create({
            data: {
              organization_id: orgId,
              entity_type: 'CUSTOMER',
              entity_id: customer.id,
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

        // The freshly-created primary location is the lead's service_location_id.
        const primaryLocationId = customer.service_locations[0]?.id ?? null;

        const leadNumber = await allocateNumber(tx, 'lead', orgId);
        const lead = await tx.lead.create({
          data: {
            lead_number: leadNumber,
            customer_id: customer.id,
            service_request,
            notes: notes || null,
            // Write the SINGLE owner into the M2M spine (commission_owner_id + one
            // lead_assignees row) so the Owned-scope key is correct from creation.
            ...(assigned_to ? { commission_owner_id: assigned_to, lead_assignees: { create: { user_id: assigned_to, organization_id: orgId } } } : {}),
            organization_id: orgId,
            service_location_id: primaryLocationId,
            ...extraData,
            // Keep legacy denormalized address in sync from the primary location.
            service_address_line1: extraData.service_address_line1 ?? location?.address_line1 ?? null,
            service_address_line2: extraData.service_address_line2 ?? location?.address_line2 ?? null,
            service_city: extraData.service_city ?? location?.city ?? null,
            service_state: extraData.service_state ?? location?.state ?? null,
            service_zip: extraData.service_zip ?? location?.zip ?? null,
            // Audit: the user who filed the lead. LAST in the object on purpose - it must win over
            // the ...extraData spread above, which is body-derived.
            ...createdByUser(req),
          },
          select: leadDetailSelect,
        });

        // Multi-visit D22a: a new lead no longer gets a placeholder visit row. The bucket used
        // to be "has a REQUESTED visit", so create() had to seed one; it is now "has no live
        // visit", which a brand-new lead satisfies by having no visits at all. Minting a row
        // here would also be wrong under multi-visit - there is no single placeholder slot once
        // a lead can hold several trips.

        return lead;
      }), { label: 'lead.create.new_customer' });

      // #233 / audit F-012: defense-in-depth (a new lead has no estimates yet → no-op);
      // same ability-gated strip as the other lead-returning handlers.
      await stripEstimateMoneyUnlessVisible(req, result);

      // Emit unassigned_created only when the new lead has no owner.
      if (!result.commission_owner) {
        await emit({
          verb: 'lead.unassigned_created',
          organizationId: orgId,
          actorId: req.user?.id ?? null,
          object: { type: 'LEAD', id: result.id, label: result.lead_number },
          entity: {},
          data: { object_label: result.lead_number },
        });
      }

      // Automation Center — fires for EVERY new lead (the in-app verb only
      // covers unowned leads; automations cover the assigned path too).
      //
      // A new lead with an owner fires BOTH created and assigned. Task deliberately does the
      // opposite (Spec B): a task created with assignees fires TASK_CREATED only, and
      // TASK_ASSIGNED fires solely for someone added to a task that already existed. The two
      // are not an inconsistency to be tidied away in either direction:
      //   * a lead has exactly ONE owner, and LEAD_CREATED / LEAD_ASSIGNED were never seeded
      //     as an enabled pair, so a doubled email is a workflow an admin deliberately built.
      //   * a task takes SEVERAL people and both its defaults ship enabled, so the same shape
      //     would email every new task's assignees twice on day one.
      // Do not "fix" either site into agreement with the other without revisiting that.
      // -> src/controllers/task.controller.ts, create() and update().
      dispatchAutomationEvent({
        type: 'LEAD_CREATED',
        organizationId: req.user!.organization_id,
        entity: { type: 'lead', id: result.id, label: result.lead_number },
        actorId: req.user?.id ?? null,
      });
      if (assigned_to) {
        dispatchAutomationEvent({
          type: 'LEAD_ASSIGNED',
          organizationId: req.user!.organization_id,
          entity: { type: 'lead', id: result.id, label: result.lead_number },
          occurrenceKey: assigned_to,
          actorId: req.user?.id ?? null,
        });
      }
      void logAudit({ req, action: 'lead.created', resourceType: 'Lead', resourceId: result.id, metadata: { lead_number: result.lead_number } });
      res.status(201).json({ lead: await withTags(req, result) });
      return;
    }

    // Existing customer — verify it exists in the requesting org. Selects the #2041 proof
    // relations too (the row is otherwise used only for this existence + readability check).
    const customer = await prisma.customer.findUnique({
      where: { id: finalCustomerId, ...tenantWhere(req) },
      select: { id: true, ...CUSTOMER_PROOF_SELECT },
    });
    if (!customer) {
      res.status(400).json({ error: 'Customer not found' });
      return;
    }

    // Cross-customer accretion guard (#800 follow-up): a typed phone/email that belongs to a
    // DIFFERENT customer must not be silently accreted onto the linked one. Same 409 as the
    // new_customer path; `?override=true` (Create anyway → accrete onto the linked customer)
    // bypasses it. The linked customer is EXCLUDED so its own prefilled primary/secondary
    // never trips this — that same-customer case is deduped inside accreteContactMethods. This
    // guard's own 409 is ALREADY redacted per-requester by findDuplicateCustomer/
    // duplicateConflictBody (#1996) — it never depends on whether the requester can read the
    // LINKED customer, only the cross-matched one, so it runs before the #1996 follow-up gate
    // below.
    if (phone || email) {
      const override = req.query.override === 'true';
      const crossMatch = await findDuplicateCustomer(prisma, orgId, { phone, email }, {
        requester: req,
        excludeCustomerId: finalCustomerId,
      });
      if (crossMatch && !override) {
        res.status(409).json(duplicateConflictBody(crossMatch));
        return;
      }
    }

    // #2041 decision 8 (was #1996's refusal — see the migration note below): the create Lead
    // grant the route already enforced is the authority; a picker-visible customer the requester
    // is not otherwise associated with may still be booked. `customerReadable` instead gates
    // the two writes below (never accrete onto / relabel a customer the requester cannot read —
    // those are the only things on this path that could confirm a guessed id) and the response
    // redaction after the write.
    const customerReadable = isCustomerReadableRow(req, customer);

    let lead;
    try {
      lead = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
        // Update the customer's source if a new one was provided — only when the requester can
        // read the row (#2041 decision 8): this write is one of the two things on this path that
        // could confirm a guessed id.
        if (customerReadable && ad_source !== undefined) {
          await tx.customer.update({
            where: { id: finalCustomerId },
            data: { ad_source: ad_source || null },
          });
        }

        // Workiz-style accretion (spec §3/§5.3): a typed phone/email adds a new
        // secondary contact method on the customer; the primary is never touched. #2041 decision
        // 8: only when readable — a rep must not accrete a typed phone onto another rep's
        // customer record.
        if (customerReadable) {
          await accreteContactMethods(tx, finalCustomerId, { phone, email });
        }

        // Resolve the lead's service location: explicit id > new_location > legacy.
        // #2041 decision 8: an explicit `service_location_id` only VALIDATES an existing row
        // against the customer (a read), so it stays unconditional. A typed `new_location`
        // ACCRETES a new ServiceLocation onto the customer (a write) — gate it on
        // `customerReadable` same as the ad_source/accreteContactMethods writes above, or a rep
        // could insert an address onto a customer they cannot read (and learn from the dedupe
        // find-or-create whether that address already exists there). Falls through to the
        // primary-location lookup below, same as omitting a location entirely.
        let resolvedLocationId: string | null = null;
        if (service_location_id || (addressForResolve && customerReadable)) {
          const resolved = await resolveOrAccreteLocation(tx, {
            customerId: finalCustomerId,
            orgId,
            service_location_id: service_location_id ?? null,
            address: addressForResolve,
          });
          resolvedLocationId = resolved.id;
        }

        if (!resolvedLocationId) {
          // Lead service location is OPTIONAL. Prefer the customer's primary location
          // when one exists (e.g. Servy creating a lead by customer name); otherwise
          // leave it null — a lead may have no location. A JOB still requires one.
          const primaryLocation = await tx.serviceLocation.findFirst({
            where: { customer_id: finalCustomerId },
            orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
            select: { id: true },
          });
          resolvedLocationId = primaryLocation?.id ?? null;
        }

        const leadNumber = await allocateNumber(tx, 'lead', orgId);
        const created = await tx.lead.create({
          data: {
            lead_number: leadNumber,
            customer_id: finalCustomerId,
            service_request,
            notes: notes || null,
            // Write the SINGLE owner into the M2M spine (see new-customer path).
            ...(assigned_to ? { commission_owner_id: assigned_to, lead_assignees: { create: { user_id: assigned_to, organization_id: orgId } } } : {}),
            organization_id: orgId,
            service_location_id: resolvedLocationId,
            ...extraData,
            // Audit: the user who filed the lead (see the new-customer path for why this is last).
            ...createdByUser(req),
          },
          select: leadDetailSelect,
        });

        // Multi-visit D22a: no placeholder visit row (see the new-customer path above).

        return created;
      }), { label: 'lead.create' });
    } catch (e) {
      if (e instanceof LocationResolutionError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // #233 / audit F-012: defense-in-depth (a new lead has no estimates yet, so this is a
    // no-op today) — keep the same ability-gated strip as the other lead-returning handlers.
    await stripEstimateMoneyUnlessVisible(req, lead);

    // Emit unassigned_created only when the new lead has no owner.
    if (!lead.commission_owner) {
      await emit({
        verb: 'lead.unassigned_created',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id: lead.id, label: lead.lead_number },
        entity: {},
        data: { object_label: lead.lead_number },
      });
    }

    // Automation Center - fires for EVERY new lead (see note on the other path, including
    // why task's created/assigned pair is deliberately mutually exclusive where this one is not).
    dispatchAutomationEvent({
      type: 'LEAD_CREATED',
      organizationId: req.user!.organization_id,
      entity: { type: 'lead', id: lead.id, label: lead.lead_number },
      actorId: req.user?.id ?? null,
    });
    if (assigned_to) {
      dispatchAutomationEvent({
        type: 'LEAD_ASSIGNED',
        organizationId: req.user!.organization_id,
        entity: { type: 'lead', id: lead.id, label: lead.lead_number },
        occurrenceKey: assigned_to,
        actorId: req.user?.id ?? null,
      });
    }
    void logAudit({ req, action: 'lead.created', resourceType: 'Lead', resourceId: lead.id, metadata: { lead_number: lead.lead_number } });
    // #2041 decision 8 — redact the response through the same contact strip evaluated AFTER the
    // write, for a requester who is still not associated with the linked customer. Findings 1/6:
    // the lead's OWN `service_location` (leadDetailSelect) is the SAME customer's street address
    // one key over from `customer` — strip it with the same verdict, or the contact block being
    // redacted is cosmetic.
    const presentedLead = (await withTags(req, lead)) as unknown as {
      customer?: Record<string, unknown> | null;
      service_location?: Record<string, unknown> | null;
    };
    res.status(201).json({
      lead: {
        ...presentedLead,
        customer: redactCustomerRowUnless(presentedLead.customer, customerReadable),
        service_location: redactServiceLocationRowUnless(presentedLead.service_location, customerReadable),
      },
    });
  } catch (err) {
    logger.error('Create lead error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: leadDetailSelect,
    });

    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update(). req.ability.can()
    // THROWS on a nested Team/Location read condition → 500; canAccessRow probes via findFirst.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, param(req, 'id')))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // #233 / audit F-012: a requester who can read this lead (e.g. a walkthrough-only
    // TECHNICIAN via OWN_WALKTHROUGH) but has NO `read Estimate` grant must NOT see the
    // embedded estimate's dollar value. Gate is ABILITY-driven (never a role literal): strip
    // the monetary summary fields when the requester can't actually see THIS lead's estimate
    // (canSeeLeadEstimateMoney - never a role literal, and not a subject-level ability check
    // alone, since a conditional grant like TECHNICIAN's is true for the role on every row).
    // Non-monetary fields (id / estimate_number / status) stay so the FE still shows it exists.
    await stripEstimateMoneyUnlessVisible(req, lead);

    // What the status menu may offer, with the lock text for each locked one. The menu renders
    // from this and holds no copy of the rules (walkthrough lead-statuses PRD 7.3).
    const status_options = leadStatusOptions(
      await loadLeadStatusFacts(prisma, {
        id: lead.id,
        organization_id: req.user!.organization_id,
        status: lead.status,
      }),
    );

    res.json({ lead: { ...(await withTags(req, lead)), status_options } });
  } catch (err) {
    logger.error('Get lead error:', err);
    res.status(500).json({ error: 'Failed to get lead' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.lead.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      // The anchor's state — not the deprecated `service_state` column — is the basis for the
      // cross-state tax warning below. A re-point writes ONLY `service_location_id`, so the
      // loose column keeps whatever CREATE put there and goes stale after the first move.
      include: { service_location: { select: { state: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe). req.ability.can() THROWS on a
    // nested Team/Location condition (lead_assignees.some.user.department_id) → 500; the
    // scoped findFirst compiles to SQL instead. Owner → match → proceed; non-owner → 403.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, param(req, 'id')))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Strip status from Sales — they can't change status directly
    const data = { ...req.body };
    if (req.user?.role === 'SALES') {
      delete data.status;
    }

    // LOST and CANCELLED are what POST /mark-lost and POST /cancel do. This door is gated only by
    // `update Lead`, which a role can hold without either verb (neither is on the Roles editor), so
    // ask for the same verb the dedicated door asks for: the subject-level check its route guard
    // makes, plus this row under that verb's own scope. Refused before anything is written, with
    // the door's 403.
    const exitAction = data.status === 'LOST' ? 'mark_lost' : data.status === 'CANCELLED' ? 'cancel' : null;
    if (
      exitAction &&
      !(req.ability?.can(exitAction, 'Lead') && (await canActOnRow(req, 'Lead', prisma.lead, param(req, 'id'), exitAction)))
    ) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Closing a lead always asks why (walkthrough lead-statuses PRD D11). This door carries no
    // reason, so a bare LOST or CANCELLED is refused before anything is written. The status menu
    // opens the Mark Lost / Cancel Lead dialogs and closes the lead through POST /mark-lost and
    // POST /cancel, which take the reason and do the walkthrough-cancelling side effects.
    if (exitAction) {
      res.status(400).json({ error: 'Please give a reason.' });
      return;
    }

    // A hand change is checked against the lead's real data before anything is written (walkthrough
    // lead-statuses PRD 7.3): the same function that builds `status_options` for the menu, so no
    // request can set a status the menu shows as locked. The refusal is the lock text, word for
    // word, because it reaches the user through `extractApiError`. Lost, Cancelled and Won are never
    // locked, and a lead's own status is never locked, so those pass straight through.
    if (data.status !== undefined && data.status !== existing.status) {
      const options = leadStatusOptions(
        await loadLeadStatusFacts(prisma, {
          id: param(req, 'id'),
          organization_id: req.user!.organization_id,
          status: existing.status,
        }),
      );
      const refusal = options.find((o) => o.status === data.status && !o.available);
      if (refusal) {
        res.status(409).json({ error: refusal.reason });
        return;
      }
    }

    // Spec #1751 D6: a hand-edited status is a transition like any other and goes through the one
    // writer, so it stamps won_at and leaves a from/to ledger entry. Before this, the ONLY record
    // of a status edit was the audit row logged below, which names which FIELDS changed and
    // nothing else — no from, no to, so no time-in-stage was computable from it even
    // retroactively. That is the defect this spec exists to close.
    const statusChange: LeadStatus | undefined = data.status;
    /**
     * `notFrom: []` — a person editing the status directly is stating the outcome outright, and
     * the terminal guard that protects the AUTOMATIC writers must not stop them correcting a
     * mistake. This is exactly the behaviour the door has today; routing it through the helper
     * must not quietly make the field read-only once a lead is won.
     */
    const applyStatusChange = async (tx: Prisma.TransactionClient) => {
      if (!statusChange || statusChange === existing.status) return;
      await transitionLeadStatus(tx, {
        leadId: param(req, 'id'),
        orgId: req.user!.organization_id,
        to: statusChange,
        from: existing.status,
        actorId: req.user!.id,
        notFrom: [],
        description: `Lead status changed to ${LEAD_STATUS_LABEL[statusChange]}`,
        metadata: { via: 'manual_edit' },
      });
    };

    // Extract ad_source — it belongs on the customer, not the lead row.
    // Extract the location-change inputs — they go through resolveOrAccreteLocation,
    // never directly into the lead.update data (besides the legacy address sync).
    // SRVW-114 slice 3 - custom_fields is pulled out of the generic spread on purpose. `rest`
    // flows straight into prisma.lead.update, so leaving it in would write an arbitrary
    // caller-supplied bag over the stored one: no validation, and every untouched key lost.
    const { ad_source, service_location_id, new_location, custom_fields, ...rest } = data;
    const leadData = { ...rest };
    // Removed from the generic spread so `transitionLeadStatus` is the ONLY writer of the column
    // (D6). Leaving it here as well would work — the values agree — but it would leave a second
    // status writer in the codebase for the next change to diverge from, which is the exact
    // failure mode D6 exists to end. Re-added to the audit row's field list below so the audit
    // trail is unchanged by the move.
    delete leadData.status;

    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'LEAD', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      leadData.custom_fields = mergeCustomFields(
        existing.custom_fields as Record<string, unknown> | null,
        custom_fields,
      );
    }

    // Entity-redesign §10 EDIT-FREEZE: once any estimate exists, customer_id and
    // service_location_id freeze. A location change on a lead with ≥1 estimate is
    // rejected. Detail/scope edits (service_request, notes, …) are always allowed.
    const wantsLocationChange = requestsLocationChange(data);
    if (wantsLocationChange) {
      const estimateCount = await prisma.estimate.count({
        where: { ...tenantWhere(req), lead_id: param(req, 'id') },
      });
      if (estimateCount > 0) {
        res.status(400).json({ error: 'Location locked — lead has estimates' });
        return;
      }
    }

    // Resolve a location change on an OPEN lead (no estimate). Surface a tax-warning
    // when the new location's state differs from the lead's current location state.
    let resolvedLocationId: string | null | undefined;
    let taxWarning: ReturnType<typeof buildLocationTaxWarning> = null;
    const addressForResolve = pickLocationAddress(data);

    const explicitLocationChange = service_location_id !== undefined || new_location !== undefined ||
      data.service_address_line1 !== undefined || data.service_zip !== undefined;

    // An explicit `service_location_id: null` with no address is a CLEAR, not a resolve: there is
    // nothing for resolveOrAccreteLocation to look up or accrete (it throws on that input). It
    // used to fall through the `(service_location_id || addressForResolve)` guard below — null is
    // falsy — so the whole block was skipped, `leadData.service_location_id` was never assigned,
    // and the caller got a 200 for a write that never happened. `=== null` keeps this narrow:
    // `undefined` (key absent) stays a no-op.
    const explicitLocationClear = service_location_id === null && !addressForResolve;

    const runLeadUpdate = async (tx: typeof prisma) => {
      if (wantsLocationChange && explicitLocationChange && explicitLocationClear) {
        leadData.service_location_id = null;
        // No tax-warning: a cleared anchor has no new state, and buildLocationTaxWarning
        // returns null whenever either side is missing. The deprecated loose address columns
        // are deliberately NOT touched — they are not a mirror of the anchor.
      } else if (wantsLocationChange && explicitLocationChange && (service_location_id || addressForResolve)) {
        const resolved = await resolveOrAccreteLocation(tx as never, {
          customerId: existing.customer_id,
          orgId: req.user!.organization_id,
          service_location_id: service_location_id ?? null,
          address: addressForResolve,
        });
        resolvedLocationId = resolved.id;
        leadData.service_location_id = resolvedLocationId;
        // The resolved location's state drives the tax-warning — covering the
        // pick-from-existing (id) path, where no inbound address state exists.
        const newState = resolved.state ?? addressForResolve?.state ?? data.service_state;
        // Basis = the lead's CURRENT anchor. `service_state` is the deprecated loose column and
        // is never written on a re-point, so after one move it names the state the lead was
        // CREATED in, not the one it is leaving — which both suppresses real cross-state
        // warnings (a move back) and invents false ones. It survives here only as the fallback
        // for legacy leads that have no anchor to read.
        const oldState = existing.service_location?.state ?? existing.service_state;
        taxWarning = buildLocationTaxWarning(oldState, newState);
      }
      // BEFORE the update below, so the row this returns already carries the new status and the
      // response needs no second read.
      await applyStatusChange(tx as unknown as Prisma.TransactionClient);
      return tx.lead.update({
        where: { id: param(req, 'id') },
        data: leadData,
        select: leadDetailSelect,
      });
    };

    let lead;
    try {
      if (ad_source !== undefined) {
        // Atomic: update customer source + lead in one transaction
        lead = await prisma.$transaction(async (tx) => {
          await tx.customer.update({
            where: { id: existing.customer_id, ...tenantWhere(req) },
            data: { ad_source: ad_source || null },
          });
          return runLeadUpdate(tx as never);
        });
      } else if (explicitLocationChange || statusChange) {
        // Location resolution needs a tx (accretion is a create). So does a status change: the
        // status write, the clock and the ledger entry are one fact and must not half-commit.
        lead = await prisma.$transaction(async (tx) => runLeadUpdate(tx as never));
      } else {
        lead = await prisma.lead.update({
          where: { id: param(req, 'id') },
          data: leadData,
          select: leadDetailSelect,
        });
      }
    } catch (e) {
      if (e instanceof LocationResolutionError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // #233 / audit F-012: same write-path leak as getById. A walkthrough-only
    // TECHNICIAN reaches PATCH /:id via OWN_WALKTHROUGH (`update Lead`) but has no
    // `read Estimate` grant → strip the estimate's monetary fields before responding.
    // `lead` is response-bound only here (taxWarning is computed inside the tx, not from
    // estimate dollars), so this in-place strip is safe.
    await stripEstimateMoneyUnlessVisible(req, lead);

    const payload = await withTags(req, lead);
    void logAudit({
      req,
      action: 'lead.updated',
      resourceType: 'Lead',
      resourceId: param(req, 'id'),
      metadata: { fields: [...Object.keys(leadData), ...(statusChange ? ['status'] : [])] },
    });
    res.json(taxWarning ? { lead: payload, tax_warning: taxWarning } : { lead: payload });
  } catch (err) {
    logger.error('Update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
}

// ─── Casual Delete ───────────────────────────────────
//
// Entity-redesign §10: low-friction hard-delete, allowed ONLY when the lead has
// NO estimate AND no Payment anywhere in its subtree. NEVER cascades (the guards
// guarantee a childless lead). Force-purge (purgeLeadSubtree) is the separate
// admin-only audited path, not this.

export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      include: {
        lead_assignees: { select: { user_id: true } },
        // S8 (D6): crew through the trips - `visit_assignees.lead_id` is gone.
        visits: { select: { assignees: { select: { user_id: true } } } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Guard 1: no estimate on the lead.
    const estimateCount = await prisma.estimate.count({
      where: { ...tenantWhere(req), lead_id: id },
    });
    if (estimateCount > 0) {
      res.status(400).json({ error: 'Lead has estimates — cancel or mark lost instead' });
      return;
    }

    // Guard 2: no Payment anywhere in the lead subtree (invoices anchored by the
    // lead's estimates OR by jobs on those estimates).
    const paymentCount = await prisma.payment.count({
      where: {
        voided_at: null,
        invoice: {
          ...tenantWhere(req),
          OR: [
            { estimate: { lead_id: id } },
            { job: { estimate: { lead_id: id } } },
          ],
        },
      },
    });
    if (paymentCount > 0) {
      res.status(400).json({ error: 'Lead has recorded payments — cannot delete' });
      return;
    }

    await prisma.lead.delete({ where: { id } });
    void logAudit({ req, action: 'lead.deleted', resourceType: 'Lead', resourceId: id });
    res.status(204).send();
  } catch (err) {
    logger.error('Delete lead error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
}

// Lead owner is SINGLE (Ran). `assigned_to` is one id (or null to clear). The owner is
// mirrored to BOTH commission_owner_id AND exactly one lead_assignees row (the Owned-scope
// key). NO owner↔performer auto-sync — walkthrough performers are an independent MULTI set.
export async function assign(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // GAP-4: per-instance scope (nested-safe), mirroring update/contact/cancel/etc. The
    // route guard (canDo('assign','Lead')) is a BARE-subject check and does NOT bind the
    // row, so a row-scoped principal holding `assign` could otherwise reassign a lead it
    // cannot access. ADMIN/unconditional → fast-path true (no query).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { assigned_to, notify } = req.body as {
      assigned_to: string | null;
      notify?: { in_app?: boolean };
    };

    // assigned_to === null clears the owner (commission_owner_id + all lead_assignees rows).
    if (assigned_to !== null) {
      const targetUser = await prisma.user.findUnique({
        where: { id: assigned_to, ...tenantWhere(req) },
        select: { id: true, role: true, is_active: true, organization_id: true },
      });

      if (!targetUser || !targetUser.is_active) {
        res.status(400).json({ error: 'Target user not found or inactive' });
        return;
      }

      if (!isOwnerEligible(targetUser.role)) {
        res.status(400).json({ error: 'This user is not eligible to be assigned as a lead owner' });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    // Capture old owner BEFORE the update so lead.reassigned_away can reference it.
    const previousOwnerId = existing.commission_owner_id ?? null;
    const lead = await prisma.$transaction(async (tx) => {
      // Mirror the SINGLE owner into lead_assignees: drop all, then create exactly one.
      await tx.leadAssignee.deleteMany({ where: { lead_id: id } });
      if (assigned_to !== null) {
        await tx.leadAssignee.create({ data: { lead_id: id, user_id: assigned_to, organization_id: orgId } });
      }
      return tx.lead.update({
        where: { id },
        data: {
          commission_owner_id: assigned_to,
        },
        select: leadDetailSelect,
      });
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    // Emit after the transaction commits.
    // #361: notify.in_app:false suppresses ONLY the new-owner notification; the outgoing
    // owner should always learn they were unassigned (lead.reassigned_away below).
    if (assigned_to !== null && notify?.in_app !== false) {
      await emit({
        verb: 'lead.assigned',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id, label: existing.lead_number },
        entity: { commission_owner_id: assigned_to },
        data: { object_label: existing.lead_number },
      });
    }
    if (previousOwnerId !== null && previousOwnerId !== assigned_to) {
      await emit({
        verb: 'lead.reassigned_away',
        organizationId: orgId,
        actorId: req.user?.id ?? null,
        object: { type: 'LEAD', id, label: existing.lead_number },
        entity: { previous_owner_id: previousOwnerId },
        data: { object_label: existing.lead_number },
      });
    }

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    if (assigned_to !== null) {
      dispatchAutomationEvent({
        type: 'LEAD_ASSIGNED',
        organizationId: orgId,
        entity: { type: 'lead', id, label: existing.lead_number },
        occurrenceKey: assigned_to,
        actorId: req.user?.id ?? null,
      });
    }

    // #585 — record the sold-by (commission owner) change on the lead timeline. Written
    // OUTSIDE the tx, mirroring contactLead's precedent (top-level timelineEvent.create).
    if (previousOwnerId !== assigned_to) {
      const ownerName = lead.commission_owner
        ? `${lead.commission_owner.first_name} ${lead.commission_owner.last_name}`
        : null;
      await prisma.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD',
          entity_id: id,
          event_type: 'OWNER_CHANGED',
          description: assigned_to === null
            ? `Sold-by cleared on ${existing.lead_number}`
            : `${ownerName ?? 'New owner'} set as sold-by on ${existing.lead_number}`,
          created_by: req.user!.id,
        },
      });
    }

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Assign lead error:', err);
    res.status(500).json({ error: 'Failed to assign lead' });
  }
}

// Walkthrough-as-entity redesign, PR-D2: writes the CURRENT visit's (D15) own notes/
// duration_minutes fields - the legacy Lead.walkthrough_notes/walkthrough_duration_minutes
// columns this handler used to dual-write are dropped, so the Walkthrough row is now the sole
// target.
export async function updateWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // This endpoint now only handles notes and duration updates
    // Scheduling/completion/cancellation use dedicated endpoints
    const { walkthrough_notes, walkthrough_duration_minutes } = req.body;

    const current = await findCurrentWalkthroughForLead(req, id);

    const lead = await prisma.$transaction(async (tx) => {
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });
      if (current) {
        await tx.visit.update({
          where: { id: current.id },
          data: {
            notes: walkthrough_notes ?? undefined,
            duration_minutes: walkthrough_duration_minutes ?? undefined,
          },
        });
      }
      return updatedLead;
    });

    // #233 / audit F-012: a walkthrough-only TECHNICIAN reaches this endpoint via
    // OWN_WALKTHROUGH (`update Lead`) but has no `read Estimate` grant → strip the
    // estimate's monetary fields before responding. Mirrors getById.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Update walkthrough error:', err);
    res.status(500).json({ error: 'Failed to update walkthrough' });
  }
}

// contactLead removed (D6, PR-B2). See the note on contactLeadSchema above: the "inferred from
// outbound activity" claim described an inference that was never built. Spec #1751 D5 owns both
// halves of the repair - the automatic writers and the hand-correction door.

// ─── Schedule Walkthrough ────────────────────────────

/**
 * Dispatch WALKTHROUGH_PERFORMER_REMOVED for each removed performer, carrying
 * their identity as eventPayload.recipient — by the time an automation fires
 * they're already off the walkthrough, so nothing downstream can re-derive
 * who they were. Never throws: a lookup failure must not turn an otherwise-
 * successful performer change into a 500 (mirrors job.controller.ts's
 * dispatchTechUnassigned).
 */
async function dispatchWalkthroughPerformerRemoved(
  req: Request,
  removedIds: string[],
  lead: { id: string; label: string },
  orgId: string,
  /** Set on the per-visit door: the occurrence is about THAT trip (D18). See walkthroughTarget. */
  visitId?: string,
): Promise<void> {
  if (removedIds.length === 0) return;
  let removedUsers: { id: string; email: string | null; first_name: string; last_name: string; phone: string | null }[] = [];
  try {
    removedUsers = (await prisma.user.findMany({
      where: { id: { in: removedIds }, ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, last_name: true, phone: true },
    })) ?? [];
  } catch (err) {
    logger.warn('Failed to resolve removed performers for WALKTHROUGH_PERFORMER_REMOVED — dispatching without a recipient', err);
  }
  for (const uid of removedIds) {
    const u = removedUsers.find((x) => x.id === uid);
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_PERFORMER_REMOVED',
      organizationId: orgId,
      entity: { type: 'lead', id: lead.id, label: lead.label },
      occurrenceKey: uid,
      ...(visitId ? { visitId } : {}),
      actorId: req.user?.id ?? null,
      ...(u ? { eventPayload: { recipient: u } } : {}),
    });
  }
}

/**
 * The trip a walkthrough door acts on (visits-and-task-categories slice 03).
 *
 * Two doors share each of schedule / performers / unschedule, the way POST /api/jobs/:id/assignees
 * and its /visits/:visitId twin share setAssignees. The legacy /walkthrough/* door acts on the
 * lead's CURRENT trip - the earliest live one - which is what the lead page means. The per-visit
 * /visits/:visitId/* door acts on the NAMED trip, which is what the scheduler means now that it
 * draws one card per walkthrough: dragging the Sep 30 card through the legacy door moved Sep 28.
 *
 * The named trip is scoped to this lead AND this organization (404 otherwise), and must still be
 * live: a called-off or finished trip is immutable at the API (409), exactly as on the job side -
 * rescheduling a COMPLETED row through scheduleActiveWalkthrough would silently reopen it.
 * Resolved only after the caller's lead-level authorization, so a refused caller learns nothing
 * about the lead's trips. `visitId` is the per-visit door's marker, and the notices it sends key
 * their occurrence on it (D18), so being moved or re-crewed on a second trip is never swallowed as
 * a duplicate of the first.
 */
async function walkthroughTarget(
  req: Request,
  leadId: string,
): Promise<
  | { ok: true; visit: Awaited<ReturnType<typeof findActiveWalkthrough>>; visitId?: string }
  | { ok: false; status: number; error: string }
> {
  const visitId = req.params.visitId as string | undefined;
  if (!visitId) return { ok: true, visit: await findActiveWalkthrough(req, leadId) };
  const visit = await findLeadVisit(req, leadId, visitId);
  if (!visit) return { ok: false, status: 404, error: 'Visit not found' };
  if (visit.status === 'CANCELLED') return { ok: false, status: 409, error: 'Visit is cancelled' };
  if (visit.status === 'COMPLETED') return { ok: false, status: 409, error: 'Visit is completed' };
  return { ok: true, visit, visitId: visit.id };
}

/**
 * SRVW-243 - the customer-facing half of `notify_customer: true` on
 * scheduleWalkthrough(). Mirrors notifyCustomerOfSchedule in job.controller.ts:
 * one EmailDispatchResult, never throws, decides nothing about the booking that
 * has already committed.
 *
 * Customer only. The performer and owner copies the pre-#1003 walkthrough sender
 * also fanned out are internal notices with no opt-in behind them; they stay
 * with the automation engine so a customer-facing tick cannot silently start
 * mailing staff.
 */
async function notifyCustomerOfWalkthrough(
  req: Request,
  args: {
    leadId: string;
    customer: { id: string; first_name: string | null; last_name: string | null; company_name: string | null; email: string | null } | null;
    /** The LEAD's own service address - the fallback, and what every walkthrough meant before
     *  a visit could carry a location of its own. */
    serviceAddress: string;
    /**
     * The ONE trip this notice is about, when the caller has one (#2175).
     *
     * A walkthrough carries its own location - the showroom is the case this feature was built
     * for - and `serviceAddress` above is the LEAD's, which is the customer's own house. Handing
     * the id over is what lets the address in this email be the trip's, and it is an id rather
     * than a resolved string deliberately: the resolution is a pointer-follow with exactly one
     * correct implementation, and a caller passing its own string would be free to drift from
     * what the automation engine renders for the same booking under
     * {{lead.walkthrough_location}}. Those two CAN both fire for one booking - the
     * notify_customer tick is deliberately independent of the engine, see scheduleWalkthrough -
     * so they must not be able to name two different places.
     *
     * Null / omitted resolves to the lead's service address exactly as before.
     */
    visitId?: string | null;
    performers: { first_name: string; last_name: string }[];
    scheduledAt: Date;
    isReschedule: boolean;
    /** Multi-visit D13 - the trip's own number, taken off the row the transaction wrote. */
    visitSeq?: number | null;
    /** Compose-dialog overrides; none of it written back to the customer record. */
    recipientEmail?: string;
    cc?: string[];
    message?: string;
  },
): Promise<EmailDispatchResult> {
  // Typed override wins; the saved address is the fallback. Trimmed so an
  // all-whitespace field falls through to no_recipient rather than reach Resend.
  const to = args.recipientEmail?.trim() || args.customer?.email;
  if (!to) return { status: 'skipped', reason: 'no_recipient' };

  const organizationId = req.user!.organization_id;
  const customerName =
    [args.customer?.first_name, args.customer?.last_name].filter(Boolean).join(' ')
    || args.customer?.company_name
    || 'there';
  const performerName =
    args.performers.map((u) => `${u.first_name} ${u.last_name}`.trim()).filter(Boolean).join(', ')
    || 'Our team';
  // One row for three things: the zone the time is rendered in, the name the customer
  // is told to contact, and (SRVW-243 header-brand fix) the org's own header wordmark/
  // logo, so the notice can no longer read as ServWave's rather than the org's own.
  // Two-to-three lookups could not disagree, but one is cheaper and this runs on the
  // response path.
  const orgRow = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, logo_url: true, brand_color: true, timezone: true },
  });
  const timezone = orgRow?.timezone || DEFAULT_TIMEZONE;
  const companyName = orgRow?.name ?? '';
  // Undefined, never a guessed name, when the org row itself is missing - wrapHtml's own
  // 'ServWave' fallback exists for exactly that case (see email.ts:55, 639-640).
  const org: OrganizationBrandingSubset | undefined = orgRow
    ? { id: organizationId, name: orgRow.name, logo_url: orgRow.logo_url, brand_color: orgRow.brand_color }
    : undefined;
  const record = {
    organizationId,
    customerId: args.customer?.id ?? null,
    leadId: args.leadId,
    // The reply anchor: the walkthrough notice, its reschedules and the
    // customer's reply are one conversation - see lib/reply-token.ts.
    entityType: 'lead',
    entityId: args.leadId,
  };

  // #2175: the TRIP's place when this notice is about one, the lead's service address when it is
  // not. The same read the automation context makes for {{lead.walkthrough_location}}, so one
  // booking cannot be announced twice naming two different places.
  const serviceAddress = args.visitId
    ? await loadVisitLocation(req, args.visitId, args.serviceAddress)
    : args.serviceAddress;

  const common = {
    organizationId, org, to, customerName, performerName, visitSeq: args.visitSeq,
    serviceAddress, timezone, record,
    cc: args.cc, message: args.message,
  };
  return args.isReschedule
    ? sendWalkthroughRescheduledEmail({ ...common, newDate: args.scheduledAt })
    : sendWalkthroughScheduledEmail({ ...common, scheduledDate: args.scheduledAt, companyName });
}

// Walkthrough performers are MULTI (REPLACE+diff, mirroring the job crew side). The schedule
// (time + SCHEDULED status on the Walkthrough row) is independent of the performer set. The
// customer "scheduled/rescheduled" automation is suppressed when there are 0 performers
// (Decision #9); the walkthrough_customer_email_sent_at flag is stamped only when performers≥1.
//
// Walkthrough-as-entity redesign, PR-B2 (D2/D5): the status guard is DELETED entirely — a visit
// action is never refused because of the lead's status. This creates-or-updates a visit row
// instead of stamping the lead directly; see walkthrough.service.ts's scheduleActiveWalkthrough.
//
// The lead's status FOLLOWS its visits (walkthrough lead-statuses PRD 6): once the visit is
// written, `syncLeadWalkthroughStatus` moves a New, Contacted or Walkthrough Completed lead to
// Walkthrough Scheduled, and does nothing to Estimate Sent, Won, Lost or Cancelled. A reschedule
// calls it too and it changes nothing, so no extra History row is written.
export async function scheduleWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const {
      walkthrough_scheduled_at, performer_ids, walkthrough_duration_minutes, send_email, force,
      notify_customer, notify_recipient_email, notify_cc_emails, notify_message, location,
    } = req.body as {
      walkthrough_scheduled_at: string;
      performer_ids: string[];
      walkthrough_duration_minutes?: number;
      send_email?: boolean;
      force?: boolean;
      notify_customer?: boolean;
      notify_recipient_email?: string;
      notify_cc_emails?: string[];
      notify_message?: string;
      // Absent when the caller said nothing about where - which is NOT the same as `null`, and
      // the difference is the whole of "moving the time must not move the meeting".
      location?: VisitLocationInput | null;
    };
    // Q1: the flat, three-state-capable boolean this door uses (undefined/true/false), same shape
    // as the job side's legacy assign() door. `undefined` -> unchanged, back-compat: the automation
    // fires. `true` -> unchanged: the direct send below fires, automation suppressed. `false` ->
    // NEITHER fires - the caller explicitly declined telling the customer, and the automation gate
    // below used to test bare `!notify_customer`, which is also true on a decline, silently mailing
    // the customer through the workflow anyway.
    const notifyDeclined = notify_customer === false;

    // HOISTED above the validator so the pool rule can see the CURRENT performer set. Without it
    // a self-only rep gets a 403 for editing only the TIME of a visit somebody else staffed - the
    // form resends the roster it was shown, so an unchanged restatement must not read as naming
    // other people. This read is side-effect-free, so moving it changes nothing but the order.
    // The lead's EARLIEST live visit, if any. Reusing it is a (re)schedule of the SAME visit;
    // when there is none live, this books a fresh, distinct visit. Booking an ADDITIONAL visit
    // alongside a live one is POST /api/leads/:id/visits, not this endpoint - see the visit
    // service for why this legacy path still collapses onto one row.
    // Slice 03: on the per-visit door (PATCH /:id/visits/:visitId) it is the NAMED trip instead.
    const target = await walkthroughTarget(req, id);
    if (!target.ok) { res.status(target.status).json({ error: target.error }); return; }
    const activeWalkthrough = target.visit;
    const wasAlreadyScheduled = activeWalkthrough != null;

    // Per-member eligibility: every performer must be an active, assignable in-org user. The pool
    // rule runs FIRST, inside the validator, so an id that resolves to nobody cannot answer 404
    // for a caller who was never allowed to name anyone - that would make the door a user-id oracle.
    const performers = await validatePerformers(
      req,
      performer_ids,
      activeWalkthrough ? activeWalkthrough.assignees.map((p) => p.user_id) : undefined,
    );
    if (!performers.ok) {
      res.status(performers.status).json({ error: performers.error });
      return;
    }

    // D8: a saved location must belong to THIS organisation before it can be written. Without the
    // check a crafted `location_id` puts another organisation's address into a customer's email -
    // the foreign key constrains the id to a real location, not to one this caller may see. Same
    // shape as validatePerformers above, including refusing with a 400 that is identical for "not
    // yours" and "does not exist", so the door is not an oracle for either.
    //
    // Ahead of the conflict check below on purpose: a body naming a location it may not have is
    // wrong regardless of whether the slot is free, and answering 409 first would tell the caller
    // about somebody else's calendar before refusing them.
    //
    // Slice 2 (D9): an ARCHIVED location is refused on the same 400, because hiding it in the
    // dropdown only reaches the clients that have reloaded since the branch closed.
    // `currentLocationId` is what stops that being destructive - this form states a location on
    // every save, so the visit already standing at a since-closed branch has to remain
    // rescheduleable without being moved off it.
    const locationWrite = await resolveVisitLocationWrite(req, location, {
      currentLocationId: activeWalkthrough?.location_id ?? null,
    });
    if (!locationWrite.ok) {
      res.status(locationWrite.status).json({ error: locationWrite.error });
      return;
    }

    const durationMinutes = walkthrough_duration_minutes || 60;
    const scheduledStart = new Date(walkthrough_scheduled_at);
    const scheduledEnd = new Date(scheduledStart.getTime() + durationMinutes * 60_000);

    // Diff vs the CURRENT performer set (drives conflict scope + diff-emails).
    const currentIds = new Set((activeWalkthrough?.assignees ?? []).map((p) => p.user_id));
    const nextIds = new Set(performer_ids);
    const addedIds = performer_ids.filter((uid) => !currentIds.has(uid));
    const keptIds = performer_ids.filter((uid) => currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    // Did the time change? (a kept performer at a brand-new slot can newly collide elsewhere.)
    const timeChanged =
      (activeWalkthrough?.scheduled_at?.getTime() ?? null) !== scheduledStart.getTime();

    // Conflict detection: PER added member; plus KEPT members only when the time also changed.
    if (!force) {
      const conflictUserIds = timeChanged ? [...addedIds, ...keptIds] : addedIds;
      const conflicts = await detectPerformerConflicts(req, {
        leadId: id,
        userIds: conflictUserIds,
        schedStart: scheduledStart,
        schedEnd: scheduledEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    // Customer "scheduled/rescheduled" automation only when performers≥1.
    const hasPerformers = performer_ids.length > 0;

    const orgId = req.user!.organization_id;
    const { lead, isReschedule, walkthroughId } = await prisma.$transaction(async (tx) => {
      const { walkthrough, isReschedule: reschedule } = await scheduleActiveWalkthrough(tx, {
        leadId: id,
        orgId,
        activeWalkthroughId: activeWalkthrough?.id ?? null,
        wasAlreadyScheduled,
        visitSeq: await nextVisitSeqForLead(tx, orgId, id),
        scheduledAt: scheduledStart,
        scheduledEnd,
        durationMinutes,
        // Q1: NOT stamped here, matching POST /api/leads/:id/visits (createVisit) below and the
        // job visit doors. The old `hasPerformers && not-yet-stamped` test decided this on CREW
        // EXISTENCE, not on any confirmed send - so it OVER-stamped a walkthrough scheduled with
        // send_email:false (nobody told, row says "announced"), and it UNDER-stamped a tick sent
        // through this door with zero performers (notify_customer's direct send doesn't check
        // hasPerformers, so it CAN send with none - see below). The send has not happened yet at
        // this point and may come back skipped (no address on file) or failed; the stamp has to
        // follow the OUTCOME, not the intent.
        stampCustomerEmailSentAt: false,
        // Already tenant-checked and reduced to columns above. An EMPTY object here is the "the
        // caller said nothing about where" case, and it has to stay empty all the way into the
        // update payload - writing nulls instead is precisely how a reschedule of the time would
        // send the customer back to their own house.
        locationData: locationWrite.data,
      });
      await replaceVisitCrew(tx, { visitId: walkthrough.id, orgId, userIds: performer_ids });

      // The lead's status follows its visits: one rule, one call, after the visit write (PRD 6.2).
      // It re-reads the lead's status itself under a row lock, so the `existing` read above, which
      // ran before this transaction opened, is not consulted. It deliberately does NOT stamp
      // contacted_at: booking a walkthrough is not reaching out to the customer, and if it wrote
      // the contact clock, the "first contact to walkthrough booked" interval (spec #1751) would
      // be structurally zero for exactly the leads it is meant to measure.
      await syncLeadWalkthroughStatus(tx, {
        leadId: id,
        orgId,
        actorId: req.user!.id,
        via: 'walkthrough_scheduled',
      });

      // Spec #1751 D2: when the FIRST walkthrough on this lead was booked. `new Date()`, not
      // `scheduledStart` — the owner's policy is "booked within a day or two of first contact",
      // so an appointment set three weeks out was still booked on time, and anchoring on the
      // appointment instant would score the salesperson on the customer's availability.
      //
      // Stamped on a reschedule too, and that is correct rather than sloppy: first touch wins, so
      // a reschedule of a walkthrough already booked cannot move the clock, while a lead whose
      // very first booking arrives through this door as `reschedule` (the active-visit path) is
      // still recorded. Nothing here needs to know which case it is in.
      //
      // Through `stampLeadClock`, not through a patch derived from `existing`: the clock is
      // MONOTONIC, and `existing` was read before this transaction opened. Deciding "is it still
      // null?" out here and writing in there is a read-then-write two concurrent bookings can
      // both win. The helper's `WHERE ... IS NULL` settles it in Postgres instead.
      await stampLeadClock(tx, id, orgId, 'walkthrough_first_booked_at', new Date());

      // `data: {}` — the row is re-read for the response shape only; the writers above already
      // made every change. Same idiom completeWalkthrough has always used.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: reschedule ? 'WALKTHROUGH_RESCHEDULED' : 'WALKTHROUGH_SCHEDULED',
          description: reschedule
            // Same rule as the job visit writers: no instant in the prose, because the
            // Activity panel prints these verbatim to every viewer in every zone (MV-TZ-07).
            ? 'Walkthrough rescheduled'
            : 'Walkthrough scheduled',
          metadata: { performer_ids, duration: durationMinutes, send_email },
          created_by: req.user!.id,
        },
      });

      return { lead: updatedLead, isReschedule: reschedule, walkthroughId: walkthrough.id };
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    await emit({
      verb: 'lead.walkthrough_scheduled',
      organizationId: orgId,
      actorId: req.user?.id ?? null,
      object: { type: 'LEAD', id, label: existing.lead_number },
      entity: {
        performer_ids,
        commission_owner_id: existing.commission_owner_id ?? null,
      },
      data: { object_label: existing.lead_number },
    });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    // Narrowed to match the (deleted) hard-coded email gates exactly: send_email:false
    // suppresses this WHOLE block, parity with the email gate below (which wrapped both
    // the customer email and the performer diff emails); WALKTHROUGH_SCHEDULED/
    // _RESCHEDULED additionally requires hasPerformers — the state-4 0-performer
    // schedule sent nothing before and must not start sending now.
    //
    // SRVW-243 - notify_customer suppresses ONLY the customer-facing event, and
    // only for this occurrence. An explicit tick has already sent that message
    // directly (below); letting the workflow send it too would mail the customer
    // twice for one action, and a workflow's send_window could deliver the
    // duplicate hours later. The performer notices are a different audience and
    // are untouched.
    if (send_email !== false) {
      // Q1: `&& !notifyDeclined` is the fix. Keep the `hasPerformers` half exactly as it is - a
      // separate, deliberate guard (the state-4 zero-performer schedule sends nothing, and must
      // not start now); only the negation on `notify_customer` was wrong.
      if (hasPerformers && !notify_customer && !notifyDeclined) {
        dispatchAutomationEvent({
          type: isReschedule ? 'WALKTHROUGH_RESCHEDULED' : 'WALKTHROUGH_SCHEDULED',
          organizationId: orgId,
          entity: { type: 'lead', id, label: existing.lead_number },
          occurrenceKey: scheduledStart.toISOString(),
          // Per-visit door: keyed to the trip that moved, and rendered from it (its own date).
          ...(target.visitId ? { visitId: target.visitId } : {}),
          actorId: req.user?.id ?? null,
        });
      }
      for (const uid of addedIds) {
        const addedUser = performers.users.find((x) => x.id === uid);
        dispatchAutomationEvent({
          type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
          organizationId: orgId,
          entity: { type: 'lead', id, label: existing.lead_number },
          occurrenceKey: uid,
          ...(target.visitId ? { visitId: target.visitId } : {}),
          actorId: req.user?.id ?? null,
          ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
        });
      }
      await dispatchWalkthroughPerformerRemoved(req, removedIds, { id, label: existing.lead_number }, orgId, target.visitId);
    }
    if (isReschedule) {
      void rearmAnchoredWaits('lead', id);
    }

    // Awaited, post-commit, and never fatal - see notifyCustomerOfSchedule on the
    // job side for why the send cannot roll the booking back and cannot be
    // swallowed either. Deliberately outside the send_email block: send_email
    // governs the automation engine, and an explicit tick is not the engine.
    const notify = notify_customer
      ? await notifyCustomerOfWalkthrough(req, {
          leadId: id,
          customer: lead.customer,
          serviceAddress: [existing.service_address_line1, existing.service_city, existing.service_state]
            .filter(Boolean).join(', '),
          // #2175: the trip this call booked or moved - the row the transaction returned, so the
          // emailed place and the persisted place cannot be two different rows.
          visitId: walkthroughId,
          performers: performers.users,
          scheduledAt: scheduledStart,
          isReschedule,
          recipientEmail: notify_recipient_email,
          cc: notify_cc_emails,
          message: notify_message,
        })
      : undefined;

    // Q1: the stamp is the OUTCOME of the send, never the intent behind it - same contract as
    // POST /api/leads/:id/visits above and the job visit doors. Guarded on "not already announced"
    // (rather than unconditionally re-stamping) so a later tick on an already-told trip does not
    // overwrite the ORIGINAL timestamp - the same "only on the first announce" rule
    // rescheduleVisit applies on the job side. `activeWalkthrough` is the PRE-transaction read, so
    // this is the state the row was in before this request touched it.
    const alreadyAnnounced = activeWalkthrough?.customer_email_sent_at != null;
    const announcedAt = !alreadyAnnounced && notify?.status === 'sent' ? new Date() : null;
    if (announcedAt) {
      await prisma.visit.updateMany({
        where: { id: walkthroughId, ...tenantWhere(req) },
        data: { customer_email_sent_at: announcedAt },
      });
    }

    res.json({ lead: await withTags(req, lead), ...(notify ? { notify } : {}) });
  } catch (err) {
    logger.error('Schedule walkthrough error:', err);
    res.status(500).json({ error: 'Failed to schedule walkthrough' });
  }
}

// ─── Set Walkthrough Performers (performer-only REPLACE) ──
//
// REPLACE the performer set without touching status/time. Diff-emails per added/removed
// performer; NO customer email, NO flag change. Mirrors the job /assignees handler.
//
// Walkthrough-as-entity redesign, PR-B2: today this had NO status guard at all — performers
// could be swapped on a lead in ANY status, including a WON/LOST one whose visit is long over.
// New guard: performers can only be set on the lead's ACTIVE (REQUESTED/SCHEDULED) visit — this
// rejects the terminal (COMPLETED/CANCELLED) case and the "no visit at all" case (nothing to
// attach a crew to), by the same check.
export async function setPerformers(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const { performer_ids } = req.body as { performer_ids: string[] };

    // Read the current roster BEFORE validating: an unchanged restatement is not "naming other
    // people", and this form resends whatever it was shown. The `!activeWalkthrough` 400 stays
    // BELOW the validator so a self-only rep naming a colleague still gets 403, not 400 - the
    // permission answer must not depend on whether a visit happens to exist.
    // Slice 03: on the per-visit door (POST /:id/visits/:visitId/performers) it is the NAMED trip.
    const target = await walkthroughTarget(req, id);
    if (!target.ok) { res.status(target.status).json({ error: target.error }); return; }
    const activeWalkthrough = target.visit;

    const performers = await validatePerformers(
      req,
      performer_ids,
      activeWalkthrough ? activeWalkthrough.assignees.map((p) => p.user_id) : undefined,
    );
    if (!performers.ok) {
      res.status(performers.status).json({ error: performers.error });
      return;
    }

    if (!activeWalkthrough) {
      res.status(400).json({ error: 'No active walkthrough to set performers on' });
      return;
    }

    const currentIds = new Set(activeWalkthrough.assignees.map((p) => p.user_id));
    const nextIds = new Set(performer_ids);
    const addedIds = performer_ids.filter((uid) => !currentIds.has(uid));
    const removedIds = [...currentIds].filter((uid) => !nextIds.has(uid));

    const orgId = req.user!.organization_id;
    const lead = await prisma.$transaction(async (tx) => {
      await replaceVisitCrew(tx, { visitId: activeWalkthrough.id, orgId, userIds: performer_ids });
      // Re-read via the detail select (performer-only mutation; status/schedule untouched).
      return tx.lead.findUnique({ where: { id }, select: leadDetailSelect });
    });

    // The row was loaded above and is only mutated (never deleted) inside the tx.
    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead!);
    res.json({ lead: await withTags(req, lead!) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    // Per-visit door (slice 03): each notice is about THIS trip, so it is keyed to it and renders
    // its own date. A walkthrough notice is already trip-level ("the walkthrough on <date>"), so
    // unlike the job door there is no "still crewed on a sibling trip" case to special-case.
    for (const uid of addedIds) {
      const addedUser = performers.users.find((x) => x.id === uid);
      dispatchAutomationEvent({
        type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
        organizationId: orgId,
        entity: { type: 'lead', id, label: existing.lead_number },
        occurrenceKey: uid,
        ...(target.visitId ? { visitId: target.visitId } : {}),
        actorId: req.user?.id ?? null,
        ...(addedUser ? { eventPayload: { recipient: addedUser } } : {}),
      });
    }
    await dispatchWalkthroughPerformerRemoved(req, removedIds, { id, label: existing.lead_number }, orgId, target.visitId);
  } catch (err) {
    logger.error('Set walkthrough performers error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to set walkthrough performers' });
    }
  }
}

/**
 * Internal sentinel: the visit was live in the pre-transaction read, but by the time the guarded
 * write ran another request had already taken it out of the live set - completed it, cancelled
 * it, or unscheduled it. Thrown INSIDE the transaction so the whole of the losing request rolls
 * back with the no-op write - its timeline event and any clock it was about to move included -
 * and so the winner's terminal stamp stands. Never escapes this module: each of the three doors
 * below maps it to the SAME 4xx a sequential second call already gets, so a caller that lost a
 * race and a caller that was simply too late are indistinguishable.
 */
class VisitNoLongerLiveError extends Error {}

// ─── Unschedule Walkthrough ──────────────────────────
//
// Takes one visit out of the open set: the row goes to CANCELLED with the reason "Unscheduled".
// KEEPS the performers (crew ⟂ schedule). Built FRESH: NO email, and no typed reason (distinct
// from cancelWalkthrough, which records one). Mirrors the job /unassign handler.
//
// The lead's status follows the visits (walkthrough lead-statuses PRD 6): when no other visit is
// still open it goes back to Walkthrough Completed if a visit already finished, otherwise back to
// Contacted. An Estimate Sent, Won, Lost or Cancelled lead is never moved by it.
//
// Visit update + lead status move + timeline write share ONE transaction, so a failed insert
// cannot leave a committed status change with no audit trail.
export async function unscheduleWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    // Slice 03: on the per-visit door (POST /:id/visits/:visitId/unschedule) the NAMED trip.
    const target = await walkthroughTarget(req, id);
    if (!target.ok) { res.status(target.status).json({ error: target.error }); return; }
    const scheduled = target.visit;
    if (!scheduled) {
      res.status(400).json({ error: 'Can only unschedule a scheduled walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const lead = await prisma.$transaction(async (tx) => {
      // `scheduled` was read BEFORE this transaction opened, so it is a snapshot, not a lock -
      // completeWalkthrough below carries the full argument. The writer re-tests the status in
      // its own WHERE and reports whether it was the one that landed the transition.
      if (!(await unscheduleWalkthroughRow(tx, scheduled.id))) {
        throw new VisitNoLongerLiveError();
      }
      // Only when no other visit is still open does the lead move: back to Walkthrough Completed
      // if a visit already finished, otherwise back to Contacted. An Estimate Sent lead stays put.
      await syncLeadWalkthroughStatus(tx, {
        leadId: id,
        orgId,
        actorId: req.user!.id,
        via: 'walkthrough_unscheduled',
      });
      // `data: {}` — the row is re-read for the response shape only; the writer above already
      // made every change. Same idiom completeWalkthrough has always used.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_UNSCHEDULED',
          description: 'Walkthrough unscheduled',
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    // Raced: the transaction rolled back with the no-op write, so this request wrote nothing.
    if (err instanceof VisitNoLongerLiveError) {
      res.status(400).json({ error: 'Can only unschedule a scheduled walkthrough' });
      return;
    }
    logger.error('Unschedule walkthrough error:', err);
    res.status(500).json({ error: 'Failed to unschedule walkthrough' });
  }
}

// ─── Complete Walkthrough ────────────────────────────
//
// Walkthrough-as-entity redesign, PR-B2: the guard moves onto the visit's own status (only a
// SCHEDULED visit can be completed).
//
// PERMISSION CHANGE (flagged explicitly per the task): this was the one handler that never
// called canAccessRow — it hand-rolled `manage('all') || is-performer` instead, so a DISPATCHER
// who was not personally a performer on this specific visit got 403'd, unlike every sibling
// handler (schedule/unschedule/cancel), which all resolve through canAccessRow('Lead') and so
// pass DISPATCHER's unconditional `read Lead` grant. Repointed onto canAccessRow('Lead') for
// consistency with those siblings — it resolves through the SAME read-Lead grant condition
// every other handler already uses (OWN_WALKTHROUGH for TECHNICIAN, now enforced against the
// Walkthrough's performers relation via the nested walkthroughs -> performers join in
// defaultGrants.ts; OWN_LEAD for SALES; unconditional for DISPATCHER/ADMIN). Net effect:
// DISPATCHER can now complete any walkthrough in the org (matches its unconditional authority
// everywhere else — job complete/cancel, etc.), and a TECHNICIAN who performed on ANY of this
// lead's visits (not only the one being completed) can complete whichever visit is currently
// SCHEDULED — a narrow widening now that a lead can have multiple visits, functionally
// identical to before under the old one-visit-per-lead model.
export async function completeWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }

    // MV-RBAC-19: authorization BEFORE the business-state check, not after. findScheduledWalkthrough
    // used to run first, so an unowned lead answered "Can only complete a scheduled walkthrough"
    // (400) instead of 403 - leaking whether an invisible lead even has one to a caller who should
    // not be able to tell this lead exists at all. findScheduledWalkthrough has no dependency on
    // this check (it is a tenant-scoped read, nothing more), so this is a pure reorder.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Only the assigned performer, Admin, or Dispatcher can complete this walkthrough' });
      return;
    }

    const scheduled = await findScheduledWalkthrough(req, id);
    if (!scheduled) {
      res.status(400).json({ error: 'Can only complete a scheduled walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const completedAt = new Date();
    const lead = await prisma.$transaction(async (tx) => {
      // `scheduled` was read BEFORE this transaction opened, so it is a snapshot, not a lock.
      // The writer re-tests the status in its own WHERE and reports whether it was the one that
      // landed the transition; losing means another request completed this visit in between.
      if (!(await completeWalkthroughRow(tx, scheduled.id, completedAt))) {
        throw new VisitNoLongerLiveError();
      }
      // Completing a visit is recorded on the visit row, and the lead's status follows: it goes to
      // Walkthrough Completed only when NO other visit is still open, and stays Walkthrough
      // Scheduled while one trip of several is done (PRD D4). The call sits straight after the
      // visit write so the lock order stays visit, then lead; the lead lock it takes is also what
      // makes two parallel completions of the last two open visits produce exactly one move.
      await syncLeadWalkthroughStatus(tx, {
        leadId: id,
        orgId,
        actorId: req.user!.id,
        via: 'walkthrough_completed',
      });
      //
      // Spec #1751 D3 advances the two completion clocks, which say different things and are
      // BOTH needed. The monotonic one records that this lead has, at some point, finished a
      // walkthrough - permanently, so booking a follow-up visit months later cannot erase it.
      // The re-anchoring one records that there is currently nothing outstanding. Neither is the
      // legacy `walkthrough_completed_at` WIRE key, which is projected from the lead's CURRENT
      // visit and falls back to null the moment a later visit is booked (right for the page hero,
      // unusable as an SLA anchor).
      //
      // They are written by two different mechanisms because they have two different invariants.
      // The monotonic one goes through `stampLeadClock`, whose `WHERE ... IS NULL` decides
      // first-touch-wins inside Postgres - `existing` was read before this transaction opened, so
      // testing it out here and writing in here would let two concurrent completions of the same
      // lead both observe null and both write. The re-anchoring one has no invariant to protect
      // and rides along in the update the door already makes.
      //
      // Order relative to completeWalkthroughRow does not matter: neither clock reads the visit
      // rows, both values are the `completedAt` this handler minted, and both writes are in the
      // same transaction.
      await stampLeadClock(tx, id, orgId, 'walkthrough_first_completed_at', completedAt);
      const completionPatch = leadClockPatch({ visitCompletedAt: completedAt });
      const updatedLead = await tx.lead.update({
        where: { id },
        data: completionPatch,
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_COMPLETED',
          description: 'Walkthrough completed',
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_COMPLETED',
      organizationId: orgId,
      entity: { type: 'lead', id, label: existing.lead_number },
      actorId: req.user?.id ?? null,
    });
  } catch (err) {
    // Raced with another completion: the transaction rolled back with the no-op write, so this
    // request wrote nothing at all, and never reached the response or the automation dispatch.
    if (err instanceof VisitNoLongerLiveError) {
      res.status(400).json({ error: 'Can only complete a scheduled walkthrough' });
      return;
    }
    logger.error('Complete walkthrough error:', err);
    res.status(500).json({ error: 'Failed to complete walkthrough' });
  }
}

// ─── Cancel Walkthrough ──────────────────────────────
//
// The guard is the visit's own status (only an open visit can be cancelled). The visit goes to
// CANCELLED with the typed reason and no replacement row is minted: "needs scheduling" is the
// ABSENCE of an open visit. The lead's status follows the visits, as in unscheduleWalkthrough
// above: it moves only when this was the last open visit.
export async function cancelWalkthrough(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    const scheduled = await findScheduledWalkthrough(req, id);
    if (!scheduled) {
      res.status(400).json({ error: 'Can only cancel a scheduled walkthrough' });
      return;
    }

    const orgId = req.user!.organization_id;
    const cancelledAt = new Date();
    const reason = req.body.cancelled_reason;
    const lead = await prisma.$transaction(async (tx) => {
      // Snapshot, not a lock - see completeWalkthrough. The accept-set is the live set because
      // that is exactly what findScheduledWalkthrough above would hand over.
      const { cancelled } = await cancelWalkthroughRow(tx, {
        walkthroughId: scheduled.id, leadId: id, orgId,
        cancelledAt, reason, cancelledBy: req.user!.id,
        acceptStatuses: LIVE_VISIT_STATUSES,
      });
      if (!cancelled) throw new VisitNoLongerLiveError();
      // Same follow-up as unschedule: the lead moves only when no other visit is still open.
      await syncLeadWalkthroughStatus(tx, {
        leadId: id,
        orgId,
        actorId: req.user!.id,
        via: 'walkthrough_cancelled',
      });
      // `data: {}` — the row is re-read for the response shape only; the writer above already
      // made every change. Same idiom completeWalkthrough has always used.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_CANCELLED',
          description: `Walkthrough cancelled: ${reason}`,
          created_by: req.user!.id,
        },
      });
      return updatedLead;
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });

    // ─── Automation Center — post-commit, fire-and-forget (#271) ─────────────
    dispatchAutomationEvent({
      type: 'WALKTHROUGH_CANCELLED',
      organizationId: orgId,
      entity: { type: 'lead', id, label: existing.lead_number },
      // The trip that was called off (slice 03). Without it the run renders the lead's CURRENT
      // trip, which - when another walkthrough is still booked - is that OTHER one: "your visit on
      // <its date> was cancelled". The lead arm of the context has no liveness gate, so a
      // cancelled trip renders as itself.
      visitId: scheduled.id,
      actorId: req.user?.id ?? null,
      eventPayload: { mergeFields: { 'event.reason': reason } },
    });
  } catch (err) {
    // Raced: the transaction rolled back with the no-op write, so this request wrote nothing -
    // in particular it did not overwrite the winner's cancellation reason or a completion.
    if (err instanceof VisitNoLongerLiveError) {
      res.status(400).json({ error: 'Can only cancel a scheduled walkthrough' });
      return;
    }
    logger.error('Cancel walkthrough error:', err);
    res.status(500).json({ error: 'Failed to cancel walkthrough' });
  }
}

// ─── Cancel Lead ─────────────────────────────────────

// Walkthrough-as-entity redesign, PR-B2: auto-cancel writes the visit rows (via
// cancelLiveWalkthroughsOnLeadExit - every live trip, the same step markLost runs),
// keyed on the visits' own live status rather than lead.status. Deliberately does NOT rebook a
// fresh row the way a standalone cancelWalkthrough once did (D12) — the lead itself is now
// CANCELLED, so it must not reappear in the "needs scheduling" bucket.
export async function cancelLead(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) { res.status(404).json({ error: 'Lead not found' }); return; }
    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) { res.status(403).json({ error: 'Insufficient permissions' }); return; }

    // Walkthrough lead-statuses PRD D10 / 7.1: Cancelled is pickable "always", from a Won, Lost or
    // Cancelled lead too (the status menu closes a lead through this door). Only a no-op is refused.
    if (existing.status === 'CANCELLED') {
      res.status(400).json({ error: `Cannot cancel a ${existing.status.toLowerCase()} lead` });
      return;
    }

    const orgId = req.user!.organization_id;
    const cancelledAt = new Date();

    const lead = await prisma.$transaction(async (tx) => {
      const cancelledTrips = await cancelLiveWalkthroughsOnLeadExit(tx, {
        leadId: id, orgId, cancelledAt, reason: LEAD_EXIT_WALKTHROUGH_REASON.CANCELLED, cancelledBy: req.user!.id,
      });

      // Spec #1751 D6 - see markLost above for why `notFrom` is empty and why the row is
      // re-read rather than returned by the writer.
      await transitionLeadStatus(tx, {
        leadId: id,
        orgId,
        to: 'CANCELLED',
        from: existing.status,
        actorId: req.user!.id,
        notFrom: [],
        description: cancelledTrips > 0
          ? 'Lead cancelled — walkthrough auto-cancelled'
          : 'Lead cancelled',
        metadata: { walkthrough_auto_cancelled: cancelledTrips > 0 },
        data: { cancelled_at: cancelledAt, cancelled_reason: req.body.cancelled_reason },
      });

      // `data: {}` — the row is re-read for the response shape only; the writer above already
      // made every change. Same idiom completeWalkthrough has always used.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });

      return updatedLead;
    });

    // Cancel all active estimates for this lead
    await prisma.estimate.updateMany({
      where: {
        ...tenantWhere(req),
        lead_id: id,
        status: { in: ['DRAFT', 'SENT', 'PENDING'] },
      },
      data: {
        status: ESTIMATE_STATUS.ARCHIVED,
        cancelled_at: new Date(),
        cancelled_reason: 'Lead cancelled',
      },
    });

    // Void any UNPAID kind=DEPOSIT Invoice on the lead's estimates (the SOLE deposit document).
    const leadEstimates = await prisma.estimate.findMany({
      where: { ...tenantWhere(req), lead_id: id },
      select: { id: true },
    });
    await voidUnpaidDepositInvoices(req, leadEstimates.map(e => e.id));

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    // The deposit-void logic above queries estimates fresh by lead_id (id only) and never
    // reads `lead.estimates`' monetary fields, so this in-place strip is response-bound only.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Cancel lead error:', err);
    res.status(500).json({ error: 'Failed to cancel lead' });
  }
}

// ─── Stats ────────────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const orgWhere = tenantWhere(req);
    // GAP-3: scope the aggregates to the requester the SAME way the list endpoint does
    // (buildLeadListWhere → scopeWhereForReq). ADMIN/DISPATCHER resolve to {} (org-wide);
    // a row-scoped role (SALES → OWN_LEAD) gets the owner condition on EVERY count, so the
    // stats cards never expose org-wide totals/won/lost to an own-lead-scoped user.
    const scopeWhere = await scopeWhereForReq(req, 'Lead');
    const [total, newThisWeek, unassigned, wonThisMonth, lostThisMonth] = await Promise.all([
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, created_at: { gte: startOfWeek } } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: { in: UNASSIGNED_COUNT_STATUSES }, AND: [{ lead_assignees: { none: {} } }] } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: 'WON', updated_at: { gte: startOfMonth } } }),
      prisma.lead.count({ where: { ...orgWhere, ...scopeWhere, status: 'LOST', lost_at: { gte: startOfMonth } } }),
    ]);

    res.json({ total, new_this_week: newThisWeek, unassigned, won_this_month: wonThisMonth, lost_this_month: lostThisMonth });
  } catch (err) {
    logger.error('Get lead stats error:', err);
    res.status(500).json({ error: 'Failed to get lead stats' });
  }
}

// ─── Lead Notes ───────────────────────────────────────

export const createLeadNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function getNotes(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: per-instance scope — mirror getById/update. The route guard (`read Lead`) is
    // CONDITIONAL for SALES (OWN_LEAD) and TECHNICIAN (OWN_WALKTHROUGH); without this an
    // own-scoped role could read notes on a lead it doesn't own (in-tenant cross-user leak).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'LEAD', entity_id: id, ...tenantWhere(req) },
      select: {
        id: true,
        content: true,
        created_at: true,
        creator: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes });
  } catch (err) {
    logger.error('Get lead notes error:', err);
    res.status(500).json({ error: 'Failed to get lead notes' });
  }
}

// #585 — expose the LEAD timeline (status/owner/dispatcher changes) to the activity panel.
export async function getTimeline(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // Per-instance scope — mirror getNotes (own-scoped SALES/TECHNICIAN must not read
    // a lead timeline they don't own).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // LEAD-only, and tenant-scoped. #2088 (B6) had widened this into an `OR` whose second branch
    // read this lead's estimates' selection rows; the 2026-09-18 revision stops those rows ever
    // being written, so the branch (and the scoped estimate-id lookup that existed only to gate
    // it) is gone. `tenantWhere(req)` stays exactly where it was.
    const events = await prisma.timelineEvent.findMany({
      where: {
        entity_type: 'LEAD',
        entity_id: id,
        ...tenantWhere(req),
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

    res.json({ events });
  } catch (err) {
    logger.error('Get lead timeline error:', err);
    res.status(500).json({ error: 'Failed to get timeline' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: per-instance scope — mirror update(). The route guard (`update Lead`) is
    // CONDITIONAL for SALES (OWN_LEAD); without this an own-scoped role could write a note
    // onto a lead it doesn't own (in-tenant cross-user write leak).
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'LEAD',
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
    logger.error('Add lead note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}

// ─── Contact (hand correction) ─────────────────────────

/**
 * POST /api/leads/:id/contact — set or correct `contacted_at` BY HAND.
 *
 * Spec #1751 D5, ratified by the product owner. Reinstates the door the walkthrough redesign
 * removed, deliberately re-scoped: it is no longer how a lead normally becomes contacted. The
 * normal path is automatic now — an outbound call, an outbound text or a human-written email
 * stamps the clock at the moment it happened (services/lead-contact.service.ts). This door exists
 * for the two cases automation cannot reach:
 *
 *   - the outreach happened OUTSIDE the platform (a rep used their personal phone), so a
 *     salesperson who did the work is otherwise recorded as negligent (user story 17); and
 *   - the automatic stamp is WRONG (a misattributed call), and a bad instant would permanently
 *     distort the report (user story 16).
 *
 * THIS IS THE ONE DELIBERATE EXCEPTION TO FIRST-TOUCH-WINS IN THE WHOLE SPEC, which is why it does
 * NOT go through `stampLeadClock`. That helper's entire contract is `WHERE contacted_at IS NULL` —
 * it CANNOT overwrite, by design, and using it here would make the correction silently do nothing
 * on exactly the leads a person is trying to correct. The write below is unconditional on purpose.
 *
 * It is still not destructive: the schema refuses null, so a set clock can be moved but never
 * un-set. Nothing in this spec erases a clock, because erasing one erases the evidence of a
 * breach that already happened.
 *
 * The status is NOT touched. The pre-redesign version of this handler moved the lead to CONTACTED
 * and that is precisely what D6 forbids now: status moves through `transitionLeadStatus` and
 * nowhere else, and a status change must never write this clock in either direction (booking a
 * walkthrough moves a New or Contacted lead to Walkthrough Scheduled in the same transaction, so a
 * status-driven stamp would make "first contact to walkthrough booked" structurally zero for the
 * very leads it exists to measure).
 */
export async function contactLead(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, contacted_at: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — the same pair every sibling action on
    // this router applies (see markLost / cancelLead). The route's own `canDo('contact', 'Lead')`
    // answers "may this role correct contact times at all"; this answers "on THIS row".
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const orgId = req.user!.organization_id;
    const previous = existing.contacted_at;
    const contactedAt = new Date(req.body.contacted_at);

    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          contacted_at: contactedAt,
          // WHO corrected it. The automatic writers deliberately leave this null, so the two are
          // distinguishable forever after — which is the whole point: an anonymous correction is
          // not auditable, and a report cannot tell a measured response time from an asserted one
          // unless the row says which it is.
          contacted_set_by: req.user!.id,
          // Reuses the column the removed door already wrote. Absent stays absent rather than
          // being blanked, so correcting the instant twice does not silently drop the note that
          // explained the first correction.
          ...(req.body.contacted_note !== undefined
            ? { contacted_note: req.body.contacted_note || null }
            : {}),
        },
        select: leadDetailSelect,
      });

      if (!previous && (tx as any).notificationRecipient?.updateMany) {
        await (tx as any).notificationRecipient.updateMany({
          where: {
            organization_id: orgId,
            notification: {
              verb: 'spider.alert',
              object_id: id,
            },
            read_at: null,
          },
          data: { read_at: new Date() },
        });
      }

      // D7: the ledger is the existing timeline, not a new table. Prose only — the instant lives
      // in metadata, because this description is printed verbatim in the Activity panel and a
      // server-rendered instant there would be in the wrong zone (MV-TZ-07).
      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD',
          entity_id: id,
          event_type: 'CONTACT_SET',
          description: previous
            ? 'Contact time corrected by hand'
            : 'Contact time set by hand',
          metadata: {
            contacted_at: contactedAt.toISOString(),
            previous_contacted_at: previous ? previous.toISOString() : null,
            source: 'manual_correction',
          },
          created_by: req.user!.id,
        },
      });

      return updated;
    });

    void logAudit({
      req,
      action: 'lead.contact_set',
      resourceType: 'Lead',
      resourceId: id,
      metadata: {
        contacted_at: contactedAt.toISOString(),
        previous_contacted_at: previous ? previous.toISOString() : null,
      },
    });

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Contact lead error:', err);
    res.status(500).json({ error: 'Failed to set the contact time' });
  }
}

// ─── Mark Lost ────────────────────────────────────────

// Walkthrough-as-entity redesign, PR-B2: same auto-cancel repoint as cancelLead — the trigger is
// the Walkthrough row's own SCHEDULED status, and no fresh REQUESTED row is rebooked (the lead
// is now LOST, so it must not reappear in the "needs scheduling" bucket).
export async function markLost(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // #106 P1: SQL-based per-instance scope (nested-safe) — see update().
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Walkthrough lead-statuses PRD D10 / 7.1: Lost is pickable "always", from a Won, Lost or
    // Cancelled lead too (the status menu closes a lead through this door). Only a no-op is refused.
    if (existing.status === 'LOST') {
      res.status(400).json({ error: `Cannot mark a ${existing.status.toLowerCase()} lead as lost` });
      return;
    }

    const orgId = req.user!.organization_id;
    const cancelledAt = new Date();

    const lead = await prisma.$transaction(async (tx) => {
      const cancelledTrips = await cancelLiveWalkthroughsOnLeadExit(tx, {
        leadId: id, orgId, cancelledAt, reason: LEAD_EXIT_WALKTHROUGH_REASON.LOST, cancelledBy: req.user!.id,
      });

      // Spec #1751 D6: the ONE writer that moves a lead's status. It writes the status, the
      // reason and the ledger entry in this transaction, and the ledger entry now carries
      // `from` and `to` - which the hand-rolled timelineEvent.create it replaces did not, so no
      // time-in-stage was computable from it even retroactively.
      //
      // `notFrom: []` because a Won or Cancelled lead may be marked lost (PRD D10) and the 400
      // above already rejects the one no-op case with a specific message; re-applying the helper's
      // default terminal guard here would silently turn a permitted move into a 200 that did nothing.
      await transitionLeadStatus(tx, {
        leadId: id,
        orgId,
        to: 'LOST',
        from: existing.status,
        actorId: req.user!.id,
        notFrom: [],
        description: cancelledTrips > 0
          ? 'Lead marked as lost — walkthrough auto-cancelled'
          : 'Lead marked as lost',
        metadata: { walkthrough_auto_cancelled: cancelledTrips > 0 },
        data: { lost_at: new Date(), lost_reason: req.body.lost_reason },
      });

      // Re-read for the response shape. The writer above deliberately returns no row: it updates
      // through updateMany so that its tenant scope and its "never overwrite" guards live in the
      // WHERE clause, and a helper that also had to satisfy each caller's own `select` would be
      // back to being nine different writers.
      // `data: {}` — the row is re-read for the response shape only; the writer above already
      // made every change. Same idiom completeWalkthrough has always used.
      const updatedLead = await tx.lead.update({
        where: { id },
        data: {},
        select: leadDetailSelect,
      });

      return updatedLead;
    });

    // Cancel all active estimates for this lead
    await prisma.estimate.updateMany({
      where: {
        ...tenantWhere(req),
        lead_id: id,
        status: { in: ['DRAFT', 'SENT', 'PENDING'] },
      },
      data: {
        status: ESTIMATE_STATUS.ARCHIVED,
        cancelled_at: new Date(),
        cancelled_reason: 'Lead marked as lost',
      },
    });

    // Void any UNPAID kind=DEPOSIT Invoice on the lead's estimates (the SOLE deposit document).
    const leadEstimates = await prisma.estimate.findMany({
      where: { ...tenantWhere(req), lead_id: id },
      select: { id: true },
    });
    await voidUnpaidDepositInvoices(req, leadEstimates.map(e => e.id));

    // #233 / audit F-012: ability-gated strip before responding (no-op for estimate-readers).
    // The deposit-void logic above queries estimates fresh by lead_id (id only) and never
    // reads `lead.estimates`' monetary fields, so this in-place strip is response-bound only.
    await stripEstimateMoneyUnlessVisible(req, lead);

    res.json({ lead: await withTags(req, lead) });
  } catch (err) {
    logger.error('Mark lost error:', err);
    res.status(500).json({ error: 'Failed to mark lead as lost' });
  }
}

// ─── Visits collection (multi-visit S1) ────────────────────────────────────
//
// The multi-visit interface, alongside the legacy single-visit endpoints above. Per the spec's API
// contract, visits are a NESTED COLLECTION on their parent, following the platform's existing
// `/api/{resource}` + `POST :id/{action}` shape. The lead side lands here; slice S2 hangs the same
// collection off jobs.
//
// The distinction that matters: POST /walkthrough/schedule (re)schedules the lead's active visit
// by collapsing onto one row, whereas POST /visits books an ADDITIONAL one. That is the whole
// invariant this slice lifts - a lead can now hold several live visits at once.

export const createVisitSchema = z.object({
  scheduled_at: z.string().datetime(),
  duration_minutes: z.number().int().min(15).max(480).default(60),
  assignee_ids: z.array(z.string().uuid()).default([]),
  notes: z.string().max(5000).optional(),
  // S7 (D3 - a visit is a visit): the SAME nested notify object the three job-visit schemas take,
  // with `.email()` and the cc array capped at 5 exactly as assignJobSchema has them.
  //
  // The dead `send_email: z.boolean().optional().default(true)` that used to sit here is gone.
  // It was destructured nowhere, so removing it is a no-op on the wire (Zod already strips
  // unknown keys), and a `.default(true)` flag lying around is a live trap the moment someone
  // wires it up. It is NOT the same flag as the legacy /walkthrough/schedule door's send_email,
  // which is real and gates that endpoint's whole automation block.
  notify: z
    .object({
      notify_customer: z.boolean().optional(),
      notify_recipient_email: z.string().email().optional(),
      notify_cc_emails: z.array(z.string().email()).max(5).optional(),
      notify_message: z.string().max(5000).optional(),
    })
    .optional(),
  force: z.boolean().optional().default(false),
  // Where this trip is happening - THE SAME FIELD its sibling door takes, from the same module,
  // not a second declaration of the same shape (visit-location spec, slice 3). One lead can hold
  // the showroom meeting, the measure at the customer's house and a design review back at the
  // showroom, which is only reachable once the door that books the SECOND trip can say where it
  // is. Sharing `visitLocationField` is what makes "both lead-side doors refuse the same body
  // identically" a property of the code rather than a pair of tests hoping two copies agree.
  //
  // Three-state here too, though only two of the three are reachable at a create: omitted writes
  // no location column at all and `null` writes six explicit nulls, which on a fresh row are the
  // same thing - the service address. The third, a value, is the one this slice exists for. It
  // stays a three-state field rather than being narrowed to "a location or nothing" because the
  // shape is the shared one, and narrowing it per door is how the two doors start to differ.
  location: visitLocationField,
});

/** Every visit on the lead, earliest scheduled first. */
export async function listVisits(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const lead = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) }, select: { id: true } });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    // The route gate `canDo('read','Lead')` is SUBJECT-level, and TECHNICIAN holds read Lead
    // conditioned on OWN_WALKTHROUGH - so without this the nested collection hands every
    // technician the times, notes and crew of every lead's trips in the org, while GET
    // /api/leads/:id on the parent row 403s them. A nested collection is never the weaker door.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    res.json({ visits: await listLeadVisits(req, id) });
  } catch (err) {
    logger.error('List visits error:', err);
    res.status(500).json({ error: 'Failed to list visits' });
  }
}

/** Book a NEW visit on the lead, leaving any existing ones untouched. */
export async function createVisit(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { scheduled_at, duration_minutes, assignee_ids, notes, force, notify, location } = req.body as {
      scheduled_at: string;
      duration_minutes: number;
      assignee_ids: string[];
      notes?: string;
      force: boolean;
      notify?: {
        notify_customer?: boolean;
        notify_recipient_email?: string;
        notify_cc_emails?: string[];
        notify_message?: string;
      };
      // Absent when the caller said nothing about where, which on a create is the service address
      // - the same type the sibling door destructures, from the same module.
      location?: VisitLocationInput | null;
    };
    const notifyCustomer = notify?.notify_customer === true;

    const existing = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true,
        status: true,
        // S7: the customer email's own fields, the same set the legacy walkthrough door reads.
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_address_line1: true,
        service_city: true,
        service_state: true,
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // The same per-instance scope the legacy /walkthrough/schedule door applies (:1513). Its
    // route gate `canDo('schedule_walkthrough','Lead')` is SUBJECT-level and SALES holds that
    // grant conditioned on OWN_LEAD, so without this a salesperson books trips on every lead in
    // the org - and since S7 that write also mails the customer, from the org's verified sending
    // domain, at a recipient and with a body the request itself chose.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Per-member eligibility, same rule the legacy schedule path applies.
    const assignees = await validatePerformers(req, assignee_ids);
    if (!assignees.ok) {
      res.status(assignees.status).json({ error: assignees.error });
      return;
    }

    // D8, through the SAME helper the sibling door calls, which is the whole of "reuse, do not
    // re-implement": a second copy of the tenant check is a second place for it to drift, and the
    // thing it protects is another organisation's address landing in this organisation's customer
    // email. Slice 2's archived-location refusal (D9) rides along for free, which is the point -
    // a booking door added later cannot forget a rule it never restated.
    //
    // `currentLocationId: null` because this door CREATES: the visit stands nowhere yet, so the
    // "a visit may stay at a location archived since it was booked" exception cannot apply and a
    // new booking into a closed branch is refused here exactly as it is on the other door.
    //
    // Ahead of the conflict check below for the same reason it sits ahead of it there: a body
    // naming a location it may not have is wrong whether or not the slot is free, and answering
    // 409 first would tell the caller about somebody else's calendar before refusing them.
    const locationWrite = await resolveVisitLocationWrite(req, location, { currentLocationId: null });
    if (!locationWrite.ok) {
      res.status(locationWrite.status).json({ error: locationWrite.error });
      return;
    }

    const scheduledStart = new Date(scheduled_at);
    const scheduledEnd = new Date(scheduledStart.getTime() + duration_minutes * 60_000);

    // D21: crew double-booking WARNS, never blocks. The 409 is advisory and the client retries
    // with force:true once the dispatcher has seen which job or lead it clashes with - a hard
    // block just moves scheduling out of the software and into a text message.
    if (!force && assignee_ids.length > 0) {
      const conflicts = await detectPerformerConflicts(req, {
        leadId: id,
        userIds: assignee_ids,
        schedStart: scheduledStart,
        schedEnd: scheduledEnd,
      });
      if (conflicts.length > 0) {
        res.status(409).json({ error: 'Schedule conflict detected', conflicts });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    // Same retry as the job door: visit_seq comes from MAX + 1 with no lock, so the unique
    // index can reject a number a concurrent create already took (section 4.4).
    const visit = await withVisitSeqRetry(() => prisma.$transaction(async (tx) => {
      const created = await createLeadVisit(tx, {
        leadId: id,
        orgId,
        visitSeq: await nextVisitSeqForLead(tx, orgId, id),
        scheduledAt: scheduledStart,
        scheduledEnd,
        durationMinutes: duration_minutes,
        notes: notes ?? null,
        // NOT here: the send is post-commit and can come back skipped (no address on file, which
        // the composer explicitly invites) or failed. The flag says the customer WAS told, so it
        // records the OUTCOME of the send and is written below, once there is one.
        stampCustomerEmailSentAt: false,
        // Already tenant-checked and reduced to columns above. EMPTY when the caller said nothing
        // about where, and it stays empty into the create: no location column is written, the six
        // stay at their NULL default, and the trip is at the service address - today's behaviour
        // for every visit booked through this door before now.
        locationData: locationWrite.data,
      });
      await replaceVisitCrew(tx, { visitId: created.id, orgId, userIds: assignee_ids });

      // The same status follow-up as the legacy door, through the same one call: a New or
      // Contacted lead goes to Walkthrough Scheduled, and a Walkthrough Completed lead that gets
      // another visit goes back to Walkthrough Scheduled (PRD D5). Still no contacted_at.
      await syncLeadWalkthroughStatus(tx, {
        leadId: id,
        orgId,
        actorId: req.user!.id,
        via: 'visit_created',
      });

      // Spec #1751 D2, the same stamp the /walkthrough/schedule door makes. This door books an
      // ADDITIONAL visit, so on a lead that already has one the write is a no-op — which is the
      // point of first-touch-wins — but it is the FIRST booking whenever a lead is booked through
      // this door first, and leaving it out would make the clock depend on which of two
      // equivalent doors the dispatcher happened to use.
      //
      // Through `stampLeadClock` for the same reason that door uses it: the clock is MONOTONIC,
      // and its `WHERE ... IS NULL` is what makes "was it already set?" atomic rather than a
      // read-then-write across the transaction boundary.
      await stampLeadClock(tx, id, orgId, 'walkthrough_first_booked_at', new Date());

      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'LEAD', entity_id: id,
          event_type: 'WALKTHROUGH_SCHEDULED',
          description: `Visit ${created.visit_seq} scheduled`,
          metadata: { visit_id: created.id, visit_seq: created.visit_seq, assignee_ids, duration: duration_minutes },
          created_by: req.user!.id,
        },
      });

      return created;
    }));

    // AWAITED and post-commit, never fatal - the same contract every other notify site has.
    // visitSeq and the date come off the row the transaction RETURNED (#1522).
    const notifyResult = notifyCustomer
      ? await notifyCustomerOfWalkthrough(req, {
          leadId: id,
          customer: existing.customer,
          serviceAddress: [existing.service_address_line1, existing.service_city, existing.service_state]
            .filter(Boolean).join(', '),
          // #2175: the trip the transaction RETURNED - the same row visitSeq and the date below
          // already come off (#1522).
          visitId: visit.id,
          performers: assignees.users,
          scheduledAt: visit.scheduled_at ?? scheduledStart,
          isReschedule: false,
          visitSeq: visit.visit_seq,
          recipientEmail: notify?.notify_recipient_email,
          cc: notify?.notify_cc_emails,
          message: notify?.notify_message,
        })
      : undefined;

    // The stamp is the outcome of the send, never the intent behind it - see the create above.
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
    logger.error('Create visit error:', err);
    res.status(500).json({ error: 'Failed to create visit' });
  }
}

// ─── Editable Record ID - preview + rename (decision #7) ───────────
//
// Lead has no entity-specific rename precondition beyond the route's canDo('renumber',
// 'Lead') gate + per-instance ownership - that lock is Invoice-only (decision #8,
// isInvoiceRenumberLocked), so neither handler below checks one.

/** Carries the structured conflict computation out of the locked transaction so the
 * catch block can build a 409 body from real data instead of a message string -
 * applyRenumber itself only throws a plain Error, so the conflict check is duplicated
 * here (computeRenumber, then applyRenumber, which re-derives it again internally) to
 * get that structure. Mirrors what applyRenumber does internally; see its doc comment. */
class LeadRenumberConflictError extends Error {
  constructor(public computation: RenumberComputation) {
    super(`Cannot rename lead ${computation.parentId}: number already in use`);
  }
}

// Read-only, no lock - safe against a plain (non-transaction) client, matching the
// engine's own contract for computeRenumber.
export async function previewNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const { number } = req.body as { number: string };

    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // Mirrors update()/assign()'s per-instance ownership check - the route's
    // canDo('renumber', 'Lead') is a bare-subject check and does not bind the row.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let computation: RenumberComputation;
    try {
      computation = await computeRenumber(prisma, 'lead', id, orgId, number);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid record number' });
      return;
    }

    res.json(computation);
  } catch (err) {
    logger.error('Preview lead number error:', err);
    res.status(500).json({ error: 'Failed to preview lead number' });
  }
}

export async function renameNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const { number } = req.body as { number: string };

    // Cheap existence + ownership + format checks BEFORE opening a transaction, so a
    // request that's going to 404/403/400 anyway never takes the row lock.
    const existing = await prisma.lead.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const formatCheck = validateNumberFormat(number);
    if (!formatCheck.ok) {
      res.status(400).json({ error: formatCheck.error });
      return;
    }

    let computation: RenumberComputation;
    try {
      computation = await prisma.$transaction(async (tx) => {
        // `leads` is an ANCHOR table (numbering.ts's allocateAnchoredNumber locks it
        // FOR NO KEY UPDATE for anchored logistic-order allocation) - matching that
        // lock strength here avoids a FOR UPDATE / FOR NO KEY UPDATE conflict deadlock
        // against a concurrent allocation on the same row.
        await tx.$executeRaw`SELECT id FROM leads WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid FOR NO KEY UPDATE`;

        // Re-derive fresh inside the lock to get the STRUCTURED conflict list for a 409
        // body - applyRenumber (below) would throw on the same conflict, but only as a
        // plain Error message, not the computation itself.
        const preview = await computeRenumber(tx, 'lead', id, orgId, number);
        if (preview.hasConflicts) {
          throw new LeadRenumberConflictError(preview);
        }
        return applyRenumber(tx, 'lead', id, orgId, number);
      });
    } catch (err) {
      if (err instanceof LeadRenumberConflictError) {
        res.status(409).json({ error: err.message, computation: err.computation });
        return;
      }
      throw err;
    }

    const derivedCount = computation.derived.length + computation.labelRefreshes.length;

    // Timeline event AFTER the transaction commits.
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'LEAD',
        entity_id: id,
        event_type: 'LEAD_RENUMBERED',
        description: `Lead number changed from ${computation.oldNumber} to ${computation.newNumber} (${derivedCount} derived record${derivedCount === 1 ? '' : 's'} updated)`,
        metadata: {
          old_number: computation.oldNumber,
          new_number: computation.newNumber,
          derived_count: derivedCount,
        },
        created_by: req.user!.id,
      },
    });

    void logAudit({
      req,
      action: 'lead.renumbered',
      resourceType: 'Lead',
      resourceId: id,
      metadata: { old_number: computation.oldNumber, new_number: computation.newNumber },
    });

    // Built from the pre-transaction row + the computation, not a re-select - the
    // rename only ever touches lead_number/number_is_custom/original_number, all
    // known here, so a fresh query would be redundant. Includes the full
    // derived-change list so the (later) frontend confirmation dialog needs no
    // second round trip.
    res.status(200).json({
      lead: {
        ...existing,
        lead_number: computation.newNumber,
        number_is_custom: true,
        original_number: existing.original_number ?? computation.oldNumber,
      },
      old_number: computation.oldNumber,
      new_number: computation.newNumber,
      derived: computation.derived,
      label_refreshes: computation.labelRefreshes,
    });
  } catch (err) {
    logger.error('Rename lead number error:', err);
    res.status(500).json({ error: 'Failed to rename lead number' });
  }
}
