/**
 * Spider's History tab (slice S3): what the contractor's table, filters, export and preview drawer
 * read (his SpiderWatcherPage.tsx History tab at 3bb6606), built from our alert log.
 *
 * Rows written since S3 carry their own copy, taken when the alert went out (sweep.ts). The list of
 * people is the exception since #3107: a row stores it once in a recipient set it points at
 * (recipientSets.ts) and holds none of its own; a row from before that keeps its own list. Both read
 * the same (storedRecipients). Rows from before S3 show what they do hold, honestly:
 *   - lead number, customer, company, request and address are read from the lead as it is now (as
 *     his own screen did, from the live lead list);
 *   - people are named as they are now, with no "how they were chosen";
 *   - the time in the stage is worked out from the two instants the row stored;
 *   - the per-channel outcome is read back from our own fixed sentences (delivery.ts wording);
 *   - message texts were never stored, so none is claimed.
 * A channel or outcome that cannot be known is null - never his "Sent" default.
 *
 * Search and every filter run on the server, so they reach every page (his filtered the one page
 * on screen).
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';
import { customerName } from './config';
import {
  EMAIL_OUTCOME,
  EMAIL_REASON,
  SPIDER_EMAIL_FROM_LINE,
  TEXT_OUTCOME,
  TEXT_REASON,
  channelRecord,
  type ChannelRecord,
  type ChannelStatus,
  type RecipientResult,
} from './delivery';
import { resolveServiceAddress, SPIDER_STAGE_NAME } from './messages';

// ─── Query parameters ────────────────────────────────────────────────────────

/** His Stage facet, limited to the three stages Spider alerts on. "Walkthrough" also finds older alerts raised for Walkthrough Scheduled. */
export const HISTORY_STAGE_STATUSES = {
  NEW: ['NEW'],
  CONTACTED: ['CONTACTED'],
  WALKTHROUGH: ['WALKTHROUGH_COMPLETED', 'WALKTHROUGH_SCHEDULED'],
} as const;
export type HistoryStage = keyof typeof HISTORY_STAGE_STATUSES;

/** His Role facet: the four roles. */
export const HISTORY_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;
export type HistoryRole = (typeof HISTORY_ROLES)[number];

export const HISTORY_MAX_PAGE_SIZE = 100;
/** The most rows one "All filtered" export carries. */
export const HISTORY_EXPORT_MAX = 5000;

/** Ids per list: the body carries them (POST), so the cap only bounds the work, never the URL. */
const MAX_IDS = 10_000;
const MAX_RANGES = 10;

/** "a,b,c" (or a repeated parameter) to a trimmed list. */
const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)));

const isoInstant = z.string().datetime({ offset: true });

const rangeSchema = z
  .string()
  .transform((s, ctx) => {
    const [from, to, ...rest] = s.split('~');
    if (rest.length > 0 || !isoInstant.safeParse(from).success || !isoInstant.safeParse(to).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A date range is two instants, from~to' });
      return z.NEVER;
    }
    const range = { from: new Date(from), to: new Date(to) };
    if (range.to < range.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A date range cannot end before it starts' });
      return z.NEVER;
    }
    return range;
  });

export const historyFiltersSchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  stage: csv.pipe(z.array(z.enum(['NEW', 'CONTACTED', 'WALKTHROUGH'])).max(3)),
  ranges: csv.pipe(z.array(rangeSchema).max(MAX_RANGES)),
  recipients: csv.pipe(z.array(z.string().uuid()).max(MAX_IDS)),
  customers: csv.pipe(z.array(z.string().uuid()).max(MAX_IDS)),
  roles: csv.pipe(z.array(z.enum(HISTORY_ROLES)).max(HISTORY_ROLES.length)),
});
export type HistoryFilters = z.infer<typeof historyFiltersSchema>;

export const historyQuerySchema = historyFiltersSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  // A larger page size is clamped to the maximum, not refused.
  page_size: z.coerce.number().int().min(1).default(25).transform((n) => Math.min(n, HISTORY_MAX_PAGE_SIZE)),
});

export const historySummarySchema = z.object({
  since: isoInstant.optional(),
});

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

