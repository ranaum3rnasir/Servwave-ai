/**
 * describeWorkflow.ts — the plain-English recipe sentence for a workflow, plus
 * the template→workflow folding used by the templates gallery's "Use this".
 *
 * Deliberately self-contained: no import from `lib/automations/describeRule.ts`
 * or `lib/api/automations.ts` — that legacy tree is deleted in Task 15, and
 * Task 11 set the precedent of re-declaring shared vocabulary locally so this
 * new module has zero dependency on what's being retired.
 */

import type {
  AuthorableStepType,
  AutomationTemplate,
  AutomationTriggerType,
  DateAnchorTriggerConfig,
  SubStatusTriggerConfig,
  WorkflowCatalog,
  WorkflowInput,
  WorkflowStepInput,
  WorkflowStepType,
} from '@/lib/api/workflows';
import type { AnchorKey } from './anchors';

/** A legacy timed trigger's bare-offset config, the (Part B) anchored shape, or
 *  JOB_SUB_STATUS_ENTERED's bare sub_status_id (SRVW-113). */
type TriggerConfig = { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig;

// ── offset humanizing ───────────────────────────────────────────────────────

/**
 * "1440" → "1 day" · "720" → "12 hours" · "30" → "30 minutes". Day-first
 * bucketing — mirrors the legacy Automation Center's `describeRule.formatOffset`
 * convention (same buckets, singular/plural handling), which is also what the
 * approved mockup uses throughout ("1 day before a job starts").
 */
export function formatOffset(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// ── recipients ───────────────────────────────────────────────────────────────

/**
 * Legacy 6-member `RecipientKey` labels plus the v2.1 `AudienceKey` additions
 * (assigned_team/dispatcher/salesperson/creator). `assigned_techs` keeps its own
 * entry rather than folding into `assigned_team` — a legacy config can still
 * carry that literal singular value and should keep reading the same way.
 */
const RECIPIENT_LABELS: Record<string, string> = {
  customer: 'the customer',
  assigned_techs: 'the assigned technician(s)',
  assigned_team: 'the assigned team',
  dispatcher: 'the dispatcher',
  salesperson: 'the salesperson',
  creator: 'the creator',
  all_admins: 'all admins',
  all_dispatchers: 'all dispatchers',
  specific_user: 'a team member',
  custom: 'a custom email address',
  removed_user: 'the removed team member',
  assigned_user: 'the assigned team member',
  // Spec B. A missing entry here reads as the '?? the recipient' fallback below, which is
  // not a compile error and not a failing test - it just quietly turns "emails the
  // assignees" into "emails the recipient".
  assignees: 'the assignees',
  watchers: 'the watchers',
};

/** Natural-conjunction join: 1 → "a"; 2 → "a and b"; 3+ → "a, b, and c" (Oxford comma). */
function joinWithAnd(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? 'the recipient';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/**
 * The full recipient list for a messaging step, joined in plain English: reads
 * the v2.1 `config.recipients` array, falling back to the legacy singular
 * `config.recipient` when only that's present (pre-multi-select workflows).
 */
function recipientsLabel(config: Record<string, unknown>): string {
  const keys = Array.isArray(config.recipients)
    ? config.recipients.filter((r): r is string => typeof r === 'string')
    : typeof config.recipient === 'string'
      ? [config.recipient]
      : [];
  if (keys.length === 0) return 'the recipient';
  return joinWithAnd(keys.map((key) => RECIPIENT_LABELS[key] ?? 'the recipient'));
}

// ── trigger clause ───────────────────────────────────────────────────────────

/** Event-trigger "When …" phrasing — indefinite articles, matches the mockup. */
const EVENT_PHRASES: Partial<Record<AutomationTriggerType, string>> = {
  JOB_SCHEDULED: 'a job is scheduled',
  JOB_RESCHEDULED: 'a job is rescheduled',
  TECH_ASSIGNED: 'a technician is assigned',
  JOB_COMPLETED: 'a job is completed',
  JOB_CANCELLED: 'a job is cancelled',
  ESTIMATE_SENT: 'an estimate is sent',
  ESTIMATE_APPROVED: 'an estimate is approved',
  ESTIMATE_DECLINED: 'an estimate is declined',
  INVOICE_SENT: 'an invoice is sent',
  INVOICE_PAID: 'an invoice is paid',
  LEAD_CREATED: 'a lead is created',
  LEAD_ASSIGNED: 'a lead is assigned',
  WALKTHROUGH_SCHEDULED: 'a walkthrough is scheduled',
  WALKTHROUGH_RESCHEDULED: 'a walkthrough is rescheduled',
  WALKTHROUGH_COMPLETED: 'a walkthrough is completed',
  WALKTHROUGH_CANCELLED: 'a walkthrough is cancelled',
  WALKTHROUGH_PERFORMER_ASSIGNED: 'a walkthrough performer is assigned',
  WALKTHROUGH_PERFORMER_REMOVED: 'a walkthrough performer is removed',
  TECH_UNASSIGNED: 'a technician is unassigned',
  JOB_EN_ROUTE: 'a technician is on the way',
};

/** Timed-trigger phrasing — offset prefix, no "When". */
const TIMED_PHRASE: Partial<Record<AutomationTriggerType, (offset: string) => string>> = {
  BEFORE_JOB_START: (offset) => `${offset} before a job starts`,
  AFTER_JOB_COMPLETED: (offset) => `${offset} after a job is completed`,
  INVOICE_OVERDUE: (offset) => `${offset} after an invoice is due and unpaid`,
  ESTIMATE_FOLLOW_UP: (offset) => `${offset} after an estimate is sent`,
};

/**
 * The date-anchored trigger types, one per entity (mirrors triggerModel.ts's
 * DATE_ANCHORED_BY_SUBJECT).
 *
 * Hand-written, like this file's RECIPIENT_LABELS, and silent when it drifts: a missing member
 * falls through to the generic clause and the admin's list of automations shows the raw enum
 * value ("When TASK_DATE_ANCHORED") instead of a sentence.
 */
const DATE_ANCHORED_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'JOB_DATE_ANCHORED',
  'LEAD_DATE_ANCHORED',
  'INVOICE_DATE_ANCHORED',
  'ESTIMATE_DATE_ANCHORED',
  // Spec B slice 5. One trigger, both directions - "1 day before the task due date" and
  // "3 days after the task due date" both come out of this one entry.
  'TASK_DATE_ANCHORED',
]);

/** Narrows a trigger_config to the anchored shape (mirrors triggerModel.ts's private isDateAnchorConfig — not exported there, so re-declared here per this file's own established duplication precedent, see RECIPIENT_LABELS above / stepSentence.ts's mirrored copy). */
function isDateAnchorConfig(config: TriggerConfig | null | undefined): config is DateAnchorTriggerConfig {
  return config != null && 'anchor' in config;
}

/** The legacy timed triggers' bare-offset shape — narrows away SubStatusTriggerConfig's
 *  `sub_status_id`-only shape, which has no `offset_minutes` field at all. */
function isOffsetConfig(config: TriggerConfig | null | undefined): config is { offset_minutes: number } {
  return config != null && 'offset_minutes' in config;
}

function triggerClause(
  trigger_type: AutomationTriggerType,
  trigger_config: TriggerConfig | null | undefined,
  catalog: WorkflowCatalog | undefined,
): string {
  if (DATE_ANCHORED_TRIGGERS.has(trigger_type) && isDateAnchorConfig(trigger_config)) {
    const label = anchorLabel(catalog, trigger_config.anchor);
    if (label) {
      // Offset-first, no "When" prefix — matches TIMED_PHRASE's convention
      // (the legacy triggers this supersedes) rather than TriggerReadback's
      // bespoke 0/1-day special phrasing ("Just before…"/"The day before…"):
      // every other trigger clause in this file is built from plain
      // formatOffset(), and this one follows the same house style rather than
      // reimplementing TriggerReadback's mockup-verbatim wording a third time.
      return `${formatOffset(trigger_config.offset_minutes)} ${trigger_config.direction} ${label}`;
    }
    // Anchor not resolvable (catalog still loading, or an anchor key the
    // catalog doesn't currently serve) — fall through to the generic
    // catalog-label/raw-type fallback below rather than crash.
  }
  const timedPhrase = TIMED_PHRASE[trigger_type];
  if (timedPhrase && isOffsetConfig(trigger_config) && trigger_config.offset_minutes) {
    return timedPhrase(formatOffset(trigger_config.offset_minutes));
  }
  const phrase =
    EVENT_PHRASES[trigger_type] ?? catalog?.triggers[trigger_type]?.label.toLowerCase() ?? trigger_type;
  return `When ${phrase}`;
}

// ── step clause ──────────────────────────────────────────────────────────────

/**
 * An anchor's plain-English label, sourced from the catalog (`anchors` is
 * keyed by entity; an AnchorKey belongs to exactly one entity, so a linear
 * search across the four short per-entity arrays finds at most one match).
 * Replaces the old hand-synced `ANCHOR_LABELS` map — undefined until the
 * catalog has loaded, or if the key isn't one the catalog serves.
 */
export function anchorLabel(catalog: WorkflowCatalog | undefined, anchor: AnchorKey): string | undefined {
  if (!catalog) return undefined;
  for (const options of Object.values(catalog.anchors)) {
    const match = options.find((option) => option.key === anchor);
    if (match) return match.label;
  }
  return undefined;
}

/** "wait until 1 day before the walkthrough" — an anchored WAIT's config, or null if unset/incomplete. */
function anchoredWaitClause(config: Record<string, unknown>, catalog: WorkflowCatalog | undefined): string | null {
  const anchor = config.anchor as AnchorKey | undefined;
  const direction = config.direction as string | undefined;
  const offset = Number(config.offset_minutes);
  const label = anchor && anchorLabel(catalog, anchor);
  if (!anchor || !label || !direction || !Number.isFinite(offset) || offset < 0) return null;
  return `wait until ${formatOffset(offset)} ${direction} ${label}`;
}

function stepClause(
  step: { step_type: WorkflowStepType; config: Record<string, unknown> },
  catalog: WorkflowCatalog | undefined,
): string {
  switch (step.step_type) {
    case 'WAIT': {
      if (step.config.mode === 'anchored') {
        return anchoredWaitClause(step.config, catalog) ?? 'wait';
      }
      const minutes = Number(step.config.duration_minutes);
      return Number.isFinite(minutes) && minutes > 0 ? `wait ${formatOffset(minutes)}` : 'wait';
    }
    case 'SEND_TEXT':
      return `text ${recipientsLabel(step.config)}`;
    case 'SEND_EMAIL':
      return `email ${recipientsLabel(step.config)}`;
    case 'NOTIFY_TEAM':
      return `notify ${recipientsLabel(step.config)}`;
    case 'STOP_IF': {
      const condition = String(step.config.condition ?? '');
      const label = catalog?.stop_if.labels[condition] ?? condition.replace(/_/g, ' ');
      return `stop if ${label || 'a condition is met'}`;
    }
    default:
      return '';
  }
}

// ── the recipe sentence ──────────────────────────────────────────────────────

/**
 * The recipe sentence for a workflow: "When a job is completed → wait 1 day →
 * text the customer → stop if the invoice is paid". Pure — no I/O.
 */
export function describeWorkflow(
  trigger_type: AutomationTriggerType,
  trigger_config: TriggerConfig | null | undefined,
  steps: Array<{ step_type: WorkflowStepType; config: Record<string, unknown> }>,
  catalog: WorkflowCatalog | undefined,
): string {
  const parts = [triggerClause(trigger_type, trigger_config, catalog)];
  for (const step of steps) {
    const clause = stepClause(step, catalog);
    if (clause) parts.push(clause);
  }
  return parts.join(' → ');
}

// ── template → workflow folding ──────────────────────────────────────────────

/**
 * Which step "Use this" installs for a template's action. The values are the
 * AUTHORABLE step types, so this fold cannot mint a step the write API rejects:
 * naming a retired one here is a compile error. PARTIAL because the action
 * type is still the wider stored enum: an action with no authorable step type
 * installs no step at all (see singleStepFromAction).
 */
const STEP_TYPE_FOR_ACTION: Partial<Record<AutomationTemplate['action_type'], AuthorableStepType>> = {
  SEND_SMS: 'SEND_TEXT',
  SEND_EMAIL: 'SEND_EMAIL',
};

/**
 * Fold a catalog template into a `createWorkflow` request body. When the
 * template carries an explicit `steps` sequence (e.g. an anchored WAIT before
 * a SEND_EMAIL), those steps are used verbatim. Otherwise it falls back to a
 * single step built from the template's `action_type`/`action_config`, with
 * each step's config assembled narrowly per the backend's strict per-step
 * schema (workflowValidation.ts) rather than spread wholesale from
 * `action_config`, so a stray key (e.g. a `subject` that only makes sense on
 * SEND_EMAIL) never trips a 400 on create. Timed follow-up templates stay
 * single-step — no stop-if is auto-inserted.
 */
export function templateToWorkflowBody(template: AutomationTemplate): WorkflowInput {
  const steps: WorkflowStepInput[] = template.steps
    ? template.steps.map(({ step_type, config }) => ({ step_type, config }))
    : singleStepFromAction(template);

  return {
    name: template.name,
    trigger_type: template.trigger_type,
    trigger_config: template.trigger_config ?? null,
    template_key: template.key,
    steps,
  };
}

/**
 * Folds a template's single `action_type`/`action_config` into one step - or
 * into NO step, when the action has no authorable step type. Returning an empty
 * list rather than a step is what keeps "Use this" from installing something
 * the write API would reject.
 */
function singleStepFromAction(template: AutomationTemplate): WorkflowStepInput[] {
  const step_type = STEP_TYPE_FOR_ACTION[template.action_type];
  if (!step_type) return [];

  const { recipient, body, subject, custom_email } = template.action_config;
  const config: Record<string, unknown> =
    step_type === 'SEND_EMAIL'
      ? { recipient, subject: subject ?? '', body, ...(custom_email ? { custom_email } : {}) }
      : { recipient, body };

  return [{ step_type, config }];
}
