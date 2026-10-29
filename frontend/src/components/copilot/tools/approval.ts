/**
 * Approval hash-pinning. When the user is shown an approval card, the resolved
 * payload is pinned with a content hash. At execution time we re-hash and refuse
 * to run if anything drifted — so what executes is EXACTLY what was approved.
 */

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface PreparedAction {
  capabilityId: string;
  toolName: string;
  /** One-line, human/spoken summary of what will happen. */
  summary: string;
  /** Field-by-field breakdown for the card. */
  detail: ApprovalDetail[];
  endpoint: { method: string; path: string };
  payload: Record<string, unknown>;
  isFinancial?: boolean;
  amountLabel?: string;
  /** Content hash of `payload`, pinned at approval time. */
  hash: string;
}

/** Deterministic JSON: object keys sorted recursively so hashing is order-independent. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** djb2 string hash → hex. Not cryptographic — only a drift detector. */
export function hashPayload(value: unknown): string {
  const str = stableStringify(value);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export function prepareAction(input: Omit<PreparedAction, 'hash'>): PreparedAction {
  return { ...input, hash: hashPayload(input.payload) };
}

/** True iff the payload still matches the hash pinned at approval time. */
export function verifyUnchanged(action: PreparedAction): boolean {
  return hashPayload(action.payload) === action.hash;
}
