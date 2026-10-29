/**
 * Spider lead watcher (#2619) - the one place that says what Spider watches and how its settings
 * are shaped.
 *
 * - The time units (Minute, Hour, Day) are defined ONCE here. The settings validation, the sweep
 *   and the screen all use them: the screen reads them from the settings endpoint's `options`
 *   rather than keeping its own list. There is no Second.
 * - The five watched statuses are the open lead statuses. Won, Lost and Cancelled are never
 *   watched.
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

// ─── Statuses ────────────────────────────────────────────────────────────────

export const SPIDER_WATCHED_STATUSES = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
  'ESTIMATED',
] as const satisfies readonly LeadStatus[];
export type SpiderStatus = (typeof SPIDER_WATCHED_STATUSES)[number];

export function isWatchedStatus(status: string): status is SpiderStatus {
  return (SPIDER_WATCHED_STATUSES as readonly string[]).includes(status);
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

/** Off by default (decided 28 Sep). Every status starts switched off with a one-day limit. */
export function defaultStatusLimits(): Record<SpiderStatus, SpiderStatusLimit> {
  return Object.fromEntries(
    SPIDER_WATCHED_STATUSES.map((s) => [s, { enabled: false, value: 1, unit: 'DAY' as SpiderUnit }]),
  ) as Record<SpiderStatus, SpiderStatusLimit>;
}

export const DEFAULT_CHANNELS: SpiderChannels = { in_app: true, red_frame: true, email: false, text: false };
// Nobody configured by default, which alerts the Admins (#2619's recipient rule).
export const DEFAULT_RECIPIENTS: SpiderRecipients = { roles: [], user_ids: [], lead_owner: false };

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
      if (!isWatchedStatus(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Unknown lead status' });
      }
    }
  });

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
  // Spider may be on with no status switched on (Ran, 14 Oct: the switch first, then the setup).
  // It then watches nothing: the sweep alerts only on enabled statuses.
  .strict();

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

export function readRecipients(raw: Prisma.JsonValue | undefined): SpiderRecipients {
  const obj = asObject(raw);
  if (!obj) return { ...DEFAULT_RECIPIENTS, roles: [], user_ids: [] };
  const roles = Array.isArray(obj.roles)
    ? (obj.roles.filter((r) => (SPIDER_ROLES as readonly unknown[]).includes(r)) as Role[])
    : [];
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
