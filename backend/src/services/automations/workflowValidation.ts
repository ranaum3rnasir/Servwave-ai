/**
 * workflowValidation.ts — the validation authority for a multi-step workflow
 * definition.
 *
 * Per-step config shape (Zod, one schema per WorkflowStepType) plus the
 * cross-field invariants a rule needs to be engine-runnable: trigger timing,
 * recipient legality, merge-field legality, and stop-if legality. The multi-step successor to the retired
 * automation.controller.ts's `validateBundle` — same invariants, applied
 * per-step instead of to a single action. PURE — no prisma, no I/O. Consumed by the API controller (Phase 3)
 * to gate PATCH/publish, and by the engine (Task 6) for the WorkflowDefinition
 * type frozen into WorkflowVersion.definition.
 */

import { z } from 'zod';
import {
  AutomationTriggerType,
  AutomationActionType,
  AutomationSendWindow,
  WorkflowStepType,
} from '@prisma/client';
import { TRIGGERS, audiencesFor, type AutomationEntity, type AuthorableActionType } from './catalog';
import { type RecipientKey } from './recipients';
import { ANCHORS_FOR_ENTITY, ALL_ANCHOR_KEYS, LEAD_STAGE_CLOCK_ANCHORS, type AnchorKey } from './anchors';

/**
 * Stop-if conditions legal per trigger entity (lead has none in v1).
 *
 * Keyed by the ONE named entity union (automationEntity.ts) rather than a hand-written copy,
 * so a new entity reddens here instead of arriving with an undefined condition list that
 * `legal.includes` would throw on.
 */
export const STOP_IF_CONDITIONS: Record<AutomationEntity, readonly string[]> = {
  invoice: ['invoice_paid', 'invoice_not_open'],
  estimate: ['estimate_answered', 'estimate_approved', 'estimate_declined'],
  job: ['job_cancelled', 'job_completed', 'job_rescheduled'],
  lead: [],
  // Empty, exactly as lead's already is. A task's own staleness - finished or cancelled
  // between enrollment and send - is handled silently inside the engine's send-time
  // re-check rather than exposed as a condition an admin has to reason about.
  task: [],
};

/** Plain-English labels for the builder UI + activity log. */
export const STOP_IF_LABELS: Record<string, string> = {
  invoice_paid: 'the invoice is paid',
  invoice_not_open: 'the invoice is no longer open',
  estimate_answered: 'the customer answered the estimate',
  estimate_approved: 'the estimate was approved',
  estimate_declined: 'the estimate was declined',
  job_cancelled: 'the job was cancelled',
  job_completed: 'the job was completed',
  job_rescheduled: 'the job was rescheduled',
};

/** Timed-trigger offset bound, minutes — 90 days. Same bound as the retired legacy ruleShape. */
const MAX_OFFSET_MINUTES = 60 * 24 * 90;

// ── per-step config schemas ─────────────────────────────────────────────────
//
// EVERY constraint below carries its own sentence. These schemas are parsed on
// each READ of a workflow and their failures are copied verbatim into the
// admin-facing `issues[]` (see validateStep), so a bound left to its default
// publishes the validator's internal English - "String must contain at least
// 1 character(s)" - onto the automations list, beside copy that speaks to the
// admin. Where the builder already words the same rule the sentence is the
// builder's, character for character (frontend/src/lib/workflows/stepSchemas.ts):
// the inline error and the list issue are one message arriving by two routes and
// they must not drift, the same rule the retirement notice below follows.

