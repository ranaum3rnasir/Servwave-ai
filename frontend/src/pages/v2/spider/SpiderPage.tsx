import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, Lock, Save, SlidersHorizontal } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { cn } from '@/lib/utils';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useAgentStatus, useAgentSwitchControl } from '@/lib/ai-center/agentStatus';
import { AgentSwitch } from '@/components/ai-center/AgentControls';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useUsers } from '@/lib/api/users';
import { spiderErrorText } from '@/lib/spider/errorText';
import {
  SPIDER_CUSTOMERS_QUERY_KEY,
  SPIDER_LEADS_QUERY_KEY,
  SPIDER_STATUS_KEY,
  fetchSpiderCustomersApi,
  fetchSpiderLeadsApi,
  useSaveSpiderSettings,
  useSpiderHistorySummary,
  useSpiderSettings,
  type SpiderSettings,
  type SpiderSettingsInput,
  type SpiderSettingsResponse,
  type SpiderStage,
} from '@/lib/api/spider';
import {
  type AssignmentUserItem,
  type LeadStageConfig,
  type SpiderAssignmentsConfig,
  type SpiderNotificationsConfig,
  type SystemRoleItem,
  type TimeUnit,
  DEFAULT_LEAD_STAGES,
  DEFAULT_SYSTEM_ROLES,
  buildWatcherCustomersFromLive,
  normalizeAssignments,
  selectedLeadsListOf,
} from '@/lib/spider/watcher';
import { readLastViewedHistoryAt, writeLastViewedHistoryAt } from '@/lib/spider/history';
import { useRecordVisit } from '../pageBreadcrumbs';
import { SpiderWatcherConfig } from './SpiderWatcherConfig';
import { SpiderSaveConfirmDialog } from './SpiderSaveConfirmDialog';
import { SpiderHistory } from './SpiderHistory';
import { SpiderStartingSummaryCard } from './SpiderStartingSummaryCard';

/*
 * Spider, the AI Agentic Farm's lead watcher (#2619), laid out as the contractor's sandbox build
 * (`frontend/src/pages/v2/spider/SpiderWatcherPage.tsx` at 3bb6606) as it is (Ran, 15 Oct):
 * his back button, header card, Configuration | History tabs, the "Configuration & Alert Rules"
 * card, his save bar and his save review. Admin-only, behind the Spider gate (spider.routes.tsx).
 * Every setting is loaded from and saved to the server; nothing is kept in the browser.
 *
 * Where it differs from his page (Ran, 15 Oct, D1): the right of the header card carries OUR on/off
 * switch, the same one as in the AI Agentic Farm's pop-up, in place of his "Active ▾" / "Deactivated".
 * Saving never switches Spider on. While Spider is off the page shows a locked panel under the
 * header instead of the tabs (the three-layer ruling, 14 Oct), and asks the server for none of the
 * settings.
 *
 * The starting summary's card (#2794, placement A) sits between the header card and the tabs, only
 * while Spider is on and a summary exists.
 *
 * The draft lives here while Spider is on, so edits not saved yet survive switching between
 * Configuration and History (#2793). Leaving the page, or turning Spider off (which asks first while
 * there are any), drops them.
 */

const SPIDER = AI_AGENTS.find((a) => a.id === 'spider')!;

/** Leads the turn-off question while the Configuration tab holds changes that are not saved yet. */
const UNSAVED_OFF_WARNING = 'The settings changes you have not saved will be lost.';

