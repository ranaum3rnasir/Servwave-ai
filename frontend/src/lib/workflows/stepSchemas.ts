/**
 * stepSchemas.ts — RHF/Zod resolvers for the per-step config forms, a 1:1 mirror
 * of the backend per-step schemas (backend/src/services/automations/
 * workflowValidation.ts). Same bounds, same cross-field rules (custom⇒email,
 * specific_user⇒user_id, condition non-empty) so what a form flags inline is
 * exactly what the server would flag as a "needs setup" issue — only the copy is
 * humanized. The recipient/merge-field *legality* checks stay server-owned
 * (they depend on the trigger's entity, which the amber "changing the trigger"
 * callout warns about) — the forms only offer legal recipients + legal chips.
 *
 * `custom_email`/`user_id` are modelled as plain optional strings (not
 * `.email()`/`.uuid()` at the field level) so the form's empty-string default
 * never spuriously errors; format/required is enforced in `superRefine` only
 * when the recipient actually calls for it — matching how the backend splits the
 * base schema from `validateWorkflowDefinition`'s companion-field checks.
 */

import { z } from 'zod';
import type { AuthorableStepType } from '@/lib/api/workflows';

/** 90 days in minutes — the shared timing ceiling (mirrors MAX_OFFSET_MINUTES). */
const MAX_WAIT_MINUTES = 60 * 24 * 90;

/** Loose email shape — same pattern the legacy editor used for custom recipients. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * v2.1 multi-select normalization (mirrors the backend's `normalizeMessagingConfig`).
 * A messaging step now carries `recipients: RecipientKey[]`, but legacy stored
 * configs — and the current single-Select forms — still speak the singular
 * `recipient`/`custom_email`/`user_id`. This preprocess synthesizes the array
 * fields from the singular ones (when absent) so both the array shape AND the
 * legacy singular shape parse. The singular fields are KEPT (not dropped) so the
 * inferred form-value types still expose them and the existing forms compile
 * unchanged — the multi-select UI migration is a later task.
 */
function withRecipientsArray(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const v: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (!('recipients' in v) && typeof v.recipient === 'string') v.recipients = [v.recipient];
  if (!('custom_emails' in v) && typeof v.custom_email === 'string' && v.custom_email.trim()) {
    v.custom_emails = [v.custom_email];
  }
  if (!('user_ids' in v) && typeof v.user_id === 'string' && v.user_id.trim()) v.user_ids = [v.user_id];
  return v;
}

/** Merge fields referenced in a piece of copy — same regex as the backend validator. */
export const MERGE_FIELD_RE = /\{\{([a-z_.]+)\}\}/g;
export function mergeFieldsIn(text: string): string[] {
  return [...text.matchAll(MERGE_FIELD_RE)].map((m) => m[1] as string);
}

// ── per-step config schemas ─────────────────────────────────────────────────

/**
 * "If empty, fill with": the per-field text a merge field renders when it has no value, keyed
 * by merge field. Mirrors the backend's `fallbacksSchema` (workflowValidation.ts): one line each,
 * optional because a step stored before the map existed reads as the seeded defaults server-side.
 */
const fallbacksSchema = z
  .record(z.string(), z.string().max(120, 'Keep the fallback text under 120 characters'))
  .optional();

/**
 * WAIT has two modes, mirroring the backend union in workflowValidation.ts:
 * relative ("wait 2 days") or anchored to an entity date ("wait until 1 day
 * before the walkthrough" — see lib/workflows/anchors.ts for the legal anchor
 * keys). `anchor`'s literal tuple deliberately does NOT span `AnchorKey` there -
 * same split the backend keeps between anchors.ts (the registry) and
 * workflowValidation.ts (the schema literal), and the same two-of-eight narrowness.
 *
 * PRE-EXISTING NARROWNESS, recorded rather than fixed (Spec B slice 5): an anchored WAIT
 * on the invoice due date or the estimate expiry is already rejected, and a wait anchored on
 * `task.due_at` hits the same wall. Not a task-specific bug. The task REMINDER is a
 * date-anchored trigger, which is a different mechanism and is unaffected.
 */
