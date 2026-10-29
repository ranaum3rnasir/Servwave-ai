import { lazy, Suspense, useState } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useUnreadCount, useMarkSeen } from '@/lib/api/notifications';
import { useNotificationRefresh } from '@/lib/notifications/useNotificationRefresh';
import { useInterruptToasts } from '@/lib/notifications/useInterruptToasts';
import { useIsMobile, useIsShortHeight } from '@/hooks/useIsMobile';

// The list and its rows are only needed once the bell opens, so they are a chunk of their own
// instead of weight in the staff app's entry bundle (which has a hard size ceiling at build).
const NotificationPanel = lazy(() =>
  import('./NotificationPanel').then((m) => ({ default: m.NotificationPanel })),
);

function PanelFallback() {
  return (
    <div role="status" aria-label="Loading notifications" className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-hidden="true" />
    </div>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  // The bottom sheet on a phone, and on a phone held sideways too: an 838x390
  // landscape phone is wide enough for the popover but its ~500px panel ran
  // 150px past the bottom of the screen. Both are named breakpoints.
  const isPhone = useIsMobile();
  const isShort = useIsShortHeight();
  const isMobile = isPhone || isShort;
  const { data: unreadData } = useUnreadCount();
  const markSeen = useMarkSeen();

  // Fresh count: the queries poll every 30 s while the tab shows; this refetches on window focus.
  useNotificationRefresh();
  // Fire a shadcn toast for each new unseen INTERRUPT-priority notification.
  useInterruptToasts();

  const unseen = unreadData?.unseen ?? 0;

  function handleOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen && unseen > 0) {
      // Mark all unseen → seen so the badge clears.
      markSeen.mutate(undefined);
    }
  }

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label="Notifications"
      title="Notifications"
    >
      <Bell className="h-5 w-5" />
      {unseen > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-notify px-1 text-[10px] font-semibold leading-none text-on-fill ring-2 ring-surface-light">
          {unseen > 99 ? '99+' : unseen}
        </span>
      )}
    </Button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        {/* Capped by the DYNAMIC viewport height: `vh` is the largest
            viewport (browser bars retracted), so with iOS Safari's bars
            showing an 80vh sheet ran under the address bar. A column whose
            list shrinks and scrolls, so a long list stays inside the cap. */}
        <SheetContent side="bottom" className="flex max-h-[85dvh] flex-col">
          <SheetHeader>
            {/* SheetTitle satisfies the a11y dialog label requirement.
                NotificationPanel renders its own visible heading — pass
                hideHeaderTitle so only one heading is visible. */}
            <SheetTitle className="sr-only">Notifications</SheetTitle>
          </SheetHeader>
          <Suspense fallback={<PanelFallback />}>
            <NotificationPanel hideHeaderTitle={false} fill />
          </Suspense>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0">
        {/* NotificationPanel owns its own header row (title + Mark all read) */}
        <Suspense fallback={<PanelFallback />}>
          <NotificationPanel />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