export const waitRelativeConfigSchema = z
  .object({
    mode: z.literal('relative'),
    duration_minutes: z
      .number({ invalid_type_error: 'Set how long to wait' })
      .int('Use a whole number of minutes')
      .min(5, 'Wait at least 5 minutes')
      .max(MAX_OFFSET_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

/**
 * PRE-EXISTING NARROWNESS, recorded rather than fixed (Spec B slice 5).
 *
 * An anchored WAIT accepts only TWO of the eight registered anchors. That is not a task
 * omission and must not be read as one: an anchored wait on the invoice due date or the
 * estimate expiry is rejected here today, and a wait anchored on `task.due_at` hits the same
 * wall for the same reason. Widening it is its own decision - the two anchors here are the
 * mid-workflow ones, where a wait has a still-pending date to park against - and out of scope
 * for the reminder slice, which adds a date-anchored TRIGGER, a different mechanism entirely.
 */
export const waitAnchoredConfigSchema = z
  .object({
    mode: z.literal('anchored'),
    anchor: z.enum(['job.scheduled_start', 'lead.walkthrough_scheduled_at'], {
      message: 'That timing anchor is no longer available - pick another',
    }),
    direction: z.enum(['before', 'after'], { message: 'Choose whether to wait before or after that date' }),
    offset_minutes: z
      .number({ invalid_type_error: 'Set the timing' })
      .int('Use a whole number of minutes')
      .min(0, 'Timing can’t be negative')
      .max(MAX_OFFSET_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

// Legacy relative configs have no `mode` key — default it so discriminatedUnion can route them,
// giving proper field-level error paths (invalid duration → path 'duration_minutes', not a path-less union error).
export const waitConfigSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('mode' in (val as object)) ? { mode: 'relative', ...(val as object) } : val),
  z.discriminatedUnion('mode', [waitRelativeConfigSchema, waitAnchoredConfigSchema]),
);

// ── recipients[] multi-select (v2.1) ────────────────────────────────────────
// A messaging step now targets a SET of audiences. The element enum is the
// coarse structural gate — the precise trigger+action legality (audiencesFor,
// catalog.ts — the SAME function the builder's multi-select reads, so the two
// can never legalize different sets) is enforced in validateStep, mirroring
// how the schema stays broad and the cross-field checks stay in
// validateWorkflowDefinition. `custom` is a SEND_EMAIL-only audience, so it is
// absent from the SEND_TEXT and NOTIFY_TEAM element enums; `removed_user` /
// `assigned_user` are legal here structurally for all three but only actually
// offered by audiencesFor() on the two REMOVED / three ASSIGNED triggers
// respectively - everywhere else validateStep's legal-set check below is what
// rejects them.
//
// Spec C slice 1: SEND_TEXT joined this list. It used to type its recipients as the
// literal 'customer' and so did not share these keys at all.
const AUDIENCE_KEYS = [
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
  // Spec B: the two task-people audiences. Structural only, as with the two above - the
  // precise legality check below is audiencesFor(), which offers these on task triggers
  // and nowhere else.
  'assignees',
  'watchers',
] as const;
const emailRecipientKey = z.enum([...AUDIENCE_KEYS, 'custom'], {
  message: 'That recipient isn’t available for emails - pick another',
});
/**
 * The text channel's element enum. Spec C slice 1: a text step used to type its recipients
 * as an array of the literal 'customer', which was the FIRST of two doors shutting a staff
 * text out (the second was the audience narrowing in catalog.ts's audiencesFor, removed in
 * the same change).
 *
 * Same key set as `teamRecipientKey` below and deliberately NOT that constant: the audiences
 * coincide, the admin-facing sentence does not. An enum with no `message` publishes zod's
 * own English - "Invalid enum value. Expected 'customer' | ..." - straight onto the
 * automations list, which is the exact failure the note at the top of this section forbids.
 *
 * `custom` is absent for the same reason it is absent from teamRecipientKey: it is an
 * audience of literal email ADDRESSES, with nothing on a handset to resolve to.
 */
const textRecipientKey = z.enum(AUDIENCE_KEYS, {
  message: 'That recipient isn’t available for text messages - pick another',
});
const teamRecipientKey = z.enum(AUDIENCE_KEYS);

/**
 * Legacy-singular normalization (back-compat is MANDATORY — stored configs from
 * before v2.1 carry `recipient`/`custom_email`/`user_id`):
 *   { recipient } → { recipients: [recipient] }
 *   { custom_email } → { custom_emails: [custom_email] }
 *   { user_id } → { user_ids: [user_id] }
 * The legacy `assigned_techs` key is folded to its canonical `assigned_team`
 * (same alias the audience resolver honors), so entity legality sees one key.
 * The singular keys are dropped so `.strict()` accepts the normalized object.
 */
function normalizeMessagingConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const v: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (!('recipients' in v) && 'recipient' in v) v.recipients = [v.recipient];
  if (!('custom_emails' in v) && 'custom_email' in v) v.custom_emails = [v.custom_email];
  if (!('user_ids' in v) && 'user_id' in v) v.user_ids = [v.user_id];
  delete v.recipient;
  delete v.custom_email;
  delete v.user_id;
  if (Array.isArray(v.recipients)) {
    v.recipients = v.recipients.map((r) => (r === 'assigned_techs' ? 'assigned_team' : r));
  }
  return v;
}

/**
 * "If empty, fill with": the per-field text a merge field renders when it has no value, keyed
 * by merge field. One line each - a fallback lands mid-sentence, so a newline in it is a
 * paste accident, not a choice. Optional: a step stored without it reads as the seeded
 * default set (mergeFieldFallbacks.ts), which is what keeps every already-published
 * workflow rendering exactly as it did.
 */
const fallbacksSchema = z
  .record(
    z.string().regex(/^[a-z_.]+$/, 'That is not a merge field'),
    z
      .string()
      .max(120, 'Keep the fallback text under 120 characters')
      .refine((v) => !/[\r\n]/.test(v), 'Keep the fallback text to one line'),
  )
  .optional();

export const sendTextConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(textRecipientKey).min(1, 'Choose who this text message goes to'),
      body: z.string().min(1, 'Write the text message').max(320, 'Texts are capped at 320 characters'),
      fallbacks: fallbacksSchema,
      /**
       * Companion to the `specific_user` audience, mirroring sendEmailConfigSchema. Allowing
       * the field is the whole of what makes the named-member audience reachable on a text:
       * the specific_user ⇔ user_ids cross-check in validateStep runs for EVERY messaging
       * step with no action gate, so it starts applying to text steps the moment the field
       * parses, rather than needing a second edit down there.
       */
      user_ids: z.array(z.string().uuid('Pick the team member from the list again')).optional(),
    })
    // `custom_emails` has no entry above and .strict() is what refuses it. That is the
    // enforcement half of leaving `custom` out of textRecipientKey - without it a text step
    // could carry addresses it can never deliver to, and the custom ⇔ custom_emails
    // cross-check below is SEND_EMAIL-only, so nothing else would catch them.
    .strict(),
);

