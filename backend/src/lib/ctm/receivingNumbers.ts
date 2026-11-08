import { isCtmConfigured, listReceivingNumbers } from './client';
import { normalizeNAPhone } from '../comms-identity';
import { logger } from '../logger';

/**
 * Resolve a CTM `receiving_number_id` (its numeric `filter_id`) to the phone
 * that actually rang, so a forwarded inbound call can name whoever picked up.
 *
 * WHY THIS IS A CACHE AND NOT A LOOKUP FUNCTION
 *
 * ingestCall runs inside the CTM webhook's `prisma.$transaction`. An HTTP
 * request on that path would hold a database transaction open across the
 * network, and Prisma aborts an interactive transaction after 5s - so a slow
 * CTM would not merely lose the attribution, it would roll back the whole
 * ingest and drop the call record. The read on the hot path is therefore
 * strictly synchronous and cache-only (`lookupReceivingNumber`), and callers
 * populate the cache from OUTSIDE their transaction (`warmReceivingNumbers`).
 *
 * Everything here fails open. Attribution is an enrichment on top of a call
 * that is worth recording either way: an unconfigured environment, a revoked
 * key or a CTM outage degrades the answer to "unknown" and never propagates an
 * error into ingest, because a rejected webhook is retried by CTM and a
 * persistently rejected one is a lost call.
 */

/** How long a fetched roster stays authoritative. Numbers get added, renamed
 *  and released in CTM, so a process-lifetime cache would attribute calls to a
 *  stale roster until the next deploy; 10 minutes bounds that drift while
 *  keeping a busy line to ~6 API calls an hour. */
export const RECEIVING_NUMBER_TTL_MS = 10 * 60 * 1000;

export interface ReceivingNumber {
  /** E.164, normalised - CTM's own `number` is E.164 today, but sibling fields
   *  on the same record are punctuated and its naming drifts across endpoints. */
  e164: string;
  /** CTM's label for the number, null on any number nobody has named there. */
  name: string | null;
}

interface CacheEntry {
  fetchedAt: number;
  byFilterId: Map<string, ReceivingNumber>;
}

const cache = new Map<string, CacheEntry>();
// In-flight warms, so simultaneous webhooks on the same account collapse into
// one request instead of racing "check cache, then fetch" into N of them.
const inFlight = new Map<string, Promise<void>>();

/** Test seam. */
export function clearReceivingNumberCache(): void {
  cache.clear();
  inFlight.clear();
}

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.fetchedAt < RECEIVING_NUMBER_TTL_MS;
}

async function fetchRoster(accountId: string): Promise<void> {
  const records = await listReceivingNumbers(accountId);
  const byFilterId = new Map<string, ReceivingNumber>();

  for (const record of records) {
    const filterId = (record as { filter_id?: unknown }).filter_id;
    const rawNumber = (record as { number?: unknown }).number;
    // A record missing either half is unusable, not an error: it simply cannot
    // participate in a lookup, and caching it would only produce a hit that
    // resolves to nothing.
    if (filterId === null || filterId === undefined || filterId === '') continue;
    if (typeof rawNumber !== 'string' || !rawNumber.trim()) continue;

    const e164 = normalizeNAPhone(rawNumber);
    if (!e164) continue;

    const rawName = (record as { name?: unknown }).name;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
    byFilterId.set(String(filterId), { e164, name });
  }

  cache.set(accountId, { fetchedAt: Date.now(), byFilterId });
}

/**
 * Populate the cache for an account. Safe to call on every webhook: a fresh
 * entry short-circuits, and concurrent calls share one request.
 *
 * MUST be awaited outside any database transaction - see the module header.
 * Never rejects.
 */
export async function warmReceivingNumbers(accountId: string): Promise<void> {
  if (!accountId || !isCtmConfigured()) return;
  if (isFresh(cache.get(accountId))) return;

  const existing = inFlight.get(accountId);
  if (existing) return existing;

  const pending = fetchRoster(accountId)
    .catch((err) => {
      // Deliberately NOT cached as a negative result: a transient 503 must not
      // blind attribution for a whole TTL window.
      logger.warn(
        `[ctm] could not refresh receiving numbers for account ${accountId} - ` +
          `forwarded calls will ingest without an answerer: ${(err as Error).message}`,
      );
    })
    .finally(() => {
      inFlight.delete(accountId);
    });

  inFlight.set(accountId, pending);
  return pending;
}

/**
 * Cache-only read: returns the number behind a `receiving_number_id`, or null
 * when the roster was never warmed, has expired, or does not know the id.
 *
 * Synchronous by design - this is the call that happens inside the webhook's
 * database transaction.
 */
export function lookupReceivingNumber(
  accountId: string,
  filterId: string,
): ReceivingNumber | null {
  if (!accountId || !filterId) return null;
  const entry = cache.get(accountId);
  if (!isFresh(entry)) return null;
  return entry.byFilterId.get(String(filterId)) ?? null;
}
