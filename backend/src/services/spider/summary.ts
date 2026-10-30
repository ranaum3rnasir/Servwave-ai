/**
 * Spider's starting summary (#2794).
 *
 * When Spider starts watching something new - it is switched on, a stage is switched on, a limit is
 * shortened, or more leads come under watch - the leads already past their limit are not alerted one
 * by one. Each recipient gets ONE starting summary of exactly the leads they would have been alerted
 * about, and from then on every lead alerts normally the moment it crosses its limit.
 *
 * - The trigger: the switch route and the settings save record the moment (and kind) on the settings
 *   row (`summaryTriggerOf`, `mergeTriggerKind`).
 * - The quiet period: the sweep acts on a trigger only once it is a sweep interval old, so several
 *   quick saves give one summary. Until then it alerts nothing for that company.
 * - The claims: every summarized lead stay gets its alert-log row (kind SUMMARIZED, linked to the
 *   summary) with the same unique claim key and recipient list as an alert, so the per-lead path
 *   skips it for the rest of the switched-on period. Lead stays already alerted in this period are
 *   already claimed, so only the new backlog is left: no list of "what is new" is needed. Switching
 *   back on starts a new period, so a lead still stuck is in that switch-on's summary (D5).
 * - Recipients: Spider's one recipient rule per lead (recipients.ts). A person's summary is the
 *   summarized leads whose recipient list includes them.
 * - Delivery: the bell (one notification per person, no toast and no red frame), the email and the
 *   text, through Spider's delivery module. Nothing overdue means no summary and no message.
 * - Only the latest summary of a company is kept; the leads of an older one keep their claim with the
 *   summary link cleared. Switching Spider on with nothing overdue removes the old one too (each
 *   turn-on replaces it); other triggers with nothing overdue leave it.
 * - All or nothing: everything delivery needs is read first, then the old summary's removal, the new
 *   summary and its claims are written in ONE transaction. Anything that fails up to there throws and
 *   leaves nothing written, so the sweep keeps the trigger and tries again. Once the claims are in,
 *   nothing throws: a channel that fails is recorded on the summary as not delivered.
 *
 * Logs carry ids only.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { DEFAULT_TIMEZONE } from '../../lib/timezone';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { emit } from '../notifications/notificationService';
import {
  SPIDER_LEAD_TIMES_SELECT,
  customerName,
  limitMs,
  readStatusLimits,
  spiderStageOf,
  type SpiderChannels,
  type SpiderRecipients,
  type SpiderStatus,
  type SpiderUnit,
} from './config';
import { resolveSpiderRecipients, type SpiderRecipient } from './recipients';
import {
  EMAIL_OUTCOME,
  EMAIL_REASON,
  SPIDER_EMAIL_FROM_LINE,
  TEXT_OUTCOME,
  TEXT_REASON,
  channelRecord,
  deliverSpiderEmailsTo,
  deliverSpiderTextsTo,
  type ChannelDelivery,
  type RecipientResult,
} from './delivery';
import { SPIDER_STAGE_NAME, resolveServiceAddress } from './messages';
import {
  SUMMARY_BELL_BODY,
  isTriggerKind,
  mostOverdueFirst,
  overByMs,
  summaryBellTitle,
  summaryDuration,
  summaryEmailHtml,
  summaryEmailSubject,
  summaryEmailText,
  summaryTextEmailed,
  summaryTextWithLink,
  triggerWhen,
  type SpiderTriggerKind,
  type SummaryLead,
} from './summaryMessages';

export const SPIDER_SUMMARY_VERB = 'spider.starting_summary';
/** The sweep's interval: a trigger is acted on once the settings have been quiet this long. */
export const SUMMARY_QUIET_MS = 2 * 60_000;
/**
 * The longest a trigger waits from when it first started waiting: the sweep acts then even if saves
 * keep coming, and stops retrying a summary that keeps failing (the per-lead path takes over).
 */
export const SUMMARY_MAX_WAIT_MS = 10 * 60_000;
/** Where the bell, the email button and the text link lead. */
export const SPIDER_SUMMARY_PATH = '/spider/summary';

export const spiderSummaryUrl = () => `${env.FRONTEND_URL.replace(/\/+$/, '')}${SPIDER_SUMMARY_PATH}`;
const leadUrl = (leadId: string) => `${env.FRONTEND_URL.replace(/\/+$/, '')}/leads/${leadId}`;

