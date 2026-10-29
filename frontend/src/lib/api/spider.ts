/**
 * Spider lead watcher (#2619) API. The server is the only source of truth: nothing here is kept
 * in the browser beyond react-query's cache, which sign-out and an identity change clear.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useSpiderAvailable } from '@/lib/spider/gate';
import { spiderErrorText } from '@/lib/spider/errorText';
import { toast } from '@/ui-kit/components/ui/sonner';

export type SpiderStatus = 'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED';
export type SpiderRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';

export interface SpiderStatusLimit {
  enabled: boolean;
  value: number;
  /** One of the units the server lists in `options.units` (Minute, Hour, Day). */
  unit: string;
}

export interface SpiderChannels {
  in_app: boolean;
  red_frame: boolean;
  email: boolean;
  text: boolean;
}

export interface SpiderRecipients {
  roles: SpiderRole[];
  user_ids: string[];
  lead_owner: boolean;
}

export interface SpiderSettings {
  is_active: boolean;
  activated_at: string | null;
  status_limits: Record<SpiderStatus, SpiderStatusLimit>;
  channels: SpiderChannels;
  recipients: SpiderRecipients;
  watch_all_leads: boolean;
  selected_lead_ids: string[];
  updated_at: string | null;
}

export interface SpiderLeadLabel {
  id: string;
  lead_number: string;
  customer_name: string;
}

export interface SpiderOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SpiderSettingsResponse {
  settings: SpiderSettings;
  selected_leads: SpiderLeadLabel[];
  options: {
    statuses: SpiderOption<SpiderStatus>[];
    units: SpiderOption[];
    roles: SpiderOption<SpiderRole>[];
  };
}

/** What the settings form saves: everything but the switch, which only PUT /spider/status changes. */
export type SpiderSettingsInput = Omit<SpiderSettings, 'is_active' | 'activated_at' | 'updated_at'>;

export interface SpiderHistoryItem {
  id: string;
  lead_id: string;
  lead_number: string;
  customer_name: string;
  status: SpiderStatus;
  status_label: string;
  entered_status_at: string;
  alerted_at: string;
  limit: { value: number; unit: string };
  channels: { in_app: string | null; email: string | null; text: string | null };
  recipients: { name: string; email_outcome: string | null; text_outcome: string | null }[];
}

export interface SpiderHistoryResponse {
  items: SpiderHistoryItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface SpiderAlertCard {
  /** The notification-recipient id: PATCH /api/notifications/:id/read marks it read. */
  id: string;
  created_at: string;
  lead_id: string;
  lead_number: string | null;
  customer_name: string | null;
  status: SpiderStatus | null;
  status_label: string | null;
  address: string | null;
  owner_name: string | null;
  entered_status_at: string | null;
  counted_from: string | null;
  time_in_status: string | null;
}

export interface SpiderUnreadResponse {
  alerts: SpiderAlertCard[];
  red_frame: boolean;
}

/**
 * Whether Spider is switched on for the company, and whether it has been set up (at least one
 * watched status with a time limit). The two are independent: an Admin may switch Spider on first
 * and set it up after, and it watches nothing until then. The two facts every role may read.
 */
export interface SpiderOnOff {
  isActive: boolean;
  isSetUp: boolean;
}

export const SPIDER_STATUS_KEY = ['spider', 'status'] as const;
export const SPIDER_SETTINGS_KEY = ['spider', 'settings'] as const;
export const SPIDER_HISTORY_KEY = ['spider', 'history'] as const;
export const SPIDER_UNREAD_KEY = ['spider', 'unread-alerts'] as const;

/** The bell's own cadence (NOTIFICATIONS_POLL_MS), kept equal on purpose. */
export const SPIDER_POLL_MS = 30_000;

export function useSpiderSettings() {
  return useQuery<SpiderSettingsResponse>({
    queryKey: SPIDER_SETTINGS_KEY,
    queryFn: () => api.get('/api/ai-farm/spider/settings').then((r) => r.data),
    staleTime: 0,
  });
}

/**
 * Saving Spider's settings. It never changes the switch. While Spider is off the server refuses the
 * save (409, "Spider is off. Turn it on to change its settings."), which the form shows as it is;
 * the status is then read again, so a page left open after another Admin switched Spider off locks.
 */
export function useSaveSpiderSettings() {
  const qc = useQueryClient();
  return useMutation<SpiderSettingsResponse, unknown, SpiderSettingsInput>({
    mutationFn: (body) => api.put('/api/ai-farm/spider/settings', body).then((r) => r.data),
    onError: (err) => {
      if ((err as { response?: { status?: number } })?.response?.status === 409) {
        qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY });
      }
    },
    onSuccess: (data) => {
      qc.setQueryData(SPIDER_SETTINGS_KEY, data);
      // The AI Agentic Farm's card and pop-up follow the switch at once, then re-read it.
      qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, {
        isActive: data.settings.is_active === true,
        isSetUp: Object.values(data.settings.status_limits ?? {}).some((l) => l?.enabled),
      });
      qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_UNREAD_KEY });
    },
  });
}

