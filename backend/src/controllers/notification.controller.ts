import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';

// ─── Keyset cursor encoding ────────────────────────────────────────────────

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return { createdAt: new Date(raw.createdAt), id: raw.id };
  } catch {
    return null;
  }
}

// ─── View mapping ─────────────────────────────────────────────────────────

function toView(row: {
  id: string;
  priority: string;
  needs_action: boolean;
  seen_at: Date | null;
  read_at: Date | null;
  acted_at: Date | null;
  created_at: Date;
  notification: {
    verb: string;
    category: string;
    title: string;
    body: string | null;
    object_type: string;
    object_id: string;
    object_label: string | null;
    action_type: string | null;
    data: unknown;
  };
}) {
  const n = row.notification;
  return {
    id: row.id,
    verb: n.verb,
    category: n.category,
    title: n.title,
    body: n.body,
    object_type: n.object_type,
    object_id: n.object_id,
    object_label: n.object_label,
    action_type: n.action_type,
    data: n.data,
    // priority and needs_action come from the RECIPIENT row (per-recipient, not from the event)
    priority: row.priority,
    needs_action: row.needs_action,
    created_at: row.created_at,
    seen_at: row.seen_at,
    read_at: row.read_at,
    acted_at: row.acted_at,
  };
}

// ─── Schemas ──────────────────────────────────────────────────────────────

export const seenSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
});

// ─── Handlers ─────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;

/**
 * GET /api/notifications
 * Keyset-paginated list of the caller's non-dismissed notification rows.
 */
export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);
    const isAll = req.query.limit === 'all' || req.query.all === 'true';
    const limit = isAll ? undefined : Math.min(Number(req.query.limit) || DEFAULT_LIMIT, 100);
    const cursorParam = req.query.cursor as string | undefined;
    const needsAction = req.query.needs_action === 'true';
    const verb = typeof req.query.verb === 'string' && req.query.verb.trim() ? req.query.verb.trim() : undefined;
    const unreadOnly = req.query.unread === 'true';

    // Build the cursor OR condition if a cursor is provided
    type CursorOr = Array<{ created_at: { lt: Date } } | { created_at: Date; id: { lt: string } }>;
    let cursorOr: CursorOr | undefined;
    if (cursorParam && !isAll) {
      const decoded = decodeCursor(cursorParam);
      if (decoded) {
        cursorOr = [
          { created_at: { lt: decoded.createdAt } },
          { created_at: decoded.createdAt, id: { lt: decoded.id } },
        ];
      }
    }

    let rows = await prisma.notificationRecipient.findMany({
      where: {
        recipient_id: me,
        ...tenant,
        dismissed_at: null,
        ...(unreadOnly ? { read_at: null } : {}),
        ...(verb ? { notification: { verb } } : {}),
        ...(needsAction ? { needs_action: true, acted_at: null } : {}),
        ...(cursorOr ? { OR: cursorOr } : {}),
      },
      include: { notification: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      ...(limit !== undefined ? { take: limit + 1 } : {}),
    });

    // Stale Spider alert cleanup: Mark notifications as read if lead has moved past the stage
    const unreadSpiderRows = rows.filter(
      (r) => r.read_at === null && r.notification.verb === 'spider.alert'
    );

    if (unreadSpiderRows.length > 0) {
      const leadIds = Array.from(
        new Set(
          unreadSpiderRows
            .map((r) => {
              const data = (r.notification.data || {}) as Record<string, any>;
              return (
                (data.lead_id as string) ||
                (data.leadId as string) ||
                (r.notification.object_type === 'LEAD' ? r.notification.object_id : null)
              );
            })
            .filter(Boolean) as string[]
        )
      );

      if (leadIds.length > 0) {
        const leads = await prisma.lead.findMany({
          where: { id: { in: leadIds }, ...tenant },
          select: {
            id: true,
            status: true,
            contacted_at: true,
            walkthrough_first_booked_at: true,
            first_estimate_sent_at: true,
          },
        });

        const leadMap = new Map(leads.map((l) => [l.id, l]));
        const staleRecipientIds: string[] = [];
        const now = new Date();

        for (const row of unreadSpiderRows) {
          const data = (row.notification.data || {}) as Record<string, any>;
          const leadId =
            (data.lead_id as string) ||
            (data.leadId as string) ||
            (row.notification.object_type === 'LEAD' ? row.notification.object_id : null);
          const stageName = (
            (data.stage_name as string) ||
            (data.leadStage as string) ||
            (data.stageId as string) ||
            ''
          ).toLowerCase().trim();

          if (leadId && leadMap.has(leadId)) {
            const lead = leadMap.get(leadId)!;
            const status = (lead.status || '').toUpperCase().trim();
            let isStale = false;

            // 1. Notification = New: lead is contacted or later
            if (stageName === 'new' || stageName.includes('new') || stageName === 'lead_new') {
              if (
                lead.contacted_at !== null ||
                status === 'CONTACTED' ||
                status === 'WALKTHROUGH_SCHEDULED' ||
                status === 'WALKTHROUGH_COMPLETED' ||
                status === 'ESTIMATED' ||
                status === 'WON' ||
                status === 'LOST'
              ) {
                isStale = true;
              }
            }
            // 2. Notification = Contacted: lead is walkthrough scheduled or later
            else if (stageName === 'contacted' || stageName.includes('contacted') || stageName === 'lead_contacted') {
              if (
                lead.walkthrough_first_booked_at !== null ||
                status === 'WALKTHROUGH_SCHEDULED' ||
                status === 'WALKTHROUGH_COMPLETED' ||
                status === 'ESTIMATED' ||
                status === 'WON'
              ) {
                isStale = true;
              }
            }
            // 3. Notification = Walkthrough Completed: lead is estimated or won
            else if (
              stageName === 'walkthrough completed' ||
              stageName.includes('walkthrough completed') ||
              stageName === 'lead_walkthrough_completed'
            ) {
              if (
                lead.first_estimate_sent_at !== null ||
                status === 'ESTIMATED' ||
                status === 'WON'
              ) {
                isStale = true;
              }
            }

            if (isStale) {
              staleRecipientIds.push(row.id);
              row.read_at = now;
            }
          }
        }

        if (staleRecipientIds.length > 0) {
          await prisma.notificationRecipient.updateMany({
            where: { id: { in: staleRecipientIds }, recipient_id: me, ...tenant },
            data: { read_at: now },
          });

          if (unreadOnly) {
            rows = rows.filter((r) => r.read_at === null);
          }
        }
      }
    }

    const hasMore = limit !== undefined && rows.length > limit;
    const page = hasMore && limit !== undefined ? rows.slice(0, limit) : rows;

    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
        : null;

    res.json({ items: page.map(toView), nextCursor });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/notifications/unread-count
 * Returns { unseen, needs_action } counts for the caller.
 */
export async function unreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);

    const unseen = await prisma.notificationRecipient.count({
      where: { recipient_id: me, ...tenant, dismissed_at: null, seen_at: null },
    });

    const needs_action = await prisma.notificationRecipient.count({
      where: { recipient_id: me, ...tenant, dismissed_at: null, needs_action: true, acted_at: null },
    });

    res.json({ unseen, needs_action });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/seen
 * Stamps seen_at on all (or a subset of) the caller's unseen rows.
 */
