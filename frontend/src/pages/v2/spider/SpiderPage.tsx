import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Clock, Eye, Save, SlidersHorizontal } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { useAgentStatus, useAgentDeactivateControl, type AgentStatus, type AgentDeactivateControl } from '@/lib/ai-center/agentStatus';
import { DeactivateConfirm } from '@/components/ai-center/AgentControls';
import { AgentStatusChip } from '@/components/ai-center/AgentStatusChip';
import { HelpIcon } from '@/components/permissions/HelpIcon';
import { extractApiError } from '@/lib/utils';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useUsers } from '@/lib/api/users';
import { spiderErrorText } from '@/lib/spider/errorText';
import {
  SPIDER_ACTIVATION_PREVIEW_KEY,
  SPIDER_STATUS_KEY,
  useActivateSpider,
  useSaveSpiderExclusions,
  useSaveSpiderSettings,
  useSpiderActivationPreview,
  useSpiderHistorySummary,
  useSpiderPickerOverview,
  useSpiderSettings,
  type SpiderSettings,
  type SpiderSettingsInput,
  type SpiderSettingsResponse,
  type SpiderActivationPreview,
  type SpiderStage,
  type SpiderStartingSummaryChoice,
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
  normalizeAssignments,
} from '@/lib/spider/watcher';
import { readLastViewedHistoryAt, writeLastViewedHistoryAt } from '@/lib/spider/history';
import { useRecordVisit } from '../pageBreadcrumbs';
import { SpiderWatcherConfig } from './SpiderWatcherConfig';
import { SpiderLeadPicker, type SpiderExclusionChange, type SpiderLeadTick } from './SpiderLeadPicker';
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
 * Spider works like an integration (Ran, 10 Nov; #3432, mockup M1): the page opens whether Spider is
 * Not active or Active, so its settings are checked before anything runs. The header's right side
 * shows the status (Not active / Active) and, for an Admin, Activate or Deactivate:
 *   - Not active: Save keeps the settings and starts nothing (PUT /spider/settings, then the picker's
 *     PATCH /spider/exclusions when there are ticks not saved; #3436). Activate,
 *     greyed out until at least one status has a time limit, opens the review with the "When you
 *     activate" box (the server's numbers and the Send / Skip choice) and sends PUT /spider/status.
 *   - Active: Save opens the review as before, without the box. Deactivate asks first, then works at
 *     once; the settings and the draft stay on the page.
 *
 * The starting summary's card (#2794, placement A) sits between the header card and the tabs, only
 * while Spider is Active and a summary exists.
 *
 * The draft lives in the page, so edits not saved yet survive switching between Configuration and
 * History (#2793), and Activate or Deactivate. Leaving the page drops them.
 */

const SPIDER = AI_AGENTS.find((a) => a.id === 'spider')!;

/** The ? beside "Not active" (mockup M1, word for word). */
export const SPIDER_NOT_ACTIVE_HELP = 'Spider watches nothing and sends nothing. Check the settings, then press Activate.';

export default function SpiderPage() {
  useRecordVisit('spider', 'Spider Watcher');
  const setAiCenterOpen = useAiCenterStore((s) => s.setOpen);
  const status = useAgentStatus(SPIDER.id);
  const control = useAgentDeactivateControl(SPIDER.id);

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

      {status.status === 'active' || status.status === 'not_active' ? (
        // Mounted once the status is read, and kept mounted across Activate and Deactivate, so the
        // draft and the open tab stay.
        <SpiderWatcherTabs status={status} control={control} isActive={status.status === 'active'} />
      ) : (
        <>
          <SpiderHeader
            actions={
              status.status === 'loading' ? (
                <Skeleton data-spider-status="loading" aria-hidden className="h-9 w-48 rounded-full" />
              ) : null
            }
          />
          {status.status === 'unknown' ? (
            <SpiderStatusError />
          ) : (
            // Until the status is read: never a flash of the settings, nor of a status it may not have.
            <Skeleton data-spider-page-placeholder aria-hidden className="h-64 w-full rounded-card" />
          )}
        </>
      )}
    </div>
  );
}

/** His header card; its right side (`actions`) carries the status and Activate / Deactivate. */
function SpiderHeader({ actions }: { actions: ReactNode }) {
  return (
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

        {/* Right: the status and, for an Admin, Activate / Deactivate (mockup M1) */}
        {actions && <div data-spider-status-actions className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * The header's status: the Not active / Active badge with no second line, and for someone who may
 * manage Spider, Activate (with the ? hover) or Deactivate. Everyone else sees the badge alone.
 */
function SpiderStatusActions({
  status,
  control,
  isActive,
  canActivate,
  activating,
  onActivate,
}: {
  status: AgentStatus;
  control: AgentDeactivateControl;
  isActive: boolean;
  canActivate: boolean;
  activating: boolean;
  onActivate: () => void;
}) {
  const [confirmOff, setConfirmOff] = useState(false);
  const badge = <AgentStatusChip state={isActive ? 'active' : 'not_active'} />;
  const setActive = control.setActive;
  if (!status.canManage || !setActive) return badge;
  if (isActive) {
    return (
      <>
        {badge}
        <Button
          type="button"
          variant="outline"
          tone="danger"
          disabled={control.saving}
          onClick={() => setConfirmOff(true)}
        >
          Deactivate
        </Button>
        <DeactivateConfirm
          name={SPIDER.name}
          warning={status.copy?.deactivateWarning ?? []}
          open={confirmOff}
          onOpenChange={setConfirmOff}
          onConfirm={() => {
            setConfirmOff(false);
            setActive(false);
          }}
        />
      </>
    );
  }
  return (
    <>
      {badge}
      <HelpIcon label="Not active" text={SPIDER_NOT_ACTIVE_HELP} />
      <Button
        type="button"
        variant="solid"
        tone="ai"
        disabled={!canActivate || activating || control.saving}
        onClick={onActivate}
        className="gap-1.5"
      >
        <CheckCircle2 className="h-4 w-4" />
        Activate
      </Button>
    </>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The "When you activate" box at the top of the review Activate opens (mockup M1, word for word):
 * what Spider will watch and how many leads are already past their limit, from the server's
 * activation preview, then the choice for those leads, with Send preselected.
 */
function SpiderActivationBox({
  preview,
  isError,
  error,
  onRetry,
  choice,
  onChoice,
}: {
  preview: SpiderActivationPreview | undefined;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  choice: SpiderStartingSummaryChoice;
  onChoice: (choice: SpiderStartingSummaryChoice) => void;
}) {
  const options: { value: SpiderStartingSummaryChoice; title: string; detail: string }[] = [
    {
      value: 'send',
      title: 'Send one starting summary of them',
      detail: `To ${plural(preview?.summaryRecipients ?? 0, 'person', 'people')}, a few minutes after you activate.`,
    },
    {
      value: 'skip',
      title: 'Skip them',
      detail: 'Alert only on leads that pass their time limit from now on.',
    },
  ];
  return (
    <section
      data-spider-activation-box
      aria-labelledby="spider-activation-box-title"
      className="rounded-xl border border-ai-200 bg-ai-50/60 p-4 shadow-xs"
    >
      <p id="spider-activation-box-title" className="mb-2 text-sm font-extrabold text-text-primary">
        When you activate
      </p>
      {isError ? (
        // The numbers could not be read: claim none, offer to ask again (Activate waits for them).
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs text-danger-text">
            {extractApiError(error, 'Could not load the Spider review')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : !preview ? (
        <div data-spider-activation-loading aria-hidden className="space-y-2">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="mt-3 h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : (
        <>
          <ul className="grid gap-2">
            <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-1.5 text-[13px] leading-snug text-text-secondary">
              <Eye aria-hidden className="mt-0.5 h-[15px] w-[15px] text-ai-600" />
              <span className="min-w-0">
                Spider watches <b className="text-text-primary">{plural(preview.watchedLeads, 'open lead', 'open leads')}</b> and
                every new lead. {preview.excludedLeads.toLocaleString()} {preview.excludedLeads === 1 ? 'is' : 'are'} excluded.
              </span>
            </li>
            <li className="grid grid-cols-[20px_minmax(0,1fr)] gap-1.5 text-[13px] leading-snug text-text-secondary">
              <Clock aria-hidden className="mt-0.5 h-[15px] w-[15px] text-ai-600" />
              <span className="min-w-0">
                <b className="text-text-primary">{preview.pastLimitLeads.toLocaleString()}</b> of them{' '}
                {preview.pastLimitLeads === 1 ? 'is' : 'are'} already past their time limit.
              </span>
            </li>
          </ul>
          <div role="radiogroup" aria-label="Leads already past their time limit" className="mt-3 grid gap-2">
            {options.map((o) => {
              const selected = choice === o.value;
              return (
                <label
                  key={o.value}
                  className={cn(
                    'grid cursor-pointer grid-cols-[20px_minmax(0,1fr)] gap-2 rounded-lg border bg-surface-light px-3 py-2.5 text-[13px] leading-snug transition-colors',
                    selected ? 'border-ai-600 ring-1 ring-ai-600' : 'border-border',
                  )}
                >
                  <input
                    type="radio"
                    name="spider-starting-summary"
                    value={o.value}
                    checked={selected}
                    onChange={() => onChoice(o.value)}
                    className="mt-0.5 h-4 w-4 accent-ai-600"
                  />
                  <span className="min-w-0">
                    <b className="text-text-primary">{o.title}</b>
                    <small className="mt-0.5 block text-xs text-text-secondary">{o.detail}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** The status could not be read: claim nothing, open nothing, offer to ask again. */
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
}

/** The picker's changes not saved yet, by lead id (#3436): each differs from what the server holds. */
type ExclusionChanges = Record<string, SpiderExclusionChange>;

/** The changes after some ticks: a tick back to what the server holds drops the change. */
function applyTicks(changes: ExclusionChanges, ticks: readonly SpiderLeadTick[]): ExclusionChanges {
  const next = { ...changes };
  for (const t of ticks) {
    if (t.excluded === t.serverExcluded) delete next[t.leadId];
    else next[t.leadId] = { excluded: t.excluded, customerId: t.customerId ?? next[t.leadId]?.customerId ?? null };
  }
  return next;
}

/** The one PATCH /spider/exclusions body for these changes. */
function exclusionBody(changes: ExclusionChanges) {
  const entries = Object.entries(changes);
  return {
    exclude: entries.filter(([, c]) => c.excluded).map(([id]) => id),
    include: entries.filter(([, c]) => !c.excluded).map(([id]) => id),
  };
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
  };
}

/** The draft as a save body. The leads Spider watches are not in it: the picker's Save sends those (#3436). */
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
  };
}

const sameInput = (a: SpiderSettingsInput, b: SpiderSettingsInput) => JSON.stringify(a) === JSON.stringify(b);

/** The server's own sentence for a failed request, or nothing when it sent none: never a sentence made up here. */
function serverSentence(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: unknown; details?: unknown[] } } })?.response?.data;
  if (!data || (typeof data.error !== 'string' && !data.details?.length)) return undefined;
  return spiderErrorText(err, '', STAGE_LABELS) || undefined;
}

// ─── Tabs and the Configuration tab ─────────────────────────────────────────

/**
 * The header's status and buttons, the tabs and both panels, mounted once Spider's status is read,
 * Not active or Active. The draft lives here, so a switch to History and back, and Activate or
 * Deactivate, keep it.
 */
function SpiderWatcherTabs({
  status,
  control,
  isActive,
}: {
  status: AgentStatus;
  control: AgentDeactivateControl;
  isActive: boolean;
}) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'config' | 'history'>('config');
  const [isSaved, setIsSaved] = useState(false);
  // Which review is open: Save's (while Active) or Activate's (with the "When you activate" box).
  const [review, setReview] = useState<'save' | 'activate' | null>(null);
  const [startingSummary, setStartingSummary] = useState<SpiderStartingSummaryChoice>('send');
  // Activate with unsaved edits saves them first, so the review's numbers are the server's for them.
  const [preparingActivate, setPreparingActivate] = useState(false);

  const qc = useQueryClient();
  const save = useSaveSpiderSettings();
  const activate = useActivateSpider();
  const preview = useSpiderActivationPreview({ enabled: review === 'activate' });
  // The review's Activate waits for numbers read for THIS opening, and stays greyed out while they show their error.
  const previewReady = !!preview.data && !preview.isFetching && !preview.isError;

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

  // "Select Contacts for Alert" (#3436, mockup M2): the header's numbers, read with the page; the lists page themselves.
  const overview = useSpiderPickerOverview();
  const saveExclusions = useSaveSpiderExclusions();
  const navigate = useNavigate();
  const setAiCenterOpen = useAiCenterStore((st) => st.setOpen);
  // The picker's ticks not saved yet (Ran, 10 Nov, Q4 A: ticks wait for Save). They live here, so they survive History
  // and back, and Activate or Deactivate, like the rest of the draft.
  const [exclusionChanges, setExclusionChanges] = useState<ExclusionChanges>({});
  const changeCount = Object.keys(exclusionChanges).length;

  // Take the server's copy whenever a fresh one arrives (first load, and a refetch), unless the
  // draft holds edits not saved yet: a background refetch never overwrites them (#2793). Done while
  // rendering, keyed on the response object.
  const [draft, setDraft] = useState<SpiderDraft | null>(null);
  const [syncedFrom, setSyncedFrom] = useState<SpiderSettingsResponse | undefined>(undefined);
  const serverInput = syncedFrom ? inputFrom(draftFrom(syncedFrom.settings)) : null;
  const settingsUnsaved = !!draft && !!serverInput && !sameInput(inputFrom(draft), serverInput);
  const unsaved = settingsUnsaved || changeCount > 0;
  // While History is open with nothing unsaved, the settings are not asked for again.
  const settingsQuery = useSpiderSettings({ enabled: activeTab === 'config' || settingsUnsaved });
  if (settingsQuery.data && settingsQuery.data !== syncedFrom) {
    setSyncedFrom(settingsQuery.data);
    if (!settingsUnsaved) setDraft(draftFrom(settingsQuery.data.settings));
  }

  const setDraftNotifications: React.Dispatch<React.SetStateAction<SpiderNotificationsConfig>> = (u) =>
    setDraft((d) => (d ? { ...d, notifications: typeof u === 'function' ? u(d.notifications) : u } : d));
  const setDraftAssignments: React.Dispatch<React.SetStateAction<SpiderAssignmentsConfig>> = (u) =>
    setDraft((d) => (d ? { ...d, assignments: typeof u === 'function' ? u(d.assignments) : u } : d));

  // The open leads Spider watches now (the header's N), and once the changes not saved yet are saved (the review's).
  const watchedNow = overview.data?.watched;
  const watchedAfterSave = useMemo(() => {
    if (watchedNow === undefined) return undefined;
    const changes = Object.values(exclusionChanges);
    return watchedNow - changes.filter((c) => c.excluded).length + changes.filter((c) => !c.excluded).length;
  }, [watchedNow, exclusionChanges]);

  const updateDraftLeadStage = (id: string, updates: Partial<LeadStageConfig>) => {
    setDraft((d) =>
      d ? { ...d, leadStages: d.leadStages.map((stage) => (stage.id === id ? { ...stage, ...updates } : stage)) } : d,
    );
  };

  const handleOpenLead = (leadId: string) => {
    setAiCenterOpen(false);
    navigate(`/leads/${leadId}`);
  };

  const showSaveError = (err: unknown) => {
    toast({
      title: 'Failed to Save Settings',
      description: spiderErrorText(err, 'Could not save Spider settings to the server.', STAGE_LABELS),
      variant: 'destructive',
      duration: 4000,
    });
  };

  /**
   * The page's one Save: the settings (PUT /spider/settings), then, only when there are ticks not saved, the picker's
   * changes in one PATCH /spider/exclusions. The settings go first: they are what the server can refuse (its required
   * checks, or Spider activated or deactivated meanwhile), and a refused save then stores nothing at all. Both have
   * landed before this resolves, so the Activate review read after it counts what was saved. Never Active / Not active.
   * Success is claimed only once the server has accepted both; `quiet` leaves out the "Saved" toast and button (the save
   * Activate makes before its review). Resolves whether it was saved.
   */
  const saveDraft = async ({ quiet = false }: { quiet?: boolean } = {}): Promise<boolean> => {
    if (!draft) return false;
    const saving = draft;
    const sent = inputFrom(saving);
    let data: SpiderSettingsResponse;
    try {
      data = await save.mutateAsync(sent);
    } catch (err) {
      showSaveError(err);
      return false;
    }
    setSyncedFrom(data);
    // An edit made while the save was on its way stays, still unsaved.
    setDraft((d) => (!d || d === saving || sameInput(inputFrom(d), sent) ? draftFrom(data.settings) : d));
    const sentChanges = exclusionChanges;
    if (Object.keys(sentChanges).length > 0) {
      try {
        await saveExclusions.mutateAsync(exclusionBody(sentChanges));
      } catch (err) {
        // The settings are saved; the ticks are not, and stay on the page as changes not saved. Never "Failed to Save
        // Settings" for settings that were saved; the server's own sentence, when it sent one, says why.
        toast({
          title: 'Settings saved, but the lead changes did not save. Try again.',
          description: serverSentence(err),
          variant: 'destructive',
          duration: 4000,
        });
        return false;
      }
      // A tick made while the save was on its way stays, still unsaved.
      setExclusionChanges((now) => {
        const left: ExclusionChanges = {};
        for (const [id, c] of Object.entries(now)) {
          const was = sentChanges[id];
          if (!was || was.excluded !== c.excluded) left[id] = c;
        }
        return left;
      });
    }
    if (!quiet) {
      setIsSaved(true);
      toast({
        title: 'Spider Agent Settings Saved',
        description:
          'Notification preferences, assignments, stage thresholds, and lead watchers have been successfully applied.',
        duration: 3000,
      });
      setTimeout(() => setIsSaved(false), 2500);
    }
    return true;
  };

  // Active: Save opens his review first. Not active: Save keeps the settings and starts nothing, so
  // it saves straight away (#3432).
  const handleSaveClick = () => {
    if (isActive) setReview('save');
    else void saveDraft();
  };

  // Confirming Save's review saves the settings only, never Active / Not active.
  const handleConfirmSave = () => {
    setReview(null);
    void saveDraft();
  };

  // Activate is greyed out until at least one status has a time limit (the server refuses it too).
  const canActivate = !!draft && draft.leadStages.some((s) => stageOn(s) && Number(s.duration) > 0);

  // Activate opens the review with the "When you activate" box. Edits not saved yet are saved first
  // (that starts nothing while Not active), so the box's numbers and the review are what activates.
  const handleActivateClick = async () => {
    if (!canActivate || preparingActivate) return;
    if (unsaved) {
      setPreparingActivate(true);
      const ok = await saveDraft({ quiet: true });
      setPreparingActivate(false);
      if (!ok) return;
    }
    setStartingSummary('send');
    // Forget the last opening's numbers: the box waits for fresh ones, never shows the old ones meanwhile.
    void qc.resetQueries({ queryKey: SPIDER_ACTIVATION_PREVIEW_KEY, exact: true });
    setReview('activate');
  };

  const handleConfirmActivate = () => {
    setReview(null);
    activate.mutate(startingSummary);
  };

  const isConfigError = settingsQuery.isError;

  return (
    <>
      <SpiderHeader
        actions={
          <SpiderStatusActions
            status={status}
            control={control}
            isActive={isActive}
            canActivate={canActivate}
            activating={preparingActivate || activate.isPending}
            onActivate={() => void handleActivateClick()}
          />
        }
      />

      {isActive && <SpiderStartingSummaryCard />}

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
              availableRoles={availableRoles}
              availableUsers={availableUsers}
              leadPicker={
                <SpiderLeadPicker
                  overview={overview.data}
                  overviewFailed={overview.isError}
                  onRetryOverview={() => void overview.refetch()}
                  changes={exclusionChanges}
                  onTicks={(ticks) => setExclusionChanges((c) => applyTicks(c, ticks))}
                  onOpenLead={handleOpenLead}
                />
              }
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
              {changeCount > 0 && (
                // Ran, 10 Nov (Q4 A): ticks wait for Save (mockup M2).
                <p data-spider-unsaved-ticks className="text-[12.5px] text-text-secondary" aria-live="polite">
                  <span className="font-bold text-warning-text">
                    {changeCount.toLocaleString()} {changeCount === 1 ? 'change' : 'changes'} not saved.
                  </span>{' '}
                  Ticks count when you press Save.
                </p>
              )}
              <Button
                type="button"
                variant="solid"
                tone={isSaved ? 'business' : 'ai'}
                onClick={handleSaveClick}
                // Activate is on its way: a save now would change the settings it was reviewed on (M3).
                disabled={activate.isPending}
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
          isSpiderActive={isActive}
          watchedLeads={watchedNow}
          onRefresh={() => refetchHistorySummary()}
        />
      )}

      {/* Spider Save Confirmation Overview Modal: Save's (Active) or Activate's (Not active) */}
      {draft && (
        <SpiderSaveConfirmDialog
          open={review !== null}
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          notifications={draft.notifications}
          assignments={draft.assignments}
          leadStages={draft.leadStages}
          watchedLeads={watchedAfterSave}
          availableRoles={availableRoles}
          availableUsers={availableUsers}
          onConfirm={review === 'activate' ? handleConfirmActivate : handleConfirmSave}
          activation={
            review === 'activate' ? (
              <SpiderActivationBox
                preview={preview.data}
                isError={preview.isError}
                error={preview.error}
                onRetry={() => void preview.refetch()}
                choice={startingSummary}
                onChoice={setStartingSummary}
              />
            ) : undefined
          }
          confirmDisabled={review === 'activate' && !previewReady}
        />
      )}
    </>
  );
}
