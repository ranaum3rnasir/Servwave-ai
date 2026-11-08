import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, PaymentMethod, LeadStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser, CREATED_BY_SYSTEM } from '../lib/created-by';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { ESTIMATE_SORT_FIELDS } from '../lib/sortFields';
import { applyFilters } from '../lib/query/filterEngine';
import { estimateFacets } from '../lib/query/registries/estimate.filters';
import { env } from '../config/env';
import { sendEstimateEmail, sendEstimateWithDepositEmail, sendEstimateApprovedNotification, sendDepositReceivedConfirmation, sendDepositPaidAlert, sendPaymentMethodSelectedAlert } from '../lib/email';
import type { EmailDispatchResult } from '../lib/email';
import { createCheckoutSession, getStripeForOrg, isStripeConfigured, resolveCheckoutFees, computeServiceFee, CARD_SERVICE_FEE_BPS } from '../lib/stripe';
import { tenantWhere } from '../lib/tenant';
import {
  LOST_REASON_CODE_MAX,
  isOfferedLostReason,
  resolveOfferedLostReasons,
} from '../lib/lostReasonOptions';
import { loadTagsByEntity, loadTagsForEntity } from '../lib/tags';
import { allocateNumber, allocateContainerEstimateNumber } from '../lib/numbering';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { scopeWhereForReq, canAccessRow, canSeePricing } from '../lib/permissions/enforce';
import { presentEstimateDetail, presentInvoiceDetail, redactCustomerRowUnless } from '../lib/permissions/customerContact';
import { isCustomerReadableRow, CUSTOMER_PROOF_SELECT } from '../lib/permissions/customerScope';
import { emit } from '../services/notifications/notificationService';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { logAudit } from '../lib/audit';
import { computeRenumber, applyRenumber, type RenumberComputation } from '../lib/record-renumber';
import { generateReply, isBrainNotConfigured } from '../services/copilot/brain';
import { asScopeArray, toScopeForTotals, toEstimateScopeForTotals, stripDocumentCost, stripScopeSendSnapshot, withOptionalDefaults, type ScopeOfWork } from '../lib/scopes';
import { estimateDocumentSelect, toEstimateDocument } from '../lib/estimate-document';
import { copyScopePhotosForward } from '../lib/copy-scope-photos';
import { mintEstimateVersion } from '../lib/mint-estimate-version';

/**
 * #2029 — carry the source estimate's scope photos onto a duplicate/revision and hand back the
 * copy WITH them, so the response is not missing what the operation just created. Only the photos
 * are re-read (never the whole detail row), so neither response shape moves.
 */
async function withCopiedScopePhotos<T extends { id: string }>(
  copy: T,
  sourceEstimateId: string,
  orgId: string,
): Promise<T> {
  await copyScopePhotosForward({ sourceEstimateId, targetEstimateId: copy.id, orgId });
  const scope_photos = await prisma.estimateScopePhoto.findMany({
    where: { estimate_id: copy.id },
    select: estimateDocumentSelect.scope_photos.select,
    orderBy: estimateDocumentSelect.scope_photos.orderBy,
  });
  return { ...copy, scope_photos };
}
import { recomputeInvoiceTotals, countsTowardTotals, type ScopeForTotals, type LineForTotals } from '../lib/invoice-totals';
import { loadOptionSummary, optionSummaryData } from '../lib/estimates/optionSummary';
import { areSelectionsLocked, changesSelectionFlagsInList, optionsLockedBody, OPTIONS_LOCKED, DEPOSIT_PART_PAID_MESSAGE } from '../lib/estimates/selectionLock';
import { ESTIMATE_STATUS, type EstimateStatusValue } from '../constants/estimateStatus';
import { TARGETABLE_ESTIMATE_STATUSES, buildStatusChangeData, blockedByMoneyTrail, clearsSendConfig, suspendsDepositLink } from '../lib/estimates/status-transitions';
import { expireDepositCheckoutsOnMaterialEdit, expireDepositCheckoutsAfterReprice, expireDepositCheckoutsOnRecall } from '../lib/estimates/deposit-checkout-guard';
import { round2, resolveDepositAmount, depositFigureWouldMove, type DepositOrgDefaults } from '../lib/estimates/deposit-amount';
import { REVOKE_PUBLIC_LINK, customerVisibleDocumentChanged, type CustomerVisibleLine } from '../lib/estimates/public-link';
import { resolveTaxRateForState } from '../lib/tax/resolveTaxRate';
import { remainingDepositCredit, applyDepositCredit } from '../lib/deposit-credit';
import { LINE_DESCRIPTION_MAX } from '../lib/line-items';
// Copy-to-invoice (R5e) reuses invoice.controller.ts's exact conventions verbatim rather than
// redefining them: the standalone-invoice permission gate's message, the detail select, the
// deposit-credit reference tag, and the payment-terms due-date resolver.
import { invoiceDetailSelect, DEPOSIT_CREDIT_REFERENCE, calculateDueDate, resolveAvailablePaymentMethods } from './invoice.controller';
import { walkthroughSnapshotSelect, projectLeadWalkthroughFields, projectLeadVisitCrew, walkthroughCompletionSnapshot } from '../services/walkthrough.service';
import type { WalkthroughCompletionSnapshot } from '../services/walkthrough.service';
import { transitionLeadStatus, stampLeadClock, WALKTHROUGH_DRIVEN_FROM_STATUSES, LEAD_STATUS_LABEL } from '../services/lead-stage.service';
import { isOnJobCrew } from '../lib/job-crew';
// The single owner of the 400 validation body shape, so a handler-level refusal is
// indistinguishable from the Zod one the same schema raises (#2010).
import { validationFailure } from '../middleware/validate';

// ─── Select Objects ────────────────────────────────────

const estimateListSelect = {
  id: true,
  estimate_number: true,
  status: true,
  subtotal: true,
  tax_rate: true,
  tax_amount: true,
  total_amount: true,
  discount_type: true,
  discount_value: true,
  discount_name: true,
  discount_amount: true,
  created_at: true,
  updated_at: true,
  // SERV10X-61 - direct anchor (R6, customer_id NOT-NULL) so a lead-less estimate's customer +
  // job provenance are readable in the list without a lead hop. Siblings of `lead`, not a
  // replacement: a lead-anchored row still resolves its customer through the lead below.
  customer_id: true,
  job_id: true,
  customer: {
    select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true },
  },
  lead: {
    select: {
      id: true,
      // The originating request text, shown as the "Service Request" column on the customer
      // detail page's Estimates tab. Already exposed on estimateDetailSelect below, so this
      // widens no audience - the list is gated on the same `read Estimate` as the detail.
      // Null-safe by construction: `lead` itself is null for a lead-less (customer-anchored)
      // estimate, and Lead.service_request is NOT NULL whenever the lead exists.
      service_request: true,
      customer: {
        select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true },
      },
    },
  },
  creator: { select: { id: true, first_name: true, last_name: true } },
};

export const estimateDetailSelect = {
  id: true,
  lead_id: true,
  // SERV10X-61 - scalar anchors alongside lead_id. customer_id (R6, NOT-NULL) lets a lead-less
  // detail resolve its customer directly; job_id tells the workspace the estimate is job-anchored
  // (drives the tax-lock UI) without walking the `job` relation.
  customer_id: true,
  job_id: true,
  estimate_number: true,
  // Editable record IDs (2026-08-19 plan) - RecordNumberEditor's `isDerivedAndLocked` gate
  // needs both: container_kind set + number_is_custom false means this estimate's number was
  // derived from its container parent and never hand-edited, so the workspace renders it
  // read-only behind an explicit "Use a custom number" unlock (see RecordNumberEditor.tsx).
  number_is_custom: true,
  container_kind: true,
  status: true,
  sent_at: true,
  approved_at: true,
  declined_at: true,
  expired_at: true,
  cancelled_at: true,
  cancelled_reason: true,
  // SRVW-285. Why the estimate was lost, and the customer's own words for it. Selected HERE and
  // deliberately NOT on `estimatePublicSelect`: this is staff-facing. Echoing a decline reason
  // back onto the page the customer declined from would read as the business arguing with them,
  // and the note is free text they wrote FOR the business, not for themselves.
  //
  // Without these two the column is write-only, and the whole point of asking was that somebody
  // can read the answer without querying the database - so the select and the rail row that
  // renders it ship together, in one slice, or neither should.
  lost_reason: true,
  lost_reason_note: true,
  name: true,
  version: true,
  modified_after_send: true,
  superseded_by_id: true,
  deposit_type: true,
  deposit_value: true,
  // R3 (2026-07-21) — cost model (D2/D8/D18). Staff-only — stripEstimateCost deletes these three
  // keys for a requester who can't see pricing, mirroring unit_cost/markup_percent below.
  labor_hours: true,
  overhead_mode: true,
  overhead_value: true,
  scope_name: true,
  scope_notes: true,
  scopes: true,
  tax_rate: true,
  subtotal: true,
  tax_amount: true,
  total_amount: true,
  discount_type: true,
  discount_value: true,
  discount_name: true,
  discount_amount: true,
  signature_data: true,
  signature_ip: true,
  signature_at: true,
  terms_accepted: true,        // #21 — surface acceptance on the authed detail (parity with estimatePublicSelect)
  terms_accepted_at: true,     // #21
  valid_until: true,
  public_token: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  // R6 (2026-07-22) — M5: direct anchor mirroring Job's shape, denormalized from the lead at
  // create()/duplicate()/revise() time (see those handlers). Exposed alongside the existing
  // `lead.customer`/`lead.customer.service_locations` nesting, not in place of it — nothing
  // reads these yet, but a future lead-less create path needs the API to already carry them.
  customer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company_name: true,
      email: true,
      phone: true,
      // The workspace header's "Prepared For" column renders the customer's BILLING address
      // (where the paperwork goes), distinct from the Service Location column below. Kept
      // byte-identical to the nested lead.customer select so both anchors render the same header.
      billing_address_line1: true,
      billing_address_line2: true,
      billing_city: true,
      billing_state: true,
      billing_zip: true,
      // #2041 decision 5 — projects the row-scope PROOF relations onto this anchor so
      // `presentEstimateDetail` (customerContact.ts) can judge readability synchronously,
      // in-memory, without re-awaiting the grant. Stripped again before any response goes out.
      ...CUSTOMER_PROOF_SELECT,
    },
  },
  service_location: {
    select: {
      address_line1: true,
      address_line2: true,
      city: true,
      state: true,
      zip: true,
    },
  },
  lead: {
    select: {
      id: true,
      // The hero's "Attached to" strip names the lead ("Lead L00042"), so the number travels
      // with the id - a link the user cannot read the destination of is half an affordance.
      lead_number: true,
      status: true,
      service_request: true,
      service_address_line1: true,
      service_address_line2: true,
      service_city: true,
      service_state: true,
      service_zip: true,
      // Walkthrough-as-entity redesign, PR-B2: the three walkthrough_* fields below are no
      // longer raw legacy columns - projectEstimateLeadWalkthrough (called at every
      // estimateDetailSelect response site) sources them from this relation instead, resolving
      // D15's "current visit" so the estimate workspace's walkthrough badge stays coherent
      // under multiple visits.
      // S8 (D6): the crew rides on the trips - `visit_assignees.lead_id` is dropped.
      visits: { select: { ...walkthroughSnapshotSelect, assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } } } },
      customer: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          company_name: true,
          email: true,
          phone: true,
          // Same "Prepared For" billing address as the direct `customer` anchor above - a
          // lead-anchored estimate resolves its customer through here instead.
          billing_address_line1: true,
          billing_address_line2: true,
          billing_city: true,
          billing_state: true,
          billing_zip: true,
          service_locations: {
            where: { is_primary: true },
            take: 1,
            select: {
              address_line1: true,
              address_line2: true,
              city: true,
              state: true,
              zip: true,
            },
          },
          // #2041 decision 5 — see the direct `customer` anchor's comment above.
          ...CUSTOMER_PROOF_SELECT,
        },
      },
    },
  },
  creator: { select: { id: true, first_name: true, last_name: true } },
  line_items: {
    select: {
      id: true,
      sequence: true,
      description: true,
      quantity: true,
      unit_price: true,
      is_taxable: true,
      line_total: true,
      price_book_item_id: true,
      price_book_item: { select: { image_url: true } },
      unit_cost: true,
      markup_percent: true,
      discount_type: true,
      discount_value: true,
      discount_amount: true,
      item_type: true,
      is_optional: true,
      is_selected: true,
      // The rep's recommendation: the editor's own checkbox reads THIS, never `is_selected`,
      // falling back to it only when this is null. Selected HERE (the authed detail shape) and
      // deliberately NOT on `estimateDocumentSelect`, which every customer-facing surface shares:
      // this is internal rep state and the customer's page has no business seeing it.
      rep_selected: true,
      // #2029 — a line item carries no uploaded photos. Its only image is the price-book item's
      // own `image_url` attribute; the uploaded-photo path is retired.
    },
    orderBy: { sequence: 'asc' as const },
  },
  // R5f (2026-07-22) — scope-of-work photos, flat (not nested under `scopes`, which is a raw JSONB
  // array with no server-side attach point) — the frontend groups these client-side by scope_id.
  scope_photos: {
    select: { id: true, scope_id: true, storage_path: true, mime_type: true, caption: true, uploaded_at: true, uploaded_by: true, size_bytes: true },
    orderBy: { uploaded_at: 'asc' as const },
  },
  job: {
    select: { id: true, job_number: true, status: true },
  },
  // The OTHER job pointer. `job` above is PROVENANCE (Job.estimate_id - a job created FROM this
  // estimate); `job_link` is the ANCHOR (Estimate.job_id - this estimate was written against an
  // existing job). A job-anchored estimate has no Job pointing back, so `job` is null and the
  // response carried nothing but a bare `job_id` uuid - the workspace could navigate to the job
  // but never name it. Same shape as `job` so the hero's "Attached to" strip renders either.
  job_link: {
    select: { id: true, job_number: true, status: true },
  },
  // Entity-redesign §6 — the kind=DEPOSIT Invoice is the SOLE deposit document + the refund
  // surface (unified Invoice refund replaces the removed POST /:id/refund-deposit). The legacy
  // Deposit model is gone (Phase D); this exposes the deposit invoice's id/status/amount so the
  // UI can render + target it.
  // R5e (2026-07-22) — widened DEPOSIT-only → DEPOSIT|STANDARD (dropped the `take: 1` that came
  // with the DEPOSIT-only assumption) so a copy-to-invoice STANDARD invoice also surfaces here,
  // for the reciprocal "View Invoice" link on the estimate detail page. Purely additive: every
  // existing DEPOSIT-only consumer of this select still gets exactly the same DEPOSIT row(s).
  invoices: {
    where: { kind: { in: ['DEPOSIT' as const, 'STANDARD' as const] } },
    select: {
      id: true, invoice_number: true, status: true, kind: true, total_amount: true, amount_due: true,
      total_refunded: true, refunded_at: true,
      payments: { select: { id: true, amount: true, method: true, paid_at: true, stripe_payment_intent_id: true, reference_number: true } },
    },
  },
  send_config: {
    select: {
      id: true, deposit_required: true, deposit_percentage: true,
      deposit_amount: true, payment_methods: true, message_body: true,
    },
  },
};

// #2028 — the public page is one of the three estimate-document surfaces, so its document body
// IS `estimateDocumentSelect` (lib/estimate-document.ts) and nothing else decides what the
// customer sees. Only NON-document fields are added here: the consent/acceptance record, the
// public lifecycle timestamps, the send configuration and the deposit invoice.
//
// The projection's customer sub-select is wider than the display name this select used to carry
// (it adds email and phone, which the Prepared For block on the PDF prints). That is the same
// audience: the customer reaching this endpoint holds the token that also serves them
// /public/pdf, which prints both. Every response built from this select is normalised through
// `toEstimateDocument`, which strips each scope's `internal_cost` before it can be serialised.
/**
 * #1997 × #2028 — the token-gated public payload carries the customer's DISPLAY NAME only. The
 * same rule `invoice.controller.ts::getPublic` states as "F-55: email/phone withheld from the
 * public (token) payload". An explicit allowlist rather than a subtraction from
 * `estimateDocumentSelect.customer.select`: this is an UNAUTHENTICATED surface, so a field must
 * be named here to reach it, and a future widening of the shared document projection (which the
 * PDF's Bill To block legitimately needs) cannot leak through by omission.
 */
const estimatePublicCustomerSelect = {
  first_name: true,
  last_name: true,
  company_name: true,
} as const;

// Exported (#2090) so a test can assert the projection itself. The selection LOCK runs in the
// customer's browser over this payload, so a field it reads and this select omits is a lock that
// silently never fires - which is exactly what happened to `invoices.kind`. A shape a test can
// only reach by hand-writing it is a shape nothing guards.
export const estimatePublicSelect = {
  ...estimateDocumentSelect,
  // #1997 × #2028 — `estimateDocumentSelect` selects `email`/`phone`/`service_locations` because
  // the PDF surfaces render a Bill To block (`getPublicPdf` runs its OWN query straight off that
  // projection). This route is unauthenticated, so there is no requester for
  // `presentEstimateDetail` to judge and the redaction cannot run here — the narrowing has to be
  // in the projection, on BOTH anchors.
  customer: { select: estimatePublicCustomerSelect },
  lead: {
    select: {
      ...estimateDocumentSelect.lead.select,
      customer: { select: estimatePublicCustomerSelect },
    },
  },
  terms_accepted: true,        // #21
  terms_accepted_at: true,     // #21
  // signature_ip intentionally excluded — internal only
  sent_at: true,
  approved_at: true,
  declined_at: true,
  valid_until: true,
  line_items: {
    // NOTE: unit_cost intentionally excluded — the projection never selects it.
    // #2053 R9 — the token-gated public read is where is_optional/is_selected start appearing
    // publicly; neither is a cost field. They arrive through `estimateDocumentSelect`, which
    // every document surface shares, rather than being restated here.
    select: estimateDocumentSelect.line_items.select,
    orderBy: { sequence: 'asc' as const },
  },
  send_config: {
    select: {
      deposit_required: true, deposit_percentage: true,
      deposit_amount: true, payment_methods: true, message_body: true,
    },
  },
  // Entity-redesign §6 - the kind=DEPOSIT Invoice is the public deposit document (its single
  // line total is the requested deposit; the legacy Deposit model is gone in Phase D).
  invoices: {
    where: { kind: 'DEPOSIT' as const },
    // The deposit document the customer's page renders. It no longer feeds the SELECTION lock:
    // the 2026-09-18 revision took the deposit out of that predicate, which now reads the
    // estimate's own `status` and nothing else.
    select: { id: true, kind: true, status: true, total_amount: true, amount_due: true, public_token: true },
    take: 1,
  },
};

/**
 * The single presenter for every response built from `estimatePublicSelect`. Flattens the lead
 * walkthrough fields as the authed responses do, then normalises the document — scopes read back
 * as an array rather than JSONB null, with each scope's staff-only `internal_cost` removed.
 */
async function presentPublicEstimate<T extends { lead?: unknown; scopes?: unknown } | null>(
  estimate: T,
): Promise<T> {
  if (!estimate) return estimate;
  // #2029 — the customer's page renders the scope photos, so their storage paths are exchanged
  // for freshly-signed urls here, in ONE batched call, exactly as the authed detail does. A
  // persisted signed url is never stored, and `storage_path` never reaches the response.
  const signed = await resolveEstimatePhotoUrls(estimate as never);
  const doc = toEstimateDocument(projectEstimateLeadWalkthrough(signed));
  // Freeze-at-send is internal rep state. `estimateDocumentSelect` never projects the line-item
  // column, but `scopes` is a whole JSONB value that arrives with whatever keys are stored, so the
  // scope half has to be stripped explicitly rather than simply not selected.
  return { ...doc, scopes: stripScopeSendSnapshot(doc.scopes) } as T;
}

// Estimate cost-visibility gate (job-lines pricing-leak follow-up, estimate half). Before this
// fix, estimateDetailSelect unconditionally selected unit_cost/markup_percent on every line item
// AND folded internal_cost into scopes, with NO stripping for a requester who can `read Estimate`
// but not `read Invoice` — e.g. a per-user-grantee opted into "Edit own estimates" without also
// being granted pricing visibility. Thin alias of the shared `stripDocumentCost` policy
// (lib/scopes.ts) so Invoice and Estimate cannot drift out of sync — strips the KEYS (absent, not
// null) from every estimateDetailSelect-shaped response — getById, create, update, duplicate,
// revise — and is reused by estimate-lines.controller.ts for the new granular endpoints.
export const stripEstimateCost = stripDocumentCost;

/**
 * Freeze-at-send, clone half. duplicate() and revise() both mint a NEW DRAFT, which has not been
 * sent to anybody, so it must not inherit a snapshot of a send that happened to a different
 * document: its `rep_selected` starts null/absent and is filled by its OWN first send.
 *
 * Line items already behave that way at both call sites, which enumerate the copied columns field
 * by field and simply do not name this one. `scopes` does not: it is copied as one whole JSONB
 * value, so the key has to be dropped explicitly. A non-array stored value (a malformed legacy
 * row) is passed through untouched rather than flattened to `[]`, which is what `asScopeArray`
 * would do and would silently destroy data on a clone.
 */
function cloneScopesForNewDraft(scopes: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (scopes == null) return Prisma.JsonNull;
  if (!Array.isArray(scopes)) return scopes as Prisma.InputJsonValue;
  return stripScopeSendSnapshot(scopes as ScopeOfWork[]) as unknown as Prisma.InputJsonValue;
}

// Walkthrough-as-entity redesign, PR-B2: estimateDetailSelect's nested `lead.visits`
// relation (see the select above) needs projecting onto the legacy walkthrough_* field NAMES
// the estimate workspace already reads off `estimate.lead`, exactly like stripEstimateCost /
// resolveEstimatePhotoUrls above - called at every one of estimateDetailSelect's response call
// sites (getById/create/update/duplicate/revise/approve/decline/cancel/etc). A no-op for a
// lead-less (customer-anchored) estimate, whose `lead` is null.
export function projectEstimateLeadWalkthrough<T extends { lead?: unknown } | null>(estimate: T): T {
  if (!estimate || !estimate.lead) return estimate;
  // S8: the crew flatten runs FIRST - projectLeadWalkthroughFields strips `visits`.
  return { ...estimate, lead: projectLeadWalkthroughFields(projectLeadVisitCrew(estimate.lead as never), { full: true }) } as T;
}

// R5f (2026-07-22) — line-item + scope photos: same Storage bucket/TTL as inv-stages.controller.ts
// / estimate-photos.controller.ts (the upload/delete endpoints).
const ESTIMATE_PHOTO_STORAGE_BUCKET = 'attachments';
const ESTIMATE_PHOTO_SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h

type EstimatePhotoRow = { storage_path: string } & Record<string, unknown>;

/**
 * Resolve every line-item/scope photo's storage_path to a freshly-signed url, in ONE batched
 * createSignedUrls call across the WHOLE response (never one call per photo) — mirrors
 * inv-stages.controller.ts's signStagePhotoUrls. Zero-cost fast path (returns `estimate`
 * unchanged) when no photo carries a storage_path, which is the common case for every response
 * that isn't GET /:id on an estimate with photos attached.
 *
 * Called BEFORE stripEstimateCost at every one of estimateDetailSelect's response call sites
 * (getById/create/update/duplicate/revise, and estimate-lines.controller.ts's 8 line/scope
 * mutation handlers) — the two touch disjoint fields, so ordering between them doesn't matter,
 * but this MUST run outside any `$transaction` (a live network call to Storage has no place
 * inside a DB transaction — see the "don't mix Storage upload in a DB transaction" learning).
 */
export async function resolveEstimatePhotoUrls<
  T extends {
    scope_photos?: EstimatePhotoRow[];
  },
>(estimate: T): Promise<T> {
  const paths: string[] = [];
  for (const p of estimate.scope_photos ?? []) {
    if (p.storage_path) paths.push(p.storage_path);
  }
  if (paths.length === 0) return estimate;

  const signed = new Map<string, string>();
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(ESTIMATE_PHOTO_STORAGE_BUCKET)
      .createSignedUrls(paths, ESTIMATE_PHOTO_SIGNED_URL_TTL_SECONDS);
    if (error || !data) {
      logger.warn('Failed to sign estimate photo URLs; photos will render with an empty url this response', error ?? '');
    } else {
      for (const row of data) {
        if (row?.path && row?.signedUrl) signed.set(row.path, row.signedUrl);
      }
    }
  } catch (err) {
    logger.warn('Failed to sign estimate photo URLs; photos will render with an empty url this response', err);
  }

  const mapPhoto = (p: EstimatePhotoRow) => {
    const out: Record<string, unknown> = { ...p, url: signed.get(p.storage_path) ?? '' };
    delete out.storage_path;
    return out;
  };

  return {
    ...estimate,
    scope_photos: (estimate.scope_photos ?? []).map(mapPhoto),
  } as T;
}

// ─── Zod Schemas ───────────────────────────────────────

const approvePublicSchema = z.object({
  // Optional at the SCHEMA layer only, so a payment retry on an already-signed (PENDING)
  // estimate can re-open checkout without re-capturing consent. A first-time approval still
  // requires it — enforced in approvePublic() once the estimate's status is known, because
  // that is the first point at which "is this a retry?" is answerable.
  signature_data: z.string().min(1, 'Signature is required').max(500000).optional(),
  payment_method: z.nativeEnum(PaymentMethod).nullable().optional(),
  terms_accepted: z.boolean().optional(),   // #21
  // #2090 slice 3b - the customer's LAST word on the options, sent with the acceptance itself so
  // a tick made on the signature screen cannot be lost between the change and the submit. Same
  // shape and the IDENTICAL validation as the standalone selection door; `is_optional` is absent
  // from that shape on purpose (see publicSelectionSchema).
  selections: z.array(z.object({
    kind: z.enum(['line', 'scope']),
    id: z.string().uuid(),
    is_selected: z.boolean(),
  })).min(1).max(200).optional(),
});

// Shared discount guard (F-45): a PERCENTAGE discount must be 0..100, otherwise it drives a
// negative total. FIXED_AMOUNT is already clamped to the line/subtotal in the controller, so
// large fixed values stay valid.
const discountPctGuard = (
  d: { discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null; discount_value?: number | null },
  ctx: z.RefinementCtx,
) => {
  if (d.discount_type === 'PERCENTAGE' && d.discount_value != null && d.discount_value > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discount_value'],
      message: 'Percentage discount cannot exceed 100',
    });
  }
};

// #2010 finding 2 — deposit_value's twin of discountPctGuard: a PERCENTAGE deposit over 100 bills
// more than the estimate total. resolveDepositAmount only clamps the FIXED branch (Math.min(..,
// total)); PERCENTAGE has no ceiling anywhere else, so this schema-level bound is the only one.
const depositPctGuard = (
  d: { deposit_type?: 'PERCENTAGE' | 'FIXED' | null; deposit_value?: number | null },
  ctx: z.RefinementCtx,
) => {
  if (d.deposit_type === 'PERCENTAGE' && d.deposit_value != null && d.deposit_value > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deposit_value'],
      message: 'Deposit percentage cannot exceed 100',
    });
  }
};

// SERV10X-61 §5.1 - a NEW estimate is anchored to EXACTLY ONE of a lead, a customer, or a job;
// the handler resolves customer/service-location/tax from whichever anchor is set. Zero anchors
// (or more than one) is a 400. The message names all three field ids so a bare no-anchor payload
// still surfaces `lead_id` for the legacy "lead required" assertion, while reading correctly for
// the customer/job paths too.
const singleAnchorGuard = (
  d: { lead_id?: string; customer_id?: string; job_id?: string },
  ctx: z.RefinementCtx,
) => {
  const anchors = [d.lead_id, d.customer_id, d.job_id].filter(Boolean);
  if (anchors.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An anchor is required: provide exactly one of lead_id, customer_id, or job_id',
    });
  }
};

// Description max-length is 5000 across Estimate/Job/Invoice line items (kept in sync for
// cross-surface consistency - v12 §2a briefly reconciled this down to 500; raised back to 5000
// here and on Job/Invoice line items together so long scope-of-work text isn't truncated).
// markup_percent mirrors JobLineItem/InvoiceLineItem: 0..100000 (#1991 — high-markup lines are
// legitimate, so the old .max(100) blocked real work). The bound and the column width move
// together: markup_percent is Decimal(8, 2) on all three line-item tables, chosen as the minimum
// that holds 100000.00, and the Zod cap sits strictly inside it so an out-of-range value is always
// refused with a 400 rather than 22003-overflowing Prisma's write into an opaque 500. Raising this
// bound past the column width would reintroduce that 500. `lineItemObjectSchema` is the bare pre-refine
// object — exported alongside the refined `lineItemSchema` so estimate-lines.controller.ts can
// derive its own update schema (.omit/.partial) from the SAME field set rather than redefining it.
export const lineItemObjectSchema = z.object({
  description: z.string().min(1, 'Description is required').max(LINE_DESCRIPTION_MAX),
  quantity: z.number().positive('Quantity must be positive'),
  unit_price: z.number().min(0, 'Unit price must be non-negative'),
  is_taxable: z.boolean().default(true),
  price_book_item_id: z.string().uuid().nullable().optional(),
  unit_cost: z.number().min(0).nullable().optional(),
  markup_percent: z.number().min(0).max(100000).nullable().optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  item_type: z.enum(['SERVICE', 'MATERIAL']).default('SERVICE'),
  // #2053 slice 1 — estimate-only (this schema is imported by estimate-lines.controller.ts and
  // nothing else; Job/Invoice line schemas are separate and never gain these). `.default()` here
  // is what makes create()'s `.optional()`-free line_items array always resolve both flags; the
  // SAME schema's `.omit/.partial` derivative (updateLineSchema) turns each into
  // ZodOptional<ZodDefault<...>>, which short-circuits on an absent key rather than defaulting
  // it — so a granular PATCH can still send one flag alone (frozen case 2).
  is_optional: z.boolean().default(false),
  is_selected: z.boolean().default(true),
});

export const lineItemSchema = lineItemObjectSchema.superRefine(discountPctGuard);

/**
 * #2053 slice 1 — non-optional implies selected, applied at every estimate line-item write path
 * (create, update's whole-document replace, addLine, updateLine). Normalises, never rejects: a
 * payload `{is_optional:false, is_selected:false}` is accepted and stored as selected (frozen
 * case 4). Exported so estimate-lines.controller.ts's addLine/updateLine share the same rule.
 *
 * READ THIS IF YOU ARE CHANGING A SELECTION WRITE PATH. This function is arithmetic on a pair of
 * booleans and says nothing about WHICH COLUMN they land in. `is_selected` is the LIVE answer on
 * the document: it drives the customer's public page and it drives the totals
 * (`countsTowardTotals`). `rep_selected` is the rep's recommendation, and since slice A2 every
 * send PUBLISHES it onto `is_selected` (`publishRepRecommendation`, this file).
 *
 * Choosing between the two is `routeSelectionWrite`'s job (estimate-lines.controller.ts), and its
 * rule is: while DRAFT a staff write lands on BOTH, because before a send the rep's
 * recommendation and the document's answer are the same thing; once the estimate has left DRAFT a
 * staff write lands on `rep_selected` alone and the customer's answer is left where it is. Slice
 * A3 put that rule in. This comment used to DEFER it — "the granular writers need to stop
 * accepting is_selected after send… its own slice" — and used to record the resulting drift, the
 * rep's tick moving the document under the customer between sends, as a live gap. That gap is
 * closed; do not re-open it by writing `is_selected` from a staff path directly.
 *
 * The callers, and what each one is:
 *
 *  - the GRANULAR writers (addLine/updateLine/addScope/updateScope,
 *    estimate-lines.controller.ts) go through `routeSelectionWrite`;
 *  - the CUSTOMER's own public selection write is `is_selected` and only ever `is_selected` —
 *    their answer is not a recommendation, and nothing customer-facing may reach the other column;
 *  - create() and update()'s WHOLE-DOCUMENT replace below write `is_selected` directly. The
 *    replace deletes and recreates every line, which DROPS the recommendation entirely — see the
 *    comment at its own write site for why preserving it is not possible while the payload
 *    carries no ids. A line that loses its `rep_selected` stops being publishable, so the next
 *    send has no opinion on it and it keeps whatever `is_selected` it was recreated with. Closing
 *    THAT means giving the payload ids; the PRD ruled it out of slices A1-A6 on purpose.
 */
export function normalizeLineSelection<T extends { is_optional?: boolean | null; is_selected?: boolean | null }>(
  x: T,
): T {
  return x.is_optional ? x : { ...x, is_selected: true };
}

// §A1/§A3a lock guard: a SENT/PENDING estimate is editable in place UNLESS it's locked —
// deposit already PAID (§A1, permanent) or the org's lock_on_send toggle is ON (§A3a, immutable
// the moment it's sent). A DRAFT estimate is never locked. Extracted from update() (finding B1)
// so estimate-lines.controller.ts's granular line/scope handlers enforce the SAME lock instead
// of only gating on isEditableStatus and silently bypassing Revise-only editing.
//
// D12 (2026-07-21) supersedes the D6-era PENDING-is-always-locked rule: PENDING (customer signed,
// deposit outstanding) is no longer unconditionally locked. A material edit to an unlocked PENDING
// estimate is now ALLOWED — it voids the signature and reverts the estimate to SENT instead of
// being hard-blocked (see pendingRevertOnMaterialChange below). The hard lock still applies
// uniformly to SENT and PENDING alike whenever the deposit is already paid or the org's
// lock_on_send toggle is on.
export function isEstimateLocked(existing: {
  status: string;
  invoices?: { status: string }[];
  organization?: { lock_on_send: boolean | null } | null;
}): boolean {
  if (existing.status === 'DRAFT') return false;
  const depositPaid = existing.invoices?.[0]?.status === 'PAID';
  const lockOnSend = existing.organization?.lock_on_send ?? false;
  return depositPaid || lockOnSend;
}

// §A3 guardrail data for a material edit to a SENT/PENDING estimate: bump version, flag
// modified_after_send, and invalidate the public link the customer already has.
// Extracted from update() (finding B1) so estimate-lines.controller.ts's recomputeAndPersist can
// apply the IDENTICAL ceremony when a granular line/scope mutation changes the customer's
// document, instead of only update()'s whole-document PATCH remembering to. WHAT counts as
// material is `customerVisibleDocumentChanged` (lib/estimates/public-link.ts), which both call
// sites share; this function is only the ceremony.
//
// A5 — the revocation itself is now `REVOKE_PUBLIC_LINK`, the same constant revise() spreads, so
// both dead-link paths leave the row in one shape and the customer meets one 404. It nulls
// `valid_until` alongside the token, which this used to leave standing: an expiry date on a row
// with no link is a date for a document nobody can open, and the date-anchor automation sweep
// still selects SENT estimates by it — i.e. an "your estimate expires tomorrow" nudge pointing at
// a 404. The send that mints the replacement token mints a fresh window with it.
export function materialChangeGuardrail(version: number): { version: number; modified_after_send: true } & typeof REVOKE_PUBLIC_LINK {
  return { version: version + 1, modified_after_send: true, ...REVOKE_PUBLIC_LINK };
}

// D12 — a material edit to a PENDING (customer-signed) estimate must void the stale signature
// rather than leave it attached to a document the customer never actually approved. Applied
// alongside materialChangeGuardrail wherever a mutation is material AND the pre-mutation status was
// PENDING; a no-op (non-material) edit must never touch these fields. Shared by update() and
// estimate-lines.controller.ts's recomputeAndPersist so the two cannot drift apart.
export function pendingRevertOnMaterialChange(
  isMaterialChange: boolean,
  status: string,
): { status: typeof ESTIMATE_STATUS.SENT; signature_data: null; signature_at: null } | Record<string, never> {
  if (isMaterialChange && status === ESTIMATE_STATUS.PENDING) {
    return { status: ESTIMATE_STATUS.SENT, signature_data: null, signature_at: null };
  }
  return {};
}

// SERV10X-61 §5.1 - a NEW estimate is anchored to EXACTLY ONE of a lead, a customer, or a job
// (all three `.optional()`; `singleAnchorGuard` below enforces the exactly-one rule). The handler
// resolves customer/service-location/tax from whichever anchor is set.
// `tax_rate` is `.optional()` (NOT defaulted to 0) so an OMITTED rate signals "auto-derive from the
// anchor's service-location state" while an explicit `0` is a deliberate override.
export const createEstimateSchema = z.object({
  lead_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  scope_notes: z.string().max(5000).optional(),
  tax_rate: z.number().min(0).max(1).optional(),
  // R5a (2026-07-21) — relaxed from .min(1): calculateTotals already folds a scope's flat_price
  // into subtotal independently of line items, so a scope-only (or start-blank, R6) estimate with
  // zero line items is a real, computable document, not an invalid one. `.default([])`, not bare
  // `.optional()` — EstimateTabs.tsx's "Start blank" sends `{ lead_id }` with no `line_items` key
  // at all, and create()'s handler destructures it unconditionally into calculateTotals(...)/
  // .map(...), both of which throw on undefined; a missing key must still resolve to [].
  line_items: z.array(lineItemSchema).default([]),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  discount_name: z.string().max(200).nullable().optional(),
}).superRefine(discountPctGuard).superRefine(singleAnchorGuard);

export const updateEstimateSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  scope_name: z.string().max(200).nullable().optional(),
  scope_notes: z.string().max(5000).optional().nullable(),
  tax_rate: z.number().min(0).max(1).optional(),
  line_items: z.array(lineItemSchema).optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  discount_name: z.string().max(200).nullable().optional(),
  deposit_type: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  deposit_value: z.number().min(0).nullable().optional(),
  // R3 (2026-07-21) — cost model (D2/D8). Nullable overhead_mode/value mirror deposit_type/value
  // directly above: null clears the estimate-level override and falls back to the org default.
  labor_hours: z.number().min(0).max(99999).nullable().optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).nullable().optional(),
  overhead_value: z.number().min(0).nullable().optional(),
}).superRefine(discountPctGuard).superRefine(depositPctGuard);