/**
 * The rows the toolbar asks for, within the caller's company. `roleUserIds` are the company's
 * people holding one of the chosen roles now: an alert from before S3 has no stored role, so it
 * matches on who those people are today.
 */
export function historyWhere(
  base: Prisma.SpiderAlertWhereInput,
  f: HistoryFilters,
  roleUserIds: readonly string[],
): Prisma.SpiderAlertWhereInput {
  const and: Prisma.SpiderAlertWhereInput[] = [];
  if (f.stage.length > 0) {
    and.push({ status: { in: f.stage.flatMap((s) => [...HISTORY_STAGE_STATUSES[s]]) } });
  }
  if (f.ranges.length > 0) {
    and.push({ OR: f.ranges.map((r) => ({ alerted_at: { gte: r.from, lte: r.to } })) });
  }
  if (f.recipients.length > 0) {
    and.push({ recipient_ids: { hasSome: f.recipients } });
  }
  if (f.customers.length > 0) {
    and.push({
      OR: [{ customer_id: { in: f.customers } }, { customer_id: null, lead: { customer_id: { in: f.customers } } }],
    });
  }
  if (f.roles.length > 0) {
    and.push({
      OR: [
        // The role each person had when alerted, from the list the row holds: its own (older rows) or its stored set.
        ...f.roles.flatMap((role) => [
          { recipients: { array_contains: [{ role }] } },
          { recipient_set: { is: { recipients: { array_contains: [{ role }] } } } },
        ]),
        // His "Administrator (Owner)" also matched the people alerted as the lead's owner.
        ...(f.roles.includes('ADMIN')
          ? [
              { recipients: { array_contains: [{ type: 'owner' }] } },
              { recipient_set: { is: { recipients: { array_contains: [{ type: 'owner' }] } } } },
            ]
          : []),
        // Only a row with no list anywhere (before S3) is matched on who holds the role now.
        { recipients: { equals: Prisma.DbNull }, recipient_set_id: null, recipient_ids: { hasSome: [...roleUserIds] } },
      ],
    });
  }
  if (f.search) {
    const q = f.search;
    // His search: lead number, address, customer, stage and request. Plus the company (his column
    // shows it). An alert from before S3 is matched on its lead as it is now.
    and.push({
      OR: [
        { lead_number: contains(q) },
        { customer_name: contains(q) },
        { company_name: contains(q) },
        { service_location: contains(q) },
        { service_request: contains(q) },
        { stage_name: contains(q) },
        { lead: { lead_number: contains(q) } },
        { lead: { service_request: contains(q) } },
        {
          lead: {
            customer: { OR: [{ first_name: contains(q) }, { last_name: contains(q) }, { company_name: contains(q) }] },
          },
        },
      ],
    });
  }
  return { ...base, AND: [SUMMARY_NOT_BUILDING, ...and] };
}

/**
 * History never lists a claim of a starting summary that is still being written (#3108): the summary is BUILDING until its
 * last claim is saved, and a half-written one must not be seen. Every other row is listed - an alert, a claim of a READY
 * summary, a claim of a SUPERSEDED one (kept for good), and a claim whose summary link is empty.
 */
export const SUMMARY_NOT_BUILDING: Prisma.SpiderAlertWhereInput = {
  OR: [{ summary_id: null }, { summary: { is: { OR: [{ status: null }, { status: { not: 'BUILDING' } }] } } }],
};

// ─── One row ─────────────────────────────────────────────────────────────────

const LOCATION_SELECT = { address_line1: true, address_line2: true, city: true, state: true, zip: true } as const;

/** What one history row reads from the database. */
export const HISTORY_ROW_SELECT = {
  id: true,
  lead_id: true,
  status: true,
  entered_status_at: true,
  alerted_at: true,
  limit_value: true,
  limit_unit: true,
  recipient_ids: true,
  delivery: true,
  lead_number: true,
  customer_id: true,
  customer_name: true,
  company_name: true,
  service_request: true,
  service_location: true,
  stage_name: true,
  elapsed_value: true,
  elapsed_unit: true,
  channels: true,
  recipients: true,
  // The list a newer row points at (recipientSets.ts); an older row holds its own in `recipients`.
  recipient_set: { select: { recipients: true } },
  email_subject: true,
  email_body: true,
  sms_message: true,
  in_app_message: true,
  kind: true,
  lead: {
    select: {
      lead_number: true,
      customer_id: true,
      service_request: true,
      customer: {
        select: {
          first_name: true,
          last_name: true,
          company_name: true,
          service_locations: { select: { ...LOCATION_SELECT, is_primary: true }, orderBy: { created_at: 'asc' as const } },
        },
      },
      service_location: { select: LOCATION_SELECT },
    },
  },
} as const satisfies Prisma.SpiderAlertSelect;

