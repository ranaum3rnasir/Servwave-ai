import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import multer from 'multer';
import { Prisma, PaymentMethod } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { generateEstimatePdf, generateInvoicePdf } from '../lib/pdf';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import { PREVIEW_ESTIMATE_FIXTURE, PREVIEW_INVOICE_FIXTURE } from '../lib/pdf/preview-fixture';
import { writeSettingsAudit, logAudit } from '../lib/audit';
import {
  acceptedPaymentMethodsSchema,
  resolveAcceptedPaymentMethods,
} from '../lib/payment-methods';
import { canSeePricing } from '../lib/permissions/enforce';
import { effectiveSenderLocalPart, senderDomainOf } from '../lib/email';
import { loadSharp } from '../lib/load-sharp';

/** Matches lib/email.ts's own cap, so a value that validates here can never be
 *  silently truncated when the address is built. */
const MAX_SENDER_LOCAL_PART = 40;

/** Local parts an org may not claim on the shared sending domain.
 *
 *  `postmaster` and `abuse` are owed to the internet rather than to any one
 *  tenant (RFC 2142), `bounce`/`bounces` is where return-path traffic belongs,
 *  and `no-reply`/`noreply` is the fallback lib/email.ts uses when a name slugs
 *  to nothing - one org claiming it would collide with every unnamed org. */
const RESERVED_SENDER_LOCAL_PARTS = new Set([
  'postmaster',
  'abuse',
  'bounce',
  'bounces',
  'no-reply',
  'noreply',
]);

const LOGO_MAX_W = 267; // 200pt * 1.33
const LOGO_MAX_H = 107; // 80pt * 1.33
// SVG dropped (F-36): raster-only so every logo is re-encoded through sharp.
const ALLOWED_MIME = ['image/png', 'image/jpeg'];
const BUCKET = 'org-assets';
const PREFIX_REGEX = /^[A-Za-z0-9-]{1,10}$/;

/**
 * Is this a time zone the runtime's own tz database recognises?
 *
 * The org timezone is not decoration - the frontend resolves and renders every scheduled
 * time against it. A name `Intl` cannot parse throws RangeError deep inside a render, so a
 * bad value has to be refused here rather than stored and detonated later. Asking Intl
 * directly (rather than matching a hand-kept list) means the check tracks whatever zones the
 * platform actually supports, and keeps accepting legacy aliases orgs may already hold.
 * '' is allowed and means "unset" - callers fall back to the default scheduling zone.
 */
function isIanaTimezone(value: string): boolean {
  if (value === '') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The logo cap. UNLIKE every other upload surface there is no second, tighter check in
// uploadLogo — this multer limit IS the limit the user is subject to, so it is also exactly
// what organization.routes.ts's too-large message quotes.
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES } });

/**
 * The design-system tokens an org may paint a scheduler event type with. Token NAMES (the
 * `--` prefix dropped), never hexes: the org picks from the palette the app already ships and the
 * board resolves the name at paint time, so a retuned token repaints every org's board.
 *
 * This list is the contract with frontend/src/design-system/scheduleEventPalette.ts - the two
 * must match entry for entry. Deliberately absent: terracotta (it is --danger and the
 * needs-crew notch; a Job painted in it would make the board's one red mean two things),
 * notify-rose (reserved for notification badges) and every surface/text neutral.
 */
export const SCHEDULE_EVENT_COLOR_TOKENS = [
  'info', 'status-blue', 'ocean-700',
  'sage-700', 'status-green', 'sage-500',
  'amber-700', 'status-amber',
  'indigo-600', 'status-purple',
  'olive-700', 'status-slate',
] as const;

// R1 (2026-07-21) — explicit allowlist of every CURRENT Organization scalar column, mirroring
// today's behavior field-for-field (no relations — Prisma never returns those from a bare
// findUnique/update anyway). `read Organization` is granted to EVERY role (Sales/Dispatcher/
// Technician included, not just Admin — see defaultGrants.ts), so the prior bare
// `findUnique`/`update` with no `select` shipped the WHOLE row, including anything ever added to
// this model, to every authenticated user. The real danger is forward-looking: Phase 2 (M2) adds
// `labor_rate`/`overhead_mode`/`overhead_value` — internal cost/margin config that must stay behind
// `read Invoice` (§2.1) — as plain columns on this same model. An explicit select means a NEW
// column never appears in a response until a developer deliberately adds it here and consciously
// decides who should see it, instead of it leaking by omission the moment the migration lands.

