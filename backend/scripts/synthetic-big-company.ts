#!/usr/bin/env npx tsx
/**
 * Synthetic big company (#2984): a scale fixture for measuring Spider (and anything else) at the size
 * of a large customer, without any real customer's data.
 *
 *   npx tsx scripts/synthetic-big-company.ts seed   [--customers N] [--overdue-leads N] [--staff N] [--chunk-size N]
 *   npx tsx scripts/synthetic-big-company.ts status
 *   npx tsx scripts/synthetic-big-company.ts delete
 *
 * The sizes may also come from SYNTHETIC_COMPANY_CUSTOMERS, SYNTHETIC_COMPANY_OVERDUE_LEADS and
 * SYNTHETIC_COMPANY_STAFF (an argument wins). Defaults: 15,000 customers, 5,000 open leads already past
 * a Spider limit, 60 staff who can receive Spider alerts.
 *
 * What it builds: ONE company with a fixed id, marked as a demo company (`is_demo`), on the Scale plan
 * (so Spider is available to it), with Spider limits on New and Contacted and Spider switched OFF. Every
 * name is generated ("Alex Sample 00042"), every email is on a reserved `.invalid` domain, every phone
 * number is in the 555-0100..0199 range kept for fiction. Each overdue lead's stage entry time (its
 * creation for New, its contacted time for Contacted, as `spiderStageOf` reads them) lies between a
 * little and about two months past its limit, so a starting summary would cover every one of them.
 * The seed itself starts nothing: switching Spider on (Activate, "Send") records the starting trigger, and with the check
 * running (SPIDER_WATCH_LIST=check) the first check after it builds the summary at once (#3471; no quiet period). The leads'
 * watch rows (spider_lead_watch) are written by the database's own triggers as the leads are inserted, and go with the
 * leads on delete.
 *
 * No passwords: staff rows are active and marked able to sign in (what Spider's recipient rule reads),
 * but no sign-in account is created for any of them and no password is ever made.
 *
 * Safety:
 * - Never production. It runs only against a database on this machine (localhost, 127.0.0.1, ::1), or
 *   a remote one the person running it names at run time: its host in E2E_ALLOWED_DB_HOSTS AND its
 *   project ref (which appears in the user name or the host) in E2E_ALLOWED_DB_REF - the same two
 *   variables the end-to-end test company provisioning uses. Nothing about production is in this
 *   file: any database not named that way is refused. It also refuses under NODE_ENV=production.
 * - Seed refuses when the company (or any of its staff emails) already exists; it never doubles data.
 * - Delete takes no company argument. It removes only the company with the fixed id, and only when
 *   that row still carries all three markers (the fixed name, the fixed email, `is_demo`). Every
 *   statement it runs is scoped to that one id.
 */
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import type { LeadStatus, PrismaClient, Role } from '@prisma/client';
import { createCompanyWithMainMailbox, issueUserMailbox } from '../src/lib/mailbox/register';
import { seedStarterTaskCategories } from '../src/lib/tasks/categories';
import { seedListRows } from '../src/lib/org-list-rows';
import { setFirstOwner } from '../src/lib/users/first-owner';
import { formatRecordNumber } from '../src/lib/numbering';
import { purgeCustomerSubtree, purgeOrganization } from '../src/lib/purge';
// The client connects on its first query, which comes only after checkDatabaseTarget passes.
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { DEFAULT_CHANNELS, DEFAULT_RECIPIENTS, SPIDER_LEAD_TIMES_SELECT, limitMs, readStatusLimits, spiderStageOf } from '../src/services/spider/config';

// ─── Identity and markers ────────────────────────────────────────────────────

export const SYNTHETIC_COMPANY_ID = '5ca1ef1c-0000-4000-8000-000000000001';
/** The purge's name guard: the company name must start with this. */
export const SYNTHETIC_NAME_GUARD = 'Synthetic Big Company';
export const SYNTHETIC_COMPANY_NAME = `${SYNTHETIC_NAME_GUARD} (test data)`;
/** A reserved top-level domain (RFC 2606): mail to it can never reach anyone. */
export const SYNTHETIC_EMAIL_DOMAIN = 'synthetic-big-company.invalid';
export const SYNTHETIC_COMPANY_EMAIL = `office@${SYNTHETIC_EMAIL_DOMAIN}`;

