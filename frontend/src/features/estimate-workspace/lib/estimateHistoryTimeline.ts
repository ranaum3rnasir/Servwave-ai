/**
 * Merging the version stream into the activity stream (#2030 slice 4).
 *
 * Two streams, one drawer. They are merged HERE, in a pure function, rather than interleaved in
 * JSX, because every defect in a merged timeline is an ordering defect — a tie, a missing
 * timestamp, an empty stream — and none of those are reachable through a rendered component
 * without a fixture per case.
 *
 * NOTHING here touches the activity query. The events arrive exactly as the history endpoint has
 * always returned them; the versions arrive from their own list endpoint. The merge is additive.
 */

/** One row of `audit_logs`, as `GET /api/estimates/:id/history` has always returned it. */
export interface EstimateActivityEvent {
  id: string;
  action: string;
  actor_email?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

/** One row of `GET /api/estimates/:id/versions`. Summary only — the frozen document is not here. */
export interface EstimateVersionSummary {
  id: string;
  version: number;
  trigger: string | null;
  /** Prisma Decimal serialises as a string over the wire; both spellings are accepted. */
  total_amount: number | string | null;
  sent_at: string;
}

export type HistoryTimelineEntry =
  | { kind: 'event'; key: string; at: number | null; event: EstimateActivityEvent }
  | { kind: 'version'; key: string; at: number | null; version: EstimateVersionSummary };

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest first — the order the history drawer has always used, so adding versions does not
 * reverse the list a reader already knows.
 */
export function buildEstimateHistoryTimeline(
  events: readonly EstimateActivityEvent[] | undefined,
  versions: readonly EstimateVersionSummary[] | undefined,
): HistoryTimelineEntry[] {
  const entries: HistoryTimelineEntry[] = [
    ...(events ?? []).map<HistoryTimelineEntry>((event) => ({
      kind: 'event',
      key: `event:${event.id}`,
      at: instant(event.created_at),
      event,
    })),
    ...(versions ?? []).map<HistoryTimelineEntry>((version) => ({
      kind: 'version',
      // Keyed off the snapshot's IDENTITY, never off its version number. The number is the
      // addressable ordinal the read-only route uses; rows written before minting assigned its
      // own ordinal can still collide on it, and `id` cannot.
      key: `version:${version.id}`,
      at: instant(version.sent_at),
      version,
    })),
  ];

  return entries.sort((a, b) => {
    const byTime = (b.at ?? 0) - (a.at ?? 0);
    if (byTime !== 0) return byTime;
    // A send writes its audit row and mints its snapshot in the same breath, so a version and an
    // event share an instant routinely. The version wins the tie: it is the anchor a reader came
    // for, and burying it under the event that describes it defeats the point of the merge.
    if (a.kind !== b.kind) return a.kind === 'version' ? -1 : 1;
    if (a.kind === 'version' && b.kind === 'version') return b.version.version - a.version.version;
    return 0;
  });
}

/**
 * How a version reached the customer, in the words a salesperson would use. Unknown or missing
 * triggers fall back to the plain statement rather than to the raw enum: a reader of the history
 * drawer should never meet a database value.
 */
const TRIGGER_SENTENCE: Record<string, string> = {
  SEND: 'Emailed to the customer',
  MARK_SENT: 'Marked as sent',
  COPY_TO_INVOICE: 'Copied to an invoice',
};

export function versionTriggerSentence(trigger: string | null | undefined): string {
  return TRIGGER_SENTENCE[trigger ?? ''] ?? 'Sent to the customer';
}