export const cancelEstimateSchema = z.object({
  cancelled_reason: z.string().min(1, 'Cancellation reason is required').max(2000),
});

export const sendEstimateSchema = z.object({
  deposit_required: z.boolean().default(true),
  payment_methods: z.array(z.nativeEnum(PaymentMethod)).default([]),
  message_body: z.string().max(5000).optional(),
  cc_emails: z.array(z.string().email()).max(5).optional(),
  // One-off recipient override (editable "To"). Request-scoped — not saved to the customer.
  recipient_override: z.string().email().optional(),
});

// Record Payment — admin captures a deposit payment directly on an estimate,
// bypassing the public-page approval ceremony. See:
// md_files/plans/estimates/record-payment-on-estimate.md
export const recordEstimatePaymentSchema = z.object({
  amount: z.number().positive(),
  deposit_percentage: z.number().positive().max(100).optional(),
  payment_method: z.nativeEnum(PaymentMethod),
  paid_at: z.string().datetime().optional(),
  reference_number: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
});

export const createEstimateNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

// Entity-redesign §10 — duplicate target-lead selector. Omitted ⇒ same lead (version/option).
export const duplicateEstimateSchema = z.object({
  target_lead_id: z.string().uuid().optional(),
});

// Editable record ids (Workiz dual-run, SERV10X record-renumber) - shared by both the preview and
// the rename endpoint below. Deliberately thin: the charset/length/numeric-cap rules live in
// validateNumberFormat inside record-renumber.ts (called by computeRenumber), not here - this
// schema only guarantees `number` is present and a string.
export const estimateNumberSchema = z.object({
  number: z.string(),
}).strict();

// List-level bulk delete (Estimates list page). Same DRAFT-only guard as single delete —
// see deleteEstimateInternal/bulkRemove below.
export const bulkDeleteEstimatesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

// List-level bulk status change (Estimates list page). The enum is COPIED from
// setEstimateStatusSchema above, not referenced - that const is defined later in this file, and
// referencing it here would hit its temporal-dead-zone at module evaluation. The two-transition
// whitelist is the whole safety property - see the docblock above setEstimateStatusSchema.
export const bulkSetEstimateStatusSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  transition: z.enum(['backtodraft', 'backtosent']),
});

// List-level bulk send reminder (Estimates list page). Capped at 25, not the house 100: each row
// renders a PDF via renderEstimatePdfBuffer (email.ts) inside sendEstimateEmail, and the loop
// below is sequential - 25 serial Resend round-trips is the real ceiling, not the PDF render.
export const bulkSendEstimateRemindersSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(25),
  message_body: z.string().max(5000).optional(),
});

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

interface LineItemInput {
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  discount_type?: string | null;
  discount_value?: number | null;
  // #2053 — see recomputeInvoiceTotals's countsTowardTotals; absent means "counts", matching
  // today's unconditional sum for a caller (e.g. the tax/discount-only recalc branch below) that
  // hasn't been touched to select these.
  is_optional?: boolean | null;
  is_selected?: boolean | null;
}

interface EstimateDiscountInput {
  discount_type?: string | null;
  discount_value?: number | null;
}

/**
 * #2053 slice 1 — THIN ADAPTER over recomputeInvoiceTotals (lib/invoice-totals.ts). The two
 * derivations agree line-for-line on today's numbers (reviewer amendment R0: same round2, same
 * per-line/per-document discount rules, same proportional taxable ratio), so delegating is a
 * no-op for every existing caller and AC8's byte-identical regression. Exported signature and
 * return shape are UNCHANGED — callers at :1180/:1748/:1846/:3846 and
 * estimate-lines.controller.ts:267 read `computed` BY INDEX, so the loops below are deleted, not
 * edited. `taxExempt: false` and `tip: 0`: the estimate resolves tax-exemption into the RATE
 * before calling this (see create()/update()'s effectiveTaxRate), and has no tip concept; passing
 * `discountType`/`discountValue` (never `invoiceDiscountAmount`) lets recomputeInvoiceTotals
 * re-resolve the discount as a RATE against THIS call's own subtotal, exactly like the deleted
 * body did.
 */
export function calculateTotals(
  lineItems: LineItemInput[],
  taxRate: number,
  estimateDiscount?: EstimateDiscountInput,
  // v12 §2a — flat-priced, non-line-item scope-of-work blocks (Estimate.scopes, scopes.ts),
  // folded into subtotal/taxable-base exactly like recomputeInvoiceTotals's scopes loop
  // (invoice-totals.ts:88-97). Reused by estimate-lines.controller.ts's recomputeAndPersist so
  // every write path — create/update/duplicate here, plus the new granular line/scope
  // endpoints — shares this one totals calculation.
  scopes?: ScopeForTotals[],
) {
  const result = recomputeInvoiceTotals({
    lines: lineItems,
    scopes,
    taxRate,
    taxExempt: false,
    discountType: estimateDiscount?.discount_type as 'PERCENTAGE' | 'FIXED_AMOUNT' | null | undefined,
    discountValue: estimateDiscount?.discount_value,
    tip: 0,
  });

  return {
    subtotal: result.subtotal,
    taxAmount: result.tax_amount,
    totalAmount: result.total_amount,
    estimateDiscountAmount: result.discount_amount,
    computed: result.computedLines,
  };
}

/**
 * #2090 - the ONE recompute of an estimate's four persisted totals columns from its CURRENT rows.
 *
 * Lifted verbatim out of estimate-lines.controller.ts's `recomputeAndPersist`, which now calls
 * this, so the staff line/scope routes and the customer's own public selection write run the same
 * arithmetic over the same inputs. It is only the arithmetic: the material-change ceremony
 * (version bump / modified_after_send / public_token invalidation) stays with each caller,
 * because a rep's edit and the customer's own tick are NOT the same event.
 *
 * Lives here rather than in a lib because `calculateTotals` does, and estimate-lines.controller.ts
 * already imports this file (never the reverse).
 */
export function recomputeEstimateTotals(
  lines: {
    quantity: unknown;
    unit_price: unknown;
    is_taxable: boolean;
    discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
    discount_value: unknown;
    is_optional: boolean;
    is_selected: boolean;
  }[],
  estimate: { tax_rate: unknown; discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null; discount_value: unknown },
  scopes: ScopeOfWork[],
) {
  return calculateTotals(
    lines.map((l) => ({
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      is_taxable: l.is_taxable,
      discount_type: l.discount_type,
      discount_value: l.discount_value == null ? null : Number(l.discount_value),
      // #2053 - without the flags the filter has nothing to filter on and every line counts.
      is_optional: l.is_optional,
      is_selected: l.is_selected,
    })),
    Number(estimate.tax_rate),
    {
      discount_type: estimate.discount_type,
      discount_value: estimate.discount_value == null ? null : Number(estimate.discount_value),
    },
    toEstimateScopeForTotals(scopes),
  );
}

// PRD §13.7 / finding B8 — the deposit-figure resolver moved to lib/estimates/deposit-amount.ts
// (#2031 slice 5) so invoice.controller's public money door can share it: estimate.controller
// already imports invoice.controller, so the dependency cannot run the other way. #2010's
// percentage ceiling moved with it — see `resolveDepositAmount` there.

/**
 * Entity-redesign §4 — derive an estimate's tax rate from the lead's service-location
 * state (destination-based tax, §11). Resolves the state via the lead's
 * `service_location` (Phase 4a) and falls back to the denormalized `service_state`
 * for backward-compat. The rate itself comes from `resolveTaxRateForState`, the one lookup every
 * derivation site shares: the org's own row for the state wins over the global one.
 * Returns 0 when no state resolves or neither table has the state.
 *
 * `client` may be the request-scoped `prisma` or a transaction client.
 */
async function deriveTaxRateFromLead(
  client: Prisma.TransactionClient | typeof prisma,
  leadId: string,
  orgId: string,
): Promise<number> {
  const lead = await client.lead.findUnique({
    where: { id: leadId, organization_id: orgId },
    select: {
      service_location_id: true,
      service_location: { select: { state: true } },
      service_state: true,
    },
  });
  const state = lead?.service_location?.state ?? lead?.service_state ?? null;
  return resolveTaxRateForState(client, orgId, state);
}

async function canAccessEstimate(
  estimate: { lead: { lead_assignees?: { user_id: string }[] } | null; created_by: string } | null,
  req: Request,
): Promise<boolean> {
  if (!estimate) return false;
  // F-004 — role-agnostic own-scope, fully grant-driven (no role literals). Owning the parent lead
  // always grants access. Otherwise any ROW-SCOPED reader — SALES (default OWN_LEAD-conditioned
  // read grant), a granted tech via a conditional override, or any future conditioned reader — is
  // own-only and rejected here; only an UNCONDITIONAL reader (ADMIN/DISPATCHER) sees an estimate
  // they don't own. The scope engine, not a hardcoded role, decides.
  if (estimate.lead) {
    const ownsLead = estimate.lead.lead_assignees?.some((a) => a.user_id === req.user?.id) ?? false;
    if (ownsLead) return true;
  } else if (estimate.created_by === req.user?.id) {
    // R6/D19 — a lead-less estimate has no assignee by design; the creator is the own-scope
    // signal instead (mirrors the lead-assignee check above, one level up the anchor chain).
    return true;
  }
  const scope = await scopeWhereForReq(req, 'Estimate');
  if (Object.keys(scope).length > 0) return false; // any conditional read grant ⇒ own-only
  return true;
}

// ─── Handlers ──────────────────────────────────────────

/**
 * Build the `where` clause (and the underlying grant-driven `readScope`) for the estimate
 * list/export. Extracted from `list()` so the unpaginated `exportAll` applies the IDENTICAL
 * tenant scope + CASL row-scope + filters. Returns `readScope` too because `list()` reuses it
 * to build the separate stats `scopeWhere`.
 */
export async function buildEstimateListWhere(req: Request): Promise<{ where: Record<string, unknown>; readScope: Record<string, unknown> }> {
  const search = (req.query.search as string) || '';

  // #106 — grant-driven row scope is the single source of read-scope truth: ADMIN/unconditional
  // → {} (no restriction), a conditioned Owned/Team/Location read → that condition, and a role
  // with NO estimate read grant → MATCH_NOTHING (fail-closed). Spread it as the OUTERMOST
  // fragment so a per-request filter can never overwrite its keys. This closes the prior
  // fail-open where only SALES was hardcoded and every other non-ADMIN role saw the whole org.
  // SALES is included via its OWN_LEAD-conditioned default `read Estimate` grant (F-004), so the
  // grant-driven readScope is the sole source of row-scope — no role literal needed.
  const readScope = await scopeWhereForReq(req, 'Estimate');
  const where: Record<string, unknown> = { ...tenantWhere(req), ...readScope };

  // status (enum-validated), created_by/lead_id (array-capable scalars), deposit_status
  // (mapped onto invoices.some), customer_id (AND-appended via lead), total (range), and
  // created (dateRange) all live in the shared facet registry now — see estimate.filters.ts
  // for why status/deposit_status/customer_id need custom appliers instead of equalsOrIn.
  await applyFilters(where, req, estimateFacets);

  if (search) {
    // Clobber-safe, and as of SERV10X-61 this is LOAD-BEARING rather than the defensive parity
    // with the lead/invoice lists it started as. A multi-read user's row-scope can be an `OR`
    // (spread in above from scopeWhereForReq) and a direct `where.OR =` would drop it (row-scope
    // LEAK). Task 8 made SALES read Estimate exactly that: OWN_ESTIMATE_VIA_LEAD_OR_CREATOR is a
    // top-level OR (own-via-lead OR lead-less-and-created-by-me), so a direct assignment here
    // would now widen a searching SALES rep's list to every estimate in the org. AND-merging is
    // what prevents that. See lib/permissions/whereCompose.
    addOrFilter(where, [
      { estimate_number: { contains: search, mode: 'insensitive' } },
      { lead: { customer: { first_name: { contains: search, mode: 'insensitive' } } } },
      { lead: { customer: { last_name: { contains: search, mode: 'insensitive' } } } },
      { lead: { customer: { company_name: { contains: search, mode: 'insensitive' } } } },
      // SERV10X-61 - parallel direct-customer terms so a lead-less estimate is findable by customer
      // name too (a lead-anchored row still also matches via the lead-based terms above).
      { customer: { first_name: { contains: search, mode: 'insensitive' } } },
      { customer: { last_name: { contains: search, mode: 'insensitive' } } },
      { customer: { company_name: { contains: search, mode: 'insensitive' } } },
    ]);
  }

  return { where, readScope };
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, ESTIMATE_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;

    const { where, readScope } = await buildEstimateListWhere(req);

    // Stats scope mirrors the list scope — both derive entirely from the grant-driven readScope
    // (SALES included, via its OWN_LEAD-conditioned Estimate read grant). No role literal.
    const scopeWhere: Record<string, unknown> = { ...tenantWhere(req), ...readScope };

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const [
      estimates, total,
      monthlyGroups,
      pendingAgg,
      pendingDeposits,
    ] = await Promise.all([
      prisma.estimate.findMany({
        where,
        select: estimateListSelect,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.estimate.count({ where }),
      prisma.estimate.groupBy({
        by: ['status'],
        where: { ...scopeWhere, created_at: { gte: monthStart, lte: monthEnd } },
        _count: true,
        _sum: { total_amount: true },
      }),
      prisma.estimate.aggregate({
        where: { ...scopeWhere, status: 'PENDING' },
        _count: true,
        _sum: { total_amount: true },
      }),
      // Pending deposits — the kind=DEPOSIT Invoice is the SOLE source (legacy Deposit gone).
      // "Pending" = a deposit invoice still awaiting payment (DRAFT/SENT, not paid/voided).
      // Scope to the SALES user's own leads (via estimate→lead), matching the other stats.
      prisma.invoice.aggregate({
        where: {
          ...tenantWhere(req),
          kind: 'DEPOSIT',
          status: { in: ['DRAFT', 'SENT'] },
          // Scope the deposit KPI through the estimate exactly as the list is scoped: a conditional
          // Estimate reader (SALES/own-scoped) sees only deposits on estimates they can read; an
          // unconditional reader (ADMIN/DISPATCHER) sees all. Grant-driven via readScope.
          ...(Object.keys(readScope).length > 0 ? { estimate: readScope } : {}),
        },
        _count: true,
        _sum: { amount_due: true },
      }),
    ]);

    // SRVW-103 - one batched, tenant-scoped tag read for the whole page (never one per row).
    const tagsByEstimate = await loadTagsByEntity(req, 'ESTIMATE', estimates.map((e) => e.id));

    const byStatus = Object.fromEntries(
      monthlyGroups.map((g) => [g.status, { count: g._count, value: g._sum.total_amount ?? 0 }])
    );
    const statDefault = { count: 0, value: 0 };

    res.json({
      estimates: estimates.map((e) => ({ ...e, tags: tagsByEstimate.get(e.id) ?? [] })),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        draft:     byStatus['DRAFT']     ?? statDefault,
        sent:      byStatus['SENT']      ?? statDefault,
        pending:   { count: pendingAgg._count, value: pendingAgg._sum.total_amount ?? 0 },
        // R1 (2026-07-21) — envelope keys renamed to match the D1 status rename
        // (approved/cancelled -> won/archived); a client-visible contract change, done now
        // rather than after external consumers exist.
        won:       byStatus[ESTIMATE_STATUS.WON]      ?? statDefault,
        declined:  byStatus['DECLINED']  ?? statDefault,
        archived:  byStatus[ESTIMATE_STATUS.ARCHIVED]  ?? statDefault,
        pending_deposits: {
          count: pendingDeposits._count,
          total: pendingDeposits._sum.amount_due || 0,
        },
      },
    });
  } catch (err) {
    logger.error('List estimates error:', err);
    res.status(500).json({ error: 'Failed to list estimates' });
  }
}

const EXPORT_ROW_CAP = 50_000;

/**
 * Export every estimate matching the active filters (unpaginated, capped). Reuses the list's
 * `where` (tenant + CASL row-scope + filters), `select`, and default `orderBy` so the CSV the
 * frontend builds is column-identical to the list and row-level security holds.
 */
