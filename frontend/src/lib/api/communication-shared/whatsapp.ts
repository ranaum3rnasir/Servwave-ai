// WA types for the Communication hub's WhatsApp page. Chats come from the API
// via useWhatsAppChats() - no WhatsApp Business account exists for any org,
// so nothing here is transmitted.

export type WAStatus = "sent" | "delivered" | "read";

export type WAMessage = {
  id: string;
  /** "them" = the customer, "us" = the business. */
  from: "them" | "us";
  text: string;
  /** Wall-clock label shown under the bubble. */
  at: string;
  /** Delivery state — only meaningful for outbound ("us") messages. */
  status?: WAStatus;
  /** Per-message job attribution (Communication ↔ Jobs). Absent = no job. */
  jobId?: string;
  /** Denormalized human job number (e.g. "J-1850") for badge rendering. */
  jobLabel?: string;
};

export type WAChat = {
  id: string;
  name: string;
  /** Sub-line under the name in the list (company / role). */
  org: string;
  phone: string;
  /** Unread inbound count shown as a green pill. */
  unread: number;
  /** Last-activity label for the list row. */
  lastAt: string;
  messages: WAMessage[];
};
