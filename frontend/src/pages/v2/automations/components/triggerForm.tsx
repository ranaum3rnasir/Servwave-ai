import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  CalendarClock,
  ChevronDown,
  ClipboardList,
  FileText,
  Info,
  Receipt,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  selectionToTrigger,
  triggerToSelection,
  type BuilderMode,
  type BuilderSubject,
  type TriggerConfig,
  type TriggerSelection,
} from '@/lib/workflows/triggerModel';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import { anchorDirections, type AnchorKey, type WaitDirection } from '@/lib/workflows/anchors';

import { EM_DASH, RANGLE, RSQUO } from './glyphs';
import SubjectPicker from './trigger/subjectPicker';
import ModeFork from './trigger/modeFork';
import EventModePanel from './trigger/eventModePanel';
import AnchorPicker from './trigger/anchorPicker';
import DateModePanel from './trigger/dateModePanel';
import TriggerReadback from './trigger/triggerReadback';

/**
 * The drawer body in trigger mode: SubjectPicker, then ModeFork, then the
 * event or date panel, with the live readback below.
 *
 * No react-hook-form and no zod. The guard is the conversion itself: `commit`
 * narrows the local selection, converts it through `selectionToTrigger`, and
 * only calls `onSetTrigger` when that returns a value. An incomplete selection
 * never reaches the draft, and therefore never reaches the autosave.
 *
 * Seeding is a one-shot effect gated on `seededRef` AND on `catalog`. A lazy
 * `useState` initializer would freeze at "blank" forever if the catalog was
 * still loading on the very first render. It skips seeding entirely when
 * `triggerConfigured` is false but still latches the ref, so a later real pick
 * is never second-guessed.
 *
 * Mode-specific fields are never cleared on a mode toggle: only `pickSubject`
 * starts a fresh object, so switching event to date and back loses no work.
 */

const SUBJECT_META: Record<BuilderSubject, { label: string; icon: LucideIcon }> = {
  job: { label: 'Jobs', icon: Briefcase },
  estimate: { label: 'Estimates', icon: FileText },
  invoice: { label: 'Invoices', icon: Receipt },
  // Deliberately the shorter "Leads", not SubjectPicker's tile label
  // "Leads & Walkthroughs". Both legacy docblocks record the divergence as
  // intentional, and the builder spec queries this breadcrumb by name.
  lead: { label: 'Leads', icon: UserPlus },
  task: { label: 'Tasks', icon: ClipboardList },
};

const MODE_META: Record<BuilderMode, { label: string; icon: LucideIcon }> = {
  event: { label: 'Right after something happens', icon: Zap },
  date: { label: 'Before or after a date', icon: CalendarClock },
};

/** The builder's own in-progress selection; both fields may be null mid-flow. */
interface LocalSelection {
  subject: BuilderSubject | null;
  mode: BuilderMode | null;
  eventTrigger?: AutomationTriggerType;
  anchor?: TriggerSelection['anchor'];
  direction?: TriggerSelection['direction'];
  offsetMinutes?: number;
}

const BLANK: LocalSelection = { subject: null, mode: null };

/** Narrows to a real TriggerSelection once both subject and mode are chosen. */
function toTriggerSelection(local: LocalSelection): TriggerSelection | null {
  if (local.subject === null || local.mode === null) return null;
  return {
    subject: local.subject,
    mode: local.mode,
    eventTrigger: local.eventTrigger,
    anchor: local.anchor,
    direction: local.direction,
    offsetMinutes: local.offsetMinutes,
  };
}

/** A breadcrumb chip. Icon plus label make up the accessible name. */
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
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={ariaLabel}
      // hover:opacity-90 rather than an alpha modifier on the tint: an
      // alpha-suffixed custom colour does not resolve through this repo's
      // Tailwind config, and the unresolved-class guard would go red on it.
      className="bg-brand-subtle text-brand-emphasis gap-1.5 text-xs font-bold hover:opacity-90"
    >
      <Icon aria-hidden />
      {label}
      <Trailing className="opacity-60" aria-hidden />
    </Button>
  );
}

