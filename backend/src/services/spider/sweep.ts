/**
 * The Spider sweep (#2619): the server - not anyone's browser - watches each open lead's status
 * and alerts the right staff once a lead has stayed in a watched status longer than the limit its
 * company set. Registered in index.ts next to the other sweeps, every 2 minutes.
 *
 * - Which companies: those with a Spider settings row that pass the Spider gate (the `spider`
 *   feature and, while the launch is demo-only, a demo company). Alerts go out only while
 *   Spider is switched on. Ending finished alerts runs for every company with a settings row,
 *   so alerts already raised still end after Spider is switched off or the gate is revoked.
 * - Which leads: every open lead (no row cap) in a status the company switched on, or only the
 *   selected leads when "watch all open leads" is off. Won, Lost and Cancelled never.
 * - Time in status: now minus the later of (a) the instant the lead entered its current status -
 *   its latest STATUS_CHANGE History entry into that status, else its creation - and (b) the
 *   company's activated_at. Nothing else on the lead is read to decide its stage.
 * - Once per lead per status visit: the alert-log row is inserted first; its unique key
 *   (company, lead, status, entered-status instant) is the claim. Only a successful claim sends.
 *   A unique-key collision is "already alerted"; any other failure sends nothing and is logged.
 * - Ending: an unread spider.alert whose lead has left the alerted status visit (another status,
 *   or the same status re-entered later) is marked read for every recipient.
 *
 * One instance across servers (a transaction-scoped advisory lock held for the run) and never two
 * overlapping runs in one process. One company's failure never stops the others. Logs carry ids
 * only.
 */
