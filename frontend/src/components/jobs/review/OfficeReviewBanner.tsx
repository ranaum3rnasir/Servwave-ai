import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import type { JobReview } from '@/lib/api/jobReview';
import { reviewCounts, unusualChips } from './reviewWording';

/**
 * The banner in the job's header card while the job is in Office review (Roles & Permissions, PRD 6, S06.8):
 * "Office review · 7 items · 3 checked", one chip for each kind of unusual item, and the Review button that opens the
 * panel. The job page draws it only when the job's own answer lists the review action for this person; everyone else
 * sees the status chip and nothing more.
 */
export interface OfficeReviewBannerProps {
  review: JobReview | undefined;
  isLoading: boolean;
  hasError: boolean;
  onReview: () => void;
}

export function OfficeReviewBanner({ review, isLoading, hasError, onReview }: OfficeReviewBannerProps) {
  return (
    <section
      aria-label="Office review"
      className="border-status-amber/40 bg-status-amber-subtle flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-sm font-semibold">
          {review ? `Office review · ${reviewCounts(review.totals)}` : 'Office review'}
        </p>
        {isLoading && !review && <Skeleton className="h-5 w-24" />}
        {hasError && !review && <span className="text-muted-foreground text-xs">The review could not be loaded.</span>}
        {review && unusualChips(review).map((chip) => (
          <Badge key={chip.kind} variant="outline" size="sm">
            {chip.text}
          </Badge>
        ))}
      </div>
      <Button size="sm" onClick={onReview}>Review</Button>
    </section>
  );
}
