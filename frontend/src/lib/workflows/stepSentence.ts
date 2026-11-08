/**
 * stepSentence.ts — the per-bubble sentence fragment for a single workflow step
 * ("Wait **1 day**", "Text **the customer**", "Stop if **the invoice is paid**").
 *
 * Sibling of describeWorkflow.ts (which renders the WHOLE recipe as one plain
 * string). This one is bubble-scoped and returns STRUCTURED segments so the
 * StepNode can bold the config token (the value the drawer edits) while keeping
 * the verb muted. An unconfigured step reads the muted prompt "Set up this
 * step…" — the amber "needs setup" badge itself is driven separately by the
 * server's `issues`, never by this helper.
 */

import { formatOffset, anchorLabel } from './describeWorkflow';
import { isAuthorableStepType } from '@/lib/api/workflows';
import type { AnchorKey } from './anchors';
import type { WorkflowCatalog, WorkflowStepType } from '@/lib/api/workflows';

export interface SentenceSegment {
  text: string;
  /** Bold token — the config value the drawer edits. */
  strong?: boolean;
}

export interface StepSentence {
  configured: boolean;
  segments: SentenceSegment[];
}

/** Flatten a sentence to plain text (test + aria helper). */
export function sentenceText(sentence: StepSentence): string {
  return sentence.segments.map((s) => s.text).join('');
}

const UNCONFIGURED: StepSentence = { configured: false, segments: [{ text: 'Set up this step…' }] };

/** Recipient → plain label. Mirrors describeWorkflow's private RECIPIENT_LABELS. */
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
  // Spec B. Same fallback trap as describeWorkflow's copy: absent keys read as
  // 'the recipient' with nothing going red.
  //
  // `assigned_user` joined them in slice 2, which is the slice that first offers the key on a
  // TASK trigger. `removed_user` was the last key still missing here where describeWorkflow's
  // copy has it, and Spec C slice 8 closed that: a text step can now be addressed to the
  // person a job or walkthrough just lost, so the divergence had a visible bubble behind it.
  //
  // This map is now key-for-key with describeWorkflow's RECIPIENT_LABELS. Keep it that way -
  // the two render the same audience in the same words, one per bubble and one per recipe.
  assignees: 'the assignees',
  watchers: 'the watchers',
  assigned_user: 'the assigned team member',
  removed_user: 'the removed team member',
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
 * Mirrors describeWorkflow's private recipientsLabel.
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

function hasBody(config: Record<string, unknown>): boolean {
  return String(config.body ?? '').trim() !== '';
}

/**
 * The bubble sentence for a step. Pure — no I/O; `catalog` supplies the
 * stop-if condition labels (falls back to a de-underscored slug when absent)
 * and an anchored WAIT's anchor label (unconfigured until the catalog can
 * resolve one).
 */
export function stepSentence(
  step: { step_type: WorkflowStepType; config: Record<string, unknown> },
  catalog: WorkflowCatalog | undefined,
): StepSentence {
  const { config } = step;
  // The switch runs on the AUTHORABLE narrowing: the bubble is a builder
  // surface, so only a step an admin can still author gets a sentence. A stored
  // type that is no longer authorable reads as unconfigured (the config drawer
  // is what explains it), and re-adding a case for one is a compile error.
  switch (isAuthorableStepType(step.step_type) ? step.step_type : null) {
    case 'WAIT': {
      if (config.mode === 'anchored') {
        const anchor = config.anchor as AnchorKey | undefined;
        const direction = config.direction as string | undefined;
        const offset = Number(config.offset_minutes);
        const label = anchor && anchorLabel(catalog, anchor);
        if (!anchor || !label || !direction || !Number.isFinite(offset) || offset < 0) {
          return UNCONFIGURED;
        }
        return {
          configured: true,
          segments: [
            { text: 'Wait until ' },
            { text: `${formatOffset(offset)} ${direction} ${label}`, strong: true },
          ],
        };
      }
      const minutes = Number(config.duration_minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return UNCONFIGURED;
      return { configured: true, segments: [{ text: 'Wait ' }, { text: formatOffset(minutes), strong: true }] };
    }
    case 'SEND_TEXT':
      if (!hasBody(config)) return UNCONFIGURED;
      return { configured: true, segments: [{ text: 'Text ' }, { text: recipientsLabel(config), strong: true }] };
    case 'SEND_EMAIL':
      if (!hasBody(config)) return UNCONFIGURED;
      return { configured: true, segments: [{ text: 'Email ' }, { text: recipientsLabel(config), strong: true }] };
    case 'STOP_IF': {
      const condition = String(config.condition ?? '');
      if (!condition) return UNCONFIGURED;
      const label = catalog?.stop_if.labels[condition] ?? condition.replace(/_/g, ' ');
      return { configured: true, segments: [{ text: 'Stop if ' }, { text: label, strong: true }] };
    }
    default:
      return UNCONFIGURED;
  }
}
