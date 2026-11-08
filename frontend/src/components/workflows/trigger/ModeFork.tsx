/**
 * ModeFork — Step 2 of the two-mode trigger builder ("How should it
 * start?"). Two cards: "Right after something happens" (event mode) vs.
 * "Before or after a date" (date mode). Mirrors md_files/specs/automations/
 * 2026-07-17-timing-builder/index.html's "STAGE 2: mode fork" screen —
 * heading, subheading, card titles, the date card's body copy, and the
 * locked-state copy are all verbatim from that approved mockup.
 *
 * One deliberate deviation, called out here rather than silently guessed:
 * the mockup's event-card body names a *sample* trigger for the current
 * subject (e.g. "...a jobs event like \"job is completed.\""), computed
 * client-side from that subject's full event list. This component's props
 * (`subject`, `anchorLabel`, `value`, `onPick` — no catalog/event list) have
 * no such sample available, so the body copy here uses only what `subject`
 * itself gives us (the entity noun) and drops the specific "like '...'"
 * example clause rather than inventing a fabricated one.
 *
 * The date card's lock state (`anchorLabel === null`) is unreachable today —
 * every subject has an anchor as of Part A (backend/src/services/automations
 * /anchors.ts) — kept only because the prop is typed nullable.
 */

import { Zap, CalendarClock } from 'lucide-react';
import type { BuilderSubject, BuilderMode } from '@/lib/workflows/triggerModel';

/** Singular, article-correct noun per subject — for the event card's "a/an ___ event" clause. */
const SUBJECT_NOUN: Record<BuilderSubject, string> = {
  job: 'a job',
  estimate: 'an estimate',
  invoice: 'an invoice',
  lead: 'a lead',
  task: 'a task',
};

export interface ModeForkProps {
  subject: BuilderSubject;
  anchorLabel: string | null;
  value: BuilderMode | null;
  onPick: (mode: BuilderMode) => void;
}

export default function ModeFork({ subject, anchorLabel, value, onPick }: ModeForkProps) {
  const dateDisabled = anchorLabel === null;

  return (
    <div>
      {/* Raw h3, deferred: text-[15px] has no matching Heading scale key, and
          font-extrabold has no matching Heading weight (semibold/bold only). */}
      <h3 className="text-[15px] font-extrabold tracking-tight text-text-primary">How should it start?</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-text-secondary">
        Two different jobs — pick the one that matches what you have in mind.
      </p>

      <div className="flex flex-col gap-2.5">
        {/* Deferred (both buttons in this file): a mode-choice card wraps
            rich multi-line content (icon tile, title, description) with an
            aria-pressed selected-ring state - a card/option-select control,
            not a CTA any Button cell is shaped for. */}
        <button
          type="button"
          onClick={() => onPick('event')}
          aria-pressed={value === 'event'}
          className={`flex items-start gap-3.5 rounded-card border bg-surface-light p-4 text-left transition-shadow ${
            value === 'event'
              ? 'border-primary ring-[3px] ring-primary-subtle'
              : 'border-border hover:border-primary-light hover:shadow-card'
          }`}
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-ic bg-primary text-on-fill">
            <Zap className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span>
            <span className="mb-0.5 block text-[14.5px] font-extrabold tracking-tight text-text-primary">
              Right after something happens
            </span>
            <span className="block text-[12.5px] text-text-secondary">
              React the moment {SUBJECT_NOUN[subject]} event occurs. You can add a short wait after.
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            if (!dateDisabled) onPick('date');
          }}
          disabled={dateDisabled}
          aria-pressed={value === 'date'}
          className={`flex items-start gap-3.5 rounded-card border p-4 text-left transition-shadow ${
            dateDisabled
              ? 'cursor-not-allowed border-border bg-background-light opacity-[.55]'
              : value === 'date'
                ? 'border-primary bg-surface-light ring-[3px] ring-primary-subtle'
                : 'border-border bg-surface-light hover:border-primary-light hover:shadow-card'
          }`}
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-ic bg-gradient-to-br from-primary-light to-primary-dark text-on-fill">
            <CalendarClock className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span>
            <span className="mb-0.5 block text-[14.5px] font-extrabold tracking-tight text-text-primary">
              Before or after a date
            </span>
            {dateDisabled ? (
              <span className="mt-1.5 block text-[11px] font-bold text-warning">
                This subject has no scheduled date to count from.
              </span>
            ) : (
              <span className="block text-[12.5px] text-text-secondary">
                Count from a date you know ahead of time — {anchorLabel} — and act a set time before or after it.
              </span>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
