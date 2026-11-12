/**
 * Spider lead watcher (#2619) API. The server is the only source of truth: nothing here is kept
 * in the browser beyond react-query's cache, which sign-out and an identity change clear.
 */
import { SPIDER_UNREAD_KEY } from '@/lib/api/shared/queryKeys';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useSpiderAvailable } from '@/lib/spider/gate';
import { spiderErrorText } from '@/lib/spider/errorText';
import { toast } from '@/ui-kit/components/ui/sonner';

/** A lead status an alert was raised for. Alerts from before 15 Oct may carry the two retired ones. */
export type SpiderStatus = 'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED';
/** The three stages Spider acts on (Ran, 15 Oct, D2), keyed by the lead status each is named after. */
export type SpiderStage = 'NEW' | 'CONTACTED' | 'WALKTHROUGH_COMPLETED';
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
  status_limits: Record<SpiderStage, SpiderStatusLimit>;
  channels: SpiderChannels;
  recipients: SpiderRecipients;
  updated_at: string | null;
}

export interface SpiderOption<V extends string = string> {
  value: V;
  label: string;
}

/** The settings carry no lead list (#3436): the picker reads the leads a page at a time. */
export interface SpiderSettingsResponse {
  settings: SpiderSettings;
  options: {
    statuses: SpiderOption<SpiderStage>[];
    units: SpiderOption[];
    roles: SpiderOption<SpiderRole>[];
  };
}

/** What the settings form saves: everything but the switch, which only PUT /spider/status changes. */
export type SpiderSettingsInput = Omit<SpiderSettings, 'is_active' | 'activated_at' | 'updated_at'>;

export type SpiderChannelStatus = 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * One channel's outcome as the contractor's alert log stored it. `error` is the first failure in his
 * wording; `skip_reason` the first skip's reason. `from` on email only.
 */
export interface SpiderHistoryChannel {
  enabled: boolean;
  status: SpiderChannelStatus;
  sent: number;
  skipped: number;
  failed: number;
  error: string | null;
  skip_reason: string | null;
  from?: string;
}

export interface SpiderHistoryRecipient {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  /** owner / user / admin; null on alerts raised before the History copy was kept. */
  type: string | null;
}

/**
 * One History row. A channel, outcome, stage or time the server cannot tell is null, never "Sent"
 * or "New" (an older server sends none of the contractor's fields).
 */
export interface SpiderHistoryItem {
  id: string;
  lead_id: string;
  lead_number: string;
  customer_id: string | null;
  customer_name: string;
  company_name: string | null;
  service_request: string | null;
  service_location: string | null;
  status: SpiderStatus;
  stage_name: string | null;
  /** Time in the stage when the alert went out, in the limit's unit (MINUTE / HOUR / DAY). */
  elapsed: { value: number; unit: string } | null;
  alerted_at: string;
  outcome: 'SENT' | 'PARTIAL' | 'FAILED' | 'SKIPPED' | null;
  /** The contractor's per-channel outcome (the server's `outcomes`). */
  outcomes: {
    email: SpiderHistoryChannel | null;
    sms: SpiderHistoryChannel | null;
    in_app: { enabled: boolean; status: 'SENT' | 'SKIPPED' } | null;
  };
  recipients: SpiderHistoryRecipient[];
  /** Reported in a starting summary rather than alerted on its own (#2794); false from an older server. */
  in_starting_summary: boolean;
  /** The texts that went out; null on alerts raised before they were kept. */
  email_subject: string | null;
  email_body: string | null;
  sms_message: string | null;
  in_app_message: string | null;
}