export type HistoryRow = Prisma.SpiderAlertGetPayload<{ select: typeof HISTORY_ROW_SELECT }>;

export interface HistoryUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
}

export type InAppRecord = { enabled: boolean; status: 'SENT' | 'SKIPPED' };
export interface HistoryChannels {
  email: ChannelRecord | null;
  sms: ChannelRecord | null;
  in_app: InAppRecord | null;
}

export type HistoryOutcome = 'SENT' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export interface HistoryRecipient {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  /** How they were chosen: owner / user / admin. Unknown (null) on alerts from before S3. */
  type: string | null;
  /** The old History screen's per-person outcome sentences, kept so an older frontend still renders. */
  email_outcome: string | null;
  text_outcome: string | null;
}

export interface HistoryItem {
  id: string;
  lead_id: string;
  lead_number: string;
  customer_id: string | null;
  customer_name: string;
  company_name: string | null;
  service_request: string | null;
  service_location: string;
  status: string;
  stage_name: string;
  elapsed: { value: number; unit: string };
  alerted_at: string;
  outcome: HistoryOutcome | null;
  /** The contractor's per-channel outcome (SENT / FAILED / SKIPPED with counts). */
  outcomes: HistoryChannels;
  recipients: HistoryRecipient[];
  /** Reported in a starting summary (#2794) rather than alerted on its own. */
  in_starting_summary: boolean;
  // ─── The fields the History screen read before S3, in their old shape, so a frontend deployed
  // before this backend (or after it, rolled back) still renders. ───
  status_label: string;
  entered_status_at: string;
  limit: { value: number; unit: string };
  /** One plain-words outcome sentence per channel, as before. */
  channels: { in_app: string | null; email: string | null; text: string | null };
  email_subject: string | null;
  email_body: string | null;
  sms_message: string | null;
  in_app_message: string | null;
}

const UNIT_MS: Record<string, number> = { MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 };
const STATUSES: readonly ChannelStatus[] = ['SENT', 'FAILED', 'SKIPPED'];

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strOrNull = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

/** A stored channel record. One the alert never finished writing (no status) is unknown. */
function storedChannel(v: unknown): ChannelRecord | null {
  const c = obj(v);
  if (!c || typeof c.enabled !== 'boolean') return null;
  if (!c.enabled) return { ...channelRecord(false, []), ...(strOrNull(c.from) ? { from: c.from as string } : {}) };
  if (!STATUSES.includes(c.status as ChannelStatus)) return null;
  return {
    enabled: true,
    status: c.status as ChannelStatus,
    sent: num(c.sent),
    skipped: num(c.skipped),
    failed: num(c.failed),
    error: strOrNull(c.error),
    skip_reason: strOrNull(c.skip_reason),
    ...(strOrNull(c.from) ? { from: c.from as string } : {}),
  };
}

function storedInApp(v: unknown): InAppRecord | null {
  const c = obj(v);
  if (!c || typeof c.enabled !== 'boolean') return null;
  if (!c.enabled) return { enabled: false, status: 'SKIPPED' };
  return c.status === 'SENT' || c.status === 'SKIPPED' ? { enabled: true, status: c.status } : null;
}

// Our own fixed wording, before S3 (delivery.ts). Reasons are given in his wording where he had one.
const LEGACY_EMAIL_SKIP: Record<string, string> = {
  'address is suppressed': EMAIL_REASON.suppressed,
  'no email address on profile': EMAIL_REASON.noAddress,
};
const LEGACY_TEXT_SKIP: Record<string, string> = {
  'no phone number on profile': TEXT_REASON.noPhone,
};

