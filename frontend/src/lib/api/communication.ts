import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useFeature, useEntitlementsReady } from '@/lib/entitlements';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useAppAbility } from '@/contexts/AbilityContext';
import api from '@/lib/axios';
import { useOrganization } from '@/lib/api/organization';
import { isPhoneConnected, isSmsReady } from '@/lib/api/phoneConnected';
import { fmtPhone, isFinalCallStatus } from '@/lib/api/communication-shared';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type {
  CallSession, CallTranscriptTurn, PhoneCustomer, PhoneAgent, Message, MessageThread, TextTemplate,
  TextAutomation, BlockedNumber, BlockReason, CallFlow, CallGroup, WAChat, EmailGroup,
  ForwardRule, TeamMember, TrainingScenario, TrainingSession, OwnedNumber, NumberStatus, ComposeOrigin,
  EmailAssignmentView, EmailThread, Email,
} from '@/lib/api/communication-shared';

// Re-export the shared types so components import them from the seam, never the
// shared module directly.
export type {
  CallSession, CallTranscriptTurn, PhoneCustomer, Contact, ChannelIdentity, PhoneAgent,
  MessageThread, Message, ThreadKind, TextTemplate, TextAutomation, MergeField,
  TextTrigger, TextAudience, BlockedNumber, BlockReason,
  TrainingScenario, TrainingSession, TranscriptTurn,
  TrainingTurn, TrainingOutcome, TrainingRoleId,
  WAChat, WAMessage, WAStatus, CallFlow, CallGroup, TeamMember, EmailGroup, ForwardRule,
  OwnedNumber, NumberType, NumberStatus,
  FlowNode, FlowStructure, ForwardTarget, MenuOption,
  CallGroupMember, RingStrategy, GroupDevice,
  Account, AccountId, Attachment, ComposeOrigin, ComposeState, ReplyDraft, Email,
  MessageStatus, DeliveryNote, DeliveryTone,
  EmailAssignmentView, EmailThread,
} from '@/lib/api/communication-shared';

// Re-export pure label maps / helpers as plain values (NOT hooks).
export {
  DISPOSITION_LABELS, CAMPAIGN_LABELS, BLOCK_REASON_LABELS, BLOCK_REASON_TONE,
  MERGE_FIELDS, mergeLabel, SMS_COMPLIANCE, OPT_OUT_FOOTER, SMS_LEGAL_DISCLAIMER,
  TEXT_TRIGGERS, TIMING_OPTIONS,
  fmtPhone, normalizeNAPhone, matchByNumber, fmtAht, customFlowOptions, flowNameForId,
  deliveryNote, outboundBubbleClass,
  flowStructureLabel, groupTargetOptions, ringLabel, SCRIPT_ATTENTION_THRESHOLD,
  TRAINING_PASS_THRESHOLD, TRAINING_ROLES, TRAINING_OUTCOME_LABELS,
  BUSINESS_NUMBER, MASKING_NUMBER, NUMBER_PRICE,
  ACCOUNTS, PRIMARY_ACCOUNT, NO_MAILBOX_LABEL, senderLabel, senderAddress,
} from '@/lib/api/communication-shared';

/** A customer's job for the center's right-rail "Jobs · navigation" list and
 *  the one-click reassign menus. Human number + service location — never UUIDs
 *  in the UI (the id is only for navigation / reassign payloads). */
export type CustomerJobNav = {
  id: string;
  /** Human job number (prod: J00018-style). */
  number: string;
  /** Service-location display line. */
  location: string;
  /** Not COMPLETED/CANCELLED — only open jobs are reassign targets. */
  open: boolean;
};

/** The open customer's jobs — reads the jobs embedded on GET /api/customers/:id. */
export function useCustomerJobs(customerId?: string) {
  return useQuery<CustomerJobNav[]>({
    queryKey: ['communication', 'customer-jobs', customerId],
    enabled: Boolean(customerId),
    queryFn: () =>
      api.get(`/api/customers/${customerId}`).then((r) => {
        const rows: Array<{
          id: string;
          job_number: string;
          status: string;
          service_location?: { address_line1: string } | null;
        }> = r.data.customer?.jobs ?? [];
        return rows.map((j) => ({
          id: j.id,
          number: j.job_number,
          location: j.service_location?.address_line1 ?? '',
          // A COMPLETED job is still a valid conversation target — customers text about finished
          // work constantly. Only a cancelled job drops out of the picker.
          open: j.status !== 'CANCELLED',
        }));
      }),
  });
}

/** A lead as an attach target. Mirrors CustomerJobNav: human number + a
 *  descriptive line, id only for the reassign payload. */
export type CustomerLeadNav = {
  id: string;
  /** Human lead number (prod: L00018-style). */
  number: string;
  /** Service request, falling back to the customer name. */
  detail: string;
  /** Not LOST/CANCELLED — mirrors the job rule (a WON lead still gets calls). */
  open: boolean;
};

type LeadRow = {
  id: string;
  lead_number: string;
  status: string;
  service_request?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null;
};

const DEAD_LEAD_STATUSES = ['LOST', 'CANCELLED'];

function mapLead(l: LeadRow): CustomerLeadNav {
  const customer =
    l.customer?.company_name ??
    [l.customer?.first_name, l.customer?.last_name].filter(Boolean).join(' ');
  return {
    id: l.id,
    number: l.lead_number,
    detail: l.service_request || customer || '',
    open: !DEAD_LEAD_STATUSES.includes(l.status),
  };
}

/** The open customer's leads — the lead half of the attach picker.
 *  GET /api/customers/:id embeds jobs but only a lead COUNT, so leads come from
 *  the list endpoint's customer_id filter instead. */
export function useCustomerLeads(customerId?: string) {
  return useQuery<CustomerLeadNav[]>({
    queryKey: ['communication', 'customer-leads', customerId],
    enabled: Boolean(customerId),
    queryFn: () =>
      api
        .get('/api/leads', { params: { customer_id: customerId } })
        .then((r) => ((r.data.leads ?? []) as LeadRow[]).map(mapLead)),
  });
}

/**
 * Org-wide attach targets for an UNKNOWN caller — the case with no customer to
 * scope a list to, so the picker searches instead of listing. Both endpoints are
 * already row-scoped server-side, so this can never offer a target the caller
 * could not otherwise see (and the attach itself re-checks that scope anyway).
 *
 * Two characters is the same floor the dialer search uses; below it the query
 * stays disabled rather than pulling every job and lead in the org.
 */
export const ATTACH_SEARCH_MIN = 2;