export default function SpiderPage() {
  useRecordVisit('spider', 'Spider Watcher');
  const setAiCenterOpen = useAiCenterStore((s) => s.setOpen);
  const status = useAgentStatus(SPIDER.id);
  const control = useAgentSwitchControl(SPIDER.id);
  // Turning Spider off locks the page and drops the draft, so the switch asks first while there is one.
  const [unsaved, setUnsaved] = useState(false);

  const handleBackToFarm = () => {
    setAiCenterOpen(true);
  };

  return (
    <div className="w-full space-y-4 -mt-2">
      {/* Back to AI Agentic Farm Action Button placed directly below Dashboard > Spider */}
      <div className="flex items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleBackToFarm}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          AI Agentic Farm
        </Button>
      </div>

      {/* Top Header Card */}
      <div className="rounded-2xl border border-border/80 bg-surface-light p-5 sm:p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          {/* Left info */}
          <div className="flex items-start gap-4">
            <Avatar ring="ai" className="h-16 w-16 shrink-0">
              <AvatarImage src={SPIDER.image} alt="Spider Agent" className="object-contain" />
              <AvatarFallback tone="solid">🕷️</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">
                  Spider
                </h1>
                <span className="rounded-full border border-ai-200 bg-ai-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ai-600">
                  AI Lead Manager
                </span>
                <span className="rounded-full border border-ai-200 bg-ai-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
                  New
                </span>
              </div>
              <p className="text-xs text-text-secondary mt-1">
                Proactively monitor pipeline progression, prevent lead stagnation, and trigger automated multi-channel escalation alerts.
              </p>
            </div>
          </div>

          {/* Right: our on/off switch (D1), in place of his Active / Deactivated control */}
          <div className="flex items-center gap-3 shrink-0">
            <AgentSwitch
              agent={SPIDER}
              status={status}
              control={control}
              unsavedWarning={unsaved ? UNSAVED_OFF_WARNING : undefined}
            />
          </div>
        </div>
      </div>

      {status.status === 'on' ? (
        <>
          <SpiderStartingSummaryCard />
          <SpiderWatcherTabs onUnsavedChange={setUnsaved} />
        </>
      ) : status.status === 'off' ? (
        <SpiderLocked />
      ) : status.status === 'unknown' ? (
        <SpiderStatusError />
      ) : (
        // Until the switch is read: never a flash of the settings, nor of the lock.
        <Skeleton data-spider-page-placeholder aria-hidden className="h-64 w-full rounded-card" />
      )}
    </div>
  );
}

/** Layer 3 while Spider is off: what is behind the lock, and how to open it (the switch above). */
function SpiderLocked() {
  return (
    <Card data-spider-locked>
      <EmptyState
        icon={<Lock aria-hidden />}
        title="Spider is off"
        description="Turn it on to change its settings or see its history."
      />
    </Card>
  );
}

/** The switch could not be read: claim nothing, open nothing, offer to ask again. */
function SpiderStatusError() {
  const qc = useQueryClient();
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-6">
        <p role="alert" className="text-sm text-danger-text">
          Could not load whether Spider is on.
        </p>
        <Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY })}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── The draft, in the contractor's shapes, and the server's ────────────────

interface SpiderDraft {
  notifications: SpiderNotificationsConfig;
  assignments: SpiderAssignmentsConfig;
  leadStages: LeadStageConfig[];
  autoEnrollAllLeads: boolean;
  selectedLeadIds: string[];
}

const UNIT_FROM_SERVER: Record<string, TimeUnit> = { MINUTE: 'Minute', HOUR: 'Hour', DAY: 'Day' };
const UNIT_TO_SERVER: Partial<Record<TimeUnit, string>> = { Minute: 'MINUTE', Hour: 'HOUR', Day: 'DAY' };

/** His stage row labels, by the server's stage key, for naming a server error about one stage. */
const STAGE_LABELS: Record<string, string> = Object.fromEntries(DEFAULT_LEAD_STAGES.map((s) => [s.id, s.label]));

/** His "is this row on" (SpiderWatcherConfig's isEnabled). */
const stageOn = (s: LeadStageConfig) => s.enabled !== false && s.duration !== undefined;

function draftFrom(settings: SpiderSettings): SpiderDraft {
  const ch = settings.channels;
  const rec = settings.recipients;
  return {
    notifications: { email: ch.email, sms: ch.text, inApp: ch.in_app, redFrame: ch.red_frame },
    assignments: normalizeAssignments({ adminRoles: rec.roles, owner: rec.lead_owner, users: rec.user_ids }),
    leadStages: DEFAULT_LEAD_STAGES.map((stage) => {
      const limit = settings.status_limits[stage.id as SpiderStage];
      if (!limit) return stage;
      // A stage that is off shows no value ("None"), as his defaults do.
      return {
        ...stage,
        unit: UNIT_FROM_SERVER[limit.unit] ?? stage.unit,
        duration: limit.enabled ? limit.value : undefined,
        enabled: limit.enabled,
      };
    }),
    autoEnrollAllLeads: settings.watch_all_leads,
    selectedLeadIds: settings.selected_lead_ids,
  };
}

