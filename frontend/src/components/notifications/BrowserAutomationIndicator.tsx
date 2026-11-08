import { useState, useEffect, useMemo } from 'react';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

interface BrowserAutomationIndicatorProps {
  className?: string;
}

/**
 * Visual Browser Automation Indicator Frame (Spider Notification Alert Indicator)
 *
 * Requirements:
 * 1. Subdued deep frame with smooth breathing pulse animation.
 * 2. Pointer-events: none overlay so user interaction remains unhindered.
 * 3. Shows automatically whenever a Spider notification alert is active (unread lead stage threshold alerts).
 * 4. Automatically disappears when the notification is marked as read upon message dispatch.
 */
export function BrowserAutomationIndicator({ className }: BrowserAutomationIndicatorProps) {
  const [tick, setTick] = useState(0);

  const currentUser = useAuthStore((s) => s.user);
  // Subscribe to reactive store slices so changes immediately re-evaluate alerts
  const redFrameEnabled = useSpiderWatcherStore((s) => s.notifications.redFrame ?? true);
  const assignments = useSpiderWatcherStore((s) => s.assignments);
  const customers = useSpiderWatcherStore((s) => s.customers);
  const selectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const leadStages = useSpiderWatcherStore((s) => s.leadStages);
  const readNotificationIds = useSpiderWatcherStore((s) => s.readNotificationIds);
  const getComputedNotifications = useSpiderWatcherStore((s) => s.getComputedNotifications);

  // Periodic heartbeat to evaluate elapsed real-time lead durations against stage thresholds
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 10000);
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  const activeNotifs = useMemo(() => {
    return redFrameEnabled ? getComputedNotifications(currentUser) : [];
  }, [redFrameEnabled, currentUser, assignments, customers, selectedLeadIds, leadStages, readNotificationIds, getComputedNotifications, tick]);

  const unreadCount = activeNotifs.filter((n) => !n.read).length;

  // Frame is strictly visible when an unread spider notification alert is active and Red Frame is enabled
  const isVisible = redFrameEnabled && unreadCount > 0;

  if (!isVisible) return null;

  return (
    <div
      aria-live="polite"
      role="status"
      className={cn('pointer-events-none fixed inset-0 z-50 overflow-hidden', className)}
    >
      {/* ── Ambient Glowing Subdued Viewport Frame ────────────────── */}
      <div
        className="pointer-events-none absolute inset-0 border-[3.5px] border-danger"
        style={{
          animation: 'spiderMaroonPulse 3.5s ease-in-out infinite',
        }}
      >
        {/* Subtle corner accents */}
        <span className="absolute -top-0.5 -left-0.5 h-3.5 w-3.5 border-t-[2.5px] border-l-[2.5px] border-danger shadow-xs" />
        <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 border-t-[2.5px] border-r-[2.5px] border-danger shadow-xs" />
        <span className="absolute -bottom-0.5 -left-0.5 h-3.5 w-3.5 border-b-[2.5px] border-l-[2.5px] border-danger shadow-xs" />
        <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 border-b-[2.5px] border-r-[2.5px] border-danger shadow-xs" />
      </div>

      {/* Gentle breathing animation keyframes with token-backed opacity */}
      <style>{`
        @keyframes spiderMaroonPulse {
          0%, 100% {
            opacity: 0.72;
            box-shadow: inset 0 0 24px rgb(var(--danger) / 0.48), 0 0 24px rgb(var(--danger) / 0.48);
          }
          50% {
            opacity: 0.88;
            box-shadow: inset 0 0 40px rgb(var(--danger) / 0.76), 0 0 35px rgb(var(--danger) / 0.72);
          }
        }
      `}</style>
    </div>
  );
}
