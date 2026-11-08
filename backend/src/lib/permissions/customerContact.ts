/**
 * #1997 — the requester-keyed customer-contact strip.
 *
 * `estimateDetailSelect` / `invoiceDetailSelect` (estimate.controller.ts / invoice.controller.ts)
 * unconditionally project a customer's `email`, `phone` and `billing_*` columns on every
 * detail-shaped response, on THREE possible anchors: the document's own `customer`, the nested
 * `lead.customer` and (invoices) `job.customer`. Neither select is wrong — an unconditional reader
 * must keep getting those fields (the frozen `repro-1997.test.ts` green controls require it) — but
 * nothing on the response chain ever asked whether THIS requester may read THIS customer row.
 * `stripDocumentCost` (lib/scopes.ts) is the only existing per-requester field filter on that
 * chain, and it branches solely on `canSeePricing(req)`, an unrelated question, so folding this
 * strip into it would silently skip the redaction for any pricing-capable requester whose
 * Customer scope is nonetheless narrowed.
 *
 * `redactCustomerContactFor` is that missing per-row check: pure, synchronous, DB-free (the row it
 * judges is whatever the caller already loaded — a re-fetch here would be an N+1 across the 11
 * invoice-lines call sites, and a query written without `tenantWhere`). `presentEstimateDetail` /
 * `presentInvoiceDetail` are the two call-site presenters every enumerated detail-shaped response
 * (estimate.controller.ts, estimate-lines.controller.ts, invoice.controller.ts,
 * invoice-lines.controller.ts) applies as its LAST transform — kept here, beside the helper, rather
 * than in either controller: `estimate.controller.ts` already imports from `invoice.controller.ts`
 * but not the reverse, and the two `*-lines.controller.ts` files would otherwise have to import a
 * full handler module for one pure function. Deliberately does NOT absorb
 * `resolveEstimatePhotoUrls` / `projectEstimateLeadWalkthrough` / `stripEstimateCost` /
 * `stripInvoiceCost` — folding those in would silently change money/photo visibility for the 9
 * bare estimate sites, a decision this issue puts out of scope (see spec Ruling 1).
 */
import type { Request } from 'express';
import { isCustomerReadableRow, stripCustomerProofKeys } from './customerScope';

/** The seven keys a customer row must not carry when the requester cannot read that customer. */
export const CUSTOMER_CONTACT_KEYS = [
  'email',
  'phone',
  'billing_address_line1',
  'billing_address_line2',
  'billing_city',
  'billing_state',
  'billing_zip',
] as const;

type CustomerRow = Record<string, unknown>;

/**
 * #1997 round 2/3 — a customer row's `service_locations` (the customer's primary street address)
 * is the same class of information the seven scalar keys above protect. Kept as a SEPARATE
 * constant rather than folded into `CUSTOMER_CONTACT_KEYS` (the "seven keys" count the issue names
 * — and a unit test pins — stays exactly seven), but stripped unconditionally alongside them by
 * `redactRow` below. Round 2 shipped this ONLY on the estimate side because the invoice PDF
 * template (`alpha-classic.ts`) dereferenced `c.service_locations.find(...)` with no optional
 * chaining and would have thrown instead of redacting; round 3 made that template null-safe (see
 * `lib/pdf/templates/alpha-classic.ts`), so both presenters now strip it the same way.
 */
const SERVICE_LOCATIONS_KEY = 'service_locations';

/** `public_token` — see the anchor-resolution doc on `redactCustomerContactFor` below. */
const PUBLIC_TOKEN_KEY = 'public_token';

/**
 * #2041 findings 1/6 — `estimateDetailSelect`/`invoiceDetailSelect`/`leadDetailSelect` all carry a
 * SIBLING top-level `service_location` block (address_line1/2, city, state, zip) alongside
 * `customer` — the R6 direct anchor, denormalized onto the document so it renders without the
 * `lead.customer` hop. `redactRow` above only ever reaches `doc.customer`/`doc.lead.customer`/
 * `doc.job.customer`; it never touched this sibling, so a requester whose `customer` block came
 * back contact-stripped still received the SAME customer's full street address one key over. Never
 * strips `id` — a couple of forms key off it for pre-fill state.
 */
const SERVICE_LOCATION_ADDRESS_KEYS = ['address_line1', 'address_line2', 'city', 'state', 'zip'] as const;

