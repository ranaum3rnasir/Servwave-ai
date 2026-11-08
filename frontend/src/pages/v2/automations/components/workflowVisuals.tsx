import { Zap, Clock, MessageSquare, Mail, Bell, OctagonPause, Wallet, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { cn } from '@/ui-kit/lib/utils';
import { STATUS_REGISTRY, type StatusIntent } from '@/design-system/status-registry';
import { workflowDisplayStatus } from '@/components/workflows/workflow-visuals';
import type { AutomationTemplate, WorkflowStatus, WorkflowStepType } from '@/lib/api/workflows';

/**
 * The module's shared visual vocabulary on the kit: step-type icon tiles, the
 * mini flow trail, template-category meta and the workflow status chip.
 *
 * `workflowDisplayStatus` is imported from the legacy file rather than copied.
 * It is the derivation that collapses `status` + `is_enabled` into
 * DRAFT/LIVE/PAUSED, it is domain logic, and forking it would give the app two
 * answers to what "live" means. Only the painting moved.
 *
 * `STEP_TYPE_META`'s LABELS are load-bearing beyond the tile: the step node's
 * drag handle names itself `Reorder step {n}: {label}` and the drawer's kicker
 * reads the same field, both of which the existing specs query by accessible
 * name. The labels below are byte-identical to the legacy map; only the colour
 * classes moved onto kit tokens.
 */

interface StepVisual {
  icon: LucideIcon;
  label: string;
  tile: string;
}

export const TRIGGER_VISUAL: StepVisual = {
  icon: Zap,
  label: 'Trigger',
  tile: 'bg-brand-subtle text-brand-emphasis',
};

// Storage-keyed on purpose. The retired in-app step (docs/adr/0005) keeps its
// icon and label here so a run recorded before the retirement still renders as
// something an admin can read.
export const STEP_TYPE_META: Record<WorkflowStepType, StepVisual> = {
  WAIT: { icon: Clock, label: 'Wait', tile: 'bg-muted text-muted-foreground' },
  SEND_TEXT: { icon: MessageSquare, label: 'Text', tile: 'bg-brand-subtle text-brand-emphasis' },
  SEND_EMAIL: { icon: Mail, label: 'Email', tile: 'bg-brand-subtle text-brand-emphasis' },
  NOTIFY_TEAM: { icon: Bell, label: 'Notify', tile: 'bg-brand-subtle text-brand-emphasis' },
  // Amber guard look. A stop-if is a checkpoint, not a message.
  STOP_IF: { icon: OctagonPause, label: 'Stop if', tile: 'bg-status-amber-subtle text-status-amber-emphasis' },
};

/** Icon tile for a step type, or the pseudo-type `TRIGGER`. */
export function StepTypeTile({
  type,
  size = 'md',
}: {
  type: WorkflowStepType | 'TRIGGER';
  size?: 'sm' | 'md' | 'lg';
}) {
  const meta = type === 'TRIGGER' ? TRIGGER_VISUAL : STEP_TYPE_META[type];
  const Icon = meta.icon;
  const box = size === 'lg' ? 'size-11' : size === 'sm' ? 'size-8' : 'size-10';
  const glyph = size === 'lg' ? 'size-5' : size === 'sm' ? 'size-4' : 'size-[18px]';
  return (
    <div className={cn('flex shrink-0 items-center justify-center rounded-md', box, meta.tile)} title={meta.label}>
      <Icon className={glyph} aria-hidden />
    </div>
  );
}

/**
 * Trigger tile, then one tile per step in order, joined by hairlines. Purely
 * decorative: the adjacent row title carries the same information as text, so
 * the whole trail is hidden from assistive tech.
 */
export function FlowTrail({ steps }: { steps: Array<{ step_type: WorkflowStepType }> }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      <StepTypeTile type="TRIGGER" size="sm" />
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="bg-border h-px w-2 shrink-0" />
          <StepTypeTile type={step.step_type} size="sm" />
        </div>
      ))}
    </div>
  );
}

export const CATEGORY_META: Record<
  AutomationTemplate['category'],
  { title: string; blurb: string; icon: LucideIcon; tile: string }
> = {
  customer: {
    title: 'Customer communication',
    blurb: 'Reminders, confirmations and follow-ups that reach clients automatically.',
    icon: MessageSquare,
    tile: 'bg-brand-subtle text-brand-emphasis',
  },
  money: {
    title: 'Getting paid',
    blurb: 'Nudge overdue invoices and thank customers the moment they pay.',
    icon: Wallet,
    tile: 'bg-status-green-subtle text-status-green-emphasis',
  },
  team: {
    title: 'Team coordination',
    blurb: 'Keep techs and the office in the loop the instant something happens.',
    icon: Users,
    tile: 'bg-brand-subtle text-brand-emphasis',
  },
};

export const CATEGORY_ORDER: AutomationTemplate['category'][] = ['customer', 'money', 'team'];

/** Registry intent to kit Badge variant. Same mapping every other v2 module uses. */
const SOLID_VARIANT: Record<StatusIntent, 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple'> = {
  success: 'green',
  warning: 'amber',
  danger: 'red',
  info: 'blue',
  neutral: 'slate',
  brand: 'purple',
};

/**
 * DRAFT / LIVE / PAUSED. Both neutral states resolve to the same registry
 * intent, so PAUSED is painted amber to keep "published but switched off"
 * distinguishable from "never published" at a glance. The v2 layer decides only
 * how a state is painted, never what it means; the same carve-out the leads and
 * tasks modules document.
 */
const WORKFLOW_VARIANT: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple'> = {
  DRAFT: 'slate',
  LIVE: 'green',
  PAUSED: 'amber',
};

export function WorkflowStatusChip({ status, is_enabled }: { status: WorkflowStatus; is_enabled: boolean }) {
  const display = workflowDisplayStatus({ status, is_enabled });
  const entry = STATUS_REGISTRY.workflow[display] ?? { label: display, intent: 'neutral' as const };
  const Icon = entry.icon;
  return (
    <Badge variant={WORKFLOW_VARIANT[display] ?? SOLID_VARIANT[entry.intent]} size="sm">
      {Icon && <Icon aria-hidden />}
      {entry.label}
    </Badge>
  );
}

/** Activity-feed row status. Icon plus label, never colour alone. */
export function WorkflowStepStatusChip({ status }: { status: string }) {
  const entry = STATUS_REGISTRY.workflowStep[status] ?? { label: status, intent: 'neutral' as const };
  const Icon = entry.icon;
  return (
    <Badge variant={SOLID_VARIANT[entry.intent]} size="sm">
      {Icon && <Icon aria-hidden />}
      {entry.label}
    </Badge>
  );
}
