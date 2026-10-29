import { prisma } from '../prisma';
import { logger } from '../logger';
import { normalizeNAPhone } from '../comms-identity';
import { isCtmConfigured } from './client';
import { syncNumbers } from './numberSync';

/**
 * A call or text on a number ServWave does not have yet syncs the org's numbers
 * (PRD #2371, stories 5, 47, 48).
 *
 * The phone system sends no event when a number is added to an account (its
 * webhooks cover calls, texts and forms only), so a number moved onto the
 * account first shows up as a call or text on it. The phone webhook calls this
 * AFTER it has answered and its ingest transaction has closed; it checks the
 * event's tracking number against the org's stored numbers and, when the number
 * is missing, runs one sync through the shared number-sync routine. That
 * routine's per-org throttle joins a run already going and skips an automatic
 * sync within 60 seconds of the last, so a burst of calls on a new number reads
 * the phone system once.
 *
 * WHY A ROSTER CACHE
 *
 * Nothing on the webhook path loads the org's stored numbers, and every call
 * and text would otherwise cost a query just to learn "yes, we have it". The
 * org's E.164 set is cached in process memory for `ORG_NUMBER_ROSTER_TTL_MS`,
 * the same way the receiving-number roster is. A number the cached set does
 * not hold is re-read from the database before anything is synced: the set may
 * simply be older than the number (the last sync, a purchase, or the Sync
 * button stored it after the set was loaded). That re-read is what stops a
 * stale set from asking for a sync on every call - so a cache miss costs one
 * small query, and a sync happens only for a number the database lacks too.
 *
 * Never rejects: everything here runs after the webhook has answered, and a
 * failure must not reach the recorded call or text. A sync failure is logged
 * once by the sync routine; a failed roster read is logged here.
 */

/** How long a loaded org roster answers "we have that number" without a query. */
export const ORG_NUMBER_ROSTER_TTL_MS = 10 * 60 * 1000;

interface RosterEntry {
  loadedAt: number;
  e164s: Set<string>;
}

const rosters = new Map<string, RosterEntry>();

/** Tests only: forget every cached org roster. */
export function clearOrgNumberRoster(): void {
  rosters.clear();
}

/** The E.164 form numbers are compared in, or null when there is no number. */
function toE164(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  if (!text) return null;
  const northAmerican = normalizeNAPhone(text);
  if (northAmerican) return northAmerican;
  const digits = text.replace(/\D/g, '');
  return text.startsWith('+') && digits ? `+${digits}` : null;
}

async function loadRoster(orgId: string): Promise<Set<string>> {
  const rows = await prisma.phoneNumber.findMany({
    where: { organization_id: orgId },
    select: { e164: true },
  });
  const e164s = new Set<string>();
  for (const row of rows) {
    const e164 = toE164(row.e164);
    if (e164) e164s.add(e164);
  }
  rosters.set(orgId, { loadedAt: Date.now(), e164s });
  return e164s;
}

/** Whether the org has the number stored, with at most one query (see the
 *  module header). */
async function orgHasNumber(orgId: string, e164: string): Promise<boolean> {
  const cached = rosters.get(orgId);
  if (cached && Date.now() - cached.loadedAt < ORG_NUMBER_ROSTER_TTL_MS && cached.e164s.has(e164)) {
    return true;
  }
  return (await loadRoster(orgId)).has(e164);
}

export interface UnknownNumberEvent {
  orgId: string;
  /** The org's phone-system account, from the org row - never the payload. */
  accountId: string;
  /** The tracking number the event names, in whatever form the payload has it. */
  trackingNumber: unknown;
}

/**
 * Sync the org's numbers when the event's tracking number is not stored for
 * the org. A no-op for an event that names no tracking number, a known number,
 * or a server with no phone service configured. Never rejects.
 */
export async function syncIfUnknownNumber(event: UnknownNumberEvent): Promise<void> {
  const e164 = toE164(event.trackingNumber);
  if (!e164 || !event.accountId || !isCtmConfigured()) return;
  try {
    if (await orgHasNumber(event.orgId, e164)) return;
  } catch (err) {
    logger.warn(
      `[number-sync] could not read the numbers of org ${event.orgId}; ` +
        `not checking this event's number: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  // The sync routine logs its own failures; a rejection here only means this
  // caller was still waiting when the run failed.
  // It never looks at the list, so a skipped or given-up sync reads none.
  await syncNumbers({
    orgId: event.orgId,
    accountId: event.accountId,
    trigger: 'unknown-number',
    needsNumbers: false,
  }).catch(() => undefined);
}
