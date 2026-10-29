// Email inbox seed data for the Communication hub's Inbox page. Lifted out of
// the prototype's InboxPage component into a self-contained mock module so the
// data seam owns it. There is exactly one sending identity today - the
// transactional system sender - and no per-org mailbox to resolve at runtime,
// so every compose surface shows an explicit unconnected state.

export type AccountId = "system";

export type Account = {
  id: AccountId;
  provider: "System";
  address: string;
  dot: string; // tailwind bg color for the account dot
};

export const ACCOUNTS: Account[] = [
  // Transactional sender - estimate/invoice/scheduling emails the app sends
  // itself. Rows with account === "system" are the "auto · transactional"
  // case in the Communication <-> Jobs contract (CommItem.transactional).
  { id: "system", provider: "System", address: "no-reply@servwave.app", dot: "bg-neutral-strong" },
];

/** The single identity the inbox composes/sends from. Lifted from the
 *  prototype's InboxPage so the data seam owns it (was a module-local const). */
export const PRIMARY_ACCOUNT: Account = ACCOUNTS[0]!;

/** Copy for an org with no connected mailbox. Single source so the inbox header
 *  chip and every compose surface can never drift apart. */
export const NO_MAILBOX_LABEL = "No mailbox connected";

// Team directory — every user on the account and their work email, so the owner
// can email a teammate (individually or as a group) without leaving the inbox.
// In production these come from the CRM's user/RBAC table; static seed here.
// Shared shapes (TeamMember / EmailGroup / ForwardRule) are declared structurally
// so the directory and inbox views share one definition without a circular import.
export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  online?: boolean;
};


// Email groups (distribution lists). Owner can email a whole team at once and
// manage membership. Editable in the prototype (resets on reload).
export type EmailGroup = {
  id: string;
  name: string;
  memberIds: string[];
};


// Forwarding rules — route incoming mail to a teammate or a group so nothing is
// missed while running the business.
export type ForwardRule = {
  id: string;
  /** What's being forwarded (an inbox/address/label). */
  from: string;
  /** Forward target — a group or an individual. */
  toGroupId?: string;
  toMemberId?: string;
  enabled: boolean;
};


export type Folder = "inbox" | "starred" | "sent" | "drafts" | "archive";

/** Unassigned / Mine / All (email slice 8b) - Missive's rule: "assigned to
 *  one person, visible to all". This is an ADDITIONAL filter on top of the
 *  inbox's normal anchor-inherited visibility, never a narrower visibility
 *  gate - `?assignment=` on GET /emails (comm-whatsapp-email.controller.ts's
 *  `assignmentFilter`). `'all'` sends no filter at all (the pre-8b default). */
export type EmailAssignmentView = "unassigned" | "mine" | "all";

/** PATCH .../emails/threads/:id/assign's 200 response shape (mapEmailThread).
 *  `assignedToUserId` already reflects auto-unassign (a deactivated assignee
 *  reads back null) - the frontend never re-derives that itself. */
export type EmailThread = {
  id: string;
  assignedToUserId: string | null;
  archived: boolean;
  snoozedUntil: string | null;
};

/** A file attached to an email / draft. Real uploads landed in email slice 7:
 *  `file` carries the actual browser File through to send time (multipart
 *  POST /emails, field `files`) for anything added in THIS compose session -
 *  the file picker, a drop, or "Attach from this record" pulling in an
 *  existing upload. Absent on an attachment read back off an already-sent
 *  Email row (`sizeBytes`/`mimeType` only) - those came from the server's own
 *  EmailAttachment rows, there is nothing left on the client to re-upload. */
export type Attachment = {
  name: string;
  size: string;
  sizeBytes?: number;
  mimeType?: string;
  /** The real File behind this chip - present only for an attachment added
   *  during the current compose session. See the type doc above. */
  file?: File;
};

/** Attach-by-origin context (Communication ↔ Jobs/Customers/Estimates/
 *  Invoices): when a compose surface is opened FROM one of these entity
 *  pages, its id rides along on the draft so (a) POST /emails stamps the
 *  same job_id/customer_id attribution the SMS/WhatsApp senders already
 *  stamp, and (b) the composer can offer "Attach from this record" for that
 *  entity's existing uploads (GET .../emails/attach-source). At most one is
 *  ever meaningful for a given draft; all four ride as optional so
 *  ComposeState/ReplyDraft stay one shape rather than a per-entity variant.
 *  estimateId/invoiceId are read-side only today (attach-source lookup) -
 *  POST /emails has no column to stamp either onto, and no compose entry
 *  point sets them yet (no "email from this estimate/invoice" flow exists
 *  in this app); they are carried now so that entry point has somewhere to
 *  put its id the moment it exists. */
export type ComposeOrigin = {
  jobId?: string;
  customerId?: string;
  estimateId?: string;
  invoiceId?: string;
};