export function useJobSearch(term: string, enabled = true) {
  const q = term.trim();
  return useQuery<CustomerJobNav[]>({
    queryKey: ['communication', 'attach-job-search', q],
    enabled: enabled && q.length >= ATTACH_SEARCH_MIN,
    queryFn: () =>
      api.get('/api/jobs', { params: { search: q, limit: 8 } }).then((r) => {
        const rows: Array<{
          id: string;
          job_number: string;
          status: string;
          service_location?: { address_line1: string } | null;
        }> = r.data.jobs ?? [];
        return rows.map((j) => ({
          id: j.id,
          number: j.job_number,
          location: j.service_location?.address_line1 ?? '',
          open: j.status !== 'CANCELLED',
        }));
      }),
  });
}

export function useLeadSearch(term: string, enabled = true) {
  const q = term.trim();
  return useQuery<CustomerLeadNav[]>({
    queryKey: ['communication', 'attach-lead-search', q],
    enabled: enabled && q.length >= ATTACH_SEARCH_MIN,
    queryFn: () =>
      api
        .get('/api/leads', { params: { search: q, limit: 8 } })
        .then((r) => ((r.data.leads ?? []) as LeadRow[]).map(mapLead)),
  });
}

// ─── Dialer search (canonical dialer-search endpoint) ───────────────────────

/** One job in a dialer-search result — real UUID id + human number. The
 *  embedded customer is present on top-level job hits; the openJobs rows under
 *  a customer omit it (the parent row carries the customer). */
export type DialerSearchJob = {
  id: string;
  number: string;
  status: string;
  location: string;
  customer?: { id: string; name: string; phone: string | null };
};

export type DialerSearchCustomer = {
  id: string;
  name: string;
  phone: string | null;
  site: string;
  openJobs: DialerSearchJob[];
};

/** Phone-identity resolution for a phone-shaped query (null otherwise / no match). */
export type DialerIdentity = {
  kind: 'customer' | 'lead' | 'vendor';
  id: string;
  label: string;
  customerId: string | null;
  leadId: string | null;
  vendorId: string | null;
};

export type DialerSearchResult = {
  query: { isPhone: boolean; e164: string | null };
  customers: DialerSearchCustomer[];
  jobs: DialerSearchJob[];
  identity: DialerIdentity | null;
};

/** GET /api/communication/dialer-search — REAL tenant search over customers
 *  (with their open jobs) + jobs, plus phone-identity resolution (#666/#357).
 *  Callers debounce the raw input; ≥2 chars gates the fetch (server accepts
 *  2-80). keepPreviousData so the dropdown doesn't flash empty between
 *  keystrokes. */
