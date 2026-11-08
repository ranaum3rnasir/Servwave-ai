/**
 * TriggerForm — the drawer body in trigger mode. Composes the two-mode
 * trigger builder (Tasks B1-B6: SubjectPicker → ModeFork →
 * EventModePanel/DateModePanel → TriggerReadback) into the surface that used
 * to hold a single flat trigger dropdown, plus the amber heads-up shown once
 * the workflow already has steps (changing the trigger can invalidate their
 * recipients or merge fields — the server re-flags anything affected).
 *
 * Local state shape: unlike `TriggerSelection` (triggerModel.ts), whose
 * `subject`/`mode` are both REQUIRED (a selection literally can't exist
 * without both), this component's own `LocalSelection` lets each start out
 * `null` — that's what represents "still on the subject/mode picker" before
 * a `TriggerSelection` exists to hand to the built components at all. Once
 * both are chosen, `toTriggerSelection` narrows it into a real
 * `TriggerSelection` for `EventModePanel`/`DateModePanel`/`TriggerReadback`
 * and for `selectionToTrigger`. Mode-specific fields (`eventTrigger`,
 * `anchor`/`direction`/`offsetMinutes`) are never cleared on a mode toggle —
 * only `pickSubject` starts a fully fresh object — so switching from event to
 * date and back never loses a half-finished pick (mirrors the approved
 * mockup's own "switch mode without losing work" legend item).
 *
 * Seeding: the saved trigger is converted to a `TriggerSelection` via
 * `triggerToSelection` once the catalog is available (it may still be
 * loading on mount — a `useEffect` + one-shot ref re-checks rather than a
 * lazy `useState` initializer, which would freeze at "blank" forever if
 * catalog was undefined on the very first render). It never re-seeds after
 * that first successful pass, so a prop echoing back the office's own
 * just-completed pick can't clobber their in-progress state.
 *
 * Legacy-trigger fallback (the trickiest call in this task — see the task
 * report for the full write-up): a saved trigger_type/trigger_config pair
 * that doesn't cleanly map into the two-mode shape — in practice, one of the
 * four pre-Part-A legacy timed triggers (BEFORE_JOB_START,
 * AFTER_JOB_COMPLETED, INVOICE_OVERDUE, ESTIMATE_FOLLOW_UP), which carry a
 * bare `{ offset_minutes }` with no anchor/direction/eventTrigger field to
 * live in — makes `triggerToSelection` return null. Rather than silently
 * showing a blank picker (which would misrepresent "nothing is configured"
 * when something real and functioning IS live), an honest banner names the
 * CURRENT trigger (read straight from the catalog) before falling through to
 * a fresh SubjectPicker. Nothing about the saved automation changes until the
 * office completes a whole new pick through the builder — closing the drawer
 * without touching it leaves the legacy trigger exactly as it was.
 *
 * The per-automation "When can it send?" control is gone from the product
 * entirely — this surface, the Settings tab, and `SendWindowToggle.tsx` all
 * dropped it. It was originally going to move to one global Automation
 * preferences setting, and a footnote here said so; that setting was cancelled,
 * so the footnote went too rather than promise a screen that will never exist.
 * Automations now send when their timing says they send, full stop.
 *
 * Quiet hours must return as ONE org-level setting before SMS unlocks (#743) —
 * a 2am email is harmless, a 2am text is not.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Briefcase, CalendarClock, ChevronDown, ClipboardList, FileText, Info, Receipt, UserPlus, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import SubjectPicker from './trigger/SubjectPicker';
import ModeFork from './trigger/ModeFork';
import EventModePanel from './trigger/EventModePanel';
import DateModePanel from './trigger/DateModePanel';
import SubStatusPicker from './trigger/SubStatusPicker';
import TriggerReadback from './trigger/TriggerReadback';
import {
  selectionToTrigger,
  triggerToSelection,
  type BuilderMode,
  type BuilderSubject,
  type TriggerConfig,
  type TriggerSelection,
} from '@/lib/workflows/triggerModel';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

const SUBJECT_META: Record<BuilderSubject, { label: string; icon: LucideIcon }> = {
  job: { label: 'Jobs', icon: Briefcase },
  estimate: { label: 'Estimates', icon: FileText },
  invoice: { label: 'Invoices', icon: Receipt },
  // Deliberately the shorter "Leads" (not SubjectPicker's tile label "Leads &
  // Walkthroughs") — SubjectPicker.tsx's own docblock calls out that this
  // component keeps its own shorter breadcrumb label on purpose.
  lead: { label: 'Leads', icon: UserPlus },
  task: { label: 'Tasks', icon: ClipboardList },
};

const MODE_META: Record<BuilderMode, { label: string; icon: LucideIcon }> = {
  event: { label: 'Right after something happens', icon: Zap },
  date: { label: 'Before or after a date', icon: CalendarClock },
};

/** The builder's own in-progress selection — see docblock above for why this
 *  differs from `TriggerSelection`. */