export async function exportAll(req: Request, res: Response) {
  try {
    const { where } = await buildEstimateListWhere(req);
    const estimates = await prisma.estimate.findMany({
      where,
      select: estimateListSelect,
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (estimates.length === EXPORT_ROW_CAP) {
      logger.warn(`Estimate export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }
    void logAudit({ req, action: 'estimate.exported', resourceType: 'Estimate', resourceId: null });
    res.json({ estimates });
  } catch (err) {
    logger.error('Export estimates error:', err);
    res.status(500).json({ error: 'Failed to export estimates' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const { lead_id, customer_id, job_id, scope_notes, tax_rate, line_items, discount_type, discount_value, discount_name } = req.body;

    const orgId = req.user!.organization_id;

    // F-004 — row-scoped create parent-ownership. A row-scoped Estimate reader may only create on a
    // parent they OWN: SALES (default OWN_LEAD-conditioned read grant) OR a per-user OWN-scoped
    // `create Estimate` grantee (whose paired conditional `read Estimate` makes scopeWhereForReq
    // non-empty) - both surface as a non-empty estimate read-scope. Unconditional readers (ADMIN,
    // who bypasses CASL) skip the check. Fully grant-driven - no role literal. Applied per-anchor
    // below (the customer anchor is exempt per §8 - any create grant may create there).
    const estCreateScope = await scopeWhereForReq(req, 'Estimate');
    const isRowScopedEstimateCreator = Object.keys(estCreateScope).length > 0;

    // SERV10X-61 §5.1 - a NEW estimate is anchored to EXACTLY ONE of a lead, a customer, or a job
    // (the schema's singleAnchorGuard guarantees exactly one field is set). Resolve the estimate's
    // customer_id / service_location_id / tax rate + the numbering container from that anchor. All
    // lookups run on `prisma` (pre-tx), mirroring the original lead-only path.
    let container: 'lead' | 'customer' | 'job';
    let containerId: string;
    let resolvedLeadId: string | null = null;
    let resolvedCustomerId: string;
    let resolvedJobId: string | null = null;
    let resolvedServiceLocationId: string | null = null;
    let effectiveTaxRate: number;
    // SRVW-82 - resolved alongside the customer by every anchor branch below; consumed by the
    // single clamp after the chain closes.
    let customerIsTaxExempt = false;

    if (lead_id) {
      // ── Lead anchor (original behavior, unchanged) ──────────────────────────────────────
      const lead = await prisma.lead.findUnique({
        where: { id: lead_id, ...tenantWhere(req) },
        select: {
          id: true, status: true, lead_assignees: { select: { user_id: true } },
          // R6 (2026-07-22) - denormalized onto the new estimate below, mirroring Job's own
          // customer_id/service_location_id shape.
          customer_id: true, service_location_id: true,
          customer: { select: { tax_exempt: true } },
        },
      });
      if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }

      const terminalStatuses = ['WON', 'LOST', 'CANCELLED'];
      if (terminalStatuses.includes(lead.status)) {
        res.status(400).json({ error: `Cannot create estimate for a ${lead.status.toLowerCase()} lead` });
        return;
      }
      // Bug #39 - never block estimate CREATION on the walkthrough: a DRAFT must always persist so
      // in-progress work is never lost. D8/D9 (PR-B2): send() no longer gates on a walkthrough
      // requirement at all - it only records silent instrumentation (see send()).
      if (isRowScopedEstimateCreator && !lead.lead_assignees.some((a) => a.user_id === req.user!.id)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      container = 'lead';
      containerId = lead_id;
      resolvedLeadId = lead_id;
      resolvedCustomerId = lead.customer_id;
      customerIsTaxExempt = Boolean(lead.customer?.tax_exempt);
      resolvedServiceLocationId = lead.service_location_id;
      // Entity-redesign §4 - tax: an OMITTED tax_rate auto-derives from the lead's service-location
      // state; an explicit value (incl. 0) is a deliberate override snapshotted onto the document.
      // deriveTaxRateFromLead makes a 2nd lead.findUnique on `prisma` (tests mock it separately).
      effectiveTaxRate = tax_rate !== undefined && tax_rate !== null
        ? tax_rate
        : await deriveTaxRateFromLead(prisma, lead_id, orgId);
    } else if (customer_id) {
      // ── Customer anchor (SERV10X-61 §5.2) ───────────────────────────────────────────────
      // §8 - ANY `create Estimate` grant may create a customer-anchored estimate; NO row-scope 403.
      // #2041 decision 8 (was #1996's read-gated refusal here): the create Estimate grant the
      // route already enforced is the authority for a picker-visible customer the requester is
      // not otherwise associated with — tenancy is still the only existence gate. Nothing on this
      // branch writes to the customer row, so there is nothing to guard; the response is redacted
      // automatically by `presentEstimateDetail` below (its `customer`/`lead.customer` anchors
      // carry the #2041 proof relations).
      const customer = await prisma.customer.findUnique({
        where: { id: customer_id, ...tenantWhere(req) },
        select: {
          id: true,
          organization_id: true,
          tax_exempt: true,
          service_locations: { where: { is_primary: true }, take: 1, select: { id: true, state: true } },
        },
      });
      if (!customer) { res.status(404).json({ error: 'Customer not found' }); return; }
      const primaryLoc = customer.service_locations[0];

      container = 'customer';
      containerId = customer_id;
      resolvedCustomerId = customer_id;
      customerIsTaxExempt = Boolean(customer.tax_exempt);
      resolvedServiceLocationId = primaryLoc?.id ?? null;
      // Tax: OMITTED derives from the primary location's state; explicit (incl. 0) overrides.
      effectiveTaxRate = tax_rate !== undefined && tax_rate !== null
        ? tax_rate
        : await resolveTaxRateForState(prisma, orgId, primaryLoc?.state ?? null);
    } else {
      // ── Job anchor (SERV10X-61 §5.4) ────────────────────────────────────────────────────
      const job = await prisma.job.findUnique({
        where: { id: job_id, ...tenantWhere(req) },
        select: {
          id: true, customer_id: true, service_location_id: true,
          visits: { select: { assignees: { select: { user_id: true } } } },
          service_location: { select: { state: true } },
          customer: { select: { tax_exempt: true } },
        },
      });
      if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
      // F-004 - a row-scoped creator may only create on a job they are ASSIGNED to.
      if (isRowScopedEstimateCreator && !isOnJobCrew(job, req.user!.id)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      container = 'job';
      containerId = job_id;
      resolvedJobId = job_id;
      resolvedCustomerId = job.customer_id;
      customerIsTaxExempt = Boolean(job.customer?.tax_exempt);
      resolvedServiceLocationId = job.service_location_id;
      // E3 (job-owns-tax-discount) - the tax LOCK is retired: a job-anchored estimate is a quote,
      // the job is the work, and they may legitimately differ (Workiz allows exactly this). Tax:
      // OMITTED derives from the job's service-location state; explicit (incl. 0) overrides -
      // same rule the lead and customer anchors already follow above.
      effectiveTaxRate = tax_rate !== undefined && tax_rate !== null
        ? tax_rate
        : await resolveTaxRateForState(prisma, orgId, job.service_location?.state ?? null);
    }

    // SRVW-82 (MONEY) - a tax-exempt customer owes no sales tax, so the exemption is applied to the
    // RATE the document is created with, mirroring the invoice side's own precedent
    // (invoice.controller.ts:816). Zeroing the rate rather than the amount means every downstream
    // reader of the persisted estimate.tax_rate - update(), duplicate(), estimate-lines
    // recomputeAndPersist, copyToInvoice, createInvoiceFromJob - inherits the exemption with no
    // signature change, and the tax-inclusive total_amount that resolveDepositAmount multiplies by
    // the deposit percentage stops carrying phantom tax. Placed AFTER the anchor chain so it covers
    // all three anchors and an explicitly supplied tax_rate alike.
    if (customerIsTaxExempt) effectiveTaxRate = 0;

    const { subtotal, taxAmount, totalAmount, estimateDiscountAmount, computed } = calculateTotals(
      line_items, effectiveTaxRate, { discount_type, discount_value },
    );

    const refIds: string[] = line_items
      .map((i: z.infer<typeof lineItemSchema>) => i.price_book_item_id)
      .filter((id: string | null | undefined): id is string => Boolean(id));
    if (refIds.length > 0) {
      const found = await prisma.priceBookItem.findMany({
        where: { id: { in: refIds }, organization_id: orgId },
        select: { id: true },
      });
      if (found.length !== refIds.length) {
        res.status(400).json({ error: 'Invalid price_book_item_id in line items' });
        return;
      }
    }

    const estimate = await prisma.$transaction(async (tx) => {
      // SERV10X-61 §5.7 - number the estimate WITHIN its anchor container (`L00005-1` /
      // `C00010-1` / `J00007-1`) rather than the flat org-wide `E…` series. Same-tx so a failed
      // insert rolls the container's estimate_seq increment back with it.
      // Returns { estimate_number, container_kind, container_seq } - spread as a unit. The
      // provenance columns are what computeRenumber selects cascade targets by, so an estimate
      // that persists only the number is invisible to a container rename for ever (follow-up 2b).
      const allocated = await allocateContainerEstimateNumber(tx, container, containerId, orgId);

      const est = await tx.estimate.create({
        data: {
          // R6 (2026-07-22) / SERV10X-61 §5 - denormalize the resolved anchor onto the estimate at
          // create time so the columns never start drifting. customer_id is always present (every
          // anchor resolves one); lead_id/job_id/service_location_id carry the anchor's own values.
          lead_id: resolvedLeadId,
          customer_id: resolvedCustomerId,
          job_id: resolvedJobId,
          service_location_id: resolvedServiceLocationId,
          ...allocated,
          organization_id: orgId,
          scope_notes: scope_notes || null,
          tax_rate: effectiveTaxRate,
          subtotal,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          discount_type: discount_type || null,
          discount_value: discount_value ?? null,
          discount_name: discount_name || null,
          discount_amount: estimateDiscountAmount,
          created_by: req.user!.id,
          line_items: {
            create: line_items.map((item: z.infer<typeof lineItemSchema>, idx: number) => ({
              sequence: idx + 1,
              description: item.description,
              quantity: item.quantity,
              unit_price: item.unit_price,
              is_taxable: item.is_taxable,
              line_total: computed[idx].line_total,
              price_book_item_id: item.price_book_item_id || null,
              unit_cost: item.unit_cost ?? null,
              markup_percent: item.markup_percent ?? null,
              discount_type: item.discount_type || null,
              discount_value: item.discount_value ?? null,
              discount_amount: computed[idx].discount_amount,
              item_type: item.item_type || 'SERVICE',
              // #2090 (slice 3a) - deliberately UNGUARDED by the selection lock. A brand-new
              // estimate is written DRAFT with no invoices at all, so `areSelectionsLocked` is
              // false by construction on every row this path can produce: a lock check here
              // could never fire. Pinned by estimate-selection-lock-server.test.ts rather than
              // by dead code.
              is_optional: item.is_optional,
              is_selected: normalizeLineSelection(item).is_selected,
            })),
          },
        },
        select: estimateDetailSelect,
      });

      // Note: lead status transition to ESTIMATED happens on estimate SEND, not create (Phase 3)

      // Create timeline event
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: est.id,
          event_type: 'CREATED',
          description: `Estimate ${est.estimate_number} created`,
          created_by: req.user!.id,
        },
      });

      return est;
    });

    void logAudit({ req, action: 'estimate.created', resourceType: 'Estimate', resourceId: estimate.id, metadata: { estimate_number: estimate.estimate_number } });
    res.status(201).json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(estimate)), req)) });
  } catch (err) {
    logger.error('Create estimate error:', err);
    res.status(500).json({ error: 'Failed to create estimate' });
  }
}

export const createFromJobItemsSchema = z.object({
  scope_notes: z.string().optional(),
});

// The owner-chain + line/scope-copy inputs POST /api/jobs/:id/estimates loads on the parent job.
const jobItemsSourceSelect = {
  id: true,
  job_number: true,
  source_plan_id: true,
  customer_id: true,
  service_location_id: true,
  customer: { select: { tax_exempt: true } },
  visits: { select: { assignees: { select: { user_id: true } } } },
  job_line_items: {
    select: {
      description: true, quantity: true, unit_price: true, is_taxable: true, line_total: true,
      item_type: true, price_book_item_id: true, unit_cost: true, markup_percent: true,
    },
    orderBy: { sequence: 'asc' as const },
  },
  scopes: true,
  // E1/E2 (job-owns-tax-discount) - tax_rate/discount_* live on the job itself now, no longer
  // resolved through an attached estimate.
  tax_rate: true,
  discount_type: true,
  discount_value: true,
} as const;

/**
 * POST /api/jobs/:id/estimates - SERV10X-60 Part B (job-items-estimate-parity). Creates a NEW
 * estimate anchored to this job (Estimate.job_id, an EstimateJobLink attachment - this job may
 * already carry any number of these, no 1:1 conflict with job.estimate_id/JobPrimaryEstimate),
 * numbered in the SAME `J00007-1` container the generic job-anchor create() branch above uses.
 *
 * Differs from that branch in SOURCING, not mechanics: it copies THIS job's own
 * job_line_items/scopes (not author-supplied line_items) and derives tax_rate/discount straight
 * off the JOB (E1/E2, job-owns-tax-discount) - the same numbers the Items tab preview and both
 * invoice doors already show - rather than a fresh (and potentially different) location-derived
 * rate. The discount is still resolved as a RATE against THIS new estimate's own (freshly copied)
 * subtotal, same mechanism estimate.controller.ts's own calculateTotals uses everywhere else -
 * this is a brand-new document, not a read of the job's frozen discount_amount.
 */
export async function createFromJobItems(req: Request, res: Response) {
  try {
    const jobId = param(req, 'id');
    const body = req.body as z.infer<typeof createFromJobItemsSchema>;
    const orgId = req.user!.organization_id;

    const job = await prisma.job.findUnique({
      where: { id: jobId, ...tenantWhere(req) },
      select: jobItemsSourceSelect,
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    if (job.source_plan_id) {
      res.status(400).json({ error: 'This job is a service plan visit and cannot be estimated - the plan was already paid upfront.' });
      return;
    }

    // F-004 - mirrors the generic job-anchor create() branch above: a row-scoped creator may
    // only create on a job they are assigned to.
    const estCreateScope = await scopeWhereForReq(req, 'Estimate');
    const isRowScopedEstimateCreator = Object.keys(estCreateScope).length > 0;
    if (isRowScopedEstimateCreator && !isOnJobCrew(job, req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const customerIsTaxExempt = Boolean(job.customer?.tax_exempt);
    const effectiveTaxRate = customerIsTaxExempt ? 0 : Number(job.tax_rate);
    const discountType = job.discount_type;
    const discountValue = job.discount_value != null ? Number(job.discount_value) : null;

    const scopes = asScopeArray(job.scopes);
    const totals = recomputeInvoiceTotals({
      lines: job.job_line_items.map((l) => ({
        quantity: Number(l.quantity), unit_price: Number(l.unit_price), is_taxable: l.is_taxable,
      })),
      scopes: toScopeForTotals(scopes),
      taxRate: effectiveTaxRate,
      taxExempt: customerIsTaxExempt,
      discountType,
      discountValue,
    });

    const estimate = await prisma.$transaction(async (tx) => {
      const allocated = await allocateContainerEstimateNumber(tx, 'job', job.id, orgId);

      const est = await tx.estimate.create({
        data: {
          lead_id: null,
          customer_id: job.customer_id,
          job_id: job.id,
          service_location_id: job.service_location_id,
          ...allocated,
          organization_id: orgId,
          scope_notes: body.scope_notes || null,
          tax_rate: effectiveTaxRate,
          subtotal: totals.subtotal,
          tax_amount: totals.tax_amount,
          total_amount: totals.total_amount,
          discount_type: discountType,
          discount_value: discountValue,
          discount_amount: totals.discount_amount,
          scopes: scopes as unknown as Prisma.InputJsonValue,
          created_by: req.user!.id,
          // Per-line discount_type/discount_value stay uncopied - mirrors jobLineToInvoiceLineCreate
          // (SRVW-85), the same convention both invoice doors already use when copying job lines.
          line_items: {
            create: job.job_line_items.map((l, idx) => ({
              sequence: idx + 1,
              description: l.description,
              quantity: l.quantity,
              unit_price: l.unit_price,
              is_taxable: l.is_taxable,
              line_total: l.line_total,
              price_book_item_id: l.price_book_item_id,
              unit_cost: l.unit_cost,
              markup_percent: l.markup_percent,
              item_type: l.item_type,
            })),
          },
        },
        select: estimateDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'ESTIMATE',
          entity_id: est.id,
          event_type: 'CREATED',
          description: `Estimate ${est.estimate_number} created from job ${job.job_number}`,
          created_by: req.user!.id,
        },
      });

      return est;
    });

    void logAudit({
      req, action: 'estimate.created', resourceType: 'Estimate', resourceId: estimate.id,
      metadata: { estimate_number: estimate.estimate_number, job_id: job.id },
    });
    res.status(201).json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(estimate)), req)) });
  } catch (err) {
    logger.error('Create estimate from job items error:', err);
    res.status(500).json({ error: 'Failed to create estimate' });
  }
}

export const attachToJobSchema = z.object({
  job_id: z.string().uuid(),
});

/**
 * POST /api/estimates/:id/attach-to-job - transition 16 (continuity map §4.6), Part C of
 * job-items-estimate-parity. Attaches an EXISTING standalone/lead-anchored estimate to an
 * EXISTING job (Estimate.job_id, the same EstimateJobLink attachment createFromJobItems above
 * writes) - the door "add an estimate to an existing job from the job's Estimate tab" that did
 * not exist before this. Distinct from createFromJobItems: that mints a NEW estimate FROM the
 * job; this re-anchors an ALREADY-EXISTING one.
 *
 * Guards, in order: the estimate must still be in-flight (DRAFT/SENT/PENDING - the same allow-
 * list update() uses) and not already attached elsewhere; the job must exist and not be a
 * service-plan visit; the two must share a customer (no crossing a customer boundary); and the
 * estimate must carry no already-recorded money (no non-voided invoice, which covers a paid
 * deposit too) - attaching must never silently move money earned under one customer/job context
 * onto another. On success the estimate is re-keyed into the job's OWN `J00007-1` container
 * (allocateContainerEstimateNumber, same helper createFromJobItems/create() use) - its number
 * changes, its id and history do not.
 */
export async function attachToJob(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { job_id } = req.body as z.infer<typeof attachToJobSchema>;
    const orgId = req.user!.organization_id;

    const estimate = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, customer_id: true, job_id: true, lead_id: true,
        // Needed to hand the row back to the allocator's series correctly on re-numbering below:
        // `original_number` is carried forward first-change-only, falling back to the number the
        // row holds now. `number_is_custom` is WRITTEN there, never read, so it is not selected.
        estimate_number: true, original_number: true,
      },
    });
    if (!estimate) { res.status(404).json({ error: 'Estimate not found' }); return; }

    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, estimate.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (!['DRAFT', 'SENT', 'PENDING'].includes(estimate.status)) {
      res.status(400).json({ error: `Cannot attach a ${estimate.status.toLowerCase()} estimate to a job` });
      return;
    }
    if (estimate.job_id) {
      res.status(400).json({ error: 'This estimate is already attached to a job' });
      return;
    }

    const job = await prisma.job.findUnique({
      where: { id: job_id, ...tenantWhere(req) },
      select: { id: true, customer_id: true, source_plan_id: true, lead_id: true, visits: { select: { assignees: { select: { user_id: true } } } } },
    });
    if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
    if (job.source_plan_id) {
      res.status(400).json({ error: 'This job is a service plan visit and cannot take an attached estimate - the plan was already paid upfront.' });
      return;
    }
    if (job.customer_id !== estimate.customer_id) {
      res.status(400).json({ error: 'This estimate and job belong to different customers' });
      return;
    }

    // F-004 - mirrors createFromJobItems above: a row-scoped requester may only attach onto a
    // job they are assigned to.
    const estUpdateScope = await scopeWhereForReq(req, 'Estimate');
    const isRowScopedUpdater = Object.keys(estUpdateScope).length > 0;
    if (isRowScopedUpdater && !isOnJobCrew(job, req.user!.id)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // No moving money already recorded against this estimate - covers both a paid deposit
    // (kind=DEPOSIT, status=PAID) and any issued STANDARD invoice in one check.
    const recordedInvoice = await prisma.invoice.findFirst({
      where: { estimate_id: estimate.id, status: { not: 'VOIDED' }, ...tenantWhere(req) },
      select: { id: true },
    });
    if (recordedInvoice) {
      res.status(409).json({
        error: 'This estimate already has a recorded invoice or paid deposit - void it before attaching to a different job.',
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const allocated = await allocateContainerEstimateNumber(tx, 'job', job.id, orgId);
      // Keep Job.lead_id truthful. This route is the ONLY way a lead-anchored estimate can
      // reach a job that create() never gave a lead (a standalone job), and it is exactly the
      // shape the migration's path-B backfill exists to repair historically - so without this
      // write the column would go stale the moment it ships, and the job would forward none of
      // the lead's attachments or notes. Guarded on null so an existing provenance is never
      // overwritten by attaching a second estimate.
      // updateMany, not update: the null-guard belongs in the WHERE (update() demands a unique
      // where, and re-reading then writing would be a race rather than a guard).
      if (estimate.lead_id && !job.lead_id) {
        await tx.job.updateMany({
          where: { id: job.id, lead_id: null, ...tenantWhere(req) },
          data: { lead_id: estimate.lead_id },
        });
      }
      return tx.estimate.update({
        where: { id: estimate.id },
        data: {
          job_id: job.id,
          ...allocated,
          // The number is ALLOCATOR-issued again, so the row must stop claiming to be hand-typed.
          // Without this, a previously renamed estimate keeps `number_is_custom = true` while now
          // carrying a correct-looking container_kind/container_seq, and computeRenumber
          // (record-renumber.ts, `number_is_custom: false`) skips it for ever — the number would
          // silently stop following its job. Before the provenance columns were written here that
          // row was at least VISIBLY incomplete (container_kind NULL); it would now look right and
          // not be, which is strictly worse to diagnose.
          number_is_custom: false,
          // First-change-only, the same rule applyRenumber follows: `original_number` records the
          // number this estimate was created with, and re-containering must not overwrite it.
          original_number: estimate.original_number ?? estimate.estimate_number,
        },
        select: estimateDetailSelect,
      });
    });

    void logAudit({
      req, action: 'estimate.attached_to_job', resourceType: 'Estimate', resourceId: estimate.id,
      metadata: { job_id: job.id, estimate_number: updated.estimate_number },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(updated)), req)) });
  } catch (err) {
    logger.error('Attach estimate to job error:', err);
    res.status(500).json({ error: 'Failed to attach estimate to job' });
  }
}

export async function getById(req: Request, res: Response) {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        ...estimateDetailSelect,
        lead: {
          select: {
            ...estimateDetailSelect.lead.select,
            lead_assignees: { select: { user_id: true } },
          },
        },
      },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // Sales guard
    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // SRVW-103 - after the 403 guard, so no tag query fires for a row the caller cannot read.
    // The spread allocates a new object whether or not stripEstimateCost returned a copy.
    const tags = await loadTagsForEntity(req, 'ESTIMATE', estimate.id);
    // #2053 round 2 — a scope block written before this feature (or never itself re-saved) has
    // no is_optional/is_selected keys in the stored JSONB; default them here so the detail
    // response always carries both flags, the same "nothing was optional, everything counts"
    // backfill the migration applies to EstimateLineItem rows. Display-only: does not touch the
    // persisted subtotal/total_amount, which were already computed selection-aware at write time.
    const estimateWithScopeDefaults = { ...estimate, scopes: withOptionalDefaults(asScopeArray(estimate.scopes)) };
    const presented = stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(estimateWithScopeDefaults)), req);
    res.json({ estimate: presentEstimateDetail(req, { ...presented, tags }) });
  } catch (err) {
    logger.error('Get estimate error:', err);
    res.status(500).json({ error: 'Failed to get estimate' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, tax_rate: true, discount_type: true, discount_value: true, version: true,
        scopes: true,
        // D12/guardrail-fix: pre-mutation totals + the non-totals "what was quoted" fields, so
        // isMaterialChange below can diff the incoming body against what's ACTUALLY persisted
        // instead of merely checking whether a field is present (the presence-based bug D12 makes
        // customer-affecting once a material PENDING edit also voids the signature).
        subtotal: true, tax_amount: true, total_amount: true, discount_amount: true,
        deposit_type: true, deposit_value: true, discount_name: true,
        created_by: true,
        job_id: true,
        organization: { select: { lock_on_send: true } },
        // The DEPOSIT row the EDIT lock reads. It no longer feeds the SELECTION lock: the
        // 2026-09-18 revision took the deposit out of that predicate.
        invoices: { where: { kind: 'DEPOSIT' }, select: { kind: true, status: true }, take: 1 },
        // A5 — the scope narrative the customer's document prints under "Scope of Work"
        // (`estimateDocumentSelect` selects it; `model.scopeNotes` renders it), so rewriting it
        // retires their link. `name`/`scope_name` are NOT read here: no document surface selects
        // either, so they are staff labels on the tab strip.
        scope_notes: true,
        // #2090 - the stored selection state this PATCH's replacement list is diffed against.
        // A5 widened it from the two selection flags to every field the customer's document
        // RENDERS, because the replacement list can move any of them. Absent on purpose:
        // `unit_cost`/`markup_percent` (staff-only margin data, D2/D8), and `sequence`/
        // `is_taxable`, which no document surface prints — see `CustomerVisibleLine`. The
        // `orderBy` still stands: the projection compares position, so the order is the contract.
        line_items: {
          select: {
            description: true, item_type: true, quantity: true, unit_price: true,
            line_total: true, discount_type: true, discount_value: true,
            discount_amount: true, is_optional: true, is_selected: true, price_book_item_id: true,
          },
          orderBy: { sequence: 'asc' as const },
        },
        lead: { select: { lead_assignees: { select: { user_id: true } } } },
        // SRVW-82 - Estimate.customer_id is R6 NOT-NULL, so this relation always resolves.
        customer: { select: { tax_exempt: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #106 — per-instance ownership (the route guard canDo('update') is subject-level only).
    // Estimate's owner chain is NESTED (lead → lead_assignees.some), so CASL's in-memory matcher
    // (`req.ability.can(...)`) THROWS "equals does not support comparison of arrays and objects" on
    // a conditioned Owned grant — it 500s even for the rightful owner. canAccessRow compiles the
    // grant condition to a scoped findFirst (nested-safe, grant-driven, fail-closed) — the primary
    // boundary for EVERY conditioned reader, now INCLUDING the default SALES role (its Estimate read
    // grant is OWN_LEAD-conditioned post-F-004, so canAccessRow does the scoped check for it too).
    // canAccessEstimate is a redundant JS owner gate (`.some()`) kept as defense-in-depth and for
    // parity with the read handlers (getById/pdf/notes).
    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // #2090 (slice 3a) - THE selection lock, refused BEFORE the two generic guards below so the
    // customer-facing reason survives (a WON estimate is already a 400 there).
    // The whole-document PATCH replaces every line in one write with no id to pair them by, so
    // the diff is positional - see `changesSelectionFlagsInList`. `existing.line_items` is always
    // projected by the select above; the `?? []` only guards a caller that narrowed it.
    if (
      areSelectionsLocked(existing)
      && changesSelectionFlagsInList(req.body?.line_items, (existing as { line_items?: { is_optional?: boolean | null; is_selected?: boolean | null }[] }).line_items ?? [])
    ) {
      res.status(409).json(optionsLockedBody(existing));
      return;
    }

    if (!['DRAFT', 'SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: 'Only draft or sent estimates can be edited' });
      return;
    }

    // §A1/§A3a — a SENT/PENDING estimate is editable in place UNLESS it's locked: deposit already
    // PAID (§A1, permanent) or the org's lock_on_send toggle is ON (§A3a, immutable the moment it's
    // sent). Locked estimates have exactly one mutation path: Revise (clone → new DRAFT, §A2).
    const isGuardedEdit = existing.status !== 'DRAFT';
    if (isEstimateLocked(existing)) {
      res.status(400).json({ error: 'This estimate is locked. Use Revise to make changes.' });
      return;
    }

    const { name, scope_name, scope_notes, tax_rate, line_items, discount_type, discount_value, discount_name, deposit_type, deposit_value, labor_hours, overhead_mode, overhead_value } = req.body;

    // E3 (job-owns-tax-discount) retires the job-anchored tax LOCK: a job-anchored estimate is a
    // quote, the job is the work, and they may legitimately differ. An inbound tax_rate now saves
    // normally, same as any other anchor.

    // R3 (2026-07-21) — labor_hours/overhead_mode/overhead_value are staff-only cost-model inputs
    // (D2/D8). A requester who can't see pricing (canSeePricing gates read Invoice) must not be
    // able to blindly set them either — mirrors the read-side strip in stripEstimateCost.
    if (
      (labor_hours !== undefined || overhead_mode !== undefined || overhead_value !== undefined)
      && !canSeePricing(req)
    ) {
      res.status(403).json({ error: 'Insufficient permissions to edit cost fields' });
      return;
    }

    // SRVW-82 - the receipt card's jurisdiction selector (EstimateReceiptCard.tsx:203) PATCHes a raw
    // tax_rate, which would otherwise re-inflate an exempt estimate. Clamp the REQUESTED rate, not
    // just the computed amount, so the persisted document and every later recompute stay at 0.
    const requestedTaxRate = tax_rate !== undefined ? (existing.customer?.tax_exempt ? 0 : tax_rate) : undefined;
    const effectiveTaxRate = requestedTaxRate !== undefined ? requestedTaxRate : Number(existing.tax_rate);

    // Build estimate-level discount from request or existing values
    const effectiveDiscountType = discount_type !== undefined ? discount_type : (existing as any).discount_type;
    const effectiveDiscountValue = discount_value !== undefined ? discount_value : Number((existing as any).discount_value ?? 0);

    // #2010 — the same merge, for the deposit pair, and here it is a GUARD, not a computation.
    // `depositPctGuard` lives on updateEstimateSchema and therefore only ever sees the REQUEST
    // BODY, but PATCH is partial and the two deposit fields are written independently below, so
    // either half of a >100% percentage deposit can be moved on its own: `{deposit_value: 500}`
    // onto a stored PERCENTAGE row, or `{deposit_type: 'PERCENTAGE'}` onto a stored FIXED/500 row.
    // Both persist an EFFECTIVE PERCENTAGE/500, which send()/markSent() would bill at 5x the
    // estimate total. Resolve the pair against the stored row first and refuse in the schema's own
    // 400 shape. Enforced only when the request actually touches a deposit field: a pre-existing
    // bad row must not wedge an unrelated edit, and resolveDepositAmount's PERCENTAGE clamp is the
    // second line of defence that stops such a row billing above the total either way.
    const touchesDeposit = deposit_type !== undefined || deposit_value !== undefined;
    const effectiveDepositType = deposit_type !== undefined
      ? (deposit_type || null)
      : ((existing as any).deposit_type ?? null);
    const effectiveDepositValue = deposit_value !== undefined
      ? (deposit_value ?? null)
      : ((existing as any).deposit_value != null ? Number((existing as any).deposit_value) : null);
    if (
      touchesDeposit
      && effectiveDepositType === 'PERCENTAGE'
      && effectiveDepositValue != null
      && effectiveDepositValue > 100
    ) {
      res.status(400).json(validationFailure([
        { field: 'deposit_value', message: 'Deposit percentage cannot exceed 100' },
      ]));
      return;
    }

    // ...and once a deposit field is touched, persist the pair TOGETHER (both write sites below
    // read these). The guard above is a read-then-write, so on its own it is racy: two concurrent
    // PATCHes of `{deposit_type:'PERCENTAGE'}` and `{deposit_value:500}` against a FIXED/50 row both
    // read the pre-write row, both resolve to a legal effective pair, and compose into PERCENTAGE/500
    // that neither request could have written alone. Writing the resolved pair makes each request
    // self-consistent, so last-writer-wins yields PERCENTAGE/50 or FIXED/500 — never the mix. For a
    // sequential request this is identical to the old per-field write: the untouched half is written
    // back as the value it already held.
    const depositWrite = touchesDeposit
      ? { deposit_type: effectiveDepositType, deposit_value: effectiveDepositValue }
      : { deposit_type: undefined, deposit_value: undefined };

    // §A3/D12/A5 — a *material* edit to a SENT/PENDING estimate bumps the version, flags "modified
    // after send", invalidates the public link the customer already has, and (when the pre-mutation
    // status was PENDING) voids the signature and reverts to SENT.
    //
    // A5 (Ran, 2026-09-19) replaced the predicate: "material" is no longer "one of the four totals
    // columns moved plus three named fields", it is "the document the customer would OPEN renders
    // differently" — `customerVisibleDocumentChanged`, the SAME helper
    // estimate-lines.controller.ts's `recomputeAndPersist` uses, so the whole-document PATCH and
    // the granular line/scope endpoints cannot drift. It is still a DIFF against the pre-mutation
    // snapshot in `existing`, never mere presence of a field in the body: a no-op PATCH must not
    // retire a live link.
    //
    // Internal cost/margin fields (labor_hours/overhead_mode/overhead_value on the estimate,
    // unit_cost/markup_percent on a line) are absent from the projection by construction — they
    // are staff-only cost data (D2/D8) that no document surface selects, so they are not something
    // the customer was quoted and must never invalidate their signature.
    //
    // The values below are what this handler will actually PERSIST, resolved the same way the two
    // write branches resolve them, so the "after" side is the stored row and not the request body.
    const nextDiscountType = discount_type !== undefined ? (discount_type || null) : ((existing as any).discount_type ?? null);
    const nextDiscountValue = discount_value !== undefined ? (discount_value ?? null) : ((existing as any).discount_value ?? null);
    const nextDiscountName = discount_name !== undefined ? (discount_name || null) : ((existing as any).discount_name ?? null);
    const nextScopeNotes = scope_notes !== undefined ? scope_notes : ((existing as any).scope_notes ?? null);
    const nextTaxRate = requestedTaxRate !== undefined ? requestedTaxRate : existing.tax_rate;

    const documentBefore = {
      subtotal: existing.subtotal,
      tax_amount: existing.tax_amount,
      total_amount: existing.total_amount,
      discount_amount: existing.discount_amount,
      tax_rate: existing.tax_rate,
      discount_type: (existing as any).discount_type ?? null,
      discount_value: (existing as any).discount_value ?? null,
      discount_name: (existing as any).discount_name ?? null,
      deposit_type: (existing as any).deposit_type ?? null,
      deposit_value: (existing as any).deposit_value ?? null,
      scope_notes: (existing as any).scope_notes ?? null,
      scopes: existing.scopes,
      line_items: (existing as { line_items?: CustomerVisibleLine[] }).line_items ?? [],
    };
    /** The estimate-level half of the "after" side — identical on both write branches. */
    const documentAfterHeader = {
      tax_rate: nextTaxRate,
      discount_type: nextDiscountType,
      discount_value: nextDiscountValue,
      discount_name: nextDiscountName,
      deposit_type: effectiveDepositType,
      deposit_value: effectiveDepositValue,
      scope_notes: nextScopeNotes,
      // This endpoint never writes `scopes` — the granular /:id/scopes endpoints own that column.
      scopes: existing.scopes,
    };

    if (line_items) {
      // Fold in the estimate's EXISTING scopes-of-work (managed via the granular
      // /:id/scopes endpoints, not this body) so a line_items-only edit here never silently
      // drops their flat_price from the recalculated subtotal/tax/total. #2053 — one of the four
      // ESTIMATE-only call sites for the selection-aware projection (reviewer amendment R1).
      const existingScopes = toEstimateScopeForTotals(asScopeArray(existing.scopes));
      const { subtotal, taxAmount, totalAmount, estimateDiscountAmount, computed } = calculateTotals(
        line_items, effectiveTaxRate, { discount_type: effectiveDiscountType, discount_value: effectiveDiscountValue },
        existingScopes,
      );

      const refIds: string[] = line_items
        .map((i: z.infer<typeof lineItemSchema>) => i.price_book_item_id)
        .filter((id: string | null | undefined): id is string => Boolean(id));
      if (refIds.length > 0) {
        const found = await prisma.priceBookItem.findMany({
          where: { id: { in: refIds }, organization_id: req.user!.organization_id },
          select: { id: true },
        });
        if (found.length !== refIds.length) {
          res.status(400).json({ error: 'Invalid price_book_item_id in line items' });
          return;
        }
      }

      // A5 — the replacement list mapped to exactly the rows the `create:` below will persist, so
      // the diff is against the stored document rather than the request body. A 2×$50 → 1×$100
      // swap nets to the same four totals and is still a different row on the customer's page.
      const documentAfterLines: CustomerVisibleLine[] = line_items.map(
        (item: z.infer<typeof lineItemSchema>, idx: number) => ({
          description: item.description,
          item_type: item.item_type || 'SERVICE',
          quantity: item.quantity,
          unit_price: item.unit_price,
          line_total: computed[idx].line_total,
          discount_type: item.discount_type || null,
          discount_value: item.discount_value ?? null,
          discount_amount: computed[idx].discount_amount,
          is_optional: item.is_optional,
          is_selected: normalizeLineSelection(item).is_selected,
          price_book_item_id: item.price_book_item_id || null,
        }),
      );
      const isMaterialChange = isGuardedEdit && customerVisibleDocumentChanged(documentBefore, {
        ...documentAfterHeader,
        subtotal,
        tax_amount: taxAmount,
        total_amount: totalAmount,
        discount_amount: estimateDiscountAmount,
        line_items: documentAfterLines,
      });
      const guardrailData = isMaterialChange ? materialChangeGuardrail(existing.version) : {};
      const pendingRevertData = pendingRevertOnMaterialChange(isMaterialChange, existing.status);

      const estimate = await prisma.$transaction(async (tx) => {
        // Delete existing line items and replace
        await tx.estimateLineItem.deleteMany({ where: { estimate_id: existing.id } });

        return tx.estimate.update({
          where: { id: existing.id },
          data: {
            name: name !== undefined ? (name || null) : undefined,
            scope_name: scope_name !== undefined ? (scope_name || null) : undefined,
            scope_notes: scope_notes !== undefined ? scope_notes : undefined,
            tax_rate: requestedTaxRate,
            subtotal,
            tax_amount: taxAmount,
            total_amount: totalAmount,
            discount_type: discount_type !== undefined ? (discount_type || null) : undefined,
            discount_value: discount_value !== undefined ? (discount_value ?? null) : undefined,
            discount_name: discount_name !== undefined ? (discount_name || null) : undefined,
            discount_amount: estimateDiscountAmount,
            deposit_type: depositWrite.deposit_type,
            deposit_value: depositWrite.deposit_value,
            labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
            overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
            overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
            ...guardrailData,
            ...pendingRevertData,
            line_items: {
              create: line_items.map((item: z.infer<typeof lineItemSchema>, idx: number) => ({
                sequence: idx + 1,
                description: item.description,
                quantity: item.quantity,
                unit_price: item.unit_price,
                is_taxable: item.is_taxable,
                line_total: computed[idx].line_total,
                price_book_item_id: item.price_book_item_id || null,
                unit_cost: item.unit_cost ?? null,
                markup_percent: item.markup_percent ?? null,
                discount_type: item.discount_type || null,
                discount_value: item.discount_value ?? null,
                discount_amount: computed[idx].discount_amount,
                item_type: item.item_type || 'SERVICE',
                is_optional: item.is_optional,
                is_selected: normalizeLineSelection(item).is_selected,
                // The rep's recommendation, and the one place it is DROPPED rather than
                // preserved. This endpoint replaces the line set wholesale: the `deleteMany`
                // above removes every existing row and these creates mint new ones, so no row
                // survives to carry a `rep_selected` across. The new rows therefore have none.
                //
                // What that costs after slice A2: a null recommendation is the "no opinion" case,
                // so the next send publishes nothing onto these rows and they keep whatever
                // `is_selected` the payload gave them. The document stays coherent — it simply
                // stops carrying the rep's recommendation until a rep ticks it again.
                //
                // Preserving it here is NOT possible as the contract stands: `lineItemObjectSchema`
                // carries no `id`, so an incoming line cannot be mapped back to the row it
                // replaces. Matching by POSITION would attach a wrong recommendation the moment
                // the rep reorders or deletes a row, which is worse than null; and taking the
                // recommendation FROM the payload would record the customer's round-tripped
                // answer as the rep's own intent, which is the exact lie this feature exists to
                // prevent. That is the PRD's ruling (part A5): leave the behaviour and the null
                // fallback alone. Closing it properly means giving the payload ids, which is its
                // own slice.
              })),
            },
          },
          select: estimateDetailSelect,
        });
      });

      if (isMaterialChange) {
        void logAudit({ req, action: 'estimate.modified_after_send', resourceType: 'Estimate', resourceId: existing.id, metadata: { version: estimate.version, signatureVoided: existing.status === ESTIMATE_STATUS.PENDING } });
        // #2031 slice 5 (F2) — this edit is the moment the deposit figure can stop being true, and
        // a checkout the customer opened before it would otherwise still settle at the old figure.
        // AWAITED, not fired and forgotten: the whole point is that the link is dead before anyone
        // is told the edit went through, and a `void` promise can be cut short with the request.
        // It cannot throw and it cannot fail this edit — see the guard.
        await expireDepositCheckoutsOnMaterialEdit(existing.id, req.user!.organization_id);
      }
      void logAudit({ req, action: 'estimate.updated', resourceType: 'Estimate', resourceId: param(req, 'id'), metadata: { fields: Object.keys(req.body) } });
      res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(estimate)), req)) });
    } else {
      // No line items change — update metadata, recalculate totals if tax/discount changed
      const needsRecalc = tax_rate !== undefined || discount_type !== undefined || discount_value !== undefined;

      let recalcData: {
        subtotal?: number;
        tax_amount?: number;
        total_amount?: number;
        discount_amount?: number;
      } = {};

      if (needsRecalc) {
        const existingLineItems = await prisma.estimateLineItem.findMany({
          where: { estimate_id: existing.id },
          select: {
            quantity: true, unit_price: true, is_taxable: true, discount_type: true, discount_value: true,
            is_optional: true, is_selected: true,
          },
        });

        const { subtotal, taxAmount, totalAmount, estimateDiscountAmount } = calculateTotals(
          existingLineItems.map((li) => ({
            quantity: Number(li.quantity),
            unit_price: Number(li.unit_price),
            is_taxable: li.is_taxable,
            discount_type: li.discount_type,
            discount_value: li.discount_value != null ? Number(li.discount_value) : null,
            is_optional: li.is_optional,
            is_selected: li.is_selected,
          })),
          effectiveTaxRate,
          { discount_type: effectiveDiscountType, discount_value: effectiveDiscountValue },
          // Same "fold in existing scopes" rationale as the line_items branch above — a
          // tax/discount-only recalc must not silently drop scope-of-work pricing either.
          // #2053 — one of the four ESTIMATE-only call sites (reviewer amendment R1).
          toEstimateScopeForTotals(asScopeArray(existing.scopes)),
        );

        recalcData = {
          subtotal,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          discount_amount: estimateDiscountAmount,
        };
      }

      // A5 — same helper, same projection, over the one branch that never touches a line: the
      // rows stand, so both sides read the stored set and only the estimate-level half can move.
      const isMaterialChange = isGuardedEdit && customerVisibleDocumentChanged(documentBefore, {
        ...documentAfterHeader,
        subtotal: recalcData.subtotal ?? existing.subtotal,
        tax_amount: recalcData.tax_amount ?? existing.tax_amount,
        total_amount: recalcData.total_amount ?? existing.total_amount,
        discount_amount: recalcData.discount_amount ?? existing.discount_amount,
        line_items: documentBefore.line_items,
      });
      const guardrailData = isMaterialChange ? materialChangeGuardrail(existing.version) : {};
      const pendingRevertData = pendingRevertOnMaterialChange(isMaterialChange, existing.status);

      const estimate = await prisma.estimate.update({
        where: { id: existing.id },
        data: {
          name: name !== undefined ? (name || null) : undefined,
          scope_name: scope_name !== undefined ? (scope_name || null) : undefined,
          scope_notes: scope_notes !== undefined ? scope_notes : undefined,
          tax_rate: requestedTaxRate,
          discount_type: discount_type !== undefined ? (discount_type || null) : undefined,
          discount_value: discount_value !== undefined ? (discount_value ?? null) : undefined,
          discount_name: discount_name !== undefined ? (discount_name || null) : undefined,
          deposit_type: depositWrite.deposit_type,
          deposit_value: depositWrite.deposit_value,
          labor_hours: labor_hours !== undefined ? (labor_hours ?? null) : undefined,
          overhead_mode: overhead_mode !== undefined ? (overhead_mode || null) : undefined,
          overhead_value: overhead_value !== undefined ? (overhead_value ?? null) : undefined,
          ...guardrailData,
          ...pendingRevertData,
          ...recalcData,
        },
        select: estimateDetailSelect,
      });

      if (isMaterialChange) {
        void logAudit({ req, action: 'estimate.modified_after_send', resourceType: 'Estimate', resourceId: existing.id, metadata: { version: estimate.version, signatureVoided: existing.status === ESTIMATE_STATUS.PENDING } });
        // #2031 slice 5 (F2) — this edit is the moment the deposit figure can stop being true, and
        // a checkout the customer opened before it would otherwise still settle at the old figure.
        // AWAITED, not fired and forgotten: the whole point is that the link is dead before anyone
        // is told the edit went through, and a `void` promise can be cut short with the request.
        // It cannot throw and it cannot fail this edit — see the guard.
        await expireDepositCheckoutsOnMaterialEdit(existing.id, req.user!.organization_id);
      }
      void logAudit({ req, action: 'estimate.updated', resourceType: 'Estimate', resourceId: param(req, 'id'), metadata: { fields: Object.keys(req.body) } });
      res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(estimate)), req)) });
    }
  } catch (err) {
    logger.error('Update estimate error:', err);
    res.status(500).json({ error: 'Failed to update estimate' });
  }
}

// Extracted from remove() so bulkRemove() (list-level bulk delete, Estimates list page) can share
// the EXACT same guard sequence + delete/cleanup/audit logic without duplicating it. Returns a
// result instead of writing to `res` directly — remove() and bulkRemove() each translate that
// result into their own response shape.
async function deleteEstimateInternal(
  req: Request,
  id: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await prisma.estimate.findUnique({
    where: { id, ...tenantWhere(req) },
    select: { id: true, status: true, created_by: true, lead: { select: { lead_assignees: { select: { user_id: true } } } } },
  });

  if (!existing) {
    return { ok: false, status: 404, error: 'Estimate not found' };
  }

  // #106 — per-instance ownership (delete), mirroring update() above. canAccessRow's scoped
  // findFirst is the nested-safe, grant-driven, fail-closed boundary for EVERY conditioned reader,
  // now INCLUDING the default SALES role (OWN_LEAD-conditioned Estimate read grant post-F-004; the
  // CASL matcher 500s on the nested lead.lead_assignees.some condition). canAccessEstimate is a
  // redundant JS owner gate kept as defense-in-depth.
  if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }

  if (!(await canAccessEstimate(existing, req))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }

  if (existing.status !== 'DRAFT') {
    return { ok: false, status: 400, error: 'Only draft estimates can be deleted' };
  }

  // R5f — collect this estimate's scope-photo storage_paths BEFORE the delete (the DB cascade
  // handles the ROWS via EstimateScopePhoto's direct estimate_id FK, but their Storage objects
  // would orphan silently otherwise). Line items carry no uploaded photos (#2029).
  const scopePhotos = await prisma.estimateScopePhoto.findMany({
    where: { estimate_id: existing.id },
    select: { storage_path: true },
  });

  await prisma.estimate.delete({ where: { id: existing.id } });

  const photoStoragePaths = scopePhotos.map((p) => p.storage_path);
  if (photoStoragePaths.length > 0) {
    try {
      const { error: removeError } = await supabaseAdmin.storage.from(ESTIMATE_PHOTO_STORAGE_BUCKET).remove(photoStoragePaths);
      if (removeError) logger.warn(`Failed to remove storage objects for deleted estimate ${existing.id}:`, removeError);
    } catch (removeErr) {
      logger.warn(`Failed to remove storage objects for deleted estimate ${existing.id}:`, removeErr);
    }
  }

  void logAudit({ req, action: 'estimate.deleted', resourceType: 'Estimate', resourceId: id });
  return { ok: true };
}

export async function remove(req: Request, res: Response) {
  try {
    const result = await deleteEstimateInternal(req, param(req, 'id'));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ message: 'Estimate deleted' });
  } catch (err) {
    logger.error('Delete estimate error:', err);
    res.status(500).json({ error: 'Failed to delete estimate' });
  }
}

// List-level bulk delete (Estimates list page) — sequential, per-id isolated. Each id's guard
// sequence + delete is IDENTICAL to single-delete (deleteEstimateInternal above); one id's
// unexpected error (caught individually) does not abort the rest of the batch. Partial success is
// a valid 200 outcome, not an error — the caller inspects `failed` for per-id reasons.
export async function bulkRemove(req: Request, res: Response) {
  try {
    const { ids } = req.body as z.infer<typeof bulkDeleteEstimatesSchema>;
    const deleted: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await deleteEstimateInternal(req, id);
        if (result.ok) {
          deleted.push(id);
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (err) {
        logger.error(`Bulk delete estimate error for ${id}:`, err);
        failed.push({ id, error: 'Failed to delete estimate' });
      }
    }

    res.json({ deleted, failed });
  } catch (err) {
    logger.error('Bulk delete estimates error:', err);
    res.status(500).json({ error: 'Failed to delete estimates' });
  }
}

// ─── Actions ───────────────────────────────────────────

// SRVW-96 - the predicate means the estimate carries `job_id` (the R6 EstimateJobLink FK) and NO
// Job names it as its provenance estimate (`Job.estimate_id`); it mirrors the guard already at
// job.controller.ts:1102-1103. It does NOT mean the estimate's line items are absent from the job.
// TWO shapes satisfy it: (a) the JOB ANCHOR - `POST /api/estimates {job_id}` writes only the FK
// (estimate.controller.ts create(), no JobLineItem created), so its lines really are estimate-only;
// (b) a MULTI-estimate conversion - job.controller.ts writes
// `estimate_id: estimateIds.length === 1 ? estimateIds[0] : null` on the job, so a 2+-estimate
// conversion leaves provenance NULL, yet every constituent estimate's lines WERE copied onto
// JobLineItem. Both are refused for the one reason true of both: the job's invoices are billed from
// the job's own JobLineItems and never from this estimate, while a deposit taken here is credited
// against that job. No data discriminator between (a) and (b) exists - JobLineItem carries no source
// pointer, and created_at ordering is not usable (25 of 85 conversion-attached staging rows have
// estimate.created_at >= job.created_at). Single-estimate conversion (job.estimate_id === estimate.id)
// is excluded and keeps its deposit.
function hasJobLinkWithoutProvenance(e: { job_id: string | null; job: { id: string } | null }): boolean {
  return e.job_id != null && e.job_id !== e.job?.id;
}

// #2090 ruling 18 - the single refusal copy for "you are trying to send a document that is no
// longer the current one". Read by BOTH doors a rep can hit it from (the workspace's send and the
// list's bulk reminder) so the two cannot drift. User-visible copy: it reaches the UI verbatim
// through extractApiError, so it names no vendor, no account and no dashboard - just what
// happened and the one thing the rep can do about it.
const SUPERSEDED_NOT_SENDABLE = 'This estimate has been superseded - open the current revision and send that one instead.';

function depositOnAttachedEstimateMessage(estimateNumber: string, jobNumber?: string | null): string {
  const job = jobNumber ?? 'another job';
  return `Estimate ${estimateNumber} is attached to job ${job} but is not that job's estimate of record. A deposit taken here is credited against ${job}'s invoices, which are billed from that job's own line items and never from this estimate - so the deposit would be spent on work this estimate did not quote. Send it without a deposit.`;
}

// ─── Deposit invoice re-pricing (#2031 slice 5) ───────────────────────────────
//
// A deposit invoice is minted at send with its own payable public link. The estimate can move
// afterwards — §A3 leaves a materially-edited SENT estimate SENT, bumps its version and flags
// modified_after_send — and the deposit document does not follow it. Ran's decision is to
// RE-PRICE ON NEXT SEND rather than void: the customer keeps the link they were given, and the
// next send makes the figure behind it true again.
//
// The re-pricing used to live inline in commitFirstSend, which only runs on a DRAFT send. It is
// extracted here so the SENT→SENT resend branch — the ordinary path after an in-place edit —
// shares the EXACT same rule instead of growing a second one that can drift.

/** The one line a deposit invoice carries. Shared by the mint and the re-price so they agree. */
function depositLineItem(
  estimateNumber: string,
  dType: 'PERCENTAGE' | 'FIXED',
  depositAmount: number,
  depositPercent: number,
) {
  return {
    sequence: 1,
    description: dType === 'FIXED'
      ? `Deposit on ${estimateNumber}`
      : `Deposit — ${Math.round(depositPercent)}% of ${estimateNumber}`,
    quantity: 1,
    unit_price: depositAmount,
    is_taxable: false,
    line_total: depositAmount,
  };
}

// `_count.payments` is the belt to the status whitelist's braces. DRAFT/SENT is what "unpaid"
// means today — every writer that records money against an invoice (invoice.recordPayment,
// estimate.recordEstimatePayment, the Stripe webhook) flips the row to PARTIAL or PAID in the same
// transaction — but money ON THE ROW is the property that actually matters. A partially-paid
// deposit is NOT unpaid, and re-pricing one would rewrite amount_due straight over a customer's
// payment. Two independent reasons to refuse are cheap; one silent erasure is not.
const depositInvoiceSyncSelect = {
  id: true,
  invoice_number: true,
  status: true,
  total_amount: true,
  _count: { select: { payments: true } },
} as const;

// Derived from the select rather than hand-written, so a field the re-price reads but the query
// stops selecting is a COMPILE error instead of a silently-undefined guard input.
type DepositInvoiceForSync = Prisma.InvoiceGetPayload<{ select: typeof depositInvoiceSyncSelect }>;

/**
 * The estimate's deposit document, if it has one. Resolved INSIDE the caller's transaction — a
 * pre-transaction read would make the re-price a race against a payment landing.
 *
 * Deliberately NOT filtered to unpaid rows: this same lookup is the one-deposit-per-estimate
 * dedupe guard, and a filter that hid a PAID deposit would have the send mint a SECOND payable
 * deposit document for the same estimate.
 */
function findDepositInvoice(
  tx: Prisma.TransactionClient,
  req: Request,
  estimateId: string,
): Promise<DepositInvoiceForSync | null> {
  return tx.invoice.findFirst({
    where: { estimate_id: estimateId, kind: 'DEPOSIT', ...tenantWhere(req) },
    select: depositInvoiceSyncSelect,
  });
}

export type DepositRepriceResult =
  | { changed: true; invoiceId: string; invoiceNumber: string; from: number; to: number }
  | { changed: false; reason: 'SETTLED' | 'ALREADY_CURRENT' };

/**
 * Bring an UNPAID deposit invoice to the deposit the estimate's current inputs produce.
 *
 * Returns what it did so the caller can record it on the estimate's history. Refuses — with no
 * write at all — the moment the invoice is anything other than an untouched DRAFT/SENT row.
 */
export async function repriceUnpaidDepositInvoice(
  tx: Prisma.TransactionClient,
  estimateNumber: string,
  invoice: DepositInvoiceForSync,
  dType: 'PERCENTAGE' | 'FIXED',
  depositAmount: number,
  depositPercent: number,
): Promise<DepositRepriceResult> {
  const unpaidStatus = invoice.status === 'DRAFT' || invoice.status === 'SENT';
  const hasMoneyAgainstIt = (invoice._count?.payments ?? 0) > 0;
  if (!unpaidStatus || hasMoneyAgainstIt) {
    return { changed: false, reason: 'SETTLED' };
  }

  const from = round2(Number(invoice.total_amount));
  const to = round2(depositAmount);
  // The SAME predicate the public money door refuses on and the checkout-expiry guard fires on
  // (lib/estimates/deposit-amount.ts). "Would this send move the figure" is one question, and the
  // three answers must never differ. Compared at cents because that is the precision the column
  // holds — and the resolver already rounds, so the value written and the value compared are the
  // same value (F3: they were not, and 3% of totals re-priced on every single resend).
  if (!depositFigureWouldMove(invoice.total_amount, depositAmount)) {
    return { changed: false, reason: 'ALREADY_CURRENT' };
  }

  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      subtotal: depositAmount,
      total_amount: depositAmount,
      // Safe to overwrite rather than adjust: we are only here because nothing has been paid.
      amount_due: depositAmount,
      line_items: {
        deleteMany: {},
        create: [depositLineItem(estimateNumber, dType, depositAmount, depositPercent)],
      },
    },
  });

  return { changed: true, invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, from, to };
}

/**
 * Record a deposit re-price on the ESTIMATE's own history (getHistory reads auditLog scoped to
 * resource_type 'Estimate'), carrying the estimate state the new figure was minted from.
 *
 * `estimate_version` + `estimate_total` are the traceability: every send also mints an
 * EstimateVersionSnapshot for that version (mintEstimateVersion), so the amount on the deposit
 * invoice can always be read back to a frozen copy of the document it was calculated from.
 */
function logDepositReprice(
  req: Request,
  estimateId: string,
  result: Extract<DepositRepriceResult, { changed: true }>,
  estimateVersion: number,
  estimateTotal: number,
) {
  void logAudit({
    req,
    action: 'estimate.deposit_repriced',
    resourceType: 'Estimate',
    resourceId: estimateId,
    metadata: {
      invoice_id: result.invoiceId,
      invoice_number: result.invoiceNumber,
      from_amount: result.from,
      to_amount: result.to,
      estimate_version: estimateVersion,
      estimate_total: estimateTotal,
    },
  });
}

/**
 * #2090 slice A2 — PUBLISH the rep's recommendation onto the customer-facing document. The one
 * copy step, shared by EVERY send: `commitFirstSend` (send()'s first-send branch and markSent())
 * and `sendEstimateInternal`'s re-send branch both call this and merge what it returns into
 * their own `tx.estimate.update`, so the two can never grow separate rules.
 *
 * WHICH COLUMN MEANS WHAT. `rep_selected` is the SALESPERSON's recommendation — what they are
 * offering on each optional line/scope. `is_selected` is the LIVE answer on the document: it is
 * what the customer's public page renders, what their own tick writes, and what
 * `countsTowardTotals` filters the money on. A send is the moment the rep's recommendation
 * becomes the offer, so it is copied ACROSS, and the totals are recomputed from the result.
 *
 * Ran's ruling, 2026-09-19: "when an estimate is being resent, we can treat it as a new estimate
 * from the customer's perspective". So this runs on every send and OVERWRITES whatever the
 * customer had ticked — no mercy rule, no row-level diffing, no preservation of their answers.
 * The consequence, deliberately not solved here: a customer who ticked three add-ons and then
 * receives a re-send loses those three ticks, and the estimate total moves under them. That is
 * correct under the ruling — they are looking at a new document — and slice A5 makes it legible
 * by giving them a new link.
 *
 * A NULL `rep_selected` IS LEFT ALONE. Null means the rep never expressed a preference on that
 * row, so `is_selected` is already the right value for it and there is nothing to publish. The
 * line half gets that for free: `where: { rep_selected: true|false }` never matches NULL in
 * Postgres, so no read is needed to skip those rows. The scope half has to say it out loud,
 * because it is a key inside a JSONB array rather than a column.
 *
 * Read FRESH inside the transaction rather than off the caller's pre-transaction row: rewriting
 * the scopes column from a stale snapshot would silently drop a concurrent scope edit (the same
 * convention estimate-lines.controller.ts documents on every one of its own scope handlers).
 *
 * Returns `publishedTotal` as well as the write fragment, because the deposit has to follow the
 * document: every deposit figure on both send branches is resolved BEFORE the transaction, from
 * the total as it stood before the publish, and a deposit priced against that figure asks the
 * customer for money the document no longer says.
 *
 * `publishedTotal` is null WHENEVER THE PUBLISH MOVED NOTHING, and that is the whole contract:
 * "the total this publish moved the document to, or null if it moved none". A send whose rows
 * carry no recommendation worth acting on is a no-op, and a no-op must not restate the totals
 * columns or re-resolve a deposit - A2 may only move money that A2 itself moved. The totals write
 * is gated on the same answer, so a caller can never price a deposit off a figure the document
 * did not take.
 */
async function publishRepRecommendation(
  tx: Prisma.TransactionClient,
  estimateId: string,
): Promise<{ data: Prisma.EstimateUpdateInput; publishedTotal: number | null }> {
  const fresh = await tx.estimate.findUnique({
    where: { id: estimateId },
    select: {
      scopes: true,
      tax_rate: true,
      discount_type: true,
      discount_value: true,
      line_items: {
        select: {
          quantity: true, unit_price: true, is_taxable: true,
          discount_type: true, discount_value: true,
          is_optional: true, is_selected: true, rep_selected: true,
        },
      },
    },
  });

  const storedScopes = asScopeArray(fresh?.scopes);
  const publishedScopes = storedScopes.map((sc) => (
    sc.rep_selected == null ? sc : { ...sc, is_selected: sc.rep_selected }
  ));

  const data: Prisma.EstimateUpdateInput = {
    // Written as a whole new array: `scopes` is a raw JSONB column with no row per block. Nothing
    // is written at all when the estimate has no scopes, so an untouched column stays untouched.
    ...(storedScopes.length > 0
      ? { scopes: publishedScopes as unknown as Prisma.InputJsonValue }
      : {}),
    // The line half is a nested relation updateMany, two statements because the source IS the
    // predicate; no read, and the relation scopes the `where` to this estimate's own rows.
    line_items: {
      updateMany: [
        { where: { rep_selected: true }, data: { is_selected: true } },
        { where: { rep_selected: false }, data: { is_selected: false } },
      ],
    },
  };

  // `is_selected` feeds `countsTowardTotals`, so publishing a different selection moves subtotal,
  // tax and total.
  //
  // No lines read back means there is nothing to price — an estimate with zero line items is
  // refused at send time ('Add at least one line item before sending'), so the only way here is a
  // row that did not resolve. Leaving the totals columns alone is the safe answer; recomputing
  // from an empty set would persist a zero.
  const lines = fresh?.line_items;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { data, publishedTotal: null };
  }

  // Both totals off the SAME read, so the difference between them is the publish and nothing
  // else. Priced against the stored `total_amount` instead, an unrelated drift between the
  // column and the rows would look like a move this slice made, and A2 would re-price a deposit
  // for a reason that has nothing to do with the rep's recommendation.
  const publishedLines = lines.map((l) => ({ ...l, is_selected: l.rep_selected ?? l.is_selected }));
  const published = recomputeEstimateTotals(publishedLines as never[], fresh as never, publishedScopes);
  const current = recomputeEstimateTotals(lines as never[], fresh as never, storedScopes);

  if (round2(published.totalAmount) === round2(current.totalAmount)) {
    return { data, publishedTotal: null };
  }

  data.subtotal = published.subtotal;
  data.tax_amount = published.taxAmount;
  data.total_amount = published.totalAmount;
  data.discount_amount = published.estimateDiscountAmount;

  return { data, publishedTotal: published.totalAmount };
}

/**
 * Everything `publishRepRecommendation` can write, as the send's own read supplies it. `line_items`
 * is optional because a narrowed fixture may not project it; an absent list simply has no line
 * selection to put back.
 */
type PrePublishSnapshot = {
  subtotal: Prisma.Decimal; tax_amount: Prisma.Decimal;
  total_amount: Prisma.Decimal; discount_amount: Prisma.Decimal;
  scopes?: unknown;
  line_items?: { id: string; is_selected: boolean }[] | null;
};

/**
 * A5 — publish the rep's recommendation onto the stored row so the PDF renderer and the email can
 * READ it, and hand back the exact inverse so a failed dispatch can put it back.
 *
 * `renderEstimatePdfBuffer` (lib/email.ts) re-reads the estimate through `estimateDocumentSelect`,
 * so the only way the attached PDF can print the figure the send produces — with its optional rows
 * marked consistently with the money beneath them — is for the row to be published before it runs.
 * That is a write before an irreversible step, so it owes an undo.
 *
 * The undo is exact rather than clever: it restores the four totals columns, the whole `scopes`
 * JSONB and every line's `is_selected`. Those are the only fields `publishRepRecommendation`
 * writes, and the undo is the SAME SHAPE as the do — one `estimate.update` carrying a nested
 * `line_items.updateMany` pair, so it is atomic without a `$transaction` of its own and stays two
 * statements whatever the document's size.
 *
 * Not using `$transaction` here is deliberate, not incidental. `sendEstimateInternal`'s
 * reliability contract is that the COMMIT is the only transaction the handler runs — that is how
 * `estimate-send-reliability.test.ts` proves a failed send never marked anything SENT. An undo
 * that opened a second transaction would make that proof unreadable for the sake of atomicity a
 * nested write already provides.
 *
 * `before` is PASSED IN, off the row `sendEstimateInternal` has already loaded, and is not re-read
 * here. That is deliberate: it adds NO ADDITIONAL READ OF THE ESTIMATE ROW — the caller's select
 * was widened instead, which costs nothing at the client — and re-reading would also break every
 * existing send test that stubs that delegate with a hand-built fixture. The cost is that the
 * snapshot is taken a few statements earlier in the same request than the publish's own internal
 * read: a window the send already lives with, since every other decision it makes is read off that
 * same row.
 *
 * Be accurate about the rest of the bill, though, because it is not zero. Moving the publish out
 * of the commit transaction MOVES a read and a write to the top level rather than removing them:
 * on an unchanged re-send, top-level `estimate.findUnique` goes 2 -> 3 (the third is
 * `publishRepRecommendation`'s own) and top-level `estimate.update` 0 -> 1, plus one more when a
 * rollback fires. The transaction does correspondingly less. What is genuinely free is the
 * snapshot.
 *
 * The publish write is UNCONDITIONAL, and deliberately so: `publishRepRecommendation` always
 * returns a `line_items.updateMany` pair, so any `Object.keys(data).length` test would read like a
 * gate while always being true. Re-deriving a real gate here would mean duplicating that
 * function's own no-op reasoning and risking divergence from it — and a gate that wrongly said
 * "nothing to do" would put the pre-publish figure back in the email. So it always writes, and
 * the cost is one extra idempotent statement per send (plus a `scopes` rewrite on a document that
 * has scope blocks); the rollback above is what makes that safe rather than merely harmless.
 */
async function publishForDispatch(
  estimateId: string,
  before: PrePublishSnapshot,
): Promise<{ publishedTotal: number | null; rollback: () => Promise<void> }> {
  // MATERIALISE the snapshot BEFORE anything is written. `before` is the live row the caller
  // loaded, not a copy, so reading it after the publish would be reading the state we are trying
  // to be able to undo.
  const lines = before.line_items ?? [];
  const wasSelected = lines.filter((l) => l.is_selected).map((l) => l.id);
  const wasUnselected = lines.filter((l) => !l.is_selected).map((l) => l.id);
  const totals = {
    subtotal: before.subtotal,
    tax_amount: before.tax_amount,
    total_amount: before.total_amount,
    discount_amount: before.discount_amount,
  };
  // A JSONB column reads back as null when no scope has ever been added, and the publish leaves an
  // empty column untouched — so there is nothing to put back for those rows.
  const scopes = before.scopes != null ? (before.scopes as Prisma.InputJsonValue) : undefined;

  const publish = await publishRepRecommendation(prisma, estimateId);
  await prisma.estimate.update({ where: { id: estimateId }, data: publish.data });

  return {
    publishedTotal: publish.publishedTotal,
    rollback: async () => {
      try {
        const restoreSelection = [
          ...(wasSelected.length > 0
            ? [{ where: { id: { in: wasSelected } }, data: { is_selected: true } }]
            : []),
          ...(wasUnselected.length > 0
            ? [{ where: { id: { in: wasUnselected } }, data: { is_selected: false } }]
            : []),
        ];
        await prisma.estimate.update({
          where: { id: estimateId },
          data: {
            ...totals,
            ...(scopes !== undefined ? { scopes } : {}),
            ...(restoreSelection.length > 0 ? { line_items: { updateMany: restoreSelection } } : {}),
          },
        });
      } catch (err) {
        // Loudly, and without masking the dispatch failure the caller is already returning: the
        // send has failed either way, but a document left published is a state someone must know
        // about.
        logger.error(`Failed to roll back the pre-dispatch publish for estimate ${estimateId}:`, err);
      }
    },
  };
}

// Extracted from send()'s first-send branch (R4, 2026-07-21) so markSent() can share it exactly —
// deposit invoice + send_config + T&C snapshot + lead auto-transition are the same regardless of
// whether the customer was emailed or told the price out loud. Only the caller differs: send()
// runs this AFTER confirming the email actually went out; markSent() runs it with no email step.
async function commitFirstSend(
  tx: Prisma.TransactionClient,
  req: Request,
  existing: {
    id: string; estimate_number: string; lead_id: string | null; customer_id: string;
    // A2 — the estimate's own deposit override, so the figure can be re-resolved from the total
    // the publish produces. Both callers already select these.
    deposit_type?: 'PERCENTAGE' | 'FIXED' | null; deposit_value?: unknown;
    lead?: { status?: LeadStatus | null; customer?: { id: string } | null } | null;
  },
  org: { estimate_terms: string | null; estimate_notes: string | null; estimate_payment_terms: string | null }
    & DepositOrgDefaults,
  body: { deposit_required: boolean; payment_methods: string[]; message_body?: string },
  publicToken: string,
  validUntil: Date,
  // The deposit as resolved BEFORE the transaction, from the total as it stood before the publish.
  // Nothing below spends these directly — see the re-resolution at the top of the body. They are
  // the fallback for the one case where the publish produced no total to re-resolve from.
  preDType: 'PERCENTAGE' | 'FIXED',
  preDepositAmount: number,
  preDepositPercent: number,
  // D8/D9 (Walkthrough-as-entity redesign, PR-B2): silent instrumentation replacing the removed
  // require_walkthrough_before_send gate - see send()/markSent() for how this is computed.
  walkthrough: WalkthroughCompletionSnapshot,
  // #2031 slice 5 — out-parameter for what the deposit re-price did, so the caller can file it on
  // the estimate's history AFTER the transaction commits. An out-parameter rather than a widened
  // return type because this function's return value IS the send response body.
  // A2 widened it: `publishedTotal` is the total the publish produced, which is the estimate
  // state any deposit figure minted below was actually calculated from.
  outcome?: { depositReprice?: DepositRepriceResult; publishedTotal?: number },
) {
  // A2 — publish the rep's recommendation onto the document the customer is about to open. All
  // of the reasoning (why the copy runs this way round, why a null is left alone, why a re-send
  // overwrites the customer's ticks) lives on `publishRepRecommendation`; this call site only
  // decides WHEN. Here that is the DRAFT-to-SENT transition, which is all this function ever runs
  // on — both callers are DRAFT-gated. The re-send branch of `sendEstimateInternal` calls the
  // same helper, so send(), markSent() and a re-send cannot drift apart.
  const publish = await publishRepRecommendation(tx, existing.id);
  if (outcome) outcome.publishedTotal = publish.publishedTotal ?? undefined;

  // THE ORDERING THAT MATTERS, and it is the same expression the re-send branch uses at its own
  // call site. The deposit reached this function already resolved, from `existing.total_amount` —
  // the total BEFORE the publish. When the publish moves that total, every figure below has to
  // follow it: the deposit invoice is money the customer is asked for against the document they
  // are about to open, the send_config figure is what every deposit surface reads, and the
  // DEPOSIT_REQUESTED timeline line is copy that states a percentage — a stale amount beside a
  // live percentage is a sentence claiming a number it does not satisfy.
  //
  // A null `publishedTotal` means the publish moved nothing, so the pre-publish resolution is
  // still the right answer and no deposit is touched on account of this slice.
  const { dType, depositAmount, depositPercent } = publish.publishedTotal == null
    ? { dType: preDType, depositAmount: preDepositAmount, depositPercent: preDepositPercent }
    : resolveDepositAmount(
      {
        deposit_type: existing.deposit_type ?? null,
        deposit_value: existing.deposit_value ?? null,
        total_amount: publish.publishedTotal,
      },
      org,
    );

  const updated = await tx.estimate.update({
    where: { id: existing.id },
    data: {
      status: 'SENT',
      sent_at: new Date(),
      public_token: publicToken,
      valid_until: validUntil,
      snapshot_terms: org.estimate_terms ?? null,
      snapshot_notes: org.estimate_notes ?? null,
      snapshot_payment_terms: org.estimate_payment_terms ?? null,
      // Published as part of the very write that flips the status to SENT, so the two can never
      // come apart, and so the `select` below reads the document back AS THE CUSTOMER WILL SEE
      // IT — which is what the send response is built from.
      ...publish.data,
    },
    select: estimateDetailSelect,
  });

  // Spec #1751 D2: the headline metric's closing edge - "the walkthrough is done, how long before
  // the salesperson sent the estimate". First touch wins, so the SECOND estimate on the same lead
  // leaves it alone; the owner asks this question once per lead, not once per document.
  //
  // Only here, never on the resend path. A resend of an estimate that went out before this column
  // existed would otherwise stamp it with today's date and report an instant turnaround on a lead
  // that in fact waited months. Historical rows are D10's backfill to fill, from the estimate's
  // own sent_at.
  if (existing.lead_id) {
    await stampLeadClock(tx, existing.lead_id, req.user!.organization_id, 'first_estimate_sent_at', new Date());
    if ((tx as any).notificationRecipient?.updateMany) {
      await (tx as any).notificationRecipient.updateMany({
        where: {
          organization_id: req.user!.organization_id,
          notification: {
            verb: 'spider.alert',
            object_id: existing.lead_id,
          },
          read_at: null,
        },
        data: { read_at: new Date() },
      });
    }
  }

  // Upsert send config — keyed on the @unique estimate_id so a resend after revise()
  // (which recalls to DRAFT but LEAVES the row) is idempotent and re-snapshots the
  // possibly-changed deposit terms, instead of colliding on the unique (P2002) and 500ing.
  await tx.estimateSendConfig.upsert({
    where: { estimate_id: existing.id },
    create: {
      estimate_id: existing.id,
      deposit_required: body.deposit_required,
      deposit_percentage: depositPercent,
      deposit_amount: depositAmount,
      payment_methods: body.payment_methods,
      message_body: body.message_body,
    },
    update: {
      deposit_required: body.deposit_required,
      deposit_percentage: depositPercent,
      deposit_amount: depositAmount,
      payment_methods: body.payment_methods,
      message_body: body.message_body,
    },
  });

  // Create the kind=DEPOSIT Invoice if a deposit is required. The Invoice is now the SOLE
  // source of truth for the deposit (the legacy Deposit model was dropped in Phase D).
  // job_id is nullable, so the deposit Invoice persists with no job; its id is the valid FK
  // target for the deposit-credit ledger (DepositCreditApplication.deposit_invoice_id). It is
  // created SENT + with a public_token so it has its own public payment surface
  // (invoice getPublic/createPublicCheckout), replacing the old Deposit.stripe_payment_link_url.
  if (body.deposit_required) {
    // One kind=DEPOSIT invoice per estimate (app guard; DB partial-unique is Phase D).
    const existingDepositInvoice = await findDepositInvoice(tx, req, existing.id);
    if (!existingDepositInvoice) {
      // SERV10X-61 - the deposit customer is the estimate's own denormalized customer_id (R6,
      // NOT-NULL on every estimate), so this works for a lead-less customer-anchored estimate too.
      const depositCustomerId = existing.customer_id;
      const depositInvoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);
      await tx.invoice.create({
        data: {
          invoice_number: depositInvoiceNumber,
          organization_id: req.user!.organization_id,
          job_id: null,
          kind: 'DEPOSIT',
          estimate_id: existing.id,
          customer_id: depositCustomerId,
          // Phase 2c — SENT (payable) + a public_token so the deposit invoice has its own public
          // payment surface (getPublic + createPublicCheckout), replacing Deposit.stripe_payment_link_url.
          status: 'SENT',
          public_token: randomUUID(),
          subtotal: depositAmount,
          discount_amount: 0,
          tax_rate: 0,
          tax_amount: 0,
          deposit_credit: 0,
          total_amount: depositAmount,
          amount_due: depositAmount,
          line_items: {
            create: [depositLineItem(existing.estimate_number, dType, depositAmount, depositPercent)],
          },
          // Audit: the user who sent the estimate with a deposit attached. The deposit invoice is
          // part of what they chose to do, so it is USER - unlike a plan invoice, nothing mints it
          // on a schedule. The re-price branch below UPDATES this row and deliberately does not
          // restamp: the creator is written once and never changes.
          ...createdByUser(req),
        },
      });
    } else {
      // Back-to-draft (#2031 slice 4) or revise() then send again: the total may have moved since
      // the deposit was minted. Keep the existing UNPAID deposit invoice in lockstep with the
      // re-snapshotted send_config so the customer never pays a superseded figure. Anything with
      // money against it is refused inside the helper, never here.
      const repriced = await repriceUnpaidDepositInvoice(
        tx, existing.estimate_number, existingDepositInvoice, dType, depositAmount, depositPercent,
      );
      if (outcome) outcome.depositReprice = repriced;
    }

    await tx.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'ESTIMATE',
        entity_id: existing.id,
        event_type: 'DEPOSIT_REQUESTED',
        description: dType === 'FIXED'
          ? `Deposit of $${depositAmount.toFixed(2)} requested`
          : `Deposit of $${depositAmount.toFixed(2)} requested (${depositPercent}%)`,
        created_by: req.user!.id,
      },
    });
  }

  // SENT timeline event. D9: metadata carries the silent walkthrough-completed instrumentation
  // that replaces the removed require_walkthrough_before_send gate.
  await tx.timelineEvent.create({
    data: {
      organization_id: req.user!.organization_id,
      entity_type: 'ESTIMATE',
      entity_id: existing.id,
      event_type: 'SENT',
      description: `Estimate ${existing.estimate_number} sent to customer`,
      metadata: {
        walkthrough_completed: walkthrough.completed,
        // The interval an owner actually polices: this instant to the event's own created_at.
        // Snapshotted here so a later visit can never rewrite what this send was measured against.
        walkthrough_completed_at: walkthrough.completedAt?.toISOString() ?? null,
      },
      created_by: req.user!.id,
    },
  });

  // Auto-transition lead to ESTIMATED if applicable (only when the estimate has a lead).
  // Spec #1751 D6 — through the one writer, which now supplies the ledger entry this used to
  // hand-roll. The entry gains `from` and `to`, which the hand-rolled one did not carry, so the
  // "how long was this lead in CONTACTED" question becomes answerable from it.
  //
  // `onlyFrom` is the four early statuses (New, Contacted, Walkthrough Scheduled, Walkthrough
  // Completed): a lead whose walkthrough is booked or done is still before the estimate, and
  // would otherwise never reach Estimate Sent. An estimate sent on a lead already ESTIMATED (a
  // second document) must not restate the status, and one sent on a WON lead must certainly not
  // pull it backward, so those stay outside the set.
  if (updated.lead_id) {
    const leadStatus = existing.lead?.status;
    const shouldTransitionLead = leadStatus != null && WALKTHROUGH_DRIVEN_FROM_STATUSES.includes(leadStatus);
    if (shouldTransitionLead) {
      await transitionLeadStatus(tx, {
        leadId: updated.lead_id,
        orgId: req.user!.organization_id,
        to: 'ESTIMATED',
        from: leadStatus,
        actorId: req.user!.id,
        notFrom: [],
        onlyFrom: WALKTHROUGH_DRIVEN_FROM_STATUSES,
        description: `Lead transitioned to ${LEAD_STATUS_LABEL.ESTIMATED} — estimate ${existing.estimate_number} sent`,
        metadata: { estimate_id: updated.id, estimate_number: existing.estimate_number, via: 'estimate_sent' },
      });
    }
  }

  return updated;
}