/**
 * Whether Spider is switched on (and set up) for the signed-in person's company, for any role.
 * Asks only for a company that passes the Spider gate (and only when `enabled`). An answer that is
 * not two plain yes-or-no values is an error, so a server that does not know the route (or an older
 * one that does not say whether Spider is set up) never reads as "on" or "not set up".
 */
export function useSpiderStatus({ enabled = true }: { enabled?: boolean } = {}) {
  const available = useSpiderAvailable();
  return useQuery<SpiderOnOff>({
    queryKey: SPIDER_STATUS_KEY,
    queryFn: async () => {
      const r = await api.get('/api/ai-farm/spider/status', { silentErrors: true });
      if (typeof r.data?.isActive !== 'boolean' || typeof r.data?.isSetUp !== 'boolean') {
        throw new Error('Unexpected Spider status');
      }
      return { isActive: r.data.isActive, isSetUp: r.data.isSetUp };
    },
    enabled: available && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

const SWITCH_FAILED = 'Could not switch Spider on or off.';

/**
 * An Admin switching Spider on or off from the AI Agentic Farm, set up or not. Only the one switch
 * is sent; the statuses, limits and recipients stay as they are. The switch moves at once (the
 * cached status is updated before the server answers) and moves back if the save fails, with the
 * server's own sentence as the error, never a field name. Afterwards both the status and the
 * Spider page's settings are read again, so an open settings form shows the new switch. A success
 * says nothing extra: the switch is its own confirmation.
 */
export function useSetSpiderActive() {
  const qc = useQueryClient();
  return useMutation<SpiderOnOff, unknown, boolean, { previous: SpiderOnOff | undefined }>({
    mutationFn: async (isActive) => {
      // silentErrors: this hook says what went wrong itself, so the global error toast stays out.
      const r = await api.put('/api/ai-farm/spider/status', { isActive }, { silentErrors: true });
      if (typeof r.data?.isActive !== 'boolean' || typeof r.data?.isSetUp !== 'boolean') {
        throw new Error('Unexpected Spider status');
      }
      return { isActive: r.data.isActive, isSetUp: r.data.isSetUp };
    },
    onMutate: async (isActive) => {
      await qc.cancelQueries({ queryKey: SPIDER_STATUS_KEY });
      const previous = qc.getQueryData<SpiderOnOff>(SPIDER_STATUS_KEY);
      // Switching never sets Spider up: that stays as it was.
      qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, { isActive, isSetUp: previous?.isSetUp ?? false });
      return { previous };
    },
    onError: (err, _isActive, context) => {
      // The switch is only shown once the status has been read, so there is always one to restore.
      if (context?.previous) qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, context.previous);
      toast.error(spiderErrorText(err, SWITCH_FAILED));
    },
    // No success toast: the switch, the pop-up's status line (a polite live region) and the card
    // strip already show the new state, and on a phone a toast would cover the pop-up's header.
    onSuccess: (data) => {
      qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, data);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_UNREAD_KEY });
    },
  });
}

export function useSpiderHistory(page: number, pageSize = 25) {
  return useQuery<SpiderHistoryResponse>({
    queryKey: [...SPIDER_HISTORY_KEY, page, pageSize],
    queryFn: () =>
      api.get('/api/ai-farm/spider/history', { params: { page, page_size: pageSize } }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
}

/**
 * The signed-in person's own unread Spider alerts. Polls on the bell's 30-second cadence and,
 * like the bell, not while the tab is hidden (react-query pauses interval refetches in the
 * background). Only ever mounted behind the Spider gate.
 */
export function useSpiderUnreadAlerts() {
  return useQuery<SpiderUnreadResponse>({
    queryKey: SPIDER_UNREAD_KEY,
    queryFn: () =>
      api
        .get('/api/ai-farm/spider/alerts/unread', { silentErrors: true })
        .then((r) => ({ alerts: r.data?.alerts ?? [], red_frame: r.data?.red_frame === true })),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: SPIDER_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Marks one alert read through the existing notification read endpoint. */
export function useMarkSpiderAlertRead() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    mutationFn: (recipientId) => api.patch(`/api/notifications/${recipientId}/read`).then((r) => r.data),
    onMutate: (recipientId) => {
      qc.setQueryData<SpiderUnreadResponse>(SPIDER_UNREAD_KEY, (prev) =>
        prev ? { ...prev, alerts: prev.alerts.filter((a) => a.id !== recipientId) } : prev,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: SPIDER_UNREAD_KEY });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
