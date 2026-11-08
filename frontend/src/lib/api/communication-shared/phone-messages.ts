// Two-way SMS threads for the unified inbox (PHONE-SYSTEM-PRD §4.2.A, §6.3).
// Keyed to Customer/Contact; campaigns separated by function (§4.2.D).
// Prototype seeds; production reads from the messaging layer.

export type MessageDirection = "in" | "out";
/** Outbound lifecycle: `queued` (recorded, nothing has attempted delivery) ->
 *  `sent` (the SMS provider accepted it) -> `delivered` (carrier confirmed).
 *  `skipped` = deliberately not delivered (see `statusReason`); `failed` = the
 *  send was attempted and lost. `received` is the inbound terminal state.
 *  An outbound row must never read `sent` before the provider accepted it. */
export type MessageStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "received"
  | "skipped"
  | "failed";
export type CampaignType = "customer_care" | "marketing_review" | "tech_ops";

export const CAMPAIGN_LABELS: Record<CampaignType, string> = {
  customer_care: "Customer care",
  marketing_review: "Marketing / review",
  tech_ops: "Technician ops",
};

export type Message = {
  id: string;
  direction: MessageDirection;
  body: string;
  ts: string;
  status?: MessageStatus;
  /** Why a `skipped`/`failed` row was not delivered (e.g. "SMS_NOT_READY",
   *  "RECIPIENT_OPTED_OUT"). Absent on every other status. */
  statusReason?: string;
  /** true when this was an automated/system message (e.g. missed-call text-back). */
  automated?: boolean;
  /** Per-message job attribution (Communication ↔ Jobs). Absent = unrouted /
   *  no job — inbound rows without a jobId surface in the Unrouted tray. */
  jobId?: string;
  /** Denormalized human job number (e.g. "J-1850") so badges render with no join. */
  jobLabel?: string;
};

/** How a thread is filed in the unified inbox directory (§14.17).
 *  - customer: a two-way conversation with a customer/contact (default)
 *  - team:     an internal thread with office staff or a field tech
 *  - group:    a multi-party thread (e.g. a job crew) */
export type ThreadKind = "customer" | "team" | "group";

export type MessageThread = {
  id: string;
  /** The customer counterparty. OPTIONAL, and the server still sends `""` rather
   *  than omitting it on a thread that has none - that empty string is a legacy
   *  sentinel from when a customer was the ONLY counterparty a thread could have.
   *  Do not read it as "which counterparty is this": a staff thread is identified
   *  by `userId`, a supplier thread by `vendorId`, a lead thread by `leadId`. */
  customerId?: string;
  channel: "sms";
  campaignType: CampaignType;
  unread: number;
  messages: Message[];
  /** Directory bucket. Absent = "customer". */
  kind?: ThreadKind;
  /** Filed away — shown only under the Archive filter. */
  archived?: boolean;
  /** Display name for team/group threads that aren't tied to a Customer —
   *  ALSO the E.164 key of an unknown-number SMS thread (no customer/vendor). */
  title?: string;
  /** Secondary line for team/group threads (role, branch, participant count). */
  subtitle?: string;
  /** Linked vendor (supplier threads). Unknown-number threads have neither
   *  customerId nor vendorId — their title IS the counterpart number. */
  vendorId?: string;
  /** Linked lead (a thread opened from a Lead page). */
  leadId?: string;
  /** Spec C - the staff counterparty. Present only on a thread addressed to a
   *  member of staff, which carries no customer, lead or vendor. */
  userId?: string;
  /** The staff member's display name, sent alongside `userId` so a staff thread
   *  renders a name without a second call. */
  linkedUser?: { id: string; name: string };
};
