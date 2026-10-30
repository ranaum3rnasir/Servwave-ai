// Phone module — SMS unified inbox (3-pane messenger).
//
// Ported from the original PhonePage monolith (regions L3541-4309 + L4321-4345).
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
import { PhoneInput } from "@/ui-kit/components/form/phoneInput";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  Inbox as InboxIcon,
  MailOpen,
  MessageSquare,
  Plus,
  Search,
  Send,
  Sparkles,
  User,
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
import { CustomerEmailText, CustomerNameText, CustomerPhoneText } from "@/components/contact/ContactText";
import { CUSTOMER_PHONE_OWNER } from "@/components/contact/contactHrefs";
import { phoneDisplay } from "@/components/contact/contactDisplayPolicy";
import { useContactPolicyInput } from "@/components/contact/useContactPolicyInput";
import { Modal } from "@/components/ui/modal";
import { useDirtyGuard } from "@/ui-kit/hooks/useDirtyGuard";
import { DiscardConfirm } from "@/ui-kit/components/ui/discardConfirm";
import { Button } from "@/components/ui/button";
import { useAppAbility } from "@/contexts/AbilityContext";
import {
  useCtmStatus,
  useCustomerJobs,
  useMarkThreadRead,
  useMarkThreadUnread,
  useMessageThread,
  useMessageThreads,
  usePhoneCustomers,
  useReassignSmsJob,
  useSendSms,
  type ConversationLinkResult,
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
import { useRoutedPane } from '@/lib/communication/useRoutedPane';
import { useUnknownNumberCreate } from '@/components/communication/phone/useUnknownNumberCreate';
import { fieldKindProps } from '@/ui-kit/lib/fieldKind';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';

/** Below md a list that can run to hundreds of rows is drawn a page at a time (mobile slice 69,
 *  PERF-04): the directory rows and a thread's bubbles are the bulk of the page's DOM. */
const ROW_WINDOW = 40;
const MESSAGE_WINDOW = 60;

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
  return customerById(customers, t.customerId)?.name ?? t.linkedCustomer?.name ?? "Unknown";
}

/**
 * A conversation's title as drawn on screen. An unknown number is a customer's phone and follows the contact
 * display policy (Copy customer phone); the name of a matched customer links to their page in the thread header
 * (`linkCustomer`) for a person who may open it. Team and group titles are names, not customer data.
 */