export function useDialerSearch(q: string) {
  const query = q.trim().slice(0, 80);
  return useQuery<DialerSearchResult>({
    queryKey: ['communication', 'dialer-search', query],
    queryFn: () =>
      api
        .get('/api/communication/dialer-search', { params: { q: query } })
        .then((r) => r.data),
    enabled: query.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

/** Phone-service status, from the org record (§5.4): `connected` = the
 *  server's `phone_connected` (see `isPhoneConnected` for the deploy-window
 *  fallback); `smsReady` additionally requires the texting approval flag
 *  (`sms_ready`, read through `isSmsReady`).
 *  Gates the SMS composer and the liveness polling. */
export function useCtmStatus() {
  const { data: org } = useOrganization();
  const connected = isPhoneConnected(org);
  return { connected, smsReady: connected && isSmsReady(org) };
}

// Liveness (v1 = polling, addendum §A.9): 20s refetch on calls + threads,
// ONLY while the org is CTM-connected (dashboard.ts conditional precedent).
// useUnreadCounts derives from these queries — no separate interval.
const LIVE_POLL_MS = 20_000;

export function useCalls() {
  const { connected } = useCtmStatus();
  // #2046 - the org-wide call log is section-gated (`access_inbox Communication`); this hook had
  // no `enabled` at all before, so it fired for every caller regardless of the ability, including
  // PhoneTabPage's `/phone` tab which a role without the section gate can still reach.
  const ability = useAppAbility();
  return useQuery<CallSession[]>({
    queryKey: ['communication', 'calls'],
    queryFn: () => api.get('/api/communication/calls').then((r) => r.data.calls),
    refetchInterval: connected ? LIVE_POLL_MS : false,
    enabled: ability.can('access_inbox', 'Communication'),
  });
}

/** Current-cycle plan usage for the Phone header meters. Server-derived from
 *  the org's own CallSession/Message rows (inbound + outbound), so `used` can
 *  legitimately exceed `limit` — the meter clamps its bar, not this number. */
export interface CommUsage {
  cycleStart: string;
  cycleLabel: string;
  /** True when the org is exempt from the allowance; both limits are then null. */
  uncapped: boolean;
  calling: { used: number; limit: number | null; unit: string };
  texting: { used: number; limit: number | null; unit: string };
}

export function useCommUsage() {
  const { connected } = useCtmStatus();
  return useQuery<CommUsage>({
    queryKey: ['communication', 'usage'],
    queryFn: () => api.get('/api/communication/usage').then((r) => r.data),
    refetchInterval: connected ? LIVE_POLL_MS : false,
  });
}

/** Fetch a single CallSession by id (GET /api/communication/calls/:id → { call }).
 *  Powers the entity-tab call detail drawer (EntityCallDrawer). */
export function useCall(callId: string) {
  return useQuery<CallSession>({
    queryKey: ['communication', 'call', callId],
    queryFn: () => api.get(`/api/communication/calls/${callId}`).then((r) => r.data.call),
    enabled: !!callId,
  });
}

// How often the dialer asks whether the call it just placed has landed, and how
// long it keeps asking. The bridge rings the agent's phone and then dials the
// customer, so the browser is never on the call: the 'end' webhook is the only
// thing that knows it finished, and it lands roughly 30-40s after hangup
// (measured live 2026-08-06 - a 19s call ended ~13:23:57, row written 13:24:14).
// 5s keeps the flip to "Call ended" prompt against that latency without
// hammering the API. The ceiling is generous because a call that has not landed
// yet is usually just still in progress, and giving up early would strand the
// dialer on "Call placed" - the exact bug this fixes.
const OUTCOME_POLL_MS = 5_000;
const OUTCOME_GIVE_UP_MS = 30 * 60_000;

/** Did the outbound call placed to `toNumber` at `since` land yet?
 *  (GET /api/communication/calls/outcome -> { call }).
 *
 *  Resolves to null until the webhook writes the CallSession, then to the row -
 *  which is what lets the bridge dialer show a REAL ended state with a real
 *  duration instead of a terminal "Call placed". Polling stops the moment a row
 *  arrives, rather than asking a settled question forever. */
export function useCallOutcome(toNumber: string | null, since: string | null) {
  return useQuery<CallSession | null>({
    queryKey: ['communication', 'call-outcome', toNumber, since],
    queryFn: () =>
      api
        .get('/api/communication/calls/outcome', { params: { to_number: toNumber, since } })
        .then((r) => r.data.call ?? null),
    enabled: !!toNumber && !!since,
    refetchInterval: (query) => {
      // Over - stop asking. A ringing/active row (a 'starts' webhook) is the
      // call still going, so keep polling until the 'end' webhook resolves it.
      if (isFinalCallStatus(query.state.data?.status)) return false;
      const dialedAt = since ? Date.parse(since) : NaN;
      if (!Number.isNaN(dialedAt) && Date.now() - dialedAt > OUTCOME_GIVE_UP_MS) return false;
      return OUTCOME_POLL_MS;
    },
    // A failed poll should just retry on the next tick rather than surface an
    // error state: the call itself is unaffected by this lookup failing.
    retry: false,
  });
}

/** Lazy signed-URL fetch for a call recording. enabled:false — NOTHING fires
 *  until the player's first Play click calls refetch(). The URL expires after
 *  300s; the player silently refetches on mid-playback expiry, and a 404 means
 *  "recording still processing" (quiet state, no toast). retry:false so a 404
 *  resolves immediately instead of after React Query's default retries. */
export function useRecordingUrl(callId: string) {
  return useQuery<{ url: string }>({
    queryKey: ['communication', 'call-recording', callId],
    queryFn: () => api.get(`/api/communication/calls/${callId}/recording`).then((r) => r.data),
    enabled: false,
    retry: false,
    // A signed URL is only fresh for 300s — never serve a stale one from cache.
    gcTime: 0,
    staleTime: 0,
  });
}

/** Lazy transcript + AI-insight hydration. CTM finalizes both after the `end`
 *  webhook - it derives the summary FROM the transcript, so a completed call
 *  can exist before either does. The call drawer fires this on open when the
 *  row is missing EITHER field; the backend fetches from CTM, persists, and
 *  returns { transcript, summary, turns }. `turns` is CTM's structured,
 *  per-speaker transcript (transcription.json outline[]) - the flat
 *  `transcript` string interleaves each channel fragment-by-fragment and is
 *  unrecoverable once flattened, so the reader renders `turns` when present
 *  and falls back to the flat string only for calls CTM never diarized. A
 *  miss or fetch failure is a quiet null on all three (never an error) - the
 *  drawer renders that as an honest "nothing available" state, not a
 *  perpetual "still generating" lie. retry:false - a null is terminal. */
export function useCallTranscript(callId: string, enabled: boolean) {
  return useQuery<{ transcript: string | null; summary: string | null; turns: CallTranscriptTurn[] | null }>({
    queryKey: ['communication', 'call-transcript', callId],
    queryFn: () =>
      api.get(`/api/communication/calls/${callId}/transcript`).then((r) => r.data),
    enabled: !!callId && enabled,
    retry: false,
  });
}

// ─── Numbers platform (slice 7) ─────────────────────────────────────────────

/** Wire row from GET /api/communication/numbers (snake_case DB shape). */
export type PhoneNumberRow = {
  id: string;
  e164: string;
  formatted?: string | null;
  label?: string | null;
  source?: string;
  type?: string | null;
  sms_enabled?: boolean;
  /** The number's id at the phone service (not read by the UI). */
  provider_number_id?: string | null;
  /** @deprecated Old name of `provider_number_id`, sent one more release.
   *  TODO(phone-api-neutral-names): drop with the backend alias. */
  ctm_number_id?: string | null;
  call_flow_id?: string | null;
  /** Where this number's calls ring (E.164), or null when it has no simple
   *  forward set. This IS the routing - see `useUpdateNumberForwarding`. */
  forward_to?: string | null;
  status?: string;
  created_at: string;
};

/** Statuses the UI knows how to render; anything else falls back to active so
 *  a new server-side state can never blank a row out. */
const NUMBER_STATUSES = new Set<NumberStatus>([
  'active',
  'paused',
  'released',
  'pending',
  'failed',
]);

/** Map a wire row onto the UI's OwnedNumber shape (NumbersView contract). */
export function mapOwnedNumber(row: PhoneNumberRow): OwnedNumber {
  return {
    id: row.id,
    number: row.formatted || fmtPhone(row.e164),
    ...(row.label ? { tag: row.label } : {}),
    type: row.type === 'tollfree' ? 'Toll-free' : 'Local',
    flowId: row.call_flow_id ?? '',
    forwardTo: row.forward_to ?? null,
    status: NUMBER_STATUSES.has(row.status as NumberStatus)
      ? (row.status as NumberStatus)
      : 'active',
    createdAt: row.created_at,
    smsEnabled: row.sms_enabled ?? false,
  };
}

/** The org's owned numbers — replaces NumbersView's SEED_NUMBERS. */
export function useNumbers() {
  return useQuery<OwnedNumber[]>({
    queryKey: ['communication', 'numbers'],
    queryFn: () =>
      api.get('/api/communication/numbers').then((r) =>
        ((r.data.numbers ?? []) as PhoneNumberRow[]).map(mapOwnedNumber),
      ),
  });
}

/** A purchasable number from CTM inventory search. The backend strips every
 *  price/cost field before it reaches us — numbers are included in the plan. */
export type AvailableNumber = { e164: string; display: string };

/** CTM number-inventory search (ADMIN-gated server-side). A mutation, not a
 *  query: each search is an explicit user action against CTM's live pool. */
export function useSearchNumbers() {
  return useMutation<AvailableNumber[], unknown, { areacode?: string; type?: 'local' | 'tollfree' }>({
    mutationFn: (args) =>
      api.post('/api/communication/numbers/search', args).then((r) => {
        const items = (r.data.numbers ?? []) as Array<Record<string, unknown>>;
        return items
          .map((n) => {
            const e164 = String(n.phone_number ?? n.number ?? n.e164 ?? '');
            return {
              e164,
              display: String(n.friendly_name ?? n.formatted ?? (e164 ? fmtPhone(e164) : '')),
            };
          })
          .filter((n) => n.e164);
      }),
  });
}

/** Row flow-reassign — PATCH /api/communication/numbers/:id. call_flow_id is
 *  the only writable field; null clears the flow. */
export function useReassignNumberFlow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, callFlowId }: { id: string; callFlowId: string | null }) =>
      api.patch(`/api/communication/numbers/${id}`, { call_flow_id: callFlowId }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'numbers'] }),
  });
}

/** What one number sync did (POST /numbers/refresh). */
export interface NumberSyncResponse {
  /** Numbers the phone system reported. */
  synced: number;
  /** Numbers stored for the first time. */
  added: number;
  /** Numbers whose texting the sync switched on. */
  texting_enabled: number;
  /** Numbers whose texting could not be switched on; retried next sync. */
  texting_failed: number;
  numbers: PhoneNumberRow[];
}

/** Re-read the provider's number list and make ours match (POST /numbers/refresh).
 *
 *  The local list is otherwise a connect-time snapshot: a number bought outside
 *  ServWave, or one ServWave bought and failed to save, never shows up - and an
 *  invisible number is still a billed number. The sync also switches texting
 *  on for any number that has it off, and names unnamed numbers. */
