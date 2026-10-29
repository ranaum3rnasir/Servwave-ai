import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, User, X } from 'lucide-react';
import { Button } from '@/ui-kit/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { StatusBadge } from '@/components/data/status-badge';
import { useMarkSpiderAlertRead, useSpiderUnreadAlerts, type SpiderAlertCard } from '@/lib/api/spider';
import { formatTimeInStatus } from '@/lib/spider/format';
import { agentMedia } from '@/lib/ai-center/media';

/**
 * Spider's popup cards and red frame (#2619), driven ONLY by the server's list of the signed-in
 * person's unread Spider alerts. Nothing is kept in the browser, so both survive a reload and a
 * sign-in on another computer. Mounted lazily by LazySpiderAlerts, behind the Spider gate.
 *
 * - The red frame shows while there is an unread alert and the company's red-frame channel is on,
 *   and goes away on its own once they are all read (or the sweep ends them).
 * - Clicking a card marks it read (the existing notification read endpoint) and opens the lead.
 */
export default function SpiderAlertsHost() {
  const { data } = useSpiderUnreadAlerts();
  const alerts = data?.alerts ?? [];
  // `red_frame` already folds in the in-app switch server-side: the frame marks an unread in-app alert.
  const showFrame = alerts.length > 0 && data?.red_frame === true;

  return (
    <>
      {showFrame && <SpiderRedFrame />}
      {alerts.length > 0 && <SpiderAlertPopup alerts={alerts} />}
    </>
  );
}

function SpiderRedFrame() {
  return (
    <div
      role="status"
      aria-label="Spider has an unread alert for you"
      data-testid="spider-red-frame"
      className="pointer-events-none fixed inset-0 z-floating border-4 border-danger motion-safe:animate-pulse"
    />
  );
}

function SpiderAlertPopup({ alerts }: { alerts: SpiderAlertCard[] }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const markRead = useMarkSpiderAlertRead();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openAlert = (alert: SpiderAlertCard) => {
    markRead.mutate(alert.id);
    setOpen(false);
    // The lead page reads this marker to offer Spider's suggested follow-up text (Spider 8/8).
    navigate(`/leads/${alert.lead_id}`, { state: { spiderFollowUp: true } });
  };

  const count = alerts.length;
  return (
    <div ref={panelRef} className="fixed bottom-[calc(1.25rem+var(--safe-bottom,0px))] right-5 z-floating flex flex-col items-end gap-2">
      {open && (
        <div
          role="dialog"
          aria-label="Spider alerts"
          className="w-[22rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-card border border-border bg-surface-light shadow-card"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <Heading level={2} scale="base">
              Spider alerts ({count})
            </Heading>
            <Button variant="ghost" size="icon-sm" aria-label="Close Spider alerts" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">
            {alerts.map((alert) => (
              <li key={alert.id}>
                <Button
                  variant="ghost"
                  className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-4 py-3"
                  aria-label={`Open lead ${alert.lead_number ?? ''} for ${alert.customer_name ?? 'this customer'}`}
                  onClick={() => openAlert(alert)}
                >
                  <SpiderAlertCardBody alert={alert} />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        variant="default"
        size="icon"
        aria-label={`${count} unread Spider alert${count === 1 ? '' : 's'}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative h-14 w-14"
      >
        <Avatar name="Spider" src={agentMedia('spider').still} size="lg" aria-hidden />
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-notify px-1 text-[11px] font-bold text-on-fill">
          {count > 99 ? '99+' : count}
        </span>
      </Button>
    </div>
  );
}

export function SpiderAlertCardBody({ alert }: { alert: SpiderAlertCard }) {
  const timeInStatus = formatTimeInStatus(alert.counted_from ?? alert.entered_status_at, alert.time_in_status);
  return (
    <div className="flex w-full flex-col gap-1 text-left">
      <div className="flex w-full items-center justify-between gap-2">
        <span className="font-mono text-xs font-bold text-text-primary">{alert.lead_number}</span>
        {alert.status && <StatusBadge domain="lead" status={alert.status} />}
      </div>
      <span className="text-sm font-semibold text-text-primary">{alert.customer_name}</span>
      <span className="text-xs text-text-secondary">
        In {alert.status_label ?? 'this status'} for {timeInStatus}
      </span>
      {alert.address && (
        <span className="flex items-center gap-1 text-xs text-text-secondary">
          <MapPin className="h-3 w-3 shrink-0" aria-hidden />
          {alert.address}
        </span>
      )}
      <span className="flex items-center gap-1 text-xs text-text-secondary">
        <User className="h-3 w-3 shrink-0" aria-hidden />
        {alert.owner_name ? `Owner: ${alert.owner_name}` : 'No owner'}
      </span>
    </div>
  );
}
