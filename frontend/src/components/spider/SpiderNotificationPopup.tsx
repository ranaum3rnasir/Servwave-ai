import { useState, useEffect, useRef, useMemo } from 'react';
import { MessageSquare, BellOff, X, MapPin, Calendar, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn, getInitials } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import {
  formatCurrentStageName,
  formatLeadLastCommunication,
  getSpiderStageAction,
  formatLastCommunicationTimestamp,
  formatNotificationMessageReadableTime,
  formatSpiderStageSentence,
  formatLargestUnitDuration,
  type InAppNotification,
} from '@/lib/spider/watcher';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useIsSpiderAdmin } from '@/lib/spider/gate';
import { spiderLeadLink, type SpiderLeadLinkState } from '@/lib/spider/followUp';
import {
  useEnableSpiderInApp,
  type SpiderAlertCard,
  type SpiderUnreadResponse,
} from '@/lib/api/spider';

/**
 * The contractor's Spider notifications popup (Ran, 15 Oct: "exactly as it is"; his
 * `components/notifications/SpiderNotificationPopup.tsx` at 3bb6606): the floating button, the
 * panel and its cards, copied as they are, fed by OUR server's list of the signed-in person's
 * unread Spider alerts instead of his browser store.
 *
 * Changes to his code, each so the screen shows only what the server raised:
 *   - Every card is a server alert. His browser-computed cards, his 2.5-second recompute and his
 *     browser-side "stale" marking are gone: the server leaves out an alert whose lead left the
 *     stage, and its sweep marks it read.
 *   - A click routes on the lead's stage now, as his did, from the server's `current_stage`. The
 *     pre-filled draft and the alert id travel in the router state, not in the address bar (his put
 *     the customer's name in the URL).
 *   - [Enable Notifications] turns in-app alerts on through the Admin-only settings save, and is
 *     shown only to an Admin; anyone else sees his sentence alone.
 *   - Escape closes the panel (an accessibility requirement; his closed on an outside click only).
 *   - The button keeps clear of a phone's home indicator (`--safe-bottom`).
 *   - Ran, 20 Oct: the spider fills more of the button (a thinner purple frame), the cards are
 *     rounded tiles, each card shows the customer's initials, and the panel opens and closes with
 *     an animation.
 */

type PopupNotification = InAppNotification & {
  currentStage: string | null;
  initials: string;
  /** The instant the card's sentence counts from: the lead's creation for New (SPEC-4 D7), else the stage entry. */
  sentenceFromAt: string | null;
};

/**
 * How long the panel's closing animation runs before it unmounts: the `fast` motion token
 * (--motion-duration-fast in tokens-v2.css), a popover-sized move. A test keeps the two in step.
 */
export const PANEL_EXIT_MS = 240;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ExpandableMessage({ text, maxChars = 100 }: { text: string; maxChars?: number }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > maxChars;

  if (!isLong) {
    return <p className="text-xs text-text-secondary leading-relaxed">{text}</p>;
  }

  return (
    <p className="text-xs text-text-secondary leading-relaxed">
      {expanded ? text : `${text.slice(0, maxChars)}...`}
      {' '}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((prev) => !prev);
        }}
        className="inline-flex items-center text-ai-600 hover:text-ai-strong font-semibold text-[11px] hover:underline cursor-pointer ml-1"
      >
        {expanded ? 'See less' : 'See more'}
      </button>
    </p>
  );
}

const SPIDER_IMAGE = AI_AGENTS.find((a) => a.id === 'spider')!.image;