export function useRefreshNumbers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post('/api/communication/numbers/refresh')
        .then((r) => r.data as NumberSyncResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'numbers'] }),
  });
}

/** Give a number back and stop its recurring charge (DELETE /numbers/:id).
 *
 *  IRREVERSIBLE at the provider - the number returns to the carrier pool and
 *  cannot be reclaimed - so the caller must confirm first. The row survives as
 *  `released` rather than being deleted, because calls and messages reference
 *  the number and last month's calls should still show which one took them. */
export function useReleaseNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api
        .delete(`/api/communication/numbers/${id}`)
        .then((r) => r.data as { number: PhoneNumberRow }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'numbers'] }),
  });
}

/** Change where a number's calls ring (PATCH /numbers/:id).
 *
 *  Unlike the flow reassign above, this is not a label: it re-points the live
 *  dial route, and the server fails the request rather than reporting success
 *  if the phone system refuses - so an error here means calls still reach the
 *  OLD destination, and the caller must say so. */
export function useUpdateNumberForwarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, forwardToE164 }: { id: string; forwardToE164: string }) =>
      api
        .patch(`/api/communication/numbers/${id}`, { forward_to_e164: forwardToE164 })
        .then((r) => r.data as { number: PhoneNumberRow }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'numbers'] }),
  });
}

export function usePhoneCustomers() {  // Emanuel Customer -> PhoneCustomer
  return useQuery<PhoneCustomer[]>({ queryKey: ['communication', 'customers'], queryFn: () => api.get('/api/communication/contacts').then((r) => r.data.contacts) });
}
export function usePhoneAgents() {
  return useQuery<PhoneAgent[]>({ queryKey: ['communication', 'agents'], queryFn: () => api.get('/api/communication/agents').then((r) => r.data.agents) });
}
export function useMessageThreads() {
  const { connected } = useCtmStatus();
  // entitlementsReady guard: without it, a stale cached user (org_features
  // undefined) makes useFeature fail OPEN on first paint, firing this poll
  // before /api/auth/me resolves — a 402 there hard-redirects to /upgrade.
  const entitlementsReady = useEntitlementsReady();
  const canAccess = useFeature('phone');
  // #2046 - the org-wide thread LIST is section-gated (`access_inbox Communication`), separately
  // from the by-id read `useMessageThread` below uses to re-source the record-tab SMS drawer -
  // that route stays ungated, so this hook must NOT be reused there.
  const ability = useAppAbility();
  return useQuery<MessageThread[]>({
    queryKey: ['communication', 'threads'],
    queryFn: () => api.get('/api/communication/threads').then((r) => r.data.threads),
    refetchInterval: connected ? LIVE_POLL_MS : false,
    enabled: entitlementsReady && canAccess && ability.can('access_inbox', 'Communication'),
  });
}

/** A single thread by id, anchor-filtered server-side and NOT gated on the section ability
 *  (`GET /api/communication/threads/:id` stays on `read Communication` alone - see R1). Powers
 *  `EntitySmsDrawer` off `CommItem.threadId` instead of the org-wide list above, so the record-tab
 *  text drawer keeps working for a caller who holds `read Communication` but not the section gate.
 *  Deliberately no `refetchInterval` - the drawer is a point-in-time read, not a live poll. */
export function useMessageThread(threadId: string | undefined) {
  return useQuery<MessageThread>({
    queryKey: ['communication', 'thread', threadId],
    queryFn: () => api.get(`/api/communication/threads/${threadId}`).then((r) => r.data.thread),
    enabled: !!threadId,
  });
}

type MarkThreadContext = { previousThreads?: MessageThread[]; previousThread?: MessageThread };

/** #2049 (validator r1) - shared rollback for both SMS mark-read/unread mutations
 *  below: snapshot the org-wide list + by-id thread cache in `onMutate`, apply the
 *  optimistic `unread` value to both, restore the snapshot AND surface the failure
 *  in `onError`, invalidate in `onSettled`. Lives here, once, so every call site
 *  (SmsInboxView's 6 sites, EntitySmsDrawer) inherits it without repeating the
 *  snapshot/restore boilerplate - a rejected PATCH must never leave the cache
 *  stuck at the optimistic value. */
function markThreadOptimistic(
  qc: ReturnType<typeof useQueryClient>,
  nextUnread: (previous: number) => number,
) {
  return {
    onMutate: async (threadId: string): Promise<MarkThreadContext> => {
      await qc.cancelQueries({ queryKey: ['communication', 'threads'] });
      await qc.cancelQueries({ queryKey: ['communication', 'thread', threadId] });
      const previousThreads = qc.getQueryData<MessageThread[]>(['communication', 'threads']);
      const previousThread = qc.getQueryData<MessageThread>(['communication', 'thread', threadId]);
      if (previousThreads) {
        qc.setQueryData<MessageThread[]>(
          ['communication', 'threads'],
          previousThreads.map((t) => (t.id === threadId ? { ...t, unread: nextUnread(t.unread) } : t)),
        );
      }
      if (previousThread) {
        qc.setQueryData<MessageThread>(['communication', 'thread', threadId], {
          ...previousThread,
          unread: nextUnread(previousThread.unread),
        });
      }
      return { previousThreads, previousThread };
    },
    onError: (err: unknown, threadId: string, ctx: MarkThreadContext | undefined) => {
      if (ctx?.previousThreads) qc.setQueryData(['communication', 'threads'], ctx.previousThreads);
      if (ctx?.previousThread) qc.setQueryData(['communication', 'thread', threadId], ctx.previousThread);
      toast({
        title: "Couldn't update this conversation",
        description: extractApiError(err, 'Try again in a moment.'),
        variant: 'destructive',
      });
    },
    onSettled: (_data: unknown, _err: unknown, threadId: string) => {
      qc.invalidateQueries({ queryKey: ['communication', 'threads'] });
      qc.invalidateQueries({ queryKey: ['communication', 'thread', threadId] });
    },
  };
}

/** #2049 - the persisting half of opening/re-opening an SMS thread. Read-side
 *  right (`read Communication` + anchor visibility, never `update`) - reaches
 *  the same rows `useMessageThread`/`EntitySmsDrawer` already read. Invalidates
 *  both the org-wide list and the by-id thread so every surface converges. */
export function useMarkThreadRead() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkThreadContext>({
    mutationFn: (threadId: string) =>
      api.patch(`/api/communication/threads/${threadId}/read`).then((r) => r.data),
    ...markThreadOptimistic(qc, () => 0),
  });
}

/** #2049 - the persisting half of "Mark as unread" on an SMS thread. */
export function useMarkThreadUnread() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkThreadContext>({
    mutationFn: (threadId: string) =>
      api.patch(`/api/communication/threads/${threadId}/unread`).then((r) => r.data),
    ...markThreadOptimistic(qc, (previous) => previous || 1),
  });
}