interface LocalSelection {
  subject: BuilderSubject | null;
  mode: BuilderMode | null;
  eventTrigger?: AutomationTriggerType;
  anchor?: TriggerSelection['anchor'];
  direction?: TriggerSelection['direction'];
  offsetMinutes?: number;
  subStatusId?: string;
}

const BLANK: LocalSelection = { subject: null, mode: null };

/** Narrows to a real `TriggerSelection` once both subject and mode are chosen; null otherwise. */
function toTriggerSelection(local: LocalSelection): TriggerSelection | null {
  if (local.subject === null || local.mode === null) return null;
  return {
    subject: local.subject,
    mode: local.mode,
    eventTrigger: local.eventTrigger,
    anchor: local.anchor,
    direction: local.direction,
    offsetMinutes: local.offsetMinutes,
    subStatusId: local.subStatusId,
  };
}

/** A breadcrumb chip — click to jump back to that stage. Icon + label make up the accessible name. */
function CrumbChip({
  icon: Icon,
  label,
  trailingIcon: Trailing,
  onClick,
  ariaLabel,
}: {
  icon: LucideIcon;
  label: string;
  trailingIcon: LucideIcon;
  onClick: () => void;
  ariaLabel: string;
}) {
  // Deferred: a breadcrumb chip (icon + label + trailing icon, bg-primary-subtle)
  // - chip/pill pattern, not Button vocabulary; no cell matches this look.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1.5 rounded border border-border bg-primary-subtle px-2.5 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary-subtle/70"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
      <Trailing className="h-3 w-3 opacity-60" aria-hidden />
    </button>
  );
}

export interface TriggerFormProps {
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /** False only for a brand-new draft whose `triggerType` is still an unseen
   *  placeholder (see useWorkflowDraft's WorkflowDraftState docblock) — the
   *  office never chose it, so it must not seed the picker or trip the
   *  legacy-trigger banner. Defaults true: every other caller (editing a
   *  saved automation, real or legacy) is unaffected. */
  triggerConfigured?: boolean;
  stepCount: number;
  catalog?: WorkflowCatalog;
  onSetTrigger: (type: AutomationTriggerType, config: TriggerConfig | null) => void;
}

