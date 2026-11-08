import type { Vendor, VendorUpsertPayload } from "@/lib/api/inventory";

/**
 * Fold a vendor upsert payload into the local `Vendor` mirror both vendor pages
 * keep alongside the query.
 *
 * The two shapes disagree on one thing, deliberately. On the WIRE, clearing an
 * optional column is an explicit `null` — `undefined` would be dropped by
 * `JSON.stringify` and the server's `!== undefined` guard would leave the old
 * value in place. On the READ type, an absent column is `undefined`, because
 * `toVendorDto` omits the key rather than emitting null. Spreading the raw
 * patch would therefore push `null` onto a `?: string` field that ~30 read
 * sites consume, so translate here instead of widening `Vendor`.
 */
export function applyPatch(v: Vendor, patch: VendorUpsertPayload): Vendor {
  const next: Record<string, unknown> = { ...v };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value === null ? undefined : value;
  }
  return next as Vendor;
}