export function useTextTemplates() {
  return useQuery<TextTemplate[]>({ queryKey: ['communication', 'templates'], queryFn: () => api.get('/api/communication/templates').then((r) => r.data.templates) });
}
export function useTextAutomations() {
  return useQuery<TextAutomation[]>({ queryKey: ['communication', 'automations'], queryFn: () => api.get('/api/communication/automations').then((r) => r.data.automations) });
}
export function useBlockedNumbers() {
  return useQuery<BlockedNumber[]>({ queryKey: ['communication', 'blocked'], queryFn: () => api.get('/api/communication/blocked').then((r) => r.data.blocked) });
}
export function useTrainingScenarios() {
  return useQuery<TrainingScenario[]>({ queryKey: ['communication', 'training-scenarios'], queryFn: () => api.get('/api/communication/training/scenarios').then((r) => r.data.scenarios) });
}
export function useTrainingSessions() {
  return useQuery<TrainingSession[]>({ queryKey: ['communication', 'training-sessions'], queryFn: () => api.get('/api/communication/training/sessions').then((r) => r.data.sessions) });
}
export function useCallFlows() {
  return useQuery<CallFlow[]>({ queryKey: ['communication', 'call-flows'], queryFn: () => api.get('/api/communication/call-flows').then((r) => r.data.callFlows) });
}
export function useCallGroups() {
  return useQuery<CallGroup[]>({ queryKey: ['communication', 'call-groups'], queryFn: () => api.get('/api/communication/call-groups').then((r) => r.data.callGroups) });
}
export function useWhatsAppChats() {
  const entitlementsReady = useEntitlementsReady();
  // Mirrors the route lock exactly: WhatsApp needs PRO `phone` AND a demo org
  // (comm-whatsapp.routes.ts answers 404 FEATURE_DISABLED otherwise). Two
  // unconditional hook calls, never `useFeature('phone') && useIsDemoOrg()` -
  // that short-circuits and skips a hook call.
  const canAccess = useFeature('phone');
  const isDemoOrg = useIsDemoOrg();
  // #2046 - all four `comm-whatsapp.routes.ts` routes are section-gated.
  const ability = useAppAbility();
  return useQuery<WAChat[]>({ queryKey: ['communication', 'whatsapp'], queryFn: () => api.get('/api/communication/whatsapp').then((r) => r.data.chats), enabled: entitlementsReady && canAccess && isDemoOrg && ability.can('access_inbox', 'Communication') });
}

type MarkWhatsAppChatContext = { previousChats?: WAChat[] };

/** #2049 slice 2 - shared rollback for both WhatsApp mark-read/unread
 *  mutations below, same shape as `markThreadOptimistic` for SMS but with
 *  ONE cache key - there is no by-id WhatsApp query on the frontend, only
 *  the org-wide `['communication','whatsapp']` list `useWhatsAppChats` reads. */
function markWhatsAppChatOptimistic(
  qc: ReturnType<typeof useQueryClient>,
  nextUnread: (previous: number) => number,
) {
  return {
    onMutate: async (chatId: string): Promise<MarkWhatsAppChatContext> => {
      await qc.cancelQueries({ queryKey: ['communication', 'whatsapp'] });
      const previousChats = qc.getQueryData<WAChat[]>(['communication', 'whatsapp']);
      if (previousChats) {
        qc.setQueryData<WAChat[]>(
          ['communication', 'whatsapp'],
          previousChats.map((c) => (c.id === chatId ? { ...c, unread: nextUnread(c.unread) } : c)),
        );
      }
      return { previousChats };
    },
    onError: (err: unknown, _chatId: string, ctx: MarkWhatsAppChatContext | undefined) => {
      if (ctx?.previousChats) qc.setQueryData(['communication', 'whatsapp'], ctx.previousChats);
      toast({
        title: "Couldn't update this conversation",
        description: extractApiError(err, 'Try again in a moment.'),
        variant: 'destructive',
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['communication', 'whatsapp'] }),
  };
}

/** #2049 slice 2 - the persisting half of opening/re-opening a WhatsApp chat.
 *  Read-side right (`read`+`access_inbox Communication`, never `update`),
 *  mirroring `useMarkThreadRead`'s SMS shape. */
export function useMarkWhatsAppChatRead() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkWhatsAppChatContext>({
    mutationFn: (chatId: string) =>
      api.patch(`/api/communication/whatsapp/${chatId}/read`).then((r) => r.data),
    ...markWhatsAppChatOptimistic(qc, () => 0),
  });
}

/** #2049 slice 2 - the persisting half of "Mark as unread" on a WhatsApp chat. */
export function useMarkWhatsAppChatUnread() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkWhatsAppChatContext>({
    mutationFn: (chatId: string) =>
      api.patch(`/api/communication/whatsapp/${chatId}/unread`).then((r) => r.data),
    ...markWhatsAppChatOptimistic(qc, (previous) => previous || 1),
  });
}

/** Email slice 8b - Unassigned / Mine / All (`?assignment=` on GET /emails,
 *  Missive's "assigned to one, visible to all" rule - an ADDITIONAL filter on
 *  top of the inbox's normal anchor visibility, never a narrower gate).
 *  `'all'` (the default) sends no `assignment` param at all, matching the
 *  pre-8b request shape exactly - existing callers (useUnreadCounts below,
 *  any caller passing nothing) keep seeing the same unfiltered set. */
export function useEmails(assignment: EmailAssignmentView = 'all') {
  const entitlementsReady = useEntitlementsReady();
  // `email`, not `phone` - email is its own STARTER entitlement.
  const canAccess = useFeature('email');
  // #2046 - `GET /emails` (the org-wide inbox list) is section-gated. `POST /emails` (send) and
  // `GET /emails/attach-source` stay ungated (R2) - this hook is the LIST read only.
  const ability = useAppAbility();
  return useQuery({
    queryKey: ['communication', 'emails', assignment],
    queryFn: () =>
      api
        .get('/api/communication/emails', {
          params: assignment === 'all' ? undefined : { assignment },
        })
        .then((r) => r.data.emails),
    enabled: entitlementsReady && canAccess && ability.can('access_inbox', 'Communication'),
  });
}
/** The From address this org's sends actually carry.
 *
 *  The compose surfaces used to show a flat "No mailbox connected" because
 *  nothing ever supplied a `fromAddress` - true when there was no per-org
 *  sending identity to supply, and a lie once every org got one. This is the
 *  seam ComposeWindow's `fromAddress` prop was left open for.
 *
 *  Served by the same derivation the send path uses, never re-derived here: a
 *  compose header that could disagree with what the recipient sees would be a
 *  more convincing lie than the honest placeholder it replaces. Stays stale-
 *  tolerant (it changes only when an admin edits the sending address or renames
 *  the org), so the default cache behaviour is right and it needs no polling. */
