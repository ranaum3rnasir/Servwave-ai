import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Resolve the real client IP behind Cloudflare → Render.
 *
 * Order: Cloudflare's authoritative `CF-Connecting-IP` (set by the edge, cannot
 * be spoofed by the client) → Express `req.ip` (already applies `trust proxy: 1`
 * to X-Forwarded-For) → the first XFF hop → the raw socket address.
 */
export function getClientIp(req: Request): string | null {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  if (req.ip) return req.ip;

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();

  return req.socket?.remoteAddress ?? null;
}

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