export const sendEmailConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(emailRecipientKey).min(1, 'Choose who this email goes to'),
      subject: z.string().min(1, 'Add a subject line').max(200, 'Subject is too long (200 characters max)'),
      body: z.string().min(1, 'Write the email').max(5000, 'Email is too long (5,000 characters max)'),
      custom_emails: z.array(z.string().email('Enter a valid email address')).optional(),
      user_ids: z.array(z.string().uuid('Pick the team member from the list again')).optional(),
      fallbacks: fallbacksSchema,
    })
    .strict(),
);

/**
 * The retired in-app step's stored config shape. Retained, and deliberately
 * ABSENT from the authorable config-schema map below, for the same reason the
 * Activity-tab label map and migrateRules keep the label: it describes rows
 * storage already holds - legacy `workflow_steps` rows and the frozen
 * `workflow_versions.definition` JSON - not a shape anything may still author.
 *
 * Its bounds are also the one set here left without admin-facing copy, and
 * deliberately so: validateStep refuses a NOTIFY_TEAM step with the retirement
 * sentence before it ever looks a config schema up, so nothing this schema says
 * can reach an admin. Wording it would only imply the step is still fixable.
 */
export const notifyTeamConfigSchema = z.preprocess(
  normalizeMessagingConfig,
  z
    .object({
      recipients: z.array(teamRecipientKey).min(1),
      body: z.string().min(1).max(5000),
      user_ids: z.array(z.string().uuid()).optional(),
    })
    .strict(),
);

