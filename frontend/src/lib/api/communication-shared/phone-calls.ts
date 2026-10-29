// CallSession records — the inbound/outbound interaction log (PHONE-SYSTEM-PRD
// §4.1.A, §6.2). Every call is logged whether answered, missed, or sent to
// voicemail. Prototype seeds; production is written by the telephony gateway
// from CTM/CPaaS webhooks.

export type CallDirection = "inbound" | "outbound";
export type CallStatus = "ringing" | "active" | "completed" | "voicemail" | "missed";

/** A call that is over: the 'end' webhook resolved it. `ringing` / `active`
 *  rows (a 'starts' webhook) are a call still in progress. */
export function isFinalCallStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "voicemail" || status === "missed";
}
// "external" = answered on a forwarded phone outside the CTM app (no agent identity).
export type AnsweredByKind = "csr" | "ai" | "voicemail" | "none" | "external";
export type Sentiment = "positive" | "neutral" | "negative";

// Disposition taxonomy — PHONE-SYSTEM-PRD §4.3.C.
export type Disposition =
  | "booked"
  | "quote_requested"
  | "quote_given"
  | "reschedule"
  | "cancel"
  | "status_check"
  | "billing"
  | "warranty"
  | "service_area_mismatch"
  | "spam"
  | "after_hours_emergency"
  | "needs_manager"
  | "follow_up";

export const DISPOSITION_LABELS: Record<Disposition, string> = {
  booked: "Booked",
  quote_requested: "Quote requested",
  quote_given: "Quote given · not booked",
  reschedule: "Reschedule",
  cancel: "Cancel",
  status_check: "Status check",
  billing: "Billing",
  warranty: "Warranty",
  service_area_mismatch: "Out of service area",
  spam: "Spam / VM",
  after_hours_emergency: "After-hours emergency",
  needs_manager: "Needs manager",
  follow_up: "Follow-up",
};

// One utterance from CTM's structured transcript (transcription.json outline[]),
// as opposed to the flat transcriptPreview string: channel 1 is always the
// external party, channel 2 is always our side — never infer sidedness from
// the speaker name, which varies (a user or a call group name).
export type CallTranscriptTurn = {
  speaker: string;
  text: string;
  channel: number | null;
  startSec: number | null;
  endSec: number | null;
};

export type CallSession = {
  id: string;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  trackingSource?: string;
  status: CallStatus;
  // `name` carries the resolved answerer (CTM CSR name / forwarded label) straight
  // from the stored answered_by JSON — present even when no PhoneAgent record matches.
  answeredBy: { kind: AnsweredByKind; id?: string; name?: string };
  startedAt: string;
  durationSec?: number;
  customerId?: string;
  jobId?: string;
  /** Human-readable job reference shown in the Calls table (e.g. "J00077"). */
  jobLabel?: string;
  /**
   * Lead anchor. A call carries BOTH a job and a lead once attached, because
   * attaching either end stamps the pair (see reassignCallJob/reassignCallLead);
   * a lead that has not become a job yet carries only these.
   *
   * There was previously a `jobKind: 'job' | 'lead'` here that the API never
   * emitted - only the demo seed set it - so every real lead-anchored call
   * rendered as a job. These two are what the backend actually sends.
   */
  leadId?: string;
  linkedLead?: { id: string; leadNumber: string };
  disposition?: Disposition;
  sentiment?: Sentiment;
  summary?: string;
  transcriptPreview?: string;
  hasRecording?: boolean;
  /** QA score for this specific call (0–100). Set once a recording is scored. */
  qaScore?: number;
  /** Confidence-gated review flag — low-confidence extracted field (§4.3.B). */
  reviewFlag?: string;
  /** Call-flow / routing rule that handled the call (e.g. "Forward to Emanuel"). */
  callFlow?: string;
  /** Free-form labels applied to the call. */
  tags?: string[];
  /** Revenue attributed to this call. */
  revenue?: number;
};