export const SYNTHETIC_SPIDER_LIMITS = {
  NEW: { enabled: true, value: 4, unit: 'HOUR' },
  CONTACTED: { enabled: true, value: 2, unit: 'DAY' },
  WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
} as const;

// ─── Arguments ───────────────────────────────────────────────────────────────

export interface SyntheticSizes {
  customers: number;
  overdueLeads: number;
  staff: number;
}

export const DEFAULT_SIZES: SyntheticSizes = { customers: 15_000, overdueLeads: 5_000, staff: 60 };
const DEFAULT_CHUNK = 1_000;
/** The phone range below holds 79,200 fictional numbers; these keep every one unique. */
const SIZE_RANGE: Record<keyof SyntheticSizes | 'chunkSize', [number, number]> = {
  customers: [1, 60_000],
  overdueLeads: [0, 60_000],
  staff: [1, 500],
  chunkSize: [1, 5_000],
};

export type SyntheticCommand = 'seed' | 'delete' | 'status';
export type ParsedArgs =
  | { ok: true; command: SyntheticCommand; sizes: SyntheticSizes; chunkSize: number }
  | { ok: false; error: string };

export const USAGE =
  'Usage: npx tsx scripts/synthetic-big-company.ts <seed|status|delete> [--customers N] [--overdue-leads N] [--staff N] [--chunk-size N]';

const FLAGS: Record<string, keyof SyntheticSizes | 'chunkSize'> = {
  '--customers': 'customers',
  '--overdue-leads': 'overdueLeads',
  '--staff': 'staff',
  '--chunk-size': 'chunkSize',
};
const ENV_VARS: Record<keyof SyntheticSizes, string> = {
  customers: 'SYNTHETIC_COMPANY_CUSTOMERS',
  overdueLeads: 'SYNTHETIC_COMPANY_OVERDUE_LEADS',
  staff: 'SYNTHETIC_COMPANY_STAFF',
};

export function parseSyntheticCompanyArgs(argv: readonly string[], envVars: Record<string, string | undefined>): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== 'seed' && command !== 'delete' && command !== 'status') {
    return { ok: false, error: `Unknown or missing command "${command ?? ''}". ${USAGE}` };
  }
  const raw: Partial<Record<keyof SyntheticSizes | 'chunkSize', string>> = {};
  for (const key of Object.keys(ENV_VARS) as (keyof SyntheticSizes)[]) {
    const v = envVars[ENV_VARS[key]];
    if (v !== undefined && v.trim() !== '') raw[key] = v.trim();
  }
  for (let i = 0; i < rest.length; i += 2) {
    const key = FLAGS[rest[i]!];
    if (!key || rest[i + 1] === undefined) return { ok: false, error: `Unknown or incomplete option "${rest[i]}". ${USAGE}` };
    raw[key] = rest[i + 1];
  }
  const out = { ...DEFAULT_SIZES, chunkSize: DEFAULT_CHUNK };
  for (const [key, value] of Object.entries(raw) as [keyof typeof out, string][]) {
    const [min, max] = SIZE_RANGE[key];
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      return { ok: false, error: `${key} must be a whole number from ${min} to ${max} (got "${value}")` };
    }
    out[key] = Number(value);
  }
  const { chunkSize, ...sizes } = out;
  return { ok: true, command, sizes, chunkSize };
}

// ─── Never production ────────────────────────────────────────────────────────

/** Exactly these host spellings count as this machine; anything else is remote (and must be named). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const POSTGRES_SCHEMES = new Set(['postgresql:', 'postgres:']);
/**
 * The only URL parameters a target may carry: Prisma's Postgres options that tune the connection and never
 * choose where it goes. Anything else is refused, above all `host`, which Prisma reads OVER the host in the
 * URL (a Unix socket directory or another server), so `postgresql://u@localhost/db?host=elsewhere` connects
 * to elsewhere. libpq's `hostaddr` and `service`, and any parameter Prisma may honour later, are refused by
 * the same rule: an unknown parameter is never trusted.
 */
