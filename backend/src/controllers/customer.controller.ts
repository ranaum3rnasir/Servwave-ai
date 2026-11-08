import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus, JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { logger } from '../lib/logger';
import { parsePagination, buildPaginationMeta, parseSortParams, respondInvalidSort } from '../lib/pagination';
import { CUSTOMER_SORT_FIELDS } from '../lib/sortFields';
import { parseArrayParam } from '../lib/query/parseArrayParam';
import { applyFilters } from '../lib/query/filterEngine';
import { customerFacets } from '../lib/query/registries/customer.filters';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import {
  getCustomerScope,
  canReadCustomerById,
  matchesFragment,
  proofSelectFor,
  stripCustomerProofKeys,
} from '../lib/permissions/customerScope';
import { projectJobCrewUnion } from '../lib/job-crew';
import { projectJobScheduleFields } from '../lib/job-schedule-projection';
import { customerScheduleVisitsArg, presentScheduleVisit } from '../lib/customer-schedule';
import { hasFeature } from '../middleware/requireFeature';
import { withRequiredCustomerFields } from '../lib/customer-create';
import { withNumberCollisionRetry } from '../lib/number-collision-retry';
import { hasPaymentInSubtree, paymentSummaryForSubtree, purgeCustomerSubtree } from '../lib/purge';
import { findDuplicateCustomer, duplicateConflictBody } from '../lib/customer-duplicate';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import { logAudit } from '../lib/audit';
import { computeRenumber, applyRenumber, type RenumberComputation } from '../lib/record-renumber';
import { optionalCustomerEmail, hasPhoneOrEmail, CONTACT_REQUIRED_MSG } from '../lib/email-schema';
import { requiredCustomerPhone, optionalCustomerPhone } from '../lib/phone-schema';
import { hasNameOrCompany, deriveCustomerKind } from '../lib/customer-kind';
import { ESTIMATE_STATUS } from '../constants/estimateStatus';
import { loadTagsByEntity, loadTagsForEntity } from '../lib/tags';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../lib/custom-fields';
import { openTaskStatusFilter } from '../lib/tasks/status';
import { getRequestOrgTimezone } from '../lib/timezone';
import { orgTodayStart } from '../lib/orgDayRange';

// ─── Shared status sets ────────────────────────────────

// Every status that is not closed (Won, Lost, Cancelled): a lead with a walkthrough booked or done
// is still open work.
const OPEN_LEAD_STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'];
// Open pipeline minus untouched NEW — leads being actively worked (see lead-semantics note).
// Derived from OPEN so active ⊆ open holds by construction; PRODUCT DECISION PENDING —
// if product rules active ≡ open, delete the .filter and alias ACTIVE_LEAD_STATUSES = OPEN_LEAD_STATUSES.
const ACTIVE_LEAD_STATUSES: LeadStatus[] = OPEN_LEAD_STATUSES.filter((s) => s !== 'NEW');
// Multi-visit S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus - they are properties of a
// TRIP and live on VisitStatus. A customer whose tech is en route or on site still reads as having
// an active job, because that job now derives SCHEDULED or IN_PROGRESS.
const ACTIVE_JOB_STATUSES: JobStatus[] = ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS'];

// ─── Select Objects ────────────────────────────────────

const customerSelect = {
  id: true,
  customer_number: true,
  first_name: true,
  last_name: true,
  company_name: true,
  email: true,
  phone: true,
  phone_ext: true,
  secondary_phone: true,
  secondary_phone_ext: true,
  ad_source: true,
  allow_billing: true,
  tax_exempt: true,
  payment_type: true,
  // SRVW-114 slice 3 - { "<CustomFieldDefinition-uuid>": <scalar> }. ExtraInfoPanel reads this
  // bag off the detail payload; without it the panel renders every field blank.
  custom_fields: true,
  created_at: true,
  updated_at: true,
  // entity-redesign §2/§10 (additive)
  kind: true,
  segment: true,
  is_parent: true,
  parent_id: true,
  bill_to_customer_id: true,
  billing_address_line1: true,
  billing_address_line2: true,
  billing_city: true,
  billing_state: true,
  billing_zip: true,
  billing_terms: true,
  source: true,
  notes: true,
  is_active: true,
  archived_at: true,
  extra_emails: {
    select: { id: true, email: true, label: true, receives_emails: true },
    orderBy: { created_at: 'asc' as const },
  },
  phones: { select: { id: true, phone: true, label: true, extension: true, is_primary: true }, orderBy: { created_at: 'asc' as const } },
};

const locationSelect = {
  id: true,
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  zip: true,
  is_primary: true,
  is_active: true,
  archived_at: true,
  created_at: true,
};

// ─── Zod Schemas ───────────────────────────────────────

const locationSchema = z.object({
  address_line1: z.string().min(1).max(200),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(2).max(2),
  zip: z.string().min(5).max(10),
  is_primary: z.boolean().optional(),
});

const extraEmailSchema = z.object({
  email: z.string().email(),
  label: z.string().max(50).optional(),
  // Opt this address in to the org's AUTOMATED customer mail (Automation Center).
  // Optional on the wire, but absence means FALSE at the write below, never the
  // column default — see normalizeExtraEmails.
  receives_emails: z.boolean().optional(),
});

type ExtraEmailInput = z.infer<typeof extraEmailSchema>;

/**
 * Both write paths recreate extra_emails from scratch (create, and the PATCH's
 * deleteMany+create), so an omitted `receives_emails` would otherwise fall through to
 * the column default of TRUE and silently opt an address in every time an older client
 * re-saved a customer. Defaulting to false here keeps the opt-in deliberate: the flag
 * is on only because a caller said so. The form always sends it explicitly, with true
 * for freshly added rows.
 */
function normalizeExtraEmails(rows: ExtraEmailInput[]) {
  return rows.map(({ email, label, receives_emails }) => ({
    email,
    label,
    receives_emails: receives_emails ?? false,
  }));
}

// entity-redesign §2 — phones[] ({phone, label?, extension?, is_primary?}). Spec wants
// 1+ phones, but that tightening is DEFERRED to the FE phase + Phase D, so the array
// itself stays .optional() to keep legacy single-phone create working.
const phoneSchema = z.object({
  phone: requiredCustomerPhone,
  label: z.string().max(50).optional().nullable(),
  extension: z.string().max(10).optional().nullable(),
  is_primary: z.boolean().optional(),
});

// Shared additive entity-redesign §2/§10 fields (all optional, backward-compatible).
// NOTE: `kind` intentionally is NOT here — it is derived server-side only
// (unified-client-creation §5.1), never accepted from the client.
const redesignFields = {
  segment: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
  is_parent: z.boolean().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  bill_to_customer_id: z.string().uuid().nullable().optional(),
  billing_address_line1: z.string().max(200).nullable().optional(),
  billing_address_line2: z.string().max(200).nullable().optional(),
  billing_city: z.string().max(100).nullable().optional(),
  billing_state: z.string().min(2).max(2).nullable().optional(),
  billing_zip: z.string().max(10).nullable().optional(),
  billing_terms: z.string().max(50).nullable().optional(),
  source: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  phones: z.array(phoneSchema).optional(),
  // convenience: copy the primary service-location address into billing_* before persist
  billing_same_as_service_location: z.boolean().optional(),
};

// Customer must have a first name OR a company name (unified-client-creation §2).
// Last name + email are optional everywhere — see hasNameOrCompany / hasPhoneOrEmail.
export const createCustomerSchema = z
  .object({
    first_name: z.string().max(100).optional().nullable(),
    last_name: z.string().max(100).optional().nullable(),
    company_name: z.string().max(200).optional().nullable(),
    email: optionalCustomerEmail,
    phone: optionalCustomerPhone,
    phone_ext: z.string().max(10).optional().nullable(),
    secondary_phone: optionalCustomerPhone,
    secondary_phone_ext: z.string().max(10).optional().nullable(),
    ad_source: z.string().max(100).optional().nullable(),
    allow_billing: z.boolean().optional(),
    tax_exempt: z.boolean().optional(),
    payment_type: z.string().max(100).optional().nullable(),
    extra_emails: z.array(extraEmailSchema).optional(),
    locations: z.array(locationSchema).optional(),
    ...redesignFields,
  })
  .refine(hasNameOrCompany, {
    message: 'Customer must have either a first name or a company name',
    path: ['first_name'],
  })
  .refine(hasPhoneOrEmail, {
    message: CONTACT_REQUIRED_MSG,
    path: ['phone'],
  });

// PATCH is intentionally permissive about person-or-company — the rule is enforced at create.
// A partial update touching only first_name shouldn't have to also restate last_name/company_name.
export const updateCustomerSchema = z.object({
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  company_name: z.string().max(200).optional().nullable(),
  email: optionalCustomerEmail,
  phone: optionalCustomerPhone,
  phone_ext: z.string().max(10).optional().nullable(),
  secondary_phone: optionalCustomerPhone,
  secondary_phone_ext: z.string().max(10).optional().nullable(),
  ad_source: z.string().max(100).optional().nullable(),
  allow_billing: z.boolean().optional(),
  tax_exempt: z.boolean().optional(),
  payment_type: z.string().max(100).optional().nullable(),
  extra_emails: z.array(extraEmailSchema).optional(),
  created_at: z.coerce.date().refine((d) => d <= new Date(), 'created_at cannot be in the future').optional(),
  ...redesignFields,
  // SRVW-114 slice 3 - ExtraInfoPanel's save patch, keyed by CustomFieldDefinition uuid, same
  // shape the job and lead PATCHes accept. Values are `unknown` here on purpose: legality
  // depends on the org's own definitions, so validateCustomFieldValues enforces it downstream.
  // An explicit null clears a key (see mergeCustomFields).
  custom_fields: z.record(z.string().uuid(), z.unknown()).optional(),
});

export const createLocationSchema = locationSchema;