export interface TriggerFormProps {
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /**
   * False only for a brand-new draft whose `triggerType` is still an unseen
   * placeholder. The office never chose it, so it must not seed the picker or
   * trip the legacy-trigger banner. Defaults true.
   */
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

  useEffect(() => {
    if (seededRef.current || !catalog) return;
    seededRef.current = true;
    if (!triggerConfigured) return;
    const sel = triggerToSelection(triggerType, triggerConfig, catalog);
    if (sel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate seed-once idiom, gated by `seededRef` so an edit is never overwritten
      setLocal({
        subject: sel.subject,
        mode: sel.mode,
        eventTrigger: sel.eventTrigger,
        anchor: sel.anchor,
        direction: sel.direction,
        offsetMinutes: sel.offsetMinutes,
      });
    }
    // else: leave `local` at BLANK. A legacy or unmapped trigger falls through
    // to a fresh SubjectPicker behind the banner below.
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

  // Recomputed fresh every render, not memoized to the initial mount, so the
  // banner disappears the instant a new pick completes. Gated on
  // `triggerConfigured`: a brand-new draft's placeholder trigger is "unmapped"
  // in exactly the same technical sense, but must never show a banner naming a
  // setup the office never chose.
  const isLegacyTrigger = triggerConfigured && triggerToSelection(triggerType, triggerConfig, catalog) === null;
  const legacyLabel = catalog.triggers[triggerType]?.label ?? triggerType;

  function commit(next: LocalSelection) {
    setLocal(next);
    const sel = toTriggerSelection(next);
    if (!sel) return;
    const trig = selectionToTrigger(sel);
    if (trig) onSetTrigger(trig.trigger_type, trig.trigger_config);
  }

  function anchorsFor(subject: BuilderSubject) {
    return catalog!.anchors[subject] ?? [];
  }

  /** The anchor being counted from: the office's pick, else the subject's first. */
  function anchorFor(subject: BuilderSubject, anchor: AnchorKey | undefined = local.anchor) {
    const options = anchorsFor(subject);
    return options.find((option) => option.key === anchor) ?? options[0];
  }

  /**
   * The directions this anchor may run in. Two rules narrow it and they point opposite ways, so
   * both are applied here rather than either being pushed into the panel.
   *
   * The catalog carries the one the backend enforces: a lead stage clock records a moment as it
   * happens, so counting BEFORE one can never fire and the validator refuses to save it. The
   * estimate rule is the builder's own - "N after the estimate expiration" can never fire either,
   * because the expiry sweep cancels the estimate at `valid_until` and only selects SENT/PENDING
   * rows, but nothing server-side rejects it, so it is not the catalog's to claim.
   */
  function directionsFor(subject: BuilderSubject, anchor: AnchorKey | undefined = local.anchor): WaitDirection[] {
    const served = anchorDirections(anchorFor(subject, anchor));
    const narrowed = subject === 'estimate' ? served.filter((direction) => direction === 'before') : served;
    // Never empty. The estimate rule is a product judgement layered on top of the served set, and
    // if an estimate anchor ever arrives that is after-only the two would have no overlap at all -
    // a timing panel with no legal direction and therefore no presets. The served set wins there,
    // because it is the one the save actually enforces.
    return narrowed.length > 0 ? narrowed : served;
  }

  function pickSubject(subject: BuilderSubject, presetTrigger?: AutomationTriggerType) {
    // Only an `events`-category hit is an immediate, complete pick. A `timed`
    // or `date` match still lands the office on this subject but falls through
    // to the mode picker, rather than fabricating an event pick for a trigger
    // EventModePanel would never list.
    const isEventHit = presetTrigger !== undefined && catalog!.triggers[presetTrigger]?.category === 'events';
    commit(isEventHit ? { subject, mode: 'event', eventTrigger: presetTrigger } : { subject, mode: null });
  }

  function pickMode(mode: BuilderMode) {
    if (mode === 'date') {
      // DateModePanel has no notion of which anchor; there is exactly one per
      // subject and this component owns that field. Preserve an existing anchor
      // when toggling back into date mode after visiting event mode.
      commit({ ...local, mode, anchor: local.anchor ?? anchorFor(local.subject as BuilderSubject)?.key });
    } else {
      commit({ ...local, mode });
    }
  }

  function pickEvent(t: AutomationTriggerType) {
    commit({ ...local, eventTrigger: t });
  }

  function pickAnchor(key: AnchorKey) {
    const subject = local.subject as BuilderSubject;
    const allowed = directionsFor(subject, key);
    // The office can set "1 day before" against an anchor that allows it and then switch to one
    // that does not. Flip the direction rather than dropping the timing: the amount they typed is
    // still what they meant, and leaving an illegal direction in place would autosave into a 400.
    const direction =
      local.direction !== undefined && !allowed.includes(local.direction) ? allowed[0] : local.direction;
    commit({ ...local, anchor: key, direction });
  }

  function pickDate(v: { direction: 'before' | 'after'; offsetMinutes: number }) {
    commit({ ...local, direction: v.direction, offsetMinutes: v.offsetMinutes });
  }

  function resetSubject() {
    setLocal(BLANK);
  }

  function resetMode() {
    setLocal({ ...local, mode: null });
  }

  const { subject, mode } = local;
  const selection = toTriggerSelection(local);
  // Follows the SELECTED anchor, not the subject's first, so the timing panel's "How far from
  // X?" and the readback below it name the date actually being counted from.
  const subjectAnchorLabel = subject !== null ? (anchorFor(subject)?.label ?? null) : null;
  const anchorOptions = subject !== null ? anchorsFor(subject) : [];

  return (
    <div className="space-y-5">
      {isLegacyTrigger && (
        <div className="bg-brand-subtle flex items-start gap-2.5 rounded-md px-3 py-2.5">
          <Info className="text-brand mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="text-muted-foreground text-xs leading-relaxed">
            {`This automation currently uses an older timing setup ${EM_DASH} `}
            <span className="text-foreground font-semibold">{legacyLabel}</span>
            {'. Pick a new starting point below to replace it, or close this panel to leave it as-is.'}
          </p>
        </div>
      )}

      {stepCount > 0 && (
        <div className="bg-status-amber-subtle flex items-start gap-2.5 rounded-md px-3 py-2.5">
          <AlertTriangle className="text-status-amber-emphasis mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="text-muted-foreground text-xs leading-relaxed">
            {`Changing the trigger can make steps invalid ${EM_DASH} we${RSQUO}ll flag anything that needs attention.`}
          </p>
        </div>
      )}

      {subject === null ? (
        <p className="text-subtle-foreground text-xs font-semibold uppercase tracking-wide">
          {`Step 1 of 3 ${EM_DASH} choose a subject`}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <CrumbChip
            icon={SUBJECT_META[subject].icon}
            label={SUBJECT_META[subject].label}
            trailingIcon={X}
            onClick={resetSubject}
            ariaLabel={`${SUBJECT_META[subject].label} ${EM_DASH} change subject`}
          />
          {mode !== null && (
            <>
              <span className="text-subtle-foreground" aria-hidden>
                {RANGLE}
              </span>
              <CrumbChip
                icon={MODE_META[mode].icon}
                label={MODE_META[mode].label}
                trailingIcon={ChevronDown}
                onClick={resetMode}
                ariaLabel={`${MODE_META[mode].label} ${EM_DASH} change mode`}
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
            <EventModePanel subject={subject} catalog={catalog} value={local.eventTrigger} onPick={pickEvent} />
          ) : (
            <div className="space-y-5">
              {anchorOptions.length > 1 && (
                <AnchorPicker options={anchorOptions} value={local.anchor} onPick={pickAnchor} />
              )}
              <DateModePanel
                anchorLabel={subjectAnchorLabel ?? ''}
                allowedDirections={directionsFor(subject)}
                value={
                  local.direction !== undefined && local.offsetMinutes !== undefined
                    ? { direction: local.direction, offsetMinutes: local.offsetMinutes }
                    : null
                }
                onChange={pickDate}
              />
            </div>
          )}
          {selection && <TriggerReadback selection={selection} catalog={catalog} />}
        </>
      )}
    </div>
  );
}