/**
 * The exact per-row verdict every strip in this module keys on. #2041 - was
 * `can(req,'read','Customer',row)`; @casl/prisma THROWS on OWN_CUSTOMER's nested to-one -> to-many
 * arms (`enforce.ts:246-256`), so this is now the SYNCHRONOUS, SQL-backed `matchesFragment`
 * verdict against the per-request-memoised scope (`customerScope.ts`) instead - the "smaller
 * alternative" spec R3 prefers over converting the ~60 presenter call sites to async. Requires the
 * row to have been selected WITH `CUSTOMER_PROOF_SELECT` merged in (`estimateDetailSelect` /
 * `invoiceDetailSelect`'s customer anchors); an absent proof key reads as a non-match (R12), never
 * a throw. FAIL-CLOSED: no `id` on the row (a condition on a column the detail select never
 * projects) and any non-match both read as "not readable".
 *
 * Exported (round 3) so a response that mints/returns a `public_token`-derived URL or field
 * OUTSIDE the two presenters below (`invoice.controller.ts::createPaymentLink`) can apply the
 * identical verdict without a second query.
 */
export function isCustomerReadable(req: Request, row: CustomerRow): boolean {
  return isCustomerReadableRow(req, row);
}

/**
 * One customer row's verdict. Never mutates `row`. The proof keys `CUSTOMER_PROOF_SELECT` added
 * (`created_by_id`/`leads`/`jobs`) are stripped on EVERY branch — they were never part of the wire
 * shape, readable or not. A readable row otherwise comes back byte-identical to what the select
 * projected; an unreadable one also loses the seven contact keys AND `service_locations`.
 */
function redactRow(req: Request, row: CustomerRow): CustomerRow {
  const readable = isCustomerReadable(req, row);
  const stripped = stripCustomerProofKeys(row);
  if (readable) return stripped;
  const out: CustomerRow = { ...stripped };
  for (const key of CUSTOMER_CONTACT_KEYS) delete out[key];
  delete out[SERVICE_LOCATIONS_KEY];
  return out;
}

/**
 * #2041 decision 8 — redact a single ALREADY-JUDGED customer row's contact block when `readable`
 * is false, WITHOUT re-deriving the verdict from the row's own shape. Used by the lead/job
 * existing-customer create paths (`lead.controller.ts`, `job.controller.ts`), which resolve
 * readability ONCE via `canReadCustomerById`/`isCustomerReadableRow` on a proof-selected probe
 * row — their own response selects (`leadDetailSelect`/`jobDetailSelect`) are not widened with
 * `CUSTOMER_PROOF_SELECT`, so re-deriving here would over-redact even an owned customer.
 *
 * #1997 × #2030 — `estimate.controller.ts::getVersion` is the third caller with exactly that
 * shape: the row it holds is a FROZEN customer copy inside an estimate version snapshot, written
 * off `estimateDocumentSelect`, which never projected an `id`. Re-deriving the verdict from the
 * copy would therefore fail closed for every requester — and a scope granted since the send would
 * still be answered from a row frozen years ago. The verdict belongs to the LIVE customer; only
 * the strip belongs to the copy.
 */
export function redactCustomerRowUnless(
  row: CustomerRow | null | undefined,
  readable: boolean,
): CustomerRow | null | undefined {
  if (!row || readable) return row;
  const out: CustomerRow = { ...row };
  for (const key of CUSTOMER_CONTACT_KEYS) delete out[key];
  delete out[SERVICE_LOCATIONS_KEY];
  return out;
}

/**
 * #2041 findings 1/6 — the `redactCustomerRowUnless` twin for the SIBLING top-level
 * `service_location` block (see `SERVICE_LOCATION_ADDRESS_KEYS` above). Strips the address lines
 * only — `id` stays, `readable` is the SAME already-judged verdict the caller passed to
 * `redactCustomerRowUnless` for that row's customer, never re-derived from the location itself
 * (a `ServiceLocation` carries no ownership proof of its own). Used by `redactCustomerContactFor`
 * below (estimate/invoice presenters) and directly by the lead/job existing-customer create paths,
 * the same two call sites `redactCustomerRowUnless` already serves.
 */
export function redactServiceLocationRowUnless(
  row: CustomerRow | null | undefined,
  readable: boolean,
): CustomerRow | null | undefined {
  if (!row || readable) return row;
  const out: CustomerRow = { ...row };
  for (const key of SERVICE_LOCATION_ADDRESS_KEYS) delete out[key];
  return out;
}

function isPlainObject(v: unknown): v is CustomerRow {
  return typeof v === 'object' && v !== null;
}