// In-progress message in the Gmail-style compose window (new mail only).
// Lifted from the prototype's InboxPage so the data seam owns the shape.
export type ComposeState = ComposeOrigin & {
  mode: "new" | "reply" | "forward";
  account: AccountId;
  to: string;
  /** Gmail-style Cc/Bcc - collapsed behind a "Cc/Bcc" toggle in the composer
   *  chrome until the sender opens it. Absent/empty means "not shown" as
   *  well as "nothing to send". */
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Files attached in the composer. */
  attachments?: Attachment[];
  /** When replying/forwarding, the conversation the sent message joins. */
  threadId?: string;
  /** The stored row a popped-out reply answers. Still SET by the inbox, but not
   *  read by anything today: there is no send path to thread against, so it
   *  never reaches the API. Kept because it is meaningful again the moment the
   *  Resend slice restores threading (In-Reply-To/References); the endpoint
   *  likewise still accepts reply_to_email_id and ignores it. */
  replyToEmailId?: string;
  /** Traffic Cop (email slice 8b, Help Scout's pattern): stamped the instant
   *  the reply/forward editor opens (startReply/startForward/popOutReply),
   *  never re-stamped afterward. Sent to POST /emails as `composing_since` on
   *  a reply (threadId present) so the server can detect the thread picking
   *  up a newer message while this draft was being written. Meaningless (and
   *  never sent) on a brand-new compose with no thread to race against. */
  composingSince?: string;
};

// In-progress reply/forward that renders INLINE under the open thread
// (Gmail's inline reply). Tied to the email it answers.
export type ReplyDraft = ComposeOrigin & {
  emailId: string;
  mode: "reply" | "forward";
  account: AccountId;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachments?: Attachment[];
  /** See ComposeState.composingSince's own doc - identical Traffic Cop role. */
  composingSince?: string;
};

/**
 * How to address the sender of a message on screen.
 *
 * `from.name` is NULL whenever the sender's client set no display name - very
 * common for a personal Gmail reply, which arrives as a bare address (the
 * backend records the absence honestly rather than inventing one, see
 * senderIdentityOf in lib/inbound-email.ts). The type used to claim `string`,
 * so every render site read the null straight through and produced a blank
 * name beside a `?` avatar. Falling back to the address is what every mail
 * client does, and it is information the row already carries.
 *
 * One helper rather than the same fallback retyped per site: the list row, the
 * reading pane, the avatar tint and the quoted reply header have to agree on
 * what a sender is called, or one person reads as two.
 *
 * TOTAL, deliberately: `from` is a JSON column passed straight through by the
 * mapper, so it can be `{}` (staging holds such a row) or null. Guarding only
 * `name` made the 'Unknown sender' fallback below unreachable - `from.email`
 * threw first - and because the list is one `.map` behind one error boundary,
 * a single malformed row blanked the entire Inbox.
 */
export function senderLabel(from: EmailSender | null | undefined): string {
  return from?.name?.trim() || from?.email?.trim() || 'Unknown sender';
}

/**
 * The sender's ADDRESS, or '' when the row does not carry one.
 *
 * Every site that interpolates or searches the address needs this rather than
 * reaching for `from.email` directly: absent, it renders the literal text
 * "undefined" to a user, and `.toLowerCase()` / `.trim()` on it throws.
 * Returning '' lets a caller apply its own `||` fallback and keeps a search
 * honest - a row with no address simply matches nothing.
 */
export function senderAddress(from: EmailSender | null | undefined): string {
  return from?.email?.trim() ?? '';
}

/**
 * Who a message came from, as the row actually stores it.
 *
 * BOTH halves are optional on purpose. This is a JSON column that the API
 * mapper forwards untouched (`from: e.from`), so nothing between the database
 * and this type validates it: `name` is absent for any client that set no
 * display name, and `email` is absent on at least one real row. Declaring
 * `email: string` did not make it a string - it only stopped the compiler from
 * pointing at the sites that would throw. Read it through senderLabel /
 * senderAddress rather than reaching in.
 */
export type EmailSender = { name?: string | null; email?: string | null };

