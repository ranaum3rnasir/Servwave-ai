/**
 * TriggerReadback — the live plain-English summary that sits directly below
 * the two-mode trigger builder (SubjectPicker → ModeFork → EventModePanel/
 * DateModePanel). Always mounted while the builder is open and re-rendering
 * on every pick, so the user sees exactly what they're building as a single
 * flowing sentence — plus, for a `before` date selection only, the "what
 * happens at the edges" rule-1 note.
 *
 * Mirrors md_files/specs/automations/2026-07-17-timing-builder/index.html's
 * `renderReadback()` / `timingPhrase()` / `offsetChip()` / `articleize()` /
 * `plural()` functions (lines ~470-546) - the timing phrases, the 0/1-day
 * special cases, and the rule-1 note copy are sourced verbatim from there:
 *   - n===0            -> "Just before" / "Right after"
 *   - n===1 && days     -> "The day before" / "The day after"
 *   - everything else   -> "{N} {unit} before/after" - the unit is only
 *                         singularized when N===1 (e.g. "1 hour before", never
 *                         "1 hours"; a non-day unit never gets the "The day"
 *                         treatment even at N===1).
 *   - event mode        -> "The moment {article}{label lowercased}" where the
 *                         article ("a"/"an") is chosen from the label's first
 *                         word, exactly like the mockup's `articleize()`
 *                         ("Invoice is paid" -> "an invoice is paid").
 *
 * THE SENTENCE DESCRIBES THE TRIGGER AND NOTHING ELSE. Both the mockup and
 * this component used to finish every sentence with the hardcoded tail "send
 * the customer an email." That tail was false twice over, and both halves were
 * reachable on the same draft. It named an audience the trigger may not be
 * able to reach at all - a task trigger's legal audiences are staff only
 * (catalog.ts's ENTITIES_WITH_CUSTOMER excludes `task`), so "the customer" was
 * a recipient the office could not have picked even if they wanted to - and it
 * asserted an email step on a draft that may have no steps at all, or whose
 * first step is a text. The "what happens" half belongs to the step bubbles,
 * which render it per step from stepSentence.ts against the config the office
 * actually chose. This strip owns the "when" half only, and its eyebrow says
 * so.
 *
 * Two further deliberate deviations, flagged here rather than silently
 * guessed:
 * 1. Empty/incomplete-selection copy. `TriggerSelection.subject`/`.mode` are
 *    non-optional, so the mockup's "Pick a subject…" / "Choose how it should
 *    start…" placeholders can never occur through this component's actual
 *    prop contract (a `TriggerSelection` value literally cannot exist without
 *    both) — they're dropped. The mockup's event-mode "Pick the event that
 *    starts it." placeholder IS reachable here (`mode==='event'` with
 *    `eventTrigger` still undefined) and is reused verbatim. Date mode has no
 *    mockup equivalent for "mode chosen, timing not yet" (the mockup's local
 *    state always seeds a default timing the instant it enters date mode);
 *    reachable here because `anchor`/`direction`/`offsetMinutes` are
 *    independently-optional on `TriggerSelection`, so a small original
 *    placeholder in the same terse style ("Choose a timing to complete
 *    this.") is used instead of leaving the strip blank or fabricating a
 *    timing that was never chosen.
 * 2. Visual chrome. The mockup's `.readback` box is a two-stop CSS gradient
 *    (raw hex) with a raw-hex border — disallowed by the "never write a raw
 *    hex" design-system rule, and no gradient-from-tokens recipe exists
 *    anywhere in this component family to reach for instead. This uses a
 *    flat `bg-background-light` (canvas token) card, the same kind of
 *    simplification DateModePanel's own docblock already made for the
 *    mockup's pill-shaped segmented control. The sentence/emphasis styling
 *    otherwise mirrors WaitForm.tsx's pre-existing "Wait **X** before the
 *    next step." readback line (`rounded bg-background-light px-3 py-2
 *    text-sm font-medium text-text-primary` + a bold inline span) — the
 *    closest existing precedent in this codebase for "a computed
 *    plain-English timing summary" — rather than inventing new chrome.
 *
 * `role="status"` on the sentence paragraph (not present in the mockup) is
 * added because this strip is a live region by definition — its whole job is
 * to reflect every pick the user makes — so assistive tech gets the same
 * "here's what you just built" feedback sighted users get from watching the
 * text change. It also gives a single stable node to read `.textContent`
 * from in tests, despite the sentence being built from several inline spans
 * (so the highlighted token can be styled like the mockup's `.hl`
 * without fragmenting the byte-for-byte text assertions across nodes).
 */

import { Clock, Info } from 'lucide-react';
import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

export interface TriggerReadbackProps {
  selection: TriggerSelection;
  catalog: WorkflowCatalog;
}