export const waitRelativeConfigSchema = z
  .object({
    mode: z.literal('relative'),
    duration_minutes: z
      .number({ invalid_type_error: 'Set how long to wait' })
      .int('Use a whole number of minutes')
      .min(5, 'Wait at least 5 minutes')
      .max(MAX_WAIT_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

export const waitAnchoredConfigSchema = z
  .object({
    mode: z.literal('anchored'),
    anchor: z.enum(['job.scheduled_start', 'lead.walkthrough_scheduled_at']),
    direction: z.enum(['before', 'after']),
    offset_minutes: z
      .number({ invalid_type_error: 'Set the timing' })
      .int('Use a whole number of minutes')
      .min(0, 'Timing can’t be negative')
      .max(MAX_WAIT_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

// Legacy relative configs (persisted before anchored wait shipped) have no `mode`
// key — default it so discriminatedUnion can route them, giving proper field-level
// error paths (invalid duration → path 'duration_minutes', not a path-less union
// error). Mirrors the backend's identical preprocess in workflowValidation.ts.
export const waitConfigSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('mode' in (val as object)) ? { mode: 'relative', ...(val as object) } : val),
  z.discriminatedUnion('mode', [waitRelativeConfigSchema, waitAnchoredConfigSchema]),
);

// The recipient element enum stays action-scoped, and the two channels have now
// diverged: SEND_TEXT speaks the full catalog audience set (see TEXT_RECIPIENT
// below, Spec C slice 8) while SEND_EMAIL still speaks the older legacy set its
// single-Select form was built on.
// There is deliberately no notify-recipient enum: the in-app step is retired, and
// this module only carries schemas for step types a draft may still author.
const EMAIL_RECIPIENT = z.enum(['customer', 'assigned_techs', 'all_admins', 'all_dispatchers', 'custom']);

/**
 * The text channel's audience keys - the mirror of workflowValidation.ts's `textRecipientKey`
 * over the same 12-member `AUDIENCE_KEYS` list, plus the legacy `assigned_techs` spelling that
 * `toLegacySingularRecipient` still mirrors onto the singular field.
 *
 * Spec C slice 8. This was two `z.literal('customer')`s inside a `.strict()` object, which was
 * the mirror's half of the customer-only constraint: slice 1 widened the SERVER to the staff
 * audiences, and while this stayed narrow the builder refused a staff text client-side before
 * a request was ever made - a backend-only fix that looks broken.
 *
 * `custom` is absent, and that absence is load-bearing rather than an omission: it is an
 * audience of literal email ADDRESSES with nothing on a handset to resolve to, and `.strict()`
 * below is what keeps its `custom_emails` companion off a text step. Same split the backend
 * keeps between `textRecipientKey` and `emailRecipientKey`.
 *
 * `EMAIL_RECIPIENT` above is deliberately NOT widened to match. It is the older, narrower
 * legacy set the single-Select email form still speaks; expanding it is its own task with its
 * own forms work, and doing it here would silently change what that form accepts.
 */
const TEXT_RECIPIENT = z.enum([
  'customer',
  'assigned_team',
  'dispatcher',
  'salesperson',
  'creator',
  'all_admins',
  'all_dispatchers',
  'specific_user',
  'removed_user',
  'assigned_user',
  'assignees',
  'watchers',
  'assigned_techs',
]);

export const sendTextConfigSchema = z.preprocess(
  withRecipientsArray,
  z
    .object({
      recipient: TEXT_RECIPIENT.optional(),
      recipients: z.array(TEXT_RECIPIENT).min(1),
      body: z.string().min(1, 'Write the text message').max(320, 'Texts are capped at 320 characters'),
      fallbacks: fallbacksSchema,
      // Companion to the `specific_user` audience, mirroring the backend's field of the same
      // name. `user_id` is declared alongside it for the same reason `custom_email` is declared
      // alongside `custom_emails` below: `withRecipientsArray` SYNTHESIZES the plural and KEEPS
      // the singular, so a config carrying only the legacy field would otherwise trip .strict().
      user_ids: z.array(z.string()).optional(),
      user_id: z.string().optional(),
    })
    .strict(),
);

export const sendEmailConfigSchema = z.preprocess(
  withRecipientsArray,
  z
    .object({
      recipient: EMAIL_RECIPIENT.optional(),
      recipients: z.array(EMAIL_RECIPIENT).min(1),
      subject: z.string().min(1, 'Add a subject line').max(200, 'Subject is too long (200 characters max)'),
      body: z.string().min(1, 'Write the email').max(5000, 'Email is too long (5,000 characters max)'),
      custom_email: z.string().optional(),
      custom_emails: z.array(z.string()).optional(),
      fallbacks: fallbacksSchema,
    })
    .strict()
    .superRefine((cfg, ctx) => {
      if (cfg.recipient !== 'custom') return;
      const email = (cfg.custom_email ?? '').trim();
      if (!email) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['custom_email'], message: 'Enter the email address to send to' });
      } else if (!EMAIL_RE.test(email)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['custom_email'], message: 'Enter a valid email address' });
      }
    }),
);

export const stopIfConfigSchema = z.object({ condition: z.string().min(1, 'Pick a condition') }).strict();

// ── the authorable config registry ──────────────────────────────────────────

/**
 * Every config schema this module offers, keyed by the step types a draft may
 * still author - the frontend mirror of the backend's STEP_CONFIG_SCHEMAS in
 * services/automations/workflowValidation.ts, and the reason this module can no
 * longer drift back into offering a step the API would reject with a 400.
 *
 * The key type is the guard. `AuthorableStepType` excludes the retired in-app
 * step, so adding an entry for it here is a compile error ("Object literal may
 * only specify known properties") rather than a live parallel schema for a step
 * type nothing else accepts - the failure mode this module was the last place to
 * still allow. The Record is total, so a dropped entry is caught too (TS1360).
 *
 * `satisfies`, not an annotation: each entry keeps its precise inferred schema
 * type, so the named exports above remain the definitions and this remains the
 * registry over them. Annotating with `Record<AuthorableStepType, z.ZodTypeAny>`
 * would erase `z.infer` for every form-values type below.
 */
export const STEP_CONFIG_SCHEMAS = {
  WAIT: waitConfigSchema,
  SEND_TEXT: sendTextConfigSchema,
  SEND_EMAIL: sendEmailConfigSchema,
  STOP_IF: stopIfConfigSchema,
} satisfies Record<AuthorableStepType, z.ZodTypeAny>;

// ── inferred form-value types ────────────────────────────────────────────────

export type WaitFormValues = z.infer<typeof waitConfigSchema>;
export type SendTextFormValues = z.infer<typeof sendTextConfigSchema>;
export type SendEmailFormValues = z.infer<typeof sendEmailConfigSchema>;
export type StopIfFormValues = z.infer<typeof stopIfConfigSchema>;

export type EmailRecipient = SendEmailFormValues['recipient'];