export const stopIfConfigSchema = z
  .object({
    condition: z.string().min(1, 'Pick a condition'),
  })
  .strict();

/**
 * The step types an admin may still AUTHOR, as opposed to the ones storage can hold.
 * Hand-written rather than derived from WorkflowStepType on purpose: the Postgres enum
 * keeps every label it has ever had so historic rows still resolve, which makes storage
 * permanently wider than the authoring surface. The `satisfies` clause is the guard -
 * putting a retired label back in this list stops the build instead of quietly widening
 * the write API again.
 */
export type AuthorableStepType = Exclude<WorkflowStepType, 'NOTIFY_TEAM'>;

export const AUTHORABLE_STEP_TYPES = [
  'WAIT',
  'SEND_TEXT',
  'SEND_EMAIL',
  'STOP_IF',
] as const satisfies readonly AuthorableStepType[];

/**
 * Config schema per step type, keyed by the AUTHORABLE union rather than by
 * WorkflowStepType. That narrowing is the compile-time half of the retirement:
 * putting a retired label back in here no longer type-checks, so the write API
 * cannot be widened again by editing this map alone.
 *
 * Still PARTIAL, and still looked up through a guard: WorkflowStepType's labels
 * outlive the authoring surface (a retired step keeps its storage label so
 * historic step runs and frozen version JSON still resolve), so a stored step
 * can name a type with no entry here. validateStep turns that miss into a
 * validation issue an admin can act on instead of a TypeError.
 */
const STEP_CONFIG_SCHEMAS: Partial<Record<AuthorableStepType, z.ZodTypeAny>> = {
  WAIT: waitConfigSchema,
  SEND_TEXT: sendTextConfigSchema,
  SEND_EMAIL: sendEmailConfigSchema,
  STOP_IF: stopIfConfigSchema,
};

/**
 * The one bridge from the wide storage enum to the narrowed map above. Every
 * lookup goes through it, so the widening happens in exactly one place and a
 * stored-but-unauthorable step type is a `undefined` schema, never an index error.
 */
function configSchemaFor(stepType: WorkflowStepType): z.ZodTypeAny | undefined {
  return (STEP_CONFIG_SCHEMAS as Partial<Record<WorkflowStepType, z.ZodTypeAny>>)[stepType];
}

/**
 * The one piece of copy an admin sees for a step whose type this build no longer
 * knows how to configure. Shared with the Test dialog so both surfaces say the
 * same thing.
 */
export const UNSUPPORTED_STEP_MESSAGE =
  'This step is no longer supported. Remove it and choose a different action.';

/**
 * The retired in-app step gets its OWN rejection, deliberately different from the
 * generic copy above.
 *
 * The generic sentence is right for a step type this build has simply never heard
 * of - there is nothing more to say about it. The in-app step is the opposite
 * case: the product made a decision (ADR 0005 - the bell is hardcoded, the
 * Automation Center owns email and text), the same outcome still happens without
 * the step, and the admin's whole task is to delete one row. An admin who reads
 * "no longer supported" learns none of that and opens a support ticket.
 *
 * The position is in the sentence, not only in the issue's `step_index`, because
 * this is the one place the retirement shows up as friction and the admin has to
 * know WHICH step to delete without counting bubbles. Worded to match the
 * read-only notice the step-config drawer shows for the same step
 * (frontend/src/lib/workflows/retiredStep.ts) - the two are the same message
 * arriving by different routes, and they must not drift.
 */
export function retiredInAppStepMessage(stepIndex: number): string {
  return (
    `Step ${stepIndex + 1} no longer sends. In-app notifications now come from the bell, ` +
    'so remove this step to publish this automation.'
  );
}

/** True when this build still knows how to configure and run this step type. */
export function isSupportedStepType(stepType: WorkflowStepType): boolean {
  return configSchemaFor(stepType) !== undefined;
}