// ─── Triggers ────────────────────────────────────────────────────────────────

/** What a settings save compares, before and after. */
export interface WatchedScope {
  status_limits: Prisma.JsonValue;
  watch_all_leads: boolean;
  selected_lead_ids: readonly string[];
}

/**
 * Whether a settings save starts watching something new, and how: a stage switched on, a limit
 * shortened, or more leads under watch ("Auto-select new leads" turned on, or leads added to the
 * selection). A save that only narrows what is watched, or changes recipients or channels, is not a
 * trigger. Several at once read as SETTINGS_CHANGED.
 */
export function settingsTriggerKind(before: WatchedScope, after: WatchedScope): SpiderTriggerKind | null {
  const was = readStatusLimits(before.status_limits);
  const now = readStatusLimits(after.status_limits);
  const kinds = new Set<SpiderTriggerKind>();
  for (const stage of Object.keys(now) as SpiderStatus[]) {
    const a = was[stage];
    const b = now[stage];
    if (!b.enabled) continue;
    if (!a.enabled) kinds.add('STAGE_ADDED');
    else if (limitMs(b.value, b.unit) < limitMs(a.value, a.unit)) kinds.add('LIMIT_SHORTENED');
  }
  const widened = after.watch_all_leads
    ? !before.watch_all_leads
    : !before.watch_all_leads && after.selected_lead_ids.some((id) => !before.selected_lead_ids.includes(id));
  if (widened) kinds.add('SCOPE_WIDENED');
  if (kinds.size === 0) return null;
  return kinds.size === 1 ? [...kinds][0]! : 'SETTINGS_CHANGED';
}

/**
 * The kind a new trigger records over one still waiting: switching on names the summary whatever
 * else changed in the quiet period; two different setting changes read as SETTINGS_CHANGED.
 */
export function mergeTriggerKind(pending: string | null | undefined, next: SpiderTriggerKind): SpiderTriggerKind {
  if (!isTriggerKind(pending) || pending === next) return next;
  if (pending === 'SWITCHED_ON' || next === 'SWITCHED_ON') return 'SWITCHED_ON';
  return 'SETTINGS_CHANGED';
}

// ─── The sweep step ──────────────────────────────────────────────────────────

/** A lead stay past its limit and not yet claimed, as the sweep found it. */
export interface OverdueVisit {
  id: string;
  status: SpiderStatus;
  entered_at: Date;
  /** The claim key's switched-on period: the later of entered_at and activated_at (sweep.ts). */
  counted_from: Date;
  limit: { value: number; unit: SpiderUnit };
}

const LEAD_SELECT = {
  id: true,
  lead_number: true,
  customer_id: true,
  service_request: true,
  commission_owner_id: true,
  commission_owner: { select: { first_name: true, last_name: true } },
  customer: {
    select: {
      first_name: true,
      last_name: true,
      company_name: true,
      service_locations: {
        select: { address_line1: true, address_line2: true, city: true, state: true, zip: true, is_primary: true },
        orderBy: [{ is_primary: 'desc' as const }, { created_at: 'asc' as const }],
        take: 1,
      },
    },
  },
  service_location: { select: { address_line1: true, address_line2: true, city: true, state: true, zip: true } },
} as const satisfies Prisma.LeadSelect;

const personName = (p: { first_name: string | null; last_name: string | null } | null) =>
  p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || null : null;

/** The claims were all taken meanwhile: roll the transaction back, nothing to report. */
class NothingClaimed extends Error {}

export interface StartingSummaryResult {
  summaryId: string | null;
  leads: number;
  recipients: number;
}

/**
 * Makes the company's starting summary of these overdue, unclaimed lead stays and delivers it.
 * Returns how many leads and people it covered (none: nothing was sent and no summary was made).
 */
