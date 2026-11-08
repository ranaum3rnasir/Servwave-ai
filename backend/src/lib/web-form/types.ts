import type { WebFormProvider } from '@prisma/client';

/**
 * One normalised shape for every website-form vendor. The adapters under
 * ./adapters are the only place vendor field slugs live; everything downstream
 * (the ledger today, the Customer + Lead creation in slice 2) reads this.
 * Plan: md_files/plans/communication/2026-09-18-web-form-lead-intake.md §3c.
 *
 * The plan calls this interface `WebFormSubmission`. That name now belongs to
 * the Prisma model for the ledger table, so the in-flight event is
 * `WebFormSubmissionEvent` and the persisted row is `WebFormSubmission` - the
 * same split TrackedCallEvent / CallSession already uses.
 */
export interface WebFormSubmissionEvent {
  provider: WebFormProvider;
  /**
   * The vendor's own entry id, when the payload carries one. It does NOT by
   * default: a Hidden field with Default Value "Submission ID" has to be added
   * to the form first (plan §4 Q4), so this is null until the agency does that.
   */
  vendorSubmissionId: string | null;
  /** `form_title`, appended by the plugin to every delivery. */
  formTitle: string | null;
  firstName: string | null;
  lastName: string | null;
  /** E.164 through normalizeNAPhone, like every other intake path; null when it does not normalise. */
  phone: string | null;
  /** Lowercased and shape-checked through normalizeEmail; null when it is not an email. */
  email: string | null;
  /** `textarea_1`, falling back to `text_1`. */
  message: string | null;
  /** `select_1`. Positional, which is why `field_map` exists. */
  selection: string | null;
  /** `current_url` - the page the form was submitted from. */
  landingPageUrl: string | null;
  /** `referer_url` - the page the visitor arrived from. */
  referringUrl: string | null;
  /** The recognised ad-tracking values among the unmapped keys (utm_*, gclid, …). Also present in `extras`. */
  trackingParams: Record<string, string>;
  /**
   * OUR receive time, and deliberately not the payload's `entry_time`: that is
   * `Y-m-d H:i:s` in the SITE's local zone with no offset, so parsing it as UTC
   * silently shifts every lead by the site's offset. `entry_time` is kept
   * verbatim in `extras` for reconciliation instead.
   */
  submittedAt: Date;
  /** Every key the map does not consume, verbatim. The drift record. */
  extras: Record<string, string>;
}
