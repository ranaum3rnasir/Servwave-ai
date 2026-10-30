import { useState } from 'react';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import type { JobReview } from '@/lib/api/jobReview';
import { byAndWhen, plural } from './reviewWording';
import { FIRST_ROWS, MORE_ROWS } from './OfficeReviewPanel';

/**
 * "Since the review" (Roles & Permissions, PRD 6, S06.20): the right-side panel of a job in Ready to close. It lists the
 * ordinary changes that landed after the review was finished (a payment, an invoice sent, a note, a line added at its
 * price, a price raised, a file uploaded). They did not send the job back; an unusual change (a price cut, a deleted file,
 * a customer detail change) would have, and then the job is in Office review with the whole review again.
 *
 * The list is the server's (`review.since_review`, built by the same change-set the Office review panel reads); the page
 * draws this panel only when the job's own answer offers the review to this person. Nothing here can be checked or
 * finished: the review is over, so the rows are read only.
 */
export interface SinceReviewPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobNumber: string;
  review: JobReview | undefined;
  hasError: boolean;
  onRetry: () => void;
}

export function SinceReviewPanel({ open, onOpenChange, jobNumber, review, hasError, onRetry }: SinceReviewPanelProps) {
  // A review read while the job was still in Office review (still cached) carries no list: it is not the answer, so it waits for the new read.
  const list = review?.since_review ?? null;
  const items = list ?? [];
  const [shown, setShown] = useState(FIRST_ROWS);
  const visible = items.slice(0, shown);
  const left = items.length - visible.length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" intent="content" aria-describedby="since-review-count" className="gap-0 sm:w-[min(34rem,100vw)]">
        <SheetHeader>
          <SheetTitle>Since the review</SheetTitle>
          <SheetDescription id="since-review-count">
            {list ? `${jobNumber} · ${plural(items.length, 'change')}` : jobNumber}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4">
          {!list && !hasError && (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading the changes">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {hasError && !list && (
            <div className="flex flex-col items-start gap-2" role="alert">
              <p className="text-sm">The changes could not be loaded.</p>
              <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
            </div>
          )}
          {list && (
            <>
              <p className="text-muted-foreground text-sm">
                These changes landed after the review was finished and did not send the job back. A price cut, a deleted file or a customer
                detail change would have.
              </p>
              {items.length === 0 ? (
                <p className="text-sm">Nothing has changed since the review was finished.</p>
              ) : (
                <section aria-label="Changes since the review" className="flex flex-col gap-2">
                  <ul className="flex flex-col gap-2">
                    {visible.map((item) => (
                      <li key={item.key} className="border-border bg-kit-card flex flex-col gap-1 rounded-md border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 text-sm font-medium break-words">{item.title}</p>
                          {item.unusual && item.unusual_reason && <Badge variant="softAmber" size="sm">{item.unusual_reason}</Badge>}
                        </div>
                        <p className="text-sm break-words">{item.summary}</p>
                        <p className="text-muted-foreground text-xs">{byAndWhen(item.by, item.at)}</p>
                      </li>
                    ))}
                  </ul>
                  {left > 0 && (
                    <Button size="sm" variant="outline" className="self-start" onClick={() => setShown((n) => n + MORE_ROWS)}>
                      {`Show ${Math.min(left, MORE_ROWS)} more (${left} left)`}
                    </Button>
                  )}
                </section>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