export async function runStartingSummary(a: {
  orgId: string;
  now: Date;
  triggeredAt: Date;
  triggerKind: SpiderTriggerKind;
  overdue: readonly OverdueVisit[];
  channels: SpiderChannels;
  recipientsConfig: SpiderRecipients;
}): Promise<StartingSummaryResult> {
  const none: StartingSummaryResult = { summaryId: null, leads: 0, recipients: 0 };
  // Nothing to report: no message. Switching on replaces the last summary even then (its card goes);
  // any other trigger leaves it.
  const nothingToReport = async () => {
    if (a.triggerKind === 'SWITCHED_ON') await prisma.spiderSummary.deleteMany({ where: { organization_id: a.orgId } });
    return none;
  };
  if (a.overdue.length === 0) return nothingToReport();

  const leads = await prisma.lead.findMany({
    where: { organization_id: a.orgId, id: { in: a.overdue.map((o) => o.id) } },
    select: LEAD_SELECT,
  });
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Each lead's people by Spider's one rule. A lead nobody can be told about is left unclaimed, as
  // the per-lead path leaves it, so it can still alert once someone it would reach exists.
  const planned: { visit: OverdueVisit; lead: (typeof leads)[number]; recipients: SpiderRecipient[] }[] = [];
  for (const visit of a.overdue) {
    const lead = leadById.get(visit.id);
    if (!lead) continue;
    const recipients = await resolveSpiderRecipients(prisma, {
      orgId: a.orgId,
      leadId: lead.id,
      ownerId: lead.commission_owner_id,
      recipients: a.recipientsConfig,
    });
    if (recipients.length > 0) planned.push({ visit, lead, recipients });
  }
  if (planned.length === 0) return nothingToReport();

  // Everything delivery needs is read before anything is written.
  const org = await prisma.organization.findUnique({ where: { id: a.orgId }, select: { timezone: true } });
  const when = triggerWhen(a.triggeredAt, a.now, org?.timezone || DEFAULT_TIMEZONE);
  const summary = { id: randomUUID() };

  const claimRows = planned.map(({ visit, lead, recipients }) => {
    const leadNumber = lead.lead_number || `Lead #${lead.id.slice(0, 6)}`;
    return {
      organization_id: a.orgId,
      lead_id: lead.id,
      status: visit.status,
      entered_status_at: visit.entered_at,
      counted_from: visit.counted_from,
      limit_value: visit.limit.value,
      limit_unit: visit.limit.unit,
      alerted_at: a.now,
      recipient_ids: recipients.map((r) => r.id),
      kind: 'SUMMARIZED',
      summary_id: summary.id,
      lead_number: leadNumber,
      customer_id: lead.customer_id,
      customer_name: customerName(lead.customer),
      company_name: lead.customer.company_name?.trim() || null,
      service_request: lead.service_request || null,
      service_location: resolveServiceAddress(lead, lead.customer),
      stage_name: SPIDER_STAGE_NAME[visit.status],
      elapsed_value: Math.max(1, Math.floor((a.now.getTime() - visit.entered_at.getTime()) / limitMs(1, visit.limit.unit))),
      elapsed_unit: visit.limit.unit,
      recipients: recipients.map((r) => ({
        id: r.id,
        name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
        email: r.email,
        role: r.role,
        type: r.chosen_as,
      })),
    };
  });

  // One transaction: the older summary goes (its leads keep their claim; the foreign key clears the
  // link), the new one and its claims arrive. A stay claimed meanwhile is skipped by the unique key.
  let claimed: { id: string; lead_id: string; recipient_ids: string[] }[];
  try {
    claimed = await prisma.$transaction(async (tx) => {
      await tx.spiderSummary.deleteMany({ where: { organization_id: a.orgId } });
      await tx.spiderSummary.create({
        data: { id: summary.id, organization_id: a.orgId, created_at: a.now, triggered_at: a.triggeredAt, trigger_kind: a.triggerKind },
        select: { id: true },
      });
      await tx.spiderAlert.createMany({ skipDuplicates: true, data: claimRows });
      const rows = await tx.spiderAlert.findMany({
        where: { organization_id: a.orgId, summary_id: summary.id },
        select: { id: true, lead_id: true, recipient_ids: true },
      });
      if (rows.length === 0) throw new NothingClaimed();
      return rows;
    });
  } catch (err) {
    if (err instanceof NothingClaimed) return nothingToReport();
    throw err;
  }

  const claimedLeadIds = new Set(claimed.map((c) => c.lead_id));
  const items = planned.filter((p) => claimedLeadIds.has(p.lead.id));
  const summaryLead = (p: (typeof items)[number]): SummaryLead => ({
    leadId: p.lead.id,
    leadNumber: p.lead.lead_number || `Lead #${p.lead.id.slice(0, 6)}`,
    customerName: customerName(p.lead.customer),
    address: resolveServiceAddress(p.lead, p.lead.customer),
    stageName: SPIDER_STAGE_NAME[p.visit.status],
    inStageMs: a.now.getTime() - p.visit.entered_at.getTime(),
    limitMs: limitMs(p.visit.limit.value, p.visit.limit.unit),
    ownerName: personName(p.lead.commission_owner),
  });

  // Each person once, with their own leads, most overdue first.
  const people = new Map<string, { person: SpiderRecipient; leads: SummaryLead[]; ownerIds: (string | null)[] }>();
  for (const p of items) {
    for (const r of p.recipients) {
      const entry = people.get(r.id) ?? { person: r, leads: [], ownerIds: [] };
      entry.leads.push(summaryLead(p));
      entry.ownerIds.push(p.lead.commission_owner_id);
      people.set(r.id, entry);
    }
  }
  const recipients = [...people.values()].map((e) => e.person);
  const leadsOf = (userId: string) => mostOverdueFirst(people.get(userId)?.leads ?? []);
  // The Owner column shows unless every lead in the person's list is their own.
  const showOwnerFor = (userId: string) => !(people.get(userId)?.ownerIds ?? []).every((o) => o === userId);

  const delivery: Record<string, ChannelDelivery> = {};
  const results: { in_app: Set<string>; email: RecipientResult[]; text: RecipientResult[] } = {
    in_app: new Set(),
    email: [],
    text: [],
  };
  // From here on nothing throws: the claims are in, so a channel that fails is recorded on the
  // summary as not delivered, as a per-lead alert records it, and never retried.
  const channelFailed = (channel: string, err: unknown) =>
    logger.error(`[spider] summary ${channel} failed for summary ${summary.id}: ${err instanceof Error ? err.name : 'unknown error'}`);
  const inAppOutcomes = () =>
    recipients.map((r) => ({ user_id: r.id, outcome: results.in_app.has(r.id) ? 'Shown in the app' : 'Not shown in the app' }));

  // In the app: one notification per person, about them alone (their own count), no toast and no
  // red frame. Its link opens their summary.
  if (a.channels.in_app) {
    try {
      for (const r of recipients) {
        const n = leadsOf(r.id).length;
        const told = await emit({
          verb: SPIDER_SUMMARY_VERB,
          organizationId: a.orgId,
          actorId: null,
          object: { type: 'SPIDER_SUMMARY', id: summary.id, label: 'Starting summary' },
          entity: { recipient_ids: [r.id] },
          data: { title: summaryBellTitle(n), body: SUMMARY_BELL_BODY, lead_count: n, link_path: SPIDER_SUMMARY_PATH },
          dedupKey: `${SPIDER_SUMMARY_VERB}:${summary.id}:${r.id}`,
          personal: true,
        });
        if (told.length > 0) results.in_app.add(r.id);
      }
      delivery.in_app = {
        outcome: results.in_app.size > 0 ? 'Shown in the app' : 'No one to alert in the app',
        recipients: inAppOutcomes(),
      };
    } catch (err) {
      channelFailed('in-app', err);
      delivery.in_app = { outcome: 'Could not be shown in the app', recipients: inAppOutcomes() };
    }
  } else {
    delivery.in_app = { outcome: 'In-app alerts are switched off' };
  }

  if (a.channels.email) {
    try {
      const sent = await deliverSpiderEmailsTo({
        orgId: a.orgId,
        logKey: { summaryId: summary.id },
        recipients,
        messageFor: (r) => {
          const own = leadsOf(r.id);
          const input = {
            recipientFirstName: r.first_name?.trim() || 'Team Member',
            leads: own,
            showOwner: showOwnerFor(r.id),
            triggerKind: a.triggerKind,
            when,
            summaryUrl: spiderSummaryUrl(),
            leadUrl,
          };
          return { subject: summaryEmailSubject(own.length), text: summaryEmailText(input), html: summaryEmailHtml(input) };
        },
      });
      results.email = sent.results;
      delivery.email = { outcome: sent.outcome, recipients: sent.recipients };
    } catch (err) {
      channelFailed('email', err);
      results.email = recipients.map((r) => ({ user_id: r.id, result: 'failed' as const, reason: EMAIL_REASON.failed }));
      delivery.email = { outcome: EMAIL_OUTCOME.failed, recipients: recipients.map((r) => ({ user_id: r.id, outcome: EMAIL_OUTCOME.failed })) };
    }
  } else {
    delivery.email = { outcome: EMAIL_OUTCOME.channelOff };
  }

  if (a.channels.text) {
    const emailed = new Set(results.email.filter((e) => e.result === 'sent').map((e) => e.user_id));
    // A summary text counts toward texting usage like any Spider text: on the alert-log row of the
    // person's most overdue lead in it (comm-usage.ts sums that column), which is kept for good.
    const claimOf = new Map(claimed.map((c) => [c.lead_id, c.id]));
    try {
      const sent = await deliverSpiderTextsTo({
        orgId: a.orgId,
        sendKey: `summary:${summary.id}`,
        logKey: { summaryId: summary.id },
        recipients,
        bodyFor: (r) => {
          const n = leadsOf(r.id).length;
          // It only mentions an email that actually went out to this person.
          return emailed.has(r.id) ? summaryTextEmailed(n) : summaryTextWithLink(n, spiderSummaryUrl());
        },
        onSent: async (r) => {
          const first = leadsOf(r.id)[0];
          const claimId = first ? claimOf.get(first.leadId) : undefined;
          if (!claimId) return;
          try {
            await prisma.spiderAlert.update({ where: { id: claimId }, data: { texts_sent: { increment: 1 } } });
          } catch {
            logger.error(`[spider] could not count a sent summary text for summary ${summary.id}`);
          }
        },
      });
      results.text = sent.results;
      delivery.text = { outcome: sent.outcome, recipients: sent.recipients };
    } catch (err) {
      channelFailed('text', err);
      results.text = recipients.map((r) => ({ user_id: r.id, result: 'failed' as const, reason: TEXT_REASON.failed }));
      delivery.text = { outcome: TEXT_OUTCOME.failed, recipients: recipients.map((r) => ({ user_id: r.id, outcome: TEXT_OUTCOME.failed })) };
    }
  } else {
    delivery.text = { outcome: TEXT_OUTCOME.channelOff };
  }

  // Each summarized lead's History row: how its people were told, through the summary.
  for (const c of claimed) {
    const mine = (list: RecipientResult[]) => list.filter((x) => c.recipient_ids.includes(x.user_id));
    const inAppSent = c.recipient_ids.some((id) => results.in_app.has(id));
    const channels = {
      in_app: { enabled: a.channels.in_app, status: a.channels.in_app && inAppSent ? 'SENT' : 'SKIPPED' },
      email: { ...channelRecord(a.channels.email, mine(results.email)), from: SPIDER_EMAIL_FROM_LINE },
      sms: channelRecord(a.channels.text, mine(results.text)),
    };
    await prisma.spiderAlert
      .update({ where: { id: c.id }, data: { channels: channels as unknown as Prisma.InputJsonValue } })
      .catch(() => logger.error(`[spider] could not record delivery for summarized alert ${c.id}`));
  }

  try {
    await prisma.spiderSummary.update({
      where: { id: summary.id },
      data: {
        lead_count: claimed.length,
        recipient_count: recipients.length,
        delivery: delivery as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    logger.error(`[spider] could not record delivery for summary ${summary.id}`);
  }
  logger.info('[spider] starting summary sent', { orgId: a.orgId, summaryId: summary.id, leads: claimed.length, recipients: recipients.length });
  return { summaryId: summary.id, leads: claimed.length, recipients: recipients.length };
}

// ─── Reading a summary ───────────────────────────────────────────────────────

export interface SummaryRow {
  lead_id: string;
  lead_number: string;
  customer_name: string;
  address: string;
  stage: SpiderStatus;
  /** The stage name, as the alerts name it. */
  stage_name: string;
  entered_stage_at: string;
  in_stage: string;
  limit: string;
  over_by: string;
  over_by_ms: number;
  owner_name: string | null;
  /** Whether the lead has left that stage visit since. */
  moved_on: boolean;
  /** Where it is now, when it has moved on: a stage name, else the lead's status. */
  moved_to: string | null;
}

export interface SummaryView {
  id: string;
  created_at: string;
  triggered_at: string;
  trigger_kind: SpiderTriggerKind;
  scope: 'mine' | 'company';
  show_owner: boolean;
  total: number;
  still_waiting: number;
  moved_on: number;
  leads: SummaryRow[];
}

/**
 * The company's latest summary as one person may read it: `forUser` set reads only the leads that
 * person was told about and can still open (`leadScope` is their row scope on leads); unset reads the
 * whole company (Admins). Null when there is no summary, or none of it is this person's.
 */
export async function readSpiderSummary(a: {
  orgId: string;
  forUser: { id: string; leadScope: Prisma.LeadWhereInput } | null;
  now?: Date;
}): Promise<SummaryView | null> {
  const summary = await prisma.spiderSummary.findUnique({ where: { organization_id: a.orgId } });
  if (!summary) return null;
  const claims = await prisma.spiderAlert.findMany({
    where: {
      organization_id: a.orgId,
      summary_id: summary.id,
      ...(a.forUser ? { recipient_ids: { has: a.forUser.id } } : {}),
    },
    select: {
      lead_id: true,
      status: true,
      entered_status_at: true,
      limit_value: true,
      limit_unit: true,
      alerted_at: true,
      lead_number: true,
      customer_name: true,
      service_location: true,
    },
  });
  if (claims.length === 0) return null;
  const leads = await prisma.lead.findMany({
    where: {
      AND: [
        { organization_id: a.orgId, id: { in: claims.map((c) => c.lead_id) } },
        ...(a.forUser ? [a.forUser.leadScope] : []),
      ],
    },
    select: {
      id: true,
      commission_owner_id: true,
      commission_owner: { select: { first_name: true, last_name: true } },
      ...SPIDER_LEAD_TIMES_SELECT,
    },
  });
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const rows: (SummaryRow & { owner_id: string | null })[] = claims.flatMap((c) => {
    const lead = leadById.get(c.lead_id);
    if (!lead) return [];
    const stage = c.status as SpiderStatus;
    const inStageMs = c.alerted_at.getTime() - c.entered_status_at.getTime();
    const limit = limitMs(c.limit_value, c.limit_unit as SpiderUnit);
    const visit = spiderStageOf(lead);
    const movedOn = !visit || visit.stage !== stage || visit.enteredAt.getTime() !== c.entered_status_at.getTime();
    const movedTo = !movedOn ? null : visit ? SPIDER_STAGE_NAME[visit.stage] : LEAD_STATUS_LABEL[lead.status];
    return [
      {
        lead_id: c.lead_id,
        lead_number: c.lead_number ?? `Lead #${c.lead_id.slice(0, 6)}`,
        customer_name: c.customer_name ?? 'Customer',
        address: c.service_location ?? 'Service location on file',
        stage,
        stage_name: SPIDER_STAGE_NAME[stage] ?? LEAD_STATUS_LABEL[stage],
        entered_stage_at: c.entered_status_at.toISOString(),
        in_stage: summaryDuration(inStageMs),
        limit: summaryDuration(limit),
        over_by: summaryDuration(overByMs({ inStageMs, limitMs: limit })),
        over_by_ms: inStageMs - limit,
        owner_name: personName(lead.commission_owner),
        owner_id: lead.commission_owner_id,
        moved_on: movedOn,
        moved_to: movedTo,
      },
    ];
  });
  if (rows.length === 0) return null;
  rows.sort((x, y) => y.over_by_ms - x.over_by_ms || x.lead_number.localeCompare(y.lead_number));
  const movedOn = rows.filter((r) => r.moved_on).length;
  const forUser = a.forUser;
  return {
    id: summary.id,
    created_at: summary.created_at.toISOString(),
    triggered_at: summary.triggered_at.toISOString(),
    trigger_kind: isTriggerKind(summary.trigger_kind) ? summary.trigger_kind : 'SETTINGS_CHANGED',
    scope: forUser ? 'mine' : 'company',
    show_owner: !forUser || !rows.every((r) => r.owner_id === forUser.id),
    total: rows.length,
    still_waiting: rows.length - movedOn,
    moved_on: movedOn,
    leads: rows.map(({ owner_id: _owner, ...r }) => r),
  };
}