// Extracted from send() so bulkSendReminders() (list-level bulk reminder, Estimates list page)
// can share the EXACT same guard/PREP/EMAIL/COMMIT sequence without duplicating it. Returns a
// result instead of writing to `res` directly - send() and bulkSendReminders() each translate
// that result into their own response shape. Same pattern as deleteEstimateInternal/bulkRemove.
//
// WATCH: send() used to respond THEN schedule the version-snapshot fire-and-forget IIFE. After
// extraction the IIFE is scheduled here, before the wrapper below responds - behaviourally
// equivalent (still fire-and-forget, still after the awaited commit), just re-ordered relative to
// the HTTP response boundary.
async function sendEstimateInternal(
  req: Request,
  id: string,
  body: z.infer<typeof sendEstimateSchema>,
): Promise<{ ok: true; estimate: unknown } | { ok: false; status: number; error: string }> {
  const existing = await prisma.estimate.findUnique({
    where: { id, ...tenantWhere(req) },
    select: {
      id: true, status: true, estimate_number: true, total_amount: true, lead_id: true,
      public_token: true, valid_until: true, modified_after_send: true, version: true,
      deposit_type: true, deposit_value: true, // B8/PRD §13.7 — the estimate's own deposit override, if set
      created_by: true,
      // A5 — the undo for the pre-dispatch publish (`publishForDispatch`). Widened onto the one
      // row this function already loads rather than fetched separately, so it costs no extra read:
      // everything the publish can write, so a send that fails can put every one of them back.
      subtotal: true, tax_amount: true, discount_amount: true, scopes: true,
      line_items: { select: { id: true, is_selected: true } },
      // SERV10X-61 - a customer-anchored estimate has no lead; the customer is reached via the
      // estimate's own denormalized customer_id (R6, NOT-NULL) + direct customer relation.
      customer_id: true,
      // #2041 — CUSTOMER_PROOF_SELECT merged in so the client-recipient gate below can judge
      // readability synchronously off this already-loaded row (no extra query).
      customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true, ...CUSTOMER_PROOF_SELECT } },
      _count: { select: { line_items: true } },
      lead: { select: { lead_assignees: { select: { user_id: true } }, status: true, customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true, ...CUSTOMER_PROOF_SELECT } } } },
      send_config: { select: { id: true } },
      // SRVW-96 - the R6 attachment plus its provenance back-relation, so a deposit-required
      // send can be refused on a job-anchored estimate that is not that job's estimate of record.
      job_id: true,
      job: { select: { id: true } },
      job_link: { select: { job_number: true } },
    },
  });

  if (!existing) {
    return { ok: false, status: 404, error: 'Estimate not found' };
  }

  // D11 (2026-07-21) — Send never disappears: every status can be (re)sent. DRAFT is the only
  // true first send (quotes deposit terms, creates the deposit invoice); everything else is a
  // resend of the same document. PENDING keeps its status (mirrors the existing SENT resend);
  // a terminal status's resend is presented to staff as "Send a copy" and skips the SENT
  // timeline entry below the transaction, so the estimate's history doesn't misleadingly
  // suggest it went back into active negotiation.
  if (!(await canAccessEstimate(existing, req))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }

  // #2090 ruling 18 - a SUPERSEDED estimate is not a document that can go out. Its public link
  // was retired the moment revise() froze it (REVOKE_PUBLIC_LINK), and the mint below
  // (`existing.public_token ?? randomUUID()`) would hand it a brand-new live URL at the old
  // prices. This gate sits with the other content guards, BEFORE the token is minted and before
  // anything irreversible. The four other terminal statuses are untouched: they keep their own
  // token and "Send a copy" goes on working for them. The successor's number is deliberately NOT
  // named - `superseded_by_id` is not on this read, and this refusal is not worth a second query.
  if (existing.status === 'SUPERSEDED') {
    return { ok: false, status: 400, error: SUPERSEDED_NOT_SENDABLE };
  }

  // SERV10X-61 §5.6 - the ≥1-line-item invariant lives at send time (create/update allow empty
  // eager drafts). A scope-only estimate is not sendable - a real quote needs a line item.
  if ((existing._count?.line_items ?? 0) === 0) {
    return { ok: false, status: 400, error: 'Add at least one line item before sending' };
  }

  // D8/D9 (Walkthrough-as-entity redesign, PR-B2): the `require_walkthrough_before_send`
  // AppSetting gate is REMOVED entirely - it was read here and nowhere else, written by NO
  // code path anywhere (no settings UI ever existed for it), so it enforced nothing. Replaced
  // with silent instrumentation: record on the SENT timeline event whether a COMPLETED visit
  // existed for this lead at send time. No modal, no block, invisible to the user - the data
  // point is for later analysis ("how often do reps estimate without visiting, and do those
  // close worse"), not enforcement.
  const walkthrough = await walkthroughCompletionSnapshot(req, existing.lead_id);

  // Read estimate validity days from AppSetting
  const validDaysSetting = await prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: req.user!.organization_id, key: 'estimate_validity_days' } } });
  const validDays = parseInt(validDaysSetting?.value ?? '30', 10);

  const isFirstSend = existing.status === 'DRAFT';
  // D11 — a resend of an already-decided estimate (won/declined/archived/expired/superseded) is
  // "send a copy": the document goes out again, but nothing about the estimate's own history
  // should read as if it were freshly quoted or re-entered negotiation.
  const isTerminalSend = [ESTIMATE_STATUS.WON, 'DECLINED', ESTIMATE_STATUS.ARCHIVED, 'EXPIRED', 'SUPERSEDED'].includes(existing.status);

  // SRVW-96 - a first send is the only send that can mint a deposit invoice (commitFirstSend);
  // a resend must not start 400ing on a client that echoes deposit_required:true.
  if (isFirstSend && body.deposit_required && hasJobLinkWithoutProvenance(existing)) {
    return { ok: false, status: 400, error: depositOnAttachedEstimateMessage(existing.estimate_number, existing.job_link?.job_number) };
  }

  // ── PREP (phase 1): resolve the recipient BEFORE anything irreversible ──────────────
  // The reported bug (Lakeside): the estimate was flipped to SENT and the client told "Sent" while
  // the email never left the system. We now refuse to send — and never mark SENT — if there is
  // no deliverable address, and (below) only commit the SENT transition once the email is
  // confirmed dispatched.
  // SERV10X-61 - a lead-anchored estimate reaches its customer through the lead; a customer-
  // anchored (lead-less) estimate reaches it through the estimate's own direct customer relation.
  const customer = existing.lead?.customer ?? existing.customer;
  // #1997 round 2 — a client-supplied recipient (the editable "To"/CC) is a direct bypass of the
  // round-1 redaction: the send dialog omits these fields when the customer is redacted (slice 1),
  // but nothing stopped a requester from posting them anyway. Same per-row check the presenter
  // uses (`isCustomerReadableRow`), never a role name. #2041: was `can(req,'read','Customer',…)`
  // — @casl/prisma throws on OWN_CUSTOMER's nested to-one -> to-many arms.
  const hasClientRecipient = body.recipient_override !== undefined || (body.cc_emails?.length ?? 0) > 0;
  if (hasClientRecipient && (!customer || !isCustomerReadableRow(req, customer))) {
    return { ok: false, status: 403, error: "You can send this to the customer's saved address only." };
  }
  // One-off recipient override (editable "To") takes precedence over the saved customer email.
  const recipientEmail = body.recipient_override ?? customer?.email;
  if (!customer || !recipientEmail) {
    return { ok: false, status: 422, error: 'No email address on file for this customer. Add an email before sending the estimate.' };
  }

  // Snapshot org T&C at send time so the PDF is legally reproducible, and read the deposit
  // default columns (#61). Loaded once here and reused for both the deposit math and the email
  // branding. Every authenticated request has a valid org in prod; a missing row is a 500.
  const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id } });
  if (!org) {
    return { ok: false, status: 500, error: 'Organization not configured.' };
  }

  // Token is minted (or reused) up-front so the public link is identical across email + commit.
  const publicToken = existing.public_token ?? randomUUID();
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + validDays);


  // What the deposit re-price did, read post-commit to file it on the estimate's history.
  // Declared out here (not inside the transaction callback) so withNumberCollisionRetry's retry
  // cannot leave a rolled-back attempt's verdict standing — the callback resets it on entry.
  // `publishedTotal` is the total the publish produced INSIDE the transaction. Carried back out
  // for the same reason `depositReprice` is: the history entry below has to name the estimate
  // state the new deposit figure was actually minted from, and after A2 that is no longer
  // `existing.total_amount`.
  const sendOutcome: { depositReprice?: DepositRepriceResult; publishedTotal?: number } = {};

  if (isFirstSend) {
    // Persist token + T&C snapshots via a PLAIN update (NOT a $transaction) so the PDF render —
    // which reads snapshot_* off the estimate row — reflects this send. Keeping $transaction
    // exclusive to the commit phase is what lets the SENT transition be gated on the email.
    await prisma.estimate.update({
      where: { id: existing.id },
      data: {
        public_token: publicToken,
        valid_until: validUntil,
        snapshot_terms: org.estimate_terms ?? null,
        snapshot_notes: org.estimate_notes ?? null,
        snapshot_payment_terms: org.estimate_payment_terms ?? null,
      },
    });
  }

  // A5, folding in Ran's A2 ruling — PUBLISH HERE: after every other PREP write, immediately
  // before the PDF is rendered and the email composed, and not inside the commit transaction.
  //
  // Since A2 a send MOVES the total: it publishes the rep's recommendation over whatever the
  // customer had ticked. The email quoted `existing.total_amount`, and `renderEstimatePdfBuffer`
  // re-reads the estimate row — so with the publish landing after both, the customer was mailed
  // one figure and their link opened on another. A5 is the slice that rewrites this path to carry
  // a new link, and the email is what carries them back to the document, so the two must agree.
  // Passing a bare total to the renderer would not have been enough: publishing also decides which
  // optional rows print as chosen and which as declined, so only a published ROW renders a
  // document that reconciles.
  //
  // Which is why this is `publishForDispatch` and not a bare write: the publish is undone on the
  // failure path below. A send that fails must leave the document exactly as it was — the customer
  // holds an un-rotated link, and a document that moved underneath it while the rep was told the
  // send failed is the precise state Ran's ruling exists to forbid.
  //
  // And why it sits BELOW the first-send token/T&C write rather than above it, which is where it
  // first went. That write is the only statement that used to separate the publish from the
  // dispatch, it is not wrapped in anything, and an uncaught throw from it would have returned 500
  // with the document published and no rollback run. Ordering removes the window instead of
  // catching it: from here to the email there is now no write at all, so there is no failure left
  // that can strand a publish. Nothing here depends on the ordering being the other way round —
  // the token write reads none of `documentTotal`, `dType` or `depositAmount`.
  //
  // The one remaining coupling, named so it stays visible: `sendEstimateEmail` /
  // `sendEstimateWithDepositEmail` both wrap their whole body in try/catch and RETURN a failure
  // result rather than throwing. The rollback below hangs off that returned result. If either
  // sender ever starts throwing instead, this path would strand a publish again.
  //
  // The in-transaction `publishRepRecommendation` on both commit branches is untouched: publishing
  // is idempotent, so it re-reads these rows, finds the published selection already standing and
  // reports no move, and `depositAmount`/`preDepositAmount` — resolved below from the published
  // figure — are what each branch then falls back to.
  const dispatch = await publishForDispatch(existing.id, existing);
  /** The figure the document now carries — what the email, the PDF, the invoice and the page all quote. */
  const documentTotal = dispatch.publishedTotal ?? Number(existing.total_amount);

  // #61/B8: type-aware deposit calculation — prefers the estimate's own deposit_type/deposit_value
  // override (Receipt Card) over the org defaults; see resolveDepositAmount (PRD §13.7).
  //
  // #2031 slice 5 — resolved on EVERY send, not only the first. A resend is the moment an unpaid
  // deposit invoice is brought back in line with the estimate, and it needs the same figure the
  // first send would have produced from the CURRENT total.
  // A5 — resolved from `documentTotal` (the PUBLISHED figure), not `existing.total_amount`,
  // so the deposit the customer is asked for matches the document their link opens on.
  const { dType, depositAmount, depositPercent } = resolveDepositAmount(
    { deposit_type: existing.deposit_type, deposit_value: existing.deposit_value, total_amount: documentTotal },
    org,
  );

  // ── EMAIL (phase 2): render the PDF + AWAIT the send. Do NOT mark SENT unless it goes out. ──
  const orgBranding = { id: org.id, name: org.name, logo_url: org.logo_url, brand_color: org.brand_color };
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Customer';
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  const publicUrl = `${env.FRONTEND_URL}/p/estimates/${existing.id}?token=${publicToken}`;

  const emailResult: EmailDispatchResult = (isFirstSend && body.deposit_required)
    ? await sendEstimateWithDepositEmail({
        estimateId: existing.id,
        org: orgBranding,
        to: recipientEmail,
        cc: body.cc_emails,
        message: body.message_body,
        customerName,
        estimateNumber: existing.estimate_number,
        total: fmt(documentTotal),
        depositAmount: fmt(depositAmount),
        depositPercentage: dType === 'FIXED' ? 0 : depositPercent,
        publicUrl,
        // Attach-by-origin: estimate-time sends have no job yet — customer/lead only.
        record: {
          organizationId: req.user!.organization_id, customerId: customer.id, leadId: existing.lead_id,
          // The reply anchor: every send about THIS estimate, and the customer's
          // reply to any of them, resolve to one address and one conversation.
          entityType: 'estimate', entityId: existing.id,
        },
      })
    : await sendEstimateEmail({
        estimateId: existing.id,
        org: orgBranding,
        to: recipientEmail,
        cc: body.cc_emails,
        message: body.message_body,
        customerName,
        estimateNumber: existing.estimate_number,
        total: fmt(documentTotal),
        publicUrl,
        record: {
          organizationId: req.user!.organization_id, customerId: customer.id, leadId: existing.lead_id,
          // The reply anchor: every send about THIS estimate, and the customer's
          // reply to any of them, resolve to one address and one conversation.
          entityType: 'estimate', entityId: existing.id,
        },
      });

  if (emailResult.status !== 'sent') {
    // A5 — nothing went out, so nothing may have moved. This is the undo that justifies publishing
    // before the dispatch at all; without it a bounced re-send would leave the customer's live
    // link opening on a document they were never sent.
    await dispatch.rollback();
    const { code, message } = mapEmailFailure(emailResult);
    return { ok: false, status: code, error: message };
  }

  // ── COMMIT (phase 3): email confirmed sent — flip the status + write the ledger ──────
  const estimate = await withNumberCollisionRetry(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Retry-safety: withNumberCollisionRetry may run this callback more than once, and a
    // rolled-back attempt's verdict must never reach the post-commit history write.
    sendOutcome.depositReprice = undefined;
    sendOutcome.publishedTotal = undefined;

    if (isFirstSend) {
      return await commitFirstSend(tx, req, existing, org, body, publicToken, validUntil, dType, depositAmount, depositPercent, walkthrough, sendOutcome);
    } else {
      // ── Resend: SENT → SENT ──
      // #2031 slice 5 — THE money step on this branch. §A3 lets a SENT estimate be edited in
      // place: the version bumps, the customer's estimate link is invalidated and
      // modified_after_send is raised, but the deposit invoice minted at the first send keeps its
      // own live public_token and stays payable at the amount the old total produced. Re-sending
      // is the moment the customer is handed a current document, so it is the moment the deposit
      // behind their link stops being a superseded figure.
      //
      // Ran's decision is re-price, never void — the customer keeps the link they already have.
      // Deliberately NOT gated on body.deposit_required: that flag is a first-send decision this
      // branch already ignores, and an unpaid deposit document that exists must be honest
      // regardless of what the client happened to echo.
      // A2 — the publish runs FIRST on this branch, and its total is what the deposit follows.
      // The same helper `commitFirstSend` calls, so a re-send and a first send publish identically.
      const publish = await publishRepRecommendation(tx, existing.id);
      sendOutcome.publishedTotal = publish.publishedTotal ?? undefined;

      // THE ORDERING THAT MATTERS. `dType`/`depositAmount`/`depositPercent` above were resolved
      // BEFORE the transaction, from `existing.total_amount` — the total as the customer's own
      // ticks had left it. The publish has just replaced those ticks with the rep's
      // recommendation, so the figure on the document has moved and the deposit has to be
      // re-resolved from the PUBLISHED total, not the pre-publish one. Priced off the stale
      // figure, a re-send that lowers the offer would leave the customer's deposit link asking
      // for money against an offer that no longer exists — and `depositFigureWouldMove` would
      // short-circuit as ALREADY_CURRENT, so it would not even be visible as a wrong write.
      //
      // Same shape as the customer's own selection door (`applyCustomerSelections`), which
      // re-resolves from the total its write produced for exactly this reason. A null
      // `publishedTotal` means the publish moved nothing, so the pre-publish resolution still
      // stands and no deposit is touched on account of this slice.
      const published = publish.publishedTotal == null
        ? { dType, depositAmount, depositPercent }
        : resolveDepositAmount(
          { deposit_type: existing.deposit_type, deposit_value: existing.deposit_value, total_amount: publish.publishedTotal },
          org,
        );

      const depositInvoice = await findDepositInvoice(tx, req, existing.id);
      if (depositInvoice) {
        sendOutcome.depositReprice = await repriceUnpaidDepositInvoice(
          tx, existing.estimate_number, depositInvoice, published.dType, published.depositAmount, published.depositPercent,
        );
      }

      // Keep the frozen send configuration in lockstep with the invoice. It is the HELD figure
      // every deposit surface reads (resolveDepositState, frontend/src/lib/deposit.ts): leaving it
      // behind would have the receipt card go on reporting a mismatch against a deposit that has
      // just been corrected. `deposit_required` is untouched — whether a deposit was asked for at
      // all was settled at the first send.
      if (sendOutcome.depositReprice?.changed && existing.send_config) {
        await tx.estimateSendConfig.update({
          where: { id: existing.send_config.id },
          data: { deposit_amount: published.depositAmount, deposit_percentage: published.depositPercent },
        });
      }

      // Update message_body on send_config if provided
      if (body.message_body !== undefined && existing.send_config) {
        await tx.estimateSendConfig.update({
          where: { id: existing.send_config.id },
          data: { message_body: body.message_body },
        });
      }

      // §A3 — a material edit since the last send nulls public_token + flags
      // modified_after_send (see update()). Re-sending clears the flag and, if the old link was
      // invalidated, mints a fresh one — this IS the "force re-send" the guardrail requires.
      //
      // #1522: persist the SAME `publicToken` that went into the email above, not a second
      // randomUUID(). Only the isFirstSend branch writes the token up-front, so on this path a
      // freshly minted UUID here was never the one the customer received and their link 404'd.
      // `publicToken` already equals existing.public_token when there is one, so the guard is
      // still what decides whether the column is written at all.
      // A5 — `valid_until` is minted WITH the token, because the guardrail retires the two
      // together (`REVOKE_PUBLIC_LINK`). Writing the token alone would hand the customer a live
      // link on a row with no expiry: the date-anchor automation sweep would never select it
      // again, and nothing would ever expire it. An unchanged re-send takes neither half and the
      // standing window is left exactly where the first send put it.
      const resent = await tx.estimate.update({
        where: { id: existing.id },
        data: {
          ...(existing.public_token == null ? { public_token: publicToken, valid_until: validUntil } : {}),
          modified_after_send: false,
          // A2 — the publish lands in THIS write, the last one on the branch, so the `select`
          // reads the document back as the customer will see it, exactly as commitFirstSend does.
          ...publish.data,
        },
        select: estimateDetailSelect,
      });

      // Audit trail timeline event — skipped for a terminal "send a copy" (D11): the estimate's
      // timeline should keep reading as won/declined/archived, not as if it re-entered an active
      // send/negotiation cycle. Metadata carries the same D9 instrumentation as first-send above.
      if (!isTerminalSend) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: existing.id,
            event_type: 'SENT',
            description: `Estimate ${existing.estimate_number} resent to customer`,
            metadata: {
              walkthrough_completed: walkthrough.completed,
              // Snapshot, as on first send above - see commitFirstSend.
              walkthrough_completed_at: walkthrough.completedAt?.toISOString() ?? null,
            },
            created_by: req.user!.id,
          },
        });
      }

      return resent;
    }
  }), { label: 'estimate.send' });

  void logAudit({ req, action: 'estimate.sent', resourceType: 'Estimate', resourceId: existing.id, metadata: { estimate_number: existing.estimate_number } });

  // #2031 slice 5 — the deposit moved, so the estimate's history says so, and says what it moved
  // between and which state of the estimate produced the new figure. Post-commit, like every other
  // audit write here: history must never be able to fail a send.
  if (sendOutcome.depositReprice?.changed) {
    logDepositReprice(
      req,
      existing.id,
      sendOutcome.depositReprice,
      existing.version,
      round2(sendOutcome.publishedTotal ?? documentTotal),
    );
    // #2031 slice 5 (F2) — the figure on the document has just moved. A checkout the customer
    // opened against the OLD figure is still live at the processor and would settle at it, and by
    // now nothing else can tell: the document reads as current again. Awaited so the send does not
    // return while the old link is still payable; it cannot throw and cannot fail the send.
    await expireDepositCheckoutsAfterReprice(sendOutcome.depositReprice.invoiceId, req.user!.organization_id);
  }

  // ─── Automation Center event — first send only, post-commit (#271) ────────
  // Resends never re-fire (and the engine's once-per-entity dedupe backstops).
  if (isFirstSend) {
    dispatchAutomationEvent({
      type: 'ESTIMATE_SENT',
      organizationId: req.user!.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: req.user?.id ?? null,
    });
  }

  // §A3 / #2030 — each Send mints an immutable version: the whole document as the customer
  // received it, not a summary. Fire-and-forget, like the audit log above — supplementary
  // history, never core transactional state. (The email itself is no longer fire-and-forget
  // here; see the PREP/EMAIL/COMMIT phases above, which await confirmation before this point.)
  if (estimate) {
    void mintEstimateVersion({
      estimateId: estimate.id,
      orgId: req.user!.organization_id,
      trigger: 'SEND',
    });
  }

  return { ok: true, estimate };
}

