/**
 * The Customer form's validation contract.
 *
 * One schema, imported by both the legacy form page and its /v2 rebuild, so a
 * rule can never land on one form and miss the other. Moved out of
 * `pages/CustomerFormPage.tsx` verbatim.
 */
import { z } from 'zod';

const CONTACT_REQUIRED_MSG = 'Enter a phone number or an email';
const PHONE_DIGITS_MSG = 'Enter a 10-digit phone number';
const EMAIL_INVALID_MSG = 'Enter a valid email address';

const digitsOf = (v: string | undefined) => (v ?? '').replace(/\D/g, '');

// Both State inputs are one narrow grid column, sized for a 2-letter code. Imported rows
// hold a full state name, and the field can only show a fragment of it ("sey"), so the
// message has to carry the value it actually found.
const STATE_CODE_MSG = 'Use the 2-letter state code';
const stateCodeIssue = (v: string | undefined) => ({
  message: v && v.trim().length > 2 ? `${STATE_CODE_MSG} (found "${v}")` : STATE_CODE_MSG,
});

// ─── Schema ──────────────────────────────────────────

export const customerSchema = z
  .object({
    segment: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    company_name: z.string().max(200).optional(),
    // Phone and email are each optional; at least one is required (SERV10X-35).
    // Still validated as an email when a value is entered.
    email: z
      .string()
      .email(EMAIL_INVALID_MSG)
      .optional()
      .or(z.literal('')),
    phone: z.string().max(20).optional(),
    phone_ext: z.string().max(10).optional(),
    // Additional emails (entity-redesign §2 extra_emails[]).
    extra_emails: z
      .array(
        z.object({
          email: z.string().optional(),
          label: z.string().max(50).optional(),
          // Opts this address in to the org's automated customer mail. Always sent
          // explicitly - the API reads an omitted flag as false, so leaving it out
          // would quietly opt an address back out on every save.
          receives_emails: z.boolean().optional(),
        }),
      )
      .optional(),
    // Additional structured phones (entity-redesign §2 phones[]).
    phones: z
      .array(
        z.object({
          phone: z.string().optional(),
          label: z.string().max(50).optional(),
          extension: z.string().max(10).optional(),
          is_primary: z.boolean().optional(),
        }),
      )
      .optional(),
    ad_source: z.string().optional(),
    // New `source` column (backend accepts both ad_source + source).
    source: z.string().optional(),
    allow_billing: z.boolean().optional(),
    tax_exempt: z.boolean().optional(),
    // Account-type / franchise model (entity-redesign §2/§10).
    account_type: z.enum(['individual', 'under']).default('individual'),
    is_franchise: z.boolean().optional(),
    parent_id: z.string().optional(),
    billing_terms: z.string().optional(),
    // Service-location address (mapped to locations[] / primary-location patch).
    // Service address is OPTIONAL — capture it if known; if any part is filled, all
    // parts must be filled (completeness enforced in superRefine below).
    address_line1: z.string().max(200).optional(),
    address_line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    // No `.max(2)`: a longer value has to REACH the refine so the message can
    // quote what it found. Truncating it at the type level rejects with the
    // generic zod length error instead.
    state: z
      .string()
      .optional()
      .refine((v) => !v || v.length === 2, stateCodeIssue),
    zip: z.string().max(10).optional(),
    // Inverted billing — default same as service location.
    billing_same_as_service_location: z.boolean().optional(),
    billing_address_line1: z.string().max(200).optional(),
    billing_address_line2: z.string().max(200).optional(),
    billing_city: z.string().max(100).optional(),
    billing_state: z
      .string()
      .optional()
      .refine((v) => !v || v.length === 2, stateCodeIssue),
    billing_zip: z.string().max(10).optional(),
    notes: z.string().max(5000).optional(),
    // Admin-only: backdate the customer's created_at (e.g. for imported records).
    created_at: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    // unified-client-creation §2 — a customer needs a first name OR a company name;
    // kind is derived server-side from company_name (see the spec + backend deriveCustomerKind).
    if (!d.first_name?.trim() && !d.company_name?.trim()) {
      ctx.addIssue({ code: 'custom', message: 'Enter a first name or a company name', path: ['first_name'] });
    }

    // Primary phone — optional, but if present must be exactly 10 digits.
    // At least one of phone/email is required (SERV10X-35).
    const primaryDigits = digitsOf(d.phone);
    const hasEmail = Boolean(d.email?.trim());
    if (primaryDigits.length === 0) {
      if (!hasEmail) {
        ctx.addIssue({ code: 'custom', message: CONTACT_REQUIRED_MSG, path: ['phone'] });
      }
    } else if (primaryDigits.length !== 10) {
      ctx.addIssue({ code: 'custom', message: PHONE_DIGITS_MSG, path: ['phone'] });
    }

    // Service address is optional, but must be COMPLETE if any part is filled.
    const addrFilled = [d.address_line1, d.city, d.state, d.zip].some(
      (v) => (v ?? '').trim().length > 0,
    );
    if (addrFilled) {
      if (!d.address_line1?.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: 'Street address is required to save an address',
          path: ['address_line1'],
        });
      }
      if (!d.city?.trim()) {
        ctx.addIssue({ code: 'custom', message: 'City is required to save an address', path: ['city'] });
      }
      if ((d.state ?? '').trim().length !== 2) {
        ctx.addIssue({ code: 'custom', ...stateCodeIssue(d.state), path: ['state'] });
      }
      if (!d.zip?.trim()) {
        ctx.addIssue({ code: 'custom', message: 'ZIP is required to save an address', path: ['zip'] });
      }
    }

    // Additional phones — any non-empty row must be exactly 10 digits.
    (d.phones || []).forEach((p, i) => {
      const digits = digitsOf(p.phone);
      if (digits.length > 0 && digits.length !== 10) {
        ctx.addIssue({ code: 'custom', message: PHONE_DIGITS_MSG, path: ['phones', i, 'phone'] });
      }
    });

    // Additional emails — any non-empty row must be a valid email.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    (d.extra_emails || []).forEach((e, i) => {
      const v = (e.email || '').trim();
      if (v.length > 0 && !EMAIL_RE.test(v)) {
        ctx.addIssue({ code: 'custom', message: EMAIL_INVALID_MSG, path: ['extra_emails', i, 'email'] });
      }
    });
  });

export type CustomerFormData = z.infer<typeof customerSchema>;