export const updateLocationSchema = z.object({
  address_line1: z.string().min(1).max(200).optional(),
  address_line2: z.string().max(200).optional().nullable(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(2).max(2).optional(),
  zip: z.string().min(5).max(10).optional(),
  is_primary: z.boolean().optional(),
});

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

interface LocationInput {
  address_line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  is_primary?: boolean;
}

// "Same as service location" convenience — copy the primary (or first) location address
// into billing_* before persist. Mutates the data object in place.
function applyBillingCopy(data: Record<string, unknown>, locations?: LocationInput[]): void {
  if (!data.billing_same_as_service_location || !locations?.length) return;
  const primary = locations.find((l) => l.is_primary) ?? locations[0];
  data.billing_address_line1 = primary.address_line1 ?? null;
  data.billing_city = primary.city ?? null;
  data.billing_state = primary.state ?? null;
  data.billing_zip = primary.zip ?? null;
}

// §2 — phone primary invariant (CUST-06). The API is authoritative regardless of payload:
// if any row flags is_primary, keep only the FIRST such row primary and force the rest false;
// if none is flagged, default the first phone to primary. Returns persist-ready create rows.
function normalizePhones(phones: z.infer<typeof phoneSchema>[]): Array<{
  phone: string;
  label: string | null;
  extension: string | null;
  is_primary: boolean;
}> {
  const primaryIndex = phones.findIndex((p) => p.is_primary === true);
  const winner = primaryIndex >= 0 ? primaryIndex : 0;
  return phones.map((p, i) => ({
    phone: p.phone,
    label: p.label ?? null,
    extension: p.extension ?? null,
    is_primary: i === winner,
  }));
}

class GuardError extends Error {}

// Editable record IDs (Workiz dual-run) - carries the tx-fresh conflict computation out of
// the rename transaction so the 409 handler doesn't have to re-derive it a second time,
// outside the lock, from a possibly-stale read. See renameCustomer below.
class RenumberConflictError extends Error {
  constructor(public readonly computation: RenumberComputation) {
    super('Conflicting number(s) already exist in this organization');
  }
}

// §10 — parent_id must be a top-level billing group (its own parent_id IS NULL), in the
// same tenant, and not self. bill_to target must be self OR the resolved parent. Returns
// nothing; throws GuardError (→ 400) on violation. selfId is undefined on create.
//
// `effectiveParentId` is the parent the bill_to invariant is evaluated against. On create it
// equals data.parent_id. On PATCH the caller passes the EFFECTIVE parent (the edited value if
// parent_id is part of the edit, otherwise the persisted parent_id from the row) so a member
// that PATCHes only { bill_to_customer_id: P } is correctly accepted instead of falsely 400'd.
async function validateParentAndBillTo(
  req: Request,
  data: { parent_id?: string | null; bill_to_customer_id?: string | null; is_parent?: boolean },
  selfId?: string,
  effectiveParentId?: string | null,
  effectiveIsParent?: boolean,
): Promise<void> {
  const parentId = data.parent_id ?? null;

  // Franchise conflict — a customer that sits UNDER a franchise (has an effective parent)
  // cannot itself be a franchise. Evaluated against the effective parent_id + is_parent so
  // it holds on create AND on PATCH (where either value may come from the persisted row).
  const conflictParentId = effectiveParentId !== undefined ? effectiveParentId : parentId;
  const conflictIsParent = effectiveIsParent !== undefined ? effectiveIsParent : data.is_parent === true;
  if (conflictParentId !== null && conflictIsParent === true) {
    throw new GuardError('A customer under a franchise cannot itself be a franchise');
  }

  if (parentId) {
    if (selfId && parentId === selfId) {
      throw new GuardError('A customer cannot be its own parent');
    }
    const parent = await prisma.customer.findFirst({
      where: { id: parentId, ...tenantWhere(req) },
      select: { id: true, parent_id: true, is_parent: true },
    });
    if (!parent) throw new GuardError('Parent customer not found in this organization');
    if (parent.parent_id !== null) {
      throw new GuardError('Parent must be a top-level customer (billing group)');
    }
    if (parent.is_parent !== true) {
      throw new GuardError('Parent must be a franchise (billing group)');
    }
  }

  // bill_to ∈ {self, the effective parent billing group}. effectiveParentId defaults to the
  // edited/created parentId when not supplied (create + the parent-only edit path).
  const billToParent = effectiveParentId !== undefined ? effectiveParentId : parentId;
  if (data.bill_to_customer_id !== undefined && data.bill_to_customer_id !== null) {
    const billTo = data.bill_to_customer_id;
    const isSelf = selfId !== undefined && billTo === selfId;
    const isParent = billToParent !== null && billTo === billToParent;
    if (!isSelf && !isParent) {
      throw new GuardError('bill_to must be the customer itself or its parent billing group');
    }
  }
}

// ─── Handlers ──────────────────────────────────────────

/**
 * The customer search OR-clauses shared by the list/export filter and the #2041 picker
 * endpoint below — one definition so the two can never drift on what "search" means.
 */
function customerSearchOrClauses(search: string) {
  return [
    { customer_number: { contains: search, mode: 'insensitive' as const } },
    { first_name: { contains: search, mode: 'insensitive' as const } },
    { last_name: { contains: search, mode: 'insensitive' as const } },
    { company_name: { contains: search, mode: 'insensitive' as const } },
    // #350 — phone search is digit-normalized both ways so a digits-only query
    // (`5551234567`) finds a formatted store (`(555) 123-4567`) and vice-versa.
    // #460 — search BOTH the legacy scalar Customer.phone AND the phones[] relation
    // (CustomerPhone), where the current create/edit path now stores numbers.
    ...phoneSearchClauses(search),
    ...phoneRelationSearchClauses(search),
    { email: { contains: search, mode: 'insensitive' as const } },
    { extra_emails: { some: { email: { contains: search, mode: 'insensitive' as const } } } },
  ];
}

/**
 * A customer's lead/job relation counts: the requester's own row scope AND the tenant. The row
 * scope is `{}` for ADMIN, so it cannot be relied on to carry the tenant; without this arm a job
 * or lead row another organization points at a customer would be counted (slice 06).
 */
function scopedRelationCounts(req: Request, leadScope: Record<string, unknown>, jobScope: Record<string, unknown>) {
  return {
    select: {
      leads: { where: { AND: [tenantWhere(req), leadScope] } },
      jobs: { where: { AND: [tenantWhere(req), jobScope] } },
    },
  };
}

/**
 * Build the `where` clause for the customer list/export, parsing tenant scope and every
 * filter from `req.query`. Extracted from `list()` so the unpaginated `exportAll` applies
 * the IDENTICAL filter set — list and export can never drift.
 */
export async function buildCustomerListWhere(req: Request): Promise<Record<string, unknown>> {
  const search = (req.query.search as string) || '';
  const cityFilter = (req.query.city as string) || '';
  const stateFilters = parseArrayParam(req.query.state);
  const hasLeads = (req.query.has_leads as string) || '';
  const hasJobs = (req.query.has_jobs as string) || '';
  const isParent = (req.query.is_parent as string) || '';

  const searchWhere = search ? { OR: customerSearchOrClauses(search) } : {};

  // Build location filter. `state` STAYS hand-rolled (not a customer.filters.ts facet) because
  // it's coupled with `city` — a free-text `{ contains }` filter that isn't a facet at all — in
  // the SAME `service_locations.some` sub-object. Splitting `state` out into a facet would need
  // a merge dance with this non-facet `city` block for no benefit; the frontend still gets the
  // same `?state=CA,TX` wire contract either way (Task 17 facets `state`, backend just doesn't
  // route it through the shared engine).
  const locationWhere: Record<string, unknown> = {};
  if (cityFilter) locationWhere.city = { contains: cityFilter, mode: 'insensitive' };
  if (stateFilters.length > 0) locationWhere.state = stateFilters.length === 1 ? stateFilters[0] : { in: stateFilters };

  // §11 — list defaults to active customers; archived are included only when explicitly
  // requested (include_archived=true) or when searching (so a search can find them).
  const includeArchived = req.query.include_archived === 'true' || !!search;

  const where: Record<string, unknown> = {
    ...tenantWhere(req),
    ...(includeArchived ? {} : { is_active: true }),
    ...searchWhere,
    ...(Object.keys(locationWhere).length > 0 ? { service_locations: { some: locationWhere } } : {}),
    ...(hasLeads === 'true' ? { leads: { some: {} } } : {}),
    ...(hasLeads === 'false' ? { leads: { none: {} } } : {}),
    ...(hasJobs === 'true' ? { jobs: { some: {} } } : {}),
    ...(hasJobs === 'false' ? { jobs: { none: {} } } : {}),
    ...((req.query.open_leads as string) === 'true' ? { leads: { some: { status: { in: OPEN_LEAD_STATUSES } } } } : {}),
    ...((req.query.active_jobs as string) === 'true' ? { jobs: { some: { status: { in: ACTIVE_JOB_STATUSES } } } } : {}),
    // customer-form-redesign — "is_parent" filters to franchises (billing groups), the only
    // customers eligible to be a parent. Used by the customer-form parent picker.
    ...(isParent === 'true' ? { is_parent: true } : {}),
  };

  // Generalized filter engine (Task 16): ad_source, payment_type, tax_exempt (2-option
  // boolean), and the first DOUBLE-countRange case in the app — leads_min/leads_max +
  // jobs_min/jobs_max on the SAME parent model (Customer), each grouping a different child
  // model by its own customer_id FK. See customer.filters.ts for the double-countRange trace.
  // The existence/tri-state toggles above (has_leads/has_jobs/open_leads/active_jobs) touch
  // where.leads/where.jobs, never where.id/where.AND, so they compose cleanly alongside
  // whatever id-filter(s) applyFilters adds.
  await applyFilters(where, req, customerFacets);

  // #2041 — SALES's row scope, composed with AND (never a spread, never `where.OR =`):
  // OWN_CUSTOMER's top-level key is `OR` and its arms are keyed `leads`/`jobs`, both of which
  // this function may ALREADY have set above (`has_leads`/`open_leads` -> where.leads,
  // `has_jobs`/`active_jobs` -> where.jobs) or via `searchWhere` (`where.OR`). Spreading the
  // fragment in would silently clobber one or the other. Appended AFTER applyFilters, which also
  // writes `where.AND` (Task 16's double-countRange case) — asArray keeps both compositions.
  const scope = await scopeWhereForReq(req, 'Customer');
  if (Object.keys(scope).length) {
    where.AND = [...asArray(where.AND), scope];
  }

  return where;
}

function asArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v !== undefined) return [v as Record<string, unknown>];
  return [];
}