export async function send(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof sendEstimateSchema>;
    const result = await sendEstimateInternal(req, param(req, 'id'), body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(result.estimate as { lead?: unknown } | null)) });
  } catch (err) {
    logger.error('Send estimate error:', err);
    res.status(500).json({ error: 'Failed to send estimate' });
  }
}

// List-level bulk send reminder (Estimates list page) - sequential, per-id isolated. Only
// SENT|PENDING rows are eligible: an EXPLICIT ALLOWLIST, not a DRAFT denylist, so every
// isTerminalSend status (WON/DECLINED/EXPIRED/ARCHIVED/SUPERSEDED) is refused before it ever
// reaches sendEstimateInternal, and a DRAFT id is refused before it can silently first-send
// (which would create a deposit invoice - see isFirstSend above).
export async function bulkSendReminders(req: Request, res: Response) {
  try {
    const { ids, message_body } = req.body as z.infer<typeof bulkSendEstimateRemindersSchema>;
    const sent: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const existing = await prisma.estimate.findUnique({
          where: { id, ...tenantWhere(req) },
          select: { status: true },
        });

        if (!existing) {
          failed.push({ id, error: 'Estimate not found' });
          continue;
        }

        if (existing.status === 'DRAFT') {
          failed.push({ id, error: 'Draft estimates cannot be reminded - send the estimate first' });
          continue;
        }

        if (existing.status !== 'SENT' && existing.status !== 'PENDING') {
          // #2090 ruling 18 - "use Send a copy" is still true for WON/DECLINED/ARCHIVED/EXPIRED,
          // and false for SUPERSEDED: that control is absent on the workspace and the send door
          // refuses it. Branch the copy rather than sending the rep to a button that is not there.
          failed.push({
            id,
            error: existing.status === 'SUPERSEDED'
              ? SUPERSEDED_NOT_SENDABLE
              : 'This estimate is already closed - open it and use Send a copy',
          });
          continue;
        }

        // deposit_required/payment_methods below satisfy sendEstimateSchema's TypeScript shape
        // ONLY - this route validates with bulkSendEstimateRemindersSchema, a separate schema
        // with neither field. They are inert at runtime: both are read solely inside
        // sendEstimateInternal's isFirstSend branch, and no eligible status here (SENT|PENDING)
        // can ever be isFirstSend (DRAFT-only).
        const result = await sendEstimateInternal(req, id, {
          deposit_required: false,
          payment_methods: [],
          ...(message_body !== undefined ? { message_body } : {}),
        });

        if (result.ok) {
          sent.push(id);
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (err) {
        logger.error(`Bulk send estimate reminder error for ${id}:`, err);
        failed.push({ id, error: 'Failed to send estimate reminder' });
      }
    }

    res.json({ sent, failed });
  } catch (err) {
    logger.error('Bulk send estimate reminders error:', err);
    res.status(500).json({ error: 'Failed to send estimate reminders' });
  }
}

// Map a non-'sent' EmailDispatchResult to the HTTP response the send() handler returns when it
// refuses to mark an estimate SENT. Pure — no side effects. org_disabled is a deliberate admin
// kill-switch (409 conflict, not an error); a missing API key or a provider rejection is an
// upstream/infra failure (502 bad gateway). In every case the estimate is LEFT unchanged.
function mapEmailFailure(result: EmailDispatchResult): { code: number; message: string } {
  if (result.status === 'skipped' && result.reason === 'org_disabled') {
    return { code: 409, message: 'Email sending is disabled for your organization. The estimate was not marked as sent.' };
  }
  if (result.status === 'skipped') { // no_api_key
    return { code: 502, message: 'Email is not configured, so the estimate was not sent.' };
  }
  return { code: 502, message: 'The estimate could not be emailed to the customer, so it was not marked as sent. Please try again.' };
}

// ─── Record Payment (admin/dispatcher) ────────────────
// Captures a deposit payment directly on an estimate, skipping the public-page signature
// ceremony. Works on DRAFT/SENT/PENDING. The kind=DEPOSIT Invoice is the SOLE deposit
// document: find-or-create it (a never-sent DRAFT has none yet), record a Payment against it,
// mark it PAID, flip the estimate → WON and the lead → WON.
export async function recordEstimatePayment(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, total_amount: true,
        lead_id: true, public_token: true, valid_until: true,
        deposit_type: true, deposit_value: true, // B8/PRD §13.7 — the estimate's own deposit override, if set
        customer_id: true, // SERV10X-61 - deposit customer, lead-less safe (R6 denormalized, NOT-NULL)
        lead: { select: {
          lead_assignees: { select: { user_id: true } },
          customer: { select: { id: true } },
          commission_owner_id: true,
          // Spec #1751 D6: the transition writer records `from` on the ledger entry, and the
          // door is the only place that already has the lead loaded.
          status: true,
        } },
        send_config: { select: { id: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #106 — per-instance ownership through SQL (lifecycle verb). The route guard
    // canDo('record_payment') is subject-level only; without this a scoped role could record a
    // deposit payment on another user's estimate. canAccessRow is nested-safe and fail-closed.
    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Only non-terminal, not-yet-paid estimates can have a payment recorded.
    if (!['DRAFT', 'SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({
        error: existing.status === ESTIMATE_STATUS.WON
          ? 'Estimate is already approved/paid'
          : `Cannot record payment on a ${existing.status.toLowerCase()} estimate`,
      });
      return;
    }

    const body = req.body as z.infer<typeof recordEstimatePaymentSchema>;
    const paidAt = body.paid_at ? new Date(body.paid_at) : new Date();

    // Resolve deposit percentage (descriptive only — the actual charge is the admin-entered
    // body.amount): an explicit request override wins; otherwise B8/PRD §13.7 — prefer the
    // ESTIMATE's own deposit_type/deposit_value (Receipt Card), falling back to the org deposit
    // default (#61) only when the estimate has neither set. Shares resolveDepositAmount with
    // send() so both paths derive off the SAME source of truth.
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: { deposit_default_type: true, deposit_default_percentage: true, deposit_default_fixed_amount: true },
    });
    const depositPercent: number = body.deposit_percentage != null
      ? body.deposit_percentage
      : resolveDepositAmount(existing, org).depositPercent;

    // Hoisted so the POST-COMMIT notification block (#271) can read it after the txn resolves.
    let isFullyPaid = false;
    // The deposit invoice reached PAID → dispatch INVOICE_PAID post-commit, for
    // door-parity with the invoice-controller + Stripe deposit doors.
    let paidDepositInvoice: { id: string; number: string } | null = null;

    const estimate = await withNumberCollisionRetry(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Retry-safety: both of these are written inside the transaction and read by the
      // POST-COMMIT notification block. A retried attempt must not inherit what a rolled-back
      // one decided — `paidDepositInvoice` in particular is set only on the full-payment
      // branch, so a stale value would dispatch INVOICE_PAID for a payment that never landed.
      isFullyPaid = false;
      paidDepositInvoice = null;

      // 1. Find-or-create the kind=DEPOSIT Invoice (the SOLE deposit document). A never-sent DRAFT
      // estimate has no deposit invoice yet (it is created at send()), so lazily create it here using
      // body.amount as the recorded deposit. Then record the Payment on it and mark it PAID or
      // PARTIAL depending on balance coverage.
      let depInv = await tx.invoice.findFirst({
        where: { estimate_id: existing.id, kind: 'DEPOSIT', ...tenantWhere(req) },
        select: { id: true, amount_due: true, total_amount: true, invoice_number: true },
      });
      // When freshly created, the deposit invoice is opened with amount_due = body.amount, so the
      // payment fully covers it; track this so coverage math doesn't depend on the create() echo.
      let depInvDue: number;
      if (!depInv) {
        // SERV10X-61 - the deposit customer is the estimate's own denormalized customer_id (R6,
        // NOT-NULL on every estimate), so this works for a lead-less customer-anchored estimate too.
        const depositCustomerId = existing.customer_id;
        const depositInvoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);
        depInv = await tx.invoice.create({
          data: {
            invoice_number: depositInvoiceNumber,
            organization_id: req.user!.organization_id,
            job_id: null,
            kind: 'DEPOSIT',
            estimate_id: existing.id,
            customer_id: depositCustomerId,
            status: 'SENT',
            public_token: randomUUID(),
            subtotal: body.amount,
            discount_amount: 0,
            tax_rate: 0,
            tax_amount: 0,
            deposit_credit: 0,
            total_amount: body.amount,
            amount_due: body.amount,
            line_items: {
              create: [{
                sequence: 1,
                description: `Deposit — ${depositPercent}% of ${existing.estimate_number}`,
                quantity: 1,
                unit_price: body.amount,
                is_taxable: false,
                line_total: body.amount,
              }],
            },
            // Audit: the user recording the deposit payment opened this invoice as part of doing so.
            ...createdByUser(req),
          },
          select: { id: true, amount_due: true, total_amount: true, invoice_number: true },
        });
        // Newly opened deposit invoice: amount_due == body.amount by construction.
        depInvDue = body.amount;
      } else {
        depInvDue = Number(depInv.amount_due);
      }

      // Compute coverage using the proven formula from invoice.controller.ts:967-972.
      // depInv is now guaranteed to exist (found or just created).
      const newAmountDue = Math.round(Math.max(depInvDue - body.amount, 0) * 100) / 100;
      isFullyPaid = newAmountDue <= 0;

      // Always record the Payment row — real money was collected regardless of full vs partial.
      await tx.payment.create({
        data: {
          invoice_id: depInv.id,
          amount: body.amount,
          method: body.payment_method,
          paid_at: paidAt,
          collected_by: req.user!.id,
          reference_number: body.reference_number ?? null,
          notes: body.notes ?? null,
          // Audit: staff collected this deposit, so the collecting user is also the creator.
          ...createdByUser(req),
        },
      });
      // Mark the deposit invoice PAID only when fully covered, else PARTIAL.
      await tx.invoice.update({
        where: { id: depInv.id },
        data: {
          amount_due: newAmountDue,
          status: isFullyPaid ? 'PAID' : 'PARTIAL',
          paid_at: isFullyPaid ? paidAt : undefined,
        },
      });
      if (isFullyPaid) {
        paidDepositInvoice = { id: depInv.id, number: depInv.invoice_number };
      }

      // 2. Estimate → WON only when fully paid. Generate public_token if missing (archival).
      if (isFullyPaid) {
        await tx.estimate.update({
          where: { id: existing.id },
          data: {
            status: ESTIMATE_STATUS.WON,
            approved_at: paidAt,
            public_token: existing.public_token ?? randomUUID(),
          },
        });
      } else if (!existing.public_token) {
        await tx.estimate.update({
          where: { id: existing.id },
          data: { public_token: randomUUID() },
        });
      }

      // 3. Create EstimateSendConfig if missing (DRAFT path).
      if (!existing.send_config) {
        await tx.estimateSendConfig.create({
          data: {
            estimate_id: existing.id,
            deposit_required: true,
            deposit_percentage: depositPercent,
            deposit_amount: body.amount,
            payment_methods: [body.payment_method],
          },
        });
      }

      // 4. Lead → WON only when fully paid (idempotent — skip terminal states).
      // Spec #1751 D6: through the one status writer, which also stamps won_at and records the
      // from/to ledger entry. The `notIn` guard this replaces is the helper's own default.
      if (isFullyPaid && existing.lead_id) {
        await transitionLeadStatus(tx, {
          leadId: existing.lead_id,
          orgId: req.user!.organization_id,
          to: 'WON',
          from: existing.lead!.status,
          actorId: req.user!.id,
          description: 'Lead won — estimate deposit paid in full',
          metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'deposit_paid' },
        });
      }

      // 5. Timeline events.
      // DEPOSIT_PAID always fires — real money is always recorded.
      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'DEPOSIT_PAID',
          description: isFullyPaid
            ? `Deposit of $${body.amount.toFixed(2)} recorded via ${body.payment_method} for estimate ${existing.estimate_number}`
            : `Deposit of $${body.amount.toFixed(2)} recorded via ${body.payment_method} for estimate ${existing.estimate_number} (partial — $${newAmountDue.toFixed(2)} remaining)`,
          metadata: {
            method: body.payment_method,
            amount: body.amount,
            recorded_by: req.user!.id,
            reference_number: body.reference_number ?? null,
          },
          created_by: req.user!.id,
        },
      });

      // APPROVED event only fires on full payment.
      if (isFullyPaid) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: existing.id,
            event_type: 'APPROVED',
            description: `Estimate ${existing.estimate_number} approved (payment recorded by admin)`,
            created_by: req.user!.id,
          },
        });
      }

      return tx.estimate.findUnique({ where: { id: existing.id }, select: estimateDetailSelect });
    }), { label: 'estimate.record_payment' });

    // ── Notifications — POST-COMMIT (must NOT run inside the txn; see #271) ──────
    // deposit_paid: always fire — real money was recorded regardless of partial/full.
    await emit({
      verb: 'estimate.deposit_paid',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      data: { object_label: existing.estimate_number, lead_id: existing.lead_id },
      dedupKey: `estimate.deposit_paid:${existing.id}`,
    });
    // approved: only on full payment; same dedupKey as paths A (approvePublic) + C (webhook).
    if (isFullyPaid) {
      await emit({
        verb: 'estimate.approved',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
        entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
        // #2090 - the chosen and declined add-ons, named as the document names them.
        data: { object_label: existing.estimate_number, lead_id: existing.lead_id, ...optionSummaryData(await loadOptionSummary(existing.id)) },
        dedupKey: `estimate.approved:${existing.id}`,
      });
      // Automation Center — dedupe key collapses the 3 approval paths downstream.
      dispatchAutomationEvent({
        type: 'ESTIMATE_APPROVED',
        organizationId: req.user!.organization_id,
        entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
        actorId: req.user?.id ?? null,
      });
      // The deposit invoice reached PAID here too — dispatch INVOICE_PAID for
      // parity with the invoice-controller + Stripe deposit doors. The `as` widens
      // past TS's CFA, which narrows this closure-assigned `let` to `null`/`never`.
      const paidInvoice = paidDepositInvoice as { id: string; number: string } | null;
      if (paidInvoice) {
        dispatchAutomationEvent({
          type: 'INVOICE_PAID',
          organizationId: req.user!.organization_id,
          entity: { type: 'invoice', id: paidInvoice.id, label: paidInvoice.number },
          actorId: req.user?.id ?? null,
        });
      }
    }

    void logAudit({ req, action: 'estimate.deposit_paid', resourceType: 'Estimate', resourceId: existing.id, metadata: { amount: body.amount, fully_paid: isFullyPaid } });
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Record estimate payment error:', err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
}

export async function cancel(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, created_by: true,
        lead: { select: {
          lead_assignees: { select: { user_id: true } },
          commission_owner_id: true,
        } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!['DRAFT', 'SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: `Cannot cancel a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: {
          status: ESTIMATE_STATUS.ARCHIVED,
          cancelled_at: new Date(),
          cancelled_reason: req.body.cancelled_reason,
        },
        select: estimateDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'CANCELLED',
          description: `Estimate ${existing.estimate_number} cancelled`,
          metadata: { reason: req.body.cancelled_reason },
          created_by: req.user!.id,
        },
      });

      // Void any UNPAID kind=DEPOSIT Invoice (DRAFT/SENT) on this estimate — a paid one stays.
      await tx.invoice.updateMany({
        where: { estimate_id: existing.id, kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'VOIDED', voided_at: new Date(), voided_reason: 'Estimate cancelled' },
      });

      return est;
    });

    // ── Notification: estimate.cancelled — POST-COMMIT (#271) ─────────────────
    await emit({
      verb: 'estimate.cancelled',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      data: { object_label: existing.estimate_number },
    });

    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Cancel estimate error:', err);
    res.status(500).json({ error: 'Failed to cancel estimate' });
  }
}

// ─── R4 (2026-07-21) — lifecycle verbs (port-plan §3.2/§10.3, D13) ────────

// Mark-sent takes the SAME body as send() (minus the email-specific cc_emails/recipient_override).
// #2044 — missing payment methods is a warning shown in both dialogs, never a block: an estimate
// commits with `payment_methods: []` exactly as configured, whether deposit-required was told to
// the customer by email (send) or in person (this route).
export const markSentEstimateSchema = z.object({
  deposit_required: z.boolean().default(true),
  payment_methods: z.array(z.nativeEnum(PaymentMethod)).default([]),
  message_body: z.string().max(5000).optional(),
});

// Mark-sent: the estimate was delivered outside the app (in person, a phone read-out) — runs the
// EXACT same first-send commit as send() (deposit invoice, send_config, T&C snapshot, lead
// auto-transition — via the shared commitFirstSend), just skips the email dispatch entirely. A
// deposit-required org's requirement is NOT bypassable by choosing this verb over Send. Deliberately
// SILENT (no notification emit) — mirrors send()'s own precedent (there is no `estimate.sent` verb
// today either); see resolveRecipients.ts for the same pattern documented on `communication.call_incoming`.
export async function markSent(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, total_amount: true, lead_id: true,
        deposit_type: true, deposit_value: true, created_by: true,
        // #2031 slice 5 — the estimate state a re-priced deposit is traced back to, on the
        // history entry below. send() already carries it.
        version: true,
        // SERV10X-61 - customer_id feeds commitFirstSend's deposit customer (lead-less safe);
        // _count feeds the same ≥1-line-item gate send() enforces (an empty estimate is not sendable).
        customer_id: true,
        _count: { select: { line_items: true } },
        lead: {
          select: {
            lead_assignees: { select: { user_id: true } }, status: true, customer: { select: { id: true } },
          },
        },
        // SRVW-96 - same guard inputs as send().
        job_id: true,
        job: { select: { id: true } },
        job_link: { select: { job_number: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (existing.status !== 'DRAFT') {
      res.status(400).json({ error: `Cannot mark a ${existing.status.toLowerCase()} estimate as sent` });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // SERV10X-61 §5.6 - mark-sent is a first-send path too: an empty estimate must not be
    // markable-as-sent any more than it is sendable (mirrors the identical gate in send()).
    if ((existing._count?.line_items ?? 0) === 0) {
      res.status(400).json({ error: 'Add at least one line item before sending' });
      return;
    }

    // D8/D9 (Walkthrough-as-entity redesign, PR-B2): the `require_walkthrough_before_send` gate
    // is removed entirely - see the identical note in send(). Silent instrumentation only.
    const walkthrough = await walkthroughCompletionSnapshot(req, existing.lead_id);

    const body = req.body as z.infer<typeof markSentEstimateSchema>;

    // SRVW-96 - markSent is DRAFT-only (guarded above), so it is always a first send; no isFirstSend
    // conjunct is needed here the way send() needs one.
    if (body.deposit_required && hasJobLinkWithoutProvenance(existing)) {
      res.status(400).json({ error: depositOnAttachedEstimateMessage(existing.estimate_number, existing.job_link?.job_number) });
      return;
    }

    const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id } });
    if (!org) {
      res.status(500).json({ error: 'Organization not configured.' });
      return;
    }

    const validDaysSetting = await prisma.appSetting.findUnique({
      where: { organization_id_key: { organization_id: req.user!.organization_id, key: 'estimate_validity_days' } },
    });
    const validDays = parseInt(validDaysSetting?.value ?? '30', 10);
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + validDays);
    const publicToken = randomUUID();

    const { dType, depositAmount, depositPercent } = resolveDepositAmount(existing, org);

    // #2031 slice 5 — same out-parameter send() uses; reset inside the callback so a retried
    // attempt cannot leave a rolled-back verdict standing.
    const markSentOutcome: { depositReprice?: DepositRepriceResult; publishedTotal?: number } = {};

    const estimate = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      markSentOutcome.depositReprice = undefined;
      markSentOutcome.publishedTotal = undefined;
      return commitFirstSend(tx, req, existing, org, body, publicToken, validUntil, dType, depositAmount, depositPercent, walkthrough, markSentOutcome);
    }), { label: 'estimate.mark_sent' });

    void logAudit({ req, action: 'estimate.marked_sent', resourceType: 'Estimate', resourceId: existing.id });

    // #2031 slice 5 — a recalled-to-draft estimate can reach this door with an unpaid deposit
    // invoice already standing, so mark-sent re-prices exactly as send() does, and says so.
    if (markSentOutcome.depositReprice?.changed) {
      logDepositReprice(
        req,
        existing.id,
        markSentOutcome.depositReprice,
        existing.version,
        round2(markSentOutcome.publishedTotal ?? Number(existing.total_amount)),
      );
      // Same reason as send()'s branch: the old figure's checkout has to die with it.
      await expireDepositCheckoutsAfterReprice(markSentOutcome.depositReprice.invoiceId, req.user!.organization_id);
    }

    // #2030 slice 2 — marking as sent is a customer RECEIVING the document, just delivered
    // outside the system, so it mints a version exactly as send() does.
    void mintEstimateVersion({
      estimateId: existing.id,
      orgId: req.user!.organization_id,
      trigger: 'MARK_SENT',
    });

    // §14.2's emit-or-silent decision for this verb: deliberately silent, matching send()'s own
    // first-send branch — sending/marking-sent is the actor's own action, not something that
    // happens TO another staff member, so there is no `estimate.marked_sent` notification verb.

    // mark-sent is unconditionally a first-send (guarded to DRAFT-only above) — same event
    // send()'s first-send branch fires, so Automation Center rules keyed on ESTIMATE_SENT still
    // trigger for an estimate delivered outside the app.
    dispatchAutomationEvent({
      type: 'ESTIMATE_SENT',
      organizationId: req.user!.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: req.user?.id ?? null,
    });

    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Mark estimate sent error:', err);
    res.status(500).json({ error: 'Failed to mark estimate as sent' });
  }
}

// PATCH /:id/status — a FREE setter over the six exposed statuses (Spec B1, applied to Estimate):
// any status is reachable from any other, forward or backward, matching the Job model and what
// Workiz lets users do. Only integrity rules block a move; ordering rules are gone.
//
// `status` is the setter. `transition` ('backtodraft' | 'backtosent') is the retained legacy alias
// for the two administrative corrections that predate the free setter — same behaviour, including
// their original source-status gate, so in-flight clients and the Estimates-list bulk action keep
// working unchanged. Exactly one of the two must be supplied.
//
// `backtodraft` is the SAME-ROW recall §14.4 distinguishes from revise()'s clone-supersede: it
// nulls public_token (the customer's old link must stop working) and keeps the same estimate
// number — no SUPERSEDED sibling. Those stamp changes now live in buildStatusChangeData() as the
// "entering DRAFT" effect, so the free setter applies them too.
//
// A staff-set PENDING is deliberately UNSIGNED (this engine never fabricates signature_data —
// only approvePublic captures a signature). That used to be the reason no manual PENDING existed:
// approvePublic's `isPaymentRetry` branch keyed off `status === 'PENDING'` alone and would skip
// signature capture, letting an unsigned estimate reach WON. That check is now keyed on
// `signature_data != null`, so an unsigned PENDING is still asked to sign.
//
// R4b (2026-07-21) — every status change emits `estimate.status_corrected` (Admin FEED + owner
// FEED, grouped with cancelled/deposit_waived/approval_voided): a correction changes the state of
// a rep's estimate without their action, the same consequence level as a waived deposit.
export const setEstimateStatusSchema = z
  .object({
    transition: z.enum(['backtodraft', 'backtosent']).optional(),
    status: z.enum(TARGETABLE_ESTIMATE_STATUSES).optional(),
    // Required when moving to DECLINED (see the refine below) — declineInternal's rule, kept: a
    // staff-recorded loss must capture why, because S1 reporting depends on that signal.
    //
    // Slice C — SHAPE ONLY. It was `z.nativeEnum(LostReason)`; the set of legal values is now
    // per-organisation, which a schema compiled at import time cannot know. The membership check
    // moved into the handler, where the org is; decision D10 says slice C replaces WHAT these
    // paths check against and never WHETHER they check, and this one is checked in `setStatus`.
    lost_reason: z.string().min(1).max(LOST_REASON_CODE_MAX).optional(),
    cancelled_reason: z.string().max(500).optional(),
  })
  .refine((d) => (d.transition ? 1 : 0) + (d.status ? 1 : 0) === 1, {
    message: 'Provide exactly one of "status" or "transition"',
  })
  .refine((d) => d.status !== ESTIMATE_STATUS.DECLINED || !!d.lost_reason, {
    message: 'lost_reason is required when declining an estimate',
    path: ['lost_reason'],
  });

const STATUS_TRANSITIONS: Record<
  'backtodraft' | 'backtosent',
  { from: string[]; to: 'DRAFT' | 'SENT'; label: string }
> = {
  backtodraft: { from: ['SENT', 'PENDING'], to: 'DRAFT', label: 'recalled to draft' },
  backtosent: { from: ['PENDING'], to: 'SENT', label: 'moved back to sent' },
};

// Extracted from setStatus() so bulkSetStatus() (list-level bulk status change, Estimates list
// page) can share the EXACT same guards + transaction/timeline/emit logic without duplicating it.
// Returns a result instead of writing to `res` directly - setStatus() and bulkSetStatus() each
// translate that result into their own response shape. Same pattern as
// deleteEstimateInternal/bulkRemove above.
//
// Takes a TARGET STATUS, not a transition: under Spec B1 the pair (from, to) carries no ordering
// meaning, only stamp meaning, which buildStatusChangeData() owns. `legacyTransition` is passed
// only when the caller used the retained alias, and exists solely to keep that alias's original
// source-status gate and wording intact.
async function setStatusInternal(
  req: Request,
  id: string,
  target: EstimateStatusValue,
  legacyTransition?: 'backtodraft' | 'backtosent',
  reason: { lost_reason?: string; cancelled_reason?: string } = {},
): Promise<{ ok: true; estimate: unknown } | { ok: false; status: number; error: string }> {
  const existing = await prisma.estimate.findUnique({
    where: { id, ...tenantWhere(req) },
    select: {
      id: true, status: true, estimate_number: true, created_by: true, lead_id: true, public_token: true,
      lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true, status: true } },
      job: {
        select: {
          id: true, job_number: true,
          invoices: { select: { id: true, status: true, payments: { select: { id: true }, take: 1 } } },
        },
      },
      // The kind=DEPOSIT Invoice is estimate_id-linked only (job_id: null — see commitFirstSend),
      // so it is invisible to the job.invoices check above and must be loaded separately.
      invoices: {
        where: { kind: 'DEPOSIT' as const },
        select: { id: true, status: true, payments: { select: { id: true }, take: 1 } },
        take: 1,
      },
    },
  });

  if (!existing) {
    return { ok: false, status: 404, error: 'Estimate not found' };
  }

  if (legacyTransition && !STATUS_TRANSITIONS[legacyTransition].from.includes(existing.status)) {
    return { ok: false, status: 400, error: `Cannot apply "${legacyTransition}" to a ${existing.status.toLowerCase()} estimate` };
  }

  // No send-ceremony gate here, deliberately. SENT is a label like every other status; minting a
  // customer link is the job of send/resend/mark-sent alone. The 409 SEND_CEREMONY_REQUIRED that
  // used to sit here redirected the client to POST /:id/mark-sent, which gates on DRAFT - so a
  // token-less WON/DECLINED/ARCHIVED estimate was refused by both ends with no path between them.

  const moneyTrailRefusal = blockedByMoneyTrail(existing, target);
  if (moneyTrailRefusal) {
    return { ok: false, status: 400, error: moneyTrailRefusal };
  }

  if (!(await canAccessEstimate(existing, req))) {
    return { ok: false, status: 403, error: 'Insufficient permissions' };
  }

  // The legacy alias keeps its original wording in the timeline/feed ("recalled to draft"); a
  // free-setter move reads as what it is.
  const label = legacyTransition
    ? STATUS_TRANSITIONS[legacyTransition].label
    : `moved to ${target.toLowerCase()}`;

  const estimate = await prisma.$transaction(async (tx) => {
    // #2031 — back to draft hands the document back to the salesperson, so the frozen send
    // configuration goes with it: it is the record of a send that no longer stands AND the gate
    // on deposit editability. deleteMany, not delete, so an estimate that never had a send
    // ceremony (Spec B1 lets any status be set directly) is a no-op rather than a P2025.
    if (clearsSendConfig(target)) {
      await tx.estimateSendConfig.deleteMany({ where: { estimate_id: existing.id } });
    }

    const est = await tx.estimate.update({
      where: { id: existing.id },
      data: buildStatusChangeData(existing.status, target, reason),
      select: estimateDetailSelect,
    });

    // Entering WON propagates the win to the lead, idempotently — same rule as approveInternal:
    // a lead already WON/LOST/CANCELLED is left alone.
    if (target === ESTIMATE_STATUS.WON && existing.lead_id) {
      await transitionLeadStatus(tx, {
        leadId: existing.lead_id,
        orgId: req.user!.organization_id,
        to: 'WON',
        from: existing.lead!.status,
        actorId: req.user!.id,
        description: 'Lead won — estimate status corrected to won',
        metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'status_correction' },
      });
    }

    // Leaving WON hands the lead back — voidApproval's rule, verbatim. A job existing means the
    // win already propagated further downstream than the lead, so the lead stays WON. And a lead
    // can hold several WON estimates at once, so demote only once this was the LAST one still
    // won, or the lead would contradict a sibling. Counted on `tx` so it sees the write above.
    if (
      existing.status === ESTIMATE_STATUS.WON &&
      target !== ESTIMATE_STATUS.WON &&
      !existing.job &&
      existing.lead_id &&
      existing.lead?.status === 'WON'
    ) {
      const siblingsStillWon = await tx.estimate.count({
        where: { ...tenantWhere(req), lead_id: existing.lead_id, status: ESTIMATE_STATUS.WON, id: { not: existing.id } },
      });
      if (siblingsStillWon === 0) {
        // `onlyFrom: ['WON']` reproduces the `where: { status: 'WON' }` guard this replaces. The
        // demotion is the one transition that runs BACKWARD, so it must not be expressed as
        // "anything but the terminal three" — that would demote a LOST lead to ESTIMATED.
        await transitionLeadStatus(tx, {
          leadId: existing.lead_id,
          orgId: req.user!.organization_id,
          to: 'ESTIMATED',
          from: existing.lead!.status,
          actorId: req.user!.id,
          notFrom: [],
          onlyFrom: ['WON'],
          description: `Lead returned to ${LEAD_STATUS_LABEL.ESTIMATED} — the last won estimate was corrected`,
          metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'status_correction' },
        });
      }
    }

    await tx.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'ESTIMATE',
        entity_id: existing.id,
        event_type: 'STATUS_CORRECTED',
        description: `Estimate ${existing.estimate_number} ${label}`,
        metadata: { from: existing.status, to: target, ...(legacyTransition ? { transition: legacyTransition } : {}) },
        created_by: req.user!.id,
      },
    });

    return est;
  });

  // #2031 slice 5 - the recall suspends the deposit link, so a checkout the customer already has
  // open has to die with it: it is live at the processor for hours, it settles against an
  // amount_due the recall does not touch, and it would win an estimate that was withdrawn.
  // AFTER the commit and never inside it (an external call must not hold a transaction open), and
  // failure-isolated inside the guard - the status change has already happened and stands.
  if (suspendsDepositLink(target)) {
    await expireDepositCheckoutsOnRecall(existing.id, req.user!.organization_id);
  }

  // Reaching WON/DECLINED/ARCHIVED through the setter is the SAME business event as reaching it
  // through approve-internal/decline-internal/cancel, so it emits the same verb. Without this the
  // notification feed would report which control the user happened to press: an estimate declined
  // from the status pill would surface as a bland "status corrected" while the identical decline
  // from the Actions menu raised `estimate.declined`. Everything else is a plain correction.
  const VERB_BY_TARGET: Partial<Record<EstimateStatusValue, string>> = {
    [ESTIMATE_STATUS.WON]: 'estimate.approved',
    [ESTIMATE_STATUS.DECLINED]: 'estimate.declined',
    [ESTIMATE_STATUS.ARCHIVED]: 'estimate.cancelled',
  };
  const verb = VERB_BY_TARGET[target] ?? 'estimate.status_corrected';

  await emit({
    verb,
    organizationId: req.user!.organization_id,
    actorId: req.user?.id ?? null,
    object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
    entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
    data: { object_label: existing.estimate_number, from: existing.status, to: target, transition: legacyTransition, transition_label: label },
    ...(target === ESTIMATE_STATUS.WON ? { dedupKey: `estimate.approved:${existing.id}` } : {}),
  });

  // Same reasoning for the automation triggers — a workflow watching "estimate approved" must fire
  // whichever control produced the approval.
  const AUTOMATION_BY_TARGET: Partial<Record<EstimateStatusValue, 'ESTIMATE_APPROVED' | 'ESTIMATE_DECLINED'>> = {
    [ESTIMATE_STATUS.WON]: 'ESTIMATE_APPROVED',
    [ESTIMATE_STATUS.DECLINED]: 'ESTIMATE_DECLINED',
  };
  const automationType = AUTOMATION_BY_TARGET[target];
  if (automationType) {
    dispatchAutomationEvent({
      type: automationType,
      organizationId: req.user!.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: req.user?.id ?? null,
    });
  }

  void logAudit({ req, action: 'estimate.status_corrected', resourceType: 'Estimate', resourceId: existing.id, metadata: { from: existing.status, to: target } });

  return { ok: true, estimate };
}