export const organizationScalarSelect = {
  id: true,
  name: true,
  legal_name: true,
  address_line1: true,
  address_line2: true,
  city: true,
  state: true,
  postal_code: true,
  country: true,
  timezone: true,
  email: true,
  phone: true,
  website: true,
  logo_url: true,
  brand_color: true,
  estimate_template: true,
  estimate_terms: true,
  estimate_notes: true,
  estimate_payment_terms: true,
  invoice_terms: true,
  invoice_notes: true,
  invoice_payment_terms: true,
  stripe_account_id: true,
  stripe_charges_enabled: true,
  stripe_payouts_enabled: true,
  stripe_details_submitted: true,
  stripe_requirements_due: true,
  stripe_disabled_reason: true,
  ctm_account_id: true,
  ctm_sms_ready: true,
  accepted_payment_methods: true,
  source_options: true,
  job_type_options: true,
  billing_terms_options: true,
  is_demo: true,
  created_at: true,
  updated_at: true,
  lead_prefix: true,
  estimate_prefix: true,
  job_prefix: true,
  invoice_prefix: true,
  number_padding: true,
  lead_next_number: true,
  estimate_next_number: true,
  job_next_number: true,
  invoice_next_number: true,
  lead_first_issued_at: true,
  estimate_first_issued_at: true,
  job_first_issued_at: true,
  invoice_first_issued_at: true,
  customer_prefix: true,
  customer_next_number: true,
  customer_first_issued_at: true,
  service_plan_prefix: true,
  service_plan_next_number: true,
  service_plan_first_issued_at: true,
  task_prefix: true,
  task_next_number: true,
  task_first_issued_at: true,
  purchase_order_prefix: true,
  purchase_order_next_number: true,
  purchase_order_first_issued_at: true,
  logistic_order_prefix: true,
  logistic_order_next_number: true,
  logistic_order_first_issued_at: true,
  default_inventory_location_id: true,
  display_name: true,
  tax_id: true,
  business_type: true,
  industry: true,
  support_email: true,
  billing_email: true,
  currency: true,
  date_format: true,
  mailing_same_as_hq: true,
  mailing_address_line1: true,
  mailing_address_line2: true,
  mailing_city: true,
  mailing_state: true,
  mailing_postal_code: true,
  mailing_country: true,
  mfa_sms_enabled: true,
  mfa_email_enabled: true,
  email_sending_enabled: true,
  sms_sending_enabled: true,
  block_negative_stock: true,
  default_job_duration_min: true,
  default_walkthrough_duration_min: true,
  default_schedule_start_time: true,
  schedule_event_colors: true,
  deposit_default_type: true,
  deposit_default_percentage: true,
  deposit_default_fixed_amount: true,
  lock_on_send: true,
} as const;

export const organizationCostSelect = {
  labor_rate: true,
  overhead_mode: true,
  overhead_value: true,
} as const;

