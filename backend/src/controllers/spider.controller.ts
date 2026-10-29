/**
 * Spider lead watcher endpoints (#2619), mounted under /api/ai-farm/spider behind the Spider gate
 * (middleware/requireSpider.ts). Settings, History and switching Spider on or off are Admin-only;
 * reading the on/off status and the unread-alerts list are open to every role.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { validationFailure } from '../middleware/validate';
import { LEAD_STATUS_LABEL } from '../services/lead-stage.service';
import {
  customerName,
  isSpiderSetUp,
  readChannels,
  settingsOptions,
  settingsView,
  SPIDER_OFF_SETTINGS_MESSAGE,
  type SetSpiderActiveBody,
  type UpdateSpiderSettingsBody,
} from '../services/spider/config';
import { SPIDER_ALERT_VERB } from '../services/spider/sweep';

export { setSpiderActiveSchema, updateSpiderSettingsSchema } from '../services/spider/config';

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Whether Spider is switched on for the caller's company, and whether it has been set up (at least
 * one watched status with a time limit), for the AI Agentic Farm's card and pop-up, which every
 * role sees. Only those two answers, never the rest of the settings: both false when there is no
 * row yet.
 */
export async function getSpiderStatus(req: Request, res: Response) {
  try {
    const row = await prisma.spiderSettings.findFirst({
      where: tenantWhere(req),
      select: { is_active: true, status_limits: true },
    });
    res.json({ isActive: row?.is_active === true, isSetUp: isSpiderSetUp(row) });
  } catch (err) {
    logger.error(`[spider] status read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider status' });
  }
}

/**
 * Switches Spider on or off from the AI Agentic Farm (Admin only), set up or not (Ran, 14 Oct: the
 * switch says whether Spider is applied; it watches nothing until a status is switched on, and the
 * settings save restarts its clock when the first one is). Only `is_active` and `activated_at`
 * change: the statuses, limits, channels, recipients and leads are kept as they are, so switching
 * back on picks up exactly where the company left off.
 *
 * Switching on from off moves `activated_at` to now, as the settings save does, so time in a status
 * never counts from before Spider was on. Switching on a company with no row creates one with the
 * default settings. Saving the state it already has changes nothing, and switching off a company
 * with no row creates none.
 */
export async function setSpiderActive(req: Request, res: Response) {
  const where = tenantWhere(req);
  const orgId = req.user!.organization_id;
  const { isActive } = req.body as SetSpiderActiveBody;
  try {
    const row = await prisma.spiderSettings.findFirst({ where, select: { is_active: true, status_limits: true } });
    if (!row) {
      if (!isActive) {
        res.json({ isActive: false, isSetUp: false });
        return;
      }
      // The settings take their column defaults, which read as the default settings (every status
      // off). skipDuplicates: when another Admin's switch created the row a moment earlier this
      // inserts nothing, and the conditional write below switches that row instead.
      await prisma.spiderSettings.createMany({
        data: [{ organization_id: orgId, is_active: true, activated_at: new Date() }],
        skipDuplicates: true,
      });
    }
    if (!row || row.is_active !== isActive) {
      // Conditional on the stored flag, so two Admins switching on at once move activated_at once.
      await prisma.spiderSettings.updateMany({
        where: { ...where, is_active: !isActive },
        data: isActive ? { is_active: true, activated_at: new Date() } : { is_active: false },
      });
    }
    res.json({ isActive, isSetUp: isSpiderSetUp(row) });
  } catch (err) {
    logger.error(`[spider] switch save failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not switch Spider on or off' });
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Number and customer for each selected lead, so the screen can name them without another call. */
async function selectedLeadLabels(orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const leads = await prisma.lead.findMany({
    where: { organization_id: orgId, id: { in: ids } },
    select: { id: true, lead_number: true, customer: { select: { first_name: true, last_name: true, company_name: true } } },
    orderBy: { lead_number: 'asc' },
  });
  return leads.map((l) => ({
    id: l.id,
    lead_number: l.lead_number,
    customer_name: customerName(l.customer),
  }));
}

export async function getSpiderSettings(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  try {
    const row = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
    const settings = settingsView(row);
    res.json({ settings, selected_leads: await selectedLeadLabels(orgId, settings.selected_lead_ids), options: settingsOptions() });
  } catch (err) {
    logger.error(`[spider] settings read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider settings' });
  }
}

/**
 * Saves Spider's settings (Admin only), only while Spider is on: its settings open only while it is
 * on (Ran, 14 Oct), so a save while it is off - or with no settings row, which is off - is refused
 * with 409 and stores nothing. The save never changes the switch: `is_active` in the body is
 * ignored, PUT /spider/status is the only way to turn Spider on or off.
 *
 * The burst guard: a save that gives an on Spider its first watched status moves `activated_at` to
 * now. Until then Spider watched nothing, so leads that sat in a status all that time must not all
 * alert at once on the next sweep.
 */
export async function updateSpiderSettings(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const body = req.body as UpdateSpiderSettingsBody;
  const refuseWhileOff = () => res.status(409).json({ error: SPIDER_OFF_SETTINGS_MESSAGE });
  try {
    const existing = await prisma.spiderSettings.findUnique({
      where: { organization_id: orgId },
      select: { is_active: true, status_limits: true },
    });
    if (!existing?.is_active) {
      refuseWhileOff();
      return;
    }
    // Only this company's people and leads can be stored: anything else in the body is dropped.
    const [users, leads] = await Promise.all([
      body.recipients.user_ids.length
        ? prisma.user.findMany({ where: { organization_id: orgId, id: { in: body.recipients.user_ids } }, select: { id: true } })
        : Promise.resolve([]),
      body.selected_lead_ids.length
        ? prisma.lead.findMany({ where: { organization_id: orgId, id: { in: body.selected_lead_ids } }, select: { id: true } })
        : Promise.resolve([]),
    ]);
    const knownUsers = new Set(users.map((u) => u.id));
    const knownLeads = new Set(leads.map((l) => l.id));

    const firstStatus = !isSpiderSetUp(existing) && Object.values(body.status_limits).some((l) => l.enabled);
    // Conditional on Spider still being on, so a save racing a switch-off stores nothing.
    const { count } = await prisma.spiderSettings.updateMany({
      where: { organization_id: orgId, is_active: true },
      data: {
        status_limits: body.status_limits,
        channels: body.channels,
        recipients: {
          roles: [...new Set(body.recipients.roles)],
          user_ids: body.recipients.user_ids.filter((id) => knownUsers.has(id)),
          lead_owner: body.recipients.lead_owner,
        },
        watch_all_leads: body.watch_all_leads,
        selected_lead_ids: body.selected_lead_ids.filter((id) => knownLeads.has(id)),
        ...(firstStatus ? { activated_at: new Date() } : {}),
      },
    });
    if (count === 0) {
      refuseWhileOff();
      return;
    }
    const row = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
    const settings = settingsView(row);
    res.json({ settings, selected_leads: await selectedLeadLabels(orgId, settings.selected_lead_ids), options: settingsOptions() });
  } catch (err) {
    logger.error(`[spider] settings save failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not save Spider settings' });
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export const HISTORY_MAX_PAGE_SIZE = 100;

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // A larger page size is clamped to the maximum, not refused.
  page_size: z.coerce.number().int().min(1).default(25).transform((n) => Math.min(n, HISTORY_MAX_PAGE_SIZE)),
});

interface StoredChannel {
  outcome?: unknown;
  recipients?: { user_id?: unknown; outcome?: unknown }[];
}

/**
 * Every alert Spider raised for this company, newest first. Only what the History tab shows:
 * names, never an email address or phone number. Kept when Spider is switched off.
 */
export async function getSpiderHistory(req: Request, res: Response) {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json(validationFailure(parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message }))));
    return;
  }
  const { page, page_size } = parsed.data;
  const where = tenantWhere(req);
  try {
    const [total, rows] = await Promise.all([
      prisma.spiderAlert.count({ where }),
      prisma.spiderAlert.findMany({
        where,
        orderBy: [{ alerted_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * page_size,
        take: page_size,
        select: {
          id: true,
          lead_id: true,
          status: true,
          entered_status_at: true,
          alerted_at: true,
          limit_value: true,
          limit_unit: true,
          recipient_ids: true,
          delivery: true,
          lead: {
            select: {
              lead_number: true,
              customer: { select: { first_name: true, last_name: true, company_name: true } },
            },
          },
        },
      }),
    ]);

    const userIds = [...new Set(rows.flatMap((r) => r.recipient_ids))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { ...where, id: { in: userIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim() || 'Team member']));

    const channel = (delivery: unknown, key: string): StoredChannel => {
      const d = delivery && typeof delivery === 'object' ? (delivery as Record<string, unknown>)[key] : null;
      return d && typeof d === 'object' ? (d as StoredChannel) : {};
    };
    const outcomeOf = (c: StoredChannel) => (typeof c.outcome === 'string' ? c.outcome : null);
    const perPerson = (c: StoredChannel, userId: string) => {
      const hit = c.recipients?.find((r) => r.user_id === userId);
      return typeof hit?.outcome === 'string' ? hit.outcome : null;
    };

    const items = rows.map((r) => {
      const email = channel(r.delivery, 'email');
      const text = channel(r.delivery, 'text');
      return {
        id: r.id,
        lead_id: r.lead_id,
        lead_number: r.lead.lead_number,
        customer_name: customerName(r.lead.customer),
        status: r.status,
        status_label: LEAD_STATUS_LABEL[r.status],
        entered_status_at: r.entered_status_at.toISOString(),
        alerted_at: r.alerted_at.toISOString(),
        limit: { value: r.limit_value, unit: r.limit_unit },
        channels: {
          in_app: outcomeOf(channel(r.delivery, 'in_app')),
          email: outcomeOf(email),
          text: outcomeOf(text),
        },
        recipients: r.recipient_ids.map((id) => ({
          name: nameOf.get(id) ?? 'Former team member',
          email_outcome: perPerson(email, id),
          text_outcome: perPerson(text, id),
        })),
      };
    });
    res.json({ items, page, page_size, total, total_pages: Math.max(1, Math.ceil(total / page_size)) });
  } catch (err) {
    logger.error(`[spider] history read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider history' });
  }
}

// ─── The caller's unread alerts ──────────────────────────────────────────────

export const UNREAD_ALERTS_LIMIT = 50;

const CARD_FIELDS = [
  'lead_id',
  'lead_number',
  'customer_name',
  'status',
  'status_label',
  'address',
  'owner_name',
  'entered_status_at',
  'counted_from',
  'time_in_status',
] as const;

/**
 * The signed-in person's own unread Spider alerts - a small, bounded list for the popup cards
 * and the red frame - plus whether the company's red-frame channel is on. The shared
 * notifications endpoint is left as it is. `id` is the notification-recipient id, which the
 * existing PATCH /api/notifications/:id/read marks read.
 */
export async function getMyUnreadSpiderAlerts(req: Request, res: Response) {
  const user = req.user!;
  try {
    const [rows, settings] = await Promise.all([
      prisma.notificationRecipient.findMany({
        where: {
          organization_id: user.organization_id,
          recipient_id: user.id,
          read_at: null,
          dismissed_at: null,
          notification: { verb: SPIDER_ALERT_VERB },
        },
        orderBy: { created_at: 'desc' },
        take: UNREAD_ALERTS_LIMIT,
        select: { id: true, created_at: true, notification: { select: { object_id: true, data: true } } },
      }),
      prisma.spiderSettings.findUnique({ where: { organization_id: user.organization_id }, select: { channels: true } }),
    ]);
    const alerts = rows.map((r) => {
      const data = (r.notification.data ?? {}) as Record<string, unknown>;
      const card: Record<string, unknown> = {};
      for (const k of CARD_FIELDS) card[k] = data[k] ?? null;
      return { id: r.id, created_at: r.created_at.toISOString(), ...card, lead_id: r.notification.object_id };
    });
    // The frame marks an unread in-app alert, so it needs the in-app channel too.
    const channels = settings ? readChannels(settings.channels) : null;
    res.json({ alerts, red_frame: !!channels && channels.red_frame && channels.in_app });
  } catch (err) {
    logger.error(`[spider] unread alerts read failed for org ${user.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider alerts' });
  }
}