/** Mirrors the mockup's `plural(n,u)` — singularizes the unit word only when n===1. */
function pluralizeUnit(n: number, unit: OffsetUnit): string {
  if (n === 1) return `1 ${unit.replace(/s$/, '')}`;
  return `${n} ${unit}`;
}

/**
 * The timing half of a date sentence ("The day before", "3 days after"), without
 * the anchor: the anchor is fixed by the subject and reads as muted tail text,
 * while this phrase is the bold token the timing panel below actually edits.
 *
 * Mirrors the mockup's `timingPhrase()` date branch. Every return value here
 * already starts with an uppercase letter or a digit, so no capitalization step
 * is needed on top (the mockup applies a separate `cap()` pass).
 */
function dateTimingPhrase(direction: 'before' | 'after', offsetMinutes: number): string {
  const { value, unit } = splitOffset(offsetMinutes);
  const preposition = direction === 'before' ? 'before' : 'after';
  if (value === 0) {
    return direction === 'before' ? 'Just before' : 'Right after';
  }
  if (value === 1 && unit === 'days') {
    return `The day ${preposition}`;
  }
  return `${pluralizeUnit(value, unit)} ${preposition}`;
}

/**
 * Mirrors the mockup's `articleize()` — "Invoice is paid" -> "an invoice is paid".
 * The `?? ''` fallbacks are for `noUncheckedIndexedAccess` only (TS can't see that
 * `(\w+)` and `(.*)` always capture something once `match` itself is truthy).
 */
function articleizeEventLabel(label: string): string {
  const match = label.match(/^(\w+)(.*)$/);
  if (!match) return label.toLowerCase();
  const noun = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').toLowerCase();
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a';
  return `${article} ${noun}${rest}`;
}

function findAnchorLabel(
  catalog: WorkflowCatalog,
  subject: TriggerSelection['subject'],
  anchor: TriggerSelection['anchor'],
): string | undefined {
  if (!anchor) return undefined;
  return catalog.anchors[subject]?.find((option) => option.key === anchor)?.label;
}

export default function TriggerReadback({ selection, catalog }: TriggerReadbackProps) {
  // The muted words that open the sentence, the bold token the panel directly
  // above this strip edits, and the muted tail. Null until the pick is complete.
  let phrase: { prefix: string; focus: string; suffix: string } | null = null;
  let emptyMessage = '';
  let showRuleOneNote = false;
  let noteAnchorLabel = '';

  if (selection.mode === 'event') {
    const def = selection.eventTrigger ? catalog.triggers[selection.eventTrigger] : undefined;
    if (!def) {
      emptyMessage = 'Pick the event that starts it.';
    } else {
      phrase = { prefix: 'The moment ', focus: articleizeEventLabel(def.label), suffix: '' };
    }
  } else {
    const anchorLabel = findAnchorLabel(catalog, selection.subject, selection.anchor);
    if (anchorLabel === undefined || selection.direction === undefined || selection.offsetMinutes === undefined) {
      emptyMessage = 'Choose a timing to complete this.';
    } else {
      phrase = {
        prefix: '',
        focus: dateTimingPhrase(selection.direction, selection.offsetMinutes),
        suffix: ` ${anchorLabel}`,
      };
      if (selection.direction === 'before') {
        showRuleOneNote = true;
        noteAnchorLabel = anchorLabel;
      }
    }
  }

  return (
    <div className="rounded-card border border-border bg-background-light p-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wide text-primary-light">
        <Clock className="h-[13px] w-[13px]" aria-hidden />
        This automation starts…
      </div>

      <p role="status" className="text-[14.5px] font-semibold leading-snug text-text-primary">
        {phrase === null ? (
          <span className="text-text-soft">{emptyMessage}</span>
        ) : (
          <>
            {phrase.prefix}
            <span className="font-extrabold text-primary">{phrase.focus}</span>
            {phrase.suffix}
            {'.'}
          </>
        )}
      </p>

      {showRuleOneNote && (
        <div
          data-testid="trigger-readback-note"
          className="mt-2.5 flex items-start gap-1.5 border-t border-dashed border-border pt-2.5 text-xs text-text-secondary"
        >
          <Info className="mt-0.5 h-[13px] w-[13px] shrink-0" aria-hidden />
          <span>
            {'If '}
            {noteAnchorLabel}
            {' is '}
            <span className="font-bold text-text-primary">still coming up</span>
            {' but it’s too late for the full head start, we send right away. If '}
            {noteAnchorLabel}
            {' has '}
            <span className="font-bold text-text-primary">already passed</span>
            {', we skip it — no reminder for something that’s over.'}
          </span>
        </div>
      )}
    </div>
  );
}
