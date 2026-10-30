/**
 * Spider lead watcher (#2619) - the one place that says what Spider watches and how its settings
 * are shaped.
 *
 * - The time units (Minute, Hour, Day) are defined ONCE here, for the settings validation and the
 *   sweep. There is no Second.
 * - Spider acts on three stages (Ran, 15 Oct, D2 - the contractor's build): New, Contacted and
 *   Walkthrough Completed. A lead's stage, and when it entered it, come from the lead's own
 *   timestamps by the contractor's rules (`spiderStageOf`). Won, Lost and Cancelled leads are never
 *   watched.
 * - The defaults and the three required checks are the contractor's (D3).
 */
import { z } from 'zod';
import type { LeadStatus, Prisma, Role } from '@prisma/client';
import { LEAD_STATUS_LABEL } from '../lead-stage.service';

// ─── Units ───────────────────────────────────────────────────────────────────

export const SPIDER_UNITS = ['MINUTE', 'HOUR', 'DAY'] as const;
export type SpiderUnit = (typeof SPIDER_UNITS)[number];

const MINUTE_MS = 60_000;
const UNIT_MS: Record<SpiderUnit, number> = {
  MINUTE: MINUTE_MS,
  HOUR: 60 * MINUTE_MS,
  DAY: 24 * 60 * MINUTE_MS,
};

export const SPIDER_UNIT_LABEL: Record<SpiderUnit, string> = {
  MINUTE: 'Minutes',
  HOUR: 'Hours',
  DAY: 'Days',
};

export function limitMs(value: number, unit: SpiderUnit): number {
  return value * UNIT_MS[unit];
}

/** The largest limit a status may carry: a year in any unit keeps the arithmetic sane. */
const MAX_LIMIT: Record<SpiderUnit, number> = { MINUTE: 525_600, HOUR: 8_760, DAY: 365 };

// ─── Stages ──────────────────────────────────────────────────────────────────

/**
 * The three stages Spider acts on, keyed by the lead status each one is named after (so the stored
 * settings, the alert log's `status` column and its once-per-visit key keep their shape). The
 * screen labels them "New → Contacted", "Contacted → Walkthrough Scheduled" and
 * "Walkthrough Completed → Estimate".
 */
export const SPIDER_WATCHED_STATUSES = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_COMPLETED',
] as const satisfies readonly LeadStatus[];
export type SpiderStatus = (typeof SPIDER_WATCHED_STATUSES)[number];

export function isWatchedStatus(status: string): status is SpiderStatus {
  return (SPIDER_WATCHED_STATUSES as readonly string[]).includes(status);
}

/**
 * The two stages Spider no longer watches (Ran, 15 Oct, D2). A screen from before then still sends
 * their limits: they are accepted and dropped, never stored.
 */
const RETIRED_STAGES = ['WALKTHROUGH_SCHEDULED', 'ESTIMATED'] as const;

/** What `spiderStageOf` reads on a lead. */
export interface SpiderLeadTimes {
  status: LeadStatus;
  created_at: Date;
  contacted_at: Date | null;
  /** SPEC-4 D7: when the lead last moved back to New with no outbound contact left; null if never. */
  returned_to_new_at: Date | null;
  walkthrough_first_booked_at: Date | null;
  last_visit_completed_at: Date | null;
  first_estimate_sent_at: Date | null;
  won_at: Date | null;
  lost_at: Date | null;
  cancelled_at: Date | null;
}

export const SPIDER_LEAD_TIMES_SELECT = {
  status: true,
  created_at: true,
  contacted_at: true,
  returned_to_new_at: true,
  walkthrough_first_booked_at: true,
  last_visit_completed_at: true,
  first_estimate_sent_at: true,
  won_at: true,
  lost_at: true,
  cancelled_at: true,
} as const satisfies Prisma.LeadSelect;