export type SendingIdentity = {
  address: string;
  name: string | null;
  sendingEnabled: boolean;
  /** The string before the `@` this org actually sends from - its own choice
   *  when it has set one, else derived from the company name. */
  localPart: string;
  /** False while `localPart` is still tracking the company name, so the
   *  settings field can say so rather than present a derived value as though
   *  the org had chosen it. */
  localPartIsCustom: boolean;
  /** The domain half, identical for every org and never an org choice. Sent
   *  separately so the settings field renders it as a fixed suffix instead of
   *  splitting `address` apart client-side. */
  senderDomain: string;
};
export function useSendingIdentity() {
  const entitlementsReady = useEntitlementsReady();
  const canAccess = useFeature('email');
  return useQuery<SendingIdentity>({
    queryKey: ['communication', 'sending-identity'],
    queryFn: () => api.get('/api/communication/sending-identity').then((r) => r.data),
    enabled: entitlementsReady && canAccess,
  });
}
export function useEmailGroups() {
  return useQuery<EmailGroup[]>({ queryKey: ['communication', 'email-groups'], queryFn: () => api.get('/api/communication/email-groups').then((r) => r.data.groups) });
}
export function useForwardRules() {
  return useQuery<ForwardRule[]>({ queryKey: ['communication', 'forward-rules'], queryFn: () => api.get('/api/communication/forward-rules').then((r) => r.data.rules) });
}
export function useTeamMembers() {
  return useQuery<TeamMember[]>({ queryKey: ['communication', 'team-members'], queryFn: () => api.get('/api/communication/team-members').then((r) => r.data.members) });
}

// Selector hook the re-skinned Header consumes (replaces Emanuel's non-reactive
// module-load TEXTING_UNREAD/WHATSAPP_UNREAD/EMAIL_UNREAD constants).
export function useUnreadCounts() {
  const threads = useMessageThreads();
  const wa = useWhatsAppChats();
  const emails = useEmails();
  return {
    sms: (threads.data ?? []).reduce((n, t) => n + (t.unread ?? 0), 0),
    whatsapp: (wa.data ?? []).reduce((n, c) => n + (c.unread ?? 0), 0),
    email: (emails.data ?? []).filter((e: { folder: string; unread: boolean }) => e.folder === 'inbox' && e.unread).length,
  };
}

type MarkEmailThreadContext = { previous?: Email[] };

/** #2049 (validator r1) - shared rollback for both email mark-read/unread
 *  mutations below, same shape as `markThreadOptimistic` for SMS: snapshot the
 *  `['communication','emails']` cache, flip `unread` on every row of the
 *  target thread, restore + toast on error, invalidate on settle. */
function markEmailThreadOptimistic(qc: ReturnType<typeof useQueryClient>, nextUnread: boolean) {
  return {
    onMutate: async (threadId: string): Promise<MarkEmailThreadContext> => {
      await qc.cancelQueries({ queryKey: ['communication', 'emails'] });
      const previous = qc.getQueryData<Email[]>(['communication', 'emails']);
      if (previous) {
        qc.setQueryData<Email[]>(
          ['communication', 'emails'],
          previous.map((e) => ((e.threadId ?? e.id) === threadId ? { ...e, unread: nextUnread } : e)),
        );
      }
      return { previous };
    },
    onError: (err: unknown, _threadId: string, ctx: MarkEmailThreadContext | undefined) => {
      if (ctx?.previous) qc.setQueryData(['communication', 'emails'], ctx.previous);
      toast({
        title: "Couldn't update this conversation",
        description: extractApiError(err, 'Try again in a moment.'),
        variant: 'destructive',
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['communication', 'emails'] }),
  };
}

/** Opening a conversation persists read-state for the whole thread - per
 *  CALLER now (email slice 8c: EmailReadState upserts, not the old shared
 *  `Email.unread` flip), though this call site's own shape is unchanged. */
export function useMarkEmailThreadRead() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkEmailThreadContext>({
    mutationFn: (threadId: string) =>
      api.patch('/api/communication/emails/thread-read', { thread_id: threadId }).then((r) => r.data),
    ...markEmailThreadOptimistic(qc, false),
  });
}

/** #2049 - the persisted half of "Mark as unread" in the reading pane
 *  (InboxPage's `updateEmail`), which used to be React-state-only. Mirrors
 *  `useMarkEmailThreadRead` above, re-gated the same way. */
export function useMarkEmailThreadUnread() {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string, MarkEmailThreadContext>({
    mutationFn: (threadId: string) =>
      api.patch('/api/communication/emails/thread-unread', { thread_id: threadId }).then((r) => r.data),
    ...markEmailThreadOptimistic(qc, true),
  });
}

/** Email slice 8b - assign a conversation to a user, or clear it with `null`
 *  (Unassigned). `threadId` is EmailThread's own id - Email.threadId (the
 *  mapped `thread_id` FK), not the message id. Mirrors useReassignEmailJob's
 *  shape one section down, but PATCHes the THREAD-level endpoint rather than
 *  a single message's job attribution. */
export function useAssignEmailThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, userId }: { threadId: string; userId: string | null }) =>
      api
        .patch(`/api/communication/emails/threads/${threadId}/assign`, { user_id: userId })
        .then((r) => r.data as { thread: EmailThread }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'emails'] }),
  });
}

/** Email slice 6 - the unmatched inbound queue: replies whose reply token
 *  resolved a conversation that we then REFUSED to attach them to, because the
 *  sender did not check out. Its own query key rather than a filter on
 *  ['communication', 'emails', ...]: these carry no thread, so they are an
 *  operator worklist rather than a slice of any inbox view. */
export function useUnmatchedEmails() {
  const entitlementsReady = useEntitlementsReady();
  const canAccess = useFeature('email');
  return useQuery<Email[]>({
    queryKey: ['communication', 'emails', 'unmatched'],
    queryFn: () => api.get('/api/communication/emails/unmatched').then((r) => r.data.emails),
    enabled: entitlementsReady && canAccess,
  });
}

/** Email slice 6 - attach an unmatched inbound message to a conversation.
 *  `threadId` omitted means "the thread this message's own reply token points
 *  at", which is the one-click case the retained token exists to serve.
 *  Invalidates the whole email key: the message leaves the queue and joins an
 *  inbox thread in the same write. */
export function useLinkInboundEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, threadId }: { emailId: string; threadId?: string }) =>
      api
        .patch(`/api/communication/emails/${emailId}/link`, threadId ? { thread_id: threadId } : {})
        .then((r) => r.data as { email: Email }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'emails'] }),
  });
}

/** Human copy for a failed manual link. The server distinguishes "this message
 *  never carried a token" from "the token's conversation is gone", and both are
 *  actionable by the operator (pick a conversation), so its own text is
 *  surfaced rather than replaced with a generic line. */