function legacyResult(
  sentence: string,
  w: { sent: string; failed: string; failedReason: string; skippedPrefix: string; skipMap: Record<string, string> },
): Omit<RecipientResult, 'user_id'> | null {
  if (sentence === w.sent) return { result: 'sent', reason: null };
  if (sentence === w.failed) return { result: 'failed', reason: w.failedReason };
  if (sentence.startsWith(w.skippedPrefix)) {
    const why = sentence.slice(w.skippedPrefix.length);
    return { result: 'skipped', reason: w.skipMap[why] ?? why };
  }
  return null;
}

function legacyChannel(
  v: unknown,
  w: { off: string; sent: string; failed: string; failedReason: string; skippedPrefix: string; skipMap: Record<string, string> },
): ChannelRecord | null {
  const c = obj(v);
  const outcome = strOrNull(c?.outcome);
  if (!c || !outcome) return null;
  if (outcome === w.off) return channelRecord(false, []);
  if (outcome === 'No one to alert') return channelRecord(true, []);
  const people = Array.isArray(c.recipients) ? c.recipients : [];
  const results: RecipientResult[] = [];
  for (const p of people) {
    const sentence = strOrNull(obj(p)?.outcome);
    const r = sentence ? legacyResult(sentence, w) : null;
    if (!r) return null;
    results.push({ user_id: String(obj(p)?.user_id ?? ''), ...r });
  }
  return results.length > 0 ? channelRecord(true, results) : null;
}

/** An alert from before S3: its delivery sentences read back as his per-channel outcome. */
export function legacyChannels(delivery: unknown): HistoryChannels {
  const d = obj(delivery) ?? {};
  const email = legacyChannel(d.email, {
    off: EMAIL_OUTCOME.channelOff,
    sent: EMAIL_OUTCOME.sent,
    failed: EMAIL_OUTCOME.failed,
    failedReason: EMAIL_REASON.failed,
    skippedPrefix: 'Email skipped: ',
    skipMap: LEGACY_EMAIL_SKIP,
  });
  const sms = legacyChannel(d.text, {
    off: TEXT_OUTCOME.channelOff,
    sent: TEXT_OUTCOME.sent,
    failed: TEXT_OUTCOME.failed,
    failedReason: TEXT_REASON.failed,
    skippedPrefix: 'Text skipped: ',
    skipMap: LEGACY_TEXT_SKIP,
  });
  const inAppOutcome = strOrNull(obj(d.in_app)?.outcome);
  const in_app: InAppRecord | null =
    inAppOutcome === 'Shown in the app'
      ? { enabled: true, status: 'SENT' }
      : inAppOutcome === 'No one to alert in the app'
        ? { enabled: true, status: 'SKIPPED' }
        : inAppOutcome === 'In-app alerts are switched off'
          ? { enabled: false, status: 'SKIPPED' }
          : null;
  // Spider's sender has always been the one fixed address.
  return { email: email ? { ...email, from: SPIDER_EMAIL_FROM_LINE } : null, sms, in_app };
}

/** His alert-log status (spiderDispatch.service.ts): FAILED, PARTIAL, SENT or SKIPPED. Null unless every channel is known. */
export function overallOutcome(ch: HistoryChannels): HistoryOutcome | null {
  if (!ch.email || !ch.sms || !ch.in_app) return null;
  const sendChannels = [ch.email, ch.sms].filter((c) => c.enabled);
  if (sendChannels.some((c) => c.sent === 0 && c.failed > 0)) return 'FAILED';
  if (sendChannels.some((c) => c.sent > 0 && c.failed > 0)) return 'PARTIAL';
  if (sendChannels.some((c) => c.sent > 0) || ch.in_app.status === 'SENT') return 'SENT';
  return 'SKIPPED';
}

/** The stored delivery sentences (delivery.ts), per channel and per person. */
function sentencesOf(delivery: unknown) {
  const d = obj(delivery) ?? {};
  const channel = (key: string) => obj(d[key]) ?? {};
  const outcome = (key: string) => strOrNull(channel(key).outcome);
  const perPerson = (key: string, userId: string) => {
    const people = Array.isArray(channel(key).recipients) ? (channel(key).recipients as unknown[]) : [];
    const hit = people.map(obj).find((p) => p?.user_id === userId);
    return strOrNull(hit?.outcome);
  };
  return {
    channels: { in_app: outcome('in_app'), email: outcome('email'), text: outcome('text') },
    perPerson,
  };
}