/** His server-notification mapping (his `serverNotifications`), from our alert card. */
function toNotification(a: SpiderAlertCard): PopupNotification {
  const leadId = a.lead_id || '';
  const leadNumber = a.lead_number || (leadId && leadId.length > 8 ? `LD-${leadId.substring(0, 6).toUpperCase()}` : leadId) || 'Lead';
  const contactName = a.customer_name || 'Customer';
  const companyName = a.company_name || contactName;
  const stageName = formatCurrentStageName(a.stage_name || 'New');
  const message = formatNotificationMessageReadableTime(a.message);
  const rawTimeAgo = formatLastCommunicationTimestamp(a.created_at) || 'Just now';
  return {
    id: a.id,
    contactName,
    companyName,
    inactiveDays: 0,
    message,
    timeAgo: formatNotificationMessageReadableTime(rawTimeAgo),
    read: false,
    contactId: '',
    leadId,
    leadNumber,
    leadStage: stageName,
    serviceRequest: a.service_request || '',
    serviceLocation: a.service_location || '',
    contactedAt: null,
    createdAt: a.created_at,
    stageEnteredAt: a.stage_entered_at,
    lastCommunication: null,
    isTriggered: true,
    assignedTo: a.assigned_to || '',
    assignedToId: null,
    currentStage: a.current_stage,
    initials: getInitials(a.customer_name, contactName[0]),
    // A lead moved back to New has a younger stay than the lead; "created X ago" counts from its creation. An alert
    // raised before that was stored counts from the stage entry, as it always did.
    sentenceFromAt: (a.status === 'NEW' && a.lead_created_at) || a.stage_entered_at,
  };
}