/**
 * #1997 round 3, finding 1 (HIGH) — the customer row whose read-verdict gates the TOP-LEVEL
 * `public_token`: the redacted authenticated detail response still carried it, and the
 * unauthenticated public PDF twin (`GET /:id/public/pdf?token=`) accepts it with no `read Customer`
 * check at all, so a requester denied the contact block could read the token off this response and
 * launder it into the full, un-redacted block through that other route.
 *
 * Priority mirrors what the enumerated selects actually project: the document's own `customer`
 * when present, else — ONLY when there is no top-level one — the nested anchor: `lead.customer`
 * for an estimate reached only through its lead, `job.customer` for a (legacy) job-anchored
 * invoice whose own `customer_id` was never backfilled. This is the same fallback
 * `invoice.controller.ts` already uses everywhere else (`invoice.customer ?? invoice.job?.customer`).
 *
 * Exported (round 3) — see `isCustomerReadable` above for why.
 */
export function resolveTokenAnchor(doc: CustomerRow): CustomerRow | undefined {
  if (isPlainObject(doc.customer)) return doc.customer;
  if (isPlainObject(doc.lead) && isPlainObject((doc.lead as CustomerRow).customer)) {
    return (doc.lead as CustomerRow).customer as CustomerRow;
  }
  if (isPlainObject(doc.job) && isPlainObject((doc.job as CustomerRow).customer)) {
    return (doc.job as CustomerRow).customer as CustomerRow;
  }
  return undefined;
}

/**
 * Walks `doc.customer`, `doc.lead.customer` and `doc.job.customer` — the three anchors the
 * enumerated detail selects ever nest a customer under — and redacts each independently (a
 * requester's scope on the direct anchor says nothing about the lead's, and vice versa). Accepts
 * a null/undefined `doc` unchanged (several call sites hand it one: `invoice.controller.ts:3195`,
 * `:3342`, `estimate.controller.ts:2557`, `:3372`). Never mutates the input; never inspects
 * `req.user.role` — the only signal is `can(req, 'read', 'Customer', row)`.
 *
 * Also deletes the document's own top-level `public_token` (see `resolveTokenAnchor` above) when
 * the resolved anchor customer is not readable. A document with no customer anchor at all is left
 * alone — there is nothing to judge, so nothing to strip.
 */
export function redactCustomerContactFor<T>(req: Request, doc: T): T {
  if (!isPlainObject(doc)) return doc;
  const out: CustomerRow = { ...doc };

  if (isPlainObject(doc.customer)) {
    out.customer = redactRow(req, doc.customer);
  }
  if (isPlainObject(doc.lead)) {
    const lead = doc.lead as CustomerRow;
    out.lead = isPlainObject(lead.customer) ? { ...lead, customer: redactRow(req, lead.customer) } : lead;
  }
  if (isPlainObject(doc.job)) {
    const job = doc.job as CustomerRow;
    out.job = isPlainObject(job.customer) ? { ...job, customer: redactRow(req, job.customer) } : job;
  }

  const tokenAnchor = resolveTokenAnchor(doc);
  if (tokenAnchor) {
    const anchorReadable = isCustomerReadable(req, tokenAnchor);
    if (!anchorReadable) {
      delete out[PUBLIC_TOKEN_KEY];
    }
    // Findings 1/6 — the document's OWN `service_location` (its street address) is judged by the
    // SAME anchor `public_token` above just was; a doc with no resolvable anchor at all is left
    // alone (nothing to judge), same rule `resolveTokenAnchor`'s caller already follows.
    if (isPlainObject(doc.service_location)) {
      out.service_location = redactServiceLocationRowUnless(doc.service_location as CustomerRow, anchorReadable);
    }
  }

  return out as T;
}

/**
 * The estimate-side presenter — the final expression at every one of estimate.controller.ts's 17
 * detail-shaped response sites and estimate-lines.controller.ts's 8. A thin, intentionally
 * behavior-free wrapper: keeping it distinct from `redactCustomerContactFor` (rather than importing
 * the helper directly at every call site) is what the source-scanning guard test greps for, and it
 * is the one place a future second estimate-side transform could be added without touching 25 call
 * sites — see Ruling 1 in the spec for why this stays pure/synchronous and does not also apply
 * `stripEstimateCost` or `projectEstimateLeadWalkthrough`.
 */
export function presentEstimateDetail<T>(req: Request, doc: T): T {
  return redactCustomerContactFor(req, doc);
}

/**
 * The invoice-side presenter — the final expression at every one of invoice.controller.ts's 12
 * detail-shaped response sites, invoice-lines.controller.ts's 11, and the invoice-shaped
 * `estimate.controller.ts::copyToInvoice` response. See `presentEstimateDetail` above.
 */
export function presentInvoiceDetail<T>(req: Request, doc: T): T {
  return redactCustomerContactFor(req, doc);
}