/**
 * Authorable step type → the authorable action type audiencesFor() expects.
 * WAIT/STOP_IF have none, which is what keeps this Partial. Both sides are keyed
 * by the AUTHORABLE unions rather than by the two Prisma enums: the retired in-app
 * step is refused at the top of validateStep and can never reach this map, so an
 * entry for it would be dead, and a wider key type would make writing one look
 * legal. Partial<Record<…>> has no compile-time exhaustiveness, so the remaining
 * two entries are checked by hand rather than by tsc.
 */
const STEP_ACTION_TYPE: Partial<Record<AuthorableStepType, AuthorableActionType>> = {
  SEND_TEXT: 'SEND_SMS',
  SEND_EMAIL: 'SEND_EMAIL',
};

/** Shape shared by the messaging step configs, once parsed. */
type MessagingConfig = {
  recipients: RecipientKey[];
  body: string;
  subject?: string;
  custom_emails?: string[];
  user_ids?: string[];
  fallbacks?: Record<string, string>;
};

// ── trigger-level config schemas ────────────────────────────────────────────
// Date-anchored triggers (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) carry their
// timing as anchor + direction + offset instead of a bare offset — same shape
// as an anchored WAIT step's config, but the anchor enum spans all four
// entities (a WAIT step's anchor is narrower — only the two mid-workflow
// entities job/lead currently support an anchored wait).

export interface DateAnchorTriggerConfig {
  anchor: AnchorKey;
  direction: 'before' | 'after';
  offset_minutes: number;
}

export const dateAnchorTriggerConfigSchema = z
  .object({
    // Derived from the registry, never re-listed here — see ALL_ANCHOR_KEYS. The hand-written
    // copy this replaces would have rejected every anchor spec #1751 D8 added while the builder
    // was already offering them, and the failure would have surfaced as an unexplained validation
    // error on save rather than as a missing option.
    anchor: z.enum(ALL_ANCHOR_KEYS),
    direction: z.enum(['before', 'after']),
    offset_minutes: z.number().int().min(0).max(MAX_OFFSET_MINUTES),
  })
  .strict();

/**
 * Triggers whose timing is an anchor + direction + offset rather than a bare offset.
 *
 * NOT derived from anything, so it is the one list a new date-anchored trigger has to be
 * added to BY HAND - miss it and the trigger's own config is rejected with "this trigger
 * fires on the event itself - remove the timing offset", which reads as nonsense.
 */
const DATE_ANCHORED_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_DATE_ANCHORED',
  'LEAD_DATE_ANCHORED',
  'INVOICE_DATE_ANCHORED',
  'ESTIMATE_DATE_ANCHORED',
  // Spec B slice 5, added in the same change as its Postgres enum value.
  'TASK_DATE_ANCHORED',
] satisfies AutomationTriggerType[]);

// SRVW-113 — JOB_SUB_STATUS_ENTERED fires on the event itself (not time-based),
// but unlike every other event trigger it still needs a trigger_config: WHICH
// sub-status the workflow cares about. `sub_status_id` only resolves inside
// the publishing org, but that lookup is I/O — this module is pure, so the
// org-membership check happens at publish time in workflow.controller.ts,
// mirroring how specific_user's user_id is resolved there today.
export interface SubStatusTriggerConfig {
  sub_status_id: string;
}

export const subStatusTriggerConfigSchema = z
  .object({ sub_status_id: z.string().uuid() })
  .strict();

/** Triggers whose trigger_config is a bare sub_status_id rather than an offset. */
const SUB_STATUS_SCOPED_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_SUB_STATUS_ENTERED',
]);

// ── shapes ───────────────────────────────────────────────────────────────────

export interface WorkflowStepInput {
  position: number;
  step_type: WorkflowStepType;
  config: unknown;
}

