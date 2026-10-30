/**
 * Payments go-live slice 33 (fix round 2) - processor ids never reach the browser (its network tab
 * is user-visible). The stored columns and event metadata keep them (the reconciler matches on
 * them); a RESPONSE drops every key shaped like one. Server logic that needs a value reads it
 * before the response is built.
 */
const PROCESSOR_ID_KEY = /^(stripe_.*_id|processor_.*_id|payment_intent)$/;
/**
 * A string that, AS A WHOLE, is a processor id: one of its id prefixes, an underscore, then a body
 * with a segment of 14+ alphanumerics carrying a digit, a lowercase AND an uppercase letter (real
 * ids are long mixed-case tokens; a typed PO, check or reference number such as 'po_45000123' is
 * not). Test-mode infixes ('cs_test_...') and later segments ('pi_..._secret_...') are allowed.
 * Never a substring match.
 */
const PROCESSOR_ID_PREFIX = /^(?:evt|re|pi|ch|py|cs|dp|du|pm|src|card|ba|acct|cus|txn|po|tr|trr|fee|fr|seti|in|sub|file|link|mandate|pmc)_([A-Za-z0-9_]+)$/;

/** True when `v` is shaped like a processor id (or a colon-joined composite of them). Exported for guard tests. */
export function isProcessorIdValue(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  // A composite such as 'evt_<id>:du_<id>' (the reconciler's event_id) is an id when EVERY part is.
  if (v.includes(':')) return v.split(':').every(isSingleProcessorId);
  return isSingleProcessorId(v);
}

function isSingleProcessorId(v: string): boolean {
  const m = PROCESSOR_ID_PREFIX.exec(v);
  return !!m && m[1].split('_').some((seg) => seg.length >= 14 && /[0-9]/.test(seg) && /[a-z]/.test(seg) && /[A-Z]/.test(seg));
}

export interface ProcessorIdOptions {
  /**
   * Also drop id-shaped string VALUES under any key. Only for server-written free-form metadata
   * (timeline events); never for documents carrying user-typed fields.
   */
  scrubValues?: boolean;
}

/** A copy of `value` with every processor-id key (and, with `scrubValues`, every id-shaped string value) removed at any depth. Dates, Decimals etc. pass through. */
export function withoutProcessorIdKeys<T>(value: T, opts: ProcessorIdOptions = {}): T {
  const dropValue = (v: unknown) => !!opts.scrubValues && isProcessorIdValue(v);
  if (Array.isArray(value)) return value.filter((v) => !dropValue(v)).map((v) => withoutProcessorIdKeys(v, opts)) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!PROCESSOR_ID_KEY.test(k) && !dropValue(v)) out[k] = withoutProcessorIdKeys(v, opts);
    }
    return out as T;
  }
  return value;
}