export async function markSeen(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);
    const { ids } = req.body as z.infer<typeof seenSchema>;

    const result = await prisma.notificationRecipient.updateMany({
      where: {
        recipient_id: me,
        ...tenant,
        dismissed_at: null,
        seen_at: null,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      },
      data: { seen_at: new Date() },
    });

    res.json({ count: result.count });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notifications/read-all
 * Watermark: stamps read_at on all of the caller's unread rows.
 */
export async function readAll(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);

    const result = await prisma.notificationRecipient.updateMany({
      where: { recipient_id: me, ...tenant, dismissed_at: null, read_at: null },
      data: { read_at: new Date() },
    });

    res.json({ count: result.count });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/:id/read
 * Stamps read_at on a single recipient row the caller owns.
 */
export async function markRead(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);
    const id = req.params.id as string;

    const result = await prisma.notificationRecipient.updateMany({
      where: { id, recipient_id: me, ...tenant },
      data: { read_at: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/:id/act
 * Stamps acted_at (and read_at) on a single recipient row the caller owns.
 * Acting implies read + done — persists the "✓ done" state for inline actions.
 */
export async function act(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);
    const id = req.params.id as string;
    const now = new Date();

    const result = await prisma.notificationRecipient.updateMany({
      where: { id, recipient_id: me, ...tenant },
      data: { acted_at: now, read_at: now },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/notifications/:id/dismiss
 * Stamps dismissed_at on a single recipient row the caller owns.
 */
export async function dismiss(req: Request, res: Response, next: NextFunction) {
  try {
    const me = req.user!.id;
    const tenant = tenantWhere(req);
    const id = req.params.id as string;

    const result = await prisma.notificationRecipient.updateMany({
      where: { id, recipient_id: me, ...tenant },
      data: { dismissed_at: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
