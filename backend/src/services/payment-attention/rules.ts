/**
 * Payments go-live P4 - when a Needs attention item is open and how it resolves (pure, no database).
 *
 * The list is derived from ServWave's own rows, so an item's state is a function of the facts around it. The SQL in
 * ./queries.ts selects exactly the rows each predicate here calls open or resolved; these functions put WORDS on the
 * resolved ones. A suite seeds every combination and checks the two agree.
 */

export const ATTENTION_TYPES = [
  'failed_payment', 'failed_refund', 'dispute', 'failed_payout', 'unmatched_payment', 'unmatched_refund',
] as const;
export type AttentionType = (typeof ATTENTION_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An item's key: `<type>:<source row id>`, stable for the life of the row. */
export const itemKey = (type: AttentionType, id: string): string => `${type}:${id}`;

export function parseItemKey(key: string): { type: AttentionType; id: string } | null {
  const at = key.indexOf(':');
  if (at < 0) return null;
  const type = key.slice(0, at);
  const id = key.slice(at + 1);
  if (!(ATTENTION_TYPES as readonly string[]).includes(type) || !UUID_RE.test(id)) return null;
  return { type: type as AttentionType, id: id.toLowerCase() };
}

/** What a person wrote when they closed an item (payment_attention_resolutions). */
export type PersonResolution = { kind: 'RESOLVED' | 'SETTLED'; note: string | null; by: string | null; at: Date };

export type Open = { open: true };
export type Resolved = { open: false; text: string; by: string | null; note: string | null; at: Date | null };
export type Classified = Open | Resolved;

const OPEN: Open = { open: true };
const resolved = (text: string, at: Date | null, by: string | null = null, note: string | null = null): Resolved => ({ open: false, text, by, note, at });
const byPerson = (r: PersonResolution): Resolved => resolved(r.kind === 'SETTLED' ? 'Marked settled' : 'Marked resolved', r.at, r.by, r.note);

/** A failed bank payment: closed by a person, a voided invoice, a later payment or a paid invoice. */
export function classifyFailedPayment(f: {
  resolution: PersonResolution | null;
  invoiceStatus: string;
  later: { method: string; at: Date } | null;
}): Classified {
  if (f.resolution) return byPerson(f.resolution);
  if (f.invoiceStatus === 'VOIDED') return resolved('Invoice voided', null);
  if (f.later) return resolved(f.later.method === 'ACH' || f.later.method === 'CARD' ? 'Paid again' : 'Paid another way', f.later.at);
  if (f.invoiceStatus === 'PAID') return resolved('Paid another way', null);
  return OPEN;
}

/** A failed refund: closed by a person, or by a later refund of at least the amount (by whoever made it). */
export function classifyFailedRefund(f: { resolution: PersonResolution | null; later: { by: string | null; at: Date } | null }): Classified {
  if (f.resolution) return byPerson(f.resolution);
  if (f.later) return resolved('Refunded again', f.later.at, f.later.by);
  return OPEN;
}

const DISPUTE_TEXT: Record<string, string> = {
  UNDER_REVIEW: 'Evidence submitted',
  WON: 'Dispute won',
  LOST: 'Dispute lost',
  CLOSED: 'Dispute closed',
};

/** A dispute: open while it needs a response; the status the reconciler moved it to says the rest. */
export function classifyDispute(f: { status: string; at: Date | null }): Classified {
  if (f.status === 'NEEDS_RESPONSE') return OPEN;
  return resolved(DISPUTE_TEXT[f.status] ?? 'Dispute closed', f.at);
}

/** A failed payout: closed by a person, or by a later payout that was paid. */
export function classifyFailedPayout(f: { resolution: PersonResolution | null; laterPaidAt: Date | null }): Classified {
  if (f.resolution) return byPerson(f.resolution);
  if (f.laterPaidAt) return resolved('Payout sent', f.laterPaidAt);
  return OPEN;
}

/** Money that is not on an invoice: its own status column, written by the existing endpoints. */
export function classifyUnapplied(f: { status: string; refundedAt: Date | null; updatedAt: Date }): Classified {
  if (f.status === 'OPEN') return OPEN;
  if (f.status === 'REFUNDED') return resolved('Refunded', f.refundedAt ?? f.updatedAt);
  return resolved('Marked resolved', f.updatedAt);
}