export function linkInboundErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } } };
  return e.response?.data?.error ?? 'Could not link this message - try again.';
}

/** Human copy for a failed email send - mirrors smsSendErrorMessage: surfaces
 *  the server's own error text, falling back to a generic retry line. */
export function emailSendErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; code?: string } } };
  return e.response?.data?.error ?? 'Email failed to send - try again.';
}

/** Traffic Cop (email slice 8b) - the 409 shape sendEmail returns when a
 *  reply's thread picked up a newer message while it was being composed:
 *  `{ error, code: 'THREAD_CHANGED', messages: Email[] }` (the newer
 *  messages, oldest first, already run through the same mapEmail every other
 *  read path uses - a real `Email[]`, not a partial/wire-only shape). */
export type ThreadChangedConflict = { messages: Email[] };

/** Narrows a failed useSendEmail() error down to the Traffic Cop's specific
 *  409, so a caller can branch on it instead of treating every failure as a
 *  generic "couldn't send". Returns null for any other error (network
 *  failure, validation 400, any other 409/500) - those stay on the ordinary
 *  emailSendErrorMessage + revert path. */
export function asThreadChangedConflict(err: unknown): ThreadChangedConflict | null {
  const e = err as {
    response?: { status?: number; data?: { code?: string; messages?: Email[] } };
  };
  if (e.response?.status === 409 && e.response.data?.code === 'THREAD_CHANGED') {
    return { messages: e.response.data.messages ?? [] };
  }
  return null;
}

/** Human copy for a failed WhatsApp send - maps the WHATSAPP_NOT_CONNECTED 409
 *  to a short UI string, falls back to the server error then a generic retry
 *  line. Callers render this INLINE near the composer (danger tokens) - never
 *  a false success toast. */
export function whatsAppSendErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; code?: string } } };
  const code = e?.response?.data?.code;
  if (code === 'WHATSAPP_NOT_CONNECTED') {
    return 'WhatsApp Business is not connected - this message was not sent.';
  }
  return e?.response?.data?.error ?? "Couldn't send the message - try again";
}

// NOTE (#229): 4 of the paths below have no backend route yet (screen-pop,
// emails/draft, ai-assist, POST training/sessions) — they 404, matching
// deployed behavior; routes are future telephony/email work.
function useCommMutation<TArgs>(path: string, opts: { retry?: false } = {}) {
  const qc = useQueryClient();
  return useMutation({
    ...opts,
    mutationFn: (args: TArgs) => api.post(path, args).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication'] }),
  });
}
// Never retried: a refused bridge call (e.g. PROFILE_PHONE_REQUIRED) needs the
// user to act, and a retried bridge that DID reach the phone service could ring twice.
export const usePlaceCall            = () => useCommMutation<unknown>('/api/communication/calls', { retry: false });
// The WebRTC softphone dials CTM in the browser (bypassing usePlaceCall's bridge),
// so it POSTs its dialer context here first for the webhook's ingestCall to consume.
export const useStashCallAttribution = () => useCommMutation<{ to_number: string; job_id?: string; lead_id?: string; customer_id?: string }>('/api/communication/calls/attribution');
export const useScreenPop            = () => useCommMutation<unknown>('/api/communication/screen-pop');
export const useSaveTemplate         = () => useCommMutation<Partial<TextTemplate>>('/api/communication/templates');
export const useSaveAutomation       = () => useCommMutation<Partial<TextAutomation>>('/api/communication/automations');
// Blocked callers deliberately do NOT go through useCommMutation: its
// invalidation covers the whole ['communication'] prefix, which would refetch
// calls/threads/callFlows/callGroups/numbers too, and PhonePage's
// `if (seed.length) setX(seed)` hydration effects would then clobber an
// in-progress local edit on the Call flows tab. These invalidate only the exact
// key useBlockedNumbers reads.
export function useBlockNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: string; name?: string; reason: BlockReason; note?: string }) =>
      api.post('/api/communication/blocked', args).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'blocked'] }),
  });
}
export function useUnblockNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string }) =>
      api.post('/api/communication/blocked/unblock', args).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication', 'blocked'] }),
  });
}

/** Human copy for a failed block/unblock. Three server shapes, not one: the
 *  duplicate 409's machine code, validate()'s `{ error: 'Validation failed',
 *  details: [{ field, message }] }` (whose bare `error` would otherwise toast
 *  the literal string "Validation failed"), then any other server error. */
export function blockNumberErrorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: string; code?: string; details?: { message?: string }[] } };
  };
  const data = e?.response?.data;
  if (data?.code === 'ALREADY_BLOCKED') return 'That number is already blocked';
  if (data?.error === 'Validation failed') {
    return data.details?.[0]?.message ?? 'Check the number and try again';
  }
  return data?.error ?? "Couldn't update the blocked list - try again";
}
// Real purchase (slice 7): forward-to is REQUIRED (the number must route
// somewhere), the call flow is optional; `warnings` surfaced by the dialog.
// The ['communication'] prefix invalidation covers ['communication','numbers'].
export const useBuyNumber            = () => useCommMutation<{ phone_number: string; forward_to_e164: string; call_flow_id?: string }>('/api/communication/numbers/buy');
export const useSaveCallFlow         = () => useCommMutation<Partial<CallFlow>>('/api/communication/call-flows');
export const useSaveCallGroup        = () => useCommMutation<Partial<CallGroup>>('/api/communication/call-groups');
export const useSendWhatsApp         = () => useCommMutation<{ chat_id: string; text: string }>('/api/communication/whatsapp');

// ─── Email send (slice 7 - Resend, multipart) ──────────────────────────────

/** `account` and `from` are deliberately absent: both are server-owned. The
 *  sender identity is fixed, and `emails.account` doubles as the marker for
 *  app-generated mail, so a client must not be able to set either. */
export type SendEmailArgs = {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string[];
  thread_id?: string | null;
  reply_to_email_id?: string;
  job_id?: string;
  customer_id?: string;
  /** Traffic Cop (email slice 8b, Help Scout's pattern): "I started composing
   *  at this instant" - only meaningful on a reply (thread_id also present).
   *  Absent = the server guard has nothing to compare against and never fires
   *  (not a policy toggle - see ReplyDraft.composingSince's own doc). Omit
   *  entirely to intentionally bypass the guard on a deliberate retry (the
   *  Traffic Cop dialog's "Send anyway" - see InboxPage.tsx). */
  composing_since?: string;
  /** Real File objects to upload alongside the send - multer.array('files', 10)
   *  on the backend, 25MB/file. Never the legacy display-only {name,size}
   *  Attachment shape; callers map their attachment list down to just the
   *  `.file` members before passing this in. */
  files?: File[];
};