import { Prisma, PrismaClient, type LeadStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { runUnscoped, runWithOrg } from '../../lib/tenant-context';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { emit } from '../notifications/notificationService';
import {
  SPIDER_WATCHED_STATUSES,
  customerName,
  isWatchedStatus,
  limitMs,
  readChannels,
  readRecipients,
  readStatusLimits,
  type SpiderChannels,
  type SpiderRecipients,
  type SpiderStatus,
  type SpiderUnit,
} from './config';
import { spiderAvailableForOrg } from './gate';
import { resolveSpiderRecipients } from './recipients';
import {
  EMAIL_OUTCOME,
  TEXT_OUTCOME,
  deliverSpiderEmails,
  deliverSpiderTexts,
  type ChannelDelivery,
  type SpiderAlertContent,
} from './delivery';

export const SPIDER_ALERT_VERB = 'spider.alert';
const SWEEP_LOCK_KEY = 'spider.sweep';
// The lock lives as long as the transaction holding it, so this bounds a run. Far beyond any real
// run (seconds), and if one ever overran, the alert log's unique claim still prevents double sends.
const SWEEP_LOCK_TIMEOUT_MS = 55 * 60_000;

export interface SpiderSweepResult {
  ran: boolean;
  companies: number;
  leadsChecked: number;
  alertsSent: number;
  alertsEnded: number;
}

const NOT_RUN: SpiderSweepResult = { ran: false, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0 };

let inFlight = false;

/** Never throws. `now` is injectable so tests can run the sweep at chosen clock times. */
export async function runSpiderSweep(now: Date = new Date()): Promise<SpiderSweepResult> {
  if (inFlight) {
    logger.warn('[spider] previous sweep still running - skipping this run');
    return NOT_RUN;
  }
  inFlight = true;
  try {
    return await runUnscoped(() => withSweepLock(() => sweepAllCompanies(now)));
  } catch (err) {
    logger.error(`[spider] sweep failed: ${errorName(err)}`);
    return NOT_RUN;
  } finally {
    inFlight = false;
  }
}

/** Test-only: true while a sweep is running in this process. */
export function _spiderSweepInFlight(): boolean {
  return inFlight;
}

/**
 * The lock is held by a transaction on a connection of its OWN, not by one of the app client's. The deployed database
 * pool holds a single connection: a lock transaction on the app's client would pin it for the whole run, and the work
 * below (which runs on that client) would wait for a second one that never comes, fail after the pool timeout, and
 * keep every other request waiting too. The extra connection lives only for the run.
 */
function openLockClient(): PrismaClient {
  const url = new URL(env.DATABASE_URL);
  url.searchParams.set('connection_limit', '1');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

async function withSweepLock(fn: () => Promise<SpiderSweepResult>): Promise<SpiderSweepResult> {
  const lockClient = openLockClient();
  try {
    return await lockClient.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${SWEEP_LOCK_KEY}, 0)) AS locked`;
        if (!row?.locked) {
          logger.info('[spider] another server is running the sweep - skipping this run');
          return NOT_RUN;
        }
        // The work runs on the app's client, not `tx`: this transaction exists only to hold the lock.
        return fn();
      },
      { timeout: SWEEP_LOCK_TIMEOUT_MS, maxWait: 10_000 },
    );
  } finally {
    await lockClient.$disconnect().catch(() => undefined);
  }
}

async function sweepAllCompanies(now: Date): Promise<SpiderSweepResult> {
  const result: SpiderSweepResult = { ran: true, companies: 0, leadsChecked: 0, alertsSent: 0, alertsEnded: 0 };
  const rows = await prisma.spiderSettings.findMany({
    select: {
      organization_id: true,
      organization: { select: { is_demo: true, plan: true, trial_ends_at: true, feature_overrides: true } },
    },
    orderBy: { organization_id: 'asc' },
  });
  for (const row of rows) {
    const orgId = row.organization_id;
    const available = spiderAvailableForOrg(row.organization);
    if (available) result.companies += 1;
    try {
      const r = await runWithOrg(orgId, () => sweepCompany(orgId, now, available));
      result.leadsChecked += r.leadsChecked;
      result.alertsSent += r.alertsSent;
      result.alertsEnded += r.alertsEnded;
    } catch (err) {
      logger.error(`[spider] sweep failed for org ${orgId}: ${errorName(err)}`);
    }
  }
  return result;
}

// ─── One company ─────────────────────────────────────────────────────────────

interface StatusVisit {
  id: string;
  status: LeadStatus;
  entered_at: Date;
}

/**
 * Each lead's current status visit: its status and the instant it entered it (the latest
 * STATUS_CHANGE History entry into the current status, else the lead's creation). One query, no
 * row cap.
 */
async function currentStatusVisits(
  orgId: string,
  filter: { statuses: readonly string[]; leadIds?: readonly string[] },
): Promise<StatusVisit[]> {
  if (filter.statuses.length === 0 || (filter.leadIds && filter.leadIds.length === 0)) return [];
  const byLead = filter.leadIds ? Prisma.sql`AND l.id = ANY(${[...filter.leadIds]}::uuid[])` : Prisma.empty;
  return prisma.$queryRaw<StatusVisit[]>`
    SELECT l.id, l.status, COALESCE(sc.entered_at, l.created_at) AS entered_at
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT max(te.created_at) AS entered_at
      FROM timeline_events te
      WHERE te.entity_type = 'LEAD'
        AND te.entity_id = l.id
        AND te.organization_id = l.organization_id
        AND te.event_type = 'STATUS_CHANGE'
        AND te.metadata->>'to' = l.status::text
    ) sc ON true
    WHERE l.organization_id = ${orgId}::uuid
      AND l.status::text = ANY(${[...filter.statuses]}::text[])
      ${byLead}`;
}

async function sweepCompany(
  orgId: string,
  now: Date,
  available: boolean,
): Promise<{ leadsChecked: number; alertsSent: number; alertsEnded: number }> {
  const alertsEnded = await endFinishedAlerts(orgId, now);
  if (!available) return { leadsChecked: 0, alertsSent: 0, alertsEnded };
  const settings = await prisma.spiderSettings.findUnique({ where: { organization_id: orgId } });
  if (!settings?.is_active || !settings.activated_at) return { leadsChecked: 0, alertsSent: 0, alertsEnded };

  const limits = readStatusLimits(settings.status_limits);
  const enabled = SPIDER_WATCHED_STATUSES.filter((s) => limits[s].enabled);
  const visits = await currentStatusVisits(orgId, {
    statuses: enabled,
    leadIds: settings.watch_all_leads ? undefined : settings.selected_lead_ids,
  });

  const activatedAt = settings.activated_at;
  const overdue = visits.flatMap((v) => {
    if (!isWatchedStatus(v.status)) return [];
    const limit = limits[v.status];
    const countedFrom = v.entered_at > activatedAt ? v.entered_at : activatedAt;
    return now.getTime() - countedFrom.getTime() >= limitMs(limit.value, limit.unit)
      ? [{ ...v, status: v.status, countedFrom, limit }]
      : [];
  });
  if (overdue.length === 0) return { leadsChecked: visits.length, alertsSent: 0, alertsEnded };

  // Skip visits already alerted before doing any work for them. The insert below is still the
  // authoritative claim; this only keeps a long-overdue lead from costing a recipient lookup on
  // every run.
  const existing = await prisma.spiderAlert.findMany({
    where: { organization_id: orgId, lead_id: { in: overdue.map((o) => o.id) } },
    select: { lead_id: true, status: true, entered_status_at: true },
  });
  const claimed = new Set(existing.map((e) => visitKey(e.lead_id, e.status, e.entered_status_at)));

  const channels = readChannels(settings.channels);
  const recipientsConfig = readRecipients(settings.recipients);
  let alertsSent = 0;
  for (const o of overdue) {
    if (claimed.has(visitKey(o.id, o.status, o.entered_at))) continue;
    try {
      const sent = await alertLead({
        orgId,
        now,
        leadId: o.id,
        status: o.status,
        enteredAt: o.entered_at,
        countedFrom: o.countedFrom,
        limit: o.limit,
        channels,
        recipientsConfig,
      });
      if (sent) alertsSent += 1;
    } catch (err) {
      logger.error(`[spider] alert failed for org ${orgId} lead ${o.id}: ${errorName(err)}`);
    }
  }
  return { leadsChecked: visits.length, alertsSent, alertsEnded };
}

function visitKey(leadId: string, status: string, enteredAt: Date): string {
  return `${leadId}|${status}|${enteredAt.getTime()}`;
}

// ─── One alert ───────────────────────────────────────────────────────────────

async function alertLead(a: {
  orgId: string;
  now: Date;
  leadId: string;
  status: SpiderStatus;
  enteredAt: Date;
  countedFrom: Date;
  limit: { value: number; unit: SpiderUnit };
  channels: SpiderChannels;
  recipientsConfig: SpiderRecipients;
}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({
    where: { id: a.leadId, organization_id: a.orgId },
    select: {
      id: true,
      lead_number: true,
      commission_owner_id: true,
      commission_owner: { select: { first_name: true, last_name: true } },
      customer: { select: { first_name: true, last_name: true, company_name: true } },
      service_location: { select: { address_line1: true, address_line2: true, city: true, state: true, zip: true } },
    },
  });
  if (!lead) return false;

  const recipients = await resolveSpiderRecipients(prisma, {
    orgId: a.orgId,
    leadId: lead.id,
    ownerId: lead.commission_owner_id,
    recipients: a.recipientsConfig,
  });
  // Nobody at all - not even an Admin - can sign in and open this lead: claim nothing, so the
  // visit can still alert once someone it would reach exists.
  if (recipients.length === 0) return false;

  // The claim. Written before anything is sent; only a successful insert sends.
  let alertId: string;
  try {
    const row = await prisma.spiderAlert.create({
      data: {
        organization_id: a.orgId,
        lead_id: lead.id,
        status: a.status,
        entered_status_at: a.enteredAt,
        counted_from: a.countedFrom,
        limit_value: a.limit.value,
        limit_unit: a.limit.unit,
        alerted_at: a.now,
        recipient_ids: recipients.map((r) => r.id),
      },
      select: { id: true },
    });
    alertId = row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    logger.error(`[spider] could not record the alert for org ${a.orgId} lead ${lead.id} - nothing sent: ${errorName(err)}`);
    return false;
  }

  const statusLabel = LEAD_STATUS_LABEL[a.status];
  const timeInStatus = formatDuration(a.now.getTime() - a.countedFrom.getTime());
  const content: SpiderAlertContent = {
    leadNumber: lead.lead_number,
    customerName: customerName(lead.customer),
    statusLabel,
    timeInStatus,
    address: formatAddress(lead.service_location),
    ownerName: lead.commission_owner
      ? `${lead.commission_owner.first_name} ${lead.commission_owner.last_name}`.trim() || null
      : null,
    leadUrl: `${env.FRONTEND_URL.replace(/\/+$/, '')}/leads/${lead.id}`,
  };

  const delivery: Record<string, ChannelDelivery> = {};

  if (a.channels.in_app) {
    const notified = await emit({
      verb: SPIDER_ALERT_VERB,
      organizationId: a.orgId,
      actorId: null,
      object: { type: 'LEAD', id: lead.id, label: lead.lead_number },
      entity: { recipient_ids: recipients.map((r) => r.id) },
      data: {
        object_label: lead.lead_number,
        spider_alert_id: alertId,
        lead_id: lead.id,
        lead_number: lead.lead_number,
        customer_name: content.customerName,
        status: a.status,
        status_label: statusLabel,
        address: content.address,
        owner_name: content.ownerName,
        entered_status_at: a.enteredAt.toISOString(),
        counted_from: a.countedFrom.toISOString(),
        time_in_status: timeInStatus,
      },
      dedupKey: `${SPIDER_ALERT_VERB}:${alertId}`,
    });
    delivery.in_app = { outcome: notified.length > 0 ? 'Shown in the app' : 'No one to alert in the app' };
  } else {
    delivery.in_app = { outcome: 'In-app alerts are switched off' };
  }

  delivery.email = a.channels.email
    ? await deliverSpiderEmails({ orgId: a.orgId, alertId, recipients, content })
    : { outcome: EMAIL_OUTCOME.channelOff };

  delivery.text = a.channels.text
    ? await deliverSpiderTexts({ orgId: a.orgId, alertId, recipients, content })
    : { outcome: TEXT_OUTCOME.channelOff };

  try {
    await prisma.spiderAlert.update({
      where: { id: alertId },
      data: { delivery: delivery as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.error(`[spider] could not record delivery for alert ${alertId}: ${errorName(err)}`);
  }
  logger.info('[spider] alert sent', { orgId: a.orgId, leadId: lead.id, alertId, recipients: recipients.length });
  return true;
}

// ─── Ending alerts ───────────────────────────────────────────────────────────

/**
 * Marks read every unread spider.alert in this company whose lead has left the alerted status
 * visit - a different status now, or the same status entered again at a later instant (or the
 * lead is gone). Touches spider.alert rows only, and only this company's.
 */
async function endFinishedAlerts(orgId: string, now: Date): Promise<number> {
  const open = await prisma.notificationRecipient.findMany({
    where: { organization_id: orgId, read_at: null, notification: { verb: SPIDER_ALERT_VERB } },
    select: { notification: { select: { id: true, object_id: true, data: true } } },
  });
  if (open.length === 0) return 0;

  const alerted = new Map<string, { leadId: string; status: string; enteredAt: string }>();
  for (const { notification: n } of open) {
    const data = (n.data ?? {}) as Record<string, unknown>;
    alerted.set(n.id, {
      leadId: n.object_id,
      status: typeof data.status === 'string' ? data.status : '',
      enteredAt: typeof data.entered_status_at === 'string' ? data.entered_status_at : '',
    });
  }

  const leadIds = [...new Set([...alerted.values()].map((v) => v.leadId))];
  const visits = await currentStatusVisits(orgId, {
    statuses: Object.keys(LEAD_STATUS_LABEL),
    leadIds,
  });
  const current = new Map(visits.map((v) => [v.id, v]));

  const finished = [...alerted.entries()]
    .filter(([, a]) => {
      const visit = current.get(a.leadId);
      return !visit || visit.status !== a.status || visit.entered_at.toISOString() !== a.enteredAt;
    })
    .map(([notificationId]) => notificationId);
  if (finished.length === 0) return 0;

  const { count } = await prisma.notificationRecipient.updateMany({
    where: { organization_id: orgId, notification_id: { in: finished }, read_at: null },
    data: { read_at: now },
  });
  return count;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

function formatAddress(
  l: { address_line1: string; address_line2: string | null; city: string; state: string; zip: string } | null,
): string | null {
  if (!l) return null;
  const street = [l.address_line1, l.address_line2].filter(Boolean).join(' ');
  return [street, l.city, `${l.state} ${l.zip}`.trim()].filter((p) => p && p.trim()).join(', ') || null;
}

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
