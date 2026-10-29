import type { Item } from "@/lib/api/inventory";
import { cn } from "@/lib/utils";

/**
 * Model number, manufacturer part number and finish, as one muted line.
 *
 * All three are writable from the Add/Edit Item dialog but had no read-back
 * surface at all - you could save a model number and never see it again. This
 * is that surface, shared by the Stock grid, the Stock side panel and the Price
 * Book grid so the format cannot drift. Only the routed v2 Price Book page
 * SEARCHES on them; the pages here do not, and neither does the API.
 *
 * The colour is a default, not a rule - `className` goes through `cn`, so a
 * caller sitting in the v2 kit can hand it that kit's muted token and have it
 * actually win rather than depend on stylesheet order.
 *
 * Finish is a foreign key rather than a string, so the caller resolves the id
 * to a name and passes `finishName`. Keeping the lookup out here means this
 * stays presentational and does not fire a query per rendered row.
 *
 * Renders nothing when the item carries none of them. That is the common case,
 * not the edge case: `model_number` and `finish_id` are new columns with no
 * backfill, so an unconditional line would put a row of placeholders under
 * every existing item.
 */
export function ItemIdentifiers({
  item,
  finishName,
  className = "",
}: {
  item: Pick<Item, "mpn" | "modelNumber">;
  /** Resolved finish name. Omitted (or undefined) renders no finish segment -
   *  which is also what a finish id with no matching row must produce, so a
   *  stale id shows nothing rather than a raw uuid. */
  finishName?: string;
  className?: string;
}) {
  const parts = [
    item.modelNumber ? `Model ${item.modelNumber}` : null,
    item.mpn ? `Part ${item.mpn}` : null,
    finishName ? `Finish ${finishName}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className={cn("truncate text-[11px] text-text-secondary", className)}>
      {parts.join(" · ")}
    </p>
  );
}