export const patchOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  legal_name: z.string().max(200).optional(),
  address_line1: z.string().min(1).max(200).optional(),
  address_line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(50).optional(),
  postal_code: z.string().min(1).max(20).optional(),
  country: z.string().length(2).optional().or(z.literal('')),
  email: z.string().email().max(200).optional(),
  phone: z.string().max(50).optional(),
  // SECURITY (review #1): z.string().url() ACCEPTS `javascript:`/`data:`/`vbscript:` URLs
  // (they parse as valid URLs). org.website renders into an <a href> on the PUBLIC,
  // unauthenticated estimate page — so an unsanitized scheme is a stored-XSS sink. Require
  // an http(s) scheme here; the frontend additionally wraps it with safeHref() defense-in-depth.
  website: z
    .string()
    .url()
    .max(200)
    .refine((v) => /^https?:\/\//i.test(v), { message: 'Website must be an http:// or https:// URL' })
    .or(z.literal(''))
    .optional(),
  brand_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  estimate_template: z.enum(['alpha-classic', 'crm-default']).optional(),
  estimate_terms: z.string().max(10000).optional(),
  estimate_notes: z.string().max(10000).optional(),
  estimate_payment_terms: z.string().max(10000).optional(),
  invoice_terms: z.string().max(10000).optional(),
  invoice_notes: z.string().max(10000).optional(),
  invoice_payment_terms: z.string().max(10000).optional(),
  lead_prefix:          z.string().regex(PREFIX_REGEX).optional(),
  estimate_prefix:      z.string().regex(PREFIX_REGEX).optional(),
  job_prefix:           z.string().regex(PREFIX_REGEX).optional(),
  invoice_prefix:       z.string().regex(PREFIX_REGEX).optional(),
  customer_prefix:      z.string().regex(PREFIX_REGEX).optional(),
  service_plan_prefix:  z.string().regex(PREFIX_REGEX).optional(),
  number_padding:       z.number().int().min(1).max(10).optional(),
  lead_next_number:     z.number().int().positive().optional(),
  estimate_next_number: z.number().int().positive().optional(),
  job_next_number:      z.number().int().positive().optional(),
  invoice_next_number:  z.number().int().positive().optional(),
  customer_next_number: z.number().int().positive().optional(),
  service_plan_next_number: z.number().int().positive().optional(),
  accepted_payment_methods: acceptedPaymentMethodsSchema.optional(),
  source_options: z
    .array(z.string().trim().min(1, 'Option cannot be empty').max(50))
    .max(100, 'Cannot exceed 100 options')
    .optional(),
  job_type_options: z
    .array(z.string().trim().min(1, 'Option cannot be empty').max(50))
    .max(100, 'Cannot exceed 100 options')
    .optional(),
  billing_terms_options: z
    .array(z.string().trim().min(1, 'Option cannot be empty').max(50))
    .max(100, 'Cannot exceed 100 options')
    .optional(),
  default_inventory_location_id: z.string().uuid().nullable().optional(),
  // Inventory P1 (D7): refuse deductions that would take on_hand below zero (409 SHORTAGE)
  // instead of the default warn-and-proceed.
  block_negative_stock: z.boolean().optional(),
  // ─── Org Settings — extended company profile ───
  display_name: z.string().max(200).optional(),
  tax_id: z.string().max(50).optional(),
  business_type: z.string().max(50).optional(),
  industry: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  support_email: z.string().email().max(200).optional().or(z.literal('')),
  billing_email: z.string().email().max(200).optional().or(z.literal('')),
  timezone: z
    .string()
    .max(64)
    .refine(isIanaTimezone, { message: 'Must be a valid IANA time zone, e.g. America/New_York' })
    .optional(),
  currency: z.string().length(3).optional().or(z.literal('')),
  date_format: z.string().max(20).optional(),
  mailing_same_as_hq: z.boolean().optional(),
  mailing_address_line1: z.string().max(200).optional(),
  mailing_address_line2: z.string().max(200).optional(),
  mailing_city: z.string().max(100).optional(),
  mailing_state: z.string().max(50).optional(),
  mailing_postal_code: z.string().max(20).optional(),
  mailing_country: z.string().length(2).optional().or(z.literal('')),
  mfa_sms_enabled: z.boolean().optional(),
  mfa_email_enabled: z.boolean().optional(),
  email_sending_enabled: z.boolean().optional(),
  sms_sending_enabled: z.boolean().optional(),
  default_job_duration_min: z.number().int().min(15).max(1440).optional(),
  default_walkthrough_duration_min: z.number().int().min(15).max(1440).optional(),
  default_schedule_start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM').optional(),
  // Per-org board colours. Partial by design: an absent key means "follow the design system",
  // so {} is a legitimate value (every type reverted), not an empty-object mistake. `.strict()`
  // on the inner object is what rejects an event type the board does not render - the four keys
  // here must stay in lockstep with EventType in frontend/src/components/schedule/scheduleModel.ts.
  // Values are palette token names (SCHEDULE_EVENT_COLOR_TOKENS above), never hexes.
  schedule_event_colors: z
    .object({
      job: z.enum(SCHEDULE_EVENT_COLOR_TOKENS).optional(),
      walkthrough: z.enum(SCHEDULE_EVENT_COLOR_TOKENS).optional(),
      'service-plan': z.enum(SCHEDULE_EVENT_COLOR_TOKENS).optional(),
      'calendar-entry': z.enum(SCHEDULE_EVENT_COLOR_TOKENS).optional(),
    })
    .strict()
    .optional(),
  // --- Deposit default (#61) ---
  deposit_default_type: z.enum(['PERCENTAGE', 'FIXED']).optional(),
  deposit_default_percentage: z.number().min(0).max(100).optional(),
  deposit_default_fixed_amount: z.number().min(0).max(99999999).optional(),
  // --- Estimate workspace redesign (§A3a) — org-wide lock-on-send policy, default OFF ---
  lock_on_send: z.boolean().optional(),
  // --- R3 (2026-07-21) cost model org defaults (D2/D8) ---
  labor_rate: z.number().min(0).max(99999999).optional(),
  overhead_mode: z.enum(['PERCENTAGE', 'FIXED']).optional(),
  overhead_value: z.number().min(0).max(99999999).optional(),
}).strict().refine(
  (d) => d.deposit_default_type !== 'FIXED' || d.deposit_default_fixed_amount === undefined || d.deposit_default_fixed_amount >= 0,
  { message: 'Fixed deposit amount must be >= 0', path: ['deposit_default_fixed_amount'] },
);  // reject unknown keys at the Zod layer (defense-in-depth over server-side strip)