/** The shape frozen into WorkflowVersion.definition (and what the engine executes). */
export interface WorkflowDefinition {
  trigger_type: AutomationTriggerType;
  trigger_config: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window: AutomationSendWindow;
  steps: Array<{ position: number; step_type: WorkflowStepType; config: unknown }>;
}

export interface ValidationIssue {
  step_index: number; // -1 for workflow-level issues (trigger/offset/steps-shape)
  path: string; // e.g. 'config.body', 'trigger_config', 'steps'
  message: string; // plain-English, user-facing
}

/** Merge fields referenced in a piece of copy — same regex the legacy controller used. */
const MERGE_FIELD_RE = /\{\{([a-z_.]+)\}\}/g;
function mergeFieldsIn(text: string): string[] {
  return [...text.matchAll(MERGE_FIELD_RE)].map((m) => m[1]);
}

function isValidOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= MAX_OFFSET_MINUTES;
}

/**
 * Triggers that fire on a PAST/terminal state of the anchor's entity (the job
 * or walkthrough is already done or cancelled). An anchored WAIT's target date
 * (anchorDate ± offset) is only meaningful when the anchor is plausibly in the
 * future — under one of these triggers it has already passed, so the wait would
 * resolve as immediately due and send a stale reminder. Scheduling/assignment
 * triggers (JOB_SCHEDULED/RESCHEDULED, TECH_ASSIGNED, WALKTHROUGH_SCHEDULED/
 * RESCHEDULED/PERFORMER_ASSIGNED, LEAD_*) are left out — their anchor is
 * plausibly future (or null, which Task 4b's park-then-stop already handles).
 */
const TERMINAL_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_COMPLETED',
  'JOB_CANCELLED',
  'WALKTHROUGH_COMPLETED',
  'WALKTHROUGH_CANCELLED',
]);