export type Email = {
  id: string;
  account: AccountId;
  from: EmailSender;
  to: string;
  subject: string;
  snippet: string;
  body: string[];
  at: string; // display label
  ts: number; // sort key (higher = newer)
  /** Email slice 8c: PER-CALLER, computed server-side off EmailReadState (a
   *  row's existence means read for that specific user), not the legacy
   *  shared `Email.unread` column - two different users looking at the "same"
   *  wire row now genuinely see their own read state, not each other's. Same
   *  field NAME as before the slice (mapEmail still writes `unread`), just a
   *  different, per-user source of truth behind it - nothing on this side
   *  needs to special-case it, only trust whatever the server sent. */
  unread: boolean;
  starred: boolean;
  folder: Exclude<Folder, "starred">;
  labels?: string[];
  hasAttachment?: boolean;
  /** Real attached files (name + display size). Newer than `hasAttachment`. */
  attachments?: Attachment[];
  /** Conversation id — replies/forwards share it so they render as one chain.
   *  Optional on legacy seeds; threadKey() falls back to the email id. */
  threadId?: string;
  /** Gmail-style flags. `important` shows a marker; `snoozedUntil` hides the
   *  message from the inbox until the (prototype) resurface time. */
  important?: boolean;
  snoozedUntil?: string | null;
  /** Per-message job attribution (Communication ↔ Jobs). Absent = no job. */
  jobId?: string;
  /** Denormalized human job number (e.g. "J-1850") for badge rendering. */
  jobLabel?: string;
  /** The customer this message is anchored to, when any (mapEmail's
   *  `customerId`). Threaded onto a reply/forward's ComposeOrigin so
   *  "Attach from this record" and job/customer attribution survive a
   *  reply, the same way jobId already does. */
  customerId?: string;
  // ─── Real-row fields - present only on rows the backend stored ───
  /** Canonical comm-module direction vocab (in|out); absent on prototype rows. */
  direction?: "in" | "out";
  cc?: string;
  bcc?: string;
  /** Sanitized HTML body (sanitized at ingest, server-side). When present the
   *  reader renders it instead of the plain `body` paragraphs. */
  bodyHtml?: string;
  /** Delivery lifecycle (email slice 4/5) - the Resend webhook's own verdict.
   *  Exact camelCase mirror of Prisma's EmailDeliveryStatus
   *  (QUEUED/SENT/DEFERRED/DELIVERED/BOUNCED/FAILED/COMPLAINED), mapped 1:1
   *  through mapEmail (comm-whatsapp-email.controller.ts). Absent - not a
   *  default - on any row nothing has ever reported on (predates the webhook,
   *  or the webhook hasn't fired yet). NEVER a value meaning "opened": Apple
   *  Mail Privacy Protection prefetches images for roughly half of all
   *  recipients, which makes "opened" meaningless as a signal, so the backing
   *  enum has no such value and none should ever be invented client-side. */
  deliveryStatus?: string;
  /** WHY the row is in its current deliveryStatus, in the provider's own words
   *  (bounce description, rejection message). Absent on the happy path. */
  deliveryStatusReason?: string;
  /** Set only alongside deliveryStatus === "BOUNCED". "HARD" (dead address,
   *  never retry) or "SOFT" (transient - full mailbox, greylisting). */
  bounceKind?: string;
  /** Email slice 6 - whether this INBOUND message was attached to its thread.
   *  Absent on every outbound row. "MATCHED" is attached; "UNMATCHED_SENDER"
   *  means the reply token DID resolve a thread and we refused to attach it
   *  because the sender did not check out; "UNMATCHED_NO_TOKEN" is reserved for
   *  a message attributable some way other than its token, and is not reachable
   *  until the In-Reply-To fallback lands. */
  inboundMatch?: "MATCHED" | "UNMATCHED_SENDER" | "UNMATCHED_NO_TOKEN";
  /** Email slice 6 - the receiving MTA's DMARC verdict on the From header.
   *  READ THIS ALONGSIDE inboundMatch, never instead of it: only "PASS" means
   *  the sender was cryptographically established. A MATCHED row carrying
   *  "NO_POLICY" or "UNAVAILABLE" matched on an unverified string compare and
   *  must not be badged like a verified one. */
  inboundAuth?: "PASS" | "FAIL" | "NO_POLICY" | "UNAVAILABLE";
  /** Email slice 8b - the CONVERSATION's assignee (EmailThread.assigned_to_
   *  user_id), flattened onto every message in it, same as threadId/
   *  threadArchived/threadSnoozedUntil below. Already reflects auto-unassign
   *  server-side (effectiveThreadAssigneeId) - null means genuinely
   *  Unassigned, never "assignee deactivated, go check". Absent entirely on a
   *  row with no thread at all (system/transactional mail - persist
   *  TransactionalEmail never attaches one). */
  threadAssignedToUserId?: string | null;
  /** Email slice 8b - shared (workflow) archive flag on the conversation.
   *  Absent when the row carries no thread. Not yet surfaced in the UI this
   *  slice builds (assign/filter/read-state only) - carried through the
   *  mapper now so the field exists the moment archive UI is built. */
  threadArchived?: boolean;
  /** Email slice 8b - shared (workflow) snooze on the conversation. Same
   *  absent-without-a-thread rule as threadArchived above; not yet surfaced. */
  threadSnoozedUntil?: string | null;
  /** Email slice 8b - who sent this message (immutable, stamped once at
   *  send). Absent on inbound/system rows, which have no ServWave sender. */
  sentByUserId?: string;
};
