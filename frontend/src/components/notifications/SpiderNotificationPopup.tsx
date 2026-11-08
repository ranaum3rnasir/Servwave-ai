import { useState, useEffect, useRef, useMemo } from 'react';
import { MessageSquare, BellOff, X, MapPin, Calendar, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import {
  useSpiderWatcherStore,
  formatCurrentStageName,
  formatLeadLastCommunication,
  getSpiderStageAction,
  formatLastCommunicationTimestamp,
  formatNotificationMessageReadableTime,
  formatSpiderStageSentence,
  formatLargestUnitDuration,
  formatHumanReadableTimeSpan,
  type InAppNotification,
} from '@/stores/spiderWatcherStore';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { useNotifications, useSpiderNotifications, useMarkRead } from '@/lib/api/notifications';

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

function isSpiderNotificationStale(notifStage: string, leadCurrentStage: string): boolean {
  const normNotif = (notifStage || '').toLowerCase().trim();
  const normCurrent = (leadCurrentStage || '').toLowerCase().trim();

  if (normNotif === 'new' || normNotif.includes('new') || normNotif === 'lead_new') {
    if (
      normCurrent === 'contacted' ||
      normCurrent.includes('walkthrough') ||
      normCurrent.includes('estimate') ||
      normCurrent === 'won' ||
      normCurrent === 'lost'
    ) {
      return true;
    }
  }

  if (normNotif === 'contacted' || normNotif.includes('contacted') || normNotif === 'lead_contacted') {
    if (
      normCurrent.includes('walkthrough') ||
      normCurrent.includes('estimate') ||
      normCurrent === 'won'
    ) {
      return true;
    }
  }

  if (
    normNotif === 'walkthrough completed' ||
    normNotif.includes('walkthrough completed') ||
    normNotif === 'lead_walkthrough_completed'
  ) {
    if (normCurrent.includes('estimate') || normCurrent === 'won') {
      return true;
    }
  }

  return false;
}

export function SpiderNotificationPopup() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);

  const currentUser = useAuthStore((s) => s.user);
  const inAppEnabled = useSpiderWatcherStore((s) => s.notifications.inApp);
  const assignments = useSpiderWatcherStore((s) => s.assignments);
  const customers = useSpiderWatcherStore((s) => s.customers);
  const selectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const leadStages = useSpiderWatcherStore((s) => s.leadStages);
  const readNotificationIds = useSpiderWatcherStore((s) => s.readNotificationIds);
  const getComputedNotifications = useSpiderWatcherStore((s) => s.getComputedNotifications);
  const selectNotification = useSpiderWatcherStore((s) => s.selectNotification);
  const markReadLocal = useSpiderWatcherStore((s) => s.markRead);
  const markLeadNotificationsRead = useSpiderWatcherStore((s) => s.markLeadNotificationsRead);
  const setInAppNotification = useSpiderWatcherStore((s) => s.setInAppNotification);
  const isWindowOpen = useSpiderWatcherStore((s) => s.isWindowOpen);
  const setIsWindowOpen = useSpiderWatcherStore((s) => s.setIsWindowOpen);

  // Server-persisted notifications query & markRead mutation
  const { data: spiderNotificationsData } = useSpiderNotifications();
  const { data: allNotificationsData } = useNotifications();
  const notificationsData = spiderNotificationsData || allNotificationsData;
  const markReadMutation = useMarkRead();

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 10000);
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  // Server-persisted notifications for Spider (database is single source of truth)
  const serverNotifications = useMemo(() => {
    const pages = notificationsData?.pages;
    if (!pages) return [];
    const allItems = pages.flatMap((p) => p?.items ?? []);
    const spiderItems = allItems.filter(
      (item) => item && (item.verb === 'spider.alert' || (item.category === 'LEAD' && item.title?.startsWith('Spider Alert')))
    );

    return spiderItems.map((item): InAppNotification & { isServerBacked: boolean } => {
      const data = (item.data || {}) as Record<string, any>;
      const leadId = (data.lead_id as string) || (item.object_type === 'LEAD' ? item.object_id : '') || '';
      const leadNumber = (data.lead_number as string) || item.object_label || (leadId && leadId.length > 8 ? `LD-${leadId.substring(0, 6).toUpperCase()}` : leadId) || 'Lead';
      const contactName = (data.customer_name as string) || (data.contactName as string) || 'Customer';
      const companyName = (data.company_name as string) || (data.companyName as string) || contactName;
      const stageName = formatCurrentStageName((data.stage_name as string) || (data.leadStage as string) || 'New');
      const rawMessage = item.body || (data.body as string) || (data.message as string) || item.title;
      const message = formatNotificationMessageReadableTime(rawMessage);
      const serviceLocation = (data.service_location as string) || (data.serviceLocation as string) || '';
      const serviceRequest = (data.service_request as string) || (data.serviceRequest as string) || '';
      const assignedTo = (data.assigned_to as string) || '';
      const rawTimeAgo = formatLastCommunicationTimestamp(item.created_at) || (data.time_in_stage as string) || 'Just now';
      const timeAgo = formatNotificationMessageReadableTime(rawTimeAgo);
      const isRead = Boolean(item.read_at);

      return {
        id: item.id,
        contactName,
        companyName,
        inactiveDays: 0,
        message,
        timeAgo,
        read: isRead,
        contactId: (data.customer_id as string) || '',
        leadId,
        leadNumber,
        leadStage: stageName,
        serviceRequest,
        serviceLocation,
        contactedAt: (data.contacted_at as string) || null,
        createdAt: item.created_at,
        stageEnteredAt:
          (data.stage_entered_at as string) ||
          (data.stageEnteredAt as string) ||
          (data.walkthrough_completed_at as string) ||
          (data.last_visit_completed_at as string) ||
          (data.contacted_at as string) ||
          null,
        lastCommunication: (data.time_in_stage as string) || null,
        isTriggered: true,
        assignedTo,
        assignedToId: null,
        isServerBacked: true,
      };
    });
  }, [notificationsData]);

  const computedNotifications = useMemo(() => {
    return inAppEnabled ? getComputedNotifications(currentUser) : [];
  }, [inAppEnabled, currentUser, assignments, customers, selectedLeadIds, leadStages, readNotificationIds, getComputedNotifications, tick]);

  const activeNotifications = useMemo(() => {
    const map = new Map<string, InAppNotification & { isServerBacked?: boolean }>();

    // 1. Server-persisted notifications are ALWAYS authoritative (database source of truth)
    // Survives Spider deactivation, refresh, close/reopen, and session changes
    for (const sn of serverNotifications) {
      map.set(sn.id, sn);
    }

    // 2. Fall back to local computed notifications when inApp is enabled (e.g. test environments / pre-dispatch)
    if (inAppEnabled) {
      for (const cn of computedNotifications) {
        const hasServerMatch = serverNotifications.some(
          (sn) => sn.leadId === cn.leadId && formatCurrentStageName(sn.leadStage) === formatCurrentStageName(cn.leadStage)
        );
        if (!hasServerMatch && !map.has(cn.id)) {
          map.set(cn.id, cn);
        }
      }
    }

    // 3. Mark stale notifications as read if lead has moved past notification stage
    for (const notif of map.values()) {
      if (notif.leadId && !notif.read) {
        for (const c of customers || []) {
          const matched = c.leads?.find((l) => l.id === notif.leadId);
          if (matched) {
            const currentStage = formatCurrentStageName(matched.stageLabel || matched.stageId);
            if (isSpiderNotificationStale(notif.leadStage || '', currentStage)) {
              notif.read = true;
            }
            break;
          }
        }
      }
    }

    return Array.from(map.values());
  }, [inAppEnabled, serverNotifications, computedNotifications, customers]);

  // Automatically mark stale notifications as read in DB and store
  useEffect(() => {
    if (!activeNotifications.length) return;
    for (const notif of activeNotifications) {
      if (!notif.leadId) continue;
      for (const c of customers || []) {
        const matched = c.leads?.find((l) => l.id === notif.leadId);
        if (matched) {
          const currentStage = formatCurrentStageName(matched.stageLabel || matched.stageId);
          if (isSpiderNotificationStale(notif.leadStage || '', currentStage)) {
            if (!readNotificationIds.includes(notif.id)) {
              markReadLocal(notif.id);
            }
            if (notif.isServerBacked || notif.id) {
              try {
                const res = api.patch(`/api/notifications/${notif.id}/read`);
                if (res && typeof res.catch === 'function') {
                  res.catch(() => {});
                }
              } catch {}
            }
          }
          break;
        }
      }
    }
  }, [activeNotifications, customers, readNotificationIds, markReadLocal]);

  const unreadNotifications = useMemo(() => {
    return activeNotifications.filter((n) => !n.read && !readNotificationIds.includes(n.id));
  }, [activeNotifications, readNotificationIds]);

  const unreadCount = unreadNotifications.length;

  // Close panel when clicking outside
  useEffect(() => {
    if (!isWindowOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsWindowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isWindowOpen, setIsWindowOpen]);

  const handleNotificationClick = async (notif: InAppNotification & { isServerBacked?: boolean }) => {
    selectNotification(notif.id);
    setIsWindowOpen(false);

    let stageName = formatCurrentStageName(notif.leadStage);
    const targetLeadId = notif.leadId;

    if (!targetLeadId) {
      navigate('/leads');
      return;
    }

    // Check if the lead's current stage in store has progressed
    for (const c of customers || []) {
      const matchedLead = c.leads?.find((l) => l.id === targetLeadId);
      if (matchedLead) {
        stageName = formatCurrentStageName(matchedLead.stageLabel || matchedLead.stageId);
        break;
      }
    }

    const notifParam = notif.id ? `&notifId=${encodeURIComponent(notif.id)}` : '';

    // If current stage is Estimate, clicking marks that Estimate notification as read.
    // If current stage is Walkthrough Completed / Contacted / New, keep it unread on click.
    if (stageName === 'Estimate' || (stageName.toLowerCase().includes('estimate') && !stageName.toLowerCase().includes('walkthrough'))) {
      markReadLocal(notif.id);
      if (targetLeadId) {
        markLeadNotificationsRead(targetLeadId, 'walkthrough-completed-estimate');
        markLeadNotificationsRead(targetLeadId, 'estimate');
      }
      if (notif.isServerBacked || notif.id) {
        try {
          api.patch(`/api/notifications/${notif.id}/read`).catch(() => {});
        } catch {}
      }
    }

    // Route based on the lead's CURRENT stage (what stage the lead is stuck in right now)
    if (
      stageName === 'Walkthrough Completed' ||
      stageName === 'Walkthrough' ||
      stageName.toLowerCase().includes('walkthrough completed') ||
      stageName === 'Estimate'
    ) {
      // Lead is currently in the Walkthrough Completed / Estimate stage →
      // Redirect to Lead Overview page
      navigate(`/leads/${targetLeadId}?tab=overview${notifParam}`);
    } else if (stageName === 'Contacted') {
      // Lead is currently in the Contacted stage →
      // Go to Walkthrough tab to schedule a walkthrough
      navigate(`/leads/${targetLeadId}?tab=walkthrough${notifParam}`);
    } else {
      // Lead is currently in the New stage (or unknown) →
      // Go to Communication tab to make first contact
      const draftMsg = encodeURIComponent(
        `Hello ${notif.contactName}, following up regarding your ${notif.serviceRequest || 'service request'} (Stage: ${stageName}).`
      );
      navigate(`/leads/${targetLeadId}?tab=communication&draft=${draftMsg}${notifParam}`);
    }
  };

  // Keep spider icon completely hidden by default. Only display when there is an active/unread notification.
  if (unreadCount === 0) return null;

  return (
    <div ref={panelRef} className="fixed bottom-5 right-5 z-50">
      {/* ── Floating Notification Bell FAB ───────────────────────────── */}
      <Button
        type="button"
        variant="solid"
        tone="ai"
        size={null}
        id="spider-notification-bell-trigger"
        onClick={() => setIsWindowOpen(!isWindowOpen)}
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
        <Avatar className="h-9 w-9 shrink-0 select-none pointer-events-none">
          <AvatarImage
            src="/ai-center/agents/spider.png"
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
      {isWindowOpen && (
        <div
          role="dialog"
          aria-label="Spider Lead Watcher Notifications"
          className="absolute bottom-16 right-0 w-80 sm:w-96 rounded-xl border border-border bg-surface-light shadow-card overflow-hidden animate-in slide-in-from-bottom-3 duration-200"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Avatar className="h-7 w-7 shrink-0">
                <AvatarImage
                  src="/ai-center/agents/spider.png"
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
              onClick={() => setIsWindowOpen(false)}
              className="h-6 w-6 transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Body */}
          <div className="max-h-[300px] overflow-y-auto divide-y divide-border/60 [scrollbar-width:thin] [scrollbar-color:rgba(156,163,175,0.6)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-muted/20 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-text-soft/60">
            {!inAppEnabled ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <BellOff className="h-8 w-8 text-text-soft/60" />
                <p className="text-xs font-medium text-text-secondary">
                  In-App Spider notifications are currently disabled.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setInAppNotification(true);
                    toast({ title: 'Enabled Spider In-App Notifications', duration: 2000 });
                  }}
                >
                  Enable Notifications
                </Button>
              </div>
            ) : activeNotifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-text-soft">
                No Spider lead watcher alerts currently active.
              </p>
            ) : (
              activeNotifications.map((n) => {
                let messageText = '';
                const stageEnteredMs = n.stageEnteredAt ? new Date(n.stageEnteredAt).getTime() : NaN;
                if (!isNaN(stageEnteredMs)) {
                  const elapsedSecs = Math.max(0, Math.floor((Date.now() - stageEnteredMs) / 1000));
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
                      'flex gap-3 p-3.5 transition-colors cursor-pointer hover:bg-background-light group',
                      !n.read ? 'bg-ai-50/40' : 'bg-surface-light'
                    )}
                  >
                    <Avatar className="h-8 w-8 shrink-0 mt-0.5">
                      <AvatarFallback tone="subtle">
                        {n.contactName[0]}
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
