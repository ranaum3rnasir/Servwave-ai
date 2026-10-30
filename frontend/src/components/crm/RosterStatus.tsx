import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * What a people picker shows while its roster is on the way, and when it could not be had. A roster that has not
 * arrived is neither empty nor refused, so a picker must never answer "No owner" or "No team members found" for it:
 * one reads as a fact about the company, the other as a rule.
 */

/** The picker's place held while the roster loads. */
export function RosterLoading({ className }: { className?: string }) {
  return <Skeleton role="status" aria-label="Loading people" className={cn('h-9 w-full', className)} />;
}

/** The roster failed: say so, and offer another try. */
export function RosterError({ onRetry, className }: { onRetry: () => void; className?: string }) {
  return (
    <div role="alert" className={cn('flex flex-wrap items-center gap-2', className)}>
      <p className="text-sm text-danger">Could not load the list of people.</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
