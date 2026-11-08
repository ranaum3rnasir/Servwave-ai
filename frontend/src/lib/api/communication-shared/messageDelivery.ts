// How an outbound message's delivery state reads in the UI.
//
// The backend stopped writing `sent` optimistically (see lib/ctm/sendSms.ts):
// a row is `queued` until the provider accepts it, `sent` once it does,
// `delivered` once the carrier confirms via the status_change webhook, and
// `skipped` when a gate deliberately suppressed the send. Rendering all of
// those as an ordinary blue bubble would put the false-success back in the UI
// even though the data is now honest.

import type { Message, MessageStatus } from "./phone-messages";

/** Reasons the delivery path records on a skipped/failed row, in plain English. */
const REASON_COPY: Record<string, string> = {
  NOT_CONNECTED: "the phone system is not connected yet",
  SMS_NOT_READY: "the A2P campaign is not approved yet",
  ORG_SMS_DISABLED: "texting is switched off for this account",
  NOT_ENTITLED: "this plan does not include texting",
  NO_SMS_NUMBER: "there is no number to text from or to",
  NOT_IN_TEST_ALLOWLIST: "the destination is not on the test allowlist",
  RECIPIENT_OPTED_OUT: "the recipient opted out of texts",
  DUPLICATE_SEND: "an identical text had just been sent",
  PROVIDER_ERROR: "the provider rejected it",
  // TODO(phone-api-neutral-names): the previous code for the same failure,
  // still sent by an old backend for one release. Drop it then.
  CTM_ERROR: "the provider rejected it",
};

export type DeliveryTone = "ok" | "pending" | "muted" | "danger";

export interface DeliveryNote {
  tone: DeliveryTone;
  /** Short label for the meta row. Null when the state needs no annotation. */
  label: string | null;
  /** Fuller explanation for a title/tooltip. */
  title: string;
}

export function deliveryNote(m: Pick<Message, "direction" | "status" | "statusReason">): DeliveryNote {
  if (m.direction !== "out") return { tone: "ok", label: null, title: "" };

  const because = m.statusReason ? REASON_COPY[m.statusReason] ?? m.statusReason : null;

  switch (m.status as MessageStatus | undefined) {
    case "failed":
      return {
        tone: "danger",
        label: "Failed to send",
        title: because ? `Not delivered - ${because}` : "Not delivered - this text failed to send",
      };
    case "skipped":
      return {
        tone: "muted",
        label: "Not sent",
        title: because ? `Recorded but not sent - ${because}` : "Recorded, but never sent",
      };
    case "queued":
      return { tone: "pending", label: "Sending", title: "Recorded - waiting on the provider" };
    case "delivered":
      return { tone: "ok", label: null, title: "Delivered" };
    case "sent":
      return { tone: "ok", label: null, title: "Sent - awaiting delivery confirmation" };
    default:
      return { tone: "ok", label: null, title: "" };
  }
}

/** Bubble classes for an outbound message, by delivery tone. Design tokens only. */
export function outboundBubbleClass(tone: DeliveryTone): string {
  switch (tone) {
    case "danger":
      // Failed delivery = danger tokens (never notify rose).
      return "border border-danger/40 bg-danger/10 text-danger";
    case "muted":
      // Never sent: deliberately not the confident primary fill.
      return "border border-border bg-surface-light text-text-secondary";
    case "pending":
      return "bg-primary/60 text-on-fill";
    default:
      return "bg-primary text-on-fill";
  }
}