/**
 * The organization as the browser gets it. The phone account id is read (the
 * select needs it to know whether the phone service is set up) but never sent:
 * Ran, "the account ID cannot be exposed". The page reads `phone_connected`.
 *
 * TODO(phone-account-id cleanup): `ctm_account_id` stays in the body for one
 * ship only, as `true`/`null` and never the id, so a browser still on the old
 * bundle (a stale service worker) that does Boolean(ctm_account_id) keeps
 * seeing the phone as set up. Remove the key in a later cleanup, once no
 * frontend reads it.
 */
function presentOrganization<T extends { ctm_account_id: string | null; ctm_sms_ready: boolean }>(org: T) {
  const phoneConnected = Boolean(org.ctm_account_id);
  return {
    ...org,
    ctm_account_id: phoneConnected ? true : null,
    phone_connected: phoneConnected,
    // The texting-approval flag under ServWave's own name. The spread above
    // still carries `ctm_sms_ready` with the same value.
    // TODO(phone-api-neutral-names): `ctm_sms_ready` is a deprecated alias,
    // kept one release for a browser still on an old bundle. It rides in on
    // `...org`, so removing it means destructuring it out of the spread
    // (`const { ctm_sms_ready, ...rest } = org`), not deleting a line here.
    sms_ready: org.ctm_sms_ready,
  };
}

