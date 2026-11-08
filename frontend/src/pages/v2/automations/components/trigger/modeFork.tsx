import { Zap, CalendarClock } from 'lucide-react';

import { cn } from '@/ui-kit/lib/utils';
import type { BuilderSubject, BuilderMode } from '@/lib/workflows/triggerModel';

import { EM_DASH } from '../glyphs';
import { Pressable } from '../pressable';

/**
 * Step 2 of the two-mode trigger builder. Two cards: react to an event, or
 * count from a date.
 *
 * Two things here are dead code today and are carried over deliberately rather
 * than cleaned up, both recorded in the branch ledger:
 *  - the date card's locked state (`anchorLabel === null`) is unreachable,
 *    every subject has an anchor, and is kept only because the prop is typed
 *    nullable;
 *  - the selected ring never shows in the app, because triggerForm always
 *    passes `value={null}` and swaps the fork for the panel the moment a mode
 *    is picked. It is reachable from a unit test only.
 */

/** Singular, article-correct noun per subject, for the event card's clause. */
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
      <p className="text-[15px] font-extrabold tracking-tight">How should it start?</p>
      <p className="text-muted-foreground mb-3.5 mt-0.5 text-[12.5px]">
        {`Two different jobs ${EM_DASH} pick the one that matches what you have in mind.`}
      </p>

      <div className="flex flex-col gap-2.5">
        <Pressable
          onPress={() => onPick('event')}
          aria-pressed={value === 'event'}
          className={cn(
            'bg-kit-card flex items-start gap-3.5 rounded-lg border p-4 text-left transition-shadow',
            value === 'event'
              ? 'border-brand ring-brand-subtle ring-[3px]'
              : 'border-border hover:border-brand hover:shadow-xs',
          )}
        >
          <span className="bg-primary text-primary-foreground flex size-[38px] shrink-0 items-center justify-center rounded-md">
            <Zap className="size-[18px]" aria-hidden />
          </span>
          <span>
            <span className="mb-0.5 block text-[14.5px] font-extrabold tracking-tight">
              Right after something happens
            </span>
            <span className="text-muted-foreground block text-[12.5px]">
              React the moment {SUBJECT_NOUN[subject]} event occurs. You can add a short wait after.
            </span>
          </span>
        </Pressable>

        <Pressable
          onPress={() => {
            if (!dateDisabled) onPick('date');
          }}
          disabled={dateDisabled}
          aria-pressed={value === 'date'}
          className={cn(
            'flex items-start gap-3.5 rounded-lg border p-4 text-left transition-shadow',
            dateDisabled
              ? 'border-border bg-muted opacity-[.55]'
              : value === 'date'
                ? 'border-brand bg-kit-card ring-brand-subtle ring-[3px]'
                : 'border-border bg-kit-card hover:border-brand hover:shadow-xs',
          )}
        >
          <span className="from-brand to-primary text-primary-foreground flex size-[38px] shrink-0 items-center justify-center rounded-md bg-gradient-to-br">
            <CalendarClock className="size-[18px]" aria-hidden />
          </span>
          <span>
            <span className="mb-0.5 block text-[14.5px] font-extrabold tracking-tight">Before or after a date</span>
            {dateDisabled ? (
              <span className="text-status-amber-emphasis mt-1.5 block text-[11px] font-bold">
                This subject has no scheduled date to count from.
              </span>
            ) : (
              <span className="text-muted-foreground block text-[12.5px]">
                {`Count from a date you know ahead of time ${EM_DASH} ${anchorLabel} ${EM_DASH} and act a set time before or after it.`}
              </span>
            )}
          </span>
        </Pressable>
      </div>
    </div>
  );
}