export interface SpiderHistoryResponse {
  items: SpiderHistoryItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** The contractor's toolbar, as the History request's body. Lists travel as arrays, never in the URL. */
export interface SpiderHistoryParams {
  search?: string;
  stage?: string[];
  ranges?: string[];
  recipients?: string[];
  customers?: string[];
  roles?: string[];
}

export interface SpiderHistorySummary {
  total: number;
  /** Alerts newer than the `since` asked for (all of them without one). */
  new_since: number;
}

export interface SpiderHistoryFilterOptions {
  recipients: SpiderOption[];
  customers: SpiderOption[];
}

export interface SpiderHistoryExport {
  items: SpiderHistoryItem[];
  total: number;
  truncated: boolean;
}

/** One unread Spider alert, as the contractor's popup card shows it (stored at alert time). */
export interface SpiderAlertCard {
  /** The notification-recipient id: PATCH /api/notifications/:id/read marks it read. */
  id: string;
  /** When the alert was raised (the card's "time ago"). */
  created_at: string;
  lead_id: string;
  lead_number: string | null;
  customer_name: string | null;
  company_name: string | null;
  /** The stage the alert was raised for: NEW, CONTACTED or WALKTHROUGH_COMPLETED. */
  status: SpiderStatus | null;
  /** His label for that stage: "New", "Contacted" or "Walkthrough Completed". */
  stage_name: string | null;
  /** The lead's stage now, which his click routes on ("Estimate" once the lead is Estimate Sent). */
  current_stage: string | null;
  service_location: string | null;
  service_request: string | null;
  assigned_to: string | null;
  /** When the lead entered the stage: the card's sentence counts from here (New: see lead_created_at). */
  stage_entered_at: string | null;
  /**
   * When the lead was created: the New sentence ("This lead was created X ago") counts from here, so it stays true
   * for a lead moved back to New (SPEC-4 D7). Null on an alert raised before it was stored.
   */
  lead_created_at: string | null;
  /** The stage sentence written at alert time. */
  message: string | null;
}

export interface SpiderUnreadResponse {
  alerts: SpiderAlertCard[];
  /** The company's in-app channel: off shows his "currently disabled" panel. */
  in_app: boolean;
  red_frame: boolean;
  /**
   * Whether the red frame shows now: its switch is on and an in-app alert or a red-frame-only record
   * (in-app alerts off) is open for this person. Absent from an older server.
   */
  frame?: boolean;
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

/** The bell's own cadence (NOTIFICATIONS_POLL_MS), kept equal on purpose. */
export const SPIDER_POLL_MS = 30_000;

/** `enabled: false` keeps the copy already read but asks the server for nothing more. */
export function useSpiderSettings({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<SpiderSettingsResponse>({
    queryKey: SPIDER_SETTINGS_KEY,
    queryFn: () => api.get('/api/ai-farm/spider/settings').then((r) => r.data),
    staleTime: 0,
    enabled,
  });
}

/**
 * Saving Spider's settings, Active or Not active (#3432). It never activates or deactivates Spider. When
 * Spider is activated or deactivated while the save is on its way the server refuses it (409, its own
 * sentence), which the form shows as it is; the status is then read again.
 */
export function useSaveSpiderSettings() {
  const qc = useQueryClient();
  return useMutation<SpiderSettingsResponse, unknown, SpiderSettingsInput>({
    // silentErrors: the page says what went wrong itself ("Failed to Save Settings").
    mutationFn: (body) => api.put('/api/ai-farm/spider/settings', body, { silentErrors: true }).then((r) => r.data),
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

/** A failed Activate or Deactivate with no sentence from the server, named by what was tried (Ran, 10 Nov). */
const ACTIVATE_FAILED = 'Could not activate Spider. Try again later.';
const DEACTIVATE_FAILED = 'Could not deactivate Spider. Try again later.';

/**
 * A failed Activate or Deactivate in words: the server's own sentence when its answer carries one, otherwise Ran's
 * (`fallback`). A network error, a timeout or a bare 5xx never shows the HTTP library's English ("Network Error").
 */
function switchErrorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown; details?: unknown } } })?.response?.data;
  const hasSentence = typeof data?.error === 'string' && data.error.trim() !== '';
  const hasDetails = Array.isArray(data?.details) && data.details.length > 0;
  return hasSentence || hasDetails ? spiderErrorText(err, fallback) : fallback;
}

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
    onError: (err, isActive, context) => {
      // The switch is only shown once the status has been read, so there is always one to restore.
      if (context?.previous) qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, context.previous);
      toast.error(switchErrorText(err, isActive ? ACTIVATE_FAILED : DEACTIVATE_FAILED));
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

/** What Activate does with the leads already past their time limit (#3431): one starting summary, or skip them. */
export type SpiderStartingSummaryChoice = 'send' | 'skip';

/** The numbers the Activate review shows (GET /spider/activation-preview, #3431): counts only. */
export interface SpiderActivationPreview {
  /** Open leads Spider would watch: every open lead that is not excluded. */
  watchedLeads: number;
  /** Excluded leads that are still open. */
  excludedLeads: number;
  /** Of the watched leads, those already past their time limit. */
  pastLimitLeads: number;
  /** The people the starting summary would go to. */
  summaryRecipients: number;
}

export const SPIDER_ACTIVATION_PREVIEW_KEY = ['spider', 'activation-preview'] as const;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The Activate review's numbers, read fresh each time the review opens (Admin only). An answer that is
 * not four counts is an error, so the review never shows a number the server did not send.
 */
export function useSpiderActivationPreview({ enabled = true }: { enabled?: boolean } = {}) {
  const available = useSpiderAvailable();
  return useQuery<SpiderActivationPreview>({
    queryKey: SPIDER_ACTIVATION_PREVIEW_KEY,
    queryFn: async () => {
      const r = await api.get('/api/ai-farm/spider/activation-preview', { silentErrors: true });
      const d = r.data ?? {};
      if (![d.watchedLeads, d.excludedLeads, d.pastLimitLeads, d.summaryRecipients].every(isCount)) {
        throw new Error('Unexpected Spider review');
      }
      return {
        watchedLeads: d.watchedLeads,
        excludedLeads: d.excludedLeads,
        pastLimitLeads: d.pastLimitLeads,
        summaryRecipients: d.summaryRecipients,
      };
    },
    enabled: available && enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Activate, from the review on the Spider page (#3432): `PUT /spider/status` with the starting-summary
 * choice. Unlike the switch it waits for the server: Spider shows as Active only once the server says
 * so. A refusal (409: no time limit on, or the settings changed meanwhile) is the server's own
 * sentence in a toast, and the status, settings and review numbers are read again.
 */
export function useActivateSpider() {
  const qc = useQueryClient();
  return useMutation<SpiderOnOff, unknown, SpiderStartingSummaryChoice>({
    mutationFn: async (startingSummary) => {
      // silentErrors: this hook says what went wrong itself, so the global error toast stays out.
      const r = await api.put('/api/ai-farm/spider/status', { isActive: true, startingSummary }, { silentErrors: true });
      if (typeof r.data?.isActive !== 'boolean' || typeof r.data?.isSetUp !== 'boolean') {
        throw new Error('Unexpected Spider status');
      }
      return { isActive: r.data.isActive, isSetUp: r.data.isSetUp };
    },
    onSuccess: (data) => {
      qc.setQueryData<SpiderOnOff>(SPIDER_STATUS_KEY, data);
    },
    onError: (err) => {
      toast.error(switchErrorText(err, ACTIVATE_FAILED));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: SPIDER_STATUS_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_SETTINGS_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_ACTIVATION_PREVIEW_KEY });
      qc.invalidateQueries({ queryKey: SPIDER_SUMMARY_KEY });
    },
  });
}

// ─── The lead picker (#3436, mockup M2) ──────────────────────────────────────
//
// "Select Contacts for Alert" never downloads the whole list. Opening the page reads the overview ("Watching N open
// leads · M excluded") and the first 50 customers with open leads; opening a customer reads its leads; the Excluded tab
// reads its own page. Every list is searched and paged on the server (GET /spider/customers, /customers/:id/leads,
// /excluded), and a Save sends the exclusion changes in one PATCH /spider/exclusions.

/** "Watching N open leads · M excluded": open leads watched, and open leads excluded. */
export interface SpiderPickerOverview {
  watched: number;
  excluded: number;
}

/** A customer with open leads, as the picker lists it. */
export interface SpiderPickerCustomer {
  id: string;
  name: string;
  company_name: string | null;
  email: string | null;
  open_leads: number;
  excluded_leads: number;
}

/** One of a customer's open leads. `stage_entered_at` is null when the lead is in none of Spider's stages. */
export interface SpiderPickerLead {
  id: string;
  lead_number: string;
  status: string;
  stage: SpiderStage | null;
  stage_entered_at: string | null;
  owner_name: string | null;
  address: string | null;
  excluded: boolean;
}

/** One excluded open lead, with its customer's id and name (the Excluded tab). */
export interface SpiderExcludedLead {
  id: string;
  lead_number: string;
  status: string;
  stage: SpiderStage | null;
  stage_entered_at: string | null;
  /** Its customer: an "Include again" moves that customer's chips at once. Absent from a server older than this field. */
  customer_id?: string | null;
  customer_name: string;
}

interface PickerPage<T> {
  rows: T[];
  next_cursor: string | null;
  /** A search's count of every match (customers only); null without a search. */
  total: number | null;
}

export const SPIDER_PICKER_KEY = ['spider', 'picker'] as const;
export const SPIDER_OVERVIEW_KEY = [...SPIDER_PICKER_KEY, 'overview'] as const;

const PICKER = '/api/ai-farm/spider';

const isOverview = (d: unknown): d is SpiderPickerOverview =>
  !!d && isCount((d as SpiderPickerOverview).watched) && isCount((d as SpiderPickerOverview).excluded);

/** The picker's header numbers. An answer that is not two counts is an error: the header never shows a guess. */
export function useSpiderPickerOverview({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<SpiderPickerOverview>({
    queryKey: SPIDER_OVERVIEW_KEY,
    queryFn: async () => {
      const r = await api.get(`${PICKER}/overview`, { silentErrors: true });
      if (!isOverview(r.data)) throw new Error('Unexpected Spider overview');
      return { watched: r.data.watched, excluded: r.data.excluded };
    },
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

async function readPage<T>(url: string, key: string, q: string, cursor: string | null): Promise<PickerPage<T>> {
  const params: Record<string, string> = {};
  if (q) params.q = q;
  if (cursor) params.cursor = cursor;
  const r = await api.get(url, { params, silentErrors: true });
  const rows = r.data?.[key];
  if (!Array.isArray(rows)) throw new Error('Unexpected Spider list');
  return {
    rows: rows as T[],
    next_cursor: typeof r.data?.next_cursor === 'string' ? r.data.next_cursor : null,
    total: isCount(r.data?.total) ? r.data.total : null,
  };
}

function usePickerList<T>(key: readonly unknown[], url: string, rowsKey: string, q: string, enabled: boolean) {
  return useInfiniteQuery<PickerPage<T>, Error, InfiniteData<PickerPage<T>>, readonly unknown[], string | null>({
    queryKey: key,
    queryFn: ({ pageParam }) => readPage<T>(url, rowsKey, q, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** The customers with open leads matching `q` (name, company, lead # or phone), 50 at a time. */
export function useSpiderPickerCustomers(q: string, { enabled = true }: { enabled?: boolean } = {}) {
  return usePickerList<SpiderPickerCustomer>([...SPIDER_PICKER_KEY, 'customers', q], `${PICKER}/customers`, 'customers', q, enabled);
}

/** One customer's open leads, read when its row is opened. */
export function useSpiderCustomerLeads(customerId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return usePickerList<SpiderPickerLead>(
    spiderCustomerLeadsKey(customerId),
    `${PICKER}/customers/${encodeURIComponent(customerId)}/leads`,
    'leads',
    '',
    enabled,
  );
}

export const spiderCustomerLeadsKey = (customerId: string) => [...SPIDER_PICKER_KEY, 'customer-leads', customerId] as const;

/** The excluded open leads matching `q`, 50 at a time (the Excluded tab). */
export function useSpiderExcludedLeads(q: string, { enabled = true }: { enabled?: boolean } = {}) {
  return usePickerList<SpiderExcludedLead>([...SPIDER_PICKER_KEY, 'excluded', q], `${PICKER}/excluded`, 'leads', q, enabled);
}

/**
 * Every open lead of ONE customer, for a tick on its row: ticking a customer ticks all its leads. One request for most
 * customers (50 leads a page); never the company's whole list.
 */
export async function fetchAllSpiderCustomerLeads(customerId: string): Promise<SpiderPickerLead[]> {
  const url = `${PICKER}/customers/${encodeURIComponent(customerId)}/leads`;
  const leads: SpiderPickerLead[] = [];
  let cursor: string | null = null;
  do {
    const page: PickerPage<SpiderPickerLead> = await readPage<SpiderPickerLead>(url, 'leads', '', cursor);
    leads.push(...page.rows);
    cursor = page.next_cursor;
  } while (cursor);
  return leads;
}

/** One Save of the picker's changes: the leads to exclude and the leads to include again. */
export interface SpiderExclusionChanges {
  exclude: string[];
  include: string[];
}

/**
 * Sends the picker's changes (PATCH /spider/exclusions). The server answers the header's new numbers; the lists are
 * read again when next shown, so every row and chip shows what was stored.
 */
export function useSaveSpiderExclusions() {
  const qc = useQueryClient();
  return useMutation<SpiderPickerOverview, unknown, SpiderExclusionChanges>({
    // silentErrors: the page says what went wrong itself ("Failed to Save Settings").
    mutationFn: async (body) => {
      const r = await api.patch(`${PICKER}/exclusions`, body, { silentErrors: true });
      if (!isOverview(r.data)) throw new Error('Unexpected Spider overview');
      return { watched: r.data.watched, excluded: r.data.excluded };
    },
    onSuccess: (overview) => {
      qc.setQueryData(SPIDER_OVERVIEW_KEY, overview);
      qc.invalidateQueries({
        queryKey: SPIDER_PICKER_KEY,
        predicate: (q) => q.queryKey[2] !== 'overview',
      });
    },
  });
}

const UNIT_MS: Record<string, number> = { MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 };
const CHANNEL_STATUSES = ['SENT', 'FAILED', 'SKIPPED'];

function historyChannel(v: unknown): SpiderHistoryChannel | null {
  const c = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!c || typeof c.enabled !== 'boolean' || !CHANNEL_STATUSES.includes(String(c.status))) return null;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    enabled: c.enabled,
    status: c.status as SpiderHistoryChannel['status'],
    sent: n(c.sent),
    skipped: n(c.skipped),
    failed: n(c.failed),
    error: historyText(c.error),
    skip_reason: historyText(c.skip_reason),
    ...(historyText(c.from) ? { from: historyText(c.from)! } : {}),
  };
}

function historyText(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * One History row as the screen reads it, from this server or an older one (the frontend and
 * backend deploy separately). An older server sends no stage name, time, per-channel outcome,
 * address or messages: what it names is used, what it does not is null.
 */
export function toHistoryItem(raw: Record<string, unknown>): SpiderHistoryItem {
  const o = raw.outcomes && typeof raw.outcomes === 'object' ? (raw.outcomes as Record<string, unknown>) : {};
  const inApp = o.in_app && typeof o.in_app === 'object' ? (o.in_app as Record<string, unknown>) : null;
  const e = raw.elapsed && typeof raw.elapsed === 'object' ? (raw.elapsed as Record<string, unknown>) : null;
  let elapsed: SpiderHistoryItem['elapsed'] =
    e && typeof e.value === 'number' && typeof e.unit === 'string' ? { value: e.value, unit: e.unit } : null;
  if (!elapsed) {
    // An older server: worked out from the two instants and the limit's unit it does send.
    const unit = String((raw.limit as { unit?: unknown } | undefined)?.unit ?? '');
    const from = Date.parse(String(raw.entered_status_at ?? ''));
    const to = Date.parse(String(raw.alerted_at ?? ''));
    if (UNIT_MS[unit] && Number.isFinite(from) && Number.isFinite(to)) {
      elapsed = { value: Math.max(1, Math.floor((to - from) / UNIT_MS[unit]!)), unit };
    }
  }
  const outcome = historyText(raw.outcome);
  return {
    id: String(raw.id),
    lead_id: String(raw.lead_id),
    lead_number: historyText(raw.lead_number) ?? '—',
    customer_id: historyText(raw.customer_id),
    customer_name: historyText(raw.customer_name) ?? '—',
    company_name: historyText(raw.company_name),
    service_request: historyText(raw.service_request),
    service_location: historyText(raw.service_location),
    status: raw.status as SpiderStatus,
    stage_name: historyText(raw.stage_name) ?? historyText(raw.status_label),
    elapsed,
    alerted_at: String(raw.alerted_at),
    outcome: outcome && ['SENT', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(outcome) ? (outcome as SpiderHistoryItem['outcome']) : null,
    outcomes: {
      email: historyChannel(o.email),
      sms: historyChannel(o.sms),
      in_app:
        inApp && typeof inApp.enabled === 'boolean' && (inApp.status === 'SENT' || inApp.status === 'SKIPPED')
          ? { enabled: inApp.enabled, status: inApp.status }
          : null,
    },
    recipients: (Array.isArray(raw.recipients) ? (raw.recipients as Record<string, unknown>[]) : []).map((r, i) => ({
      id: historyText(r.id) ?? `recipient-${i}`,
      name: historyText(r.name) ?? '—',
      email: historyText(r.email),
      role: historyText(r.role),
      type: historyText(r.type),
    })),
    in_starting_summary: raw.in_starting_summary === true,
    email_subject: historyText(raw.email_subject),
    email_body: historyText(raw.email_body),
    sms_message: historyText(raw.sms_message),
    in_app_message: historyText(raw.in_app_message),
  };
}

function toHistoryResponse(data: Record<string, unknown>): SpiderHistoryResponse {
  const items = (Array.isArray(data?.items) ? data.items : []) as Record<string, unknown>[];
  return {
    items: items.map(toHistoryItem),
    page: Number(data?.page ?? 1),
    page_size: Number(data?.page_size ?? items.length),
    total: Number(data?.total ?? items.length),
    total_pages: Math.max(1, Number(data?.total_pages ?? 1)),
  };
}

const isNotFound = (err: unknown) => (err as { response?: { status?: number } })?.response?.status === 404;

const HISTORY_SEARCH = '/api/ai-farm/spider/history/search';
const HISTORY_EXPORT = '/api/ai-farm/spider/history/export';
const HISTORY_LIST = '/api/ai-farm/spider/history';

/**
 * One page of History, with the contractor's toolbar applied on the server (POSTed, so a long list
 * of ticked customers never meets a URL limit). `buildParams` runs when the request is made, so a
 * date preset is always worked out from the current time. An older server without the search route
 * gets the plain page request. Read when the tab opens and on Refresh; never polled (his refetched
 * every 10 seconds).
 */
export function useSpiderHistory(page: number, pageSize: number, toolbarKey: unknown, buildParams: () => SpiderHistoryParams) {
  return useQuery<SpiderHistoryResponse>({
    queryKey: [...SPIDER_HISTORY_KEY, 'page', page, pageSize, toolbarKey],
    queryFn: async () => {
      try {
        const r = await api.post(HISTORY_SEARCH, { page, page_size: pageSize, ...buildParams() }, { silentErrors: true });
        return toHistoryResponse(r.data);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        const r = await api.get(HISTORY_LIST, { params: { page, page_size: pageSize }, silentErrors: true });
        return toHistoryResponse(r.data);
      }
    },
    placeholderData: (prev) => prev,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
}

/**
 * The History tab's count badge: every alert, and those newer than `since` (this browser's last
 * view of History; every alert when it has none). Read with the page, never polled.
 */
export function useSpiderHistorySummary(since: number | null) {
  return useQuery<SpiderHistorySummary>({
    queryKey: [...SPIDER_HISTORY_KEY, 'summary', since],
    queryFn: () =>
      api
        .get('/api/ai-farm/spider/history/summary', {
          params: since ? { since: new Date(since).toISOString() } : {},
          silentErrors: true,
        })
        .then((r) => r.data),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * The options of his Recipients and Customers filters. An older server without the route answers
 * 404: that reads as no options (his filters with empty lists), never as an error.
 */
export function useSpiderHistoryFilters() {
  return useQuery<SpiderHistoryFilterOptions>({
    queryKey: [...SPIDER_HISTORY_KEY, 'filters'],
    queryFn: async () => {
      try {
        const r = await api.get('/api/ai-farm/spider/history/filters', { silentErrors: true });
        return {
          recipients: Array.isArray(r.data?.recipients) ? r.data.recipients : [],
          customers: Array.isArray(r.data?.customers) ? r.data.customers : [],
        };
      } catch (err) {
        if (isNotFound(err)) return { recipients: [], customers: [] };
        throw err;
      }
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The most pages an older server is read for "All filtered": its own cap, 100 at a time. */
const EXPORT_FALLBACK_PAGES = 50;

/**
 * His "All filtered" export: every row the toolbar matches, up to the server's cap (`truncated`
 * says when there were more). An older server without the export route is read page by page.
 * Errors reach the caller, which says what went wrong.
 */
export async function fetchSpiderHistoryExport(params: SpiderHistoryParams): Promise<SpiderHistoryExport> {
  try {
    const r = await api.post(HISTORY_EXPORT, params, { silentErrors: true });
    const items = (Array.isArray(r.data?.items) ? r.data.items : []) as Record<string, unknown>[];
    return {
      items: items.map(toHistoryItem),
      total: Number(r.data?.total ?? items.length),
      truncated: r.data?.truncated === true,
    };
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const items: SpiderHistoryItem[] = [];
    let total = 0;
    for (let page = 1; page <= EXPORT_FALLBACK_PAGES; page++) {
      const r = await api.get(HISTORY_LIST, { params: { page, page_size: 100 }, silentErrors: true });
      const res = toHistoryResponse(r.data);
      items.push(...res.items);
      total = res.total;
      if (page >= res.total_pages) break;
    }
    return { items, total, truncated: total > items.length };
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * One alert as the card reads it. A server from before the contractor's card fields (the frontend
 * and backend deploy separately) sends its own names for the same facts, which stand in.
 */
function toAlertCard(a: Record<string, unknown>): SpiderAlertCard {
  const stageName = text(a.stage_name) ?? text(a.status_label);
  return {
    id: String(a.id),
    created_at: String(a.created_at),
    lead_id: String(a.lead_id),
    lead_number: text(a.lead_number),
    customer_name: text(a.customer_name),
    company_name: text(a.company_name),
    status: (text(a.status) as SpiderStatus | null) ?? null,
    stage_name: stageName,
    current_stage: text(a.current_stage) ?? stageName,
    service_location: text(a.service_location) ?? text(a.address),
    service_request: text(a.service_request),
    assigned_to: text(a.assigned_to) ?? text(a.owner_name),
    stage_entered_at: text(a.stage_entered_at) ?? text(a.entered_status_at),
    lead_created_at: text(a.lead_created_at),
    message: text(a.message),
  };
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
        .then((r) => ({
          alerts: ((r.data?.alerts ?? []) as Record<string, unknown>[]).map(toAlertCard),
          // An older server that does not say reads as on, so the cards still show.
          in_app: r.data?.in_app !== false,
          red_frame: r.data?.red_frame === true,
          ...(typeof r.data?.frame === 'boolean' ? { frame: r.data.frame } : {}),
        })),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: SPIDER_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

const ENABLE_IN_APP_FAILED = 'Could not turn on in-app notifications.';

/**
 * The contractor's [Enable Notifications] (his popup, in-app switched off), through the Admin-only
 * settings save: the stored settings are read and saved again with in-app alerts on, nothing else
 * changed. The server refuses it for anyone but an Admin, and while Spider is off.
 */
export function useEnableSpiderInApp() {
  const qc = useQueryClient();
  return useMutation<SpiderSettingsResponse, unknown, void>({
    mutationFn: async () => {
      const current = await qc.fetchQuery<SpiderSettingsResponse>({
        queryKey: SPIDER_SETTINGS_KEY,
        queryFn: () => api.get('/api/ai-farm/spider/settings', { silentErrors: true }).then((r) => r.data),
        staleTime: 0,
      });
      const s = current.settings;
      const body: SpiderSettingsInput = {
        status_limits: s.status_limits,
        channels: { ...s.channels, in_app: true },
        recipients: s.recipients,
      };
      return api.put('/api/ai-farm/spider/settings', body, { silentErrors: true }).then((r) => r.data);
    },
    onSuccess: (data) => {
      qc.setQueryData(SPIDER_SETTINGS_KEY, data);
      qc.setQueryData<SpiderUnreadResponse>(SPIDER_UNREAD_KEY, (prev) => (prev ? { ...prev, in_app: true } : prev));
      qc.invalidateQueries({ queryKey: SPIDER_UNREAD_KEY });
    },
    onError: (err) => {
      toast.error(spiderErrorText(err, ENABLE_IN_APP_FAILED));
    },
  });
}

// ─── The starting summary (#2794) ────────────────────────────────────────────

/** What started the summary. */
export type SpiderTriggerKind = 'SWITCHED_ON' | 'STAGE_ADDED' | 'LIMIT_SHORTENED' | 'SCOPE_WIDENED' | 'SETTINGS_CHANGED';

/** One lead of a starting summary, with where it is now. Durations come written ("2 days 4 hours"). */
export interface SpiderSummaryLead {
  lead_id: string;
  lead_number: string;
  customer_name: string;
  address: string;
  stage: SpiderStage;
  /** The stage as the alerts name it: "New", "Contacted", "Walkthrough Completed". */
  stage_name: string;
  entered_stage_at: string;
  in_stage: string;
  limit: string;
  over_by: string;
  owner_name: string | null;
  moved_on: boolean;
  /** Where it is now, once it has moved on. */
  moved_to: string | null;
}

export interface SpiderSummary {
  id: string;
  created_at: string;
  triggered_at: string;
  trigger_kind: SpiderTriggerKind;
  scope: 'mine' | 'company';
  show_owner: boolean;
  total: number;
  still_waiting: number;
  moved_on: number;
  leads: SpiderSummaryLead[];
}

export const SPIDER_SUMMARY_KEY = ['spider', 'summary'] as const;

const TRIGGER_KINDS: readonly SpiderTriggerKind[] = ['SWITCHED_ON', 'STAGE_ADDED', 'LIMIT_SHORTENED', 'SCOPE_WIDENED', 'SETTINGS_CHANGED'];

/** A summary as the screen reads it; anything that is not one reads as no summary. */
export function toSpiderSummary(raw: unknown): SpiderSummary | null {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!s || typeof s.id !== 'string' || !Array.isArray(s.leads) || s.leads.length === 0) return null;
  const leads = (s.leads as Record<string, unknown>[]).map((l) => ({
    lead_id: String(l.lead_id),
    lead_number: text(l.lead_number) ?? '—',
    customer_name: text(l.customer_name) ?? '—',
    address: text(l.address) ?? '',
    stage: String(l.stage) as SpiderStage,
    stage_name: text(l.stage_name) ?? '—',
    entered_stage_at: String(l.entered_stage_at ?? ''),
    in_stage: text(l.in_stage) ?? '—',
    limit: text(l.limit) ?? '—',
    over_by: text(l.over_by) ?? '—',
    owner_name: text(l.owner_name),
    moved_on: l.moved_on === true,
    moved_to: text(l.moved_to),
  }));
  const movedOn = leads.filter((l) => l.moved_on).length;
  return {
    id: s.id,
    created_at: String(s.created_at),
    triggered_at: String(s.triggered_at ?? s.created_at),
    trigger_kind: TRIGGER_KINDS.includes(s.trigger_kind as SpiderTriggerKind) ? (s.trigger_kind as SpiderTriggerKind) : 'SETTINGS_CHANGED',
    scope: s.scope === 'company' ? 'company' : 'mine',
    show_owner: s.show_owner !== false,
    total: leads.length,
    still_waiting: leads.length - movedOn,
    moved_on: movedOn,
    leads,
  };
}

/**
 * Reads the starting summary: the caller's own (`mine`, any role) or the whole company's
 * (`company`, Admins). A server from before the summary (the two deploy separately) answers 404:
 * that reads as no summary, quietly, as does an Admin-only answer to anyone else.
 */
export async function fetchSpiderSummary(scope: 'mine' | 'company'): Promise<SpiderSummary | null> {
  try {
    const r = await api.get(scope === 'company' ? '/api/ai-farm/spider/summary/company' : '/api/ai-farm/spider/summary', {
      silentErrors: true,
    });
    return toSpiderSummary(r.data?.summary);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 403) return null;
    throw err;
  }
}

/** The starting summary for a screen. Read when the screen opens; never polled. */
export function useSpiderSummary(scope: 'mine' | 'company', { enabled = true }: { enabled?: boolean } = {}) {
  const available = useSpiderAvailable();
  return useQuery<SpiderSummary | null>({
    queryKey: [...SPIDER_SUMMARY_KEY, scope],
    queryFn: () => fetchSpiderSummary(scope),
    enabled: available && enabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
