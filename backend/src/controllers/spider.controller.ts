/**
 * Spider lead watcher endpoints (#2619), mounted under /api/ai-farm/spider behind the Spider gate
 * (middleware/requireSpider.ts). Settings, History, switching Spider on or off and the company-wide
 * starting summary are Admin-only; reading the on/off status, the unread-alerts list and one's own
 * starting summary are open to every role.
 */
import type { Request, Response } from 'express';
import { Prisma, type Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { validationFailure, zodValidationFailure } from '../middleware/validate';
import {
  customerName,
  hasRecipient,
  isSpiderSetUp,
  isWatchedStatus,
  readChannels,
  settingsOptions,
  settingsView,
  SPIDER_ACTIVATE_NEEDS_LIMIT_MESSAGE,
  SPIDER_SAVE_RACED_MESSAGE,
  SPIDER_STALE_PAGE_MESSAGE,
  SPIDER_ACTIVATE_RACED_MESSAGE,
  SPIDER_ACTIVATE_FAILED_MESSAGE,
  SPIDER_DEACTIVATE_FAILED_MESSAGE,
  SPIDER_REQUIRED_MESSAGES,
  type SetSpiderActiveBody,
  type SpiderStatus,
  type UpdateSpiderSettingsBody,
} from '../services/spider/config';
import {
  skippedStayKey,
  watchedVisits,
  SPIDER_ALERT_VERB,
  alertedVisitOf,
  currentVisitsByLead,
  endOpenSpiderRecords,
  alertStillOpen,
  excludedAmong,
  openAlertRulesOf,
} from '../services/spider/sweep';
import {
  HISTORY_EXPORT_MAX,
  HISTORY_ROW_SELECT,
  historyFiltersSchema,
  historyItem,
  historyQuerySchema,
  historySummarySchema,
  historyWhere,
  SUMMARY_NOT_BUILDING,
  storedRecipients,
  type HistoryRow,
} from '../services/spider/history';
import { SPIDER_STAGE_NAME } from '../services/spider/messages';
import { spiderActivationPreview } from '../services/spider/activationPreview';
import { mergeTriggerKind, readSpiderSummary, settingsTriggerKind } from '../services/spider/summary';
import type { SpiderTriggerKind } from '../services/spider/summaryMessages';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { SPIDER_FRAME_VERB } from '../services/notifications/bellHiddenVerbs';

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
 * Activate or Deactivate Spider (Admin only; #3431). Spider works like an integration (Ran, 10 Nov): being on the
 * company's account (the Spider gate) and running are two facts, and running starts only here. Of the settings, only
 * `is_active`, `activated_at` and the starting trigger change: the stages, limits, channels, recipients and leads are
 * kept as they are, so activating again picks up exactly where the company left off.
 *
 * Activate is refused with 409, changing nothing, while no status has a time limit switched on (no settings row counts
 * as none). Activating from Not active moves `activated_at` to now, which starts a new active period, and records the
 * SWITCHED_ON starting trigger (#2794) for `startingSummary: 'send'` or when it is left out: the leads already past
 * their limit, including those that went overdue while Spider was not active and those alerted in an earlier period
 * (D5), arrive as one starting summary per person instead of one alert each. `startingSummary: 'skip'` records no trigger
 * and remembers the stays already past their limit at that moment (`backlog_skipped_stays`, Ran 10 Nov): those are never
 * reported, and everything else alerts as normal, including a stay that goes past its limit later for any reason (time, a
 * shortened limit, a status switched on, a lead included again). Activating while Active changes nothing.
 *
 * Deactivate works at once: it also ends every open Spider alert of the company, for everyone who got it (Ran, 20 Oct,
 * D4); Spider History keeps the record. Deactivating when already Not active ends anything still open and changes
 * nothing else, and deactivating a company with no row creates none.
 */
export async function setSpiderActive(req: Request, res: Response) {
  const where = tenantWhere(req);
  const orgId = req.user!.organization_id;
  const { isActive, startingSummary = 'send' } = req.body as SetSpiderActiveBody;
  try {
    // Activate is checked and written against the same stored settings: the write is conditional on them, so a save
    // landing in between (a limit changed, leads excluded) is answered 409 at once. It is never read again and activated
    // on settings the review did not show (Ran, 10 Nov: activation only after the review).
    const row = await prisma.spiderSettings.findFirst({ where });
    if (isActive && !isSpiderSetUp(row)) {
      res.status(409).json({ error: SPIDER_ACTIVATE_NEEDS_LIMIT_MESSAGE });
      return;
    }
    if (!row || row.is_active === isActive) {
      // Already in the asked state (or Deactivate with no row): nothing to write. Deactivate still ends anything open.
      if (row && !isActive) await endOpenAlertsOnSwitchOff(orgId);
      res.json({ isActive, isSetUp: isSpiderSetUp(row) });
      return;
    }
    if (!isActive) {
      await prisma.spiderSettings.updateMany({ where: { ...where, is_active: true }, data: { is_active: false } });
      // Never in one transaction with the write above: a sweep alerting at this moment re-checks the
      // switch after writing its alert rows (sweep.ts stillOn), so the flag must be committed before
      // this clear starts, or an alert written in between could stay open.
      await endOpenAlertsOnSwitchOff(orgId);
      res.json({ isActive, isSetUp: isSpiderSetUp(row) });
      return;
    }
    const now = new Date();
    // Send starts a fresh wait for the summary (a trigger left from before Spider was deactivated is folded into it)
    // and forgets any earlier skip. Skip records no trigger, drops any left over, and remembers exactly the stays past
    // their limit now, by the sweep's own rule (sweep.ts watchedVisits), so only those are never reported.
    const activate =
      startingSummary === 'skip'
        ? {
            summary_trigger_at: null, summary_trigger_kind: null, summary_trigger_since: null, backlog_skipped_at: now,
            backlog_skipped_stays: (await watchedVisits(orgId, { ...row, backlog_skipped_stays: [] }, now, now)).overdue.map(skippedStayKey),
          }
        : { summary_trigger_at: now, summary_trigger_kind: 'SWITCHED_ON', summary_trigger_since: now, backlog_skipped_at: null, backlog_skipped_stays: [] };
    const { count } = await prisma.spiderSettings.updateMany({
      where: {
        ...where,
        is_active: false,
        status_limits: { equals: row.status_limits as Prisma.InputJsonValue },
        excluded_lead_ids: { equals: row.excluded_lead_ids },
      },
      data: { is_active: true, activated_at: now, ...activate },
    });
    if (count === 1) {
      res.json({ isActive, isSetUp: true });
      return;
    }
    // Nothing written. Another Admin's Activate landing first is no change to the settings: Spider is Active, as asked.
    const after = await prisma.spiderSettings.findFirst({ where, select: { is_active: true, status_limits: true } });
    if (after?.is_active === true) {
      res.json({ isActive: true, isSetUp: isSpiderSetUp(after) });
      return;
    }
    // A change that left no time limit on keeps its own, plainer reason (still 409, still nothing written).
    if (!isSpiderSetUp(after)) {
      res.status(409).json({ error: SPIDER_ACTIVATE_NEEDS_LIMIT_MESSAGE });
      return;
    }
    res.status(409).json({ error: SPIDER_ACTIVATE_RACED_MESSAGE });
  } catch (err) {
    logger.error(`[spider] switch save failed for org ${req.user!.organization_id}`, err);
    // Ran, 10 Nov: named by what was tried, the request's own target state.
    res.status(500).json({ error: isActive ? SPIDER_ACTIVATE_FAILED_MESSAGE : SPIDER_DEACTIVATE_FAILED_MESSAGE });
  }
}

/**
 * The numbers the Activate review shows (#3431, Admin only): open leads Spider would watch, leads excluded, how many are
 * already past their limit and how many people the starting summary would reach. Counts only, for the caller's company.
 */
export async function getSpiderActivationPreview(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  try {
    res.json(await spiderActivationPreview(orgId));
  } catch (err) {
    logger.error(`[spider] activation preview failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load the Spider review' });
  }
}

/**
 * Spider is already off when this runs, so a failure here never fails the switch: the unread list
 * shows nothing while off, and the next sweep ends what is left (sweep.ts sweepCompany).
 */
async function endOpenAlertsOnSwitchOff(orgId: string): Promise<void> {
  try {
    await endOpenSpiderRecords(orgId, new Date());
  } catch (err) {
    logger.error(`[spider] could not end open alerts on switch-off for org ${orgId}: ${err instanceof Error ? err.name : 'unknown error'}`);
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSpiderSettings(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  try {
    // The leads Spider watches are not part of the settings (#3436): the picker reads them a page at a time.
    const row = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
    res.json({ settings: settingsView(row), options: settingsOptions() });
  } catch (err) {
    logger.error(`[spider] settings read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider settings' });
  }
}

/**
 * A save's starting trigger. One still waiting is folded into it (still one summary), and keeps the
 * moment it first started waiting, which bounds the wait however many saves follow.
 */
export function triggerData(
  existing: { summary_trigger_at: Date | null; summary_trigger_kind: string | null; summary_trigger_since: Date | null },
  kind: SpiderTriggerKind,
  now: Date,
) {
  const waiting = existing.summary_trigger_at !== null;
  return {
    summary_trigger_at: now,
    summary_trigger_kind: mergeTriggerKind(waiting ? existing.summary_trigger_kind : null, kind),
    summary_trigger_since: waiting ? (existing.summary_trigger_since ?? existing.summary_trigger_at) : now,
  };
}

/**
 * Saves Spider's settings (Admin only), Active or Not active (#3431: like an integration, Spider is set up before it
 * runs). The save never changes Active / Not active: `is_active` in the body is ignored, PUT /spider/status is the only
 * way to activate or deactivate. A company with no settings row gets one, Not active.
 *
 * While Not active a save stores the settings and starts nothing: it records no starting trigger, and the sweep sends
 * nothing for the company. Activate records the trigger.
 *
 * While Active, a save that starts watching something new - a stage switched on, a limit shortened - records a starting
 * trigger (#2794), so the leads already past their limit arrive as one starting summary per
 * person rather than one alert each. A save that only narrows what is watched, or changes recipients or channels,
 * records none. It never moves `activated_at`.
 *
 * The write is conditional on the Active / Not active state the save read: if Spider was activated or deactivated in
 * between, the save stores nothing and answers 409, since that state decides whether it records a trigger.
 *
 * A save from a screen older than #3436 (it still sends `watch_all_leads` / `selected_lead_ids`) stores nothing and
 * answers 409 with SPIDER_STALE_PAGE_MESSAGE: the lead choices it carries no longer apply, so it must not say "Saved".
 */
export async function updateSpiderSettings(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const body = req.body as UpdateSpiderSettingsBody;
  // A screen from before #3436 still sends its lead selection: refused before anything is read or stored, so it never
  // says "Saved" for lead choices that no longer apply.
  if (body.watch_all_leads !== undefined || body.selected_lead_ids !== undefined) {
    res.status(409).json({ error: SPIDER_STALE_PAGE_MESSAGE });
    return;
  }
  try {
    const select = {
      is_active: true,
      status_limits: true,
      excluded_lead_ids: true,
      summary_trigger_at: true,
      summary_trigger_kind: true,
      summary_trigger_since: true,
    } as const;
    // Only this company's people and leads can be stored: anything else in the body is dropped.
    const users = body.recipients.user_ids.length
      ? await prisma.user.findMany({ where: { organization_id: orgId, id: { in: body.recipients.user_ids } }, select: { id: true } })
      : [];
    const knownUsers = new Set(users.map((u) => u.id));
    const recipients = {
      roles: [...new Set(body.recipients.roles)],
      user_ids: body.recipients.user_ids.filter((id) => knownUsers.has(id)),
      lead_owner: body.recipients.lead_owner,
    };
    // Only another company's people chosen: nobody would be stored, so the required check fails.
    if (!hasRecipient(recipients)) {
      res.status(400).json(validationFailure([{ field: 'recipients', message: SPIDER_REQUIRED_MESSAGES.recipient }]));
      return;
    }

    // The first save of a company that never set Spider up makes its row, Not active (skipDuplicates: when another
    // Admin's save created it a moment earlier this inserts nothing).
    let existing = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId }, select });
    if (!existing) {
      await prisma.spiderSettings.createMany({ data: [{ organization_id: orgId }], skipDuplicates: true });
      existing = await prisma.spiderSettings.findUniqueOrThrow({ where: { organization_id: orgId }, select });
    }

    // The exclusion list is never written here (#3436): only PATCH /spider/exclusions changes it, so a save never undoes
    // an exclusion saved meanwhile (an older screen that sends its lead selection was refused above).
    // Not active: no trigger, whatever the save widens. Activate records one.
    const trigger = existing.is_active
      ? settingsTriggerKind(existing, {
          status_limits: body.status_limits as Prisma.JsonValue,
          excluded_lead_ids: existing.excluded_lead_ids,
        })
      : null;
    const { count } = await prisma.spiderSettings.updateMany({
      where: { organization_id: orgId, is_active: existing.is_active },
      data: {
        status_limits: body.status_limits,
        channels: body.channels,
        recipients,
        ...(trigger ? triggerData(existing, trigger, new Date()) : {}),
      },
    });
    if (count === 0) {
      res.status(409).json({ error: SPIDER_SAVE_RACED_MESSAGE });
      return;
    }
    const row = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
    res.json({ settings: settingsView(row), options: settingsOptions() });
  } catch (err) {
    logger.error(`[spider] settings save failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not save Spider settings' });
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export { HISTORY_MAX_PAGE_SIZE } from '../services/spider/history';

/**
 * The toolbar's parameters: the query string on GET, the JSON body on POST. The current screen
 * POSTs, so a long list of ticked customers or people never meets a URL length limit; GET stays for
 * a screen deployed before it.
 */
function historyParams(req: Request): unknown {
  return req.method === 'POST' ? (req.body ?? {}) : req.query;
}

function badQuery(res: Response, error: z.ZodError) {
  // Same shape as before, capped at MAX_DETAILS issues like every validate() 400.
  res.status(400).json(zodValidationFailure(error));
}

/** The company's people holding one of these roles now: the Role filter for alerts from before S3. */
async function userIdsWithRoles(where: { organization_id: string }, roles: readonly string[]): Promise<string[]> {
  if (roles.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { ...where, role: { in: roles as Role[] } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** The table's rows, in the History tab's shape. People on alerts from before S3 are named as they are now. */
async function historyItems(where: { organization_id: string }, rows: HistoryRow[]) {
  const legacyIds = [...new Set(rows.filter((r) => storedRecipients(r) === null).flatMap((r) => r.recipient_ids))];
  const users = legacyIds.length
    ? await prisma.user.findMany({
        where: { ...where, id: { in: legacyIds } },
        select: { id: true, first_name: true, last_name: true, email: true, role: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => historyItem(r, byId));
}

const NEWEST_FIRST: Prisma.SpiderAlertOrderByWithRelationInput[] = [{ alerted_at: 'desc' }, { id: 'desc' }];

/**
 * Every alert Spider raised for this company, newest first, with the contractor's toolbar applied
 * on the server - search, Stage, Date / Time, Recipients, Customers and Role - so it reaches every
 * page. Admin-only. Recipients carry their email, as his table's "+N" list and his email preview
 * did; never a phone number. Kept when Spider is switched off.
 */
export async function getSpiderHistory(req: Request, res: Response) {
  const parsed = historyQuerySchema.safeParse(historyParams(req));
  if (!parsed.success) {
    badQuery(res, parsed.error);
    return;
  }
  const { page, page_size, ...filters } = parsed.data;
  const base = tenantWhere(req);
  try {
    const where = historyWhere(base, filters, await userIdsWithRoles(base, filters.roles));
    const [total, rows] = await Promise.all([
      prisma.spiderAlert.count({ where }),
      prisma.spiderAlert.findMany({
        where,
        orderBy: NEWEST_FIRST,
        skip: (page - 1) * page_size,
        take: page_size,
        select: HISTORY_ROW_SELECT,
      }),
    ]);
    res.json({
      items: await historyItems(base, rows),
      page,
      page_size,
      total,
      total_pages: Math.max(1, Math.ceil(total / page_size)),
    });
  } catch (err) {
    logger.error(`[spider] history read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider history' });
  }
}

/**
 * His "All filtered" export: every row the toolbar's filters match, newest first, up to
 * HISTORY_EXPORT_MAX. `truncated` says when there were more.
 */
export async function exportSpiderHistory(req: Request, res: Response) {
  const parsed = historyFiltersSchema.safeParse(historyParams(req));
  if (!parsed.success) {
    badQuery(res, parsed.error);
    return;
  }
  const base = tenantWhere(req);
  try {
    const where = historyWhere(base, parsed.data, await userIdsWithRoles(base, parsed.data.roles));
    const [total, rows] = await Promise.all([
      prisma.spiderAlert.count({ where }),
      prisma.spiderAlert.findMany({ where, orderBy: NEWEST_FIRST, take: HISTORY_EXPORT_MAX, select: HISTORY_ROW_SELECT }),
    ]);
    res.json({ items: await historyItems(base, rows), total, truncated: total > rows.length });
  } catch (err) {
    logger.error(`[spider] history export failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not export Spider history' });
  }
}

/**
 * For the History tab's count badge: every alert, and the alerts newer than `since` (the browser's
 * "last viewed History" time; all of them when it has none).
 */
export async function getSpiderHistorySummary(req: Request, res: Response) {
  const parsed = historySummarySchema.safeParse(req.query);
  if (!parsed.success) {
    badQuery(res, parsed.error);
    return;
  }
  const where = { ...tenantWhere(req), ...SUMMARY_NOT_BUILDING };
  const orgId = req.user!.organization_id;
  try {
    const since = parsed.data.since ? new Date(parsed.data.since) : null;
    const [total, newSince] = await Promise.all([
      prisma.spiderAlert.count({ where }),
      since ? prisma.spiderAlert.count({ where: { ...where, alerted_at: { gt: since } } }) : Promise.resolve(null),
    ]);
    res.json({ total, new_since: newSince ?? total });
  } catch (err) {
    logger.error(`[spider] history summary failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load Spider history' });
  }
}

/**
 * The options of his Recipients and Customers filters, as his were: every person in the company,
 * and every customer of the company. Value and label only; the filter searches inside a long list.
 */
export async function getSpiderHistoryFilters(req: Request, res: Response) {
  const where = tenantWhere(req);
  try {
    const [users, customers] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, first_name: true, last_name: true, email: true },
        orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
      }),
      prisma.customer.findMany({
        where,
        select: { id: true, first_name: true, last_name: true, company_name: true },
      }),
    ]);
    res.json({
      recipients: users.map((u) => ({ value: u.id, label: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email })),
      customers: customers
        .map((c) => ({ value: c.id, label: customerName(c) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    });
  } catch (err) {
    logger.error(`[spider] history filters read failed for org ${req.user!.organization_id}`, err);
    res.status(500).json({ error: 'Could not load Spider history' });
  }
}

// ─── The caller's unread alerts ──────────────────────────────────────────────

/** Enough for the contractor's "99+" badge, still a bounded list. */
export const UNREAD_ALERTS_LIMIT = 100;

/** The card fields every alert carries from the moment it was raised (the notification data). */
const CARD_FIELDS = [
  'lead_number',
  'customer_name',
  'company_name',
  'status',
  'status_label',
  'stage_name',
  'service_location',
  'service_request',
  'assigned_to',
  'address',
  'owner_name',
  'entered_status_at',
  'stage_entered_at',
  'lead_created_at',
  'counted_from',
  'time_in_status',
] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * The signed-in person's own unread Spider alerts - a bounded list for the popup cards and the red
 * frame - plus whether the company's in-app and red-frame channels are on. `id` is the
 * notification-recipient id, which the existing PATCH /api/notifications/:id/read marks read.
 *
 * An alert that is no longer open is left out at once (alertStillOpen, the sweep's own rule): its lead has left the
 * alerted stage visit, or the settings saved now no longer alert it - the lead excluded, its stage's limit off, or a
 * longer limit it is not past (#3450). So the popup and the frame follow a stage change or a settings save on their next
 * read. The settings are read once, and only the listed leads' exclusions, never the whole list. While Spider is switched off the list is
 * empty and the frame off. This request writes nothing: the sweep marks those alerts read
 * (sweep.ts endFinishedAlerts and, for a company that is off, endOpenSpiderRecords).
 */
export async function getMyUnreadSpiderAlerts(req: Request, res: Response) {
  const user = req.user!;
  const orgId = user.organization_id;
  try {
    const unreadOf = (verb: string) => ({
      organization_id: orgId,
      recipient_id: user.id,
      read_at: null,
      dismissed_at: null,
      notification: { verb },
    });
    const [rows, frameRows, settings] = await Promise.all([
      prisma.notificationRecipient.findMany({
        where: unreadOf(SPIDER_ALERT_VERB),
        orderBy: { created_at: 'desc' },
        take: UNREAD_ALERTS_LIMIT,
        select: { id: true, created_at: true, notification: { select: { object_id: true, data: true } } },
      }),
      // Red-frame-only records (in-app alerts off): they show the frame, never a card.
      prisma.notificationRecipient.findMany({
        where: unreadOf(SPIDER_FRAME_VERB),
        orderBy: { created_at: 'desc' },
        take: UNREAD_ALERTS_LIMIT,
        select: { notification: { select: { object_id: true, data: true } } },
      }),
      prisma.spiderSettings.findUnique({
        where: { organization_id: orgId },
        select: { channels: true, is_active: true, status_limits: true },
      }),
    ]);
    const channels = settings ? readChannels(settings.channels) : null;
    const redFrame = !!channels && channels.red_frame;
    // Spider off (D4): nothing of it shows, whatever is still stored - switching off ends the alerts
    // and the sweep ends any it missed. No row is not off: a company only gets a row by switching on.
    if (settings && !settings.is_active) {
      res.json({ alerts: [], in_app: channels ? channels.in_app : true, red_frame: redFrame, frame: false });
      return;
    }
    const leadIds = [...rows, ...frameRows].map((r) => r.notification.object_id);
    const [visits, excluded] = await Promise.all([
      currentVisitsByLead(orgId, leadIds),
      settings ? excludedAmong(orgId, leadIds) : Promise.resolve(new Set<string>()),
    ]);
    // The listed leads' exclusions stand in for the whole list: the rule only asks about these leads.
    const rules = openAlertRulesOf(settings && { status_limits: settings.status_limits, excluded_lead_ids: [...excluded] });
    const now = new Date();
    const stillOpen = (n: { object_id: string; data: unknown }) =>
      alertStillOpen(alertedVisitOf(n.object_id, n.data), visits.get(n.object_id), rules, now);
    const alerts = rows.flatMap((r) => {
      const leadId = r.notification.object_id;
      const visit = visits.get(leadId);
      if (!stillOpen(r.notification)) return [];
      const data = (r.notification.data ?? {}) as Record<string, unknown>;
      const card: Record<string, unknown> = {};
      for (const k of CARD_FIELDS) card[k] = data[k] ?? null;
      // Alerts raised before the contractor's fields were stored fall back to what they carry.
      const stageName =
        str(data.stage_name) ?? (isWatchedStatus(String(data.status)) ? SPIDER_STAGE_NAME[data.status as SpiderStatus] : null);
      return [
        {
          id: r.id,
          created_at: r.created_at.toISOString(),
          ...card,
          lead_id: leadId,
          stage_name: stageName,
          // His click routes on the lead's stage now: "Estimate" once its status is Estimate Sent.
          current_stage: visit?.lead_status === 'ESTIMATED' ? 'Estimate' : stageName,
          service_location: str(data.service_location) ?? str(data.address),
          assigned_to: str(data.assigned_to) ?? str(data.owner_name),
          stage_entered_at: str(data.stage_entered_at) ?? str(data.entered_status_at),
          message: str(data.body),
        },
      ];
    });
    res.json({
      alerts,
      in_app: channels ? channels.in_app : true,
      red_frame: redFrame,
      // Whether the red frame shows now: its switch is on and an in-app alert or a red-frame-only
      // record is still open for this person.
      frame: redFrame && (alerts.length > 0 || frameRows.some((r) => stillOpen(r.notification))),
    });
  } catch (err) {
    logger.error(`[spider] unread alerts read failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load Spider alerts' });
  }
}

// ─── The starting summary (#2794) ────────────────────────────────────────────

/**
 * The caller's own starting summary: the company's latest summary, only the leads the caller was
 * told about and can still open, each with where it is now. Any role in a Spider company. `summary`
 * is null when there is none, or none of it is the caller's.
 */
export async function getMySpiderSummary(req: Request, res: Response) {
  const user = req.user!;
  try {
    const leadScope = (await scopeWhereForReq(req, 'Lead')) as Prisma.LeadWhereInput;
    const summary = await readSpiderSummary({ orgId: user.organization_id, forUser: { id: user.id, leadScope } });
    res.json({ summary });
  } catch (err) {
    logger.error(`[spider] summary read failed for org ${user.organization_id}`, err);
    res.status(500).json({ error: 'Could not load the starting summary' });
  }
}

/** The company-wide starting summary, for the Spider page's card (Admin only). */
export async function getCompanySpiderSummary(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  try {
    res.json({ summary: await readSpiderSummary({ orgId, forUser: null }) });
  } catch (err) {
    logger.error(`[spider] company summary read failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load the starting summary' });
  }
}