export async function setStatus(req: Request, res: Response) {
  try {
    const { transition, status, lost_reason, cancelled_reason } = req.body as z.infer<typeof setEstimateStatusSchema>;
    // The schema guarantees exactly one of the two is present.
    const target = status ?? STATUS_TRANSITIONS[transition!].to;

    // Slice C — the membership check the schema used to do with `z.nativeEnum`. Same 400, same
    // shape of answer, measured against the organisation's own list instead of the enum. Only
    // when declining: `lost_reason` is ignored on every other target, and running it regardless
    // would 400 a perfectly good back-to-draft that happened to carry a stale field.
    if (target === ESTIMATE_STATUS.DECLINED && lost_reason
        && !(await isOfferedLostReason(req.user!.organization_id, lost_reason))) {
      res.status(400).json({ error: 'That decline reason is not one your organization offers' });
      return;
    }
    const result = await setStatusInternal(req, param(req, 'id'), target, transition, { lost_reason, cancelled_reason });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(result.estimate as { lead?: unknown } | null)) });
  } catch (err) {
    logger.error('Set estimate status error:', err);
    res.status(500).json({ error: 'Failed to update estimate status' });
  }
}

// List-level bulk status change (Estimates list page) - sequential, per-id isolated. Same two-
// transition whitelist as setStatus/STATUS_TRANSITIONS above; one id's failure never aborts the
// rest of the batch.
export async function bulkSetStatus(req: Request, res: Response) {
  try {
    const { ids, transition } = req.body as z.infer<typeof bulkSetEstimateStatusSchema>;
    const updated: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const result = await setStatusInternal(req, id, STATUS_TRANSITIONS[transition].to, transition);
        if (result.ok) {
          updated.push(id);
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (err) {
        logger.error(`Bulk set estimate status error for ${id}:`, err);
        failed.push({ id, error: 'Failed to update estimate status' });
      }
    }

    res.json({ updated, failed });
  } catch (err) {
    logger.error('Bulk set estimate status error:', err);
    res.status(500).json({ error: 'Failed to update estimate statuses' });
  }
}

export const approveInternalSchema = z.object({});

// Approve-internal: a verbal/off-platform win — no signature, no deposit collection. Reuses the
// SAME `estimate.approved` notification verb approvePublic's no-deposit branch emits (Branch 1) —
// it is the identical business event (this estimate is now WON), just a different channel.
export async function approveInternal(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true, created_by: true,
        lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true, status: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!['SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: `Cannot approve a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: { status: ESTIMATE_STATUS.WON, approved_at: new Date() },
        select: estimateDetailSelect,
      });

      if (existing.lead_id) {
        await transitionLeadStatus(tx, {
          leadId: existing.lead_id,
          orgId: req.user!.organization_id,
          to: 'WON',
          from: existing.lead!.status,
          actorId: req.user!.id,
          description: 'Lead won — estimate approved internally',
          metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'internal_approval' },
        });
      }

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'APPROVED',
          description: `Estimate ${existing.estimate_number} approved internally (verbal win)`,
          metadata: { method: 'internal' },
          created_by: req.user!.id,
        },
      });

      return est;
    });

    await emit({
      verb: 'estimate.approved',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      // #2090 - the chosen and declined add-ons, named as the document names them.
      data: { object_label: existing.estimate_number, lead_id: existing.lead_id, ...optionSummaryData(await loadOptionSummary(existing.id)) },
      dedupKey: `estimate.approved:${existing.id}`,
    });

    dispatchAutomationEvent({
      type: 'ESTIMATE_APPROVED',
      organizationId: req.user!.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: req.user?.id ?? null,
    });

    // Distinct audit action from the public route's 'estimate.approved' — same notification verb
    // above (identical business event), but the audit/history label must not read "by customer"
    // for a staff-recorded verbal win.
    void logAudit({ req, action: 'estimate.approved_internal', resourceType: 'Estimate', resourceId: existing.id });
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Approve estimate internally error:', err);
    res.status(500).json({ error: 'Failed to approve estimate' });
  }
}

// Decline-internal: staff records a verbal/off-platform decline. Unlike the public route's
// OPTIONAL lost_reason, this one is REQUIRED — a staff member recording a loss has no excuse not
// to capture why (S1 reporting depends on this signal). Reuses `estimate.declined`, same reasoning
// as approve-internal above.
// Slice C — shape only, for the reason given on `setEstimateStatusSchema.lost_reason` above:
// the legal set is per-organisation now, so the membership half of this check lives in the
// handler. Still REQUIRED here, which is the half that was always this route's own rule.
export const declineInternalSchema = z.object({
  lost_reason: z.string().min(1).max(LOST_REASON_CODE_MAX),
});

export async function declineInternal(req: Request, res: Response) {
  try {
    const { lost_reason } = req.body as z.infer<typeof declineInternalSchema>;

    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true, created_by: true,
        lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!['SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: `Cannot decline a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Slice C — after the access checks, not before: a caller who may not touch this estimate
    // learns that and nothing else, rather than being told which reasons the org offers.
    if (!(await isOfferedLostReason(req.user!.organization_id, lost_reason))) {
      res.status(400).json({ error: 'That decline reason is not one your organization offers' });
      return;
    }

    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: { status: 'DECLINED', declined_at: new Date(), lost_reason },
        select: estimateDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'DECLINED',
          description: `Estimate ${existing.estimate_number} declined internally`,
          metadata: { method: 'internal', lost_reason },
          created_by: req.user!.id,
        },
      });

      // Void any UNPAID kind=DEPOSIT Invoice (DRAFT/SENT) — mirrors declinePublic.
      const voided = await tx.invoice.updateMany({
        where: { estimate_id: existing.id, kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'VOIDED', voided_at: new Date(), voided_reason: 'Estimate declined' },
      });
      if (voided.count > 0) {
        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: existing.id,
            event_type: 'DEPOSIT_VOIDED',
            description: 'Deposit voided due to estimate decline',
            created_by: req.user!.id,
          },
        });
      }

      return est;
    });

    await emit({
      verb: 'estimate.declined',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      data: { object_label: existing.estimate_number, lost_reason },
    });

    dispatchAutomationEvent({
      type: 'ESTIMATE_DECLINED',
      organizationId: req.user!.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: req.user?.id ?? null,
    });

    // Distinct audit action from the public route's 'estimate.declined' — see the matching
    // comment in approveInternal above.
    void logAudit({ req, action: 'estimate.declined_internal', resourceType: 'Estimate', resourceId: existing.id, metadata: { lost_reason } });
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Decline estimate internally error:', err);
    res.status(500).json({ error: 'Failed to decline estimate' });
  }
}

