// Blocked callers (PHONE-SYSTEM-PRD §14.19). The Blocked callers tab is the
// only writer: rows persist through POST /api/communication/blocked and are
// read back by GET /api/communication/blocked.
//
// Enforcement is record-side ONLY - a blocked number's calls and texts are
// still recorded, they just raise no bell and no unread badge (backend
// lib/ctm/ingest.ts). Nothing is blocked at the carrier, and nothing can be:
// see backend/src/lib/communication/blockedNumbers.ts for the decision record.

export type BlockReason = "spam" | "not_spam" | "customer" | "other";

export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  spam: "Spam",
  not_spam: "Not spam",
  customer: "Customer",
  other: "Other",
};

/** Pill tone per reason for the blocked-callers list. */
export const BLOCK_REASON_TONE: Record<BlockReason, string> = {
  spam: "bg-danger-surface text-danger-text ring-danger-border",
  not_spam: "bg-neutral-surface text-neutral-text ring-neutral-border",
  customer: "bg-ai-surface text-ai-text ring-ai-border",
  other: "bg-warning-surface text-warning-text ring-warning-border",
};

export type BlockedNumber = {
  id: string;
  /** E.164 (+12125551042); pre-2026-08 rows may still hold display form -
   *  render through fmtPhone, compare through the backend key. */
  number: string;
  /** Caller/customer name if we know it. */
  name?: string;
  reason: BlockReason;
  /** Free-text note on why this number was blocked. */
  note?: string;
  blockedAt: string; // ISO
  blockedBy: string;
};
