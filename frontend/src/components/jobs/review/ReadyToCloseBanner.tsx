import { Button } from '@/ui-kit/components/ui/button';
import { formatCurrency } from '@/lib/utils';

/**
 * What the server says about a job in Ready to close (Roles & Permissions, PRD 6, S06.13), for the banner. The browser
 * never works out money owed or whether Mark Done is allowed: the amount, the offer and the reason all come from here.
 */
export interface ReadyToCloseAnswer {
  /** What is owed now, in dollars; 0 when nothing is. */
  amount_owed: number;
  /** `offered`: Mark Done may be pressed. `disabled`: drawn with the reason. `none`: this person does not close jobs. */
  mark_done: 'offered' | 'disabled' | 'none';
  mark_done_reason: string | null;
  /** True when the press must confirm the amount first. */
  confirm_amount: boolean;
  /** True when this person may read the review: the banner offers "Since the review" (S06.20). */
  review_changes: boolean;
}

/**
 * The banner in the job's header card while the job is in Ready to close: "Ready to close", the amount owed when there is
 * one, and Mark Done for a holder of Close jobs. When money is owed and the person may not close over it, Mark Done is
 * drawn disabled with the server's reason beside it. The job page draws it only when the job's own answer carries the
 * block, which it does for a person who closes jobs or reviews them. A person who holds Office review also gets "Since the review",
 * which opens the list of ordinary changes made after the review was finished (S06.20).
 */
export interface ReadyToCloseBannerProps {
  answer: ReadyToCloseAnswer;
  onMarkDone: () => void;
  isPending: boolean;
  /** Opens the "Since the review" panel; drawn only when the job's answer offers the review to this person. */
  onShowChanges: () => void;
}

export function ReadyToCloseBanner({ answer, onMarkDone, isPending, onShowChanges }: ReadyToCloseBannerProps) {
  const owed = answer.amount_owed > 0;
  return (
    <section
      aria-label="Ready to close"
      className="border-status-blue/40 bg-status-blue-subtle flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold">
          Ready to close
          {owed && <span data-testid="ready-to-close-owed">{` · ${formatCurrency(answer.amount_owed)} owed`}</span>}
        </p>
        {answer.mark_done === 'disabled' && answer.mark_done_reason && (
          <p id="mark-done-reason" className="text-muted-foreground text-xs">{answer.mark_done_reason}</p>
        )}
      </div>
      {answer.review_changes && (
        <Button size="sm" variant="outline" onClick={onShowChanges}>Since the review</Button>
      )}
      {answer.mark_done !== 'none' && (
        <Button
          size="sm"
          onClick={onMarkDone}
          disabled={answer.mark_done === 'disabled'}
          isLoading={isPending}
          aria-describedby={answer.mark_done === 'disabled' ? 'mark-done-reason' : undefined}
        >
          Mark Done
        </Button>
      )}
    </section>
  );
}