const SAFE_URL_PARAMS = new Set([
  'schema', 'connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout', 'statement_cache_size',
  'pgbouncer', 'application_name', 'max_connection_lifetime', 'max_idle_connection_lifetime',
  'sslmode', 'sslaccept', 'sslcert', 'sslidentity', 'sslpassword', 'channel_binding', 'options',
]);

export type TargetCheck = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Whether this database may receive the synthetic company. A database on this machine may; any other
 * only when the person running the script names it at run time by host AND project ref. Production is
 * never named here: it is refused because nobody allowlists it, not because this file knows it.
 *
 * The host judged is the one the driver will connect to: the URL must be a plain postgres URL with one
 * host and no parameter that can move the connection elsewhere, so the URL's own host is the target.
 */
export function checkDatabaseTarget(input: {
  databaseUrl: string | undefined;
  nodeEnv?: string;
  allowedHosts?: string;
  allowedRef?: string;
}): TargetCheck {
  if (input.nodeEnv === 'production') {
    return { ok: false, reason: 'NODE_ENV is production: this tool never runs inside a deployed server.' };
  }
  if (!input.databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set.' };
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    return { ok: false, reason: 'DATABASE_URL is not a valid URL.' };
  }
  if (!POSTGRES_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `DATABASE_URL must be a postgresql:// URL (got "${url.protocol}").` };
  }
  for (const key of url.searchParams.keys()) {
    if (!SAFE_URL_PARAMS.has(key)) {
      return {
        ok: false,
        reason: `DATABASE_URL carries the parameter "${key}", which may choose where the connection goes (or is unknown). Put the host in the URL itself.`,
      };
    }
  }
  const host = url.hostname.toLowerCase();
  if (!host || /[,/%\\]/.test(host)) {
    return { ok: false, reason: 'DATABASE_URL must name exactly one plain host (no socket path, no host list, no encoded characters).' };
  }
  const target = `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  if (LOOPBACK_HOSTS.has(host)) return { ok: true, target };

  const allowed = (input.allowedHosts ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(host)) {
    return {
      ok: false,
      reason: `database host "${host}" is not on this machine and is not in E2E_ALLOWED_DB_HOSTS. Name a staging host there; never a production one.`,
    };
  }
  const ref = (input.allowedRef ?? '').trim().toLowerCase();
  const user = decodeURIComponent(url.username).toLowerCase();
  if (!ref || !(user.includes(ref) || host.includes(ref))) {
    return {
      ok: false,
      reason: 'E2E_ALLOWED_DB_REF is not set, or does not appear in the database user name or host. Set it to the staging project ref; never a production one.',
    };
  }
  return { ok: true, target };
}

// ─── The generated company ───────────────────────────────────────────────────

const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Jamie', 'Robin', 'Avery'] as const;
const SOURCES = ['Google', 'Referral', 'Facebook', 'Yelp', 'Direct Mail'] as const;
const JOB_TYPES = ['HVAC Service', 'HVAC Install', 'Plumbing', 'Electrical', 'General Maintenance'] as const;
/** Every area code 200-999 except the N11 service codes; 555-0100..0199 is fictional in each. */
const AREA_CODES = Array.from({ length: 800 }, (_, i) => 200 + i).filter((c) => c % 100 !== 11);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** How far past its limit the most overdue lead is (they spread evenly up to this). */
const OVERDUE_SPREAD_MINUTES = 60 * 24 * 60;

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The n-th fictional phone number (E.164), unique for n below 79,200. */
export function fictionalPhone(n: number): string {
  const area = AREA_CODES[Math.floor(n / 100) % AREA_CODES.length]!;
  return `+1${area}55501${pad(n % 100, 2)}`;
}

export interface SyntheticCompany {
  staff: Array<{
    id: string; organization_id: string; email: string; first_name: string; last_name: string; role: Role;
    is_admin: boolean; is_active: boolean; has_login: boolean; phone: string;
  }>;
  customers: Array<{
    id: string; organization_id: string; customer_number: string; kind: 'COMPANY' | 'PERSON'; segment: 'COMMERCIAL' | 'RESIDENTIAL';
    first_name: string; last_name: string; company_name: string | null; email: string; phone: string; source: string;
    is_active: boolean; created_at: Date; updated_at: Date; created_by_source: 'SYSTEM';
  }>;
  customerEmails: Array<{ id: string; customer_id: string; email: string; label: string }>;
  customerPhones: Array<{ id: string; customer_id: string; phone: string; label: string; is_primary: boolean }>;
  serviceLocations: Array<{
    id: string; customer_id: string; address_line1: string; city: string; state: string; zip: string; is_primary: boolean; created_at: Date;
  }>;
  leads: Array<{
    id: string; organization_id: string; lead_number: string; customer_id: string; service_location_id: string;
    status: LeadStatus; service_request: string; job_type: string; source: string;
    created_at: Date; updated_at: Date; contacted_at: Date | null; commission_owner_id: string | null;
    created_by_source: 'SYSTEM';
  }>;
  leadAssignees: Array<{ id: string; lead_id: string; user_id: string; organization_id: string }>;
}

/**
 * The staff seats: about 10% Admins (at least one), 30% Dispatchers, the rest Sales, who own the leads. Admin is
 * the flag on the person, written with the role here, never read back from the role name.
 */
function staffSeat(i: number, staff: number): { role: Role; is_admin: boolean } {
  const admins = Math.max(1, Math.round(staff * 0.1));
  const dispatchers = staff - admins >= 2 ? Math.round(staff * 0.3) : 0;
  if (i < admins) return { role: 'ADMIN', is_admin: true };
  if (i < admins + dispatchers) return { role: 'DISPATCHER', is_admin: false };
  return { role: 'SALES', is_admin: false };
}

export function buildSyntheticCompany(sizes: SyntheticSizes, now: Date): SyntheticCompany {
  const org = SYNTHETIC_COMPANY_ID;
  const staff: SyntheticCompany['staff'] = [];
  for (let i = 0; i < sizes.staff; i += 1) {
    const { role, is_admin } = staffSeat(i, sizes.staff);
    const n = pad(i + 1, sizes.staff >= 100 ? 3 : 2);
    staff.push({
      id: randomUUID(), organization_id: org, email: `staff-${n}@${SYNTHETIC_EMAIL_DOMAIN}`,
      first_name: FIRST_NAMES[i % FIRST_NAMES.length]!, last_name: `Staff ${n}`, role,
      is_admin, is_active: true, has_login: true, phone: fictionalPhone(i),
    });
  }
  const sales = staff.filter((s) => s.role === 'SALES');
  const owners = sales.length > 0 ? sales : staff;

  const customers: SyntheticCompany['customers'] = [];
  const customerEmails: SyntheticCompany['customerEmails'] = [];
  const customerPhones: SyntheticCompany['customerPhones'] = [];
  const serviceLocations: SyntheticCompany['serviceLocations'] = [];
  for (let i = 0; i < sizes.customers; i += 1) {
    const n = pad(i + 1, 5);
    const id = randomUUID();
    const email = `customer-${n}@${SYNTHETIC_EMAIL_DOMAIN}`;
    const phone = fictionalPhone(sizes.staff + i);
    const business = i % 5 === 4;
    // Spread over the last two years, oldest first.
    const created = new Date(now.getTime() - (730 - Math.floor((i / sizes.customers) * 700)) * DAY_MS);
    customers.push({
      id, organization_id: org, customer_number: formatRecordNumber('C', 5, i + 1),
      kind: business ? 'COMPANY' : 'PERSON', segment: business ? 'COMMERCIAL' : 'RESIDENTIAL',
      first_name: FIRST_NAMES[i % FIRST_NAMES.length]!, last_name: `Sample ${n}`,
      company_name: business ? `Sample Business ${n}` : null,
      email, phone, source: SOURCES[i % SOURCES.length]!, is_active: true,
      created_at: created, updated_at: created, created_by_source: 'SYSTEM',
    });
    customerEmails.push({ id: randomUUID(), customer_id: id, email, label: 'Primary' });
    customerPhones.push({ id: randomUUID(), customer_id: id, phone, label: 'Mobile', is_primary: true });
    serviceLocations.push({
      id: randomUUID(), customer_id: id, address_line1: `${100 + (i % 9_000)} Sample Street`,
      city: 'Sampletown', state: 'MA', zip: '02108', is_primary: true, created_at: created,
    });
  }

  const leads: SyntheticCompany['leads'] = [];
  const leadAssignees: SyntheticCompany['leadAssignees'] = [];
  const limitOf = (stage: 'NEW' | 'CONTACTED') => {
    const l = SYNTHETIC_SPIDER_LIMITS[stage];
    return limitMs(l.value, l.unit);
  };
  for (let i = 0; i < sizes.overdueLeads; i += 1) {
    const id = randomUUID();
    const c = i % sizes.customers;
    const owner = owners[i % owners.length]!;
    const stage = i % 2 === 0 ? 'NEW' : 'CONTACTED';
    // Past the limit by one hour plus a spread up to about two months, different for each lead.
    const over = HOUR_MS + ((i * 7_919) % OVERDUE_SPREAD_MINUTES) * 60_000;
    const entered = new Date(now.getTime() - limitOf(stage) - over);
    const created = stage === 'NEW' ? entered : new Date(entered.getTime() - (1 + (i % 47)) * HOUR_MS);
    leads.push({
      id, organization_id: org, lead_number: formatRecordNumber('L', 5, i + 1),
      customer_id: customers[c]!.id, service_location_id: serviceLocations[c]!.id,
      status: stage, service_request: `Synthetic test request ${pad(i + 1, 5)}`,
      job_type: JOB_TYPES[i % JOB_TYPES.length]!, source: SOURCES[i % SOURCES.length]!,
      created_at: created, updated_at: entered, contacted_at: stage === 'CONTACTED' ? entered : null,
      commission_owner_id: owner.id, created_by_source: 'SYSTEM',
    });
    leadAssignees.push({ id: randomUUID(), lead_id: id, user_id: owner.id, organization_id: org });
  }
  return { staff, customers, customerEmails, customerPhones, serviceLocations, leads, leadAssignees };
}

// ─── Seed ────────────────────────────────────────────────────────────────────

type Log = (line: string) => void;

export type SeedResult = { ok: true; counts: SyntheticCounts; ms: number } | { ok: false; reason: string };

async function chunked<T>(rows: T[], size: number, write: (part: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

export async function seedSyntheticCompany(
  db: PrismaClient,
  opts: { sizes: SyntheticSizes; chunkSize?: number; now?: Date; log?: Log },
): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const size = opts.chunkSize ?? DEFAULT_CHUNK;
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  const step = (what: string) => log(`[synthetic-big-company] +${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);

  const existing = await db.organization.findFirst({
    where: { OR: [{ id: SYNTHETIC_COMPANY_ID }, { name: SYNTHETIC_COMPANY_NAME }] },
    select: { id: true },
  });
  const staffTaken = await db.user.count({ where: { email: { endsWith: `@${SYNTHETIC_EMAIL_DOMAIN}` } } });
  if (existing || staffTaken > 0) {
    return { ok: false, reason: 'The synthetic big company already exists here. Delete it first (the delete command), then seed again.' };
  }

  const company = buildSyntheticCompany(opts.sizes, now);
  step(`generated ${company.customers.length} customers, ${company.leads.length} overdue leads, ${company.staff.length} staff`);

  await createCompanyWithMainMailbox(db, {
    id: SYNTHETIC_COMPANY_ID, name: SYNTHETIC_COMPANY_NAME, email: SYNTHETIC_COMPANY_EMAIL, is_demo: true, plan: 'SCALE',
    address_line1: '1 Sample Street', city: 'Sampletown', state: 'MA', postal_code: '02108',
    estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
  });
  await seedStarterTaskCategories(db, SYNTHETIC_COMPANY_ID);
  await seedListRows(db, SYNTHETIC_COMPANY_ID);
  step('company created (demo company, Scale plan)');

  await db.user.createMany({ data: company.staff });
  await db.$transaction(async (tx) => {
    for (const s of company.staff) await issueUserMailbox(tx, s);
  }, { timeout: 300_000, maxWait: 20_000 });
  await setFirstOwner(db, SYNTHETIC_COMPANY_ID, company.staff[0]!.id);
  step(`${company.staff.length} staff with their mailboxes`);

  await chunked(company.customers, size, (d) => db.customer.createMany({ data: d }));
  await chunked(company.customerEmails, size, (d) => db.customerEmail.createMany({ data: d }));
  await chunked(company.customerPhones, size, (d) => db.customerPhone.createMany({ data: d }));
  await chunked(company.serviceLocations, size, (d) => db.serviceLocation.createMany({ data: d }));
  step(`${company.customers.length} customers with an email, a phone and a service location each`);
  await chunked(company.leads, size, (d) => db.lead.createMany({ data: d }));
  await chunked(company.leadAssignees, size, (d) => db.leadAssignee.createMany({ data: d }));
  step(`${company.leads.length} overdue leads with their owners`);

  await db.organization.update({
    where: { id: SYNTHETIC_COMPANY_ID },
    data: {
      customer_next_number: company.customers.length + 1, customer_first_issued_at: now,
      lead_next_number: company.leads.length + 1, ...(company.leads.length > 0 ? { lead_first_issued_at: now } : {}),
    },
  });
  await db.spiderSettings.create({
    data: {
      organization_id: SYNTHETIC_COMPANY_ID, is_active: false, activated_at: null,
      status_limits: SYNTHETIC_SPIDER_LIMITS, channels: { ...DEFAULT_CHANNELS }, recipients: { ...DEFAULT_RECIPIENTS },
      watch_all_leads: true,
    },
  });
  step('Spider settings: limits on New and Contacted, switched off');
  return { ok: true, counts: (await countSyntheticCompany(db, now))!, ms: Date.now() - t0 };
}