// Void-approval — D13's GUARDED unwind (not the prototype's hard block): a WON estimate can be
// unwound back to SENT unless its job has already been invoiced or carries a payment, in which
// case the money trail is real and unwinding would orphan it. ADMIN-only (no DEFAULT_GRANTS row —
// ADMIN reaches every action via `manage all`).
export async function voidApproval(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true,
        lead: { select: { lead_assignees: { select: { user_id: true } }, commission_owner_id: true, status: true } },
        job: {
          select: {
            id: true, job_number: true,
            invoices: { select: { id: true, status: true, payments: { select: { id: true }, take: 1 } } },
          },
        },
        // SRVW-86 - the R6 attachment (Estimate.job_id / job_link) is a second job pointer `job`
        // (provenance) cannot see. Same shape as `job` above so the invoiced-or-paid guard below
        // can resolve either.
        job_link: {
          select: {
            id: true, job_number: true,
            invoices: { select: { id: true, status: true, payments: { select: { id: true }, take: 1 } } },
          },
        },
        // The kind=DEPOSIT Invoice is estimate_id-linked only (job_id: null — see commitFirstSend),
        // so it's invisible to the job.invoices check above. Port-plan: "unpaid deposit only".
        invoices: {
          where: { kind: 'DEPOSIT' as const },
          select: { id: true, status: true, payments: { select: { id: true }, take: 1 } },
          take: 1,
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (existing.status !== 'WON') {
      res.status(400).json({ error: `Cannot void approval on a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // SRVW-86 - resolve either job pointer: `job` is provenance (Job.estimate_id points back),
    // `job_link` is the R6 attachment (Estimate.job_id) that no Job points back at. Both carry
    // the same shape, so whichever is set is checked identically.
    const attachedJob = existing.job ?? existing.job_link;
    if (attachedJob) {
      const isInvoicedOrPaid = attachedJob.invoices.some((inv) => inv.status !== 'DRAFT' || inv.payments.length > 0);
      if (isInvoicedOrPaid) {
        res.status(400).json({
          error: `Cannot void approval — job ${attachedJob.job_number} has already been invoiced or has payments recorded.`,
        });
        return;
      }
    }

    const depositInvoice = existing.invoices?.[0];
    if (depositInvoice?.payments.length) {
      res.status(400).json({ error: 'Cannot void approval — the deposit has payments recorded.' });
      return;
    }

    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: { status: ESTIMATE_STATUS.SENT, approved_at: null },
        select: estimateDetailSelect,
      });

      // Reverts lead iff no job (port-plan §3.2) — a job existing means the win already
      // propagated further downstream than the lead, so the lead stays WON.
      // A lead can hold several WON estimates at once (the single-approved-per-lead invariant is
      // gone), so demote only once this was the LAST one still WON - otherwise the lead would
      // contradict a sibling that is still won. Counted on `tx` so it sees the SENT write above.
      if (!attachedJob && existing.lead_id && existing.lead?.status === 'WON') {
        const siblingsStillWon = await tx.estimate.count({
          where: {
            ...tenantWhere(req),
            lead_id: existing.lead_id,
            status: ESTIMATE_STATUS.WON,
            id: { not: existing.id },
          },
        });
        if (siblingsStillWon === 0) {
          // onlyFrom — see the sibling demotion in the status-correction door.
          await transitionLeadStatus(tx, {
            leadId: existing.lead_id,
            orgId: req.user!.organization_id,
            to: 'ESTIMATED',
            from: existing.lead!.status,
            actorId: req.user!.id,
            notFrom: [],
            onlyFrom: ['WON'],
            description: `Lead returned to ${LEAD_STATUS_LABEL.ESTIMATED} — the last won estimate had its approval voided`,
            metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'void_approval' },
          });
        }
      }

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'APPROVAL_VOIDED',
          description: `Approval voided for estimate ${existing.estimate_number}`,
          created_by: req.user!.id,
        },
      });

      return est;
    });

    await emit({
      verb: 'estimate.approval_voided',
      organizationId: req.user!.organization_id,
      actorId: req.user?.id ?? null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      data: { object_label: existing.estimate_number },
    });

    void logAudit({ req, action: 'estimate.approval_voided', resourceType: 'Estimate', resourceId: existing.id });
    res.json({ estimate: presentEstimateDetail(req, projectEstimateLeadWalkthrough(estimate)) });
  } catch (err) {
    logger.error('Void estimate approval error:', err);
    res.status(500).json({ error: 'Failed to void approval' });
  }
}

export async function duplicate(req: Request, res: Response) {
  try {
    const sourceEstimateId = param(req, 'id');
    const existing = await prisma.estimate.findUnique({
      where: { id: sourceEstimateId, ...tenantWhere(req) },
      select: {
        lead_id: true,
        customer_id: true,
        service_location_id: true,
        created_by: true,
        scope_notes: true,
        scopes: true,
        tax_rate: true,
        discount_type: true,
        discount_value: true,
        discount_name: true,
        customer: { select: { tax_exempt: true } },
        lead: { select: { lead_assignees: { select: { user_id: true } } } },
        line_items: {
          select: {
            description: true, quantity: true, unit_price: true, is_taxable: true,
            line_total: true, sequence: true, price_book_item_id: true, unit_cost: true,
            markup_percent: true,
            discount_type: true, discount_value: true, item_type: true,
            is_optional: true, is_selected: true,
          },
          orderBy: { sequence: 'asc' },
        },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const orgId = req.user!.organization_id;

    // Entity-redesign §10 — duplicate with a target-lead selector:
    //   • same lead (target omitted / equals source) → version/option; carry source tax.
    //   • different lead → cross-customer reuse; lines + scope carry, but tax RE-DERIVES
    //     from the target lead's service-location. Validate the target is in this tenant.
    // (Minimal-coherent: no SALES target-ownership guard this phase — same-tenant only;
    // flagged for product review.)
    const targetLeadIdInput: string | undefined = req.body?.target_lead_id;
    const targetLeadId = targetLeadIdInput ?? existing.lead_id;
    const isCrossLead = !!targetLeadIdInput && targetLeadIdInput !== existing.lead_id;

    let effectiveTaxRate = Number(existing.tax_rate);
    let duplicateCustomerIsExempt = Boolean(existing.customer?.tax_exempt);
    // R6 (2026-07-22) — the duplicate's anchor columns follow whichever lead it ends up on:
    // same-lead duplicates keep the source's already-denormalized customer_id/service_location_id;
    // a cross-lead duplicate re-derives both from the TARGET lead, same as tax re-derives above.
    let targetCustomerId = existing.customer_id;
    let targetServiceLocationId = existing.service_location_id;
    if (isCrossLead) {
      const targetLead = await prisma.lead.findUnique({
        where: { id: targetLeadIdInput as string, ...tenantWhere(req) },
        select: { id: true, customer_id: true, service_location_id: true, customer: { select: { tax_exempt: true } } },
      });
      if (!targetLead) {
        res.status(404).json({ error: 'Target lead not found' });
        return;
      }
      effectiveTaxRate = await deriveTaxRateFromLead(prisma, targetLeadIdInput as string, orgId);
      targetCustomerId = targetLead.customer_id;
      targetServiceLocationId = targetLead.service_location_id;
      duplicateCustomerIsExempt = Boolean(targetLead.customer?.tax_exempt);
    }

    // SRVW-82 - a duplicate is a NEW document, and duplicate() is the one clone path that re-derives
    // a rate (cross-lead). Same clamp as create(); revise() is deliberately NOT touched because it is
    // a documented verbatim freeze-and-clone whose deposit invoice carries forward unadjusted.
    if (duplicateCustomerIsExempt) effectiveTaxRate = 0;

    const estimate = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const estimateNumber = await allocateNumber(tx, 'estimate', req.user!.organization_id);

      // Recalculate totals from line items
      const lineItemsData = existing.line_items.map(li => ({
        quantity: Number(li.quantity),
        unit_price: Number(li.unit_price),
        is_taxable: li.is_taxable,
        discount_type: li.discount_type,
        discount_value: li.discount_value != null ? Number(li.discount_value) : null,
        is_optional: li.is_optional,
        is_selected: li.is_selected,
      }));
      const estDiscount = {
        discount_type: existing.discount_type,
        discount_value: existing.discount_value != null ? Number(existing.discount_value) : null,
      };
      // Scopes-of-work carry forward verbatim (same field, either lead) — fold them into the
      // recalculated totals exactly like the line items above. #2053 — one of the four
      // ESTIMATE-only call sites (reviewer amendment R1); AC13 needs the duplicate's totals to
      // stay selection-correct, not jump back to "everything counts".
      const existingScopes = toEstimateScopeForTotals(asScopeArray(existing.scopes));
      const { subtotal, taxAmount, totalAmount, estimateDiscountAmount, computed } = calculateTotals(
        lineItemsData, effectiveTaxRate, estDiscount, existingScopes,
      );

      return tx.estimate.create({
        data: {
          lead_id: targetLeadId,
          customer_id: targetCustomerId,
          service_location_id: targetServiceLocationId,
          // job_id intentionally NOT copied — a duplicate is a fresh draft that hasn't been used
          // to create any job yet, regardless of whether the source estimate has one.
          estimate_number: estimateNumber,
          organization_id: req.user!.organization_id,
          scope_notes: existing.scope_notes,
          // Freeze-at-send: verbatim EXCEPT the snapshot (see cloneScopesForNewDraft).
          scopes: cloneScopesForNewDraft(existing.scopes),
          tax_rate: effectiveTaxRate,
          subtotal,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          discount_type: existing.discount_type,
          discount_value: existing.discount_value,
          discount_name: existing.discount_name,
          discount_amount: estimateDiscountAmount,
          created_by: req.user!.id,
          line_items: {
            create: existing.line_items.map((item, idx) => ({
              sequence: item.sequence,
              description: item.description,
              quantity: item.quantity,
              unit_price: item.unit_price,
              is_taxable: item.is_taxable,
              line_total: computed[idx].line_total,
              price_book_item_id: item.price_book_item_id,
              unit_cost: item.unit_cost,
              markup_percent: item.markup_percent,
              discount_type: item.discount_type,
              discount_value: item.discount_value,
              discount_amount: computed[idx].discount_amount,
              item_type: item.item_type,
              is_optional: item.is_optional,
              is_selected: item.is_selected,
            })),
          },
        },
        select: estimateDetailSelect,
      });
    }), { label: 'estimate.duplicate' });

    // #2029 — the scope photos follow the document. OUTSIDE the transaction on purpose: copying
    // a Storage object is a live network call, and a duplicate must not be rolled back because a
    // photo could not be copied.
    const withPhotos = await withCopiedScopePhotos(estimate, sourceEstimateId, orgId);

    res.status(201).json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(withPhotos)), req)) });
  } catch (err) {
    logger.error('Duplicate estimate error:', err);
    res.status(500).json({ error: 'Failed to duplicate estimate' });
  }
}

// ─── Revise (clone → supersede) ───────────────────────
// Entity-redesign §4 / §10, as amended by §A2: revise takes a SENT (or PENDING)-but-NOT-approved
// estimate and CLONES it into a new DRAFT row with its own estimate_number, freezing the source
// as SUPERSEDED (read-only, provenance kept via superseded_by_id) and re-pointing the paid deposit
// invoice (if any) at the new row — unadjusted, at the exact amount paid. No refund path here by
// design (§A2.4); the eventual credit-to-final-invoice still runs through the existing
// DepositCreditApplication ledger, untouched, whenever a job/invoice is created off whichever
// estimate is now current. WON is the freeze line — frozen forever.
//
// This USED to be a same-row recall back to DRAFT, and the comment here used to explain that
// nulling public_token + valid_until invalidated the link on the way. The clone path dropped
// that, leaving the superseded row serving its old prices at its old URL. #2090 ruling 17 puts
// the revocation back — for the other reason: the source is no longer the current document, so
// its public door closes and the PDF the customer was already emailed is the record. The NEW
// DRAFT starts with no token of its own and mints one at its first send (isFirstSend), exactly
// as it always has; nothing on any sibling estimate row is read or written.
export async function revise(req: Request, res: Response) {
  try {
    const existing = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true, organization_id: true,
        customer_id: true, service_location_id: true, created_by: true,
        name: true, scope_name: true, scope_notes: true, scopes: true, tax_rate: true,
        discount_type: true, discount_value: true, discount_name: true, discount_amount: true,
        deposit_type: true, deposit_value: true,
        subtotal: true, tax_amount: true, total_amount: true,
        line_items: {
          select: {
            sequence: true, description: true, quantity: true, unit_price: true, is_taxable: true,
            line_total: true, price_book_item_id: true, unit_cost: true, markup_percent: true,
            discount_type: true, discount_value: true, discount_amount: true, item_type: true,
            is_optional: true, is_selected: true,
          },
          orderBy: { sequence: 'asc' },
        },
        lead: { select: { lead_assignees: { select: { user_id: true } } } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!['SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({
        error: existing.status === ESTIMATE_STATUS.WON
          ? 'Won estimates are frozen — add change-order lines on the invoice or duplicate to a new estimate'
          : 'Only sent estimates can be revised',
      });
      return;
    }

    if (!(await canAccessEstimate(existing, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const revised = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const newEstimateNumber = await allocateNumber(tx, 'estimate', existing.organization_id);

      const newEstimate = await tx.estimate.create({
        data: {
          lead_id: existing.lead_id,
          // R6 (2026-07-22) — same-row recall/supersede (§A2), never a cross-lead operation, so
          // the anchor carries forward verbatim from the source estimate. job_id intentionally
          // NOT copied — see the analogous comment in duplicate() above.
          customer_id: existing.customer_id,
          service_location_id: existing.service_location_id,
          estimate_number: newEstimateNumber,
          status: 'DRAFT',
          organization_id: existing.organization_id,
          created_by: req.user!.id,
          name: existing.name,
          scope_name: existing.scope_name,
          scope_notes: existing.scope_notes,
          // Verbatim carry-forward, same as subtotal/tax_amount/total_amount below — revise is an
          // exact freeze-and-clone (§A2), nothing about the priced content changes, so there's no
          // calculateTotals() call here (unlike create/update/duplicate, which recompute).
          // Freeze-at-send: verbatim EXCEPT the snapshot (see cloneScopesForNewDraft). The new
          // revision is an unsent DRAFT and takes its own snapshot at its own send.
          scopes: cloneScopesForNewDraft(existing.scopes),
          tax_rate: existing.tax_rate,
          discount_type: existing.discount_type,
          discount_value: existing.discount_value,
          discount_name: existing.discount_name,
          discount_amount: existing.discount_amount,
          deposit_type: existing.deposit_type,
          deposit_value: existing.deposit_value,
          subtotal: existing.subtotal,
          tax_amount: existing.tax_amount,
          total_amount: existing.total_amount,
          line_items: {
            create: existing.line_items.map((li) => ({
              sequence: li.sequence,
              description: li.description,
              quantity: li.quantity,
              unit_price: li.unit_price,
              is_taxable: li.is_taxable,
              line_total: li.line_total,
              price_book_item_id: li.price_book_item_id,
              unit_cost: li.unit_cost,
              markup_percent: li.markup_percent,
              discount_type: li.discount_type,
              discount_value: li.discount_value,
              discount_amount: li.discount_amount,
              item_type: li.item_type,
              is_optional: li.is_optional,
              is_selected: li.is_selected,
            })),
          },
        },
        select: estimateDetailSelect,
      });

      await tx.estimate.update({
        where: { id: existing.id },
        // #2090 ruling 17 - the old row is frozen AND its public link is retired. Everything that
        // makes it history (status, superseded_by_id, estimate_number, the priced content) stays;
        // only the customer's door closes. See REVOKE_PUBLIC_LINK.
        data: { status: 'SUPERSEDED', superseded_by_id: newEstimate.id, ...REVOKE_PUBLIC_LINK },
      });

      // The deposit invoice (if any) carries forward unadjusted — it now belongs to whichever
      // estimate is current, so job-creation gating and the deposit-credit-to-final-invoice
      // ledger keep working unchanged against it. Amount is never touched (§A2.3/A2.4).
      await tx.invoice.updateMany({
        where: { estimate_id: existing.id, kind: 'DEPOSIT' },
        data: { estimate_id: newEstimate.id },
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: existing.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'REVISED',
          description: `Estimate ${existing.estimate_number} superseded by ${newEstimateNumber}`,
          created_by: req.user!.id,
        },
      });
      await tx.timelineEvent.create({
        data: {
          organization_id: existing.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: newEstimate.id,
          event_type: 'REVISED',
          description: `Created as a revision of ${existing.estimate_number}`,
          created_by: req.user!.id,
        },
      });

      return newEstimate;
    }), { label: 'estimate.revise' });

    // #2029 — the scope photos follow the document, exactly as they do on duplicate(). OUTSIDE
    // the transaction: copying a Storage object is a live network call, and a revision must not
    // be rolled back because a photo could not be copied.
    const revisedWithPhotos = await withCopiedScopePhotos(
      revised, param(req, 'id'), req.user!.organization_id,
    );

    void logAudit({
      req,
      action: 'estimate.superseded',
      resourceType: 'Estimate',
      resourceId: existing.id,
      metadata: { estimate_number: existing.estimate_number, superseded_by: revised.estimate_number, superseded_by_id: revised.id },
    });
    void logAudit({
      req,
      action: 'estimate.revised_from',
      resourceType: 'Estimate',
      resourceId: revised.id,
      metadata: { estimate_number: revised.estimate_number, revised_from: existing.estimate_number, revised_from_id: existing.id },
    });
    res.json({ estimate: presentEstimateDetail(req, stripEstimateCost(projectEstimateLeadWalkthrough(await resolveEstimatePhotoUrls(revisedWithPhotos)), req)) });
  } catch (err) {
    logger.error('Revise estimate error:', err);
    res.status(500).json({ error: 'Failed to revise estimate' });
  }
}

// §F — "first real AI win": draft a scope-of-work paragraph from the estimate's own line items,
// reusing the existing Servy copilot brain (Gemini/Groq) rather than a new AI integration. Purely
// a suggestion — the caller still has to Apply it via the normal scope_notes PATCH.
export async function draftScope(req: Request, res: Response) {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true,
        created_by: true,
        line_items: { select: { description: true, quantity: true }, orderBy: { sequence: 'asc' } },
        lead: { select: { lead_assignees: { select: { user_id: true } } } },
      },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (estimate.line_items.length === 0) {
      res.status(400).json({ error: 'Add line items before generating a scope draft' });
      return;
    }

    const itemLines = estimate.line_items.map((li) => `- ${li.quantity}x ${li.description}`).join('\n');
    const prompt = `Write a short, professional scope-of-work paragraph (2-4 sentences, no headers, no markdown, no bullet points) for a home-service estimate with these line items:\n${itemLines}\n\nDescribe the work in plain customer-facing language. Do not invent details the line items don't imply.`;

    let result;
    try {
      result = await generateReply({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        systemInstruction: 'You draft scope-of-work descriptions for home-service estimates (HVAC/plumbing/electrical). Be concise, professional, and strictly factual — never invent work not implied by the given line items.',
      });
    } catch (err) {
      if (isBrainNotConfigured(err)) {
        res.status(503).json({ error: 'AI scope draft is not configured for this environment' });
        return;
      }
      throw err;
    }

    void logAudit({ req, action: 'estimate.ai_scope_drafted', resourceType: 'Estimate', resourceId: estimate.id });
    res.json({ scope_text: result.text.trim() });
  } catch (err) {
    logger.error('AI scope draft error:', err);
    res.status(500).json({ error: 'Failed to draft scope of work' });
  }
}

// §G — History tab: field-level diffs surfaced from the existing audit_logs/logAudit trail
// (PR #295), scoped to this estimate. Read-only, org-isolated via org_id (not tenantWhere —
// audit_logs is keyed on org_id, not organization_id).
export async function getHistory(req: Request, res: Response) {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, created_by: true, lead: { select: { lead_assignees: { select: { user_id: true } } } } },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const events = await prisma.auditLog.findMany({
      where: { org_id: req.user!.organization_id, resource_type: 'Estimate', resource_id: estimate.id },
      orderBy: { created_at: 'desc' },
      take: 200,
    });

    res.json({ events });
  } catch (err) {
    logger.error('Get estimate history error:', err);
    res.status(500).json({ error: 'Failed to get estimate history' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/estimates/:id/copy-to-invoice — R5e: copy an Estimate directly into a standalone
// Invoice, independent of the Job pipeline (no Job required) — pure sales-side billing.
//
// Any estimate status is allowed, INCLUDING DRAFT — there is deliberately no status whitelist.
// Blocked with 409 if the estimate already has a Job (this feature is only for estimates that
// never became one — the job pipeline is the other way to bill an estimate) or if a non-VOIDED
// STANDARD invoice already exists for it (one active copy per estimate — prevents duplicate
// double-billing from repeated clicks).
//
// Permission model DELIBERATELY mirrors createStandaloneInvoice's exact two-layer gate — NOT the
// job-anchored create()'s grant-driven per-instance ownership check — because this is a
// standalone document with no job/lead ownership to verify: route-level canDo('create','Invoice')
// (this router's `estimate.routes.ts` mount), plus the identical hardcoded ADMIN/DISPATCHER-only
// check below (same condition, same message as createStandaloneInvoice).
//
// Total fidelity (the new invoice's totals must equal the estimate's own): line items copy their
// discount_type/discount_value/discount_amount/markup_percent 1:1 (unlike the job-anchored
// create()'s known snapshot bug, which drops per-line discounts — NOT replicated here), and
// Estimate.scopes copies onto Invoice.scopes. Both feed recomputeInvoiceTotals with the SAME
// formula estimate.controller.ts's own calculateTotals uses (taxRate/invoiceDiscountAmount =
// the estimate's own tax_rate/discount_amount, taxExempt hardcoded false — calculateTotals never
// applies a tax-exempt override either, so matching that exactly is what makes totals equal).
// SRVW-82: still true - the tax exemption is applied UPSTREAM, to the estimate's own tax_rate at
// create/update/duplicate, so this hardcoded taxExempt:false is arithmetically inert
// (invoice-totals.ts:112 multiplies by the rate) and both documents stay equal for exempt and
// non-exempt customers alike.
class CopyToInvoiceConflictError extends Error {}

// SRVW-86 - ONE message for BOTH job pointers. `Estimate.job` is provenance (Job.estimate_id
// points back); `Estimate.job_id` / `job_link` is the R6 attachment, which a multi-estimate
// conversion (job.controller.ts:1480 leaves estimate_id NULL) and the job-anchored create
// (estimate.controller.ts's create path) both set with NO Job pointing back. Same remedy either
// way: bill it through the job. Keeps the substring 'already has a job' so the existing message
// assertion in estimates.test.ts is not rewritten to go green.
function jobAttachedCopyError(jobNumber?: string | null): string {
  return jobNumber
    ? `This estimate already has a job (${jobNumber}) - invoice it from that job instead of copying it to a standalone invoice.`
    : 'This estimate already has a job - invoice it from that job instead of copying it to a standalone invoice.';
}

export async function copyToInvoice(req: Request, res: Response) {
  const role = req.user?.role;
  if (role !== 'ADMIN' && role !== 'DISPATCHER') {
    res.status(403).json({ error: 'Not authorized to create a standalone invoice' });
    return;
  }

  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: {
        id: true,
        job: { select: { id: true, job_number: true } },
        // SRVW-86 - the R6 attachment. The scalar is what the guard rejects on (a relation that
        // fails to hydrate must not open the door); `job_link` only supplies the job's number.
        job_id: true,
        job_link: { select: { id: true, job_number: true } },
        tax_rate: true,
        discount_amount: true,
        labor_hours: true,
        overhead_mode: true,
        overhead_value: true,
        scopes: true,
        // SERV10X-61 (MONEY-PATH) - direct anchor (R6) so a lead-less estimate still resolves the
        // customer_id the copied invoice is billed to, and the customer's payment_type for the due
        // date. Falls back through the lead for lead-anchored rows.
        customer_id: true,
        customer: { select: { payment_type: true } },
        lead: {
          select: {
            customer_id: true,
            customer: { select: { payment_type: true } },
          },
        },
        line_items: {
          select: {
            sequence: true,
            description: true,
            quantity: true,
            unit_price: true,
            is_taxable: true,
            line_total: true,
            discount_type: true,
            discount_value: true,
            discount_amount: true,
            markup_percent: true,
            unit_cost: true,
            item_type: true,
            price_book_item_id: true,
            // #2090 - read so the copy can be filtered to what the customer took. InvoiceLineItem
            // has neither column; these never reach the write (see lineCreates below).
            is_optional: true,
            is_selected: true,
          },
          orderBy: { sequence: 'asc' as const },
        },
      },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (estimate.job) {
      res.status(409).json({
        error: 'This estimate already has a job — copy-to-invoice is only available for estimates that never became a job.',
      });
      return;
    }

    // SRVW-86 - the R6 attachment (Estimate.job_id / job_link) is a second job pointer the
    // provenance relation above cannot see. Reject on the scalar so a relation that failed to
    // hydrate never opens the door.
    if (estimate.job_id) {
      res.status(409).json({ error: jobAttachedCopyError(estimate.job_link?.job_number) });
      return;
    }

    const existingActive = await prisma.invoice.findFirst({
      where: { estimate_id: estimate.id, kind: 'STANDARD', status: { not: 'VOIDED' }, ...tenantWhere(req) },
      select: { invoice_number: true },
    });
    if (existingActive) {
      res.status(409).json({
        error: `This estimate already has an invoice (${existingActive.invoice_number}). Void it first or edit the existing one.`,
      });
      return;
    }

    const customerId = estimate.lead?.customer_id ?? estimate.customer_id ?? null;
    if (!customerId) {
      res.status(400).json({ error: 'Estimate has no associated customer' });
      return;
    }

    // #2090 slice 3d - SELECTED rows only, filtered HERE so `forTotals`, `lineCreates` and
    // `scopeBlocksForInvoice` below all see the same, already-narrowed set. An add-on the
    // customer declined is not work this invoice is billing for.
    const lineItems = (estimate.line_items ?? []).filter(countsTowardTotals);
    const scopeBlocks = asScopeArray(estimate.scopes).filter(countsTowardTotals);
    // #2053 R2 (blocking) — strip the estimate-only flags BEFORE they land on Invoice.scopes.
    // toScopeForTotals below stays flag-blind regardless (it only ever projects
    // flat_price/is_taxable), but scopeBlocks itself carries whatever the raw JSONB column has,
    // and the write below persists scopeBlocks verbatim onto the new invoice — carrying the keys
    // there would make an INVOICE's own totals silently selection-filtered the next time
    // invoice-lines.controller.ts recomputes them (see the rationale in Solution §2).
    //
    // `rep_selected` is the third such flag and goes with them, under the same R2 rule. It
    // costs an invoice nothing arithmetically (nothing invoice-side reads it), but it is a record
    // of what a SALESPERSON offered on an ESTIMATE, and an invoice is neither. Leaving it would
    // park stale estimate state on a different entity for a later reader to misread.
    const scopeBlocksForInvoice = stripScopeSendSnapshot(
      scopeBlocks.map(({ is_optional: _isOptional, is_selected: _isSelected, ...rest }) => rest),
    );

    const forTotals: LineForTotals[] = lineItems.map((li) => ({
      quantity: Number(li.quantity),
      unit_price: Number(li.unit_price),
      is_taxable: li.is_taxable,
      discount_type: li.discount_type ?? null,
      discount_value: li.discount_value == null ? null : Number(li.discount_value),
    }));

    const totals = recomputeInvoiceTotals({
      lines: forTotals,
      scopes: toScopeForTotals(scopeBlocks),
      taxRate: Number(estimate.tax_rate || 0),
      taxExempt: false,
      invoiceDiscountAmount: Number(estimate.discount_amount || 0),
    });

    const lineCreates: Prisma.InvoiceLineItemCreateWithoutInvoiceInput[] = lineItems.map((li) => ({
      sequence: li.sequence,
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unit_price,
      is_taxable: li.is_taxable,
      line_total: li.line_total,
      discount_type: li.discount_type,
      discount_value: li.discount_value,
      discount_amount: li.discount_amount,
      markup_percent: li.markup_percent,
      unit_cost: li.unit_cost,
      item_type: li.item_type,
      price_book_item_id: li.price_book_item_id,
      // Invoice-only defaults — no job in this flow, so no job-line back-pointer or stock state.
      stock_status: 'NOT_TRACKED' as const,
      stock_location_id: null,
      job_line_item_id: null,
    }));

    const dueDate = calculateDueDate((estimate.lead?.customer ?? estimate.customer)?.payment_type ?? null, new Date());

    const invoice = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNumber(tx, 'invoice', req.user!.organization_id);

      // Deposit-credit draw-down — verbatim mirror of invoice.controller.ts's create() (and
      // createInvoiceFromJob's identical mirror of it): find the PAID kind=DEPOSIT invoice for
      // this estimate, credit min(remaining, total) as a POST-TAX Payment (never a discount line).
      let depositCredit = 0;
      let depInvId: string | null = null;
      const depInv = await tx.invoice.findFirst({
        where: { estimate_id: estimate.id, kind: 'DEPOSIT', status: 'PAID', ...tenantWhere(req) },
        select: { id: true },
      });
      if (depInv) {
        depInvId = depInv.id;
        const remaining = await remainingDepositCredit(tx, depInv.id);
        depositCredit = Math.round(Math.min(Math.max(remaining, 0), totals.total_amount) * 100) / 100;
      }
      const amountDue = Math.round((totals.total_amount - depositCredit) * 100) / 100;

      // TOCTOU guard (independent review) — the pre-transaction job/duplicate-invoice checks
      // above read state from BEFORE this transaction opened, so two concurrent requests (e.g.
      // a double-click) can both pass them. Re-verify against a fresh read taken INSIDE the
      // transaction, right before the invoice is created — mirrors job.controller.ts's
      // createInvoiceFromJob over-bill re-check (same rationale, same placement).
      const [freshJob, freshActive] = await Promise.all([
        tx.estimate.findUnique({
          where: { id: estimate.id },
          select: {
            job: { select: { id: true } },
            // SRVW-86 - same second pointer, re-checked inside the transaction.
            job_id: true,
            job_link: { select: { job_number: true } },
          },
        }),
        tx.invoice.findFirst({
          where: { estimate_id: estimate.id, kind: 'STANDARD', status: { not: 'VOIDED' }, ...tenantWhere(req) },
          select: { invoice_number: true },
        }),
      ]);
      if (freshJob?.job) {
        throw new CopyToInvoiceConflictError(
          'This estimate already has a job — copy-to-invoice is only available for estimates that never became a job.'
        );
      }
      if (freshJob?.job_id) {
        throw new CopyToInvoiceConflictError(jobAttachedCopyError(freshJob.job_link?.job_number));
      }
      if (freshActive) {
        throw new CopyToInvoiceConflictError(
          `This estimate already has an invoice (${freshActive.invoice_number}). Void it first or edit the existing one.`
        );
      }

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          organization_id: req.user!.organization_id,
          job_id: null,
          estimate_id: estimate.id,
          customer_id: customerId,
          kind: 'STANDARD',
          status: 'DRAFT',
          subtotal: totals.subtotal,
          discount_amount: Number(estimate.discount_amount || 0),
          tax_rate: Number(estimate.tax_rate || 0),
          tax_amount: totals.tax_amount,
          deposit_credit: depositCredit,
          total_amount: totals.total_amount,
          amount_due: amountDue,
          due_date: dueDate,
          // Copy the estimate's cost basis onto the new invoice — same copy-on-conversion
          // precedent as Estimate → Job (job.controller.ts) / job.controller.ts's job → invoice.
          labor_hours: estimate.labor_hours,
          overhead_mode: estimate.overhead_mode,
          overhead_value: estimate.overhead_value,
          // as unknown as Prisma.InputJsonValue: matches invoice-lines.controller.ts's own scopes
          // write convention. scopeBlocks (asScopeArray-normalized) rather than the raw
          // estimate.scopes — a JSONB column reads back `null` (not `[]`) when never populated,
          // and Prisma's Json field rejects a bare `null` on create (NullableJsonNullValueInput
          // is required for an explicit null) — the normalized array sidesteps that entirely.
          scopes: scopeBlocksForInvoice as unknown as Prisma.InputJsonValue,
          line_items: { create: lineCreates },
          // Audit: the user performing the copy-to-invoice, never the estimate's own author.
          ...createdByUser(req),
        },
        select: invoiceDetailSelect,
      });

      if (depositCredit > 0 && depInvId) {
        const applied = await applyDepositCredit(tx, depInvId, created.id, totals.total_amount, req.user!.organization_id);
        if (applied > 0) {
          await tx.payment.create({
            data: {
              invoice_id: created.id,
              amount: applied,
              method: 'CARD',
              paid_at: new Date(),
              collected_by: null,
              reference_number: DEPOSIT_CREDIT_REFERENCE,
              notes: 'Deposit credit applied from estimate deposit',
              // Audit: a synthetic ledger row the platform mints, not money anyone collected -
              // same case as lib/deposit-credit.ts's drawdown payment.
              ...CREATED_BY_SYSTEM,
            },
          });
        }
      }

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${invoiceNumber} created`,
          created_by: req.user?.id,
        },
      });

      return created;
    }), { label: 'estimate.invoice.create' });

    void logAudit({
      req,
      action: 'invoice.created',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      metadata: { invoice_number: invoice.invoice_number, estimate_id: estimate.id },
    });
    // Nice-to-have: note this on the ESTIMATE's own history too — getHistory (above) reads
    // auditLog scoped to resource_type 'Estimate', so a 2nd logAudit call (no new machinery)
    // against the estimate is enough to surface "invoice created from this estimate" there.
    void logAudit({
      req,
      action: 'estimate.invoice_copied',
      resourceType: 'Estimate',
      resourceId: estimate.id,
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
    });

    // #2030 slice 2 — freeze the document the invoice was built FROM. That record is what makes
    // a payment reconcilable against what was actually quoted; without it the estimate can be
    // edited afterwards and nothing says what the invoice was copied from.
    void mintEstimateVersion({
      estimateId: estimate.id,
      orgId: req.user!.organization_id,
      trigger: 'COPY_TO_INVOICE',
    });

    res.status(201).json({ invoice: presentInvoiceDetail(req, invoice) });
  } catch (err) {
    if (err instanceof CopyToInvoiceConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error('Error copying estimate to invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Public Handlers (No Auth) ─────────────────────────

/**
 * #904/#927 - is CARD actually chargeable for this org right now?
 *
 * Two independent ways it can be false, and the endpoint must defend against both:
 *  - `stripe_charges_enabled` is the mirrored-from-Stripe truth and can flip false between the
 *    estimate being sent and the customer submitting it (mid-onboarding, deauthorized, restricted).
 *  - an `available_payment_methods` AppSetting override can exclude CARD even while charges are
 *    genuinely enabled.
 *
 * Delegates to invoice.controller's resolver rather than re-deriving the chain, so the estimate
 * and invoice public flows can never disagree about what is payable.
 */
function cardIsPayable(
  methodsSettingValue: string | null | undefined,
  org: { accepted_payment_methods: unknown; stripe_charges_enabled: boolean } | null | undefined,
): boolean {
  return resolveAvailablePaymentMethods(methodsSettingValue, org).includes('CARD');
}

export async function getPublic(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const estimate = await prisma.estimate.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: estimatePublicSelect,
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // Fetch settings and org in parallel (use estimate's own org_id — public route has no req.user)
    const estOrgId = (estimate as any).organization_id as string;
    const [termsSetting, bankTransferSetting, checkSetting, cashSetting, methodsSetting, org] = await Promise.all([
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: estOrgId, key: 'estimate_terms' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: estOrgId, key: 'bank_transfer_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: estOrgId, key: 'check_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: estOrgId, key: 'cash_instructions' } } }),
      prisma.appSetting.findUnique({ where: { organization_id_key: { organization_id: estOrgId, key: 'available_payment_methods' } } }),
      prisma.organization.findUnique({ where: { id: estOrgId } }),
    ]);

    // #904/#927 - the page must not offer a CARD button that cannot be charged. send_config
    // records what the sender OFFERED at send time; whether CARD is actually payable NOW is the
    // org's resolved accepted-methods list (charges enabled + not excluded by an AppSetting
    // override), which can change after the estimate goes out. Only CARD is filtered: the other
    // methods are manual and stay valid whatever Stripe is doing. approvePublic re-runs this
    // exact resolution, so what the page shows and what the endpoint accepts cannot diverge.
    if (!cardIsPayable(methodsSetting?.value, org)) {
      const sendConfig = (estimate as any).send_config;
      if (sendConfig?.payment_methods) {
        sendConfig.payment_methods = (sendConfig.payment_methods as string[]).filter((m) => m !== 'CARD');
      }
    }

    const organization = org ? {
      name: org.name,
      logo_url: org.logo_url,
      brand_color: org.brand_color,
      email: org.email,
      phone: org.phone,
      website: org.website,
      // #21 — prefer the send-time snapshot so FE gate == server gate; live terms only for
      // legacy rows that predate snapshot_terms.
      estimate_terms: (estimate as any).snapshot_terms ?? org.estimate_terms,
      // §4.5 — public page no longer needs an org-level Stripe flag.
      // CARD-vs-EXTERNAL_CARD routing happens off send_config.payment_methods,
      // which is already part of the estimate payload above.
    } : null;

    const expired = estimate.valid_until ? new Date(estimate.valid_until) < new Date() : false;

    // Slice 4 — display-only preview so the public page can render the Service Fee row before
    // redirect (D8). Only meaningful when a deposit is actually required — no deposit means no
    // Stripe checkout, and therefore no fee (D6: computed only in the two checkout-creation paths).
    const depositInvoice = (estimate as any).invoices?.[0];
    const depositRequired = !!((estimate as any).send_config?.deposit_required && depositInvoice);
    const depositBasisCents = depositRequired ? Math.round(Number(depositInvoice.total_amount) * 100) : 0;
    // The only condition left is "is there a deposit to charge" - never who the org is.
    const serviceFeeBps = depositRequired ? CARD_SERVICE_FEE_BPS : 0;
    const serviceFeePreview = depositRequired ? computeServiceFee(depositBasisCents, CARD_SERVICE_FEE_BPS) / 100 : 0;

    res.json({
      // #1997 — a fail-closed BACKSTOP, not the protection itself. This route is unauthenticated,
      // so there is no requester to judge and the presenter can only answer "not readable"; what
      // actually keeps the customer's contact off this payload is `estimatePublicSelect`, which
      // never projects it. Applied anyway so that a future widening of the shared document
      // projection is stripped here rather than served, and so this site reads like every other
      // detail-shaped one (the source-scanning guard checks exactly that).
      estimate: presentEstimateDetail(req, await presentPublicEstimate(estimate)),
      organization,
      terms: termsSetting?.value ?? null,
      payment_instructions: {
        bank_transfer: bankTransferSetting?.value ?? null,
        check: checkSetting?.value ?? null,
        cash: cashSetting?.value ?? null,
      },
      expired,
      service_fee_bps: serviceFeeBps,
      service_fee_preview: serviceFeePreview,
    });
  } catch (err) {
    logger.error('Get public estimate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── #2090 slice 3b - the customer's own selection ────────────────────────────────────────────

/**
 * The body of `PATCH /api/estimates/:id/public/selections` and the optional `selections` rider on
 * `POST /api/estimates/:id/approve`.
 *
 * `is_optional` is deliberately NOT a key. This is an UNAUTHENTICATED write door: the customer
 * may say which add-ons they want, never which rows are add-ons in the first place. Zod strips
 * what it does not declare, so a payload carrying it is not "ignored by the controller" - the key
 * never reaches the controller at all.
 *
 * A scope block is addressed by its uuid `id`, never by its index: a reorder renumbers indices,
 * and `estimate-selection-timeline.test.ts` already establishes `scope_id` as the stable handle.
 */
const publicSelectionSchema = z.object({
  kind: z.enum(['line', 'scope']),
  id: z.string().uuid(),
  is_selected: z.boolean(),
});

export const publicSelectionsSchema = z.object({
  selections: z.array(publicSelectionSchema).min(1).max(200),
});

export type PublicSelection = z.infer<typeof publicSelectionSchema>;

/**
 * Everything both selection doors need about the estimate they are about to write to: the rows
 * the payload may name, the inputs the totals recompute needs, and the deposit row the lock and
 * the re-price read.
 */
const selectionTargetSelect = {
  id: true,
  organization_id: true,
  estimate_number: true,
  status: true,
  valid_until: true,
  tax_rate: true,
  discount_type: true,
  discount_value: true,
  deposit_type: true,
  deposit_value: true,
  total_amount: true,
  scopes: true,
  line_items: {
    select: { id: true, description: true, is_optional: true, is_selected: true },
    orderBy: { sequence: 'asc' as const },
  },
  // The DEPOSIT row the re-price and the page's deposit block read. It no longer feeds the
  // SELECTION lock: the 2026-09-18 revision took the deposit out of that predicate.
  invoices: {
    where: { kind: 'DEPOSIT' as const },
    select: { id: true, kind: true, status: true, total_amount: true, amount_due: true },
    take: 1,
  },
} as const;

type SelectionTarget = {
  id: string;
  organization_id: string;
  estimate_number: string;
  status: string;
  valid_until: Date | null;
  tax_rate: unknown;
  discount_type: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value: unknown;
  deposit_type: 'PERCENTAGE' | 'FIXED' | null;
  deposit_value: unknown;
  total_amount: unknown;
  scopes: unknown;
  line_items: { id: string; description: string; is_optional: boolean; is_selected: boolean }[];
  invoices: { id: string; kind: string; status: string; total_amount: unknown; amount_due: unknown }[];
};

/**
 * The security rules for the public write, all of them, in one place. Returns the response to
 * send, or null when the payload may proceed.
 *
 *  - Every id must belong to THIS estimate. A foreign or invented one gets the SAME 404 a wrong
 *    token gets: an unauthenticated caller must not be able to learn that an id exists.
 *  - Only a row the rep marked optional may be touched. A payload naming a required line is
 *    REFUSED, never silently dropped - a customer who thinks they removed something must be told
 *    they did not.
 */
export function rejectCustomerSelections(
  estimate: Pick<SelectionTarget, 'line_items' | 'scopes'>,
  selections: PublicSelection[],
): { status: number; body: Record<string, string> } | null {
  const scopes = asScopeArray(estimate.scopes);
  for (const sel of selections) {
    const stored = sel.kind === 'line'
      ? estimate.line_items.find((l) => l.id === sel.id)
      : scopes.find((s) => s.id === sel.id);
    if (!stored) return { status: 404, body: { error: 'Estimate not found' } };
    if (stored.is_optional !== true) {
      return {
        status: 400,
        body: {
          error: 'NOT_OPTIONAL',
          message: 'That item is part of this estimate and cannot be removed.',
        },
      };
    }
  }
  return null;
}

/**
 * Write the customer's ticks, then recompute the document from what is now stored.
 *
 * `is_selected` is the ONLY column written. `is_optional` is not merged, defaulted or normalised
 * here: every row this reaches has already been proved optional by `rejectCustomerSelections`,
 * so the "non-optional implies selected" rule has nothing to do.
 *
 * Deliberately WITHOUT `materialChangeGuardrail` / `pendingRevertOnMaterialChange`, which every
 * STAFF write path applies when the totals move. That ceremony exists to protect the customer
 * from an edit made behind their back: it bumps the version, raises modified_after_send and NULLS
 * `public_token`. Applying it to the customer's own tick would destroy the link they are holding
 * in the middle of their decision, and void the signature of a PENDING estimate they themselves
 * signed. The arithmetic is shared (`recomputeEstimateTotals`); the ceremony is not, on purpose.
 */
async function commitCustomerSelections(
  tx: Prisma.TransactionClient,
  estimate: SelectionTarget,
  selections: PublicSelection[],
): Promise<{ total_amount: unknown }> {
  for (const sel of selections) {
    if (sel.kind !== 'line') continue;
    await tx.estimateLineItem.update({
      where: { id: sel.id, estimate_id: estimate.id },
      data: { is_selected: sel.is_selected },
    });
  }

  // Re-read the CURRENT scopes column inside the tx rather than trusting the pre-transaction
  // snapshot - same convention as estimate-lines.controller.ts's own scope handlers.
  const current = await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } });
  const scopes = asScopeArray(current?.scopes);
  if (selections.some((s) => s.kind === 'scope')) {
    for (const sel of selections) {
      if (sel.kind !== 'scope') continue;
      const i = scopes.findIndex((s) => s.id === sel.id);
      if (i >= 0) scopes[i] = { ...scopes[i], is_selected: sel.is_selected };
    }
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { scopes: scopes as unknown as Prisma.InputJsonValue },
    });
  }

  const lines = (await tx.estimateLineItem.findMany({
    where: { estimate_id: estimate.id },
    orderBy: { sequence: 'asc' },
  })) ?? [];
  const freshScopes = asScopeArray(
    (await tx.estimate.findUnique({ where: { id: estimate.id }, select: { scopes: true } }))?.scopes,
  );
  const { subtotal, taxAmount, totalAmount, estimateDiscountAmount } = recomputeEstimateTotals(
    lines as never[],
    estimate,
    freshScopes,
  );

  return tx.estimate.update({
    where: { id: estimate.id },
    data: {
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      discount_amount: estimateDiscountAmount,
    },
    select: { total_amount: true },
  });
}

/**
 * The whole public selection write, shared by the standalone endpoint and by `approvePublic`'s
 * `selections` rider: lock, validate, write, recompute, re-price the deposit.
 *
 * Returns the estimate's DEPOSIT invoice as it stands AFTER the write - which is the point of
 * running this before `approvePublic` reads the deposit at all: branches 2 and 3 must mint their
 * checkout against the total the customer just accepted, not the one the estimate was sent with.
 *
 * Returns null after having already written the error response.
 */
/**
 * #2090 - thrown INSIDE the selection transaction to roll it back when the deposit cannot follow
 * the customer's choice. A named class, not a string, so the handler can tell it from a genuine
 * failure and answer 409 rather than 500.
 */
class DepositPartPaidError extends Error {
  constructor() {
    super('Deposit already part-paid');
    this.name = 'DepositPartPaidError';
  }
}

async function applyCustomerSelections(
  req: Request,
  res: Response,
  estimateId: string,
  selections: PublicSelection[],
): Promise<{ depositInvoice: SelectionTarget['invoices'][number] | undefined } | null> {
  const estimate = (await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: selectionTargetSelect,
  })) as unknown as SelectionTarget | null;
  if (!estimate) {
    res.status(404).json({ error: 'Estimate not found' });
    return null;
  }

  if (areSelectionsLocked(estimate)) {
    res.status(409).json(optionsLockedBody(estimate));
    return null;
  }

  const rejection = rejectCustomerSelections(estimate, selections);
  if (rejection) {
    res.status(rejection.status).json(rejection.body);
    return null;
  }

  const org = await prisma.organization.findUnique({ where: { id: estimate.organization_id } });

  let reprice: DepositRepriceResult | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      const { total_amount } = await commitCustomerSelections(tx, estimate, selections);

      // AC4 - "recomputes totals AND the outstanding deposit". The deposit document was minted at
      // send time against the sent total; the customer has just changed that total, so the figure
      // they are about to be asked for has to move with it. Same helper the re-send path uses, so
      // an unpaid deposit is re-priced and a settled one is refused with no write at all.
      const deposit = await tx.invoice.findFirst({
        where: { estimate_id: estimate.id, kind: 'DEPOSIT', organization_id: estimate.organization_id },
        select: { id: true, invoice_number: true, status: true, total_amount: true, _count: { select: { payments: true } } },
      });
      if (deposit) {
        const { dType, depositAmount, depositPercent } = resolveDepositAmount(
          { deposit_type: estimate.deposit_type, deposit_value: estimate.deposit_value, total_amount },
          org,
        );
        reprice = await repriceUnpaidDepositInvoice(
          tx,
          estimate.estimate_number,
          deposit as never,
          dType,
          depositAmount,
          depositPercent,
        );
        // #2090 - the deposit has money against it, so the re-price refused, correctly: writing
        // over a customer's payment is worse than anything this endpoint is for. The SELECTION
        // must then refuse too, and roll back. Committing it would leave the estimate's total
        // moved and the deposit still priced off the total before it, which is exactly the
        // divergence the re-price exists to prevent, reached from the other side. ALREADY_CURRENT
        // is not a refusal (the figure is already right), so only SETTLED throws.
        if (!reprice.changed && reprice.reason === 'SETTLED') {
          throw new DepositPartPaidError();
        }
        // The send-time snapshot is what every SURFACE reads the deposit off (frontend
        // `resolveDepositState` prefers `send_config.deposit_amount` over the invoice's own
        // total), while `approvePublic`'s card branch charges the INVOICE. Moving one without the
        // other would show the customer one deposit and bill another - the exact divergence
        // `frontend/src/lib/deposit.ts`'s header exists to warn about. Only when the re-price
        // actually moved the figure.
        if (reprice.changed) {
          await tx.estimateSendConfig.updateMany({
            where: { estimate_id: estimate.id },
            data: { deposit_amount: depositAmount, deposit_percentage: round2(depositPercent) },
          });
        }
      }
    });
  } catch (err) {
    if (!(err instanceof DepositPartPaidError)) throw err;
    // The same 409 shape as every other locked-selection refusal, so the page needs no second
    // branch and the customer reads one kind of sentence about one kind of situation.
    res.status(409).json({ error: OPTIONS_LOCKED, message: DEPOSIT_PART_PAID_MESSAGE });
    return null;
  }

  // Post-commit, never inside the transaction: the old figure's open checkout has to die with it,
  // and reaching the processor cannot be allowed to roll back the customer's own choice.
  if (reprice?.changed) {
    await expireDepositCheckoutsAfterReprice(reprice.invoiceId, estimate.organization_id);
  }

  void logAudit({
    req,
    orgId: estimate.organization_id,
    actorId: null,
    action: 'estimate.selections_changed',
    resourceType: 'Estimate',
    resourceId: estimate.id,
    metadata: { count: selections.length, via: 'public_token' },
  });

  const refreshed = (await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { invoices: selectionTargetSelect.invoices },
  })) as unknown as { invoices: SelectionTarget['invoices'] } | null;

  return { depositInvoice: refreshed?.invoices?.[0] };
}

/**
 * PATCH /api/estimates/:id/public/selections?token=
 *
 * The customer's own tick, persisted on change and before the lock. Unauthenticated: the token in
 * the URL is the only credential, compared exactly as `getPublic` compares it (no token → 400,
 * wrong token → 404). Rate-limited by `publicSelectionLimiter` rather than `publicActionLimiter`:
 * approve happens once, a decision session does not.
 *
 * The response is built by `presentPublicEstimate`, the same presenter `getPublic` uses, so it
 * cannot carry a cost field this door forgot to strip.
 *
 * No notification is written. A rep's tick writes none (slice 1b) and neither does a customer's;
 * the timeline event is the record.
 */
export async function updatePublicSelections(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const estimate = await prisma.estimate.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: { id: true, status: true, valid_until: true },
    });
    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // The same three statuses the document is live in for the customer. The "after acceptance,
    // before lock" window this list used to be widened for is gone: since the 2026-09-18 revision
    // a WON estimate is locked the moment it is signed. WON STAYS here all the same, and must,
    // because this gate runs FIRST - drop it and a signed estimate is turned away with a generic
    // 400 instead of reaching `areSelectionsLocked` and answering 409 OPTIONS_LOCKED, which is
    // the refusal the page knows how to explain. It is a pass-through to the lock, not a permit.
    if (!['SENT', 'PENDING', 'WON'].includes(estimate.status)) {
      res.status(400).json({ error: `Cannot change selections on a ${estimate.status.toLowerCase()} estimate` });
      return;
    }
    if (estimate.valid_until && new Date(estimate.valid_until) < new Date()) {
      res.status(400).json({ error: 'Estimate has expired' });
      return;
    }

    const { selections } = req.body as z.infer<typeof publicSelectionsSchema>;
    const applied = await applyCustomerSelections(req, res, estimate.id, selections);
    if (!applied) return;

    const fresh = await prisma.estimate.findFirst({
      where: { id: estimate.id },
      select: estimatePublicSelect,
    });
    res.json({ estimate: presentEstimateDetail(req, await presentPublicEstimate(fresh)) });
  } catch (err) {
    logger.error('Public estimate selection error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function approvePublic(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const parsed = approvePublicSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Signature is required' });
      return;
    }
    const { signature_data, payment_method, terms_accepted, selections } = parsed.data;
    // Format check only when one was supplied. Whether a signature is REQUIRED depends on the
    // estimate's status (a payment retry is already signed) and is enforced below, once the row
    // has been loaded.
    if (signature_data !== undefined && !signature_data.startsWith('data:image/')) {
      res.status(400).json({ error: 'Invalid signature format' });
      return;
    }
    // F-24: capture the trust-proxy-resolved client IP (app.set('trust proxy', 1) in app.ts),
    // never the raw X-Forwarded-For header. The raw header is attacker-controlled — a client can
    // prepend spoofed hops ("<spoofed>, <realproxyip>") and poison the signing audit record.
    // req.ip applies the trust-proxy hop count and yields the correct client address.
    const signatureIp = req.ip ?? null;

    const existing = await prisma.estimate.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true,
        organization_id: true,
        total_amount: true, valid_until: true, signature_data: true,
        snapshot_terms: true,   // #21 — authoritative "did THIS estimate present terms"
        // The kind=DEPOSIT Invoice is the SOLE deposit document (legacy Deposit gone).
        invoices: {
          where: { kind: 'DEPOSIT' as const },
          select: { id: true, status: true, total_amount: true, amount_due: true },
          take: 1,
        },
        send_config: { select: { deposit_required: true, payment_methods: true } },
        organization: { select: { id: true, stripe_account_id: true, accepted_payment_methods: true, stripe_charges_enabled: true } },
        // Notification: commission_owner_id needed for entity routing.
        lead: { select: { commission_owner_id: true, status: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // D6 (2026-07-21): PENDING means "customer approved + signed, deposit not yet processed".
    // It is therefore a legitimate RE-ENTRY point, not a terminal state: a customer who signed
    // and then abandoned the card checkout returns here to retry payment. SENT = first approval
    // (captures the signature); PENDING = payment retry (signature is preserved, never
    // re-captured, so the original consent record is immutable).
    if (existing.status !== 'SENT' && existing.status !== 'PENDING') {
      res.status(400).json({ error: `Cannot approve a ${existing.status.toLowerCase()} estimate` });
      return;
    }
    // Keyed on the signature ON FILE, not on the status alone. Under Spec B1 staff can set PENDING
    // by hand (PATCH /:id/status), and such a row is honestly unsigned — this route is still the
    // only thing that ever captures a signature. Keying off `status === 'PENDING'` alone would
    // treat a hand-set PENDING as "already signed", skip capture, and let the estimate reach WON
    // with no consent record at all. A genuine retry (customer signed, then abandoned checkout)
    // has signature_data set and still skips re-capture, keeping the original consent immutable.
    const isPaymentRetry = existing.status === 'PENDING' && existing.signature_data != null;

    // Signature is mandatory for a first-time approval. On a retry the estimate is already
    // signed, so re-sending it is neither required nor honoured (the stored consent wins).
    if (!isPaymentRetry && !signature_data) {
      res.status(400).json({ error: 'Signature is required' });
      return;
    }

    // Check expiration — skipped on a payment retry: the customer already accepted while the
    // estimate was live, so a validity window that lapsed afterwards must not strand their
    // outstanding deposit. (Matching reason the expiration sweep no longer touches PENDING.)
    if (!isPaymentRetry && existing.valid_until && new Date(existing.valid_until) < new Date()) {
      res.status(400).json({ error: 'Estimate has expired' });
      return;
    }

    // #21 — T&C gate. Consent is evaluated against the terms PRESENTED at send time
    // (snapshot_terms, captured in send() at line ~1042), so a post-send edit/blank of
    // the org's live terms cannot let an in-flight estimate approve against the wrong terms.
    if (existing.snapshot_terms && existing.snapshot_terms.trim() !== '' && terms_accepted !== true) {
      res.status(400).json({ error: 'Terms acceptance is required' });
      return;
    }

    // Computed once here; used in all three approve branches to persist acceptance consistently.
    const termsApplied = !!(existing.snapshot_terms && existing.snapshot_terms.trim() !== '');

    // Every refusal these four gates answer with runs HERE, before the selections rider writes a
    // single row. A refused approval must leave the document exactly as it found it.
    //
    // It did not. The rider used to be applied first, so a 400 out of the gates below still
    // committed the customer's ticks, recomputed subtotal/tax/total and re-priced the unpaid
    // deposit behind them - permanently, once per attempt. Measured on staging 2026-09-18: two
    // consecutive refusals walked one estimate's total 1485 -> 1925 -> 2255 while the customer
    // was never approved and never told their quote had moved.
    //
    // Read that first line narrowly, because it is not a guarantee about the whole handler. A
    // THROW after the rider still leaves the rider committed: branch 2 stamps the estimate
    // PENDING and then reaches the payment processor with no try/catch of its own, so a
    // processor failure answers 500 from the outer catch with the total already moved, and a
    // database error in any branch does the same. Unwinding that needs a compensating write
    // rather than a reordering, and it is not reachable by a caller who could not also pay, so
    // it is deliberately left alone here rather than half-solved.
    //
    // Validate-first rather than roll-back-on-refusal, because the selection write is NOT a
    // single transaction: `applyCustomerSelections` commits, then reaches the payment processor
    // to expire the superseded checkout and writes an audit row, both deliberately outside the
    // transaction (see its own comments). A rollback would have to unwind those too. These four
    // gates, by contrast, read nothing the rider can change: `send_config` and the org's
    // payability are fixed for the request, and the DEPOSIT invoice's EXISTENCE is invariant
    // across the rider - the re-price moves that row's figure, it never creates or deletes it -
    // so `depositRequired` is the same answer before and after.
    //
    // One answer does change, deliberately. A request that is invalid in both ways at once, a
    // bad payment method AND a rider naming a foreign or non-optional line, used to get the
    // rider's refusal (404, or 400 NOT_OPTIONAL, or 409 OPTIONS_LOCKED) and now gets the payment
    // refusal instead. Telling the customer what is wrong with the method they picked beats
    // telling them about a rider their browser never sent.
    const depositRequired = !!existing.invoices?.[0] && existing.send_config?.deposit_required === true;

    // If deposit is required, payment_method must be provided
    if (depositRequired && !payment_method) {
      res.status(400).json({ error: 'Payment method is required' });
      return;
    }

    // Validate payment method is in send_config.payment_methods
    if (depositRequired && payment_method) {
      const allowedMethods = (existing.send_config!.payment_methods as string[]) || [];
      if (!allowedMethods.includes(payment_method)) {
        res.status(400).json({ error: 'Payment method not available' });
        return;
      }
    }

    // #904/#927 - CARD must be REJECTED, never quietly re-routed, when it is not payable.
    // Before this guard, a CARD request on an org whose charges had been disabled fell through
    // to Branch 3: the estimate was stamped PENDING and the request returned 200, so the
    // homeowner saw success while no card was ever charged and no checkout was created.
    // getPublic now strips CARD from the offered methods in exactly this state (same resolver),
    // so a customer using the page cannot reach here - this is the backstop for direct API
    // calls. The 400 shape matches invoice.controller's createPublicCheckout, which the public
    // estimate page already maps to friendly homeowner copy.
    if (depositRequired && payment_method === 'CARD') {
      const methodsSetting = await prisma.appSetting.findUnique({
        where: { organization_id_key: { organization_id: existing.organization_id, key: 'available_payment_methods' } },
      });
      if (!cardIsPayable(methodsSetting?.value, existing.organization)) {
        res.status(400).json({ error: 'Card payments are not enabled for this organization' });
        return;
      }
      // Hoisted out of Branch 2 to join the other refusals: the processor being unconfigured is
      // a refusal like any other, and it used to fire AFTER the rider had already moved the
      // total. Same condition it had there (Branch 2 is reached only when a deposit is required
      // and the method is CARD), same message, so nothing about the answer changes - only when
      // it is given. This is the only gate whose place in the control flow moved, so it is
      // pinned directly by estimate-approve-refused-leaves-total-alone.test.ts, which has to
      // stub the processor as unconfigured because the shared test setup reports it configured.
      if (!isStripeConfigured()) {
        res.status(400).json({ error: 'Card payment is not available' });
        return;
      }
    }

    // #2090 slice 3b - the customer's selections are applied and the document recomputed HERE,
    // once the approval is known to be going through, and BEFORE the deposit is read a line
    // below and before any of the three branches writes a status. That second half of the order
    // is still the whole point: branch 1 wins the estimate at the accepted total, and branches 2
    // and 3 mint their checkout against the deposit that total produces, not against the figure
    // the estimate was sent with. `applyCustomerSelections` owns the lock (409 OPTIONS_LOCKED),
    // the ownership check (a foreign id 404s) and the optional-only rule, so the rider is
    // exactly as guarded as the standalone door.
    let depositInvoice: { id: string; status: string; total_amount: unknown; amount_due: unknown } | undefined =
      existing.invoices?.[0];
    if (selections?.length) {
      const applied = await applyCustomerSelections(req, res, existing.id, selections);
      if (!applied) return;
      depositInvoice = applied.depositInvoice;
    }

    // #2090 - read ONCE, after the selections rider has been applied and before any branch
    // writes, so every one of the three branches names the same add-ons in its notification and
    // in the customer's approval email.
    const optionSummary = await loadOptionSummary(existing.id);

    // ── Branch 1: No deposit required ──
    if (!depositRequired) {
      const estimate = await prisma.$transaction(async (tx) => {
        const est = await tx.estimate.update({
          where: { id: existing.id },
          data: {
            status: ESTIMATE_STATUS.WON,
            approved_at: new Date(),
            signature_data,
            signature_ip: signatureIp,
            signature_at: new Date(),
            ...(termsApplied ? { terms_accepted: true, terms_accepted_at: new Date() } : {}),
          },
          select: estimatePublicSelect,
        });

        // Auto-transition lead to WON (idempotent) — only when a lead exists.
        // actorId null: this is the PUBLIC door, so there is no signed-in user to attribute the
        // transition to. The customer approved it, and the ledger says so by naming no ServWave
        // actor rather than by borrowing one.
        if (existing.lead_id) {
          await transitionLeadStatus(tx, {
            leadId: existing.lead_id,
            orgId: existing.organization_id,
            to: 'WON',
            from: existing.lead!.status,
            actorId: null,
            description: 'Lead won — estimate approved by the customer',
            metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'customer_approval' },
          });
        }

        await tx.timelineEvent.create({
          data: {
            organization_id: existing.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: existing.id,
            event_type: 'APPROVED',
            description: `Estimate ${existing.estimate_number} approved by customer`,
          },
        });

        return est;
      });

      // ── Notification: estimate.approved (Path A — no deposit) — POST-COMMIT (#271) ──
      // actorId null: customer-facing public route. dedupKey shared with paths B+C.
      await emit({
        verb: 'estimate.approved',
        organizationId: existing.organization_id,
        actorId: null,
        object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
        entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
        // #2090 - the chosen and declined add-ons, named as the document names them. Read AFTER
        // the transaction above, so a selection the customer sent with this very approval is in it.
        data: { object_label: existing.estimate_number, lead_id: existing.lead_id, ...optionSummaryData(optionSummary) },
        dedupKey: `estimate.approved:${existing.id}`,
      });

      // Automation Center — same-entity dedupe collapses the 3 approval paths.
      dispatchAutomationEvent({
        type: 'ESTIMATE_APPROVED',
        organizationId: existing.organization_id,
        entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
        actorId: null,
      });

      void logAudit({ req, orgId: existing.organization_id, actorId: null, action: 'estimate.approved', resourceType: 'Estimate', resourceId: existing.id, metadata: { estimate_number: existing.estimate_number, via: 'public_no_deposit' } });
      res.json({ estimate: await presentPublicEstimate(estimate) });

      // Fire-and-forget: send post-signature PDF notification (Branch 1 = no deposit at all).
      prisma.estimate.findUnique({
        where: { id: existing.id },
        include: {
          organization: true,
          // SERV10X-61 - direct anchor (R6) so a lead-less approved estimate still emails the
          // customer its signed PDF; falls back through the lead for lead-anchored rows.
          customer: true,
          lead: { include: { customer: true } },
        },
      }).then((updated) => {
        if (!updated?.organization) return;
        const cust = updated.lead?.customer ?? updated.customer;
        if (!cust?.email) return;
        const name = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.company_name || 'Customer';
        sendEstimateApprovedNotification({
          estimateId: updated.id,
          org: {
            id: updated.organization_id,
            name: updated.organization.name,
            logo_url: updated.organization.logo_url,
            brand_color: updated.organization.brand_color,
          },
          to: cust.email,
          customerName: name,
          estimateNumber: updated.estimate_number,
          total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(updated.total_amount)),
          // #2090 - the same two lists the notification names.
          options: optionSummary,
          record: {
            organizationId: updated.organization_id,
            customerId: cust.id,
            leadId: updated.lead_id,
          },
        });
      }).catch((err) => logger.error('Failed to send approval notification:', err));
      return;
    }

    // ── Branch 2: Deposit required + CARD ──
    // #904 - this is deliberately an unguarded CARD check. Payability (charges enabled AND CARD
    // in the resolved accepted-methods list) AND a configured processor were both proved above,
    // and a CARD request that fails either 400s rather than reaching here. Re-testing them here
    // would recreate the exact silent-fallthrough bug this fixes: any CARD request that failed
    // the condition would land in Branch 3 and return success without charging anything.
    // EXTERNAL_CARD is not CARD and still falls through to the manual non-Stripe branch below,
    // as intended.
    if (payment_method === 'CARD') {
      // D6 (2026-07-21): save the signature AND move to PENDING. PENDING means "customer
      // approved + signed, deposit not yet processed" — which is exactly this state, regardless
      // of how the deposit will arrive. Previously this branch left the row at SENT, so a
      // customer who signed and then closed the Stripe tab produced a signed-but-SENT estimate:
      // the signature said yes while the status said the customer had not responded, and the
      // document stayed editable. The webhook moves PENDING → WON on payment.
      // On a payment retry the signature is already recorded — preserve it rather than
      // re-stamping signature_at, so the consent record reflects the original acceptance.
      await prisma.estimate.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING',
          ...(isPaymentRetry ? {} : {
            signature_data,
            signature_ip: signatureIp,
            signature_at: new Date(),
          }),
          ...(termsApplied && !isPaymentRetry ? { terms_accepted: true, terms_accepted_at: new Date() } : {}),
        },
      });

      // The kind=DEPOSIT Invoice is the deposit document, charged at face value.
      // The webhook resolves this checkout via metadata.invoiceId and flows through the standard
      // invoiceId branch, which (for kind=DEPOSIT) also approves the estimate + wins the lead.
      const depositAmount = Number(depositInvoice!.total_amount);

      const ctx = getStripeForOrg(existing.organization);
      // Double guard, layer 1 (defensive at the caller): only compute a fee at all when this
      // checkout is actually running against a connected account. Layer 2 lives inside
      // createCheckoutSession itself, which re-checks ctx.stripeAccount before including the field.
      // D2 — resolveCheckoutFees owns the fee math so this call site and the invoice-payment one
      // (invoice.controller.ts) can never drift on it.
      const fees = ctx.stripeAccount
        ? resolveCheckoutFees(Math.round(depositAmount * 100))
        : undefined;
      const session = await createCheckoutSession({
        depositAmount,
        description: `Deposit for Estimate ${existing.estimate_number}`,
        successUrl: `${env.FRONTEND_URL}/p/estimates/${existing.id}?token=${token}&payment=success`,
        cancelUrl: `${env.FRONTEND_URL}/p/estimates/${existing.id}?token=${token}&payment=cancelled`,
        metadata: { invoiceId: depositInvoice!.id, estimateId: existing.id },
        applicationFeeAmount: fees?.applicationFeeAmount,
        serviceFeeAmount: fees?.serviceFeeAmount,
      }, ctx);

      const estimate = await prisma.estimate.findFirst({
        where: { id: existing.id },
        select: estimatePublicSelect,
      });

      void logAudit({ req, orgId: existing.organization_id, actorId: null, action: 'estimate.deposit_checkout_started', resourceType: 'Estimate', resourceId: existing.id, metadata: { via: 'stripe_checkout' } });
      res.json({ estimate: await presentPublicEstimate(estimate), checkout_url: session.url });
      return;
    }

    // ── Branch 3: Deposit required + non-Stripe method ──
    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING',
          // Preserve the original consent record on a payment retry (see Branch 2).
          ...(isPaymentRetry ? {} : {
            signature_data,
            signature_ip: signatureIp,
            signature_at: new Date(),
          }),
          ...(termsApplied && !isPaymentRetry ? { terms_accepted: true, terms_accepted_at: new Date() } : {}),
        },
        select: estimatePublicSelect,
      });

      // The kind=DEPOSIT Invoice has no method-pre-selection field; the customer's chosen method
      // is captured when the deposit payment is actually recorded. Keep the audit timeline event.
      await tx.timelineEvent.create({
        data: {
          organization_id: existing.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'DEPOSIT_PAYMENT_METHOD_SELECTED',
          description: `Customer selected ${payment_method} as deposit payment method for ${existing.estimate_number}`,
        },
      });

      return est;
    });

    void logAudit({ req, orgId: existing.organization_id, actorId: null, action: 'estimate.deposit_method_selected', resourceType: 'Estimate', resourceId: existing.id, metadata: { via: 'manual_method' } });
    res.json({ estimate: await presentPublicEstimate(estimate) });

    // Fire-and-forget: notify estimate creator of payment method selection
    prisma.estimate.findUnique({
      where: { id: existing.id },
      select: {
        estimate_number: true,
        invoices: { where: { kind: 'DEPOSIT' as const }, select: { total_amount: true }, take: 1 },
        creator: { select: { email: true } },
        // SERV10X-61 - direct anchor (R6) so a lead-less estimate names its customer in the
        // method-selected alert; falls back through the lead for lead-anchored rows.
        customer: { select: { first_name: true, last_name: true, company_name: true } },
        lead: { select: { customer: { select: { first_name: true, last_name: true, company_name: true } } } },
      },
    }).then((est) => {
      if (!est?.creator?.email) return;
      const cust = est.lead?.customer ?? est.customer;
      const custName = [cust?.first_name, cust?.last_name].filter(Boolean).join(' ') || cust?.company_name || 'Customer';
      sendPaymentMethodSelectedAlert({
        organizationId: existing.organization_id,
        to: est.creator.email,
        estimateNumber: est.estimate_number,
        customerName: custName,
        paymentMethod: payment_method!,
        depositAmount: Number(est.invoices?.[0]?.total_amount || 0),
      });
    }).catch(() => {});

    // Fire-and-forget: send post-signature PDF notification (Branch 3 = non-CARD method)
    prisma.estimate.findUnique({
      where: { id: existing.id },
      include: {
        organization: true,
        // SERV10X-61 - direct anchor (R6) so a lead-less approved estimate still emails the
        // customer its signed PDF; falls back through the lead for lead-anchored rows.
        customer: true,
        lead: { include: { customer: true } },
      },
    }).then((updated) => {
      if (!updated?.organization) return;
      const cust = updated.lead?.customer ?? updated.customer;
      if (!cust?.email) return;
      const name = [cust.first_name, cust.last_name].filter(Boolean).join(' ') || cust.company_name || 'Customer';
      sendEstimateApprovedNotification({
        estimateId: updated.id,
        org: {
          id: updated.organization_id,
          name: updated.organization.name,
          logo_url: updated.organization.logo_url,
          brand_color: updated.organization.brand_color,
        },
        to: cust.email,
        customerName: name,
        estimateNumber: updated.estimate_number,
        total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(updated.total_amount)),
        // #2090 - the same two lists the notification names.
        options: optionSummary,
        record: {
          organizationId: updated.organization_id,
          customerId: cust.id,
          leadId: updated.lead_id,
        },
      });
    }).catch((err) => logger.error('Failed to send approval notification:', err));
  } catch (err) {
    logger.error('Approve public estimate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * SRVW-285 slice 1 — the ceiling on the customer's free-text decline comment.
 *
 * The rule is TRUNCATE, not reject, and that direction is the whole point. Every other guard on
 * this route is written so that a bad answer costs the answer and never the decline: an
 * unrecognized `lost_reason` is dropped rather than 400-ed, and no field is required at all. A
 * length check that 400-ed would break that pattern at the worst moment — the customer has
 * already pressed Decline, and a validation error hands them a failed action instead of the
 * completed one they asked for, so the business loses the STATUS as well as the comment.
 *
 * 2000 characters is far past any real answer (`express.json({ limit: '1mb' })` in app.ts is the
 * outer bound on what can even arrive) and the frontend caps its textarea at the same number, so
 * a customer typing normally never meets this rule at all. It exists for the crafted body.
 */
export const LOST_REASON_NOTE_MAX = 2000;

/**
 * Trim, cap, and collapse an empty answer to `undefined`.
 *
 * `undefined` rather than `null` on purpose: the caller spreads the result conditionally, so an
 * unanswered box writes NO KEY into the update rather than an explicit `lost_reason_note: null`.
 * A decline that skipped the question then produces byte-for-byte the write this route produced
 * before the question existed.
 *
 * Trim happens BEFORE the cap so leading/trailing padding cannot push a legitimate answer over
 * the line and cost it real characters off the end.
 */
function normalizeLostReasonNote(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, LOST_REASON_NOTE_MAX);
}

// R4 (2026-07-21) — port-plan §3.2 flagged this public route as never having had a Zod schema.
// `lost_reason` was always optional and silently dropped an unrecognized value (see the manual
// enum-membership check below, kept as-is) — this schema just makes that contract explicit and
// rejects a malformed body shape (e.g. a non-string) instead of the handler papering over it.
//
// SRVW-285 — `lost_reason_note` joins it under the same contract: optional, string-shaped, and
// NOT length-checked here. Zod's `.max()` would 400; see LOST_REASON_NOTE_MAX above for why the
// length rule has to be a truncation in the handler instead.
export const declinePublicSchema = z.object({
  lost_reason: z.string().optional(),
  lost_reason_note: z.string().optional(),
});

/**
 * Slice C, decision D6 — the reason list for the PUBLIC estimate page.
 *
 * WHY THIS IS ITS OWN ROUTE AND NOT A FIELD ON THE ESTIMATE PAYLOAD. Slice 1's acceptance says
 * in as many words that the decline dialog "must not start returning anything the page did not
 * already have". Bolting the org's configuration onto `estimatePublicSelect` would ship it on
 * every public page load, to everyone holding a link, whether or not they ever open the decline
 * dialog. This is fetched when that dialog opens and at no other moment.
 *
 * WHY IT CANNOT BE `GET /api/lost-reason-options`. That router sits behind `authenticate`, and
 * this caller is a homeowner with a link and no account. The token IS the credential, checked
 * the same way every other public estimate route checks it - the row must match BOTH the id and
 * the `public_token`, so a guessed id without the token is a 404 like any other miss.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: `is_active` (an inactive reason is simply absent),
 * `sort_order` (the order IS the array), any id, and any count. A customer learns the words they
 * may choose between and nothing whatsoever about how the business curates them.
 */
export async function getPublicDeclineReasons(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const existing = await prisma.estimate.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: { organization_id: true },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    res.json({ decline_reasons: await resolveOfferedLostReasons(existing.organization_id) });
  } catch (err) {
    logger.error('Public decline reasons error:', err);
    res.status(500).json({ error: 'Failed to load decline reasons' });
  }
}

export async function declinePublic(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const existing = await prisma.estimate.findFirst({
      where: { id: param(req, 'id'), public_token: token },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true,
        organization_id: true,
        // Notification: commission_owner_id needed for entity routing.
        lead: { select: { commission_owner_id: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!['SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: `Cannot decline a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    // Optional reason captured when the quote is lost (S1 report). Ignore unknown values.
    //
    // Slice C — the list it is checked against is now the ORGANISATION's (D3), not the retired
    // `LostReason` enum, so a reason an admin added is storable here and one they retired is
    // not. Decision D8 is untouched and is the reason this stays a silent drop rather than a
    // 400: a customer holding a page whose option was deactivated mid-session must still be
    // able to decline, and a validation error would cost the business the STATUS as well as
    // the reason.
    const reasonInput = req.body?.lost_reason;
    const lost_reason: string | undefined =
      typeof reasonInput === 'string' && (await isOfferedLostReason(existing.organization_id, reasonInput))
        ? reasonInput
        : undefined;

    // SRVW-285 — the comment beside the picker. Independent of `lost_reason` in BOTH directions:
    // a customer who typed a sentence but picked nothing still has their sentence kept, and a
    // dropped unknown reason never takes the comment down with it.
    const lost_reason_note = normalizeLostReasonNote(req.body?.lost_reason_note);

    const estimate = await prisma.$transaction(async (tx) => {
      const est = await tx.estimate.update({
        where: { id: existing.id },
        data: {
          status: 'DECLINED',
          declined_at: new Date(),
          ...(lost_reason ? { lost_reason } : {}),
          ...(lost_reason_note ? { lost_reason_note } : {}),
        },
        select: estimatePublicSelect,
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: existing.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: existing.id,
          event_type: 'DECLINED',
          description: `Estimate ${existing.estimate_number} declined by customer`,
          // SRVW-285 — parity with declineInternal, which has always stamped
          // `{ method: 'internal', lost_reason }` here. The public route carried no metadata at
          // all, so a customer-side decline left no trace of WHY anywhere a staff member reads.
          // Note this is the only place the two fields travel together with the event; the
          // columns above remain the system of record for the conversion report.
          metadata: { method: 'public', lost_reason: lost_reason ?? null, lost_reason_note: lost_reason_note ?? null },
        },
      });

      // Void any UNPAID kind=DEPOSIT Invoice (DRAFT/SENT) on this estimate.
      const voided = await tx.invoice.updateMany({
        where: { estimate_id: existing.id, kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'VOIDED', voided_at: new Date(), voided_reason: 'Estimate declined' },
      });
      if (voided.count > 0) {
        await tx.timelineEvent.create({
          data: {
            organization_id: existing.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: existing.id,
            event_type: 'DEPOSIT_VOIDED',
            description: `Deposit voided due to estimate decline`,
          },
        });
      }

      return est;
    });

    // ── Notification: estimate.declined — POST-COMMIT (#271) ──────────────────
    // actorId null: customer-facing public route.
    await emit({
      verb: 'estimate.declined',
      organizationId: existing.organization_id,
      actorId: null,
      object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
      entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
      data: { object_label: existing.estimate_number, lost_reason: lost_reason ?? null },
    });

    // Automation Center event — post-commit, fire-and-forget.
    dispatchAutomationEvent({
      type: 'ESTIMATE_DECLINED',
      organizationId: existing.organization_id,
      entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
      actorId: null,
    });

    void logAudit({ req, orgId: existing.organization_id, actorId: null, action: 'estimate.declined', resourceType: 'Estimate', resourceId: existing.id });
    res.json({ estimate: await presentPublicEstimate(estimate) });
  } catch (err) {
    logger.error('Decline public estimate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// REMOVED: markDepositReceived — superseded by recordEstimatePayment above.

// ─── Waive Deposit ────────────────────────────────────

export const waiveDepositSchema = z.object({
  action: z.enum(['waive', 'cancel']).default('waive'),
});

// Phase 2a (entity-redesign seam 2): DUAL-WRITE the void onto the kind=DEPOSIT Invoice in
// addition to the legacy Deposit row. Best-effort — estimates that predate Phase 2a have no
// deposit invoice and behave exactly as before.
export async function waiveDeposit(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, status: true, estimate_number: true, lead_id: true,
        // The kind=DEPOSIT Invoice is the SOLE deposit document. "Active" = a non-voided,
        // non-paid deposit invoice (DRAFT/SENT) that can still be waived.
        invoices: {
          where: { kind: 'DEPOSIT' as const },
          select: { id: true, status: true },
          take: 1,
        },
        // Notification: commission_owner_id needed for entity routing.
        lead: { select: { commission_owner_id: true, status: true } },
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #106 — per-instance ownership through SQL (lifecycle verb). The route guard
    // canDo('waive_deposit') is subject-level only; canAccessRow is the nested-safe, fail-closed
    // owner gate that prevents waiving a deposit on another user's estimate.
    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (!['SENT', 'PENDING'].includes(existing.status)) {
      res.status(400).json({ error: `Cannot waive deposit on a ${existing.status.toLowerCase()} estimate` });
      return;
    }

    const depositInvoice = existing.invoices?.[0];
    if (!depositInvoice || !['DRAFT', 'SENT'].includes(depositInvoice.status)) {
      res.status(400).json({ error: 'No active deposit to waive' });
      return;
    }

    const action = req.body.action || 'waive';

    const now = new Date();

    const estimate = await prisma.$transaction(async (tx) => {
      // Void the kind=DEPOSIT Invoice (the SOLE deposit document).
      await tx.invoice.update({
        where: { id: depositInvoice.id },
        data: {
          status: 'VOIDED',
          voided_at: now,
          voided_reason: action === 'waive' ? 'Deposit waived' : 'Estimate cancelled',
        },
      });

      await tx.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'ESTIMATE',
          entity_id: id,
          event_type: 'DEPOSIT_VOIDED',
          description: action === 'waive'
            ? `Deposit waived for estimate ${existing.estimate_number}`
            : `Deposit voided (estimate cancelled) for ${existing.estimate_number}`,
          created_by: req.user!.id,
        },
      });

      if (action === 'waive') {
        await tx.estimate.update({
          where: { id: existing.id },
          data: { status: ESTIMATE_STATUS.WON, approved_at: now },
        });

        // Lead → WON (idempotent) — only when a lead exists.
        if (existing.lead_id) {
          await transitionLeadStatus(tx, {
            leadId: existing.lead_id,
            orgId: req.user!.organization_id,
            to: 'WON',
            from: existing.lead!.status,
            actorId: req.user?.id ?? null,
            description: 'Lead won — estimate accepted',
            metadata: { estimate_id: existing.id, estimate_number: existing.estimate_number, via: 'accept' },
          });
        }
      } else {
        // action === 'cancel'
        await tx.estimate.update({
          where: { id: existing.id },
          data: { status: ESTIMATE_STATUS.ARCHIVED, cancelled_at: now },
        });

        await tx.timelineEvent.create({
          data: {
            organization_id: req.user!.organization_id,
            entity_type: 'ESTIMATE',
            entity_id: id,
            event_type: 'CANCELLED',
            description: `Estimate ${existing.estimate_number} cancelled`,
            created_by: req.user!.id,
          },
        });
      }

      return tx.estimate.findUnique({ where: { id }, select: estimateDetailSelect });
    });

    // ── Notification: estimate.deposit_waived — POST-COMMIT (#271) ────────────
    if (action === 'waive') {
      await emit({
        verb: 'estimate.deposit_waived',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'ESTIMATE', id: existing.id, label: existing.estimate_number },
        entity: { commission_owner_id: existing.lead?.commission_owner_id ?? null },
        data: { object_label: existing.estimate_number },
      });
    }

    const response: Record<string, unknown> = { estimate: presentEstimateDetail(req, estimate) };

    if (action === 'waive') {
      // Waiving the deposit approves the estimate — same automation event as
      // the other approval doors (dedupe collapses repeats).
      dispatchAutomationEvent({
        type: 'ESTIMATE_APPROVED',
        organizationId: req.user!.organization_id,
        entity: { type: 'estimate', id: existing.id, label: existing.estimate_number },
        actorId: req.user?.id ?? null,
      });
      void logAudit({ req, action: 'estimate.deposit_waived', resourceType: 'Estimate', resourceId: existing.id });
    }
    res.json(response);
  } catch (err) {
    logger.error('Waive deposit error:', err);
    res.status(500).json({ error: 'Failed to waive deposit' });
  }
}

