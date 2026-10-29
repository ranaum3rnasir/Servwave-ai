// SRVW-105 - shared partial-failure summary for the four bulk-selection toolbars (Estimates
// bulk delete/status/reminder, Invoices bulk send/resend, Customers bulk tag). Lifted verbatim
// from EstimatesPage.tsx's original bulk-delete toast logic: dedupe the failure reasons, quote
// the single shared reason when every failure agrees, and fall back to a generic phrase when the
// batch failed for mixed reasons rather than asserting a specific cause that may not be true for
// every failed row.

export interface BulkFailure {
  id: string;
  error: string;
}

export interface SummariseBulkResultArgs {
  /** Count of ids that succeeded. */
  okCount: number;
  failed: BulkFailure[];
  /** Singular noun, e.g. "estimate". */
  noun: string;
  /** Plural noun, e.g. "estimates". */
  nounPlural: string;
  /** Past-tense verb describing the successful action, e.g. "deleted", "updated", "sent", "tagged". */
  verbPast: string;
}

export function summariseBulkResult({
  okCount,
  failed,
  noun,
  nounPlural,
  verbPast,
}: SummariseBulkResultArgs): { title: string; description: string } {
  const failedCount = failed.length;
  const okLabel = okCount === 1 ? noun : nounPlural;

  if (failedCount === 0) {
    return {
      title: `${nounPlural.charAt(0).toUpperCase()}${nounPlural.slice(1)} ${verbPast}`,
      description: `${verbPast.charAt(0).toUpperCase()}${verbPast.slice(1)} ${okCount} ${okLabel}.`,
    };
  }

  const failureReasons = [...new Set(failed.map((f) => f.error))];
  const reasonText = failureReasons.length === 1 ? failureReasons[0] : 'various reasons';

  return {
    title: `Some ${nounPlural} could not be ${verbPast}`,
    description: `${verbPast.charAt(0).toUpperCase()}${verbPast.slice(1)} ${okCount} ${okLabel}. ${failedCount} could not be ${verbPast} (${reasonText}).`,
  };
}
