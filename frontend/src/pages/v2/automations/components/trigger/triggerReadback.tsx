import { Clock, Info } from 'lucide-react';

import type { TriggerSelection } from '@/lib/workflows/triggerModel';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { splitOffset, type OffsetUnit } from '@/lib/workflows/timing';

import { ELLIPSIS, EM_DASH, RSQUO } from '../glyphs';

/**
 * The live plain-English summary under the trigger builder. Always mounted
 * while the builder is open, re-rendering on every pick, so the office sees
 * exactly what they are building as one flowing sentence.
 *
 * `role="status"` on the sentence paragraph makes it a live region and gives
 * tests one stable node to read `.textContent` from despite the sentence being
 * assembled out of several inline spans.
 *
 * THE SENTENCE DESCRIBES THE TRIGGER AND NOTHING ELSE. It used to end with the
 * hardcoded tail "send the customer an email." - false twice over, and both
 * halves were reachable on the same draft. It named an audience the trigger
 * may not be able to reach at all (a task trigger's legal audiences are staff
 * only: catalog.ts's ENTITIES_WITH_CUSTOMER excludes `task`, so "the customer"
 * was a recipient the office could not have picked), and it asserted an email
 * step on a draft that may have no steps at all, or whose first step is a
 * text. The "what happens" half belongs to the step bubbles, which render it
 * per step from stepSentence.ts against the config the office actually chose.
 * This strip owns the "when" half only, and its eyebrow says so.
 */
export interface TriggerReadbackProps {
  selection: TriggerSelection;
  catalog: WorkflowCatalog;
}

/** Singularizes the unit word only when n === 1. */
function pluralizeUnit(n: number, unit: OffsetUnit): string {
  if (n === 1) return `1 ${unit.replace(/s$/, '')}`;
  return `${n} ${unit}`;
}

/**
 * The timing half of a date sentence ("The day before", "3 days after"), without
 * the anchor: the anchor is fixed by the subject and reads as muted tail text,
 * while this phrase is the bold token the timing panel below actually edits.
 *
 * Every return value already starts with an uppercase letter or a digit, so no
 * separate capitalization pass is needed on top.
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

/** "Invoice is paid" becomes "an invoice is paid". */
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
    <div className="border-border bg-muted rounded-lg border p-4">
      <div className="text-brand mb-1.5 flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-wide">
        <Clock className="size-[13px]" aria-hidden />
        {`This automation starts${ELLIPSIS}`}
      </div>

      <p role="status" className="text-[14.5px] font-semibold leading-snug">
        {phrase === null ? (
          <span className="text-subtle-foreground">{emptyMessage}</span>
        ) : (
          <>
            {phrase.prefix}
            <span className="text-brand font-extrabold">{phrase.focus}</span>
            {phrase.suffix}
            {'.'}
          </>
        )}
      </p>

      {showRuleOneNote && (
        <div
          data-testid="trigger-readback-note"
          className="border-border text-muted-foreground mt-2.5 flex items-start gap-1.5 border-t border-dashed pt-2.5 text-xs"
        >
          <Info className="mt-0.5 size-[13px] shrink-0" aria-hidden />
          <span>
            {'If '}
            {noteAnchorLabel}
            {' is '}
            <span className="text-foreground font-bold">still coming up</span>
            {` but it${RSQUO}s too late for the full head start, we send right away. If `}
            {noteAnchorLabel}
            {' has '}
            <span className="text-foreground font-bold">already passed</span>
            {`, we skip it ${EM_DASH} no reminder for something that${RSQUO}s over.`}
          </span>
        </div>
      )}
    </div>
  );
}
