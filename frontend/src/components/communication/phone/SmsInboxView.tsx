// Phone module — SMS unified inbox (3-pane messenger).
//
// Ported from Emanuel's PhonePage monolith (regions L3541-4309 + L4321-4345).
// The monolith's `InboxView` is renamed `SmsInboxView` here to avoid clashing
// with the email InboxPage. Behaviour and prop signatures are preserved
// verbatim; only two things changed:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens. emerald,
//      amber, rose, sky status tints are kept.
//   2. Module-scope data (customers) now comes from the
//      `@/lib/api/communication` seam hooks; the pure helpers that closed
//      over those arrays (threadTitle, buildRecipients) take the array(s) as
//      explicit arguments — same convention as the shared `customerById`.
//   3. v1 texting is customer-only: the Team / Group lanes + "By job" roster
//      (mock-fed, wired to toast-only sends) are hidden until an internal
//      messaging backend exists. Sends are REAL (POST /api/communication/sms):
//      bubbles commit on the 201, delivery:'failed' renders the failed bubble,
//      and a 409 from the compliance gate surfaces inline near the composer.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  Inbox as InboxIcon,
  MailOpen,
  MessageSquare,
  Plus,
  Search,
  Send,
  Sparkles,
  User,
  UserPlus,
  Users,
  UsersRound,
} from "lucide-react";
import { JobBadge } from "@/components/communication/shared/atoms";
import { customerById, InfoRow, shortTime } from "@/components/communication/phone/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import {
  useCtmStatus,
  useCustomerJobs,
  useMarkThreadRead,
  useMarkThreadUnread,
  useMessageThreads,
  useNumbers,
  usePhoneCustomers,
  useReassignSmsJob,
  useSendSms,
  smsSendErrorMessage,
  fmtPhone,
  normalizeNAPhone,
  CAMPAIGN_LABELS,
  deliveryNote,
  outboundBubbleClass,
} from "@/lib/api/communication";
import type {
  CustomerJobNav,
  Message,
  MessageThread,
  ThreadKind,
  PhoneCustomer,
  SendSmsResult,
} from "@/lib/api/communication";
import { useScheduleTimezone } from '@/lib/schedule-tz';

// Lanes: customer conversations, staff (Team), archive.
//
// The Team lane is real as of Spec C. Automations now text members of staff and
// record each send as a `kind: 'team'` thread keyed on the person (see
// backend services/automations/smsRecord.ts). Before that it was a prototype
// affordance wired to nothing and hiding it was right; leaving it hidden once
// something writes those threads means a staff text is written, stored and
// invisible.
//
// It is a SEPARATE lane rather than staff threads folded into Conversations, on
// purpose: an admin must never be in doubt about whether the conversation in
// front of them is with a customer, and a lane answers that more strongly than
// an icon does.
//
// The Group lane stays hidden - nothing writes `kind: 'group'`, so it would be
// the same empty prototype it always was.
type ThreadFilter = "conversations" | "team" | "archive";

const THREAD_FILTERS: {
  key: ThreadFilter;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: "conversations", label: "Conversations", icon: MessageSquare },
  { key: "team", label: "Team", icon: Users },
  { key: "archive", label: "Archive", icon: Archive },
];

/** Per-lane empty state. Named per lane rather than derived, so the team lane
 *  does not call a staff thread a "conversation" - the word this whole slice is
 *  keeping reserved for customers. */
const EMPTY_LANE_COPY: Record<ThreadFilter, string> = {
  conversations: "No conversations.",
  team: "No team conversations.",
  archive: "No archived conversations.",
};

function threadKind(t: MessageThread): ThreadKind {
  return t.kind ?? "customer";
}

/** Display name for a thread — the customer's name, or the explicit title
 * we keep on team/group threads that aren't tied to a Customer record.
 * Unknown-number threads are titled by their E.164 key — pretty-print those
 * (team/group name titles don't normalize and pass through untouched). */
function threadTitle(t: MessageThread, customers: PhoneCustomer[]): string {
  if (t.title) {
    const e164 = normalizeNAPhone(t.title);
    return e164 ? fmtPhone(e164) : t.title;
  }
  return customerById(customers, t.customerId)?.name ?? "Unknown";
}

/** Small uppercase meta line under each row / in the conversation header. */
function threadMeta(t: MessageThread): string {
  const kind = threadKind(t);
  if (kind === "team") return `Team · ${t.subtitle ?? "Internal"}`;
  if (kind === "group") return `Group · ${t.subtitle ?? "Crew"}`;
  return `${CAMPAIGN_LABELS[t.campaignType]} · SMS`;
}

/** Which lane a thread belongs to. Archive wins over kind - archived means
 *  archived whatever the counterparty is - and the two live lanes partition the
 *  rest strictly by kind, so no thread can ever show up in both. A `group`
 *  thread still matches nothing, exactly as before. */
function matchesFilter(t: MessageThread, f: ThreadFilter): boolean {
  if (f === "archive") return !!t.archived;
  if (t.archived) return false;
  if (f === "team") return threadKind(t) === "team";
  return threadKind(t) === "customer";
}

/** The counterpart number of an unknown-number thread — a title-keyed SMS
 * thread with no linked customer OR vendor (its title IS the number, stored
 * E.164 by the shared keying rule). E.164 where normalizable, else the raw
 * title. Null for customer / vendor / team / group threads. */
