import { Request, Response } from 'express';
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
export async function list(req: Request, res: Response) {
  const me = req.user!.id;
  const tenant = tenantWhere(req);
  const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, 100);
  const cursorParam = req.query.cursor as string | undefined;
  const needsAction = req.query.needs_action === 'true';

  // Build the cursor OR condition if a cursor is provided
  type CursorOr = Array<{ created_at: { lt: Date } } | { created_at: Date; id: { lt: string } }>;
  let cursorOr: CursorOr | undefined;
  if (cursorParam) {
    const decoded = decodeCursor(cursorParam);
    if (decoded) {
      cursorOr = [
        { created_at: { lt: decoded.createdAt } },
        { created_at: decoded.createdAt, id: { lt: decoded.id } },
      ];
    }
  }

  const rows = await prisma.notificationRecipient.findMany({
    where: {
      recipient_id: me,
      ...tenant,
      dismissed_at: null,
      ...(needsAction ? { needs_action: true, acted_at: null } : {}),
      ...(cursorOr ? { OR: cursorOr } : {}),
    },
    include: { notification: true },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const nextCursor =
    hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null;

  res.json({ items: page.map(toView), nextCursor });
}

/**
 * GET /api/notifications/unread-count
 * Returns { unseen, needs_action } counts for the caller.
 */
export async function unreadCount(req: Request, res: Response) {
  const me = req.user!.id;
  const tenant = tenantWhere(req);

  const unseen = await prisma.notificationRecipient.count({
    where: { recipient_id: me, ...tenant, dismissed_at: null, seen_at: null },
  });

  const needs_action = await prisma.notificationRecipient.count({
    where: { recipient_id: me, ...tenant, dismissed_at: null, needs_action: true, acted_at: null },
  });

  res.json({ unseen, needs_action });
}

/**
 * PATCH /api/notifications/seen
 * Stamps seen_at on all (or a subset of) the caller's unseen rows.
 */
export async function markSeen(req: Request, res: Response) {
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
}

/**
 * POST /api/notifications/read-all
 * Watermark: stamps read_at on all of the caller's unread rows.
 */
export async function readAll(req: Request, res: Response) {
  const me = req.user!.id;
  const tenant = tenantWhere(req);

  const result = await prisma.notificationRecipient.updateMany({
    where: { recipient_id: me, ...tenant, dismissed_at: null, read_at: null },
    data: { read_at: new Date() },
  });

  res.json({ count: result.count });
}

/**
 * PATCH /api/notifications/:id/read
 * Stamps read_at on a single recipient row the caller owns.
 */
export async function markRead(req: Request, res: Response) {
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
}

/**
 * PATCH /api/notifications/:id/act
 * Stamps acted_at (and read_at) on a single recipient row the caller owns.
 * Acting implies read + done — persists the "✓ done" state for inline actions.
 */
export async function act(req: Request, res: Response) {
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
}

/**
 * PATCH /api/notifications/:id/dismiss
 * Stamps dismissed_at on a single recipient row the caller owns.
 */
export async function dismiss(req: Request, res: Response) {
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
}