/** POST /api/communication/emails is multipart/form-data (email slice 7): the
 *  route needs to carry real file bytes alongside the compose fields, so this
 *  builds a FormData instead of going through useCommMutation's JSON-only
 *  `api.post(path, args)` - mirrors the established multipart pattern
 *  (JobFilesCard.tsx's upload, api.post(url, formData, { headers:
 *  {'Content-Type': 'multipart/form-data'} })). `body` rides as one
 *  JSON-encoded text field (multer never parses a nested array out of a plain
 *  form field) - the backend's sendEmailSchema parses it back into string[].
 */
export function useSendEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: SendEmailArgs) => {
      const fd = new FormData();
      fd.append('to', args.to);
      if (args.cc) fd.append('cc', args.cc);
      if (args.bcc) fd.append('bcc', args.bcc);
      if (args.subject) fd.append('subject', args.subject);
      fd.append('body', JSON.stringify(args.body));
      if (args.thread_id != null) fd.append('thread_id', args.thread_id);
      if (args.composing_since) fd.append('composing_since', args.composing_since);
      if (args.reply_to_email_id) fd.append('reply_to_email_id', args.reply_to_email_id);
      if (args.job_id) fd.append('job_id', args.job_id);
      if (args.customer_id) fd.append('customer_id', args.customer_id);
      for (const file of args.files ?? []) fd.append('files', file);
      return api
        .post('/api/communication/emails', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        .then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication'] }),
  });
}

/** One existing generic Attachment (photo/PDF already uploaded on a job/
 *  customer/estimate/invoice), reshaped for "Attach from this record"
 *  (email slice 7). Mirrors GET .../emails/attach-source's response row. */
export type AttachSourceFile = {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  display_name: string;
  created_at: string;
};

/** GET /api/communication/emails/attach-source?<param>=<id> - the compose
 *  window's "Attach from this record" read. Exactly one of job/customer/
 *  estimate/invoice id is meaningful per draft (ComposeOrigin's own
 *  contract); the first one present wins and the others are ignored rather
 *  than firing four requests. Disabled entirely with no origin id at all -
 *  a free compose has no record to attach from. */
export function useAttachSources(origin: ComposeOrigin) {
  const params = origin.jobId
    ? { job_id: origin.jobId }
    : origin.customerId
      ? { customer_id: origin.customerId }
      : origin.estimateId
        ? { estimate_id: origin.estimateId }
        : origin.invoiceId
          ? { invoice_id: origin.invoiceId }
          : null;
  return useQuery<AttachSourceFile[]>({
    queryKey: ['communication', 'attach-source', params],
    queryFn: () =>
      api
        .get('/api/communication/emails/attach-source', { params: params! })
        .then((r) => r.data.attachments),
    enabled: params != null,
  });
}
// useSaveDraft was removed: POST /api/communication/emails/draft has never
// existed on the backend. The call always failed, and once email left the phone
// gate it started failing as a 402 upsell for Phone & Messaging on a page the
// org owns. Drafts live in the Inbox's local state only; persisting them is
// part of building the real send path.
export const useAiAssist             = () => useCommMutation<unknown>('/api/communication/ai-assist');
export const useStartTrainingSession = () => useCommMutation<unknown>('/api/communication/training/sessions');

// ─── SMS send (slice 6) ─────────────────────────────────────────────────────

/** 201 response of POST /api/communication/sms. `delivery` is present only
 *  when CTM delivery was attempted: 'failed' means the row exists but the
 *  carrier send bounced (the message row is already stamped failed).
 *  `threadId` is present only on compose-to-number sends (slice H7) — the
 *  server-resolved conversation the text landed in. */
export type SendSmsResult = { message?: Message; threadId?: string; delivery?: 'sent' | 'failed' };

/** Human copy for a blocked SMS send — maps the compliance gate's 409
 *  `{ error, code }` to short UI strings, falls back to the server's error
 *  text, then to a generic retry line. Callers render this INLINE near the
 *  composer (danger tokens) — never a false success toast. */
export function smsSendErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; code?: string } } };
  const code = e?.response?.data?.code;
  const copy: Record<string, string> = {
    RECIPIENT_OPTED_OUT: 'This number has opted out of texts',
    NO_SMS_NUMBER: 'No SMS-capable number — buy one in Numbers',
    SMS_NOT_READY: 'Texting activates once A2P is approved',
    DUPLICATE_SEND: 'Duplicate message — just sent',
    NOT_IN_TEST_ALLOWLIST: "This number isn't on the test allowlist",
  };
  if (code && copy[code]) return copy[code];
  return e?.response?.data?.error ?? "Couldn't send the message — try again";
}

/** Send an SMS. Success invalidates the communication caches (the server
 *  thread carries the new message); failure ALSO invalidates so any stale
 *  optimistic view resyncs — callers await the result and surface
 *  `smsSendErrorMessage(err)` inline instead of toasting success blindly. */
export function useSendSms() {
  const qc = useQueryClient();
  return useMutation<
    SendSmsResult,
    unknown,
    { threadId?: string; customerId?: string; toNumber?: string; body: string; jobId?: string }
  >({
    mutationFn: (args) =>
      api.post('/api/communication/sms', args).then((r) => r.data as SendSmsResult),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['communication'] }),
    onError: () => qc.invalidateQueries({ queryKey: ['communication'] }),
  });
}

/** One-click reassign — move an SMS message to another job (or clear with
 *  null → back to the Unrouted tray). Callers commit local thread state and
 *  toast in the mutation's success path (no optimistic commit). */
export function useReassignSmsJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, jobId }: { messageId: string; jobId: string | null }) =>
      api.patch(`/api/communication/sms/${messageId}/job`, { job_id: jobId }).then((r) => r.data),
    onSuccess: () => {
      // Cross-surface sync: the SMS center, every job page's Communication tab
      // and every customer/lead roll-up show the same attribution. The entity
      // keys are PREFIX invalidations — ['job-communications'] matches all
      // ['job-communications', jobId] queries (same for customers/leads).
      qc.invalidateQueries({ queryKey: ['communication'] });
      qc.invalidateQueries({ queryKey: ['job-communications'] });
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
    },
    // Failed reassign: callers never committed locally — refetch the center's
    // server truth anyway so any stale view resyncs.
    onError: () => qc.invalidateQueries({ queryKey: ['communication'] }),
  });
}

/** Email mirror of useReassignSmsJob - move an email to another job (or clear
 *  with null). Same cross-surface invalidation set: an email's job chip shows
 *  in the hub and in all three entity roll-ups, so all four must resync. */
export function useReassignEmailJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ emailId, jobId }: { emailId: string; jobId: string | null }) =>
      api.patch(`/api/communication/emails/${emailId}/job`, { job_id: jobId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['communication'] });
      qc.invalidateQueries({ queryKey: ['job-communications'] });
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
    },
    onError: () => qc.invalidateQueries({ queryKey: ['communication'] }),
  });
}
