// Owned phone numbers (Phone module — Numbers view).
//
// `OwnedNumber` is the UI-facing shape of an org-owned tracking/receiving
// number. It moved here from NumbersView.tsx (slice 7) so the data seam
// (lib/api/communication.ts) can map GET /api/communication/numbers rows
// without importing a component; NumbersView re-exports it for compatibility.

export type NumberType = "Local · Primary" | "Local" | "Toll-free";
/** `pending` / `failed` are purchase states: the row is claimed before the
 *  provider is called, so a purchase that dies mid-flight leaves a VISIBLE row
 *  instead of an invisible recurring charge. Neither is usable for calls. */
export type NumberStatus = "active" | "paused" | "released" | "pending" | "failed";

export type OwnedNumber = {
  id: string;
  number: string; // formatted, e.g. "(551) 282-7064"
  tag?: string; // small label under the number
  type: NumberType;
  flowId: string; // "" = no flow assigned
  adGroupId?: string; // "" / undefined = no ad group assigned
  /** Where calls to this number actually ring (E.164), or null when no simple
   *  forward is set. Editable - it is the routing, not a label. */
  forwardTo?: string | null;
  status: NumberStatus;
  createdAt: string; // ISO
  /** Texting-capable (wire `sms_enabled`) — gates the SMS composer (§5.4). */
  smsEnabled?: boolean;
};
