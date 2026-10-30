import { Request } from 'express';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { getClientIp } from './client-ip';

export { getClientIp } from './client-ip';

export interface LogAuditParams {
  /** Authenticated request — actor + org + ip + user-agent are read from it. */
  req?: Request;
  /** Action in `resource.verb` form, e.g. 'estimate.approved', 'login.failed'. */
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Small before/after or context summary. Never dump large objects or secrets. */
  metadata?: Record<string, unknown>;
  /** Explicit org override for system/public/webhook actions (e.g. resolved from an entity). */
  orgId?: string | null;
  /** Explicit actor override; pass null for system/automated/customer actions. */
  actorId?: string | null;
  /** Explicit actor email override (denormalized — survives later user deletion). */
  actorEmail?: string | null;
}

/**
 * Re-audit N19 (L10): a refusal row (`access.denied`, `access.hidden`) is written once per minute for the same refusal: the same
 * person, refused the same thing (the route by its pattern, the record, and the switches or reason it names) in the same company. The
 * table only takes new rows (M14), so a person hammering one refused address would otherwise grow it for good, one row a try.
 * The first refusal is always written, and a different route, record, person or reason is its own refusal. Held in this
 * server's memory (no migration): with several servers, each writes the first refusal of the minute it sees. Each refusal is
 * remembered under a 44-character digest of its parts, so the memory is bounded by the key cap whatever the addresses are.
 */
const REFUSAL_ACTIONS = new Set(['access.denied', 'access.hidden']);
export const REFUSAL_REPEAT_WINDOW_MS = 60_000;
const REFUSAL_KEYS_MAX = 10_000;
const lastRefusalAt = new Map<string, number>();

/**
 * The route a refusal was on, as its pattern (`GET /api/customers/:id`), never the address as typed: a new random id in the
 * address is the same refusal (re-audit pass 2, P2-6). A refusal made by a check the whole router runs before any route matches
 * is that router's (`GET /api/roles *`). With no request to read, the address with every segment holding a digit, or longer
 * than an id's words would be, read as an id.
 */
function refusedRouteOf(req: Request | undefined, metadata: Record<string, unknown> | undefined): string {
  const method = (req?.method ?? (typeof metadata?.method === 'string' ? metadata.method : '')).toUpperCase();
  const pattern = (req as { route?: { path?: unknown } } | undefined)?.route?.path;
  // Express matches mount paths and routes whatever their letter case, and leaves req.baseUrl as the caller typed it, so the
  // route is read in lower case: `/API/Customers/:id` is the same refusal as `/api/customers/:id` (re-audit pass 3, N-p3-1).
  if (req && typeof pattern === 'string') return `${method} ${`${req.baseUrl ?? ''}${pattern}`.toLowerCase()}`;
  if (req) return `${method} ${(req.baseUrl ?? '').toLowerCase()} *`;
  const path = typeof metadata?.path === 'string' ? metadata.path.toLowerCase() : '';
  return `${method} ${path.split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? ':id' : seg)).join('/')}`;
}

function isRepeatedRefusal(orgId: string, actorId: string | null, params: LogAuditParams, now = Date.now()): boolean {
  if (!REFUSAL_ACTIONS.has(params.action)) return false;
  // The refusal's parts: the route as its pattern, and the rest of what the row records but the address as typed. Kept as a
  // fixed-size digest, never the parts themselves, so memory per refusal is bounded whatever the caller sends (N19, memory).
  const { path: _typed, ...rest } = (params.metadata ?? {}) as Record<string, unknown>;
  const key = createHash('sha256')
    .update(JSON.stringify([
      orgId, actorId, params.action, params.resourceType ?? null, params.resourceId ?? null, refusedRouteOf(params.req, params.metadata), rest,
    ]))
    .digest('base64');
  const last = lastRefusalAt.get(key);
  if (last !== undefined && now - last < REFUSAL_REPEAT_WINDOW_MS) return true;
  // Oldest first (a Map keeps insertion order): re-inserting moves the key to the end, and the oldest are dropped past the cap.
  lastRefusalAt.delete(key);
  lastRefusalAt.set(key, now);
  if (lastRefusalAt.size > REFUSAL_KEYS_MAX) {
    for (const [k, at] of lastRefusalAt) {
      if (lastRefusalAt.size <= REFUSAL_KEYS_MAX && now - at < REFUSAL_REPEAT_WINDOW_MS) break;
      lastRefusalAt.delete(k);
    }
  }
  return false;
}