// ─── Status ──────────────────────────────────────────────────────────────────

export interface SyntheticCounts {
  customers: number;
  customerEmails: number;
  customerPhones: number;
  serviceLocations: number;
  leads: number;
  leadAssignees: number;
  /** Open leads past their Spider limit right now, by the sweep's own stage rule. */
  overdueLeads: number;
  staff: number;
  /** Staff who can receive Spider alerts (active, marked able to sign in). */
  alertableStaff: number;
  spiderOn: boolean | null;
}

export async function countSyntheticCompany(db: PrismaClient, now: Date = new Date()): Promise<SyntheticCounts | null> {
  const org = SYNTHETIC_COMPANY_ID;
  const exists = await db.organization.findUnique({ where: { id: org }, select: { id: true } });
  if (!exists) return null;
  const ofCustomers = { customer: { organization_id: org } };
  const [customers, customerEmails, customerPhones, serviceLocations, leads, leadAssignees, staff, alertableStaff, settings, open] =
    await Promise.all([
      db.customer.count({ where: { organization_id: org } }),
      db.customerEmail.count({ where: ofCustomers }),
      db.customerPhone.count({ where: ofCustomers }),
      db.serviceLocation.count({ where: ofCustomers }),
      db.lead.count({ where: { organization_id: org } }),
      db.leadAssignee.count({ where: { organization_id: org } }),
      db.user.count({ where: { organization_id: org } }),
      db.user.count({ where: { organization_id: org, is_active: true, has_login: true } }),
      db.spiderSettings.findUnique({ where: { organization_id: org }, select: { is_active: true, status_limits: true } }),
      db.lead.findMany({ where: { organization_id: org }, select: SPIDER_LEAD_TIMES_SELECT }),
    ]);
  const limits = readStatusLimits(settings?.status_limits);
  const overdueLeads = open.filter((l) => {
    const visit = spiderStageOf(l);
    if (!visit || !limits[visit.stage].enabled) return false;
    return now.getTime() - visit.enteredAt.getTime() >= limitMs(limits[visit.stage].value, limits[visit.stage].unit);
  }).length;
  return {
    customers, customerEmails, customerPhones, serviceLocations, leads, leadAssignees, overdueLeads, staff, alertableStaff,
    spiderOn: settings ? settings.is_active : null,
  };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * The fast path: the bulk of the company's rows in a few statements, each scoped to the one company id
 * ($1). Any row someone added that still points at these (an estimate on a lead, say) stops it with a
 * foreign-key error; the whole step then rolls back and the full per-customer purge runs instead.
 */
export const FAST_DELETE_STATEMENTS: readonly string[] = [
  'DELETE FROM spider_alerts WHERE organization_id = $1::uuid',
  'DELETE FROM lead_assignees WHERE organization_id = $1::uuid',
  'DELETE FROM leads WHERE organization_id = $1::uuid',
  'DELETE FROM customer_phones WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = $1::uuid)',
  'DELETE FROM customer_emails WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = $1::uuid)',
  'DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = $1::uuid)',
  'DELETE FROM customers WHERE organization_id = $1::uuid',
];

const DELETE_TX = { timeout: 600_000, maxWait: 20_000 };

export type DeleteResult =
  | { ok: true; deleted: false }
  | { ok: true; deleted: true; path: 'fast' | 'full'; ms: number }
  | { ok: false; reason: string };

export async function deleteSyntheticCompany(db: PrismaClient, opts: { log?: Log } = {}): Promise<DeleteResult> {
  const log = opts.log ?? (() => undefined);
  const t0 = Date.now();
  const org = SYNTHETIC_COMPANY_ID;
  const row = await db.organization.findUnique({ where: { id: org }, select: { name: true, email: true, is_demo: true } });
  if (!row) return { ok: true, deleted: false };
  if (row.name !== SYNTHETIC_COMPANY_NAME || row.email !== SYNTHETIC_COMPANY_EMAIL || row.is_demo !== true) {
    return { ok: false, reason: `Refusing: company ${org} does not carry the synthetic company's name, email and demo flag. Nothing was deleted.` };
  }

  let path: 'fast' | 'full' = 'fast';
  try {
    await db.$transaction(async (tx) => {
      for (const sql of FAST_DELETE_STATEMENTS) await tx.$executeRawUnsafe(sql, org);
    }, DELETE_TX);
    log('[synthetic-big-company] customers and leads removed in bulk');
  } catch (err) {
    path = 'full';
    log(`[synthetic-big-company] bulk delete stopped (${(err as { code?: string }).code ?? 'error'}): someone added records; removing customer by customer`);
    const customers = await db.customer.findMany({ where: { organization_id: org }, select: { id: true } });
    for (const c of customers) {
      await db.$transaction((tx) => purgeCustomerSubtree(tx, c.id, org), DELETE_TX);
    }
  }
  await db.$transaction((tx) => purgeOrganization(tx, org, SYNTHETIC_NAME_GUARD), DELETE_TX);
  return { ok: true, deleted: true, path, ms: Date.now() - t0 };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  dotenv.config();
  const parsed = parseSyntheticCompanyArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const target = checkDatabaseTarget({
    databaseUrl: process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    allowedHosts: process.env.E2E_ALLOWED_DB_HOSTS,
    allowedRef: process.env.E2E_ALLOWED_DB_REF,
  });
  if (!target.ok) {
    console.error(`Refusing to run: ${target.reason}`);
    return 3;
  }
  console.log(`[synthetic-big-company] ${parsed.command} on ${target.target}`);
  try {
    return await runUnscoped(async () => {
      if (parsed.command === 'status') {
        const counts = await countSyntheticCompany(prisma);
        console.log(counts ? JSON.stringify(counts, null, 2) : 'The synthetic big company does not exist here.');
        return 0;
      }
      if (parsed.command === 'seed') {
        console.log(`[synthetic-big-company] sizes ${JSON.stringify(parsed.sizes)}, chunk ${parsed.chunkSize}`);
        const r = await seedSyntheticCompany(prisma, { sizes: parsed.sizes, chunkSize: parsed.chunkSize, log: (l) => console.log(l) });
        if (!r.ok) {
          console.error(r.reason);
          return 1;
        }
        console.log(`[synthetic-big-company] seeded company ${SYNTHETIC_COMPANY_ID} in ${(r.ms / 1000).toFixed(1)}s`);
        console.log(JSON.stringify(r.counts, null, 2));
        return 0;
      }
      const r = await deleteSyntheticCompany(prisma, { log: (l) => console.log(l) });
      if (!r.ok) {
        console.error(r.reason);
        return 1;
      }
      console.log(r.deleted
        ? `[synthetic-big-company] deleted company ${SYNTHETIC_COMPANY_ID} (${r.path} path) in ${(r.ms / 1000).toFixed(1)}s`
        : 'The synthetic big company does not exist here; nothing to delete.');
      return 0;
    });
  } catch (err) {
    console.error(err);
    console.error('If a seed stopped part way, run the delete command, then seed again.');
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}