export const getOrganization = async (req: Request, res: Response) => {
  try {
    // R3 — cost defaults (labor_rate/overhead_*) are merged in ONLY for a requester who can see
    // pricing (read Invoice). Every other role gets exactly organizationScalarSelect, unchanged.
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: canSeePricing(req) ? { ...organizationScalarSelect, ...organizationCostSelect } : organizationScalarSelect,
    });
    if (!org) {
      res.status(404).json({ error: 'Organization not configured' });
      return;
    }
    res.json(presentOrganization(org));
  } catch (err) {
    logger.error('getOrganization error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const uploadLogo = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    const mime = req.file.mimetype;
    if (!ALLOWED_MIME.includes(mime)) {
      res.status(400).json({ error: 'Unsupported image type' });
      return;
    }
    // Magic-byte sniff before decode: reject header/content mismatch (F-35).
    if (!sniffMatchesDeclared(req.file.buffer, mime, ALLOWED_MIME)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }
    // Re-encode every (raster) logo through sharp with an explicit
    // decompression-bomb guard (F-38): cap decoded pixels + fail on bad input.
    const sharp = await loadSharp();
    const buffer = await sharp(req.file.buffer, { limitInputPixels: 24_000_000, failOn: 'error' })
      .resize(LOGO_MAX_W, LOGO_MAX_H, { fit: 'inside', withoutEnlargement: false })
      .toBuffer();
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id } });
    if (!org) {
      res.status(404).json({ error: 'Organization not configured' });
      return;
    }
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const storagePath = `${org.id}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, { contentType: mime, upsert: true });
    if (upErr) {
      logger.error('Logo upload failed:', upErr);
      res.status(500).json({ error: 'Storage upload failed' });
      return;
    }
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(storagePath);
    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: { logo_url: pub.publicUrl },
    });
    void logAudit({ req, action: 'organization.logo_uploaded', resourceType: 'Organization', resourceId: req.user!.organization_id });
    res.json({ logo_url: updated.logo_url });
  } catch (err) {
    logger.error('uploadLogo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export async function maxNumberForTx(
  tx: Prisma.TransactionClient,
  table: 'leads' | 'estimates' | 'jobs' | 'invoices' | 'customers' | 'service_plans',
  column: 'lead_number' | 'estimate_number' | 'job_number' | 'invoice_number' | 'customer_number' | 'service_plan_number',
  orgId: string,
  // When true, excludes hand-typed rows (number_is_custom) from the scan, so a single
  // custom number can never permanently raise the settings-page floor for that entity's
  // automatic series — the collision check should only ever compare a new next-number
  // against numbers the allocator itself issued. Defaults false, preserving today's
  // behavior for every existing call site (service_plans has no number_is_custom column
  // and must always pass false).
  excludeCustom = false,
): Promise<number> {
  // Highest already-issued number for this entity, or 0 if none. Extract each row's TRAILING
  // digit-run and take the MAX — the SAME extraction the allocator self-heal uses (see
  // lib/numbering.ts), so this collision guard and the allocator always agree on "highest
  // issued number".
  //
  // The previous approach stripped a fixed number of leading chars (the CURRENT prefix length)
  // and hard-cast the remainder to INTEGER. That crashes with Postgres 22P02 ("invalid input
  // syntax for type integer") on any org whose rows don't all match today's prefix — e.g.
  // imported orgs (Workiz) that mix bare-numeric and prefixed numbers, or any org that changed
  // its prefix — aborting the whole settings save with an opaque 500. The trailing-digit regex
  // is immune to prefix mismatches; rows with no digits yield NULL and are ignored by MAX().
  //
  // Identifiers (table/column) come ONLY from the typed literal unions above and the six
  // hardcoded call sites below — never request data — and the regex is a constant, so the
  // Prisma.raw() over those closed identifiers holds no user-controlled SQL sink even if a
  // future refactor wired an identifier to user input. orgId stays a bound parameter. (F-50)
  // Hardcoded literal, same Prisma.raw-of-a-literal safety posture as the rest of this
  // function — never derived from caller input.
  const excludeCustomFilter = excludeCustom ? Prisma.raw('AND NOT number_is_custom') : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ max_num: number | null }>>`
    SELECT MAX((SUBSTRING(${Prisma.raw(column)} FROM '[0-9]+$'))::int) AS max_num
    FROM ${Prisma.raw(table)}
    WHERE organization_id = ${orgId}::uuid ${excludeCustomFilter}
  `;
  return rows[0]?.max_num ?? 0;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const updateOrganization = async (req: Request, res: Response) => {
  try {
    const orgId = req.user!.organization_id;

    // Strip server-controlled fields from inbound payload — only the allocator writes these
    delete (req.body as Record<string, unknown>).lead_first_issued_at;
    delete (req.body as Record<string, unknown>).estimate_first_issued_at;
    delete (req.body as Record<string, unknown>).job_first_issued_at;
    delete (req.body as Record<string, unknown>).invoice_first_issued_at;
    delete (req.body as Record<string, unknown>).customer_first_issued_at;
    delete (req.body as Record<string, unknown>).service_plan_first_issued_at;

    const body = req.body as Record<string, unknown>;

    // All numbering validation + write happens in a single transaction with row-level
    // lock on the org row, to prevent TOCTOU against the concurrent allocator.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;

      const current = await tx.organization.findUnique({
        where: { id: orgId },
        select: {
          stripe_charges_enabled: true,
        },
      });
      if (!current) throw new HttpError(404, 'Organization not configured');

      // Prefix and next-number are both freely editable for every entity, including
      // customers (consistent with leads/estimates/jobs/invoices). The allocator is
      // counter-based — it increments `*_next_number` and prepends the current prefix,
      // never re-parsing existing rows — so changing the prefix only affects numbers
      // issued from now on. The next-number check below still ensures a changed
      // next-number is greater than every number already issued, so identifiers can
      // never duplicate.

      // §4.5 — CARD is server-owned, not a client-settable member of this array: it is
      // derived from stripe_charges_enabled (see resolveAcceptedPaymentMethods for why this
      // resolves rather than validates). The row is already locked FOR UPDATE above, so the
      // charges flag read here cannot race the account.updated webhook. Zod already validated
      // the array shape + enum values.
      if (body.accepted_payment_methods !== undefined) {
        body.accepted_payment_methods = resolveAcceptedPaymentMethods(
          body.accepted_payment_methods as PaymentMethod[],
          current.stripe_charges_enabled,
        );
      }

      // Collision guard — a changed "next number" must be strictly greater than the highest
      // number ALREADY issued for that entity, so moving the starting point can never produce a
      // duplicate document number. Forward-only, matching Workiz/QuickBooks/Xero (you may skip
      // ahead, never go back). Backstops: the allocator self-heals to max+1 (lib/numbering.ts)
      // and the DB composite unique on (organization_id, *_number) is the ultimate guarantee.
      const NEXT_NUMBER_CHECKS = [
        { key: 'lead_next_number',         table: 'leads',         column: 'lead_number',         label: 'Leads',         excludeCustom: true },
        { key: 'estimate_next_number',     table: 'estimates',     column: 'estimate_number',     label: 'Estimates',     excludeCustom: true },
        { key: 'job_next_number',          table: 'jobs',          column: 'job_number',          label: 'Jobs',          excludeCustom: true },
        { key: 'invoice_next_number',      table: 'invoices',      column: 'invoice_number',      label: 'Invoices',      excludeCustom: true },
        { key: 'customer_next_number',     table: 'customers',     column: 'customer_number',     label: 'Customers',     excludeCustom: true },
        { key: 'service_plan_next_number', table: 'service_plans', column: 'service_plan_number', label: 'Service Plans', excludeCustom: false },
      ] as const;
      for (const c of NEXT_NUMBER_CHECKS) {
        const proposed = body[c.key];
        if (proposed === undefined) continue;
        const max = await maxNumberForTx(tx, c.table, c.column, orgId, c.excludeCustom);
        if ((proposed as number) <= max) {
          throw new HttpError(
            400,
            `The next ${c.label} number cannot be lower than ${max + 1}. You have already issued up to ${max}, and existing documents keep their numbers.`,
          );
        }
      }

      // DEC3 — the default receive-location must belong to this org.
      if (body.default_inventory_location_id !== undefined && body.default_inventory_location_id !== null) {
        const loc = await tx.inventoryLocation.findFirst({
          where: { id: body.default_inventory_location_id as string, organization_id: orgId },
          select: { id: true },
        });
        if (!loc) throw new HttpError(400, 'Invalid default_inventory_location_id');
      }

      // Dedupe option arrays (case-insensitive, preserve first occurrence)
      if (Array.isArray(body.source_options)) {
        const seen = new Set<string>();
        body.source_options = (body.source_options as string[]).filter(s => {
          const key = s.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (Array.isArray(body.job_type_options)) {
        const seen = new Set<string>();
        body.job_type_options = (body.job_type_options as string[]).filter(s => {
          const key = s.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (Array.isArray(body.billing_terms_options)) {
        const seen = new Set<string>();
        body.billing_terms_options = (body.billing_terms_options as string[]).filter(s => {
          const key = s.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      return tx.organization.update({
        where: { id: orgId },
        data: body,
        // R3 — same canSeePricing-conditional select as getOrganization. In practice this route is
        // ADMIN-only (canDo('update', 'Organization')) and ADMIN always sees pricing, but the
        // explicit condition keeps the two handlers from being able to drift apart.
        select: canSeePricing(req) ? { ...organizationScalarSelect, ...organizationCostSelect } : organizationScalarSelect,
      });
    });

    await writeSettingsAudit(req, 'organization.updated', { fields: Object.keys(body) });
    void logAudit({ req, action: 'organization.updated', resourceType: 'Organization', resourceId: req.user!.organization_id, metadata: { fields: Object.keys(body) } });
    res.json(presentOrganization(updated));
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error('updateOrganization error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const previewPdf = async (req: Request, res: Response) => {
  try {
    const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id } });
    if (!org) return res.status(404).json({ error: 'Organization not configured' });
    const VALID_TEMPLATES = ['alpha-classic', 'crm-default'] as const;
    type TemplateKey = typeof VALID_TEMPLATES[number];
    const queryTemplate = req.query.template as string | undefined;
    const templateKey: TemplateKey = (VALID_TEMPLATES as readonly string[]).includes(queryTemplate ?? '')
      ? (queryTemplate as TemplateKey)
      : (org.estimate_template ?? 'alpha-classic') as TemplateKey;
    // Allow the Branding screen to preview a brand color before it's saved, so the
    // effect of the color picker is visible live. Only a valid 6-digit hex is honored.
    const queryColor = req.query.color as string | undefined;
    const orgForPreview =
      queryColor && /^#[0-9A-Fa-f]{6}$/.test(queryColor) ? { ...org, brand_color: queryColor } : org;
    // Estimate/Invoice preview toggle — same org (template + brand color) renders both
    // documents. Defaults to 'estimate' so the existing frontend contract is unchanged.
    const isInvoicePreview = req.query.doc === 'invoice';
    const pdfBuffer = isInvoicePreview
      ? await generateInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, orgForPreview, templateKey)
      : await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE as any, orgForPreview, templateKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${isInvoicePreview ? 'invoice' : 'estimate'}-preview.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (err) {
    logger.error('Preview PDF generation failed:', err);
    res.status(500).json({ error: 'Preview generation failed' });
  }
};

// ─── Email sender address ────────────────────────────────

/**
 * The org's chosen local part for its business From address - the string
 * BEFORE the `@`, and nothing else. The domain half is always the shared
 * env.EMAIL_FROM_BUSINESS one, identical for every org, and is deliberately
 * not accepted here: sending is in-house, so an org never picks a domain.
 *
 * Empty clears the override and returns the org to the name-derived default
 * (see effectiveSenderLocalPart in lib/email.ts), which is why the column is
 * nullable rather than backfilled.
 */
export const emailSenderSchema = z
  .object({
    local_part: z
      .string()
      .trim()
      .toLowerCase()
      .max(MAX_SENDER_LOCAL_PART, `Use at most ${MAX_SENDER_LOCAL_PART} characters`)
      .refine((v) => v === '' || /^[a-z0-9]+$/.test(v), {
        // Deliberately narrower than RFC 5322 allows. The full grammar permits
        // dots, plus signs and quoted strings, all of which are mangled or
        // sub-address-interpreted by enough receivers to be a support burden
        // on an address a company prints on invoices.
        message: 'Use letters and numbers only, with no spaces, dots or @',
      })
      .refine((v) => !RESERVED_SENDER_LOCAL_PARTS.has(v), {
        message: 'That address is reserved',
      }),
  })
  .strict();

export const updateEmailSender = async (req: Request, res: Response) => {
  const orgId = req.user!.organization_id;
  // '' means "clear it"; null in the column is what makes the derived default
  // apply again, so the two have to map onto each other here.
  const localPart: string | null = req.body.local_part === '' ? null : req.body.local_part;

  try {
    if (localPart) {
      // Pre-check purely so the admin gets a useful message instead of a raw
      // constraint error. It is NOT the guarantee - two orgs can clear this
      // check concurrently - so the unique index still has to be handled below.
      const taken = await prisma.organization.findFirst({
        where: { email_sender_local_part: localPart, id: { not: orgId } },
        select: { id: true },
      });
      if (taken) {
        res.status(409).json({
          error: 'Another organization already sends from that address',
          code: 'LOCAL_PART_TAKEN',
        });
        return;
      }
    }

    const org = await prisma.organization.update({
      where: { id: orgId },
      data: { email_sender_local_part: localPart },
      select: { id: true, name: true, email_sender_local_part: true },
    });

    await writeSettingsAudit(req, 'organization.email_sender', { local_part: localPart });

    res.json({
      local_part: effectiveSenderLocalPart(org.name, org.email_sender_local_part),
      local_part_is_custom: Boolean(org.email_sender_local_part),
      sender_domain: senderDomainOf(),
    });
  } catch (err) {
    // The index is the real guarantee; whoever loses the race lands here and
    // must get the same clean 409 the pre-check gives, not a 500.
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({
        error: 'Another organization already sends from that address',
        code: 'LOCAL_PART_TAKEN',
      });
      return;
    }
    logger.error('Failed to update organization email sender:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