export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });
    const sort = parseSortParams(req.query as any, CUSTOMER_SORT_FIELDS);
    if (!sort.ok) {
      respondInvalidSort(res, sort);
      return;
    }
    const orderBy = sort.orderBy;
    const search = (req.query.search as string) || '';

    const where = await buildCustomerListWhere(req);

    // Always include primary location for address column; expand when searching
    const locationSelect = search
      ? {
          service_locations: {
            select: { id: true, address_line1: true, address_line2: true, city: true, state: true, zip: true, is_primary: true },
            orderBy: { is_primary: 'desc' as const },
          },
        }
      : {
          service_locations: {
            where: { is_primary: true },
            select: { address_line1: true, city: true, state: true, zip: true },
            take: 1,
          },
        };

    // #2041 R1 (blocking) — the SQL `where` above is the real enforcement, but the frozen test
    // (`repro-2041.test.ts:104`) stubs `findMany` directly, bypassing it, so a where-only fix
    // still returns an unassociated row. `proofSelect` projects the customer scope's own proof
    // relations into the select; anything that reaches this app layer despite the SQL scope is
    // dropped in memory and WARN-logged (an invariant violation in production, never a silent
    // short page) rather than trusted.
    const scope = await scopeWhereForReq(req, 'Customer');
    const [leadScope, jobScope] = await Promise.all([
      scopeWhereForReq(req, 'Lead'),
      scopeWhereForReq(req, 'Job'),
    ]);
    const proofSelect = proofSelectFor(scope, req.user!.id);

    const [rawCustomers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        select: {
          ...customerSelect,
          ...locationSelect,
          ...proofSelect,
          // #2041 decision 4 — `_count` follows the requester's OWN Lead/Job scope (filtered
          // relation count), so a SALES row's `leads`/`jobs` tally matches what they can actually
          // open, not the customer's org-wide totals. `{}` for ADMIN, so ADMIN is untouched.
          _count: scopedRelationCounts(req, leadScope, jobScope),
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    const customers = rawCustomers
      .filter((c) => {
        const ok = matchesFragment(scope, c);
        if (!ok) {
          logger.warn(`#2041: GET /api/customers SQL scope returned customer ${c.id} which failed the in-memory proof re-check — dropped from the response. This should never happen in production.`);
        }
        return ok;
      })
      .map((c) => stripCustomerProofKeys(c));

    // SRVW-103 - one batched, tenant-scoped tag read for the whole page (never one per row).
    const tagsByCustomer = await loadTagsByEntity(req, 'CUSTOMER', customers.map((c) => c.id));

    res.json({
      customers: customers.map((c) => ({ ...c, tags: tagsByCustomer.get(c.id) ?? [] })),
      pagination: buildPaginationMeta(total, { page, limit, skip }),
    });
  } catch (err) {
    logger.error('List customers error:', err);
    res.status(500).json({ error: 'Failed to list customers' });
  }
}

// ─── Org-wide picker (Ran's carve-out, #2041 slice 1) ──────────────────────

// #2041 R6 — the client-sent limit is never trusted; anything above this is clamped.
const PICKER_MAX_LIMIT = 25;
const PICKER_DEFAULT_LIMIT = 10;

const pickerSelect = {
  id: true,
  first_name: true,
  last_name: true,
  company_name: true,
  phone: true,
  phone_ext: true,
  email: true,
  ad_source: true,
  tax_exempt: true,
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
} as const;

type PickerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  phone: string | null;
  phone_ext: string | null;
  email: string | null;
  ad_source: string | null;
  tax_exempt: boolean;
  service_locations: { city: string; is_primary: boolean }[];
};

function pickerPhoneLast4(phone: string | null | undefined): string {
  return (phone || '').replace(/\D/g, '').slice(-4);
}

function pickerPrimaryCity(locations: PickerRow['service_locations'] | undefined): string | null {
  if (!locations || locations.length === 0) return null;
  const primary = locations.find((l) => l.is_primary) ?? locations[0];
  return primary.city ?? null;
}

/**
 * Per-row readability verdict for the picker projection (decision 7). #2041 slice 2: SALES's
 * `read Customer` grant is now conditioned (OWN_CUSTOMER), so a picker row the requester is not
 * associated with comes back `restricted: true`. `canReadCustomerById` is the same decision-3
 * helper `getById` uses — a dedicated proof-only probe, memoised per (request, id), so a picker
 * page that also expands the selection (`pickerGetById`) pays for at most one query per row.
 */
async function isPickerRowReadable(req: Request, row: Pick<PickerRow, 'id'>): Promise<boolean> {
  return canReadCustomerById(req, row.id);
}

/**
 * Project a raw picker row into the wire shape, redacted when `readable` is false.
 * A readable row carries today's picker fields (bit-for-bit what the pre-#2041 typeahead
 * returned) plus `tax_exempt` — a boolean flag, no contact data, needed by the create forms'
 * tax preview. An unreadable row carries ONLY id, first/last name, company name, the last 4
 * digits of the phone and the primary location's city — never email, phone, address lines,
 * customer_number, `_count`, ad_source or tax_exempt (decision 7 / R6). Exported so slice 2 can
 * reuse it without touching the handlers below.
 */
export function projectPickerRow(row: PickerRow, readable: boolean) {
  if (!readable) {
    return {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      company_name: row.company_name,
      phone_last4: pickerPhoneLast4(row.phone),
      city: pickerPrimaryCity(row.service_locations),
      restricted: true as const,
    };
  }
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    company_name: row.company_name,
    phone: row.phone,
    phone_ext: row.phone_ext,
    email: row.email,
    ad_source: row.ad_source,
    tax_exempt: row.tax_exempt,
    service_locations: row.service_locations,
    restricted: false as const,
  };
}

/**
 * GET /api/customers/picker?search=&limit= — the org-wide create-form typeahead (Ran's
 * carve-out, spec "Solution" item 4, decision 7). Deliberately `tenantWhere(req)` ONLY, no row
 * scope: a rep must be able to start a lead/job/estimate/invoice on a customer they have never
 * worked with. `search` is required and must be >= 2 characters (R6, mirrors
 * `search.controller.ts`'s `q.length < 2` rule) — anything shorter or absent returns an empty
 * list, never the book.
 *
 * Note (R6): `picker/:id` (below) will happily resolve the `existing.id` a redacted
 * duplicate-409 body carries (`customer-duplicate.ts`) down to name + company + `phone_last4`
 * + city. That is the SAME information a `picker?search=<the phone the requester already
 * typed>` call returns by design — not a #1996 regression, but a stated consequence of this
 * carve-out.
 */
export async function picker(req: Request, res: Response) {
  try {
    const search = ((req.query.search as string) || '').trim();
    if (search.length < 2) {
      res.json({ customers: [] });
      return;
    }

    const rawLimit = parseInt((req.query.limit as string) || '', 10);
    const limit = Math.min(
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : PICKER_DEFAULT_LIMIT,
      PICKER_MAX_LIMIT,
    );

    const where = {
      ...tenantWhere(req),
      is_active: true,
      OR: customerSearchOrClauses(search),
    };

    const rows = await prisma.customer.findMany({
      where,
      select: pickerSelect,
      take: limit,
      orderBy: { created_at: 'desc' },
    });

    const customers = await Promise.all(
      (rows as PickerRow[]).map(async (row) => projectPickerRow(row, await isPickerRowReadable(req, row))),
    );

    res.json({ customers });
  } catch (err) {
    logger.error('Customer picker search error:', err);
    res.status(500).json({ error: 'Failed to search customers' });
  }
}

/**
 * GET /api/customers/picker/:id — the "expand the picked customer" fetch the create forms
 * make after a typeahead selection (or after re-opening a duplicate match). Returns EXACTLY
 * the same projection `picker` returns for that row — restricted rows included, never a
 * richer twin (R6) — and 404 for an out-of-org id, same body a cross-org id already gets
 * everywhere else in this file.
 */