/**
 * The lead's Spider stage and the instant it entered it, or null when it is in none - the
 * contractor's rules (spiderWatcherCron.ts), in his order:
 *
 *   New                    no contacted_at, status New, no walkthrough booked or completed - from creation,
 *                          or from returned_to_new_at when the lead moved back to New (SPEC-4 D7): a
 *                          fresh stay, with its own claim key, so it alerts again once per stay
 *   Contacted              status New or Contacted, with contacted_at or status Contacted, no
 *                          walkthrough booked or completed - from contacted_at, else creation
 *   Walkthrough Completed  last_visit_completed_at and no estimate sent - from last_visit_completed_at
 *
 * Two fixes to his rules, both so the server watches exactly the leads his screen lists:
 *   - Won, Lost and Cancelled leads are in no stage (his query excluded them; this does it here).
 *     His query also never fetched Walkthrough Scheduled or Walkthrough Completed leads, so his
 *     third stage could not fire for a completed walkthrough; those leads are read now, for that
 *     stage only (Contacted still takes only New and Contacted leads, as his query did).
 *   - A lead that reached Estimate (status Estimate Sent, or an estimate sent) is past New and
 *     Contacted. His screen never listed one; his sweep alerted it as "contacted, but a walkthrough
 *     has not yet been scheduled".
 */
export function spiderStageOf(l: SpiderLeadTimes): { stage: SpiderStatus; enteredAt: Date } | null {
  if (l.status === 'WON' || l.status === 'LOST' || l.won_at || l.lost_at || l.cancelled_at) return null;
  const pastEstimate = l.status === 'ESTIMATED' || !!l.first_estimate_sent_at;
  const noWalkthrough = !l.walkthrough_first_booked_at && !l.last_visit_completed_at;
  if (!l.contacted_at && l.status === 'NEW' && noWalkthrough && !pastEstimate) {
    return { stage: 'NEW', enteredAt: l.returned_to_new_at ?? l.created_at };
  }
  // His query fetched only New, Contacted and Estimate Sent leads, so a Walkthrough Scheduled or
  // Walkthrough Completed lead with no visit timestamps was never "contacted, walkthrough not scheduled".
  const newOrContacted = l.status === 'NEW' || l.status === 'CONTACTED';
  if ((l.contacted_at || l.status !== 'NEW') && newOrContacted && noWalkthrough && !pastEstimate) {
    return { stage: 'CONTACTED', enteredAt: l.contacted_at ?? l.created_at };
  }
  if (l.last_visit_completed_at && !l.first_estimate_sent_at) {
    return { stage: 'WALKTHROUGH_COMPLETED', enteredAt: l.last_visit_completed_at };
  }
  return null;
}

export const SPIDER_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const satisfies readonly Role[];

// ─── Settings shape ──────────────────────────────────────────────────────────

export interface SpiderStatusLimit {
  enabled: boolean;
  value: number;
  unit: SpiderUnit;
}

export interface SpiderChannels {
  in_app: boolean;
  red_frame: boolean;
  email: boolean;
  text: boolean;
}

export interface SpiderRecipients {
  roles: Role[];
  user_ids: string[];
  lead_owner: boolean;
}

export interface SpiderSettingsView {
  is_active: boolean;
  activated_at: string | null;
  status_limits: Record<SpiderStatus, SpiderStatusLimit>;
  channels: SpiderChannels;
  recipients: SpiderRecipients;
  watch_all_leads: boolean;
  selected_lead_ids: string[];
  updated_at: string | null;
}

/**
 * The contractor's defaults (Ran, 15 Oct, D3; his store's DEFAULT_LEAD_STAGES): every stage off,
 * counted in minutes. The value is never read while a stage is off; the screen shows it empty.
 */
export function defaultStatusLimits(): Record<SpiderStatus, SpiderStatusLimit> {
  return Object.fromEntries(
    SPIDER_WATCHED_STATUSES.map((s) => [s, { enabled: false, value: 1, unit: 'MINUTE' as SpiderUnit }]),
  ) as Record<SpiderStatus, SpiderStatusLimit>;
}