/**
 * The list of people a row stored when it was written: the recipient set it points at (rows since #3107), else its own copy
 * (rows before). Null for a row from before S3, which stored none.
 */
export function storedRecipients(row: Pick<HistoryRow, 'recipients' | 'recipient_set'>): Prisma.JsonArray | null {
  const set = row.recipient_set?.recipients;
  if (Array.isArray(set)) return set;
  return Array.isArray(row.recipients) ? row.recipients : null;
}

function recipientsOf(row: HistoryRow, users: ReadonlyMap<string, HistoryUser>): HistoryRecipient[] {
  const { perPerson } = sentencesOf(row.delivery);
  const old = (id: string) => ({ email_outcome: perPerson('email', id), text_outcome: perPerson('text', id) });
  const stored = storedRecipients(row);
  if (stored) {
    return stored.flatMap((r) => {
      const o = obj(r);
      if (!o || typeof o.id !== 'string') return [];
      return [{
        id: o.id,
        name: strOrNull(o.name) ?? strOrNull(o.email) ?? 'Team Member',
        email: strOrNull(o.email),
        role: strOrNull(o.role),
        type: strOrNull(o.type),
        ...old(o.id),
      }];
    });
  }
  return row.recipient_ids.map((id) => {
    const u = users.get(id);
    if (!u) return { id, name: 'Former team member', email: null, role: null, type: null, ...old(id) };
    return { id, name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email, email: u.email, role: u.role, type: null, ...old(id) };
  });
}

function elapsedOf(row: HistoryRow): { value: number; unit: string } {
  if (row.elapsed_value !== null && row.elapsed_unit) return { value: row.elapsed_value, unit: row.elapsed_unit };
  const unit = UNIT_MS[row.limit_unit] ? row.limit_unit : 'DAY';
  const ms = row.alerted_at.getTime() - row.entered_status_at.getTime();
  return { value: Math.max(1, Math.floor(ms / UNIT_MS[unit])), unit };
}

export function historyItem(row: HistoryRow, users: ReadonlyMap<string, HistoryUser>): HistoryItem {
  const stored = obj(row.channels);
  const outcomes: HistoryChannels = stored
    ? { email: storedChannel(stored.email), sms: storedChannel(stored.sms), in_app: storedInApp(stored.in_app) }
    : legacyChannels(row.delivery);
  const status = row.status as keyof typeof LEAD_STATUS_LABEL;
  return {
    id: row.id,
    lead_id: row.lead_id,
    lead_number: row.lead_number ?? row.lead.lead_number,
    customer_id: row.customer_id ?? row.lead.customer_id,
    customer_name: row.customer_name ?? customerName(row.lead.customer),
    company_name: row.customer_name !== null ? row.company_name : row.lead.customer.company_name?.trim() || null,
    service_request: row.lead_number !== null ? row.service_request : row.lead.service_request || null,
    service_location: row.service_location ?? resolveServiceAddress(row.lead, row.lead.customer),
    status: row.status,
    stage_name:
      row.stage_name ??
      (status in SPIDER_STAGE_NAME ? SPIDER_STAGE_NAME[status as keyof typeof SPIDER_STAGE_NAME] : LEAD_STATUS_LABEL[status]),
    elapsed: elapsedOf(row),
    alerted_at: row.alerted_at.toISOString(),
    outcome: overallOutcome(outcomes),
    outcomes,
    recipients: recipientsOf(row, users),
    in_starting_summary: row.kind === 'SUMMARIZED',
    status_label: LEAD_STATUS_LABEL[status],
    entered_status_at: row.entered_status_at.toISOString(),
    limit: { value: row.limit_value, unit: row.limit_unit },
    channels: sentencesOf(row.delivery).channels,
    email_subject: row.email_subject,
    email_body: row.email_body,
    sms_message: row.sms_message,
    in_app_message: row.in_app_message,
  };
}