export async function pickerGetById(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const row = (await prisma.customer.findUnique({
      where: { id, ...tenantWhere(req) },
      select: pickerSelect,
    })) as PickerRow | null;

    if (!row) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customer = projectPickerRow(row, await isPickerRowReadable(req, row));
    res.json({ customer });
  } catch (err) {
    logger.error('Customer picker detail error:', err);
    res.status(500).json({ error: 'Failed to load customer' });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const { locations, extra_emails, phones, billing_same_as_service_location, ...rest } = req.body;
    const orgId = req.user!.organization_id;

    // §10 guards — parent must be a top-level billing group; bill_to ∈ {self, parent}.
    // (On create there is no self id yet, so bill_to may only equal the parent.)
    try {
      await validateParentAndBillTo(req, rest);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Duplicate-customer guard (Fixes #42) — block a create whose primary email
    // OR phone already exists in this org. `?override=true` bypasses the block
    // but the match is still recorded on the timeline event below.
    const override = req.query.override === 'true';
    const duplicateMatch = await findDuplicateCustomer(prisma, orgId, {
      email: rest.email,
      phone: rest.phone,
    }, { requester: req });
    if (duplicateMatch && !override) {
      res.status(409).json(duplicateConflictBody(duplicateMatch));
      return;
    }

    // "same as service location" billing-address copy convenience.
    if (billing_same_as_service_location) {
      applyBillingCopy(Object.assign(rest, { billing_same_as_service_location: true }), locations);
      delete rest.billing_same_as_service_location;
    }

    const locationData = locations?.map((loc: z.infer<typeof locationSchema>, i: number) => ({
      ...loc,
      is_primary: locations.length === 1 ? true : (loc.is_primary ?? (i === 0)),
    }));

    const phoneData = phones && normalizePhones(phones);

    const customer = await withNumberCollisionRetry(() => prisma.$transaction(async (tx) => {
      return tx.customer.create({
        data: {
          // NOT-NULL safety — customer_number/kind/segment have no DB default.
          // The shared helper guarantees them (and organization_id); is_parent
          // flows via ...rest (defaults to false in the schema when omitted).
          ...(await withRequiredCustomerFields(tx, orgId, rest)),
          ...(locationData && {
            service_locations: { create: locationData },
          }),
          ...(extra_emails?.length && {
            extra_emails: { create: normalizeExtraEmails(extra_emails) },
          }),
          ...(phoneData?.length && {
            phones: { create: phoneData },
          }),
          // Audit: the acting user. LAST in the object on purpose - withRequiredCustomerFields
          // spreads the parsed body (`...rest`), and this has to win over anything arriving that
          // way. Nothing can today (the zod create schema declares no created_by_* key, so
          // validate() strips them), and the ordering keeps that true if the schema ever grows.
          ...createdByUser(req),
        },
        select: {
          ...customerSelect,
          service_locations: { select: locationSelect },
        },
      });
    }), { label: 'customer.create' });

    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'CUSTOMER',
        entity_id: customer.id,
        event_type: 'CUSTOMER_CREATED',
        // On an override-create, record the bypassed duplicate — the only
        // forward audit trail for #42 (no merge tool yet). #1996: for a requester who could
        // not read the matched row, the description/metadata must not leak it either — a
        // neutral description and no `matched_customer_number`.
        description: duplicateMatch
          ? duplicateMatch.readable
            ? `Customer created (duplicate of ${duplicateMatch.match.customer_number} bypassed)`
            : 'Customer created (duplicate of an existing customer bypassed)'
          : 'Customer created',
        ...(duplicateMatch && {
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
        }),
        created_by: req.user!.id,
      },
    });

    void logAudit({ req, action: 'customer.created', resourceType: 'Customer', resourceId: customer.id });
    res.status(201).json({ customer });
  } catch (err) {
    logger.error('Create customer error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
}

// ─── Shared Financial Helper ──────────────────────────────
// Single source of truth for customer-anchored financial aggregation.
// Both getById and getSummary use this so they can never disagree.
//
// THE PAST DUE / DUE SPLIT CUTS ON THE ORG'S CALENDAR DAY, NOT ON `NOW()` (#1823).
//
// `due_date < NOW()` asked Postgres "is this instant in the past", which buckets every
// invoice due EARLIER TODAY as past due — while the OVERDUE chip rendered a few pixels
// away on the same record asks `orgDayDiff(due_date, tz) < 0`
// (frontend/src/lib/invoices/invoiceMoney.ts -> isOverdue) and calls it merely SENT.
// This tile is the surface the 20260825190000_invoice_due_date_backfill migration header
// named as its motivation and then missed; `orgTodayStart` is the exact instant expression
// of that chip's predicate (see backend/src/lib/orgDayRange.ts:94 and its header).
//
// `timeZone` is REQUIRED and resolved by the CALLER — required because a defaulted zone is
// how the wrong clock leaks back in (the #1634 anti-pattern, restated at
// services/ar-aging-report.ts:56), and caller-resolved because this function must stay
// `await`-free until its `$queryRaw`: both call sites issue it inside a `Promise.all`
// alongside two more `$queryRaw`s, and the suites stub those BY CALL ORDER
// (__tests__/customers.test.ts:1814, __tests__/tag-read-hydration.test.ts:69). An internal
// `await` for the zone lookup would reorder this query behind the other two.
//
// The boundary is bound as a PARAMETER, not interpolated: `$queryRaw` is a tagged template,
// so `${overdueBefore}` is `$n` on the wire, exactly like the `${id}::uuid` casts below.
// The zone STRING never enters SQL at all — the calendar arithmetic happens in TS, which is
// what every other org-clock reader here does (dashboard.controller.ts:74-76,
// invoice.controller.ts:964).
async function loadCustomerFinancials(id: string, orgId: string, timeZone: string) {
  // ISO-8601 with an explicit `Z`, cast in SQL exactly like the `${id}::uuid` binds below:
  // a text -> timestamptz cast of a Z-bearing instant is exact in every session TimeZone,
  // and unlike a bare Date bind it makes no assumption about how the query engine types the
  // parameter. `due_date` (schema.prisma:1185) is this repo's only @db.Timestamptz column
  // read from raw SQL, so there is no in-repo Date-bind precedent for it to lean on.
  // The `due_date IS NULL` arm on the due_balance side below is KEPT. Migration
  // 20260825190000 backfilled every open invoice's due_date (still_null = 0), so it is moot
  // on today's data — but a newly created row can still be NULL, and dropping the arm would
  // silently exclude it from BOTH buckets, so the two tiles would stop summing to the open
  // balance. NULL -> "due, not past due" also matches the isOverdue guard on the frontend:
  // if (!invoice.due_date) return false.
  //
  // Kept here rather than as `--` lines inside the template: this is the only raw-SQL comment
  // in application code, and the template is transmitted verbatim, so it would ship ~370 bytes
  // to Postgres on every customer-detail request and add noise to pg_stat_statements.
  const overdueBefore = orgTodayStart(timeZone).toISOString();
  const result = await prisma.$queryRaw<Array<{
    lifetime_revenue: string | null;
    total_invoiced: string | null;
    past_due_balance: string | null;
    due_balance: string | null;
    unpaid_invoice_count: string;
    paid_invoice_count: string;
  }>>`
    SELECT
      COALESCE((SELECT SUM(p.amount) FROM payments p
                JOIN invoices i2 ON p.invoice_id = i2.id
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND (p.reference_number IS DISTINCT FROM 'DEPOSIT-CREDIT')), 0) AS lifetime_revenue,
      COALESCE((SELECT SUM(i2.total_amount) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'), 0) AS total_invoiced,
      COALESCE((SELECT SUM(i2.amount_due) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'
                  AND i2.status IN ('SENT','PARTIAL') AND i2.due_date < ${overdueBefore}::timestamptz), 0) AS past_due_balance,
      COALESCE((SELECT SUM(i2.amount_due) FROM invoices i2
                WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                  AND i2.kind <> 'DEPOSIT'
                  AND i2.status IN ('SENT','PARTIAL') AND (i2.due_date IS NULL OR i2.due_date >= ${overdueBefore}::timestamptz)), 0) AS due_balance,
      (SELECT COUNT(*) FROM invoices i2 WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                AND i2.kind <> 'DEPOSIT'
                AND i2.status IN ('SENT','PARTIAL')) AS unpaid_invoice_count,
      (SELECT COUNT(*) FROM invoices i2 WHERE i2.customer_id = ${id}::uuid AND i2.organization_id = ${orgId}::uuid
                AND i2.kind <> 'DEPOSIT'
                AND i2.status = 'PAID') AS paid_invoice_count
  `;
  const fin = result?.[0];
  return {
    lifetime_revenue: parseFloat(String(fin?.lifetime_revenue ?? '0')),
    total_invoiced: parseFloat(String(fin?.total_invoiced ?? '0')),
    past_due_balance: parseFloat(String(fin?.past_due_balance ?? '0')),
    due_balance: parseFloat(String(fin?.due_balance ?? '0')),
    paid_invoice_count: parseInt(String(fin?.paid_invoice_count ?? '0'), 10),
    unpaid_invoice_count: parseInt(String(fin?.unpaid_invoice_count ?? '0'), 10),
  };
}

export async function getById(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    // #2041 decision 3 — a SEPARATE, proof-only probe, judged in memory. Deliberately NOT
    // folded into the big `Promise.all` findUnique below: the frozen test's mock answers on
    // `where.id` alone regardless of `select`, so a spread-in scope there would still return B.
    // Same body a cross-org id already gets — never 403 (that confirms existence).
    if (!(await canReadCustomerById(req, id))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const [leadScope, jobScope] = await Promise.all([
      scopeWhereForReq(req, 'Lead'),
      scopeWhereForReq(req, 'Job'),
    ]);

    // AWAITED AHEAD OF THE BATCH, not inside it. Same trade-off dashboard.controller.ts:63-76
    // reasoned through and accepted: one memoized ~1ms lookup on the critical path, versus a
    // response whose Past Due tile disagrees with the OVERDUE chip on the invoice right below
    // it. It must be hoisted rather than awaited inside loadCustomerFinancials, or that
    // helper's `$queryRaw` would be issued after the other two in the batch — see the comment
    // on the helper.
    const timeZone = await getRequestOrgTimezone(req);

    // The job set the paged Jobs tab and the schedule feed read (tenant + Job row scope): Total
    // Jobs, Active Jobs and the embedded list can never count a job another org points here.
    const visibleJobs = customerJobsWhere(req, id, jobScope);

    const [customer, notes, orphanInvoices, financials, estimateResult, depositResult, allInvoices, openLeadsCount, activeLeadsCount, openTasksCount, activeJobsCount] = await Promise.all([
      prisma.customer.findUnique({
        where: { id, ...tenantWhere(req) },
        select: {
          ...customerSelect,
          service_locations: { select: locationSelect, orderBy: { is_primary: 'desc' } },
          // #2041 decision 4 — follows the requester's own Lead/Job scope, matching list().
          _count: { select: { leads: { where: { AND: [tenantWhere(req), leadScope] } }, jobs: { where: visibleJobs } } },
          // The newest 20, for the comms rail's job picker (useCustomerJobs). Scoped like the
          // _count beside it (slice 06); the customer page's Jobs tab pages GET /:id/jobs instead.
          jobs: {
            where: visibleJobs,
            select: {
              id: true,
              job_number: true,
              status: true,
              scope_notes: true,
              completed_at: true,
              created_at: true,
              // S8 (D6): crew through the trips. projectJobCrewUnion rebuilds the `assignees`
              // wire key from these rows before the response goes out - see below.
              // S8 (A5, RATIFIED): also the source of `scheduled_start` - the stored mirror is
              // dropped, and projectJobScheduleFields rebuilds it the same way, same place.
              visits: {
                select: {
                  status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
                  assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
                },
              },
              service_location: { select: { address_line1: true, city: true, state: true } },
              estimate: { select: { estimate_number: true, total_amount: true } },
              invoices: {
                select: {
                  id: true,
                  invoice_number: true,
                  status: true,
                  total_amount: true,
                  amount_due: true,
                  due_date: true,
                  created_at: true,
                  payments: {
                    select: {
                      id: true,
                      amount: true,
                      method: true,
                      paid_at: true,
                      notes: true,
                      collector: { select: { id: true, first_name: true, last_name: true } },
                    },
                    orderBy: { paid_at: 'desc' as const },
                  },
                },
                orderBy: { created_at: 'asc' as const },
              },
            },
            orderBy: { created_at: 'desc' },
            take: 20,
          },
        },
      }),
      prisma.note.findMany({
        where: { entity_type: 'CUSTOMER', entity_id: id, ...tenantWhere(req) },
        select: {
          id: true,
          content: true,
          created_at: true,
          creator: { select: { id: true, first_name: true, last_name: true } },
        },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      // §6/§8 — reach invoices anchored directly to the customer (orphan + estimate-anchored,
      // not only the job-nested ones above). Job-less invoices have a non-null customer_id.
      prisma.invoice.findMany({
        where: { customer_id: id, job_id: null, organization_id: orgId },
        select: {
          id: true,
          invoice_number: true,
          status: true,
          kind: true,
          total_amount: true,
          amount_due: true,
          due_date: true,
          created_at: true,
          payments: {
            select: {
              id: true,
              amount: true,
              method: true,
              paid_at: true,
              notes: true,
              collector: { select: { id: true, first_name: true, last_name: true } },
            },
            orderBy: { paid_at: 'desc' as const },
          },
        },
        orderBy: { created_at: 'desc' as const },
        take: 20,
      }),
      loadCustomerFinancials(id, orgId, timeZone),
      prisma.$queryRaw<Array<{
        total: string;
        pending: string;
        approved: string;
        total_value: string | null;
      }>>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(CASE WHEN e.status IN ('DRAFT','SENT') THEN 1 END)::text AS pending,
          COUNT(CASE WHEN e.status = ${ESTIMATE_STATUS.WON}::"EstimateStatus" THEN 1 END)::text AS approved,
          COALESCE(SUM(e.total_amount), 0) AS total_value
        FROM estimates e
        WHERE e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.$queryRaw<Array<{
        deposits_collected: string | null;
        deposits_pending: string | null;
      }>>`
        SELECT
          COALESCE(SUM(CASE WHEN i.status = 'PAID' THEN i.total_amount ELSE 0 END), 0) AS deposits_collected,
          COALESCE(SUM(CASE WHEN i.status IN ('DRAFT', 'SENT') THEN i.amount_due ELSE 0 END), 0) AS deposits_pending
        FROM invoices i
        JOIN estimates e ON i.estimate_id = e.id
        WHERE i.kind = 'DEPOSIT'
          AND e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.invoice.findMany({
        where: { customer_id: id, organization_id: orgId, kind: { not: 'DEPOSIT' } },
        select: {
          id: true, invoice_number: true, status: true, kind: true,
          total_amount: true, amount_due: true, due_date: true, created_at: true,
          job: { select: { id: true, job_number: true } },
          payments: {
            select: { id: true, amount: true, method: true, paid_at: true, notes: true,
                      collector: { select: { id: true, first_name: true, last_name: true } } },
            orderBy: { paid_at: 'desc' as const },
          },
        },
        orderBy: { created_at: 'desc' as const },
      }),
      // Slice 06: every count the page shows counts only the rows its reader can open.
      prisma.lead.count({ where: { AND: [tenantWhere(req), leadScope, { customer_id: id, status: { in: OPEN_LEAD_STATUSES } }] } }),
      prisma.lead.count({ where: { AND: [tenantWhere(req), leadScope, { customer_id: id, status: { in: ACTIVE_LEAD_STATUSES } }] } }),
      prisma.task.count({ where: { linked_entity_type: 'CUSTOMER', linked_entity_id: id, ...tenantWhere(req), status: openTaskStatusFilter() } }),
      // Active Jobs across every page, not only the embedded newest 20.
      prisma.job.count({ where: { AND: [visibleJobs, { status: { in: ACTIVE_JOB_STATUSES } }] } }),
    ]);

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // SRVW-103 - after the 404 guard, so no tag query fires for a row the caller cannot read.
    const tags = await loadTagsForEntity(req, 'CUSTOMER', customer.id);

    const est = estimateResult[0];
    const dep = depositResult[0];

    // Flatten the nested `job` relation into scalar `job_number`/`job_id` on each invoice row.
    const mappedInvoices = (allInvoices ?? []).map((inv) => ({
      ...inv,
      job_number: inv.job?.job_number ?? null,
      job_id: inv.job?.id ?? null,
      job: undefined,
    }));

    // S8 (D6): `job_assignees` is gone, so the Jobs tab's technician column is served from the
    // derived union over each job's trips - the SAME projector the jobs list and the job detail
    // use, so the three cannot disagree about who is on a job. Without it the wire key simply
    // vanishes and both customer-detail pages render every row "Unassigned": no error, no
    // typecheck failure, because the frontend declares `assignees` optional.
    const jobsWithCrew = (customer.jobs ?? []).map((j) => projectJobScheduleFields(projectJobCrewUnion(j as unknown as Record<string, unknown>)));

    res.json({
      // `notes` is the scalar free-text column (the edit form binds it); the polymorphic
      // Note rows go under `activity_notes` so the two never collide (was: spreading the
      // array onto `notes`, which made the edit form render/save "[object Object]").
      customer: { ...customer, jobs: jobsWithCrew, activity_notes: notes, orphan_invoices: orphanInvoices, invoices: mappedInvoices, tags },
      summary: {
        financials,
        estimates: {
          total: parseInt(String(est?.total ?? '0'), 10),
          pending: parseInt(String(est?.pending ?? '0'), 10),
          approved: parseInt(String(est?.approved ?? '0'), 10),
          total_value: parseFloat(String(est?.total_value ?? '0')),
        },
        deposits: {
          collected: parseFloat(String(dep?.deposits_collected ?? '0')),
          pending: parseFloat(String(dep?.deposits_pending ?? '0')),
        },
        leads: { open: openLeadsCount ?? 0, active: activeLeadsCount ?? 0 },
        tasks: { open: openTasksCount ?? 0 },
        jobs: { active: activeJobsCount ?? 0 },
      },
    });
  } catch (err) {
    logger.error('Get customer error:', err);
    res.status(500).json({ error: 'Failed to get customer' });
  }
}

/**
 * The customer-scoped job endpoints' shared read gate: the customer itself through the same gate
 * getById uses, then a tenant-scoped existence check. A miss answers 404 with the body a missing
 * customer gets (never 403, which would confirm the record exists) and returns false.
 */
async function ensureReadableCustomer(req: Request, res: Response, id: string): Promise<boolean> {
  if (await canReadCustomerById(req, id)) {
    const exists = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) }, select: { id: true } });
    if (exists) return true;
  }
  res.status(404).json({ error: 'Customer not found' });
  return false;
}

/**
 * The customer's jobs the requester may open: tenant, the requester's own Job row scope (the scope
 * the jobs list applies) and this customer. Each fragment is its own AND arm, so a scope carrying
 * `customer_id` can neither overwrite nor be overwritten. The Schedule tab's feed and the paged
 * Jobs tab both read this one where, so the two tabs always list the same jobs.
 */
function customerJobsWhere(req: Request, customerId: string, jobScope: Record<string, unknown>): Prisma.JobWhereInput {
  return { AND: [tenantWhere(req), jobScope, { customer_id: customerId }] };
}

/** Newest first; the id breaks created_at ties so a page boundary never repeats or skips a row. */
const CUSTOMER_JOBS_ORDER: Prisma.JobOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'asc' }];

/**
 * GET /api/customers/:id/schedule - every visit of the customer's jobs and every walkthrough
 * visit of the customer's leads (slice 04's per-visit Schedule tab; see lib/customer-schedule.ts).
 *
 * UNPAGED on purpose: the tab promises every visit, however many jobs the customer has, so it
 * must not inherit the page size the Jobs/Leads tabs use (slice 06). That is why it sits behind
 * expensiveLimiter and why the page requests it only while the Schedule tab is open: the Jobs and
 * Leads tabs get their one date per row from their own paged endpoints.
 *
 * Scoping, all three layers:
 *   - the customer itself through the same read gate getById uses (404, never 403);
 *   - tenant on each parent AND on the nested visits;
 *   - the requester's own Job / Lead row scope - the scope the jobs and leads lists apply - so a
 *     scoped role sees only the visits of records it can open.
 * Lead visits are served only to an org entitled to leads (the leads API is plan-gated).
 */
export async function getSchedule(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    if (!(await ensureReadableCustomer(req, res, id))) return;

    const withLeads = hasFeature(req, 'leads');
    const [jobScope, leadScope] = await Promise.all([
      scopeWhereForReq(req, 'Job'),
      withLeads ? scopeWhereForReq(req, 'Lead') : Promise.resolve(null),
    ]);
    const visits = customerScheduleVisitsArg(orgId);

    const [jobs, leads] = await Promise.all([
      prisma.job.findMany({
        where: customerJobsWhere(req, id, jobScope),
        select: { id: true, job_number: true, status: true, scope_notes: true, visits },
        orderBy: CUSTOMER_JOBS_ORDER,
      }),
      leadScope
        ? prisma.lead.findMany({
            where: { AND: [tenantWhere(req), leadScope, { customer_id: id }] },
            select: { id: true, lead_number: true, status: true, service_request: true, visits },
            orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    res.json({
      jobs: jobs.map((j) => ({ ...j, visits: j.visits.map(presentScheduleVisit) })),
      leads: leads.map((l) => ({ ...l, visits: l.visits.map(presentScheduleVisit) })),
    });
  } catch (err) {
    logger.error('Get customer schedule error:', err);
    res.status(500).json({ error: 'Failed to load the schedule' });
  }
}

/**
 * GET /api/customers/:id/jobs?page=&limit= - the customer page's Jobs tab, one numbered page at a
 * time (slice 06). The detail payload used to embed only the 20 newest jobs, so older work was
 * unreachable from the customer's page.
 *
 * Same job set as the Schedule tab's feed (customerJobsWhere), so the total counts exactly the
 * rows this requester can open and every listed job has its visits on the feed. Each job carries
 * its Scheduled date (`scheduled_start` / `scheduled_end` / `is_all_day`) from the job-window rule
 * every job payload uses, which is always the start of one of its own rows on the feed. One page is ONE
 * job query (Prisma batches each nested relation into a single IN query, never one per row) plus
 * one count.
 */
export async function listJobs(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { page, limit, skip } = parsePagination(req.query as { page?: string; limit?: string });

    if (!(await ensureReadableCustomer(req, res, id))) return;

    const where = customerJobsWhere(req, id, await scopeWhereForReq(req, 'Job'));
    const [rows, total] = await Promise.all([
      prisma.job.findMany({
        where,
        select: {
          id: true,
          job_number: true,
          status: true,
          scope_notes: true,
          completed_at: true,
          created_at: true,
          // The crew union and the Scheduled date below (S8 D6: crew and schedule live on the visits).
          visits: {
            where: tenantWhere(req),
            select: {
              status: true,
              scheduled_at: true,
              scheduled_end: true,
              is_all_day: true,
              created_at: true,
              assignees: { select: { user: { select: { id: true, first_name: true, last_name: true } } } },
            },
          },
          service_location: { select: { address_line1: true, city: true, state: true } },
          // The Invoice column: the latest non-voided invoice's status, plus how many more there are.
          // Tenant-filtered like `visits` above: defense in depth, not trusting every invoice that
          // points at an in-org job to be in the org as well.
          invoices: { where: tenantWhere(req), select: { id: true, status: true }, orderBy: { created_at: 'asc' } },
        },
        orderBy: CUSTOMER_JOBS_ORDER,
        skip,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    // The Technician column and the Scheduled date, from the same projectors the jobs list and
    // job detail use: `scheduled_start` is the job-window rule (next upcoming live visit, else the
    // earliest non-cancelled one), so the tab needs no per-visit feed to print one date per row.
    const jobs = rows.map((row) => {
      const { visits: _visits, ...job } = projectJobScheduleFields(projectJobCrewUnion(row as unknown as Record<string, unknown>));
      return job;
    });

    res.json({ jobs, pagination: buildPaginationMeta(total, { page, limit, skip }) });
  } catch (err) {
    logger.error('List customer jobs error:', err);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    // #2041 — `update Customer` carries the SAME OWN_CUSTOMER condition as `read`, so this reuses
    // the read-scoped probe. Same 404 body as the tenancy miss above — never 403.
    if (!(await canReadCustomerById(req, param(req, 'id')))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // SRVW-114 slice 3 - custom_fields is pulled out of the generic spread on purpose. `rest`
    // flows straight into prisma.customer.update, so leaving it in would write an arbitrary
    // caller-supplied bag over the stored one: no validation, and every untouched key lost.
    const { extra_emails, phones, billing_same_as_service_location, created_at, custom_fields, ...rest } = req.body;
    const selfId = param(req, 'id');

    let nextCustomFields: Record<string, unknown> | undefined;
    if (custom_fields !== undefined) {
      try {
        await validateCustomFieldValues(req.user!.organization_id, 'CUSTOMER', custom_fields);
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      nextCustomFields = mergeCustomFields(existing.custom_fields as Record<string, unknown> | null, custom_fields);
    }

    // §10 — clearing parent_id (member removal / promote-to-standalone) resets bill_to to self (null).
    if ('parent_id' in rest && (rest.parent_id === null || rest.parent_id === undefined)) {
      rest.bill_to_customer_id = null;
    }

    // The effective parent is the EDITED value when parent_id is part of this PATCH, otherwise
    // the persisted parent_id. The bill_to ∈ {self, parent} invariant is evaluated against it,
    // so a member that PATCHes only { bill_to_customer_id: P } is accepted (defect 1).
    const effectiveParentId =
      'parent_id' in rest ? (rest.parent_id ?? null) : ((existing.parent_id as string | null) ?? null);

    // Franchise flag follows the same effective-value pattern: the edited value when is_parent
    // is part of this PATCH, otherwise the persisted flag. Used for the franchise-conflict rule.
    const effectiveIsParent =
      'is_parent' in rest ? rest.is_parent === true : (existing.is_parent as boolean | undefined) === true;

    // §10 — re-parenting to a DIFFERENT non-null parent without restating bill_to: a stale
    // persisted bill_to that no longer satisfies {self, new parent} would otherwise survive
    // and silently break the invariant (defect 2). Re-validate the persisted bill_to against
    // the new parent and reset it to self (null = bills self) when it no longer qualifies.
    if ('parent_id' in rest && rest.parent_id && !('bill_to_customer_id' in rest)) {
      const persistedBillTo = (existing.bill_to_customer_id as string | null) ?? null;
      if (persistedBillTo !== null && persistedBillTo !== selfId && persistedBillTo !== rest.parent_id) {
        rest.bill_to_customer_id = null;
      }
    }

    // §10 guards — run when parent/bill_to OR the franchise flag are part of this edit. The
    // franchise-conflict rule needs to fire even when only is_parent is toggled on a member.
    if ('parent_id' in rest || 'bill_to_customer_id' in rest || 'is_parent' in rest) {
      try {
        await validateParentAndBillTo(req, rest, selfId, effectiveParentId, effectiveIsParent);
      } catch (err) {
        if (err instanceof GuardError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    // SERV10X-35 — a customer must keep at least one contact method after this edit.
    if ('phone' in rest || 'email' in rest) {
      const effPhone = 'phone' in rest ? rest.phone : (existing.phone as string | null);
      const effEmail = 'email' in rest ? rest.email : (existing.email as string | null);
      if (!hasPhoneOrEmail({ phone: effPhone, email: effEmail })) {
        res.status(400).json({ error: CONTACT_REQUIRED_MSG });
        return;
      }
    }

    // billing-copy convenience needs the customer's locations.
    if (billing_same_as_service_location) {
      const locs = await prisma.serviceLocation.findMany({
        where: { customer_id: selfId },
        select: { address_line1: true, city: true, state: true, zip: true, is_primary: true },
      });
      applyBillingCopy(Object.assign(rest, { billing_same_as_service_location: true }), locs);
      delete rest.billing_same_as_service_location;
    }

    const isAdmin = req.user?.role === 'ADMIN';
    const createdAtChanged =
      isAdmin && created_at !== undefined &&
      (!existing.created_at ||
       (created_at as Date).toISOString().slice(0, 10) !== (existing.created_at as Date).toISOString().slice(0, 10));
    // §5.1 — kind is derived, never client-supplied. Re-derive it whenever this PATCH
    // touches the customer's identity (name/company), using the EFFECTIVE
    // (edited-if-present, else persisted) values. Untouched PATCHes never write kind.
    const kindUpdate = ('first_name' in rest || 'company_name' in rest)
      ? {
          kind: deriveCustomerKind({
            first_name: 'first_name' in rest ? (rest.first_name as string | null | undefined) : existing.first_name,
            company_name: 'company_name' in rest ? (rest.company_name as string | null | undefined) : existing.company_name,
          }),
        }
      : {};

    const customer = await prisma.customer.update({
      where: { id: param(req, 'id') },
      data: {
        ...rest,
        ...kindUpdate,
        ...(nextCustomFields !== undefined && { custom_fields: nextCustomFields as Prisma.InputJsonValue }),
        ...(createdAtChanged && { created_at }),
        ...(extra_emails !== undefined && {
          extra_emails: {
            deleteMany: {},
            create: normalizeExtraEmails(extra_emails),
          },
        }),
        ...(phones !== undefined && {
          phones: {
            deleteMany: {},
            create: normalizePhones(phones),
          },
        }),
      },
      select: customerSelect,
    });

    const auditFields = [
      ...Object.keys(rest),
      ...(createdAtChanged ? ['created_at'] : []),
      // Destructured out of `rest` above, so it has to be re-declared here or the edit would
      // vanish from the audit trail. Only the field NAME is recorded - the values themselves
      // are org-defined and can hold anything, so they never enter timeline metadata.
      ...(nextCustomFields !== undefined ? ['custom_fields'] : []),
    ];

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'CUSTOMER_UPDATED',
        description: 'Customer details updated',
        metadata: { fields: auditFields },
        created_by: req.user!.id,
      },
    });

    void logAudit({
      req,
      action: 'customer.updated',
      resourceType: 'Customer',
      resourceId: param(req, 'id'),
      metadata: { fields: auditFields },
    });
    res.json({ customer });
  } catch (err) {
    logger.error('Update customer error:', err);
    res.status(500).json({ error: 'Failed to update customer' });
  }
}

export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // §10 — a parent billing group with members can never be casually deleted (members are
    // independent customers; detach them first). Archive instead, or force-purge.
    const memberCount = await prisma.customer.count({ where: { parent_id: id, ...tenantWhere(req) } });
    if (memberCount > 0) {
      res.status(400).json({ error: 'Cannot delete a billing group with members — detach members first' });
      return;
    }

    const [leadCount, jobCount] = await Promise.all([
      prisma.lead.count({ where: { customer_id: id, ...tenantWhere(req) } }),
      prisma.job.count({ where: { customer_id: id, ...tenantWhere(req) } }),
    ]);

    if (leadCount > 0 || jobCount > 0) {
      res.status(400).json({ error: 'Cannot delete customer with existing leads or jobs' });
      return;
    }

    // §10 money-gate — casual delete is allowed ONLY when there is zero financial history.
    // Even with no leads/jobs an orphan invoice + payment could still exist in the subtree.
    if (await hasPaymentInSubtree(id, orgId)) {
      res.status(400).json({
        error: 'Cannot delete a customer with recorded payments — archive the customer or force-purge instead',
      });
      return;
    }

    await prisma.customer.delete({ where: { id } });
    void logAudit({ req, action: 'customer.deleted', resourceType: 'Customer', resourceId: id });
    res.json({ message: 'Customer deleted' });
  } catch (err) {
    logger.error('Delete customer error:', err);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
}

// ─── Customer lifecycle (entity-redesign §10) ───────────

export async function archiveCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: { is_active: false, archived_at: new Date() },
      select: customerSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_ARCHIVED',
        description: 'Customer archived',
        created_by: req.user!.id,
      },
    });

    void logAudit({ req, action: 'customer.archived', resourceType: 'Customer', resourceId: id });
    res.json({ customer });
  } catch (err) {
    logger.error('Archive customer error:', err);
    res.status(500).json({ error: 'Failed to archive customer' });
  }
}

export async function unarchiveCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customer = await prisma.customer.update({
      where: { id },
      data: { is_active: true, archived_at: null },
      select: customerSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_UNARCHIVED',
        description: 'Customer unarchived',
        created_by: req.user!.id,
      },
    });

    res.json({ customer });
  } catch (err) {
    logger.error('Unarchive customer error:', err);
    res.status(500).json({ error: 'Failed to unarchive customer' });
  }
}

export const purgeCustomerSchema = z.object({
  confirm: z.string().min(1),
});

// Editable record IDs (Workiz dual-run) - charset/length/numeric-cap validation lives in
// validateNumberFormat inside lib/record-renumber.ts (called by computeRenumber). This
// schema only guards the wire shape: `number` must be present and a string.
export const renumberCustomerSchema = z.object({ number: z.string() }).strict();

export async function purgeCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Type-to-confirm — body.confirm must equal the customer_number.
    if (req.body?.confirm !== existing.customer_number) {
      res.status(400).json({ error: `Confirmation does not match (expected ${existing.customer_number})` });
      return;
    }

    // Members are independent customers — never cascade-delete them. Block purge while
    // any member still points here (chosen minimal-coherent interpretation of §10).
    const memberCount = await prisma.customer.count({ where: { parent_id: id, ...tenantWhere(req) } });
    if (memberCount > 0) {
      res.status(400).json({ error: 'Cannot purge a billing group with members — detach members first' });
      return;
    }

    // Money-gate audit — ADMIN may purge regardless, but we surface a destructive warning.
    const money = await paymentSummaryForSubtree(id, orgId);

    await prisma.$transaction(
      async (tx) => {
        await purgeCustomerSubtree(tx, id, orgId);
      },
      { maxWait: 20000, timeout: 120000 },
    );

    // Emit the audit AFTER the subtree wipe (the wipe deletes the customer's own timeline rows).
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_PURGED',
        description: `Customer ${existing.customer_number} force-purged`,
        metadata: {
          customer_number: existing.customer_number,
          payment_total: money.paymentTotal,
          has_stripe_charge: money.hasStripeCharge,
        },
        created_by: req.user!.id,
      },
    });

    const response: Record<string, unknown> = { message: 'Customer purged', purged: true };
    if (money.hasPayment) {
      response.warning = `$${money.paymentTotal.toFixed(2)} recorded — destroys financial records`;
      response.payment_total = money.paymentTotal;
      response.has_stripe_charge = money.hasStripeCharge;
      if (money.hasStripeCharge) {
        response.stripe_warning = 'One or more payments have a Stripe charge — purging does not refund the customer';
      }
    }
    res.json(response);
  } catch (err) {
    logger.error('Purge customer error:', err);
    res.status(500).json({ error: 'Failed to purge customer' });
  }
}

// §13 — anonymize is DESIGNED-NOW / BUILT-LATER. The route is gated admin-only and returns
// a documented 501 so the design contract is discoverable and the gate is testable.
export async function anonymizeCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.status(501).json({
      error: 'Not Implemented',
      deferred: true,
      design:
        'PII→tombstone (Redacted Customer #N), keep financial skeleton incl. scrubbing frozen ' +
        'invoice/estimate name+address snapshots; retention law beats erasure (GDPR 17(3)(b)/(e), ' +
        'CCPA exempt). Build deferred per §13.',
    });
  } catch (err) {
    logger.error('Anonymize customer error:', err);
    res.status(500).json({ error: 'Failed to anonymize customer' });
  }
}

// ─── Customer Number Rename (Editable Record IDs) ───────
//
// Preview is read-only/advisory (no lock, no writes) - safe to call from a plain prisma
// client. Rename is the real write: it looks up + validates OUTSIDE a transaction first
// (permission → 404; customer has no extra per-instance ownership check or business
// precondition beyond that - see customer.controller's other handlers, none of them do
// one either), then opens a transaction that locks the parent row before calling
// computeRenumber/applyRenumber, exactly as record-renumber.ts's own contract requires.

export async function previewCustomerNumber(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    const existing = await prisma.customer.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const computation = await computeRenumber(prisma, 'customer', id, orgId, req.body.number);
    res.json(computation);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid record number')) {
      res.status(400).json({ error: err.message });
      return;
    }
    logger.error('Preview customer number error:', err);
    res.status(500).json({ error: 'Failed to preview customer number change' });
  }
}

export async function renameCustomer(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    // Cheap existence + tenant-ownership check BEFORE opening a transaction, so a request
    // that's going to 404 anyway never takes the row lock.
    const existing = await prisma.customer.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    let computation: RenumberComputation;
    try {
      computation = await prisma.$transaction(async (tx) => {
        // Same FOR NO KEY UPDATE strength allocateAnchoredNumber already takes on this
        // exact table (numbering.ts's ANCHORS.customer) - a mismatched lock strength on
        // the same row from two different code paths can deadlock or fail to serialize.
        await tx.$executeRaw`SELECT id FROM customers WHERE id = ${id}::uuid FOR NO KEY UPDATE`;

        // Re-derive fresh under the lock (never trust a client-supplied/pre-lock read) and
        // fail BEFORE calling applyRenumber when there's a conflict, so the 409 body can
        // carry this exact tx-fresh computation instead of a second, racy re-derivation.
        const preview = await computeRenumber(tx, 'customer', id, orgId, req.body.number);
        if (preview.hasConflicts) {
          throw new RenumberConflictError(preview);
        }
        return applyRenumber(tx, 'customer', id, orgId, req.body.number);
      });
    } catch (err) {
      if (err instanceof RenumberConflictError) {
        res.status(409).json({
          error: 'Cannot rename customer: conflicting number(s) already exist in this organization',
          ...err.computation,
        });
        return;
      }
      if (err instanceof Error && err.message.startsWith('Invalid record number')) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const derivedCount = computation.derived.length + computation.labelRefreshes.length;

    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'CUSTOMER',
        entity_id: id,
        event_type: 'CUSTOMER_RENUMBERED',
        description:
          `Customer number changed from ${computation.oldNumber} to ${computation.newNumber} ` +
          `(${derivedCount} derived record${derivedCount === 1 ? '' : 's'} updated)`,
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
      action: 'customer.renumbered',
      resourceType: 'Customer',
      resourceId: id,
      metadata: { old_number: computation.oldNumber, new_number: computation.newNumber },
    });

    // Built from the pre-transaction row + the computation rather than re-selected, so the
    // response doesn't cost a second round trip - the values written are exactly these
    // (applyRenumber's own COALESCE-on-original_number rule, mirrored here).
    res.json({
      customer: {
        ...existing,
        customer_number: computation.newNumber,
        number_is_custom: true,
        original_number: (existing as { original_number: string | null }).original_number ?? computation.oldNumber,
      },
      old_number: computation.oldNumber,
      new_number: computation.newNumber,
      derived: computation.derived,
      label_refreshes: computation.labelRefreshes,
    });
  } catch (err) {
    logger.error('Rename customer number error:', err);
    res.status(500).json({ error: 'Failed to rename customer number' });
  }
}

// ─── Stats & Export ─────────────────────────────────────

export async function getStats(req: Request, res: Response) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const orgWhere = tenantWhere(req);
    // #2041 — every count follows the SAME row scope the list uses, so `stats.total` always
    // equals `pagination.total` in the same session (AC3). Composed with AND, never a spread:
    // the third/fourth counts already set `where.leads`/`where.jobs`, which OWN_CUSTOMER's own
    // `leads`/`jobs` arms would silently clobber (decision 1) — a stats-only org-wide leak.
    const scope = await scopeWhereForReq(req, 'Customer');
    const withScope = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
      const w: Record<string, unknown> = { ...orgWhere, ...extra };
      if (Object.keys(scope).length) w.AND = [...asArray(w.AND), scope];
      return w;
    };

    const [total, newThisMonth, activeLeads, activeJobs] = await Promise.all([
      prisma.customer.count({ where: withScope() }),
      prisma.customer.count({ where: withScope({ created_at: { gte: startOfMonth } }) }),
      prisma.customer.count({ where: withScope({ leads: { some: { status: { in: OPEN_LEAD_STATUSES } } } }) }),
      prisma.customer.count({ where: withScope({ jobs: { some: { status: { in: ACTIVE_JOB_STATUSES } } } }) }),
    ]);

    res.json({ total, newThisMonth, activeLeads, activeJobs });
  } catch (err) {
    logger.error('Get customer stats error:', err);
    res.status(500).json({ error: 'Failed to get customer stats' });
  }
}

const EXPORT_ROW_CAP = 50_000;

export async function exportAll(req: Request, res: Response) {
  try {
    const where = await buildCustomerListWhere(req);
    const [leadScope, jobScope] = await Promise.all([
      scopeWhereForReq(req, 'Lead'),
      scopeWhereForReq(req, 'Job'),
    ]);
    const customers = await prisma.customer.findMany({
      where,
      select: {
        ...customerSelect,
        service_locations: {
          where: { is_primary: true },
          select: { address_line1: true, city: true, state: true, zip: true },
          take: 1,
        },
        _count: scopedRelationCounts(req, leadScope, jobScope),
      },
      orderBy: { created_at: 'desc' },
      take: EXPORT_ROW_CAP,
    });
    if (customers.length === EXPORT_ROW_CAP) {
      logger.warn(`Customer export hit row cap (${EXPORT_ROW_CAP}) for org ${req.user?.organization_id}`);
    }

    void logAudit({
      req,
      action: 'customer.exported',
      resourceType: 'Customer',
      resourceId: null,
      metadata: { count: customers.length },
    });
    res.json({ customers });
  } catch (err) {
    logger.error('Export customers error:', err);
    res.status(500).json({ error: 'Failed to export customers' });
  }
}

export async function addLocation(req: Request, res: Response) {
  try {
    // Tenancy + existence FIRST — `canReadCustomerById`'s empty-scope (ADMIN/unconditional) fast
    // path deliberately skips its own query (enforce.ts's `canAccessRow` caveat, same shape), so
    // it is not itself an existence check. The row-scope check below is what narrows a CONDITIONED
    // read; both 404 with the SAME body, never 403.
    const customer = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!customer || !(await canReadCustomerById(req, param(req, 'id')))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    if (req.body.is_primary) {
      await prisma.serviceLocation.updateMany({
        where: { customer_id: param(req, 'id') },
        data: { is_primary: false },
      });
    }

    const location = await prisma.serviceLocation.create({
      data: { ...req.body, customer_id: param(req, 'id') },
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'LOCATION_ADDED',
        description: `Service location added: ${location.address_line1}, ${location.city}`,
        metadata: { location_id: location.id },
        created_by: req.user!.id,
      },
    });

    res.status(201).json({ location });
  } catch (err) {
    logger.error('Add location error:', err);
    res.status(500).json({ error: 'Failed to add location' });
  }
}

export async function updateLocation(req: Request, res: Response) {
  try {
    // Tenancy + existence FIRST — see addLocation's comment above.
    const customer = await prisma.customer.findUnique({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!customer || !(await canReadCustomerById(req, param(req, 'id')))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: param(req, 'locId'), customer_id: param(req, 'id') },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    if (req.body.is_primary) {
      await prisma.serviceLocation.updateMany({
        where: { customer_id: param(req, 'id'), NOT: { id: param(req, 'locId') } },
        data: { is_primary: false },
      });
    }

    const updated = await prisma.serviceLocation.update({
      where: { id: param(req, 'locId') },
      data: req.body,
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: param(req, 'id'),
        event_type: 'LOCATION_UPDATED',
        description: `Service location updated: ${updated.address_line1}, ${updated.city}`,
        metadata: { location_id: updated.id },
        created_by: req.user!.id,
      },
    });

    res.json({ location: updated });
  } catch (err) {
    logger.error('Update location error:', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
}

// §10 — the "1+ active locations, exactly one primary" invariant. Guards removing or
// archiving a location: blocks the last active, and the primary unless another is promoted.
// Throws GuardError (→ 400). Promotes `promoteId` first when supplied.
async function enforceLocationInvariant(
  customerId: string,
  location: { id: string; is_primary: boolean },
  promoteId: string | undefined,
): Promise<void> {
  const activeCount = await prisma.serviceLocation.count({
    where: { customer_id: customerId, is_active: true },
  });
  if (activeCount <= 1) {
    throw new GuardError('Cannot remove the last active location');
  }
  if (location.is_primary) {
    if (!promoteId) {
      throw new GuardError('Cannot remove the primary location without promoting another');
    }
    // Promote the supplied location to primary, demote everyone else.
    await prisma.serviceLocation.updateMany({
      where: { customer_id: customerId, NOT: { id: promoteId } },
      data: { is_primary: false },
    });
    await prisma.serviceLocation.update({ where: { id: promoteId }, data: { is_primary: true } });
  }
}

export async function removeLocation(req: Request, res: Response) {
  try {
    const customerId = param(req, 'id');
    const locId = param(req, 'locId');
    const customer = await prisma.customer.findUnique({ where: { id: customerId, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: locId, customer_id: customerId },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    // last-active / primary invariant (promotes if promote_location_id supplied).
    try {
      await enforceLocationInvariant(customerId, location, req.body?.promote_location_id);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // §10 — hard-delete only if NEVER referenced by a lead OR a job; else archive.
    const [jobCount, leadCount] = await Promise.all([
      prisma.job.count({ where: { service_location_id: locId, ...tenantWhere(req) } }),
      prisma.lead.count({ where: { service_location_id: locId, ...tenantWhere(req) } }),
    ]);

    if (jobCount > 0 || leadCount > 0) {
      await prisma.serviceLocation.update({
        where: { id: locId },
        data: { is_active: false, archived_at: new Date() },
      });
      await prisma.timelineEvent.create({
        data: {
          organization_id: req.user!.organization_id,
          entity_type: 'CUSTOMER',
          entity_id: customerId,
          event_type: 'LOCATION_ARCHIVED',
          description: 'Service location archived (referenced by leads or jobs)',
          metadata: { location_id: locId },
          created_by: req.user!.id,
        },
      });
      res.json({ message: 'Location archived (referenced by leads or jobs)', archived: true });
      return;
    }

    await prisma.serviceLocation.delete({ where: { id: locId } });
    res.json({ message: 'Location deleted' });
  } catch (err) {
    logger.error('Delete location error:', err);
    res.status(500).json({ error: 'Failed to delete location' });
  }
}

export async function archiveLocation(req: Request, res: Response) {
  try {
    const customerId = param(req, 'id');
    const locId = param(req, 'locId');
    const customer = await prisma.customer.findUnique({ where: { id: customerId, ...tenantWhere(req) } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    const location = await prisma.serviceLocation.findFirst({
      where: { id: locId, customer_id: customerId },
    });
    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    try {
      await enforceLocationInvariant(customerId, location, req.body?.promote_location_id);
    } catch (err) {
      if (err instanceof GuardError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const updated = await prisma.serviceLocation.update({
      where: { id: locId },
      data: { is_active: false, archived_at: new Date() },
      select: locationSelect,
    });

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: 'CUSTOMER',
        entity_id: customerId,
        event_type: 'LOCATION_ARCHIVED',
        description: `Service location archived: ${updated.address_line1}, ${updated.city}`,
        metadata: { location_id: locId },
        created_by: req.user!.id,
      },
    });

    res.json({ location: updated });
  } catch (err) {
    logger.error('Archive location error:', err);
    res.status(500).json({ error: 'Failed to archive location' });
  }
}

// ─── Customer Summary (Financial Aggregation) ──────────

export async function getSummary(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;

    // Tenancy + existence FIRST — see addLocation's comment above.
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing || !(await canReadCustomerById(req, id))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // The org clock for the Past Due / Due split — see loadCustomerFinancials. Resolved after
    // the 404 guard so a miss still costs nothing, and memoized on the request by
    // getRequestOrgTimezone.
    const timeZone = await getRequestOrgTimezone(req);

    // Run all 3 aggregation queries in parallel
    const [financials, estimateResult, depositResult] = await Promise.all([
      loadCustomerFinancials(id, orgId, timeZone),
      prisma.$queryRaw<Array<{
        total: string;
        pending: string;
        approved: string;
        total_value: string | null;
      }>>`
        SELECT
          COUNT(*)::text AS total,
          COUNT(CASE WHEN e.status IN ('DRAFT','SENT') THEN 1 END)::text AS pending,
          COUNT(CASE WHEN e.status = ${ESTIMATE_STATUS.WON}::"EstimateStatus" THEN 1 END)::text AS approved,
          COALESCE(SUM(e.total_amount), 0) AS total_value
        FROM estimates e
        WHERE e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
      prisma.$queryRaw<Array<{
        deposits_collected: string | null;
        deposits_pending: string | null;
      }>>`
        SELECT
          COALESCE(SUM(CASE WHEN i.status = 'PAID' THEN i.total_amount ELSE 0 END), 0) AS deposits_collected,
          COALESCE(SUM(CASE WHEN i.status IN ('DRAFT', 'SENT') THEN i.amount_due ELSE 0 END), 0) AS deposits_pending
        FROM invoices i
        JOIN estimates e ON i.estimate_id = e.id
        WHERE i.kind = 'DEPOSIT'
          AND e.customer_id = ${id}::uuid
          AND e.organization_id = ${orgId}::uuid
      `,
    ]);

    const est = estimateResult[0];
    const dep = depositResult[0];

    res.json({
      financials,
      estimates: {
        total: parseInt(String(est?.total ?? '0'), 10),
        pending: parseInt(String(est?.pending ?? '0'), 10),
        approved: parseInt(String(est?.approved ?? '0'), 10),
        total_value: parseFloat(String(est?.total_value ?? '0')),
      },
      deposits: {
        collected: parseFloat(String(dep?.deposits_collected ?? '0')),
        pending: parseFloat(String(dep?.deposits_pending ?? '0')),
      },
    });
  } catch (err) {
    logger.error('Get customer summary error:', err);
    res.status(500).json({ error: 'Failed to get customer summary' });
  }
}

// ─── Customer Notes ─────────────────────────────────────

export const createNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

export async function addNote(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Tenancy + existence FIRST — see addLocation's comment above.
    const existing = await prisma.customer.findUnique({ where: { id, ...tenantWhere(req) } });
    if (!existing || !(await canReadCustomerById(req, id))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'CUSTOMER',
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
    logger.error('Add customer note error:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
}