function ThreadTitle({
  thread,
  customers,
  linkCustomer = false,
}: {
  thread: MessageThread;
  customers: PhoneCustomer[];
  linkCustomer?: boolean;
}) {
  if (thread.title) {
    const e164 = threadKind(thread) === "customer" ? normalizeNAPhone(thread.title) : null;
    return e164 ? <CustomerPhoneText phone={e164}>{fmtPhone(e164)}</CustomerPhoneText> : <>{threadTitle(thread, customers)}</>;
  }
  // The directory is closed to a person without View customers; the thread's own customer name stands in for it, and
  // CustomerNameText draws it as plain text when they cannot open the page.
  const customer = customerById(customers, thread.customerId) ?? thread.linkedCustomer;
  if (!customer || !linkCustomer) return <>{threadTitle(thread, customers)}</>;
  return <CustomerNameText customerId={customer.id} name={customer.name} />;
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

/** The header of an open thread with no CRM record behind it: the label, and Create lead / Create job when the person may. */
function UnknownNumberActions({ e164 }: { e164: string }) {
  const navigate = useNavigate();
  const { leadHref, jobHref } = useUnknownNumberCreate(e164);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        Unknown number
      </span>
      {leadHref && (
        <button
          type="button"
          onClick={() => navigate(leadHref)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[11px] font-semibold text-text-primary transition hover:bg-background-light"
        >
          <Plus className="h-3 w-3" /> Create lead
        </button>
      )}
      {jobHref && (
        <button
          type="button"
          onClick={() => navigate(jobHref)}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[11px] font-semibold text-text-primary transition hover:bg-background-light"
        >
          <Plus className="h-3 w-3" /> Create job
        </button>
      )}
    </div>
  );
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

/** What opens the composer from a link (see the deep links in `SmsInboxView`). */
type ComposeSeed = {
  number?: string;
  customerId?: string;
  /** The number is a customer's phone: it is drawn under the copy rule, with this name when the link carried one. */
  customerPhone?: boolean;
  name?: string;
  /** The record the number was tapped from, so the sent text is filed on it. */
  jobId?: string;
  leadId?: string;
};

/** What a `?to=` link adds to the number: for a customer's phone who it is and where it was tapped (`textPath`). */
function composeSeedExtras(params: URLSearchParams): ComposeSeed {
  const extras: ComposeSeed = {};
  const jobId = params.get("jobId");
  const leadId = params.get("leadId");
  if (jobId) extras.jobId = jobId;
  if (leadId) extras.leadId = leadId;
  if (params.get("owner") === CUSTOMER_PHONE_OWNER) {
    extras.customerPhone = true;
    const name = params.get("name");
    if (name) extras.name = name;
  }
  return extras;
}

export function SmsInboxView({
  threads,
  setThreads,
  onToast,
}: {
  threads: MessageThread[];
  setThreads: React.Dispatch<React.SetStateAction<MessageThread[]>>;
  onToast: (m: string) => void;
}) {
  // Data seam — module-scope arrays in the original monolith now come from hooks.
  const { data: customers = [] } = usePhoneCustomers();
  const tz = useScheduleTimezone();
  // The server thread directory, consulted directly by the deep-link effect:
  // the `threads` prop lags one commit behind (TextPage's seed-merge effect),
  // and isFetched distinguishes "no thread yet" from "still loading".
  const threadsQuery = useMessageThreads();
  const threadDir = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);
  const sendSms = useSendSms();
  const reassignSms = useReassignSmsJob();
  // Attach conversations to jobs and leads decides who can tag a text to a job here; Edit communication records plays
  // no part in it. Without it the inbox still shows where each text is filed.
  const mayAttach = useAppAbility().can("attach", "Communication");
  // A number is a customer phone: a toast names it only for a person the Copy customer phone rule lets select it.
  const contactPolicy = useContactPolicyInput();
  // #2049 - the persisting half of every local `unread: 0` write below (send
  // paths + openThread). Fire-and-forget: the local zero is already applied
  // optimistically by the same call sites, so a slow/failed PATCH costs a
  // stale badge on the NEXT poll at worst, never a blocked UI.
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const navigate = useNavigate();

  // Composer gate (§5.4): texting is live only when the org's phone service is
  // connected AND the A2P campaign is approved (sms_ready). Whether a number
  // can text is NOT read here: GET /communication/numbers is the person's own
  // scoped list (it can be empty for someone who still sends from the company
  // line), so the server's send route decides and answers NO_SMS_NUMBER.
  const { connected, smsReady } = useCtmStatus();
  const smsBlocked = !connected || !smsReady;

  // Inline send failure — rendered near the composer (danger tokens), never a
  // false success toast. Cleared on the next attempt / thread switch.
  const [sendError, setSendError] = useState<string | null>(null);

  const [filter, setFilter] = useState<ThreadFilter>("conversations");
  const visible = useMemo(
    () => threads.filter((t) => matchesFilter(t, filter)),
    [threads, filter],
  );
  const [openId, setOpenId] = useState<string>(threads[0]?.id ?? "");
  // Below md one pane shows at a time and the open conversation is in the URL (mobile slice 69):
  // `pane.paneId` is the thread the URL names, null while the list shows. From md up both panes are
  // on screen and `openId` alone decides, as it always did.
  const pane = useRoutedPane("threadId");
  // A thread started locally (no server id yet) is replaced by the server's row on the next poll;
  // the URL keeps the local id, so remember whose it was and follow it to the real thread.
  const [placeholderOwners, setPlaceholderOwners] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  // Composer prefill from deep links: ?to= seeds a raw number, ?customerId=
  // (with no existing thread) preselects that customer in the dialog.
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null);
  // Compose-to-number send failure — rendered INSIDE the dialog (there is no
  // conversation to fall back to until the server resolves the thread).
  const [composeError, setComposeError] = useState<string | null>(null);
  // The merged `threads` prop lags one commit behind the server directory, so a thread the URL names
  // is looked up in both before it is called unknown.
  const findListed = (id: string): MessageThread | undefined => {
    const owner = placeholderOwners[id];
    return (
      threads.find((t) => t.id === id) ??
      threadDir.find((t) => t.id === id) ??
      (owner ? threads.find((t) => t.customerId === owner) : undefined)
    );
  };
  // The list follows the person's scope, but a conversation can also be reached through a record (the job it
  // is about), and the notification bell links straight to it. A link to a thread the list does not hold is
  // therefore read by id: the single read decides whether the person may open it, and the list never has to.
  const [searchParams] = useSearchParams();
  const linkedThreadId = searchParams.get("threadId");
  const unlisted = Boolean(linkedThreadId) && threadsQuery.isFetched && !findListed(linkedThreadId!);
  const linkedRead = useMessageThread(unlisted ? linkedThreadId! : undefined);
  const findThread = (id: string): MessageThread | undefined =>
    findListed(id) ?? (linkedRead.data?.id === id ? linkedRead.data : undefined);
  // The person may not read the conversation the link names: say so, and show no other one in its place.
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const linkedThread = linkedRead.data;
  const linkRefused = unlisted && linkedRead.isError;
  const awaitingRead = unlisted && linkedRead.isPending;
  useEffect(() => {
    // A conversation read by id joins the local threads, so replying to it and marking it read behave as they do
    // for any listed one; the next list poll does not remove it (local-only threads stay).
    if (linkedThread) setThreads((prev) => (prev.some((t) => t.id === linkedThread.id) ? prev : [linkedThread, ...prev]));
  }, [linkedThread, setThreads]);
  const refusalHandled = useRef(false);
  useEffect(() => {
    // Once per refusal: the page hands this view a fresh onToast on every render, and a person who then picks a
    // conversation from the list must not be sent back to the notice.
    if (!linkRefused || refusalHandled.current) return;
    refusalHandled.current = true;
    setLinkUnavailable(true);
    setOpenId("");
    // A phone drops back to the list (below), where nothing else says why; from md up the thread pane says it.
    if (pane.isPhone) onToast("This conversation is not available.");
  }, [linkRefused, pane.isPhone, onToast]);
  const paneThread = pane.paneId ? findThread(pane.paneId) : undefined;
  const showThreadPane = pane.isPhone && Boolean(pane.paneId);
  const open = showThreadPane
    ? paneThread
    : linkUnavailable && !openId
      ? undefined
      : (threads.find((t) => t.id === openId) ?? visible[0]);
  // The newest messages are the ones in view; older ones are a tap away on a phone.
  const [earlierShown, setEarlierShown] = useState<Record<string, number>>({});
  const openMessages = open?.messages ?? [];
  const messageWindow = MESSAGE_WINDOW + (open ? (earlierShown[open.id] ?? 0) : 0);
  const hiddenEarlier = pane.isPhone ? Math.max(0, openMessages.length - messageWindow) : 0;
  const shownMessages = hiddenEarlier > 0 ? openMessages.slice(-messageWindow) : openMessages;
  // A thread opens on its newest message, and a new one brings the view back to the bottom.
  const messagesRef = useRef<HTMLDivElement>(null);
  const openId_ = open?.id;
  const openCount = openMessages.length;
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [openId_, openCount, showThreadPane]);
  const [rowsShown, setRowsShown] = useState(ROW_WINDOW);
  // The open thread's counterpart number when it is an unknown-number thread
  // (title-keyed, no customer/vendor) — drives the header affordance and the
  // reply payload (no customerId to send by).
  const openUnknownNumber = open ? unknownThreadNumber(open) : null;
  // The staff counterparty of an open team thread, when it has one. A staff
  // thread IS a conversation: their mobile lives on `users.phone`, the server
  // resolves it off `user_id` (resolveSmsDestination's user branch) and
  // delivers on it (isDeliverableThread), and their inbound replies already
  // land on this exact thread - the CTM webhook keys a staff number onto it.
  //
  // This REVERSES Spec C's ruling that a team thread is "an OUTBOUND RECORD,
  // not a conversation". That call was correct while the server had no way to
  // address a person: a reply would have been recorded and never sent, settling
  // at `queued` for ever and rendering as a "Sending" bubble the admin reads as
  // delivered - the false-success shape the honest-status work removed. Both
  // halves of the destination are now built, so the reason is gone and the
  // block goes with it. It left the admin staring at a reply they could not
  // answer.
  const openStaffUserId =
    open && threadKind(open) === "team" ? (open.userId ?? null) : null;

  // ...and what still resolves to NOBODY, which keeps the block for exactly the
  // reason above: a `group` thread (a crew broadcast has no single
  // counterparty) and a team thread carrying no `userId`. A send on either
  // would still be recorded and never delivered, so say so rather than offer
  // the box. Deliberately NOT widened to enable group threads.
  const openHasNoRecipient = open
    ? threadKind(open) !== "customer" && !openStaffUserId
    : false;

  // Deep links — resolved once. ?threadId=… opens the exact thread
  // (notification bell); ?customerId=… opens that customer's thread (job page
  // link, dialer Text action) or, when no thread exists yet, the composer with
  // the customer preselected; ?to=… opens the composer prefilled with a raw
  // number (dialer Text on a number-only entry). Thread lookups consult the
  // server directory (threadDir) as well as the merged `threads` prop, which
  // lags one commit behind the seed.
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
      // ...then whose number it is and where it was tapped, when the link says.
      setComposeSeed((seed) => ({ ...seed, ...composeSeedExtras(searchParams) }));
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
      // On a phone the deep link lands on the conversation: put it in the URL (replacing the
      // link's own entry, so Back leaves for where the link came from rather than the list).
      if (pane.paneId !== target.id) pane.open(target.id, { replace: true });
      return;
    }
    // Directory fully loaded and still no thread for this customer → start
    // one: open the composer with the customer preselected.
    if (customerId && threadsQuery.isFetched) {
      deepLinked.current = true;
      setComposeSeed({ customerId });
      setComposeOpen(true);
    }
  }, [threads, threadDir, threadsQuery.isFetched, searchParams, pane]);

  // A phone whose URL names a conversation that does not exist (a stale link, a thread that was
  // archived away) shows the list instead of an empty pane, and drops the dead id from the URL.
  const { isPhone: onPhone, paneId: routedId, back: backToList } = pane;
  const directoryReady = threadsQuery.isFetched;
  useEffect(() => {
    if (onPhone && routedId && !paneThread && directoryReady && !awaitingRead) backToList({ replace: true });
  }, [onPhone, routedId, paneThread, directoryReady, awaitingRead, backToList]);

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
        onSuccess: (result?: ConversationLinkResult) => {
          // Removing a job tag can take the text out of the person's reach (they could read it only through that
          // job). The server says so in a success: the text leaves the conversation, and the conversation leaves the
          // list when it was the last text they could read in it.
          if (result?.left) {
            setThreads((prev) =>
              prev
                .map((t) => (t.id === threadId ? { ...t, messages: t.messages.filter((m) => m.id !== messageId) } : t))
                .filter((t) => t.id !== threadId || t.messages.length > 0),
            );
            onToast("Job tag removed. This text is no longer in your list.");
            return;
          }
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
          onToast("Couldn't update the job tag - try again");
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
  // A phone draws the first page of the directory and offers the rest (the open thread is always a
  // row of its own, so it never depends on the window).
  const listRows = pane.isPhone ? rows.slice(0, rowsShown) : rows;
  const hiddenRows = rows.length - listRows.length;

  // Switch directory buckets — and reselect the first thread in the bucket so
  // the conversation pane never shows a thread that's filtered out of view.
  function pickFilter(f: ThreadFilter) {
    setFilter(f);
    setRowsShown(ROW_WINDOW);
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
        pane.open(existing.id);
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
        setPlaceholderOwners((prev) => ({ ...prev, [id]: customerId }));
        pane.open(id);
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
    // The job or lead the number was tapped from files the text on that record, but only for the number the person
    // was sent here with: a different number picked after "Change" has no record behind it.
    const seeded = composeSeed?.number ? normalizeNAPhone(composeSeed.number) === e164 : false;
    sendSms.mutate(
      {
        toNumber: e164,
        body: text,
        ...(seeded && composeSeed?.jobId && { jobId: composeSeed.jobId }),
        ...(seeded && composeSeed?.leadId && { leadId: composeSeed.leadId }),
      },
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
          pane.open(id);
          // #2049 - the server always resolves/creates a real thread for this
          // path and returns its id (`threadFromNumber`); the local `thr_...`
          // fallback only covers a response shape that never actually occurs.
          if (data?.threadId) markThreadRead.mutate(data.threadId);
          closeCompose();
          if (data?.delivery !== "failed") {
            const mayShowNumber = phoneDisplay("customer_phone", e164, null, contactPolicy).selectable;
            onToast(mayShowNumber ? `✉️ Message sent to ${fmtPhone(e164)}` : "✉️ Message sent");
          }
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
    if (smsBlocked || openHasNoRecipient || !draft.trim() || !open || sendSms.isPending) return;
    const body = draft.trim();
    setSendError(null);
    sendSms.mutate(
      // Unknown-number AND staff threads carry no customerId - reply by
      // threadId (their id is always the server's; they only enter local state
      // server-first). A staff thread's customerId is the legacy `""` sentinel,
      // which would fail the send schema outright.
      openUnknownNumber || openStaffUserId
        ? { threadId: open.id, body }
        : { customerId: open.customerId, body },
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
    pane.open(id);
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
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-[minmax(0,1fr)]">
      {/* Thread list + directory filter */}
      <div
        data-pane="list"
        className={`col-span-12 min-h-0 flex-col overflow-hidden border-r border-border bg-surface-light md:col-span-4 lg:col-span-3 ${showThreadPane ? "hidden" : "flex"}`}
      >
        <div className="flex flex-col gap-2 border-b border-border px-2 py-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <InboxIcon className="h-3.5 w-3.5" /> Inbox
            </span>
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] font-semibold text-on-fill transition hover:bg-primary/90 mobile:min-h-11"
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
                    "inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold transition mobile:min-h-11",
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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-text-secondary">
            {EMPTY_LANE_COPY[filter]}
          </p>
        ) : (
          listRows.map((row) => {
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
                <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-background-light px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                    <ThreadTitle thread={t} customers={customers} />
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
        {hiddenRows > 0 && (
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            onClick={() => setRowsShown((n) => n + ROW_WINDOW)}
            className="h-auto min-h-11 w-full rounded-none border-b border-border px-3 py-3 text-[13px]"
          >
            Show {Math.min(hiddenRows, ROW_WINDOW)} more ({hiddenRows} not shown)
          </Button>
        )}
        </div>
      </div>

      {/* Conversation */}
      <div
        data-pane="thread"
        className={`col-span-12 min-h-0 flex-col md:col-span-8 lg:col-span-6 ${pane.isPhone && !showThreadPane ? "hidden" : "flex"}`}
      >
        {open ? (
          <>
            <div className="flex flex-none items-center justify-between gap-2 border-b border-border bg-surface-light px-4 py-2.5 max-md:px-2">
              <div className="flex min-w-0 items-center gap-2">
                {/* Below md the list and the thread take turns (mobile slice 69): this goes back to
                    the list the way the browser's Back does. */}
                <Button
                  type="button"
                  variant="ghost"
                  tone="neutral"
                  size="icon"
                  onClick={() => pane.back()}
                  aria-label="Back to conversations"
                  className="-ml-1 h-11 w-11 flex-shrink-0 md:hidden"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                {threadKind(open) === "team" && (
                  <Users className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                )}
                {threadKind(open) === "group" && (
                  <UsersRound className="h-4 w-4 flex-shrink-0 text-text-secondary" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    <ThreadTitle thread={open} customers={customers} linkCustomer />
                  </p>
                  <p className="truncate text-[11px] text-text-secondary">
                    {threadMeta(open)}
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-shrink flex-wrap items-center justify-end gap-2">
              {/* #2049 (AC3) - the SMS parity for email's reading-pane "Mark as
                  unread" affordance; persists via markOpenThreadUnread. Gated
                  on `openHasNoRecipient`, the staging-only "team threads are
                  real conversations" split (e333c5609) of what was a single
                  `openIsStaffThread` block on main - a thread with no one to
                  reply to (group, or team without a resolved staff user)
                  keeps no read-state affordance either, same as the composer. */}
              {!openHasNoRecipient && (
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
                  no CRM record behind it - offer to make a lead or a job of
                  it, with the number prefilled ( ?phone= - same seam as the
                  dialer, slice 2.2). Which of the two shows follows the
                  person's Create + Show pair (S02.27); with neither, the
                  number is all there is. */}
              {openUnknownNumber ? (
                <UnknownNumberActions e164={openUnknownNumber} />
              ) : (
                <MessageSquare className="h-4 w-4 flex-shrink-0 text-text-secondary" />
              )}
              </div>
            </div>
            <div
              ref={messagesRef}
              data-slot="sms-messages"
              className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain bg-background-light px-4 py-3"
            >
              {hiddenEarlier > 0 && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    tone="neutral"
                    size="sm"
                    onClick={() =>
                      setEarlierShown((prev) => ({ ...prev, [open.id]: (prev[open.id] ?? 0) + MESSAGE_WINDOW }))
                    }
                    className="text-[12px]"
                  >
                    Show {Math.min(hiddenEarlier, MESSAGE_WINDOW)} earlier messages
                  </Button>
                </div>
              )}
              {shownMessages.map((m) => (
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
                        <span className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide">
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
                      {threadKind(open) === "customer" &&
                        (mayAttach ? (
                          <JobAssignMenu
                            jobs={openJobs}
                            onPick={(job) => reassignMessage(open.id, m.id, job)}
                          >
                            <button
                              type="button"
                              title={m.jobLabel ? `Tagged to ${m.jobLabel} - click to reassign` : "No job - click to assign"}
                              className="rounded-pill transition hover:opacity-80"
                            >
                              <JobBadge job={m.jobLabel} />
                            </button>
                          </JobAssignMenu>
                        ) : (
                          <JobBadge job={m.jobLabel} />
                        ))}
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
            <div data-slot="sms-composer" className="flex-none border-t border-border bg-surface-light">
              {/* Composer gate — one muted banner naming the SPECIFIC blocker.
                  A thread with no one to address is checked FIRST and wins: it
                  is blocked for a reason of its own that no org setting can
                  clear, so naming an org-level blocker there would send an
                  admin off to fix something that would not have helped. Then
                  §5.4: not connected → connect; connected but A2P pending →
                  approval. A missing texting number surfaces from the send. */}
              {openHasNoRecipient ? (
                <p className="border-b border-border bg-background-light px-3 py-1.5 text-[11px] text-text-secondary">
                  This internal thread has no one to reply to.
                </p>
              ) : (
                smsBlocked && (
                  <p className="border-b border-border bg-background-light px-3 py-1.5 text-[11px] text-text-secondary">
                    {!connected
                      ? "Text messaging activates when your phone system is connected."
                      : "Texting activates once carrier approval comes through - check status in Settings → Phone & SMS."}
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
                  disabled={smsBlocked || openHasNoRecipient}
                  maxLength={1600}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface-light px-3 py-2 text-sm mobile:!text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle disabled:cursor-not-allowed disabled:bg-background-light disabled:text-text-secondary"
                />
                <button
                  onClick={send}
                  disabled={smsBlocked || openHasNoRecipient || !draft.trim() || sendSms.isPending}
                  className="inline-flex flex-none items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-fill hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-border disabled:text-text-secondary mobile:min-h-11"
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
            {linkUnavailable
              ? "This conversation is not available."
              : showThreadPane && (threadsQuery.isLoading || awaitingRead)
                ? "Loading conversation…"
                : "No conversation selected"}
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
            canAttach={mayAttach}
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
          initialCustomerPhone={composeSeed?.customerPhone ? { name: composeSeed.name } : undefined}
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
  /** A customer's phone the person was sent here with: no customer record behind it, but the number is the customer's. */
  customerPhone?: boolean;
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
function numberRecipient(e164: string, ofCustomer?: { name?: string }): Recipient {
  if (ofCustomer) {
    return {
      id: `num:${e164}`,
      name: ofCustomer.name ?? "Customer",
      subtitle: "",
      number: e164,
      customerPhone: true,
      haystack: "",
    };
  }
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
  initialCustomerPhone,
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
  /** The seeded number is a customer's phone (its name, when the link carried one). */
  initialCustomerPhone?: { name?: string };
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
    initialE164 ? numberRecipient(initialE164, initialCustomerPhone) : null,
  );
  const [body, setBody] = useState("");

  // A typed message is not thrown away without asking (mobile slice 43). A number or a search is
  // trivially re-entered and does not count. Sending closes through the parent, so only a
  // dismissal reaches the guard.
  const guard = useDirtyGuard({ dirty: body.trim() !== "", onClose });

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
    <>
    <Modal
      intent="form"
      open
      onClose={() => guard.requestDismiss("close")}
      title={selected ? `New message · ${selected.name}` : "New message"}
      size="lg"
      footer={
        selected ? (
          <>
            <Button variant="outline" onClick={() => guard.requestDismiss("close")}>
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
                  {...fieldKindProps('search')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search customers…"
                  autoFocus={canAutoFocus()}
                  className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm mobile:!text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
                />
              </div>
              {/* Free "To" number entry (slice H7) — text any number, no
                  customer record required. Enabled once it normalizes to a
                  valid NA number (mirrors the server's validation). */}
              <div className="mt-2 flex items-center gap-2">
                <PhoneInput
                  appearance="bare"
                  format="as-typed"
                  personalAutofill={false}
                  value={numberEntry}
                  onValueChange={setNumberEntry}
                  onKeyDown={(e) => e.key === "Enter" && pickNumber()}
                  placeholder="Or text a number: (555) 123-4567"
                  aria-label="To phone number"
                  className="flex-1 rounded-md border border-border bg-surface-light px-3 py-2 text-sm mobile:!text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2">
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
                            {r.customerId ? (
                              <CustomerPhoneText phone={r.number}>{fmtPhone(r.number)}</CustomerPhoneText>
                            ) : (
                              fmtPhone(r.number)
                            )}
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
                  {(selected.customerId || selected.customerPhone) && selected.number ? (
                    <CustomerPhoneText phone={selected.number}>{fmtPhone(selected.number)}</CustomerPhoneText>
                  ) : (
                    selected.subtitle
                  )}
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
                autoFocus={canAutoFocus()}
                className="h-full w-full resize-none rounded-md border border-border p-3 text-sm mobile:!text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
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
    <DiscardConfirm {...guard.confirmProps} />
    </>
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
  canAttach,
  onReassign,
}: {
  customer?: PhoneCustomer;
  /** The open CUSTOMER thread — feeds the Unrouted tray (absent for team/group). */
  thread?: MessageThread;
  jobs: CustomerJobNav[];
  /** Holds Attach conversations to jobs and leads: the Unrouted tray exists only to assign, so it shows to them alone. */
  canAttach: boolean;
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
        <InfoRow
          key={ch.id}
          label={ch.kind === "sms" ? "SMS" : ch.kind}
          value={
            ch.kind === "email" ? (
              <CustomerEmailText email={ch.value} />
            ) : (
              <CustomerPhoneText phone={ch.value}>{fmtPhone(ch.value)}</CustomerPhoneText>
            )
          }
        />
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
            Job list is navigation only - number + service location.
          </p>
        </div>
      )}
      {canAttach && unrouted.length > 0 && (
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
            Inbound texts with no job. Assign one - or leave as no job.
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
