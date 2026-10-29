import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { LOST_REASON_NOTE_MAX } from '@/constants/lostReasons';

interface DeclineReasonFieldsProps {
  reason: string;
  onReasonChange: (reason: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  /** Held true while the decline is in flight, so a customer cannot edit a submitted answer. */
  disabled?: boolean;
  /**
   * The reasons to offer, resolved by the page from the organisation's own list (slice C, D6).
   *
   * A PROP rather than a fetch of its own, because the credential is the page's: the `?token=` in
   * the URL is all the customer holds, and this component has no access to it and no business
   * knowing about it. It stays what it was - presentational, every input arriving from above.
   */
  options: { value: string; label: string }[];
}

/**
 * The body of the public decline confirmation - a reason picker and a comment box.
 *
 * Rendered into `ConfirmDialog`'s `children` slot rather than as a dialog of its own. That slot
 * exists for exactly this ("the input a destructive action needs before it can be confirmed"), and
 * using it keeps the decline a single confirm step: the customer has already decided, and putting
 * a second modal between them and the outcome is how you lose the decline itself.
 *
 * BOTH FIELDS ARE OPTIONAL, AND NEITHER GATES THE CONFIRM BUTTON. That is a product decision, not
 * an oversight - see the call site in PublicEstimatePage, which deliberately passes no
 * `confirmDisabled`. Requiring an answer risks the customer abandoning the decline and going
 * silent, which loses the reason AND the status; an unlabelled decline is strictly better.
 *
 * THE COMMENT BOX IS ALWAYS VISIBLE, not revealed by picking "Other". "Price" plus "we got it
 * three thousand cheaper down the road" is worth far more than "Price" alone, and a box that
 * appears on one branch only teaches the customer that the other branches do not want to hear
 * from them.
 *
 * The options arrive as a prop and nothing is listed here. Slice C swapped their source for the
 * organisation's own list; this file gained one prop and lost one import, which is as close to
 * "not reopened" as the seam was ever going to get.
 */
export function DeclineReasonFields({
  reason,
  onReasonChange,
  note,
  onNoteChange,
  disabled = false,
  options,
}: DeclineReasonFieldsProps) {
  return (
    <div className="flex flex-col gap-4 text-left">
      <div className="flex flex-col gap-1.5">
        {/* Explicit ids rather than a FormField wrapper: this page is unauthenticated and composes
            kit primitives directly (see the page's own header comment), and `SelectField` renders
            a Radix trigger that a plain <label for> resolves to correctly. */}
        <Label htmlFor="decline-reason">Why are you declining? (optional)</Label>
        <SelectField
          id="decline-reason"
          value={reason}
          onValueChange={onReasonChange}
          options={options}
          placeholder="Choose a reason"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="decline-note">Anything you would like us to know? (optional)</Label>
        <Textarea
          id="decline-note"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          // Same number the server truncates at, so the cap is met here as a full box rather than
          // as silently dropped characters after the fact.
          maxLength={LOST_REASON_NOTE_MAX}
          rows={3}
          placeholder="Your feedback helps us quote better next time."
          disabled={disabled}
        />
      </div>
    </div>
  );
}