function inputFrom(d: SpiderDraft): SpiderSettingsInput {
  return {
    status_limits: Object.fromEntries(
      d.leadStages.map((s) => {
        const on = stageOn(s) && Number(s.duration) > 0;
        // The value of a stage that is off is never read; 1 keeps the stored row valid.
        return [s.id, { enabled: on, value: on ? Number(s.duration) : 1, unit: UNIT_TO_SERVER[s.unit] ?? 'MINUTE' }];
      }),
    ) as SpiderSettingsInput['status_limits'],
    channels: {
      in_app: !!d.notifications.inApp,
      red_frame: !!d.notifications.redFrame,
      email: !!d.notifications.email,
      text: !!d.notifications.sms,
    },
    recipients: {
      roles: d.assignments.adminRoles as SpiderSettingsInput['recipients']['roles'],
      user_ids: d.assignments.users,
      lead_owner: d.assignments.owner,
    },
    watch_all_leads: d.autoEnrollAllLeads,
    selected_lead_ids: d.selectedLeadIds,
  };
}

const sameInput = (a: SpiderSettingsInput, b: SpiderSettingsInput) => JSON.stringify(a) === JSON.stringify(b);

// ─── Tabs and the Configuration tab ─────────────────────────────────────────

/**
 * The tabs and both panels, mounted only while Spider is on. The draft lives here, so a switch to
 * History and back keeps it.
 */