// ─── Refund Deposit / Reactivate Deposit ──────────────
// REMOVED (Phase 5 fold): refundDeposit + refundDepositSchema + reactivateDeposit.
// The deposit refund is now the unified Invoice refund — POST /api/invoices/:id/refund on
// the kind=DEPOSIT invoice (invoice.controller.refundInvoice), which writes the first-class
// Refund row + INVOICE_REFUNDED timeline event. The legacy estimate routes are gone.

// REMOVED: updatePaymentMethod — the standalone Change Method action is gone.
// Admins use Record Payment (which sets the method as part of recording the
// deposit) instead.

// ─── Notes ─────────────────────────────────────────────

export async function getNotes(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // #233/F-004 per-row gate (mirrors getById/getPdf): select the owner set so canAccessEstimate
    // can evaluate ownership. SALES holds a (post-F-004 OWN_LEAD-conditioned) `read Estimate` grant
    // that still satisfies the subject-level route guard — without this a SALES rep could read the
    // notes of ANY estimate in the org, including leads they don't own (cross-user in-tenant leak).
    const estimate = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, created_by: true, lead: { select: { lead_assignees: { select: { user_id: true } } } } },
    });
    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #233/F-004 per-row ownership gate — IDENTICAL to getById/getPdf. canAccessEstimate returns
    // true for ADMIN/DISPATCHER (unconditional), the owning SALES rep, and any owner; false otherwise.
    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const notes = await prisma.note.findMany({
      where: { entity_type: 'ESTIMATE', entity_id: id, ...tenantWhere(req) },
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
    logger.error('Get estimate notes error:', err);
    res.status(500).json({ error: 'Failed to get estimate notes' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // #233/F-004 per-row gate (mirrors getById/getPdf): select the owner set so canAccessEstimate
    // can evaluate ownership. SALES holds a (post-F-004 OWN_LEAD-conditioned) `read Estimate` grant
    // that still satisfies the subject-level route guard — without this a SALES rep could write a
    // note onto ANY estimate in the org, including leads they don't own (cross-user in-tenant write).
    const estimate = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, created_by: true, lead: { select: { lead_assignees: { select: { user_id: true } } } } },
    });
    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #233/F-004 per-row ownership gate — IDENTICAL to getById/getPdf. canAccessEstimate returns
    // true for ADMIN/DISPATCHER (unconditional), the owning SALES rep, and any owner; false otherwise.
    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'ESTIMATE',
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
    logger.error('Add estimate note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}

// ─── Stats ─────────────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    const orgWhere = tenantWhere(req);
    // Role-scope the estimate stats the SAME way list() does, so a scoped role's summary cards only
    // sum estimates it can actually see (authz-1; closes the list↔stats divergence). Fully
    // grant-driven: readScope covers ADMIN/{} + SALES (OWN_LEAD-conditioned read) + any custom
    // Owned/Team/Location read grant + no-grant→MATCH_NOTHING. No role literal.
    const statsWhere: Record<string, unknown> = { ...orgWhere, ...(await scopeWhereForReq(req, 'Estimate')) };
    const [
      draftCount, sentCount, pendingCount, wonCount, declinedCount, archivedCount,
      draftValue, sentValue, pendingValue, wonValue, declinedValue, archivedValue,
      pendingDeposits,
    ] = await Promise.all([
      prisma.estimate.count({ where: { ...statsWhere, status: 'DRAFT' } }),
      prisma.estimate.count({ where: { ...statsWhere, status: 'SENT' } }),
      prisma.estimate.count({ where: { ...statsWhere, status: 'PENDING' } }),
      prisma.estimate.count({ where: { ...statsWhere, status: ESTIMATE_STATUS.WON } }),
      prisma.estimate.count({ where: { ...statsWhere, status: 'DECLINED' } }),
      prisma.estimate.count({ where: { ...statsWhere, status: ESTIMATE_STATUS.ARCHIVED } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: 'DRAFT' }, _sum: { total_amount: true } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: 'SENT' }, _sum: { total_amount: true } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: 'PENDING' }, _sum: { total_amount: true } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: ESTIMATE_STATUS.WON }, _sum: { total_amount: true } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: 'DECLINED' }, _sum: { total_amount: true } }),
      prisma.estimate.aggregate({ where: { ...statsWhere, status: ESTIMATE_STATUS.ARCHIVED }, _sum: { total_amount: true } }),
      // Pending deposits — the kind=DEPOSIT Invoice is the SOLE source (legacy Deposit gone).
      // Left org-wide by design: scoping the deposit KPI to a role needs the Invoice
      // read-scope (OWN_INVOICE_VIA_LEAD), a separate product decision (see re-audit authz-1).
      prisma.invoice.aggregate({ where: { ...orgWhere, kind: 'DEPOSIT', status: { in: ['DRAFT', 'SENT'] } }, _count: true, _sum: { amount_due: true } }),
    ]);

    res.json({
      // R1 (2026-07-21) — renamed to match the D1 status rename (approved/cancelled ->
      // won/archived), consistent with list()'s embedded stats. This endpoint stays dormant
      // (§4b — no frontend caller), so the rename carries zero consumer risk.
      draft:     { count: draftCount,    value: draftValue._sum.total_amount || 0 },
      sent:      { count: sentCount,     value: sentValue._sum.total_amount || 0 },
      pending:   { count: pendingCount,  value: pendingValue._sum.total_amount || 0 },
      won:       { count: wonCount,      value: wonValue._sum.total_amount || 0 },
      declined:  { count: declinedCount, value: declinedValue._sum.total_amount || 0 },
      archived:  { count: archivedCount, value: archivedValue._sum.total_amount || 0 },
      pending_deposits: {
        count: pendingDeposits._count,
        total: pendingDeposits._sum.amount_due || 0,
      },
    });
  } catch (err) {
    logger.error('Get estimate stats error:', err);
    res.status(500).json({ error: 'Failed to get estimate stats' });
  }
}

// ─── Versions (#2030) ─────────────────────────────────
//
// A version is the frozen document one customer actually received. These two endpoints are the
// READER the snapshot has never had. They only read: read-only here is structural, not a mode
// flag on the workspace that can be got wrong.

/** The estimate this request may see, or null. Shares getPdf's per-row ownership gate exactly. */
async function loadVersionEstimate(req: Request) {
  const estimate = await prisma.estimate.findUnique({
    where: { id: param(req, 'id'), ...tenantWhere(req) },
    select: {
      id: true,
      estimate_number: true,
      organization_id: true,
      created_by: true,
      // #1997 × #2030 — the LIVE customer anchors, so `getVersion` can judge the requester's
      // read-Customer scope against a row that has an `id` and a current scope. The frozen copy
      // inside the snapshot has neither. Same id + display-name shape `estimateDetailSelect`
      // projects, which is what a conditioned `read Customer` grant is evaluated against.
      customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      lead: {
        select: {
          lead_assignees: { select: { user_id: true } },
          customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        },
      },
    },
  });
  if (!estimate) return null;
  return (await canAccessEstimate(estimate, req)) ? estimate : null;
}

// GET /api/estimates/:id/versions — the list. Summary only: the whole frozen document has no
// business in a list, and `trigger` is what makes the re-send count derivable from the versions
// rather than from a counter that could disagree with them.
export async function listVersions(req: Request, res: Response) {
  try {
    const estimate = await loadVersionEstimate(req);
    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    const versions = await prisma.estimateVersionSnapshot.findMany({
      where: { estimate_id: estimate.id },
      select: { id: true, version: true, trigger: true, total_amount: true, sent_at: true },
      orderBy: { version: 'asc' },
    });

    res.json({ versions });
  } catch (err) {
    logger.error('List estimate versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/estimates/:id/versions/:version — one version, whole.
//
// The document comes from the SNAPSHOT, never from the live estimate: that is what guarantees a
// past version looks like what was actually sent, rather than like today's template applied to
// old data. Its photos are re-signed on the way out — the snapshot stores paths precisely because
// a signed url expires within the hour and a version is meant to outlive that by years.
export async function getVersion(req: Request, res: Response) {
  try {
    const estimate = await loadVersionEstimate(req);
    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    const requested = Number(param(req, 'version'));
    if (!Number.isInteger(requested)) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    const snapshot = await prisma.estimateVersionSnapshot.findFirst({
      where: { estimate_id: estimate.id, version: requested },
      // Newest first, explicitly. Minting assigns its own per-estimate ordinal now, but rows
      // written before it did can still share a number, and there is no unique constraint to lean
      // on. With no orderBy a duplicate resolves to whatever the planner returns, so one url could
      // open either document; newest wins because that is the one the customer most recently
      // received.
      orderBy: { created_at: 'desc' },
    });
    // A snapshot from before #2030 is summary-only. There is nothing to open, and rendering an
    // empty document as if it were what the customer received would be worse than a 404.
    if (!snapshot?.document) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    const document = snapshot.document as unknown as {
      view: { rows: Array<{ photos: Array<{ url: string }> }> };
      customer?: Record<string, unknown> | null;
    };
    // #1997 × #2030 — the snapshot froze the WHOLE customer row, contact columns included, and
    // this response is as detail-shaped as any other. Clearing `canAccessEstimate` above says
    // nothing about whether this requester may read that customer. The verdict is taken on the
    // LIVE row (`isCustomerReadableRow` needs an `id`, which the document projection never froze,
    // and a scope granted since the send must be honoured); only the strip lands on the copy.
    // A document with no resolvable anchor is left alone — there is nothing to judge, so nothing
    // to strip, the same rule `redactCustomerContactFor` follows.
    const anchor = estimate.customer ?? estimate.lead?.customer ?? null;
    const anchorReadable = anchor ? isCustomerReadableRow(req, anchor) : true;
    const redacted = document.customer
      ? { ...document, customer: redactCustomerRowUnless(document.customer, anchorReadable) }
      : document;
    const signed = await signVersionPhotos(redacted);

    res.json({
      version: {
        version: snapshot.version,
        trigger: snapshot.trigger,
        sent_at: snapshot.sent_at,
        total_amount: snapshot.total_amount,
        // Both, so a reader always has an obvious way back to the current estimate.
        estimate_id: estimate.id,
        estimate_number: estimate.estimate_number,
        document: signed,
      },
    });
  } catch (err) {
    logger.error('Get estimate version error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Exchange the version's stored Storage paths for freshly-signed urls, in ONE batched call. */
async function signVersionPhotos<T extends { view: { rows: Array<{ photos: Array<{ url: string }> }> } }>(
  document: T,
): Promise<T> {
  const paths = document.view.rows.flatMap((row) => row.photos.map((p) => p.url)).filter(Boolean);
  if (paths.length === 0) return document;

  const urls = new Map<string, string>();
  try {
    const { data } = await supabaseAdmin.storage
      .from(ESTIMATE_PHOTO_STORAGE_BUCKET)
      .createSignedUrls(paths, ESTIMATE_PHOTO_SIGNED_URL_TTL_SECONDS);
    for (const row of data ?? []) {
      if (row?.path && row?.signedUrl) urls.set(row.path, row.signedUrl);
    }
  } catch (err) {
    logger.warn('Failed to sign version photo URLs; they render blank this response', err);
  }

  return {
    ...document,
    view: {
      ...document.view,
      rows: document.view.rows.map((row) => ({
        ...row,
        photos: row.photos.map((p) => ({ ...p, url: urls.get(p.url) ?? '' })),
      })),
    },
  };
}

// ─── PDF ──────────────────────────────────────────────

export const getPdf = async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'] as string;
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: {
        // #2028 — the document body is the shared projection; this preview must be byte-identical
        // to what getPublicPdf serves the customer and to what lib/email.ts attaches.
        ...estimateDocumentSelect,
        // R6 (2026-07-22) — NOT document content: created_by is required by canAccessEstimate's
        // null-lead fallback (D19), and lead_assignees by its ownership branch.
        created_by: true,
        // #1997 (Decision 6) — the redaction helper judges the row it is handed; without `id` it
        // would fail-closed even for a requester a future conditioned `read Customer` intends to
        // allow, disagreeing with the screen. Never rendered. Added HERE rather than inside
        // `estimateDocumentCustomerSelect` on purpose: the token-gated public payload has
        // deliberately carried no customer scalar ids, and the shared projection feeds it too.
        customer: { select: { id: true, ...estimateDocumentSelect.customer.select } },
        lead: {
          select: {
            ...estimateDocumentSelect.lead.select,
            // #233 per-row gate (mirrors getById): load the owner set so canAccessEstimate can
            // evaluate ownership below. Without it a SALES rep — whose (post-F-004 OWN_LEAD-
            // conditioned) `read Estimate` grant still satisfies the subject-level route guard —
            // could pull the fully-priced PDF (subtotal/tax/total + per-line prices) of ANY estimate.
            lead_assignees: { select: { user_id: true } },
            // #1997 (Decision 6) — see the direct `customer` sub-select above; the nested anchor
            // is judged independently, so it needs its own `id` too.
            customer: {
              select: { id: true, ...estimateDocumentSelect.lead.select.customer.select },
            },
          },
        },
      },
    });

    if (!estimate) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #233 per-row ownership gate — IDENTICAL to getById's `canAccessEstimate` check. The route
    // guard `canDo('read','Estimate')` is subject-level only; SALES' (post-F-004 OWN_LEAD-
    // conditioned) read-Estimate grant still satisfies it, so without this a SALES rep could read
    // the priced PDF of an estimate on a lead they don't own (cross-user in-tenant pricing leak).
    // canAccessEstimate returns true for ADMIN/DISPATCHER (unconditional), the owning SALES rep,
    // and any owner; false otherwise.
    if (!(await canAccessEstimate(estimate, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const orgId = estimate.organization_id;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) {
      res.status(500).json({ error: 'Organization not found' });
      return;
    }

    const { generateEstimatePdf } = await import('../lib/pdf/index.js');
    // §2.2 — this staff preview/download must render the SAME document the customer gets from
    // getPublicPdf below. Omitting the template arg silently fell back to 'alpha-classic'
    // (lib/pdf/index.ts), so an org on crm-default saw a different template in its own Preview.
    // #1997 — this staff render must degrade the same way the screen does for a requester who
    // cannot read the customer; the templates already tolerate the absence (alpha-classic.ts
    // reads `c.email || ''` / `formatPhoneDisplay(c.phone)`, both null-safe). getPublicPdf below
    // is untouched — it renders on behalf of the organization for the customer, not a requester.
    // Redaction is the LAST transform, after the document normaliser (#1997's own contract).
    const pdfSource = presentEstimateDetail(req, toEstimateDocument(estimate));
    const buffer = await generateEstimatePdf(pdfSource as any, org as any, (org.estimate_template ?? 'alpha-classic') as any);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="estimate-${estimate.estimate_number}.pdf"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    logger.error(`PDF generation failed for estimate ${id}:`, err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
};

// ─── Public PDF ───────────────────────────────────────

export const getPublicPdf = async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params['id'] as string;
    const token = req.query.token as string | undefined;
    if (!token) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    const est = await prisma.estimate.findUnique({
      where: { id },
      select: { id: true, estimate_number: true, public_token: true },
    });
    if (!est || est.public_token !== token) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // The document body is the shared projection — the same one getPdf previews and lib/email.ts
    // attaches. No canAccessEstimate here (this route is token-gated, not user-gated), so none of
    // getPdf's authorization anchors are needed.
    const fullEst = await prisma.estimate.findUnique({
      where: { id },
      select: estimateDocumentSelect,
    });
    if (!fullEst) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }
    // Use the estimate's own organization_id — public route has no req.user
    const org = await prisma.organization.findUnique({ where: { id: fullEst.organization_id } });
    if (!org) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    const { generateEstimatePdf } = await import('../lib/pdf/index.js');
    const pdfBuffer = await generateEstimatePdf(toEstimateDocument(fullEst) as any, org as any, (org.estimate_template ?? 'alpha-classic') as any);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="estimate-${est.estimate_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error(`Public PDF generation failed:`, err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
};

// ─── Creators ─────────────────────────────────────────

export async function listCreators(req: Request, res: Response) {
  try {
    // Live QA, 2026-08-05: the route's `canDo('read', 'Estimate')` guard is subject-level, so it
    // passed for anyone holding ANY read grant - including TECHNICIAN's new CONDITIONAL
    // OWN_ESTIMATE_VIA_LEAD_OR_CREATOR grant. But this list is org-wide (every admin/sales user,
    // and anyone else who has ever created an estimate) - it exists to populate a filter dropdown
    // for someone who sees MANY estimates, which only an unconditional reader (ADMIN/DISPATCHER)
    // actually does. A row-scoped reader's own estimates are never filtered by creator (they see
    // at most their own), so narrow to the same unconditional-only check invoice.controller.ts
    // uses for create Invoice (scopeWhereForReq → {} ⇒ no restriction).
    const scope = await scopeWhereForReq(req, 'Estimate');
    if (Object.keys(scope).length > 0) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    const users = await prisma.user.findMany({
      where: {
        ...tenantWhere(req),
        OR: [
          { is_active: true, role: { in: ['ADMIN', 'SALES'] } },
          { created_estimates: { some: {} } },
        ],
      },
      select: { id: true, first_name: true, last_name: true },
      orderBy: { first_name: 'asc' },
    });
    res.json({ users });
  } catch (err) {
    logger.error('List estimate creators error:', err);
    res.status(500).json({ error: 'Failed to list creators' });
  }
}

// ─── Editable record ids (Workiz dual-run, SERV10X record-renumber) ──────

/**
 * Thrown INSIDE the rename transaction when a fresh, lock-protected `computeRenumber` finds
 * conflicts, so the controller can respond 409 with the structured computation instead of
 * guessing at the shape of `applyRenumber`'s own (plain-message) conflict error. Carrying the
 * computation on the error also means `applyRenumber` - which re-derives and would throw for the
 * identical reason - is never even called on the conflict path, so nothing is written.
 */
class RenumberConflictError extends Error {
  constructor(public readonly computation: RenumberComputation) {
    super(`Cannot rename estimate ${computation.parentId}: number "${computation.newNumber}" has conflicts`);
  }
}

/** True for the `Invalid record number: ...` Error validateNumberFormat/computeRenumber throw. */
function isInvalidNumberError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith('Invalid record number');
}

/**
 * POST /:id/number/preview - read-only, no lock, no writes. Mirrors computeRenumber's own
 * contract (advisory only): drives the (later-PR) confirmation dialog before the real rename.
 */
export async function previewNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const existing = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    // #106 - per-instance ownership (the route guard canDo('renumber') is subject-level only).
    // Same canAccessRow gate update()/delete()/waiveDeposit()/recordEstimatePayment() already use.
    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const computation = await computeRenumber(prisma, 'estimate', id, orgId, req.body.number);
    res.json(computation);
  } catch (err) {
    if (isInvalidNumberError(err)) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Preview estimate number error:', err);
    res.status(500).json({ error: 'Failed to preview estimate number change' });
  }
}

/**
 * PATCH /:id/number - the real rename. Cheap existence/ownership check OUTSIDE the transaction
 * first (mirrors update()/waiveDeposit()'s permission -> 404 -> ownership ordering, so a request
 * that's going to 404/403 anyway never opens a transaction); estimate has no entity-specific
 * rename precondition (unlike invoice's isInvoiceRenumberLocked). The transaction then locks the
 * parent row `FOR NO KEY UPDATE` - the SAME lock strength allocateAnchoredNumber already takes on
 * the estimates table when estimate is the LogisticOrder anchor (numbering.ts), so the two code
 * paths serialize against each other instead of deadlocking or racing - before computing/applying.
 */
export async function renameNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const existing = await prisma.estimate.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Estimate not found' });
      return;
    }

    if (!(await canAccessRow(req, 'Estimate', prisma.estimate, existing.id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    let computation: RenumberComputation;
    try {
      computation = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM estimates WHERE id = ${id}::uuid AND organization_id = ${orgId}::uuid FOR NO KEY UPDATE`;

        // Compute fresh, under the lock, BEFORE calling applyRenumber - so a conflict can be
        // reported with the full structured computation. applyRenumber re-derives this exact
        // same computation internally and would throw for the identical reason, so skip it
        // entirely on the conflict path rather than calling it twice.
        const preview = await computeRenumber(tx, 'estimate', id, orgId, req.body.number);
        if (preview.hasConflicts) {
          throw new RenumberConflictError(preview);
        }

        return applyRenumber(tx, 'estimate', id, orgId, req.body.number);
      });
    } catch (err) {
      if (err instanceof RenumberConflictError) {
        res.status(409).json({ error: err.message, computation: err.computation });
        return;
      }
      if (isInvalidNumberError(err)) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Timeline + audit AFTER the transaction commits - never inside it (a rolled-back attempt
    // must leave no trace of either).
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'ESTIMATE',
        entity_id: id,
        event_type: 'ESTIMATE_RENUMBERED',
        description: `Estimate number changed from ${computation.oldNumber} to ${computation.newNumber}`
          + ` (${computation.derived.length + computation.labelRefreshes.length} related record(s) updated)`,
        metadata: {
          old_number: computation.oldNumber,
          new_number: computation.newNumber,
          derived_count: computation.derived.length + computation.labelRefreshes.length,
        },
        created_by: req.user!.id,
      },
    });

    void logAudit({
      req,
      action: 'estimate.renumbered',
      resourceType: 'Estimate',
      resourceId: id,
      metadata: { old_number: computation.oldNumber, new_number: computation.newNumber },
    });

    // Built from the computation, not a re-SELECT - everything the (later-PR) frontend
    // confirmation dialog needs, in one round trip.
    res.json({
      estimate: { id, estimate_number: computation.newNumber },
      old_number: computation.oldNumber,
      new_number: computation.newNumber,
      derived: computation.derived,
      label_refreshes: computation.labelRefreshes,
    });
  } catch (err) {
    logger.error('Rename estimate number error:', err);
    res.status(500).json({ error: 'Failed to change estimate number' });
  }
}
