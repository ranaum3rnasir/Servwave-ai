/**
 * Job-scoped communication aggregation (Communication ↔ Jobs, Slice 1).
 *
 * CommItem is the FROZEN shared contract between the backend aggregation
 * endpoint (GET /api/jobs/:id/communications) and every frontend consumer —
 * field names must not change. Items arrive sorted ASCENDING by `at`
 * (oldest first).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { CommChannel } from '@/components/communication/shared/atoms';

export interface CommItem {
  id: string;
  channel: CommChannel;
  direction: 'in' | 'out';
  /** Counterparty display name (customer name; phone/email fallback). */
  who: string;
  /** call: "Inbound call · 4m 07s" / sms: "Text message" / whatsapp: "WhatsApp message" / email: subject or "(no subject)". */
  title: string;
  /** Body/snippet/summary, truncated ~160 chars. */
  preview: string;
  /** ISO timestamp. */
  at: string;
  /** Omitted (not null) when the item has no job attribution. */
  jobId?: string;
  jobLabel?: string;
  /** Lead linkage (call/email/sms lead_id, per-record; whatsapp chat.lead). Omitted when unlinked. */
  leadId?: string;
  /** #2046 - sms rows only: the row's `MessageThread.id`, so `EntitySmsDrawer` can re-source off
   *  the anchor-filtered by-id thread read (`useMessageThread`) instead of the section-gated
   *  org-wide list. Additive field, mirrors backend `mapMessage`'s `threadId` (R1). Omitted on
   *  every non-sms row and on an sms row with no thread (e.g. a hand-logged entry). */
  threadId?: string;
  /** Joined lead's lead_number (L00001-style). */
  leadLabel?: string;
  /** Calls only: answered_by csr name → agent user name → 'Forwarded phone' (external). */
  answeredBy?: string;
  /** Email rows sent by the system account (estimate/invoice/etc.). */
  transactional?: boolean;
  /** Reserved for the business-state chip (sage); NOT populated in v1. */
  state?: string;
  /** Call disposition etc. */
  meta?: string;
  /** Email delivery lifecycle (slice 5) - email channel only, and only once the
   *  Resend webhook has reported on this row. Exact camelCase mirror of
   *  Email.deliveryStatus (lib/api/communication-shared/email.ts) - see that
   *  type's doc comment for the full contract, including why "opened" can
   *  never appear here. Deliberately NOT rendered through StateChip: that
   *  component is hardcoded sage for "genuine business state (Approved /
   *  Paid)" (atoms.tsx's own color contract comment) and a bounce/failure
   *  must never read as that positive a color - it goes through StatusBadge's
   *  `messageDelivery` domain instead, which is tone-aware per status. */
  deliveryStatus?: string;
  deliveryStatusReason?: string;
  bounceKind?: string;
  /** Manual Communication Log: a record a human typed in about a conversation that happened off
   *  the platform, rather than one the platform recorded. Present only on those rows and omitted
   *  (never `false`) everywhere else. Renders the muted "Logged" chip. */
  manuallyLogged?: boolean;
  /** Who TYPED the entry, and who HAD the conversation — display names, not ids, because a reader
   *  of a timeline resolves an id by making a second lookup they never actually make. Both are
   *  carried separately so the row can say which is which: an admin backfilling an organisation's
   *  history is a second-hand witness to conversations colleagues had. Manual rows only. */
  loggedByName?: string;
  performedByName?: string;
  /** Who TYPED it, by id (slice 8) — what lets the row decide whether to offer an EDIT, which a
   *  display name cannot do because two colleagues can share one. A fact about the row; the rule
   *  is applied by `canModifyLoggedEntry` below and enforced for real by the API on the write.
   *  Manual rows only. */
  loggedById?: string;
}

/**
 * MAY THIS VIEWER CORRECT OR REMOVE THIS ENTRY — the affordance rule (slice 8).
 *
 * The logger, or an organisation admin. The API enforces exactly the same rule on the write, and
 * this is deliberately only the AFFORDANCE half: it decides whether to offer the action, never
 * whether the action is allowed. The two agreeing is what makes the UI honest; the two
 * disagreeing costs a 403 the user should not have been offered, never an edit that lands.
 *
 * `role`, the BASE role, because that is the field the API's own check reads — an ADMIN-derived
 * custom role is still the organisation's admin and is still the person expected to clean up
 * after a leaver. Mirroring it here is the point; diverging would be the bug.
 *
 * FAILS CLOSED on an entry with no `loggedById`. A payload that does not say who logged it cannot
 * establish that this viewer did.
 */