/** Full-definition validation. Returns [] when publishable. */
export function validateWorkflowDefinition(def: {
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window?: AutomationSendWindow;
  steps: WorkflowStepInput[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trigger = TRIGGERS[def.trigger_type];

  // 1 & 2 — trigger timing
  if (DATE_ANCHORED_TRIGGERS.has(def.trigger_type)) {
    const parsed = dateAnchorTriggerConfigSchema.safeParse(def.trigger_config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        issues.push({
          step_index: -1,
          path: field ? `trigger_config.${field}` : 'trigger_config',
          message: issue.message,
        });
      }
    } else if (!ANCHORS_FOR_ENTITY[trigger.entity].includes(parsed.data.anchor)) {
      issues.push({
        step_index: -1,
        path: 'trigger_config.anchor',
        message: 'This timing anchor isn’t available for this trigger',
      });
    } else if (parsed.data.direction === 'before' && LEAD_STAGE_CLOCK_ANCHORS.has(parsed.data.anchor)) {
      // A lead stage clock records a moment AS IT HAPPENS, so "two hours BEFORE the lead arrives"
      // is a rule that can never fire — by the time the column carries a date, the window the
      // per-minute sweep looks forward into is already behind it. Refused here rather than left
      // constructible, because the failure mode is pure silence: the rule saves, reads correctly
      // in the builder, and then nothing ever fires and nothing ever goes red.
      //
      // Kept here rather than in the schema above on purpose. That schema is also a member of
      // createWorkflowSchema's DTO union, where a refinement failure surfaces as a path-less
      // union error on every draft save; this is the layer that speaks in plain English and
      // points at a field, and it is where the sibling anchor check already lives.
      issues.push({
        step_index: -1,
        path: 'trigger_config.direction',
        message: 'This moment is recorded as it happens, so an automation can only run after it — choose “after”',
      });
    }
  } else if (trigger.timeBased) {
    if (!isValidOffset((def.trigger_config as { offset_minutes?: unknown } | null)?.offset_minutes)) {
      issues.push({
        step_index: -1,
        path: 'trigger_config',
        message: 'This trigger needs a timing offset (e.g. 24 hours before)',
      });
    }
  } else if (SUB_STATUS_SCOPED_TRIGGERS.has(def.trigger_type)) {
    const parsed = subStatusTriggerConfigSchema.safeParse(def.trigger_config);
    if (!parsed.success) {
      issues.push({
        step_index: -1,
        path: 'trigger_config.sub_status_id',
        message: 'Pick which sub-status should trigger this automation',
      });
    }
  } else if (def.trigger_config != null) {
    issues.push({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  }

  // 3 — steps must be non-empty
  if (def.steps.length === 0) {
    issues.push({ step_index: -1, path: 'steps', message: 'Add at least one step' });
    return issues; // nothing left to validate per-step
  }

  // 4 — positions must be exactly 0..n-1, in ascending array order
  const inOrder = def.steps.every((step, index) => step.position === index);
  if (!inOrder) {
    issues.push({ step_index: -1, path: 'steps', message: 'Steps are out of order — tidy up and try again' });
  }

  // 5-9 — per-step config + cross-field invariants
  def.steps.forEach((step, index) => {
    validateStep(step, index, def.trigger_type, trigger.entity, issues);
  });

  return issues;
}

function validateStep(
  step: WorkflowStepInput,
  index: number,
  triggerType: AutomationTriggerType,
  entity: AutomationEntity,
  issues: ValidationIssue[],
): void {
  // The retired in-app step is refused HERE, at the very top, ahead of the
  // config-schema lookup. Ordering is the whole point: the lookup below reports
  // any schema-less step with the generic sentence, and a schema parse failure
  // reports field errors, so a rejection placed anywhere lower would lose the
  // deliberate copy to whichever generic message happened to fire first. Storage
  // keeps the label (historic step runs and frozen version JSON still resolve),
  // so a stored draft can still name it - this is what stops that draft being
  // republished. Already-published versions are untouched and keep running; a
  // legacy step in one is neutralised at run time, not rejected.
  if (step.step_type === 'NOTIFY_TEAM') {
    issues.push({ step_index: index, path: 'step_type', message: retiredInAppStepMessage(index) });
    return;
  }

  // Spec B's "a text step on an entity with no customer" guard stood here and Spec C slice 1
  // removed it, exactly as its own note said it would. It fired when a trigger had ZERO legal
  // text audiences, which only ever happened because SMS narrowed to `customer` and a task
  // has none. A text step now reaches every audience an email step reaches (catalog.ts's
  // audiencesFor), so the condition can no longer be true for any trigger and the guard was
  // dead code asserting a channel rule that is no longer the rule.
  //
  // Nothing replaces it: a task text addressed to `assignees` is legal, and one addressed to
  // `customer` is caught by the ordinary per-entity recipient check below, in that check's
  // own words. The frontend lock this note once deferred to a later slice is GONE. Spec C
  // slice 8 lifted it: lockedStepTypesFor (featureFlags.ts) asks one question again - has the
  // org connected texting - with the per-subject task clause and its "a task has no customer,
  // use an email step instead" copy deleted, and stepSchemas.ts's TEXT_RECIPIENT is now a
  // widened enum over the same 12-member AUDIENCE_KEYS list textRecipientKey uses above (plus
  // the legacy `assigned_techs` spelling). Client and server agree on the channel's audiences.

  // A step type with no config schema is reported, not thrown on. This function
  // runs on every READ of a workflow (toApiWorkflow), not just at publish, so an
  // unguarded lookup would 500 the whole automations list for any organization
  // holding such a step in a draft. Validation continues with the other steps.
  const schema = configSchemaFor(step.step_type);
  if (!schema) {
    issues.push({ step_index: index, path: 'step_type', message: UNSUPPORTED_STEP_MESSAGE });
    return;
  }
  const result = schema.safeParse(step.config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join('.');
      issues.push({
        step_index: index,
        path: field ? `config.${field}` : 'config',
        message: issue.message,
      });
    }
    return; // config didn't even parse — nothing typed left to check
  }

  // WAIT: bounds are fully covered by the schema parse above (rule 5); an
  // anchored wait additionally needs its anchor to belong to the trigger's
  // entity, and its trigger must NOT be terminal (rule 11 — a past/terminal
  // trigger's anchor has already happened, so the wait would fire immediately).
  if (step.step_type === 'WAIT') {
    const cfg = result.data as { mode?: string; anchor?: AnchorKey };
    if (cfg.mode === 'anchored' && cfg.anchor && !ANCHORS_FOR_ENTITY[entity].includes(cfg.anchor)) {
      issues.push({
        step_index: index,
        path: 'config.anchor',
        message: 'This timing anchor isn’t available for this trigger',
      });
    }
    if (cfg.mode === 'anchored' && TERMINAL_TRIGGERS.has(triggerType)) {
      issues.push({
        step_index: index,
        path: 'config.mode',
        message:
          'A ‘wait until before/after’ timer needs a trigger with an upcoming date — this trigger fires after the fact',
      });
    }
    return;
  }

  // 6-8 — messaging steps: recipient legality (every key in recipients[] must be
  // an audience audiencesFor(triggerType, actionType) actually offers — trigger-
  // scoped, not just entity-scoped, so a trigger-specific audience like
  // removed_user validates correctly), the custom/specific_user companion
  // fields (required-iff-selected, both directions), and merge-field legality.
  const actionType = STEP_ACTION_TYPE[step.step_type];
  if (actionType) {
    const cfg = result.data as MessagingConfig;

    const legal = new Set<string>(audiencesFor(triggerType, actionType).map((opt) => opt.key));
    for (const key of cfg.recipients) {
      if (!legal.has(key)) {
        issues.push({
          step_index: index,
          path: 'config.recipients',
          message: `Recipient "${key}" is not available for this trigger`,
        });
      }
    }

    // specific_user ⇔ user_ids (both directions): a chosen person needs at least
    // one id, and stray ids without the specific-person audience are a mistake.
    const hasSpecificUser = cfg.recipients.includes('specific_user');
    const userIds = cfg.user_ids ?? [];
    if (hasSpecificUser && userIds.length === 0) {
      issues.push({ step_index: index, path: 'config.user_ids', message: 'Pick the team member to notify' });
    } else if (!hasSpecificUser && userIds.length > 0) {
      issues.push({
        step_index: index,
        path: 'config.user_ids',
        message: 'Add the specific-person recipient, or remove the chosen team member(s)',
      });
    }

    // custom ⇔ custom_emails (SEND_EMAIL only, both directions).
    if (step.step_type === 'SEND_EMAIL') {
      const hasCustom = cfg.recipients.includes('custom');
      const customEmails = cfg.custom_emails ?? [];
      if (hasCustom && customEmails.length === 0) {
        issues.push({ step_index: index, path: 'config.custom_emails', message: 'Enter the email address to send to' });
      } else if (!hasCustom && customEmails.length > 0) {
        issues.push({
          step_index: index,
          path: 'config.custom_emails',
          message: 'Add the custom-email recipient, or remove the extra address(es)',
        });
      }
    }

    // Mirrors validateBundle: every field referenced anywhere in the copy is
    // checked, and any miss is reported at config.body (parity with the
    // single-action validator this module mirrors).
    const allowedFields = new Set(TRIGGERS[triggerType].mergeFields);
    const used = [...mergeFieldsIn(cfg.body), ...mergeFieldsIn(cfg.subject ?? '')];
    for (const field of used) {
      if (!allowedFields.has(field)) {
        issues.push({
          step_index: index,
          path: 'config.body',
          message: `The field {{${field}}} isn't available for this trigger`,
        });
      }
    }
    return;
  }

  // 9 — stop-if condition must be legal for the trigger's entity
  if (step.step_type === 'STOP_IF') {
    const cfg = result.data as { condition: string };
    const legal = STOP_IF_CONDITIONS[entity];
    if (!legal.includes(cfg.condition)) {
      issues.push({
        step_index: index,
        path: 'config.condition',
        message: "This stop condition isn't available for this trigger",
      });
    }
  }
}