/** For tests: forget every refusal seen, so a case starts with none. */
export function forgetRefusalsForTests(): void {
  lastRefusalAt.clear();
}

/** For tests: the keys the refusals seen are remembered under. */
export function refusalKeysForTests(): string[] {
  return [...lastRefusalAt.keys()];
}

/**
 * Append a row to the org-wide security/compliance audit trail.
 *
 * NON-BLOCKING + FAILURE-ISOLATED: this never throws into the caller. Call it
 * after the audited action has already succeeded (after any `$transaction`
 * resolves and the response is sent). Callers may `void logAudit(...)` without
 * awaiting; the returned promise always resolves (never rejects).
 *
 * org_id is required (the column is NOT NULL). It comes from `req.user` or the
 * explicit `orgId` override. If neither is available (e.g. a failed login on an
 * unknown email), the event is skipped with a warning rather than inserting an
 * org-less row.
 */
export async function logAudit(params: LogAuditParams): Promise<void> {
  try {
    const { req, action } = params;

    const orgId = params.orgId ?? req?.user?.organization_id ?? null;
    if (!orgId) {
      logger.warn(`logAudit skipped: no org_id for action "${action}"`);
      return;
    }

    const actorId = params.actorId !== undefined ? params.actorId : (req?.user?.id ?? null);
    const actorEmail =
      params.actorEmail !== undefined ? params.actorEmail : (req?.user?.email ?? null);

    if (isRepeatedRefusal(orgId, actorId, params)) return;

    await prisma.auditLog.create({
      data: {
        org_id: orgId,
        actor_id: actorId,
        actor_email: actorEmail,
        action,
        resource_type: params.resourceType ?? null,
        resource_id: params.resourceId ?? null,
        metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
        ip_address: req ? getClientIp(req) : null,
        user_agent: req ? (req.headers['user-agent'] ?? null) : null,
      },
    });
  } catch (err) {
    // Auditing must never take down a real user action.
    logger.error(`logAudit failed (non-fatal) for action "${params.action}":`, err);
  }
}

/**
 * Write an audit row INSIDE the caller's transaction (re-audit N23). Unlike `logAudit`, a failure throws, so the change it records
 * rolls back with it: a change that must never happen without its record (a custom role made, renamed or archived) writes its
 * row here. The actor, company, address and browser are read from the signed-in request, as `logAudit` reads them.
 */
export async function recordAuditInTx(
  tx: Prisma.TransactionClient,
  req: Request,
  params: { action: string; resourceType: string; resourceId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      org_id: req.user!.organization_id,
      actor_id: req.user!.id,
      actor_email: req.user!.email ?? null,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId,
      metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
      ip_address: getClientIp(req),
      user_agent: req.headers['user-agent'] ?? null,
    },
  });
}

/**
 * Best-effort settings audit. Writes a TimelineEvent row scoped to the org.
 * Never throws — auditing must not break a settings mutation.
 */
export async function writeSettingsAudit(
  req: Request,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const orgId = req.user!.organization_id;
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'OrganizationSettings',
        entity_id: orgId,
        event_type: eventType,
        description: `Settings change: ${eventType}`,
        metadata: metadata as object,
        created_by: req.user!.id,
      },
    });
  } catch (err) {
    logger.error('writeSettingsAudit failed (non-fatal):', err);
  }
}