export default function TriggerForm({
  triggerType,
  triggerConfig,
  triggerConfigured = true,
  stepCount,
  catalog,
  onSetTrigger,
}: TriggerFormProps) {
  const [local, setLocal] = useState<LocalSelection>(BLANK);
  const seededRef = useRef(false);

  // Seed once the catalog resolves (it may still be loading at mount) — never
  // re-seeds after, so a prop merely echoing the office's own just-completed
  // pick can't clobber in-progress state on a later render. A never-configured
  // draft skips seeding entirely and starts at BLANK (the guided picker) —
  // seededRef still latches so a later real pick's own commit() (which sets
  // `local` directly) is never second-guessed by this effect re-running.
  useEffect(() => {
    if (seededRef.current || !catalog) return;
    seededRef.current = true;
    if (!triggerConfigured) return;
    const sel = triggerToSelection(triggerType, triggerConfig, catalog);
    if (sel) {
      setLocal({
        subject: sel.subject,
        mode: sel.mode,
        eventTrigger: sel.eventTrigger,
        anchor: sel.anchor,
        direction: sel.direction,
        offsetMinutes: sel.offsetMinutes,
        subStatusId: sel.subStatusId,
      });
    }
    // else: leave `local` at BLANK — a legacy/unmapped trigger falls through
    // to a fresh SubjectPicker (see the legacy-fallback banner below).
  }, [catalog, triggerType, triggerConfig, triggerConfigured]);

  if (!catalog) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  // Recomputed fresh every render (not memoized to the initial mount) so the
  // banner disappears the instant the office completes a new pick — that pick
  // flows back through `onSetTrigger` -> the parent's draft -> new
  // `triggerType`/`triggerConfig` props, which this line re-evaluates. Gated
  // on `triggerConfigured`: a brand-new draft's placeholder trigger_type is
  // "unmapped" in exactly the same technical sense as a real legacy trigger,
  // but it must never show a banner naming a setup the office never chose.
  const isLegacyTrigger = triggerConfigured && triggerToSelection(triggerType, triggerConfig, catalog) === null;
  const legacyLabel = catalog.triggers[triggerType]?.label ?? triggerType;

  function commit(next: LocalSelection) {
    setLocal(next);
    const sel = toTriggerSelection(next);
    if (!sel) return;
    const trig = selectionToTrigger(sel);
    if (trig) onSetTrigger(trig.trigger_type, trig.trigger_config);
  }

  function anchorFor(subject: BuilderSubject) {
    return catalog!.anchors[subject]?.[0];
  }

  function pickSubject(subject: BuilderSubject, presetTrigger?: AutomationTriggerType) {
    // Only an 'events'-category hit is an immediate, complete pick — a
    // 'timed' (legacy) or 'date'-category catalog match still lands the
    // office on this subject, but falls to the mode picker rather than
    // fabricating an event pick for a trigger EventModePanel would never
    // even list (SubjectPicker's own search has no category filter, so a
    // query can surface any of the three categories — see the task report).
    const isEventHit = presetTrigger !== undefined && catalog!.triggers[presetTrigger]?.category === 'events';
    commit(isEventHit ? { subject, mode: 'event', eventTrigger: presetTrigger } : { subject, mode: null });
  }

  function pickMode(mode: BuilderMode) {
    if (mode === 'date') {
      // DateModePanel has no notion of "which anchor" (there's exactly one
      // per subject) — this component owns that field. Preserve an existing
      // anchor if the office is toggling back into date mode after visiting
      // event mode (no-lost-work), otherwise seed it fresh.
      commit({ ...local, mode, anchor: local.anchor ?? anchorFor(local.subject as BuilderSubject)?.key });
    } else {
      commit({ ...local, mode });
    }
  }

  function pickEvent(t: AutomationTriggerType) {
    commit({ ...local, eventTrigger: t });
  }

  function pickDate(v: { direction: 'before' | 'after'; offsetMinutes: number }) {
    commit({ ...local, direction: v.direction, offsetMinutes: v.offsetMinutes });
  }

  function pickSubStatus(subStatusId: string) {
    commit({ ...local, subStatusId });
  }

  function resetSubject() {
    setLocal(BLANK);
  }

  function resetMode() {
    setLocal({ ...local, mode: null });
  }

  const { subject, mode } = local;
  const selection = toTriggerSelection(local);
  const subjectAnchorLabel = subject !== null ? (anchorFor(subject)?.label ?? null) : null;

  return (
    <div className="space-y-5">
      {isLegacyTrigger && (
        <div className="flex items-start gap-2.5 rounded bg-primary-subtle px-3 py-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs leading-relaxed text-text-secondary">
            This automation currently uses an older timing setup —{' '}
            <span className="font-semibold text-text-primary">{legacyLabel}</span>. Pick a new starting point below
            to replace it, or close this panel to leave it as-is.
          </p>
        </div>
      )}

      {stepCount > 0 && (
        <div className="flex items-start gap-2.5 rounded bg-warning/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-text-secondary">
            Changing the trigger can make steps invalid — we’ll flag anything that needs attention.
          </p>
        </div>
      )}

      {subject === null ? (
        <p className="text-xs font-semibold uppercase tracking-wide text-text-soft">Step 1 of 3 — choose a subject</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <CrumbChip
            icon={SUBJECT_META[subject].icon}
            label={SUBJECT_META[subject].label}
            trailingIcon={X}
            onClick={resetSubject}
            ariaLabel={`${SUBJECT_META[subject].label} — change subject`}
          />
          {mode !== null && (
            <>
              <span className="text-text-soft" aria-hidden>
                ›
              </span>
              <CrumbChip
                icon={MODE_META[mode].icon}
                label={MODE_META[mode].label}
                trailingIcon={ChevronDown}
                onClick={resetMode}
                ariaLabel={`${MODE_META[mode].label} — change mode`}
              />
            </>
          )}
        </div>
      )}

      {subject === null ? (
        <SubjectPicker catalog={catalog} onPick={pickSubject} />
      ) : mode === null ? (
        <ModeFork subject={subject} anchorLabel={subjectAnchorLabel} value={null} onPick={pickMode} />
      ) : (
        <>
          {mode === 'event' ? (
            <>
              <EventModePanel subject={subject} catalog={catalog} value={local.eventTrigger} onPick={pickEvent} />
              {local.eventTrigger === 'JOB_SUB_STATUS_ENTERED' && (
                <SubStatusPicker value={local.subStatusId} onPick={pickSubStatus} />
              )}
            </>
          ) : (
            <DateModePanel
              anchorLabel={subjectAnchorLabel ?? ''}
              // Estimates get before-only: "N after the estimate expiration" can
              // never fire (estimate-expiration.ts cancels the estimate at
              // valid_until, and the sweep only selects SENT/PENDING), so we don't
              // offer it. See #867/the plan's PART C note.
              allowAfter={subject !== 'estimate'}
              value={
                local.direction !== undefined && local.offsetMinutes !== undefined
                  ? { direction: local.direction, offsetMinutes: local.offsetMinutes }
                  : null
              }
              onChange={pickDate}
            />
          )}
          {selection && <TriggerReadback selection={selection} catalog={catalog} />}
        </>
      )}

    </div>
  );
}