export function canModifyLoggedEntry(
  item: CommItem,
  viewer: { id?: string; role?: string },
): boolean {
  if (!item.manuallyLogged || !item.loggedById) return false;
  return item.loggedById === viewer.id || viewer.role === 'ADMIN';
}

/**
 * NEWEST FIRST — the single owner of the timeline's DISPLAY order.
 *
 * The endpoints return items ASCENDING (see this file's top doc comment) and that contract is
 * deliberately unchanged: `findTransactionalEmail` below reads the list in arrival order and
 * returns the LAST match to mean "the most recent send", so flipping the wire (or sorting inside
 * the hooks every consumer shares) would silently make a stale bounce shadow a clean resend.
 *
 * Every SURFACE that renders the stream, however, reads newest-first. That sort had been
 * hand-copied at each surface, and the copy the Job tab needed was simply never written — which
 * is the defect this function exists to make unrepeatable. Sorting here, at the point of display,
 * keeps the wire contract and the reading order independent, which is what they are.
 *
 * Compared as INSTANTS, not as strings: a lexical compare of ISO timestamps only happens to work
 * while every row carries the same UTC suffix, and orders wrongly the moment one carries an
 * offset. Returns a new array; the caller's data (react-query's cache) is never mutated.
 */
export function newestFirst(items: CommItem[] | undefined): CommItem[] {
  return [...(items ?? [])].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** GET /api/jobs/:id/communications — the job's unified timeline across channels. */
export function useJobCommunications(jobId?: string) {
  return useQuery({
    queryKey: ['job-communications', jobId],
    enabled: !!jobId,
    queryFn: () =>
      api.get(`/api/jobs/${jobId}/communications`).then((r) => r.data.items as CommItem[]),
    // Live refresh: a call/text placed from this job lands as a webhook row a few
    // seconds after hangup — poll + refetch on focus so it appears without a
    // manual reload (house pattern, notifications.ts).
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * GET /api/leads/:id/communications — the lead's timeline: STRICTLY rows
 * attributed to this lead by lead_id, mirroring useJobCommunications' job_id
 * scoping exactly (full job-parity ruling, 2026-07-22 — no customer-history
 * union). A row with lead_id null won't surface here even if it belongs to
 * the same customer, same as an un-job-tagged row on a job's timeline.
 */
export function useLeadCommunications(leadId?: string) {
  return useQuery({
    queryKey: ['lead-communications', leadId],
    enabled: !!leadId,
    queryFn: () =>
      api.get(`/api/leads/${leadId}/communications`).then((r) => r.data.items as CommItem[]),
    // Live refresh — see useJobCommunications.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * POST /api/communication/sms — send a text stamped with this LEAD at origin.
 * Mirrors useSendJobSms; the backend accepts an explicit `leadId` (slice E4 lead
 * attribution), org-validates it, and stamps both the thread and the resulting
 * message row with lead_id so it surfaces on the lead's strictly lead_id-scoped
 * timeline. customerId still routes the thread.
 */
export function useSendLeadSms(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: string }) =>
      api.post('/api/communication/sms', { customerId, body, leadId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-communications', leadId] });
      // Prefix match — refresh the per-customer roll-up too (the row is
      // customer-linked as well as lead-linked).
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
      qc.invalidateQueries({ queryKey: ['lead', leadId] });
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/**
 * WHAT KIND of conversation is being logged (slice 6) — the three channels a conversation with a
 * customer actually happens over when it does not pass through ServWave.
 *
 * There are exactly three, and the list is not an arbitrary starting point: in-person
 * conversations, voicemail-left, letters and walk-ins have no slot in the shared CommItem
 * `channel` union and would have to be threaded through every mapper and filter in the backend
 * aggregator. Explicitly out of scope, per the spec.
 *
 * `sms` on the wire and "Text" on screen — the same split CommItem and the channel icons already
 * use, so one vocabulary reaches the API and another reaches the reader, deliberately.
 */
export const MANUAL_COMM_CHANNELS = [
  { value: 'call', label: 'Call' },
  { value: 'sms', label: 'Text' },
  { value: 'email', label: 'Email' },
] as const;

export type ManualCommChannel = (typeof MANUAL_COMM_CHANNELS)[number]['value'];

/**
 * WHICH ENTITY a logged entry hangs off. Exactly one, never both and never neither.
 *
 * A union rather than two optional ids, because that is the rule: the API refuses a body naming
 * both or naming neither, and the database carries the same invariant as
 * `manual_communication_logs_exactly_one_anchor`. Two optional fields would let a caller express
 * either mistake and find out at runtime; this shape cannot express them at all.
 *
 * It also carries the ROLL-UP consequence: the anchor decides which timeline query to refresh,
 * and an entry logged on a lead that later became a job stays on the lead — nothing here
 * migrates it forward.
 */
export type ManualCommAnchor =
  | { kind: 'lead'; id: string }
  | { kind: 'job'; id: string }
  // The third anchor (#2021): a conversation about the customer and about no one lead or job -
  // and the only anchor available at all on a customer holding neither.
  | { kind: 'customer'; id: string };

/**
 * The ONE place an anchor becomes wire keys, shared by create and update.
 *
 * Shared rather than written twice because the two bodies do not disagree about it, and the way
 * that drifts is silent: an update that named the anchor differently from a create would move
 * entries between records nobody asked to move. Exactly one key is ever produced - the union
 * above is what guarantees it, and it is the same invariant the API's anchor COUNT and the
 * database's `manual_communication_logs_exactly_one_anchor` CHECK enforce on the other side.
 */
function anchorBody(anchor: ManualCommAnchor): Record<string, string> {
  switch (anchor.kind) {
    case 'lead':
      return { lead_id: anchor.id };
    case 'job':
      return { job_id: anchor.id };
    case 'customer':
      return { customer_id: anchor.id };
  }
}

/**
 * POST /api/communication/manual-log — record a communication that ALREADY happened.
 *
 * Not a send: nothing leaves the building, nobody is notified, no automation fires. The entry
 * lands in the timeline of the lead or job it names — and on that entity's customer roll-up —
 * marked as hand-entered, and NOWHERE in the Communication module.
 *
 * `occurredAt` goes on the wire as the ZONELESS wall clock the picker produced
 * ('YYYY-MM-DDTHH:MM'), never as an ISO instant. Converting it here would resolve it against the
 * BROWSER's zone; the server composes it against the ORGANISATION's, and refuses a value that
 * already carries a zone. See LogCommunicationDrawer's header.
 */
export function useLogCommunication(anchor: ManualCommAnchor) {
  const qc = useQueryClient();
  // The exact key the anchor's own timeline query uses (useLeadCommunications /
  // useJobCommunications above), so the entry appears without a manual reload.
  const timelineKey =
    anchor.kind === 'lead'
      ? ['lead-communications', anchor.id]
      : anchor.kind === 'customer'
        ? ['customer-communications', anchor.id]
        : ['job-communications', anchor.id];
  return useMutation({
    mutationFn: ({
      channel,
      direction,
      occurredAt,
      notes,
      performedBy,
      durationMinutes,
      subject,
    }: {
      /** Call, text or email. Always sent — the entry's channel is a stated fact of the record,
       *  not something the server should have to fall back on a column default for. */
      channel: ManualCommChannel;
      direction: 'in' | 'out';
      occurredAt: string;
      notes: string;
      /** Who HAD the conversation. There is deliberately no counterpart for the logger: the
       *  server takes that from the authenticated principal and the API refuses a body naming
       *  it, so this hook has no way to send one even by mistake. */
      performedBy: string;
      /** How long it lasted, in whole minutes — OPTIONAL, and omitted from the body rather
       *  than sent as null when the user left it alone. A blank duration is "I don't know how
       *  long it was", which is a different fact from zero. */
      durationMinutes?: number;
      /** The subject line of a logged email — optional, and meaningful only for that channel.
       *  The API refuses one on a call or a text: the timeline builds its title out of these
       *  columns, so a subject on a call would render as one. */
      subject?: string;
    }) =>
      api
        .post('/api/communication/manual-log', {
          // Exactly one anchor key reaches the wire — the union above is what guarantees it.
          ...anchorBody(anchor),
          channel,
          direction,
          occurred_at: occurredAt,
          notes,
          performed_by: performedBy,
          // Each optional field is sent only when its own channel made it available. The drawer
          // clears them on a channel change rather than hiding them, so an answer that no longer
          // applies cannot ride along.
          ...(durationMinutes != null && { duration_minutes: durationMinutes }),
          ...(subject != null && { subject }),
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: timelineKey });
      // Prefix match — the entry rolls up onto the customer through whichever anchor it names,
      // so every per-customer roll-up is stale after this.
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
    },
  });
}

/**
 * The whole stored entry, as the capture form reopens on it (slice 8).
 *
 * NOT the same thing as the timeline's `CommItem`, and the difference is why this exists: a
 * CommItem's `preview` is truncated at 160 characters and it carries no duration, outcome,
 * performer id or subject. A form seeded from one would silently discard the tail of somebody's
 * notes the moment they pressed save.
 */
export interface ManualLogEntry {
  id: string;
  channel: ManualCommChannel;
  direction: 'in' | 'out';
  /** The instant, for display. */
  occurredAt: string;
  /** THE SAME INSTANT ON THE ORGANISATION'S CLOCK, 'YYYY-MM-DDTHH:MM' — what the picker reopens
   *  on. Composed by the server, never derived here: this component has no safe way to do it
   *  (`useScheduleTimezone()` answers with a guess while the organisation query is in flight), and
   *  reopening on the wrong zone and saving unchanged would MOVE the entry. */
  occurredAtLocal: string;
  notes: string;
  durationMinutes: number | null;
  subject: string | null;
  leadId: string | null;
  jobId: string | null;
  /** The third anchor (#2021). Exactly one of the three is ever non-null. */
  customerId: string | null;
  performedBy: string;
  loggedBy: string;
  manuallyLogged: true;
}

/** Somebody the drawer may credit a conversation to: a name to show and an id to send. */
export interface ManualLogPerformer {
  id: string;
  first_name: string;
  last_name: string;
}

/**
 * GET /api/communication/manual-log/performers — the "who had the conversation?" roster.
 *
 * NOT `GET /api/users`, which is what this picker used to read. That route is gated on
 * `read User`, a grant SALES does not hold and does not gain from being allowed to log past
 * communications — so the picker 403'd and rendered EMPTY for exactly the role an admin had just
 * granted the capability to. This endpoint is guarded by that capability instead, and returns id
 * and display name only. See the handler for why `read User` was not simply granted alongside.
 */
export function useManualLogPerformers(enabled = true) {
  return useQuery({
    queryKey: ['manual-log-performers'],
    enabled,
    queryFn: () =>
      api
        .get('/api/communication/manual-log/performers')
        .then((r) => r.data.users as ManualLogPerformer[]),
    staleTime: 30_000,
  });
}

/** GET /api/communication/manual-log/:id — the entry the edit form reopens on. */
export function useManualCommunicationLog(id?: string) {
  return useQuery({
    queryKey: ['manual-communication-log', id],
    enabled: !!id,
    queryFn: () =>
      api.get(`/api/communication/manual-log/${id}`).then((r) => r.data.entry as ManualLogEntry),
  });
}

/**
 * Everything an edit or a delete makes stale.
 *
 * PREFIX invalidation across BOTH anchor families, not the one key the create path invalidates.
 * An edit can RE-POINT an entry from a lead to a job, which leaves two lists wrong: the one it
 * left and the one it joined. The mutation knows the destination and could compute the origin,
 * but a rule of the form "also invalidate the old one" is exactly the rule that gets forgotten
 * when a field is added; refetching both families is cheap and cannot be wrong.
 */
function invalidateTimelines(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['lead-communications'] });
  qc.invalidateQueries({ queryKey: ['job-communications'] });
  qc.invalidateQueries({ queryKey: ['customer-communications'] });
}

/**
 * PUT /api/communication/manual-log/:id — correct an entry.
 *
 * THE WHOLE EDITABLE RECORD, replaced. Every field the form shows is sent on every save, and one
 * the user cleared is sent as absent so the server stores NULL. That is the contract the API
 * declares (see its schema), and it is what stops a duration typed against a call surviving onto
 * an email — the pairing the API refuses and the timeline would otherwise render.
 *
 * `occurredAt` goes on the wire as the ZONELESS wall clock, exactly as on create.
 */
export function useUpdateCommunicationLog(entryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      anchor: ManualCommAnchor;
      channel: ManualCommChannel;
      direction: 'in' | 'out';
      occurredAt: string;
      notes: string;
      /** Who HAD the conversation. Required here, unlike on create: an edit that said nothing
       *  about it would let the server fall back on the caller, silently re-crediting an admin
       *  who was only fixing a colleague's typo. */
      performedBy: string;
      durationMinutes?: number;
      subject?: string;
    }) =>
      api
        .put(`/api/communication/manual-log/${entryId}`, {
          // Exactly one anchor key reaches the wire — and naming a DIFFERENT one is how an entry
          // moves between a lead, a job and a customer.
          ...anchorBody(vars.anchor),
          channel: vars.channel,
          direction: vars.direction,
          occurred_at: vars.occurredAt,
          notes: vars.notes,
          performed_by: vars.performedBy,
          ...(vars.durationMinutes != null && { duration_minutes: vars.durationMinutes }),
          ...(vars.subject != null && { subject: vars.subject }),
        })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manual-communication-log', entryId] });
      invalidateTimelines(qc);
    },
  });
}

