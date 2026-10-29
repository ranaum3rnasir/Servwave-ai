import { AlertTriangle } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/**
 * A failed load: what could not be loaded, and a Retry.
 *
 * Mobile slice 68 (PRD story 140). A page or list whose request failed used to render the same
 * words as a page with nothing in it ("Lead not found.", "No results found."), so a lost signal on
 * a phone read as lost data. This is the one error state for those places.
 *
 * The copy is fixed. The server's own message is never shown: it can name internals that are not
 * the customer's business (and a failed request often has no useful message at all).
 */
export function LoadError({ title, onRetry, retrying = false, className }: {
  /** Names what failed, e.g. "Couldn't load this lead." */
  title: string;
  onRetry: () => void;
  /** A retry is already in flight: the button waits instead of firing a second request. */
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-slot="load-error"
      className={cn('flex flex-col items-center justify-center px-5 py-11 text-center', className)}
    >
      <div className="bg-muted text-subtle-foreground mb-3 grid size-11 place-items-center rounded-xl [&_svg]:size-5">
        <AlertTriangle aria-hidden />
      </div>
      <h3 className="text-[14.5px] font-bold tracking-tight">{title}</h3>
      <p className="text-muted-foreground mt-1 max-w-[42ch] text-[13px] leading-relaxed">
        Check your connection and try again.
      </p>
      <div className="mt-3.5">
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
          Retry
        </Button>
      </div>
    </div>
  );
}