function SpiderWatcherTabs({ onUnsavedChange }: { onUnsavedChange: (unsaved: boolean) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'config' | 'history'>('config');
  const [isSaved, setIsSaved] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  const save = useSaveSpiderSettings();

  // His History count badge: alerts newer than the last time this browser opened History, kept
  // under his own browser key (Ran, 15 Oct). Counted by the server; read with the page, never polled.
  const [lastViewedHistoryAt, setLastViewedHistoryAt] = useState<number | null>(() => readLastViewedHistoryAt());
  const historySummary = useSpiderHistorySummary(lastViewedHistoryAt);
  const { refetch: refetchHistorySummary } = historySummary;

  // Opening History clears the badge and remembers the visit, as his tab click did.
  const openHistoryTab = () => {
    setActiveTab('history');
    const now = Date.now();
    setLastViewedHistoryAt(now);
    writeLastViewedHistoryAt(now);
  };
  const openConfigTab = () => {
    // Back on Configuration: count again from the moment History was last open.
    if (activeTab === 'history') refetchHistorySummary();
    setActiveTab('config');
  };

  // Calculate count of unread/new logs since user last visited History tab
  const unreadLogsCount = activeTab === 'history' ? 0 : (historySummary.data?.new_since ?? 0);

  // His roles: the four base roles, with his labels (our server takes only these four).
  const availableRoles: SystemRoleItem[] = DEFAULT_SYSTEM_ROLES;

  // System users
  const { data: apiUsers } = useUsers();
  const availableUsers: AssignmentUserItem[] = useMemo(() => {
    if (Array.isArray(apiUsers) && apiUsers.length > 0) {
      return apiUsers.map((u) => {
        const roleMatch = availableRoles.find((r) => r.id === u.role);
        return {
          id: u.id,
          name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
          email: u.email,
          role: u.role,
          roleLabel: roleMatch?.label || u.role,
          avatar_url: u.avatar_url,
        };
      });
    }
    return [];
  }, [apiUsers, availableRoles]);

  // Fetch real leads from API (his query, his cadence: no polling)
  const {
    data: apiLeads,
    isLoading: isLeadsLoading,
    isError: isLeadsError,
    refetch: refetchLeads,
  } = useQuery({
    queryKey: SPIDER_LEADS_QUERY_KEY,
    queryFn: fetchSpiderLeadsApi,
    // Read once per visit (and again after a save): never polled, never on focus.
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  // Fetch real customers from API
  const {
    data: apiCustomers,
    isLoading: isCustomersLoading,
    isError: isCustomersError,
    refetch: refetchCustomers,
  } = useQuery({
    queryKey: SPIDER_CUSTOMERS_QUERY_KEY,
    queryFn: fetchSpiderCustomersApi,
    // Read once per visit (and again after a save): never polled, never on focus.
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  // Take the server's copy whenever a fresh one arrives (first load, and a refetch), unless the
  // draft holds edits not saved yet: a background refetch never overwrites them (#2793). Done while
  // rendering, keyed on the response object.
  const [draft, setDraft] = useState<SpiderDraft | null>(null);
  const [syncedFrom, setSyncedFrom] = useState<SpiderSettingsResponse | undefined>(undefined);
  const serverInput = syncedFrom ? inputFrom(draftFrom(syncedFrom.settings)) : null;
  const unsaved = !!draft && !!serverInput && !sameInput(inputFrom(draft), serverInput);
  // While History is open with nothing unsaved, the settings are not asked for again.
  const settingsQuery = useSpiderSettings({ enabled: activeTab === 'config' || unsaved });
  if (settingsQuery.data && settingsQuery.data !== syncedFrom) {
    setSyncedFrom(settingsQuery.data);
    if (!unsaved) setDraft(draftFrom(settingsQuery.data.settings));
  }

  const settings = settingsQuery.data?.settings;
  const storeCustomers = useMemo(
    // Time in a stage counts from when the lead entered it, as the server counts it (#2794): never
    // from when Spider was switched on.
    () => buildWatcherCustomersFromLive(apiLeads || [], apiCustomers || [], null),
    [apiLeads, apiCustomers],
  );

  useEffect(() => {
    onUnsavedChange(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange]);

  const selectedLeadLabels = useMemo(
    () => Object.fromEntries((syncedFrom?.selected_leads ?? []).map((l) => [l.id, l])),
    [syncedFrom],
  );

  const update = (patch: Partial<SpiderDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setDraftNotifications: React.Dispatch<React.SetStateAction<SpiderNotificationsConfig>> = (u) =>
    setDraft((d) => (d ? { ...d, notifications: typeof u === 'function' ? u(d.notifications) : u } : d));
  const setDraftAssignments: React.Dispatch<React.SetStateAction<SpiderAssignmentsConfig>> = (u) =>
    setDraft((d) => (d ? { ...d, assignments: typeof u === 'function' ? u(d.assignments) : u } : d));

  // "Auto-select new leads" is the server's watch-all flag: while it is on the server watches every
  // lead, so every listed lead is ticked, as his screen showed. Unticking any of them (or Deselect
  // all) turns it off and keeps the rest ticked, saved as the selected leads, so the ticks always
  // match what the server watches.
  const autoSelect = draft?.autoEnrollAllLeads === true;
  const listedLeadIds = useMemo(() => storeCustomers.flatMap((c) => c.leads.map((l) => l.id)), [storeCustomers]);
  const storedSelectedLeadIds = draft?.selectedLeadIds;
  const draftSelectedLeadIds = useMemo(
    () => (autoSelect ? listedLeadIds : (storedSelectedLeadIds ?? [])),
    [autoSelect, listedLeadIds, storedSelectedLeadIds],
  );
  // His selected customers: every customer with a selected lead (the server stores the leads only).
  const draftSelectedCustomerIds = useMemo(
    () => storeCustomers.filter((c) => c.leads.some((l) => draftSelectedLeadIds.includes(l.id))).map((c) => c.id),
    [storeCustomers, draftSelectedLeadIds],
  );

  // His History empty state's "{n} lead targets": the saved selection, counted as the save review
  // counts it (every listed lead while "Auto-select new leads" is on), so the two agree.
  const savedSettings = syncedFrom?.settings;
  const watchedLeads = useMemo(() => {
    if (!savedSettings) return 0;
    const ids = savedSettings.watch_all_leads ? listedLeadIds : savedSettings.selected_lead_ids;
    return selectedLeadsListOf(storeCustomers, ids, selectedLeadLabels).length;
  }, [savedSettings, listedLeadIds, storeCustomers, selectedLeadLabels]);

  /** A change to the ticks: auto-select stays on only while every listed lead is still ticked. */
  const selectLeads = (selectedLeadIds: string[]) =>
    update(autoSelect ? { selectedLeadIds, autoEnrollAllLeads: false } : { selectedLeadIds });

  const updateDraftLeadStage = (id: string, updates: Partial<LeadStageConfig>) => {
    setDraft((d) =>
      d ? { ...d, leadStages: d.leadStages.map((stage) => (stage.id === id ? { ...stage, ...updates } : stage)) } : d,
    );
  };

  const toggleCustomerSelection = (customerId: string, leadIdsForCustomer: string[]) => {
    const allLeadsSelected =
      leadIdsForCustomer.length > 0 &&
      leadIdsForCustomer.every((id) => draftSelectedLeadIds.includes(id));
    const isSelected =
      draftSelectedCustomerIds.includes(customerId) &&
      (leadIdsForCustomer.length === 0 || allLeadsSelected);

    const newLeadIds = isSelected
      ? draftSelectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id))
      : Array.from(new Set([...draftSelectedLeadIds, ...leadIdsForCustomer]));
    selectLeads(newLeadIds);
  };

  const toggleLeadSelection = (leadId: string) => {
    const isLeadSelected = draftSelectedLeadIds.includes(leadId);
    const newLeadIds = isLeadSelected
      ? draftSelectedLeadIds.filter((id) => id !== leadId)
      : [...draftSelectedLeadIds, leadId];
    selectLeads(newLeadIds);
  };

  const selectAllCustomers = () => {
    update({ selectedLeadIds: listedLeadIds });
  };

  const deselectAllCustomers = () => {
    selectLeads([]);
  };

  // Ticking auto-select ticks everything; unticking it on its own keeps every listed lead ticked
  // (and watched), as the selected leads.
  const changeAutoSelect = (enabled: boolean) =>
    update(enabled ? { autoEnrollAllLeads: true } : { autoEnrollAllLeads: false, selectedLeadIds: draftSelectedLeadIds });

  const handleSaveClick = () => {
    setIsConfirmModalOpen(true);
  };

  // Saves the settings only, never the switch (D1). Success is claimed only once the server has
  // accepted the save.
  const handleConfirmSave = () => {
    if (!draft) return;
    setIsConfirmModalOpen(false);
    save.mutate(inputFrom(draft), {
      onSuccess: (data, sent) => {
        setSyncedFrom(data);
        // An edit made while the save was on its way stays, still unsaved.
        setDraft((d) => (d && !sameInput(inputFrom(d), sent) ? d : draftFrom(data.settings)));
        setIsSaved(true);
        toast({
          title: 'Spider Agent Settings Saved',
          description:
            'Notification preferences, assignments, stage thresholds, and lead watchers have been successfully applied.',
          duration: 3000,
        });
        setTimeout(() => setIsSaved(false), 2500);
        queryClient.invalidateQueries({ queryKey: SPIDER_LEADS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: SPIDER_CUSTOMERS_QUERY_KEY });
      },
      onError: (err) => {
        toast({
          title: 'Failed to Save Settings',
          description: spiderErrorText(err, 'Could not save Spider settings to the server.', STAGE_LABELS),
          variant: 'destructive',
          duration: 4000,
        });
      },
    });
  };

  const isConfigError = settingsQuery.isError;

  return (
    <>
      {/* Navigation Tabs: Configuration | History */}
      <div className="flex items-center justify-between border-b border-border px-1">
        <div role="tablist" className="flex items-center gap-6">
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeTab === 'config'}
            aria-label="Configuration Tab"
            onClick={openConfigTab}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openConfigTab();
              }
            }}
            className={cn(
              '-mb-px flex items-center gap-2 pb-2.5 pt-1 px-1 text-sm font-semibold transition-colors border-b-2 cursor-pointer select-none',
              activeTab === 'config'
                ? 'border-brand text-text-primary font-bold'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            <span>Configuration</span>
          </div>
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeTab === 'history'}
            aria-label="History Tab"
            onClick={openHistoryTab}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openHistoryTab();
              }
            }}
            className={cn(
              '-mb-px flex items-center gap-2 pb-2.5 pt-1 px-1 text-sm font-semibold transition-colors border-b-2 cursor-pointer select-none',
              activeTab === 'history'
                ? 'border-brand text-text-primary font-bold'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            <span>History</span>
            {unreadLogsCount > 0 && (
              <span className="rounded-full bg-ai-600 px-2 py-0.5 text-[10px] font-bold text-on-fill shadow-xs animate-in fade-in-0 duration-200">
                {unreadLogsCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tab 1: Configuration */}
      {activeTab === 'config' && (
        <div className="rounded-2xl border border-border/80 bg-surface-light p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 border-b border-border pb-4">
            <SlidersHorizontal className="h-5 w-5 text-ai-600" />
            <div>
              <h2 className="text-base font-bold text-text-primary">Configuration & Alert Rules</h2>
              <p className="text-xs text-text-secondary">
                Configure communication channels, assignees, stage thresholds, and monitored pipeline targets.
              </p>
            </div>
          </div>

          {/* Configuration Error State Banner */}
          {isConfigError && (
            <div className="mb-4 rounded-xl border border-danger-border bg-danger-surface p-4 text-xs text-danger-text flex items-center justify-between gap-3 shadow-xs">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
                <span>Failed to load Spider configuration: {(settingsQuery.error as Error | null)?.message || 'Server error'}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => settingsQuery.refetch()}>
                Retry
              </Button>
            </div>
          )}

          {draft ? (
            <SpiderWatcherConfig
              notifications={draft.notifications}
              setNotifications={setDraftNotifications}
              assignments={draft.assignments}
              setAssignments={setDraftAssignments}
              leadStages={draft.leadStages}
              updateLeadStage={updateDraftLeadStage}
              selectedCustomerIds={draftSelectedCustomerIds}
              selectedLeadIds={draftSelectedLeadIds}
              toggleCustomerSelection={toggleCustomerSelection}
              toggleLeadSelection={toggleLeadSelection}
              selectAllCustomers={selectAllCustomers}
              deselectAllCustomers={deselectAllCustomers}
              storeCustomers={storeCustomers}
              availableRoles={availableRoles}
              availableUsers={availableUsers}
              isLoading={isLeadsLoading || isCustomersLoading}
              isError={isLeadsError || isCustomersError}
              errorMessage={
                isLeadsError && isCustomersError
                  ? 'Failed to load leads and customers from database.'
                  : isLeadsError
                  ? 'Failed to load leads from database.'
                  : isCustomersError
                  ? 'Failed to load customers from database.'
                  : undefined
              }
              onRetry={() => {
                if (isLeadsError) refetchLeads();
                if (isCustomersError) refetchCustomers();
              }}
              autoEnrollNewLeads={draft.autoEnrollAllLeads}
              onAutoEnrollChange={changeAutoSelect}
              isActive
              activatedAt={null}
            />
          ) : (
            !isConfigError && <Skeleton data-spider-config-placeholder aria-hidden className="h-64 w-full rounded-card" />
          )}

          {/* Bottom Save bar */}
          <div className="mt-8 pt-5 border-t border-border flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              Make sure to save changes before leaving the page.
            </p>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="solid"
                tone={isSaved ? 'business' : 'ai'}
                onClick={handleSaveClick}
                className="gap-2 min-w-[120px]"
              >
                {isSaved ? (
                  <>
                    <Check className="h-4 w-4" />
                    Saved
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: History (Structured Notification Logs matching sketch) */}
      {activeTab === 'history' && (
        <SpiderHistory
          isSpiderActive
          watchedLeads={watchedLeads}
          onRefresh={() => refetchHistorySummary()}
        />
      )}

      {/* Spider Save Confirmation Overview Modal */}
      {draft && (
        <SpiderSaveConfirmDialog
          open={isConfirmModalOpen}
          onOpenChange={setIsConfirmModalOpen}
          notifications={draft.notifications}
          assignments={draft.assignments}
          leadStages={draft.leadStages}
          selectedLeadIds={draftSelectedLeadIds}
          selectedCustomerIds={draftSelectedCustomerIds}
          storeCustomers={storeCustomers}
          availableRoles={availableRoles}
          availableUsers={availableUsers}
          autoEnrollAllLeads={draft.autoEnrollAllLeads}
          selectedLeadLabels={selectedLeadLabels}
          onConfirm={handleConfirmSave}
        />
      )}
    </>
  );
}