function unknownThreadNumber(t: MessageThread): string | null {
  if (threadKind(t) !== "customer" || t.customerId || t.vendorId || !t.title) return null;
  return normalizeNAPhone(t.title) ?? t.title;
}

/** Build the outbound bubble from the send's 201. The server settles the row's
 *  real status (queued / sent / delivered / skipped / failed) and returns it -
 *  echo that verbatim rather than assuming "sent", which is exactly the
 *  false-success the backend stopped writing. */
function buildOutMessage(data: SendSmsResult | undefined, body: string): Message {
  return {
    id: data?.message?.id ?? `m_${Date.now()}`,
    direction: "out",
    body,
    ts: data?.message?.ts ?? new Date().toISOString(),
    status: data?.message?.status ?? "queued",
    ...(data?.message?.statusReason ? { statusReason: data.message.statusReason } : {}),
  };
}

/** A row in the inbox list: either a live thread, or a directory member who
 * has no thread yet (so the bucket shows the *whole* roster — pick anyone to
 * start a conversation). PHONE-SYSTEM-PRD §14.17. */
type InboxRow =
  | { kind: "thread"; thread: MessageThread }
  | { kind: "person"; member: Recipient };

export function SmsInboxView({
  threads,
  setThreads,
  onToast,
}: {
  threads: MessageThread[];
  setThreads: React.Dispatch<React.SetStateAction<MessageThread[]>>;
  onToast: (m: string) => void;
}) {
  // Data seam — module-scope arrays in Emanuel's monolith now come from hooks.
  const { data: customers = [] } = usePhoneCustomers();
  const tz = useScheduleTimezone();
  // The server thread directory, consulted directly by the deep-link effect:
  // the `threads` prop lags one commit behind (TextPage's seed-merge effect),
  // and isFetched distinguishes "no thread yet" from "still loading".
  const threadsQuery = useMessageThreads();
  const threadDir = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);
  const sendSms = useSendSms();
  const reassignSms = useReassignSmsJob();
  // #2049 - the persisting half of every local `unread: 0` write below (send
  // paths + openThread). Fire-and-forget: the local zero is already applied
  // optimistically by the same call sites, so a slow/failed PATCH costs a
  // stale badge on the NEXT poll at worst, never a blocked UI.
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const navigate = useNavigate();

  // Composer gate (§5.4): texting is live only when the org's CTM sub-account
  // is connected AND the A2P campaign is approved (sms_ready) AND the org owns
  // at least one SMS-capable number to send from.
  const { connected, smsReady } = useCtmStatus();
  const numbersQuery = useNumbers();
  const noSmsNumber =
    connected &&
    smsReady &&
    numbersQuery.isSuccess &&
    !(numbersQuery.data ?? []).some((n) => n.smsEnabled);
  const smsBlocked = !connected || !smsReady || noSmsNumber;

  // Inline send failure — rendered near the composer (danger tokens), never a
  // false success toast. Cleared on the next attempt / thread switch.
  const [sendError, setSendError] = useState<string | null>(null);

  const [filter, setFilter] = useState<ThreadFilter>("conversations");
  const visible = useMemo(
    () => threads.filter((t) => matchesFilter(t, filter)),
    [threads, filter],
  );
  const [openId, setOpenId] = useState<string>(threads[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  // Composer prefill from deep links: ?to= seeds a raw number, ?customerId=
  // (with no existing thread) preselects that customer in the dialog.
  const [composeSeed, setComposeSeed] = useState<{ number?: string; customerId?: string } | null>(null);
  // Compose-to-number send failure — rendered INSIDE the dialog (there is no
  // conversation to fall back to until the server resolves the thread).
  const [composeError, setComposeError] = useState<string | null>(null);
  const open = threads.find((t) => t.id === openId) ?? visible[0];
  // The open thread's counterpart number when it is an unknown-number thread
  // (title-keyed, no customer/vendor) — drives the header affordance and the
  // reply payload (no customerId to send by).
  const openUnknownNumber = open ? unknownThreadNumber(open) : null;
  // Staff (team) threads are an OUTBOUND RECORD, not a conversation: nothing
  // routes a reply to a person, and the server has no destination for one -
  // `resolveSmsDestination` (comm-threads.controller) resolves customer ->
  // vendor -> title-as-number and has no user branch, and the delivery block
  // above it is gated on `isJobAttributableThread`, which a team thread fails.
  // So a reply typed here would not 409: it would be RECORDED and never sent,
  // settling at `queued` for ever and rendering as a "Sending" bubble the admin
  // reads as delivered. That is the exact false-success shape the honest-status
  // work removed. Say so instead of offering the box.
  const openIsStaffThread = open ? threadKind(open) === "team" : false;

  // Deep links — resolved once. ?threadId=… opens the exact thread
  // (notification bell); ?customerId=… opens that customer's thread (job page
  // link, dialer Text action) or, when no thread exists yet, the composer with
  // the customer preselected; ?to=… opens the composer prefilled with a raw
  // number (dialer Text on a number-only entry). Thread lookups consult the
  // server directory (threadDir) as well as the merged `threads` prop, which
  // lags one commit behind the seed.
  const [searchParams] = useSearchParams();
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    const to = searchParams.get("to");
    const customerId = searchParams.get("customerId");
    const threadId = searchParams.get("threadId");
    if (!to && !customerId && !threadId) {
      deepLinked.current = true;
      return;
    }
    if (to) {
      deepLinked.current = true;
      setComposeSeed({ number: to });
      setComposeOpen(true);
      return;
    }
    const byParam = (t: MessageThread) =>
      (threadId ? t.id === threadId : false) ||
      (customerId ? t.customerId === customerId : false);
    const target = threads.find(byParam) ?? threadDir.find(byParam);
    if (target) {
      deepLinked.current = true;
      setOpenId(target.id);
      return;
    }
    // Directory fully loaded and still no thread for this customer → start
    // one: open the composer with the customer preselected.
    if (customerId && threadsQuery.isFetched) {
      deepLinked.current = true;
      setComposeSeed({ customerId });
      setComposeOpen(true);
    }
  }, [threads, threadDir, threadsQuery.isFetched, searchParams]);

  // The open thread's customer jobs — feed the right-rail navigation list and
  // the one-click reassign menus (open jobs only as targets). Scoped to
  // CUSTOMER threads only: team/group internal lanes never load job context.
  const { data: customerJobs = [] } = useCustomerJobs(
    open && threadKind(open) === "customer" ? open.customerId || undefined : undefined,
  );
  const openJobs = useMemo(() => customerJobs.filter((j) => j.open), [customerJobs]);

  // One-click reassign — commit on confirmation: the local thread update and
  // the success toast run only after the PATCH resolves; a failed PATCH leaves
  // local state untouched (the hook refetches ['communication'] to resync) and
  // surfaces an error toast. null clears the tag (back to the Unrouted tray).
  function reassignMessage(
    threadId: string,
    messageId: string,
    job: { id: string; number: string } | null,
  ) {
    reassignSms.mutate(
      { messageId, jobId: job?.id ?? null },
      {
        onSuccess: () => {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId
                ? {
                    ...t,
                    messages: t.messages.map((m) =>
                      m.id === messageId
                        ? { ...m, jobId: job?.id, jobLabel: job?.number }
                        : m,
                    ),
                  }
                : t,
            ),
          );
          onToast(job ? `Tagged to ${job.number}` : "Job tag removed");
        },
        onError: () => {
          onToast("Couldn't update the job tag — try again");
        },
      },
    );
  }

  // Merge live threads with the rest of the customer directory so the side
  // list always shows everyone you can message — not just open threads.
  const rows = useMemo<InboxRow[]>(() => {
    const threadRows: InboxRow[] = visible.map((t) => ({ kind: "thread", thread: t }));
    if (filter === "conversations") {
      const taken = new Set(visible.map((t) => t.customerId).filter(Boolean));
      const extras = buildRecipients(customers)
        .filter((m) => m.customerId && !taken.has(m.customerId))
        .map<InboxRow>((m) => ({ kind: "person", member: m }));
      return [...threadRows, ...extras];
    }
    return threadRows;
  }, [visible, filter, customers]);

  // Switch directory buckets — and reselect the first thread in the bucket so
  // the conversation pane never shows a thread that's filtered out of view.
  function pickFilter(f: ThreadFilter) {
    setFilter(f);
    setSendError(null);
    const first = threads.find((t) => matchesFilter(t, f));
    setOpenId(first?.id ?? "");
  }

  // Start (or jump to) a conversation with a customer from the New-message
  // composer — select (or create) the thread, and commit the outbound bubble
  // only after the server confirms the send. A failed send opens the thread
  // with the text restored to the draft + the mapped error inline.
  function startCustomerThread(customerId: string, body: string) {
    const text = body.trim();
    if (text && sendSms.isPending) return;
    setFilter("conversations");
    setSendError(null);
    const existing = threads.find((t) => t.customerId === customerId);

    function selectThread(msg?: Message) {
      if (existing) {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === existing.id
              ? { ...t, messages: msg ? [...t.messages, msg] : t.messages, unread: 0 }
              : t,
          ),
        );
        setOpenId(existing.id);
        // #2049 - a real server thread id (this branch only fires for a
        // thread already known from the seed); the brand-new local placeholder
        // below has none yet, so there is nothing to persist.
        markThreadRead.mutate(existing.id);
      } else {
        const id = `thr_${Date.now()}`;
        setThreads((prev) => [
          {
            id,
            customerId,
            channel: "sms",
            campaignType: "customer_care",
            unread: 0,
            messages: msg ? [msg] : [],
          },
          ...prev,
        ]);
        setOpenId(id);
      }
    }

    if (!text) {
      selectThread();
      setComposeOpen(false);
      onToast("Conversation opened");
      return;
    }

    sendSms.mutate(
      { customerId, body: text },
      {
        onSuccess: (data) => {
          selectThread(buildOutMessage(data, text));
          closeCompose();
          if (data?.delivery !== "failed") {
            onToast(
              `✉️ Message sent to ${customerById(customers, customerId)?.name ?? "customer"}`,
            );
          }
        },
        onError: (err) => {
          // No bubble — the server rejected the send. Mirror startNumberThread:
          // surface the mapped reason, no thread selection — selectThread()
          // for a customer with no existing thread created a local phantom
          // conversation that was never rolled back (s1d).
          closeCompose();
          setDraft(text);
          setSendError(smsSendErrorMessage(err));
        },
      },
    );
  }

  // Compose to an ARBITRARY number (slice H7). The server keys the thread
  // exactly like the CTM webhook ingest (customer match → that customer's
  // thread; unmatched → a title-keyed "unknown number" thread) and returns the
  // resolved threadId, so the bubble commits onto the REAL conversation. A
  // rejected send keeps the dialog open with the mapped reason inline.
  function startNumberThread(e164: string, body: string) {
    const text = body.trim();
    if (!text || sendSms.isPending) return;
    setComposeError(null);
    sendSms.mutate(
      { toNumber: e164, body: text },
      {
        onSuccess: (data) => {
          setFilter("conversations");
          setSendError(null);
          const msg = buildOutMessage(data, text);
          const id = data?.threadId ?? `thr_${Date.now()}`;
          setThreads((prev) => {
            const existing = data?.threadId ? prev.find((t) => t.id === data.threadId) : undefined;
            if (existing) {
              return prev.map((t) =>
                t.id === existing.id
                  ? { ...t, messages: [...t.messages, msg], unread: 0 }
                  : t,
              );
            }
            // Placeholder until the next poll replaces it by id with the
            // server row (which carries the linked customer, if any).
            return [
              {
                id,
                customerId: "",
                channel: "sms" as const,
                campaignType: "customer_care" as const,
                unread: 0,
                messages: [msg],
                title: e164,
              },
              ...prev,
            ];
          });
          setOpenId(id);
          // #2049 - the server always resolves/creates a real thread for this
          // path and returns its id (`threadFromNumber`); the local `thr_...`
          // fallback only covers a response shape that never actually occurs.
          if (data?.threadId) markThreadRead.mutate(data.threadId);
          closeCompose();
          if (data?.delivery !== "failed") onToast(`✉️ Message sent to ${fmtPhone(e164)}`);
        },
        onError: (err) => setComposeError(smsSendErrorMessage(err)),
      },
    );
  }

  function closeCompose() {
    setComposeOpen(false);
    setComposeSeed(null);
    setComposeError(null);
  }

  function send() {
    if (smsBlocked || openIsStaffThread || !draft.trim() || !open || sendSms.isPending) return;
    const body = draft.trim();
    setSendError(null);
    sendSms.mutate(
      // Unknown-number threads carry no customerId — reply by threadId (their
      // id is always the server's; they only enter local state server-first).
      openUnknownNumber ? { threadId: open.id, body } : { customerId: open.customerId, body },
      {
        onSuccess: (data) => {
          // Commit the bubble on confirmation only; a delivery:'failed' 201
          // renders the failed bubble (danger) and NO success toast.
          const msg = buildOutMessage(data, body);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === open.id ? { ...t, messages: [...t.messages, msg], unread: 0 } : t,
            ),
          );
          // #2049 - replying to an already-open thread; it is always a real
          // server thread by this point (openUnknownNumber's own doc: "their
          // id is always the server's").
          markThreadRead.mutate(open.id);
          setDraft("");
          if (data?.delivery !== "failed") onToast("✉️ Message sent");
        },
        onError: (err) => setSendError(smsSendErrorMessage(err)),
      },
    );
  }

  function openThread(id: string) {
    setOpenId(id);
    setSendError(null);
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread: 0 } : t)));
    // #2049 - the persisting half of the fix: this used to zero `unread` in
    // React state only, so a reload or the next 20s poll restored the badge.
    markThreadRead.mutate(id);
  }

  // #2049 (AC3) - the mirror of openThread's persistence: "Mark as unread" on
  // the currently-open conversation, the SMS parity for email's reading-pane
  // affordance (readingPane.tsx's markUnread).
  function markOpenThreadUnread() {
    if (!open) return;
    setThreads((prev) => prev.map((t) => (t.id === open.id ? { ...t, unread: t.unread || 1 } : t)));
    markThreadUnread.mutate(open.id);
  }

  return (
    <div className="grid h-full grid-cols-12">
      {/* Thread list + directory filter */}
      <div className="col-span-4 flex flex-col overflow-hidden border-r border-border bg-surface-light lg:col-span-3">
        <div className="flex flex-col gap-2 border-b border-border px-2 py-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <InboxIcon className="h-3.5 w-3.5" /> Inbox
            </span>
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] font-semibold text-on-fill transition hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          {/* Directory tabs — wrap to a second row in the narrow column */}
          <div className="flex flex-wrap items-center gap-1">
            {THREAD_FILTERS.map((f) => {
              const on = filter === f.key;
              const count = threads.reduce(
                (n, t) => n + (matchesFilter(t, f.key) ? t.unread : 0),
                0,
              );
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => pickFilter(f.key)}
                  className={[
                    "inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition",
                    on
                      ? "border-primary bg-primary text-on-fill"
                      : "border-border bg-surface-light text-text-secondary hover:bg-background-light",
                  ].join(" ")}
                >
                  <f.icon className="h-3.5 w-3.5" />
                  {f.label}
                  {count > 0 && (
                    <span
                      className={[
                        "ml-0.5 rounded-full px-1.5 text-[10px] font-bold",
                        on ? "bg-on-fill/25 text-on-fill" : "bg-primary text-on-fill",
                      ].join(" ")}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-text-secondary">
            {EMPTY_LANE_COPY[filter]}
          </p>
        ) : (
          rows.map((row) => {
          if (row.kind === "person") {
            const m = row.member;
            const start = () =>
              m.customerId && startCustomerThread(m.customerId, "");
            return (
              <button
                key={m.id}
                onClick={start}
                className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left transition hover:bg-background-light"
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-background-light text-text-secondary">
                  <User className="h-3.5 w-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-text-primary">
                    {m.name}
                  </span>
                  <span className="truncate text-[11px] text-text-secondary">
                    {m.subtitle}
                  </span>
                </span>
                <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-background-light px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  <MessageSquare className="h-3 w-3" /> Text
                </span>
              </button>
            );
          }
          const t = row.thread;
          const last = t.messages[t.messages.length - 1];
          const active = open?.id === t.id;
          const kind = threadKind(t);
          return (
            <button
              key={t.id}
              onClick={() => openThread(t.id)}
              className={[
                "flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left transition",
                active ? "bg-primary/10" : "hover:bg-background-light",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {kind === "team" && (
                    <Users className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
                  )}
                  {kind === "group" && (
                    <UsersRound className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
                  )}
                  <span className="truncate text-sm font-semibold text-text-primary">
                    {threadTitle(t, customers)}
                  </span>
                </span>
                {t.unread > 0 && (
                  <span className="flex-shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-on-fill">
                    {t.unread}
                  </span>
                )}
              </div>
              <span className="truncate text-[11px] text-text-secondary">{last?.body}</span>
              <span className="truncate text-[10px] uppercase tracking-wide text-text-secondary">
                {threadMeta(t)}
              </span>
            </button>
          );
        })
        )}
        </div>
      </div>

      {/* Conversation */}
      <div className="col-span-8 flex flex-col lg:col-span-6">
        {open ? (
          <>
            <div className="flex items-center justify-between border-b border-border bg-surface-light px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                {threadKind(open) === "team" && (
                  <Users className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                )}
                {threadKind(open) === "group" && (
                  <UsersRound className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {threadTitle(open, customers)}
                  </p>
                  <p className="truncate text-[11px] text-text-secondary">
                    {threadMeta(open)}
                  </p>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
              {/* #2049 (AC3) - the SMS parity for email's reading-pane "Mark as
                  unread" affordance; persists via markOpenThreadUnread. */}
              {!openIsStaffThread && (
                <button
                  type="button"
                  aria-label="Mark as unread"
                  title="Mark as unread"
                  onClick={markOpenThreadUnread}
                  className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-secondary transition hover:bg-background-light hover:text-text-primary"
                >
                  <MailOpen className="h-4 w-4" />
                </button>
              )}
              {/* Unknown-number affordance (slice H7): a title-keyed thread has
                  no CRM record behind it — offer to create one, with the number
                  prefilled ( ?phone= — same seam as the dialer, slice 2.2). */}
              {openUnknownNumber ? (
                <div className="flex flex-shrink-0 items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                    Unknown number
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/customers/new?phone=${encodeURIComponent(openUnknownNumber)}`)
                    }
                    className="inline-flex items-center gap-1 rounded-md bg-success px-2 py-1 text-[11px] font-semibold text-on-fill transition hover:bg-success/90"
                  >
                    <UserPlus className="h-3 w-3" /> Create customer
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/leads/new?phone=${encodeURIComponent(openUnknownNumber)}`)
                    }
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[11px] font-semibold text-text-primary transition hover:bg-background-light"
                  >
                    <Plus className="h-3 w-3" /> Create lead
                  </button>
                </div>
              ) : (
                <MessageSquare className="h-4 w-4 flex-shrink-0 text-text-secondary" />
              )}
              </div>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto bg-background-light px-4 py-3">
              {open.messages.map((m) => (
                <div
                  key={m.id}
                  className={["flex", m.direction === "out" ? "justify-end" : "justify-start"].join(" ")}
                >
                  <div className="max-w-[78%]">
                    <div
                      className={[
                        "rounded-2xl px-3 py-2 text-sm",
                        m.direction === "out"
                          ? `rounded-br-sm ${outboundBubbleClass(deliveryNote(m).tone)}`
                          : "rounded-bl-sm border border-border bg-surface-light text-text-primary",
                      ].join(" ")}
                    >
                      {m.automated && (
                        <span className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide opacity-80">
                          <Sparkles className="h-2.5 w-2.5" /> Auto text-back
                        </span>
                      )}
                      <p>{m.body}</p>
                    </div>
                    {/* Variant A meta row — job pill + assign menu render ONLY
                        on kind === 'customer' threads (vendor threads with a
                        null kind resolve to 'customer'); team AND group
                        internal lanes NEVER show job attribution UI. */}
                    <div
                      className={[
                        "mt-1 flex items-center gap-2",
                        m.direction === "out" ? "justify-end" : "",
                      ].join(" ")}
                    >
                      {threadKind(open) === "customer" && (
                        <JobAssignMenu
                          jobs={openJobs}
                          onPick={(job) => reassignMessage(open.id, m.id, job)}
                        >
                          <button
                            type="button"
                            title={m.jobLabel ? `Tagged to ${m.jobLabel} — click to reassign` : "No job — click to assign"}
                            className="rounded-pill transition hover:opacity-80"
                          >
                            <JobBadge job={m.jobLabel} />
                          </button>
                        </JobAssignMenu>
                      )}
                      {(() => {
                        // A row that was never sent must say so - the whole point
                        // of the honest-status work is that the bubble stops
                        // implying delivery the backend never confirmed.
                        const note = deliveryNote(m);
                        if (!note.label) return null;
                        return (
                          <span
                            title={note.title}
                            className={[
                              "text-[10px] font-semibold",
                              note.tone === "danger" ? "text-danger" : "text-text-secondary",
                            ].join(" ")}
                          >
                            {note.label}
                          </span>
                        );
                      })()}
                      <span className="text-[10px] text-text-secondary">{shortTime(m.ts, tz)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-border bg-surface-light">
              {/* Composer gate — one muted banner naming the SPECIFIC blocker.
                  A staff thread is checked FIRST and wins: it is blocked for a
                  reason of its own that no org setting can clear, so naming an
                  org-level blocker there would send an admin off to fix
                  something that would not have helped. Then §5.4: not connected
                  → connect; connected but A2P pending → approval; connected +
                  approved but no texting number → buy. */}
              {openIsStaffThread ? (
                <p className="border-b border-border bg-background-light px-3 py-1.5 text-[11px] text-text-secondary">
                  Replies to staff threads are not available yet.
                </p>
              ) : (
                smsBlocked && (
                  <p className="border-b border-border bg-background-light px-3 py-1.5 text-[11px] text-text-secondary">
                    {!connected
                      ? "Text messaging activates when your phone system is connected."
                      : !smsReady
                        ? "Texting activates once the A2P campaign is approved — check status in Settings → Phone & SMS."
                        : "No SMS-capable number — buy one in the Numbers tab."}
                  </p>
                )
              )}
              {/* Inline send failure — the mapped 409/transport reason. */}
              {sendError && (
                <p
                  role="status"
                  className="border-b border-danger/20 bg-danger/10 px-3 py-1.5 text-[11px] font-medium text-danger"
                >
                  {sendError}
                </p>
              )}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Type an SMS reply…"
                  disabled={smsBlocked || openIsStaffThread}
                  maxLength={1600}
                  className="flex-1 rounded-md border border-border bg-surface-light px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle disabled:cursor-not-allowed disabled:bg-background-light disabled:text-text-secondary"
                />
                <button
                  onClick={send}
                  disabled={smsBlocked || openIsStaffThread || !draft.trim() || sendSms.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-fill hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-border disabled:text-text-secondary"
                >
                  <Send className="h-4 w-4" /> Send
                </button>
              </div>
              {/* Live segment hint (addendum §A.6): CTM splits at 160 chars, up to 1600. */}
              {draft.length > 160 && (
                <p className="px-3 pb-2 text-[11px] text-text-secondary">
                  {Math.ceil(draft.length / 160)} segments
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
            No conversation selected
          </div>
        )}
      </div>

      {/* Context panel — customer/job context, or a team-thread summary */}
      <aside className="hidden border-l border-border bg-surface-light lg:col-span-3 lg:block">
        {open && threadKind(open) === "team" ? (
          <TeamInfoPanel thread={open} customers={customers} />
        ) : (
          <ContextPanel
            customer={
              // Customer/job context (incl. the Jobs · navigation list and the
              // Unrouted tray) renders ONLY for kind === 'customer' threads —
              // group/internal lanes never expose job UI.
              open && threadKind(open) === "customer"
                ? customerById(customers, open.customerId)
                : undefined
            }
            thread={open && threadKind(open) === "customer" ? open : undefined}
            jobs={customerJobs}
            onReassign={(messageId, job) => open && reassignMessage(open.id, messageId, job)}
          />
        )}
      </aside>

      {composeOpen && (
        <NewMessageDialog
          onClose={closeCompose}
          onSendToCustomer={startCustomerThread}
          onSendToNumber={startNumberThread}
          customers={customers}
          initialNumber={composeSeed?.number}
          initialCustomerId={composeSeed?.customerId}
          errorText={composeError}
          sending={sendSms.isPending}
        />
      )}
    </div>
  );
}

/* New-message composer — start a fresh SMS with a customer. v1 is customer
 * texting only: the Team / "By job" prototype rosters (mock-fed, wired to
 * toast-only sends) are gone until internal messaging is backed. */
type Recipient = {
  id: string;
  name: string;
  subtitle: string;
  number?: string;
  customerId?: string;
  haystack: string;
};

/** Build the customer roster. The monolith closed over a module-scope
 * customers array; in ALPHA it comes from the seam hook, so callers thread
 * it in. */
function buildRecipients(customers: PhoneCustomer[]): Recipient[] {
  return customers.map((c) => {
    const phone = primaryPhone(c);
    const contact = c.contacts[0];
    // Digit-stripped form alongside the display form so a partial number
    // (e.g. "609") substring-matches regardless of punctuation grouping.
    const digits = phone.replace(/\D/g, "");
    // Every phone on file — not just the displayed/primary one — is
    // searchable: a dispatcher may know the customer's cell even when an
    // office line (phones[0]) is what's shown.
    const allDigits = (c.phones ?? []).map((p) => p.replace(/\D/g, ""));
    return {
      id: `cust:${c.id}`,
      name: c.name,
      subtitle: [contact?.name, c.site].filter(Boolean).join(" · "),
      number: phone || undefined,
      customerId: c.id,
      haystack: [c.name, contact?.name, c.site, fmtPhone(phone), phone, digits, ...allDigits]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
}

/** Primary phone for a customer — first phone channel across all contacts,
 *  falling back to `phones[]` (contacts[].channels[] carries no phone data
 *  in practice — nothing writes it; real numbers live on the customer row /
 *  customer_phones[], surfaced server-side as `phones[]`). */
function primaryPhone(c: PhoneCustomer): string {
  return (
    c.contacts.flatMap((ct) => ct.channels).find((ch) => ch.kind === "phone")
      ?.value ?? c.phones?.[0] ?? ""
  );
}

/** A raw-number recipient (no CRM record behind it — slice H7). */
function numberRecipient(e164: string): Recipient {
  return {
    id: `num:${e164}`,
    name: fmtPhone(e164),
    subtitle: "New number",
    number: e164,
    haystack: "",
  };
}

function NewMessageDialog({
  onClose,
  onSendToCustomer,
  onSendToNumber,
  customers,
  initialNumber,
  initialCustomerId,
  errorText,
  sending,
}: {
  onClose: () => void;
  onSendToCustomer: (customerId: string, body: string) => void;
  onSendToNumber: (e164: string, body: string) => void;
  customers: PhoneCustomer[];
  /** Deep-link seed ( ?to= ): a valid NA number jumps straight to the compose
   *  pane; an unnormalizable one prefills the number field for correction. */
  initialNumber?: string;
  /** Deep-link seed ( ?customerId= with no thread ): preselect this customer. */
  initialCustomerId?: string;
  /** Compose-to-number send failure — rendered inline near the actions. */
  errorText?: string | null;
  sending?: boolean;
}) {
  const [query, setQuery] = useState("");
  const initialE164 = initialNumber ? normalizeNAPhone(initialNumber) : null;
  const [numberEntry, setNumberEntry] = useState(initialNumber && !initialE164 ? initialNumber : "");
  const [selected, setSelected] = useState<Recipient | null>(
    initialE164 ? numberRecipient(initialE164) : null,
  );
  const [body, setBody] = useState("");

  const recipients = useMemo(() => buildRecipients(customers), [customers]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) => r.haystack.includes(q));
  }, [recipients, query]);

  // One-shot ?customerId= preselect — waits for the roster to load, and never
  // re-fires after the user hits "Change".
  const seededCustomer = useRef(false);
  useEffect(() => {
    if (!initialCustomerId || seededCustomer.current) return;
    const r = recipients.find((x) => x.customerId === initialCustomerId);
    if (r) {
      seededCustomer.current = true;
      setSelected(r);
    }
  }, [recipients, initialCustomerId]);

  const entryE164 = normalizeNAPhone(numberEntry);
  function pickNumber() {
    if (entryE164) setSelected(numberRecipient(entryE164));
  }

  // A raw number has no conversation to "open" — it needs an actual message.
  const isNumberRecipient = !!selected && !selected.customerId;

  function sendIt() {
    if (!selected || sending) return;
    if (selected.customerId) {
      onSendToCustomer(selected.customerId, body);
    } else if (selected.number && body.trim()) {
      onSendToNumber(selected.number, body);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={selected ? `New message · ${selected.name}` : "New message"}
      size="lg"
      footer={
        selected ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={sendIt} disabled={sending || (isNumberRecipient && !body.trim())}>
              <Send className="h-4 w-4" />
              {body.trim() || isNumberRecipient ? "Send" : "Open conversation"}
            </Button>
          </>
        ) : undefined
      }
    >
      {/* Search + list / compose */}
      <div className="-mx-6 -mt-2 flex h-[26rem] flex-col overflow-hidden">
        {!selected ? (
          <>
            <div className="border-b border-border px-6 pb-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search customers…"
                  autoFocus
                  className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
                />
              </div>
              {/* Free "To" number entry (slice H7) — text any number, no
                  customer record required. Enabled once it normalizes to a
                  valid NA number (mirrors the server's validation). */}
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={numberEntry}
                  onChange={(e) => setNumberEntry(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && pickNumber()}
                  placeholder="Or text a number: (555) 123-4567"
                  aria-label="To phone number"
                  inputMode="tel"
                  className="flex-1 rounded-md border border-border bg-surface-light px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
                />
                <button
                  type="button"
                  onClick={pickNumber}
                  disabled={!entryE164}
                  className="flex-shrink-0 rounded-md border border-border bg-surface-light px-2.5 py-2 text-[12px] font-semibold text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:text-text-secondary disabled:hover:bg-surface-light"
                >
                  Use number
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
              {filtered.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-text-secondary">
                  No matches.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {filtered.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(r)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition hover:bg-primary/10"
                      >
                        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-background-light text-text-secondary">
                          <User className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-text-primary">
                            {r.name}
                          </span>
                          <span className="block truncate text-[11px] text-text-secondary">
                            {r.subtitle}
                          </span>
                        </span>
                        {r.number && (
                          <span className="flex-shrink-0 font-mono text-[11px] text-primary">
                            {fmtPhone(r.number)}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border px-6 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-text-primary">
                  To: {selected.name}
                </span>
                <span className="block truncate text-[11px] text-text-secondary">
                  {/* Number recipients already show the number as the name —
                      keep the secondary line to the "New number" hint. */}
                  {selected.customerId && selected.number
                    ? fmtPhone(selected.number)
                    : selected.subtitle}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex-shrink-0 text-[12px] font-semibold text-primary hover:text-primary/90"
              >
                Change
              </button>
            </div>
            <div className="flex-1 px-6 py-4">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={`Write a message to ${selected.name}…`}
                autoFocus
                className="h-full w-full resize-none rounded-md border border-border p-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
              />
            </div>
            {/* Inline send failure (compose-to-number) — the mapped 409/
                transport reason, same danger-token idiom as the composer. */}
            {errorText && (
              <p
                role="status"
                className="border-t border-danger/20 bg-danger/10 px-6 py-1.5 text-[11px] font-medium text-danger"
              >
                {errorText}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* One-click job (re)assign menu — lists the customer's OPEN jobs as
 * "number · location" plus an explicit "No job" reset. Wraps any trigger
 * (a message's pill, the Unrouted tray's Assign button). */
function JobAssignMenu({
  jobs,
  onPick,
  children,
}: {
  jobs: CustomerJobNav[];
  onPick: (job: { id: string; number: string } | null) => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {jobs.length === 0 ? (
          <DropdownMenuItem disabled tone="muted" className="text-[12px]">
            No open jobs
          </DropdownMenuItem>
        ) : (
          jobs.map((j) => (
            <DropdownMenuItem
              key={j.id}
              onClick={() => onPick({ id: j.id, number: j.number })}
              className="cursor-pointer"
            >
              <span className="truncate text-[12px]">
                <span className="font-semibold text-primary">{j.number}</span>
                {j.location ? <span className="text-text-secondary"> · {j.location}</span> : null}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onPick(null)} className="cursor-pointer">
          <span className="text-[12px] text-text-secondary">No job</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextPanel({
  customer,
  thread,
  jobs,
  onReassign,
}: {
  customer?: PhoneCustomer;
  /** The open CUSTOMER thread — feeds the Unrouted tray (absent for team/group). */
  thread?: MessageThread;
  jobs: CustomerJobNav[];
  onReassign: (messageId: string, job: { id: string; number: string } | null) => void;
}) {
  const navigate = useNavigate();
  if (!customer) {
    return <div className="p-4 text-sm text-text-secondary">Select a conversation.</div>;
  }
  const contact = customer.contacts[0];
  const openJobs = jobs.filter((j) => j.open);
  // The per-customer Unrouted tray — inbound messages with no job attribution.
  // Leaving them here IS a valid resolution ("no job"); assigning is one click.
  const unrouted = (thread?.messages ?? []).filter((m) => m.direction === "in" && !m.jobId);
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
          <User className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{customer.name}</p>
          <p className="text-[11px] capitalize text-text-secondary">{customer.type}</p>
        </div>
      </div>
      <InfoRow label="Site" value={customer.site} />
      {contact && <InfoRow label="Contact" value={`${contact.name}${contact.role ? ` · ${contact.role}` : ""}`} />}
      {contact?.channels.map((ch) => (
        <InfoRow key={ch.id} label={ch.kind === "sms" ? "SMS" : ch.kind} value={fmtPhone(ch.value)} />
      ))}
      {customer.membershipTier && (
        <div className="rounded-md bg-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-warning">
          {customer.membershipTier}
          {customer.slaProfile ? ` · ${customer.slaProfile}` : ""}
        </div>
      )}
      {jobs.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Jobs · navigation
          </p>
          <div className="space-y-1.5">
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => navigate(`/jobs/${j.id}`)}
                title={`Open ${j.number}`}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-[11px] transition hover:border-primary hover:bg-primary/10"
              >
                <span className="truncate">
                  <span className="font-semibold text-primary">{j.number}</span>
                  {j.location ? <span className="text-text-secondary"> · {j.location}</span> : null}
                </span>
                <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 -rotate-90 text-text-secondary" />
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-text-secondary">
            Job list is navigation only — number + service location.
          </p>
        </div>
      )}
      {unrouted.length > 0 && (
        <div className="rounded-card border border-dashed border-warning/60 bg-warning/5 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <InboxIcon className="h-4 w-4 text-warning" />
            <span className="text-[11px] font-semibold text-text-primary">Unrouted</span>
            <span className="ml-auto rounded-pill bg-warning/15 px-1.5 text-[11px] font-semibold text-warning">
              {unrouted.length}
            </span>
          </div>
          <div className="mt-1.5 space-y-1.5">
            {unrouted.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">{m.body}</p>
                <JobAssignMenu jobs={openJobs} onPick={(job) => onReassign(m.id, job)}>
                  <button
                    type="button"
                    className="flex-shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-semibold text-primary transition hover:bg-primary/10"
                  >
                    Assign
                  </button>
                </JobAssignMenu>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[10px] text-text-secondary">
            Inbound texts with no job. Assign one — or leave as no job.
          </p>
        </div>
      )}
    </div>
  );
}

/* Right-hand summary for an internal Team thread — there's no Customer record,
 * so we show who the thread is with plus quick internal actions (§14.17). */
function TeamInfoPanel({
  thread,
  customers,
}: {
  thread: MessageThread;
  customers: PhoneCustomer[];
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-background-light text-text-secondary">
          <Users className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">
            {threadTitle(thread, customers)}
          </p>
          <p className="text-[11px] text-text-secondary">Internal team thread</p>
        </div>
      </div>
      {thread.subtitle && <InfoRow label="Role" value={thread.subtitle} />}
      <InfoRow label="Channel" value="Internal · SMS" />
      <div className="rounded-md bg-background-light px-2.5 py-2 text-[11px] text-text-secondary">
        Team conversations stay inside ServWave and aren't billed as customer SMS.
      </div>
    </div>
  );
}
