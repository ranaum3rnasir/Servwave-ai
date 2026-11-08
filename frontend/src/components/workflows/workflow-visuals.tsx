/**
 * workflow-visuals.tsx — the shared visual vocabulary for the new Workflow
 * Builder surface: step-type icon tiles (+ the trigger tile), the mini flow
 * trail (trigger → step icons in order), template-category meta, and the
 * workflow status pill.
 *
 * COPY+ADAPT of `components/automations/automation-visuals.tsx` for the new
 * multi-step step types — deliberately NOT imported from that legacy tree
 * (deleted whole in Task 15). All colors resolve to ServWave semantic tokens;
 * status/step identity is always icon + shape + label, never color alone.
 *
 * Note: `rounded-control` is NOT a registered Tailwind utility in this repo
 * (checked tailwind.config.js — no `control` key under `borderRadius`, only
 * `DEFAULT`/`sm` map to `--radius-control`). The legacy file's use of that
 * class is a pre-existing no-op; this file uses the bare `rounded` utility
 * (which DOES resolve to the 6px control radius) wherever a control needs it.
 */

import {
  Zap,
  Clock,
  MessageSquare,
  Mail,
  Bell,
  OctagonPause,
  Wallet,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AutomationTemplate, WorkflowStatus, WorkflowStepType } from '@/lib/api/workflows';
import { StatusBadge } from '@/components/data/status-badge';

// ── step-type + trigger tiles ────────────────────────────────────────────────

type StepVisual = { icon: LucideIcon; label: string; tileBg: string; tileText: string };

export const TRIGGER_VISUAL: StepVisual = {
  icon: Zap,
  label: 'Trigger',
  tileBg: 'bg-primary-subtle',
  tileText: 'text-primary',
};

// Storage-keyed on purpose. The retired in-app step (docs/adr/0005) keeps its
// icon and label here so a run recorded before the retirement still renders as
// something an admin can read.
export const STEP_TYPE_META: Record<WorkflowStepType, StepVisual> = {
  WAIT: { icon: Clock, label: 'Wait', tileBg: 'bg-background-light', tileText: 'text-text-secondary' },
  SEND_TEXT: { icon: MessageSquare, label: 'Text', tileBg: 'bg-primary-subtle', tileText: 'text-primary' },
  SEND_EMAIL: { icon: Mail, label: 'Email', tileBg: 'bg-primary-subtle', tileText: 'text-primary' },
  NOTIFY_TEAM: { icon: Bell, label: 'Notify', tileBg: 'bg-primary-subtle', tileText: 'text-primary' },
  // Amber-tinted guard look — a stop-if is a checkpoint, not a message.
  STOP_IF: { icon: OctagonPause, label: 'Stop if', tileBg: 'bg-warning/10', tileText: 'text-warning' },
};

/** Icon tile for a step type (or the pseudo-type 'TRIGGER') — sized sm|md|lg. */
export function StepTypeTile({
  type,
  size = 'md',
}: {
  type: WorkflowStepType | 'TRIGGER';
  size?: 'sm' | 'md' | 'lg';
}) {
  const meta = type === 'TRIGGER' ? TRIGGER_VISUAL : STEP_TYPE_META[type];
  const Icon = meta.icon;
  const box = size === 'lg' ? 'h-11 w-11' : size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const ic = size === 'lg' ? 'h-5 w-5' : size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]';
  return (
    <div
      className={`flex ${box} shrink-0 items-center justify-center rounded-ic ${meta.tileBg}`}
      title={meta.label}
    >
      <Icon className={`${ic} ${meta.tileText}`} aria-hidden />
    </div>
  );
}

/**
 * The mini flow trail — trigger tile, then one tile per step in order,
 * connected by thin rail segments. Purely decorative (icon + shape only; the
 * adjacent row title carries the label), used in the "My automations" list
 * and the template gallery cards.
 */
export function FlowTrail({ steps }: { steps: Array<{ step_type: WorkflowStepType }> }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      <StepTypeTile type="TRIGGER" size="sm" />
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="h-px w-2 shrink-0 bg-border" />
          <StepTypeTile type={step.step_type} size="sm" />
        </div>
      ))}
    </div>
  );
}

// ── template categories ─────────────────────────────────────────────────────

export const CATEGORY_META: Record<
  AutomationTemplate['category'],
  { title: string; blurb: string; icon: LucideIcon; tileBg: string; tileText: string }
> = {
  customer: {
    title: 'Customer communication',
    blurb: 'Reminders, confirmations and follow-ups that reach clients automatically.',
    icon: MessageSquare,
    tileBg: 'bg-primary-subtle',
    tileText: 'text-primary',
  },
  money: {
    title: 'Getting paid',
    blurb: 'Nudge overdue invoices and thank customers the moment they pay.',
    icon: Wallet,
    tileBg: 'bg-success/10',
    tileText: 'text-success',
  },
  team: {
    title: 'Team coordination',
    blurb: 'Keep techs and the office in the loop the instant something happens.',
    icon: Users,
    tileBg: 'bg-primary-subtle',
    tileText: 'text-primary',
  },
};

export const CATEGORY_ORDER: AutomationTemplate['category'][] = ['customer', 'money', 'team'];

// ── workflow status pill ─────────────────────────────────────────────────────

export type WorkflowDisplayStatus = 'DRAFT' | 'LIVE' | 'PAUSED';

export function workflowDisplayStatus(w: { status: WorkflowStatus; is_enabled: boolean }): WorkflowDisplayStatus {
  if (w.status !== 'PUBLISHED') return 'DRAFT';
  return w.is_enabled ? 'LIVE' : 'PAUSED';
}

export function WorkflowStatusPill({ status, is_enabled }: { status: WorkflowStatus; is_enabled: boolean }) {
  return <StatusBadge domain="workflow" status={workflowDisplayStatus({ status, is_enabled })} />;
}
