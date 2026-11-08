import { useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useUnreadCount, useMarkSeen } from '@/lib/api/notifications';
import { useNotificationRealtime } from '@/lib/notifications/useNotificationRealtime';
import { useInterruptToasts } from '@/lib/notifications/useInterruptToasts';
import { useIsMobile } from '@/hooks/useIsMobile';
import { NotificationPanel } from './NotificationPanel';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { data: unreadData } = useUnreadCount();
  const markSeen = useMarkSeen();

  // Live subscription — keeps unread count fresh via Supabase realtime broadcast.
  useNotificationRealtime();
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
        <SheetContent side="bottom" className="max-h-[80vh]">
          <SheetHeader>
            {/* SheetTitle satisfies the a11y dialog label requirement.
                NotificationPanel renders its own visible heading — pass
                hideHeaderTitle so only one heading is visible. */}
            <SheetTitle className="sr-only">Notifications</SheetTitle>
          </SheetHeader>
          <NotificationPanel hideHeaderTitle={false} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        {/* NotificationPanel owns its own header row (title + Mark all read) */}
        <NotificationPanel />
      </PopoverContent>
    </Popover>
  );
}