/** His defaults: every channel on, all four roles and the lead's owner. */
export const DEFAULT_CHANNELS: SpiderChannels = { in_app: true, red_frame: true, email: true, text: true };
export const DEFAULT_RECIPIENTS: SpiderRecipients = { roles: [...SPIDER_ROLES], user_ids: [], lead_owner: true };

/** The contractor's three required checks (his save dialog), in his words. */
export const SPIDER_REQUIRED_MESSAGES = {
  channel: 'Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).',
  recipient: 'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
  stage: 'Please set at least one stage duration threshold greater than 0.',
} as const;

// ─── Validation (the update body) ────────────────────────────────────────────

const limitSchema = z
  .object({
    enabled: z.boolean(),
    value: z.number().int('Limit must be a whole number').positive('Limit must be greater than zero'),
    unit: z.enum(SPIDER_UNITS, { errorMap: () => ({ message: 'Unit must be Minutes, Hours or Days' }) }),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.value > MAX_LIMIT[l.unit]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Limit can be at most one year' });
    }
  });

const statusLimitsSchema = z
  .record(z.string(), limitSchema)
  .superRefine((limits, ctx) => {
    for (const key of Object.keys(limits)) {
      if (!isWatchedStatus(key) && !(RETIRED_STAGES as readonly string[]).includes(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Unknown lead status' });
      }
    }
  })
  // The retired stages are accepted from an older screen and dropped here, so they are never stored.
  .transform((limits) => Object.fromEntries(Object.entries(limits).filter(([key]) => isWatchedStatus(key))));

/** Why a settings save is refused while Spider is off. Shown to the Admin as it is. */
export const SPIDER_OFF_SETTINGS_MESSAGE = 'Spider is off. Turn it on to change its settings.';

export const updateSpiderSettingsSchema = z
  .object({
    // Accepted and IGNORED: the switch is PUT /spider/status alone (Ran, 14 Oct). Kept optional so a
    // frontend from before that change (the frontend and backend deploy separately) still saves.
    is_active: z.boolean().optional(),
    status_limits: statusLimitsSchema,
    channels: z
      .object({ in_app: z.boolean(), red_frame: z.boolean(), email: z.boolean(), text: z.boolean() })
      .strict(),
    recipients: z
      .object({
        roles: z.array(z.enum(SPIDER_ROLES)).max(SPIDER_ROLES.length),
        user_ids: z.array(z.string().uuid()).max(500),
        lead_owner: z.boolean(),
      })
      .strict(),
    watch_all_leads: z.boolean(),
    selected_lead_ids: z.array(z.string().uuid()).max(5000),
  })
  .strict()
  // The contractor's three required checks (Ran, 15 Oct, D3). Spider may still be switched ON with
  // nothing set up (the switch is separate, 14 Oct); it then watches nothing until a save passes these.
  .superRefine((b, ctx) => {
    if (!Object.values(b.channels).some(Boolean)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channels'], message: SPIDER_REQUIRED_MESSAGES.channel });
    }
    if (!hasRecipient(b.recipients)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients'], message: SPIDER_REQUIRED_MESSAGES.recipient });
    }
    if (!Object.values(b.status_limits).some((l) => l.enabled && l.value > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status_limits'], message: SPIDER_REQUIRED_MESSAGES.stage });
    }
  });

/** At least one role, one person or the lead's owner. */
export function hasRecipient(r: { roles: readonly unknown[]; user_ids: readonly unknown[]; lead_owner: boolean }): boolean {
  return r.roles.length > 0 || r.user_ids.length > 0 || r.lead_owner;
}

export type UpdateSpiderSettingsBody = z.infer<typeof updateSpiderSettingsSchema>;

/** The AI Agentic Farm's on/off switch: only the one flag, nothing else in the settings. */
export const setSpiderActiveSchema = z.object({ isActive: z.boolean() }).strict();

export type SetSpiderActiveBody = z.infer<typeof setSpiderActiveSchema>;

// ─── Reading stored rows ─────────────────────────────────────────────────────

/** A stored JSON value as a plain object, or null when it is anything else. */
function asObject(raw: Prisma.JsonValue | undefined): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * The stored JSON, read defensively: anything the validation would not have accepted (an unknown
 * unit, a non-positive value) reads as switched off, so a bad row can never make the sweep alert.
 */
export function readStatusLimits(raw: Prisma.JsonValue | undefined): Record<SpiderStatus, SpiderStatusLimit> {
  const limits = defaultStatusLimits();
  const obj = asObject(raw) ?? {};
  for (const status of SPIDER_WATCHED_STATUSES) {
    const parsed = limitSchema.safeParse(obj[status]);
    if (parsed.success) limits[status] = parsed.data;
  }
  return limits;
}

/**
 * Whether a company has set Spider up: its stored row watches at least one status with a time
 * limit. Independent of the switch: Spider may be on before it is set up, and watches nothing until
 * then. No row is never set up.
 */
export function isSpiderSetUp(row: { status_limits: Prisma.JsonValue } | null | undefined): boolean {
  if (!row) return false;
  return Object.values(readStatusLimits(row.status_limits)).some((l) => l.enabled);
}

export function readChannels(raw: Prisma.JsonValue | undefined): SpiderChannels {
  const obj = asObject(raw);
  if (!obj) return { ...DEFAULT_CHANNELS };
  const flag = (k: keyof SpiderChannels) => (typeof obj[k] === 'boolean' ? (obj[k] as boolean) : DEFAULT_CHANNELS[k]);
  return { in_app: flag('in_app'), red_frame: flag('red_frame'), email: flag('email'), text: flag('text') };
}

/** A key never saved reads as the default (a row the switch created holds `{}`). */
export function readRecipients(raw: Prisma.JsonValue | undefined): SpiderRecipients {
  const obj = asObject(raw) ?? {};
  const roles = Array.isArray(obj.roles)
    ? (obj.roles.filter((r) => (SPIDER_ROLES as readonly unknown[]).includes(r)) as Role[])
    : [...DEFAULT_RECIPIENTS.roles];
  const user_ids = Array.isArray(obj.user_ids) ? obj.user_ids.filter((u): u is string => typeof u === 'string') : [];
  const lead_owner = typeof obj.lead_owner === 'boolean' ? obj.lead_owner : DEFAULT_RECIPIENTS.lead_owner;
  return { roles, user_ids, lead_owner };
}

export interface SpiderSettingsRow {
  is_active: boolean;
  activated_at: Date | null;
  status_limits: Prisma.JsonValue;
  channels: Prisma.JsonValue;
  recipients: Prisma.JsonValue;
  watch_all_leads: boolean;
  selected_lead_ids: string[];
  updated_at: Date;
}

export function settingsView(row: SpiderSettingsRow | null): SpiderSettingsView {
  return {
    is_active: row?.is_active ?? false,
    activated_at: row?.activated_at?.toISOString() ?? null,
    status_limits: readStatusLimits(row?.status_limits),
    channels: readChannels(row?.channels),
    recipients: readRecipients(row?.recipients),
    watch_all_leads: row?.watch_all_leads ?? true,
    selected_lead_ids: row?.selected_lead_ids ?? [],
    updated_at: row?.updated_at?.toISOString() ?? null,
  };
}

/** What the screen needs to draw the form, so it never keeps its own copy of these lists. */
export function settingsOptions() {
  return {
    statuses: SPIDER_WATCHED_STATUSES.map((value) => ({ value, label: LEAD_STATUS_LABEL[value] })),
    units: SPIDER_UNITS.map((value) => ({ value, label: SPIDER_UNIT_LABEL[value] })),
    roles: SPIDER_ROLES.map((value) => ({ value, label: ROLE_LABEL[value] })),
  };
}

const ROLE_LABEL: Record<(typeof SPIDER_ROLES)[number], string> = {
  ADMIN: 'Admin',
  SALES: 'Sales',
  DISPATCHER: 'Dispatcher',
  TECHNICIAN: 'Technician',
};

/** "Pat Payer", else the company name, else "Customer" - how Spider names a lead's customer everywhere. */
export function customerName(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_name?.trim() || 'Customer';
}