/** DELETE /api/communication/manual-log/:id — remove an entry logged on the wrong record. */
export function useDeleteCommunicationLog(entryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/communication/manual-log/${entryId}`).then((r) => r.data),
    onSuccess: () => invalidateTimelines(qc),
  });
}

/**
 * POST /api/communication/sms — send a text stamped with this job at origin
 * (attach-by-origin: composed from a job page → tagged at send).
 */
export function useSendJobSms(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: string }) =>
      api.post('/api/communication/sms', { customerId, body, jobId }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-communications', jobId] });
      // Prefix matches — refresh every per-customer roll-up
      // (['customer-communications', customerId]) and per-lead union
      // (['lead-communications', leadId]; customer-linked rows show there too).
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
    },
  });
}

/**
 * POST /api/communication/emails — send an email stamped with this job at
 * origin (attach-by-origin). The backend takes `body` as an array of lines
 * and snake_case `job_id`; it resolves + stamps job_label itself.
 */
export function useSendJobEmail(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ to, subject, body }: { to: string; subject: string; body: string }) =>
      api
        .post('/api/communication/emails', { to, subject, body: [body], job_id: jobId })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job-communications', jobId] });
      qc.invalidateQueries({ queryKey: ['customer-communications'] });
      qc.invalidateQueries({ queryKey: ['lead-communications'] });
      qc.invalidateQueries({ queryKey: ['communication'] });
    },
  });
}

/**
 * Email slice 5 — correlating an Estimate/Invoice's OWN transactional send
 * against a comm timeline this module already exposes.
 *
 * WHY THIS EXISTS: Email carries customer_id/lead_id/job_id, but no
 * estimate_id or invoice_id column (verified against schema.prisma - adding
 * one is a real migration, out of scope for this slice). What Estimate/
 * Invoice detail pages CAN read today is the same job/lead/customer comm
 * timeline the Job/Customer/Lead Communication tabs already render (their own
 * transactional send stamps job_id and/or lead_id/customer_id at origin — see
 * backend lib/email.ts's sendEstimateEmail/sendEstimateWithDepositEmail/
 * sendInvoiceEmail call sites). The subject line is fully deterministic
 * (`Estimate ${estimateNumber} ...` / `Invoice ${invoiceNumber} ...`) and the
 * number is unique per org, so a prefix match against that same list is a
 * precise, zero-migration correlation — not a fuzzy heuristic.
 *
 * `items` is read in the ASCENDING (oldest-first) order these endpoints
 * return (see this file's top doc comment); this returns the LAST match,
 * i.e. the most recent send/resend, so a stale bounce from send #1 never
 * shadows a clean send #2.
 *
 * BOUNDARY, not a bare startsWith: estimate revisions on the same lead are
 * numbered with a `-N` suffix (e.g. E00042 alongside E00042-2), and a bare
 * `title.startsWith(subjectPrefix)` would let "Estimate E00042-2 from
 * ServWave" false-match a lookup for "Estimate E00042" - the shorter number
 * IS a string-prefix of the longer one. The character immediately after the
 * prefix must therefore be a space or end-of-string (every real subject
 * format puts a space before "from"/"—"/"Deposit ..." right after the
 * number, or - for a bare `Invoice ${invoiceNumber}` with no org name - ends
 * there outright), never a digit or hyphen.
 */
export function findTransactionalEmail(
  items: CommItem[] | undefined,
  subjectPrefix: string,
): CommItem | undefined {
  if (!items) return undefined;
  let match: CommItem | undefined;
  for (const item of items) {
    // PLATFORM sends only (slice 6). What this function's answer is used for is a delivery
    // status and a bounce banner - claims about what ServWave's own mail transport did. A
    // hand-logged email is a record of a message somebody sent from Outlook, so it can never be
    // the send an estimate or invoice is asking about. Guarded on provenance rather than on the
    // title, even though a logged entry's title ("Outbound email · <subject>") would not match
    // this prefix: the title is a rendering decision and this is a correctness one.
    if (item.channel !== 'email' || item.direction !== 'out' || item.manuallyLogged) continue;
    if (!item.title.startsWith(subjectPrefix)) continue;
    const boundary = item.title[subjectPrefix.length];
    if (boundary !== undefined && boundary !== ' ') continue;
    match = item;
  }
  return match;
}