export function SpiderNotificationPopup({ data }: { data: SpiderUnreadResponse }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  // 'closing' keeps the panel on screen, out of reach (inert), while its closing animation plays.
  const [panelState, setPanelState] = useState<'closed' | 'open' | 'closing'>('closed');
  const isWindowOpen = panelState === 'open';
  // The clock the open cards' times are drawn from ("2 hours 15 minutes ago"): set when the panel
  // opens and every 30 seconds while it is open, without asking the server anything.
  const [now, setNow] = useState(() => Date.now());
  const isAdmin = useIsSpiderAdmin();
  const enableInApp = useEnableSpiderInApp();

  const inAppEnabled = data.in_app;
  const activeNotifications = useMemo(() => data.alerts.map(toNotification), [data.alerts]);
  const unreadCount = activeNotifications.length;

  const closePanel = () =>
    setPanelState((s) => (s === 'open' ? (prefersReducedMotion() ? 'closed' : 'closing') : s));

  useEffect(() => {
    if (panelState !== 'closing') return;
    const timer = setTimeout(() => setPanelState((s) => (s === 'closing' ? 'closed' : s)), PANEL_EXIT_MS);
    return () => clearTimeout(timer);
  }, [panelState]);

  useEffect(() => {
    if (!isWindowOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [isWindowOpen]);

  // Close panel when clicking outside (and on Escape)
  useEffect(() => {
    if (!isWindowOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePanel();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [isWindowOpen]);

  const handleNotificationClick = (notif: PopupNotification) => {
    closePanel();

    // Route based on the lead's CURRENT stage (what stage the lead is stuck in right now)
    const stageName = formatCurrentStageName(notif.currentStage || notif.leadStage);
    const targetLeadId = notif.leadId;

    if (!targetLeadId) {
      navigate('/leads');
      return;
    }

    // Opening a card never clears its alert, at any stage, Estimate included (SPEC-6, Ran's decision
    // 11.2): the server ends it once the lead really moves on (D1).

    const go = (tab: string, state: SpiderLeadLinkState) => navigate(spiderLeadLink(targetLeadId, tab), { state });

    if (
      stageName === 'Walkthrough Completed' ||
      stageName === 'Walkthrough' ||
      stageName.toLowerCase().includes('walkthrough completed') ||
      stageName === 'Estimate'
    ) {
      // Lead is currently in the Walkthrough Completed / Estimate stage →
      // Redirect to Lead Overview page
      go('overview', { spiderAlertId: notif.id });
    } else if (stageName === 'Contacted') {
      // Lead is currently in the Contacted stage →
      // Go to Walkthrough tab to schedule a walkthrough
      go('walkthrough', { spiderAlertId: notif.id });
    } else {
      // Lead is currently in the New stage (or unknown) →
      // Go to Communication tab to make first contact
      go('communication', {
        spiderAlertId: notif.id,
        spiderDraft: `Hello ${notif.contactName}, following up regarding your ${notif.serviceRequest || 'service request'} (Stage: ${stageName}).`,
      });
    }
  };

  // Keep spider icon completely hidden by default. Only display when there is an active/unread notification.
  if (unreadCount === 0) return null;

  return (
    <div ref={panelRef} className="fixed bottom-[calc(1.25rem+var(--safe-bottom,0px))] right-5 z-50">
      {/* ── Floating Notification Bell FAB ───────────────────────────── */}
      <Button
        type="button"
        variant="solid"
        tone="ai"
        size={null}
        id="spider-notification-bell-trigger"
        onClick={() => {
          if (isWindowOpen) {
            closePanel();
          } else {
            setNow(Date.now());
            setPanelState('open');
          }
        }}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} unread Spider notification${unreadCount > 1 ? 's' : ''} — click to view`
            : 'Spider Lead Watcher notifications'
        }
        aria-expanded={isWindowOpen}
        className={cn(
          'relative flex h-14 w-14 items-center justify-center p-0 transition-transform hover:scale-110 active:scale-95',
          !isWindowOpen && unreadCount > 0 && 'animate-bounce',
        )}
        style={!isWindowOpen && unreadCount > 0 ? { animationDuration: '1.4s' } : undefined}
      >
        <Avatar className="h-12 w-12 shrink-0 select-none pointer-events-none">
          <AvatarImage
            src={SPIDER_IMAGE}
            alt="Spider Agent"
            className="object-contain"
          />
          <AvatarFallback tone="solid">
            🕷️
          </AvatarFallback>
        </Avatar>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-notify px-1 text-[11px] font-bold text-on-fill ring-2 ring-surface-light animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {/* ── Notification panel ────────────────────────────────────────── */}
      {panelState !== 'closed' && (
        <div
          role="dialog"
          aria-label="Spider Lead Watcher Notifications"
          data-state={isWindowOpen ? 'open' : 'closed'}
          aria-hidden={isWindowOpen ? undefined : true}
          inert={!isWindowOpen}
          // The motion tokens, set inline: the `data-[state=*]:animate-in/out` classes set tailwindcss-animate's
          // 150ms default with a class-plus-attribute selector, which a plain `duration-fast` class loses to.
          style={{ animationDuration: 'var(--motion-duration-fast)', animationTimingFunction: 'var(--motion-ease-out)' }}
          className="absolute bottom-16 right-0 w-[21rem] max-w-[calc(100vw-2.5rem)] sm:w-96 origin-bottom-right rounded-xl border border-border bg-surface-light shadow-card overflow-hidden fill-mode-forwards data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarImage
                  src={SPIDER_IMAGE}
                  alt="Spider Agent"
                  className="object-contain"
                />
                <AvatarFallback tone="solid">
                  🕷️
                </AvatarFallback>
              </Avatar>
              <div className="flex items-center gap-1.5">
                <Heading level={3} scale="sm" weight="bold">
                  Spider Notifications
                </Heading>
                <span className="rounded-full bg-danger-surface border border-danger-border px-1.5 py-0.5 text-[10px] font-bold text-danger-text">
                  {unreadCount} Awaiting
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={closePanel}
              className="h-6 w-6 transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Body */}
          <div className="max-h-[300px] overflow-y-auto space-y-2 p-2 [scrollbar-width:thin] [scrollbar-color:rgba(156,163,175,0.6)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-muted/20 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-text-soft/60">
            {!inAppEnabled ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <BellOff className="h-8 w-8 text-text-soft/60" />
                <p className="text-xs font-medium text-text-secondary">
                  In-App Spider notifications are currently disabled.
                </p>
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={enableInApp.isPending}
                    onClick={() => {
                      enableInApp.mutate(undefined, {
                        onSuccess: () => toast({ title: 'Enabled Spider In-App Notifications', duration: 2000 }),
                      });
                    }}
                  >
                    Enable Notifications
                  </Button>
                )}
              </div>
            ) : activeNotifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-text-soft">
                No Spider lead watcher alerts currently active.
              </p>
            ) : (
              activeNotifications.map((n) => {
                let messageText: string;
                const sentenceFromMs = n.sentenceFromAt ? new Date(n.sentenceFromAt).getTime() : NaN;
                if (!isNaN(sentenceFromMs)) {
                  const elapsedSecs = Math.max(0, Math.floor((now - sentenceFromMs) / 1000));
                  const dynamicElapsedStr = formatLargestUnitDuration(elapsedSecs);
                  messageText = formatSpiderStageSentence({
                    assignedToName: n.assignedTo,
                    stageLabelOrId: n.leadStage,
                    timeElapsedStr: dynamicElapsedStr,
                  });
                } else {
                  const rawText =
                    n.message ||
                    n.lastCommunication ||
                    formatLeadLastCommunication(n.contactedAt, n.createdAt);
                  messageText = formatNotificationMessageReadableTime(rawText);
                }
                const topTimeAgo = formatLastCommunicationTimestamp(n.createdAt) || n.timeAgo;
                const leadDisplayNumber = n.leadNumber || (n.leadId && n.leadId.length > 8 ? `LD-${n.leadId.substring(0, 6).toUpperCase()}` : n.leadId) || 'Lead';
                const stageAction = getSpiderStageAction(n.leadStage);
                const ActionIcon =
                  stageAction.stageKey === 'walkthrough_completed'
                    ? FileText
                    : stageAction.stageKey === 'contacted'
                    ? Calendar
                    : MessageSquare;

                return (
                  <div
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open notification for lead ${leadDisplayNumber}`}
                    onClick={() => handleNotificationClick(n)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleNotificationClick(n);
                      }
                    }}
                    className={cn(
                      'flex gap-2.5 rounded-xl border border-border/60 p-3 transition-colors cursor-pointer hover:bg-background-light group',
                      !n.read ? 'bg-ai-50/40' : 'bg-surface-light'
                    )}
                  >
                    <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                      <AvatarFallback tone="subtle">
                        {n.initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      {/* Top row: Lead # (prominent) + Stage badge + Time ago */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                          <span className="shrink-0 rounded-md bg-ai-50 border border-ai-200 px-2 py-0.5 text-xs font-mono font-bold text-ai-600">
                            {leadDisplayNumber}
                          </span>
                          {n.leadStage && (
                            <span className="shrink-0 rounded-full bg-primary-subtle border border-border px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
                              {formatCurrentStageName(n.leadStage)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] font-medium text-text-soft">{topTimeAgo}</span>
                          {!n.read && (
                            <span
                              className="h-2 w-2 rounded-full shrink-0 animate-pulse bg-danger"
                            />
                          )}
                        </div>
                      </div>

                      {/* Customer Name */}
                      <div className="flex items-center gap-1 text-xs text-text-primary font-semibold truncate group-hover:text-ai-600 transition-colors">
                        <span className="text-text-soft text-[11px] font-normal">Customer:</span>
                        <span className="truncate">{n.contactName}</span>
                        {n.companyName && n.companyName !== n.contactName && (
                          <span className="text-text-soft text-[10px] font-normal truncate">
                            • {n.companyName}
                          </span>
                        )}
                      </div>

                      {/* Lead complete service location */}
                      {n.serviceLocation && n.serviceLocation !== 'Service location not specified' && (
                        <div
                          className="flex items-center gap-1 text-[11px] text-text-secondary font-medium truncate"
                          title={n.serviceLocation}
                        >
                          <MapPin className="h-3 w-3 text-text-soft shrink-0" />
                          <span className="truncate">{n.serviceLocation}</span>
                        </div>
                      )}

                      {/* Lead Stage detail with Expandable See More */}
                      <ExpandableMessage text={messageText} />

                      <div className="pt-1 flex items-center justify-between">
                        <span className="inline-flex items-center gap-1 rounded-full bg-danger-surface border border-danger-border px-2 py-0.5 text-[10px] font-semibold text-danger-text">
                          <ActionIcon className="h-3 w-3 shrink-0" />
                          <span>{stageAction.label}</span>
                        </span>
                        {n.assignedTo && (
                          <span className="text-[10px] text-text-soft truncate max-w-[140px]">
                            Assigned: {n.assignedTo}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
