import { cn } from '@/lib/utils';

interface BrowserAutomationIndicatorProps {
  className?: string;
}

/**
 * Visual Browser Automation Indicator Frame (Spider Notification Alert Indicator), the contractor's
 * red frame copied as it is (Ran, 15 Oct; his `components/notifications/BrowserAutomationIndicator.tsx`
 * at 3bb6606): a 3.5px danger border with four corner accents and his `spiderMaroonPulse` glow, with
 * pointer-events none so it never blocks a click.
 *
 * Two changes, neither visible:
 *   - It does not decide when to show. His computed overdue leads in the browser every 2.5 seconds;
 *     here the host (SpiderAlertsHost) renders it only while the company's Red Frame is on and the
 *     server lists an unread Spider alert for the signed-in person.
 *   - It carries a screen-reader label (his status region had none), which our accessibility rules
 *     require. Reduced motion is handled by the global `prefers-reduced-motion` rule in index.css,
 *     which stops this animation as it stops every other one.
 */
export function BrowserAutomationIndicator({ className }: BrowserAutomationIndicatorProps) {
  return (
    <div
      aria-live="polite"
      role="status"
      aria-label="Spider has an unread alert for you"
      data-testid="spider-red-frame"
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
