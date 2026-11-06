/**
 * The sweep's reads in pages (#2992): no sweep query reads all of a company's rows in one go. A read over a company's
 * rows (its open leads, its unread Spider records, the alert-log rows of its overdue leads) goes in keyset pages of
 * SWEEP_PAGE_SIZE rows, ordered by a unique key and continued after the last key read, so the order is total: no row
 * is skipped or read twice across pages, whatever else the rows share. A read for a list of ids goes in chunks of
 * at most SWEEP_PAGE_SIZE ids.
 */

/** The most rows one sweep read returns, and the most ids one read asks for. */
export const SWEEP_PAGE_SIZE = 500;

/** The items in consecutive chunks of at most `size`, in their order. None for no items. */
export function inChunks<T>(items: readonly T[], size: number = SWEEP_PAGE_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The items in consecutive chunks whose JSON text stays within `maxBytes` each, and that hold at most `maxItems` items,
 * in their order (#3107, #3108): for a write whose rows differ in size, so no single statement grows past a size no matter
 * how long each row's text is, nor past a number of rows. An item bigger than `maxBytes` alone is a chunk of its own. None
 * for no items.
 */
export function inChunksOfBytes<T>(items: readonly T[], maxBytes: number, maxItems: number = Number.POSITIVE_INFINITY): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (chunk.length > 0 && (bytes + size > maxBytes || chunk.length >= maxItems)) {
      out.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += size;
  }
  if (chunk.length > 0) out.push(chunk);
  return out;
}

/**
 * Reads every page of a keyset read and hands each to `each`, in order. `read(after)` must return at most `size` rows
 * ordered by `key` ascending, only rows whose key is greater than `after` (all rows when `after` is undefined), and
 * the key must be unique. A page shorter than `size` is the last one, so a company with fewer rows than a page costs
 * exactly one read, as before paging.
 */
export async function forEachKeysetPage<T>(
  read: (after: string | undefined) => Promise<T[]>,
  key: (row: T) => string,
  each: (page: T[]) => Promise<void> | void,
  size: number = SWEEP_PAGE_SIZE,
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    if (page.length === 0) return;
    await each(page);
    if (page.length < size) return;
    after = key(page[page.length - 1]!);
  }
}

/** Every row of a keyset read, page by page (forEachKeysetPage). */
export async function allKeysetPages<T>(
  read: (after: string | undefined) => Promise<T[]>,
  key: (row: T) => string,
  size: number = SWEEP_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  await forEachKeysetPage(read, key, (page) => void rows.push(...page), size);
  return rows;
}
