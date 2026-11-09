/* =============================================================================
   S06.32 - the one-time move of existing Completed jobs, applied for real.

   Proves against real Postgres, the way the deploy applies it (the Prisma deploy command), on a prod-shaped copy
   (every migration BEFORE this one, jobs seeded in every status):
     - a Completed job that is paid in full or has a zero total lands in Done; one with money owed, work not yet invoiced
       included, lands in Ready to close; jobs in any other status are left exactly as they were;
     - the migration's classification agrees with the app's own money-owed rule (lib/job-money-owed readJobMoneyOwed, the
       rule Mark Done enforces), job by job, to the cent, over a wide set of named cases and a seeded random set; a job
       invoiced for less than it was sold for is the one place they differ (the live rule keeps the rest owed, the frozen
       migration reads the invoice), and there the live rule is never the lower;
     - each moved job gets exactly one History entry "Moved by the job close-out upgrade" with no actor; a Done job is
       stamped closed on the day it was completed with nobody as closer; a Ready to close job is not closed;
     - no review round opens and no row is written to any table but jobs and timeline_events (no alert, no notification,
       no automation enrollment);
     - a Cancelled job keeps its written reason as the note and gets no reason code;
     - a second run moves nothing and writes nothing;
     - the dry run writes nothing, previews exactly what the run then does, and the proof check confirms it, each over one
       database connection and printing company ids and counts only.

   Each case builds its own throwaway database from one prod-shaped template on the server TEST_DATABASE_URL points at
   and drops it afterwards. Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops
   databases. The Prisma CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never
   fall back to the checkout's .env (the shared staging DB). Rows are written with raw SQL so a column a later slice adds
   to these tables cannot break the older-schema database. Nothing here imports, at load, a module that touches the app's
   client.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  CLOSE_OUT_UPGRADE_EVENT, CLOSE_OUT_UPGRADE_MIGRATION, CLOSE_OUT_UPGRADE_NOTE, closeOutUpgradePlanSql,
  dryRunReport, formatDryRunReport, formatProofReport, proofReport,
} from '../lib/job-close-out-upgrade';
import { deployFrom, deployMigrations, prepareMigrationsDir, createMigrationDatabase } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', CLOSE_OUT_UPGRADE_MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const TSX_CLI = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const REPORT_SCRIPT = join(__dirname, '..', 'scripts', 'job-close-out-upgrade-report.ts');
const hasPsql = spawnSync('psql', ['--version']).status === 0;

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Job close-out upgrade suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

// ─── Fixture vocabulary ─────────────────────────────────────────────────────────────────────────────

type Target = 'DONE' | 'READY_TO_CLOSE';

interface PaymentSpec {
  amount: number;
  state?: 'SUCCEEDED' | 'PROCESSING' | 'FAILED';
  voided?: boolean;
  /** The applied deposit credit row carries this reference. */
  credit?: boolean;
  /** Money given back: the app's rule does not subtract it, and nor does the migration. */
  refunded?: number;
}
interface InvoiceSpec {
  /** Where the invoice hangs: on the job (default), on the estimate it was made from, or on an attached estimate. */
  on?: 'job' | 'estimate' | 'attached';
  kind?: 'STANDARD' | 'DEPOSIT';
  number: string;
  total: number;
  voided?: boolean;
  payments?: PaymentSpec[];
}
interface JobSpec {
  name: string;
  status?: string;
  /** [quantity, unit price, taxable]. */
  lines?: Array<[number, number, boolean?]>;
  scopes?: unknown;
  taxRate?: number;
  discount?: number;
  taxExempt?: boolean;
  plan?: boolean;
  /** The estimate the job was made from. */
  estimate?: { total: number };
  attached?: Array<{ total: number; status?: string }>;
  invoices?: InvoiceSpec[];
  completedAt?: string | null;
  cancelledReason?: string;
  subStatus?: boolean;
  /** What the migration must do with it (named cases only). */
  expect?: Target | 'UNTOUCHED';
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

async function insert(db: Db, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.$executeRawUnsafe(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => lit(row[c])).join(', ')})`);
}

interface Company {
  org: string;
  user: string;
  n: number;
}

async function newCompany(db: Db): Promise<Company> {
  const org = randomUUID();
  const tag = org.slice(0, 8);
  await insert(db, 'organizations', {
    id: org, name: `s0632-${tag}`, email: `s0632-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
    state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', updated_at: new Date().toISOString(),
  });
  const user = randomUUID();
  await insert(db, 'users', {
    id: user, organization_id: org, email: `u-${tag}@example.test`, first_name: 'Sam', last_name: 'Tester', role: 'ADMIN', updated_at: new Date().toISOString(),
  });
  return { org, user, n: 0 };
}

/** Writes one job with everything its spec describes; returns its id. */
async function seedJob(db: Db, co: Company, spec: JobSpec): Promise<string> {
  const tag = `${co.org.slice(0, 8)}-${++co.n}`;
  const now = new Date().toISOString();
  const customer = randomUUID();
  await insert(db, 'customers', {
    id: customer, organization_id: co.org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
    first_name: 'Pat', last_name: 'Payer', tax_exempt: spec.taxExempt ?? false, updated_at: now,
  });
  const location = randomUUID();
  await insert(db, 'service_locations', {
    id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108',
  });

  const estimate = (total: number, jobId: string | null, status = 'SENT') => {
    const id = randomUUID();
    return insert(db, 'estimates', {
      id, organization_id: co.org, customer_id: customer, estimate_number: `E-${tag}-${++co.n}`, subtotal: total, tax_amount: 0,
      total_amount: total, created_by: co.user, status, job_id: jobId, updated_at: now,
    }).then(() => id);
  };
  const jobId = randomUUID();
  const estimateId = spec.estimate ? await estimate(spec.estimate.total, null, 'WON') : null;
  let planId: string | null = null;
  if (spec.plan) {
    planId = randomUUID();
    await insert(db, 'service_plans', {
      id: planId, organization_id: co.org, customer_id: customer, service_location_id: location, service_plan_number: `SP-${tag}`,
      name: 'Quarterly check', visit_cadence: 'WEEKLY', start_date: now, contract_price: 100, updated_at: now,
    });
  }
  let subStatusId: string | null = null;
  if (spec.subStatus) {
    subStatusId = randomUUID();
    await insert(db, 'job_sub_statuses', { id: subStatusId, organization_id: co.org, parent: 'COMPLETED', label: `Parts ${tag}`, updated_at: now });
  }
  await insert(db, 'jobs', {
    id: jobId, organization_id: co.org, customer_id: customer, service_location_id: location, job_number: `J-${tag}`,
    status: spec.status ?? 'COMPLETED', estimate_id: estimateId, source_plan_id: planId, sub_status_id: subStatusId,
    tax_rate: spec.taxRate ?? 0, discount_amount: spec.discount ?? 0,
    scopes: spec.scopes === undefined ? null : JSON.stringify(spec.scopes),
    completed_at: spec.completedAt === undefined ? '2026-03-04T15:20:00.000Z' : spec.completedAt,
    cancelled_at: spec.status === 'CANCELLED' ? '2026-02-01T10:00:00.000Z' : null, cancelled_reason: spec.cancelledReason ?? null,
    updated_at: '2026-05-06T07:08:09.000Z',
  });
  let seq = 0;
  for (const [quantity, price, taxable] of spec.lines ?? []) {
    await insert(db, 'job_line_items', {
      id: randomUUID(), job_id: jobId, organization_id: co.org, sequence: ++seq, description: 'Work', quantity, unit_price: price,
      line_total: Math.round(quantity * price * 100) / 100, is_taxable: taxable ?? true,
    });
  }
  const attachedIds: string[] = [];
  for (const a of spec.attached ?? []) attachedIds.push(await estimate(a.total, jobId, a.status ?? 'SENT'));

  for (const inv of spec.invoices ?? []) {
    const id = randomUUID();
    const on = inv.on ?? 'job';
    await insert(db, 'invoices', {
      id, organization_id: co.org, customer_id: customer, invoice_number: `${inv.number}-${tag}`, kind: inv.kind ?? 'STANDARD',
      status: inv.voided ? 'VOIDED' : 'SENT', subtotal: inv.total, tax_amount: 0, total_amount: inv.total, amount_due: inv.total,
      voided_at: inv.voided ? now : null, updated_at: now,
      job_id: on === 'job' ? jobId : null,
      estimate_id: on === 'estimate' ? estimateId : on === 'attached' ? attachedIds[0]! : null,
    });
    for (const p of inv.payments ?? []) {
      await insert(db, 'payments', {
        id: randomUUID(), invoice_id: id, amount: p.amount, method: 'CASH', paid_at: now, state: p.state ?? 'SUCCEEDED',
        voided_at: p.voided ? now : null, reference_number: p.credit ? 'DEPOSIT-CREDIT' : null, refunded_amount: p.refunded ?? null,
      });
    }
  }
  return jobId;
}

// ─── The named cases: each says what the job must become ────────────────────────────────────────────

const paidInFull: InvoiceSpec = { number: 'I1', total: 100, payments: [{ amount: 100 }] };
const NAMED: JobSpec[] = [
  { name: 'paid in full', lines: [[1, 100]], invoices: [paidInFull], expect: 'DONE' },
  { name: 'partly paid', lines: [[1, 100]], invoices: [{ number: 'I1', total: 100, payments: [{ amount: 40 }] }], expect: 'READY_TO_CLOSE' },
  { name: 'invoiced, nothing paid', lines: [[1, 100]], invoices: [{ number: 'I1', total: 100 }], expect: 'READY_TO_CLOSE' },
  { name: 'not invoiced, positive total', lines: [[2, 50]], expect: 'READY_TO_CLOSE' },
  { name: 'zero total, no lines', expect: 'DONE' },
  { name: 'zero total, priced at nothing', lines: [[3, 0]], expect: 'DONE' },
  { name: 'zero-total invoice', lines: [[1, 0]], invoices: [{ number: 'I1', total: 0 }], expect: 'DONE' },
  {
    name: 'deposit on the estimate, final invoice paid with the deposit credit',
    estimate: { total: 1000 },
    invoices: [
      { on: 'estimate', kind: 'DEPOSIT', number: 'D1', total: 300, payments: [{ amount: 300 }] },
      { number: 'I1', total: 1000, payments: [{ amount: 300, credit: true }, { amount: 700 }] },
    ],
    expect: 'DONE',
  },
  {
    name: 'deposit on the estimate, final invoice not paid',
    estimate: { total: 1000 },
    invoices: [
      { on: 'estimate', kind: 'DEPOSIT', number: 'D1', total: 300, payments: [{ amount: 300 }] },
      { number: 'I1', total: 1000, payments: [{ amount: 300, credit: true }] },
    ],
    expect: 'READY_TO_CLOSE',
  },
  { name: 'estimate sold, nothing invoiced yet', estimate: { total: 800 }, expect: 'READY_TO_CLOSE' },
  { name: 'estimate sold at nothing', estimate: { total: 0 }, lines: [[1, 500]], expect: 'DONE' },
  {
    name: 'a voided invoice leaves the job to its own total',
    lines: [[1, 200]], invoices: [{ number: 'I1', total: 500, voided: true }], expect: 'READY_TO_CLOSE',
  },
  {
    name: 'a voided payment is not money paid',
    lines: [[1, 100]], invoices: [{ number: 'I1', total: 100, payments: [{ amount: 100, voided: true }] }], expect: 'READY_TO_CLOSE',
  },
  {
    name: 'a pending payment is not money paid',
    lines: [[1, 100]], invoices: [{ number: 'I1', total: 100, payments: [{ amount: 100, state: 'PROCESSING' }] }], expect: 'READY_TO_CLOSE',
  },
  {
    name: 'a failed payment is not money paid',
    lines: [[1, 100]], invoices: [{ number: 'I1', total: 100, payments: [{ amount: 100, state: 'FAILED' }] }], expect: 'READY_TO_CLOSE',
  },
  {
    name: 'a refunded payment is still counted, as the app counts it',
    lines: [[1, 100]], invoices: [{ number: 'I1', total: 100, payments: [{ amount: 100, refunded: 100 }] }], expect: 'DONE',
  },
  { name: 'a service plan visit job is never owed', plan: true, lines: [[1, 100]], expect: 'DONE' },
  { name: 'a live attached estimate is owed', attached: [{ total: 400 }], expect: 'READY_TO_CLOSE' },
  { name: 'a declined attached estimate adds nothing', attached: [{ total: 400, status: 'DECLINED' }], expect: 'DONE' },
  { name: 'a superseded attached estimate adds nothing', attached: [{ total: 400, status: 'SUPERSEDED' }], expect: 'DONE' },
  {
    name: 'invoice made from an attached estimate, paid',
    attached: [{ total: 400 }], invoices: [{ on: 'attached', number: 'I1', total: 400, payments: [{ amount: 400 }] }], expect: 'DONE',
  },
  {
    name: 'invoice made from an attached estimate, unpaid',
    attached: [{ total: 400 }], invoices: [{ on: 'attached', number: 'I1', total: 400 }], expect: 'READY_TO_CLOSE',
  },
  { name: 'tax makes the total', lines: [[1, 100]], taxRate: 0.0825, invoices: [{ number: 'I1', total: 100, payments: [{ amount: 100 }] }], expect: 'DONE' },
  { name: 'taxed job, not invoiced', lines: [[1, 100]], taxRate: 0.0825, expect: 'READY_TO_CLOSE' },
  { name: 'a discount that takes the total to zero', lines: [[1, 100]], discount: 100, expect: 'DONE' },
  { name: 'a discount larger than the work', lines: [[1, 100]], discount: 150, expect: 'DONE' },
  { name: 'a tax-exempt customer pays no tax', lines: [[1, 100, true]], taxRate: 0.1, taxExempt: true, discount: 100, expect: 'DONE' },
  { name: 'a flat-priced scope is owed', scopes: [{ title: 'Install', flat_price: 250, is_taxable: true }], taxRate: 0.06, expect: 'READY_TO_CLOSE' },
  { name: 'scopes with no price are worth nothing', scopes: [{ title: 'Note only', flat_price: null }, { title: 'Also', is_taxable: false }], expect: 'DONE' },
  { name: 'a price kept as text is read', scopes: [{ title: 'Install', flat_price: '75.50', is_taxable: false }], expect: 'READY_TO_CLOSE' },
  { name: 'a scope whose price is not a number cannot be priced, so it waits', scopes: [{ title: 'Install', flat_price: 'ask' }], expect: 'READY_TO_CLOSE' },
  { name: 'scopes that are not a list are ignored', scopes: { oops: true }, expect: 'DONE' },
  { name: 'Completed with a sub-status', lines: [[1, 0]], subStatus: true, expect: 'DONE' },
  { name: 'Completed with no completed date', lines: [[1, 0]], completedAt: null, expect: 'DONE' },
  // every other status stays exactly as it is, owed money or not
  ...(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] as const).map((status): JobSpec => ({
    name: `already ${status}`, status, lines: [[1, 100]], expect: 'UNTOUCHED',
  })),
  { name: 'cancelled with a written reason', status: 'CANCELLED', cancelledReason: 'Customer went elsewhere', lines: [[1, 100]], expect: 'UNTOUCHED' },
];

/** A small seeded generator, so a failure names a case that can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    cents: (lo: number, hi: number) => Math.round((lo + next() * (hi - lo)) * 100) / 100,
  };
}

/**
 * Jobs with prices, rates and discounts that land on half-cents, paid in every proportion. The migration is the frozen rule
 * of the day it ran, which reads the newest standard invoice; it is never given two standard invoices, where the live rule
 * (lib/job-money-totals) adds each invoice's due and the two would rightly differ.
 */
function randomSpecs(count: number): JobSpec[] {
  const r = rng(632);
  return Array.from({ length: count }, (_, i): JobSpec => {
    const lines = Array.from({ length: r.int(0, 4) }, (): [number, number, boolean] => [
      r.pick([1, 2, 3, 0.5, 1.25, 7, 12]), r.cents(0, 300), r.next() < 0.7,
    ]);
    const scopes = Array.from({ length: r.int(0, 2) }, () => ({ title: 's', flat_price: r.next() < 0.2 ? null : r.cents(0, 900), is_taxable: r.next() < 0.5 }));
    const taxRate = r.pick([0, 0.06, 0.0625, 0.0825, 0.07125, 0.095]);
    const spec: JobSpec = {
      name: `random ${i}`, lines, scopes: scopes.length ? scopes : undefined, taxRate, taxExempt: r.next() < 0.15,
      discount: r.next() < 0.4 ? r.cents(0, 120) : 0, plan: r.next() < 0.05,
    };
    const shape = r.int(0, 4);
    if (shape === 1) spec.estimate = { total: r.cents(0, 1500) };
    if (shape === 2) spec.attached = [{ total: r.cents(0, 1500), status: r.pick(['SENT', 'WON', 'DECLINED', 'EXPIRED']) }];
    const invoiceCount = r.int(0, 2);
    spec.invoices = Array.from({ length: invoiceCount }, (_, k): InvoiceSpec => {
      const total = r.cents(0, 1500);
      const share = r.pick([0, 0.25, 0.5, 1, 1]);
      return {
        number: `I${k + 1}`, total, kind: k === 0 && invoiceCount > 1 ? 'DEPOSIT' : 'STANDARD', voided: r.next() < 0.15,
        payments: share === 0 ? [] : [{ amount: Math.round(total * share * 100) / 100, state: r.pick(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'PROCESSING', 'FAILED']), voided: r.next() < 0.1 }],
      };
    });
    if (spec.attached && spec.invoices.length) spec.invoices[0]!.on = 'attached';
    if (spec.estimate && spec.invoices.length > 1) spec.invoices[1]!.on = 'estimate';
    return spec;
  });
}

// ─── The suite ──────────────────────────────────────────────────────────────────────────────────────

suite('the job close-out upgrade (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];
  let template = '';
  let throughMigrationsDir = '';

  const urlOf = (name: string, params = '') => {
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    return `${u.toString()}${params}`;
  };

  function cli(dbUrl: string, args: string[], cwd: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    });
  }

  /** A fresh database cloned from the prod-shaped template. */
  async function scratch(): Promise<{ dbUrl: string; db: Db }> {
    const name = `s0632_mig_${randomUUID().slice(0, 8)}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    databases.push(name);
    const dbUrl = urlOf(name);
    const db = clientAt(dbUrl);
    clients.push(db);
    return { dbUrl, db };
  }

  /**
   * The migration, applied the way the deploy applies it: only the migrations not yet applied run. The directory
   * stops at this migration, so a migration written later never runs here (see migration-deploy-support).
   */
  const applyMigration = (dbUrl: string) => deployFrom(dbUrl, throughMigrationsDir);

  /** The migration file run a second time, the way the shared staging database may see it. */
  const runFileAgain = (dbUrl: string) => cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], throughMigrationsDir);

  beforeAll(async () => {
    template = `s0632_tpl_${randomUUID().slice(0, 8)}`;
    await createMigrationDatabase(admin, template, CLOSE_OUT_UPGRADE_MIGRATION, tempDirs);
    databases.push(template);
    deployMigrations(urlOf(template), CLOSE_OUT_UPGRADE_MIGRATION, 'before', tempDirs);
    throughMigrationsDir = prepareMigrationsDir(CLOSE_OUT_UPGRADE_MIGRATION, 'through', tempDirs);
  }, 600_000);

  // Every DROP DATABASE forces an immediate checkpoint on the server, and the server's settings are durable (spec #3234: no
  // non-durable settings). This file drops a dozen scratch databases one after another, and the other lanes' files do the same, so
  // under lanes the drops queue behind each other's checkpoints: measured 47 s with only these two files in the lanes, and past the lane
  // run's 60 s hook limit in two full runs at load 8-13. It is slow teardown, not a stuck one, so this hook alone gets the room.
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect()));
    for (const name of databases.reverse()) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  }, 300_000);

  // ── What the rest of the database looks like, so "nothing else was written" is a fact, not a claim ──

  /** Row counts of every table except the two the move writes. */
  async function otherTableCounts(db: Db): Promise<Record<string, number>> {
    const tables = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         AND table_name NOT IN ('jobs', 'timeline_events', '_prisma_migrations') ORDER BY table_name`,
    );
    const out: Record<string, number> = {};
    for (const t of tables) {
      const [row] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t.table_name}"`);
      out[t.table_name] = Number(row!.n);
    }
    return out;
  }
  /** Every job row as the database holds it, by id. */
  async function jobRows(db: Db): Promise<Record<string, Record<string, unknown>>> {
    const rows = await db.$queryRawUnsafe<Array<{ id: string; row: Record<string, unknown> }>>(`SELECT id, to_jsonb(j) AS row FROM jobs j`);
    return Object.fromEntries(rows.map((r) => [r.id, r.row]));
  }
  async function entries(db: Db, jobId?: string) {
    return db.$queryRawUnsafe<Array<{ id: string; entity_id: string; organization_id: string; description: string; created_by: string | null; created_at: Date; metadata: Record<string, unknown> }>>(
      `SELECT id, entity_id, organization_id, description, created_by, created_at, metadata FROM timeline_events
       WHERE entity_type = 'JOB' AND event_type = '${CLOSE_OUT_UPGRADE_EVENT}' ${jobId ? `AND entity_id = '${jobId}'::uuid` : ''}`,
    );
  }

  /** Seeds the named cases into one company; returns each job's id with its spec. */
  async function seedNamed(db: Db, co: Company) {
    const out: Array<{ id: string; spec: JobSpec }> = [];
    for (const spec of NAMED) out.push({ id: await seedJob(db, co, spec), spec });
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('moves paid and zero-total Completed jobs to Done and jobs with money owed to Ready to close, and touches nothing else', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    const jobs = await seedNamed(db, co);
    const rowsBefore = await jobRows(db);
    const othersBefore = await otherTableCounts(db);

    applyMigration(dbUrl);

    const rowsAfter = await jobRows(db);
    for (const { id, spec } of jobs) {
      const label = spec.name;
      if (spec.expect === 'UNTOUCHED') {
        expect(rowsAfter[id], label).toEqual(rowsBefore[id]);
      } else {
        expect(rowsAfter[id]!.status, label).toBe(spec.expect);
      }
    }
    // Nothing but the status, the sub-status and the Done stamp changed on a moved job (updated_at and completed_at stay).
    for (const { id, spec } of jobs.filter((j) => j.spec.expect !== 'UNTOUCHED')) {
      const before = rowsBefore[id]!;
      const after = rowsAfter[id]!;
      const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      expect(changed, spec.name).toContain('status');
      expect(['closed_at', 'status', 'sub_status_id'], spec.name).toEqual(expect.arrayContaining(changed));
    }
    // No alert, no notification, no review round, no automation: every other table holds the rows it held.
    expect(await otherTableCounts(db)).toEqual(othersBefore);
    const [rounds] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM job_reviews`);
    expect(Number(rounds!.n)).toBe(0);
  }, 300_000);

  it('writes one History entry per moved job, with no actor, and stamps a Done job closed on the day it was completed with nobody as closer', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    const jobs = await seedNamed(db, co);
    const before = await entries(db);
    expect(before).toHaveLength(0);

    applyMigration(dbUrl);

    const moved = jobs.filter((j) => j.spec.expect === 'DONE' || j.spec.expect === 'READY_TO_CLOSE');
    const all = await entries(db);
    expect(all).toHaveLength(moved.length);
    const rows = await jobRows(db);
    for (const { id, spec } of moved) {
      const own = all.filter((e) => e.entity_id === id);
      expect(own, spec.name).toHaveLength(1);
      expect(own[0]!.description).toBe(CLOSE_OUT_UPGRADE_NOTE);
      expect(own[0]!.description).toBe('Moved by the job close-out upgrade');
      expect(own[0]!.created_by).toBeNull();
      expect(own[0]!.organization_id).toBe(co.org);
      expect(own[0]!.metadata).toEqual({ from: 'COMPLETED', to: spec.expect, via: 'job_close_out_upgrade' });
      // The entry is dated when the move ran, in UTC like every other entry.
      expect(Math.abs(own[0]!.created_at.getTime() - Date.now())).toBeLessThan(10 * 60_000);
      const job = rows[id]!;
      expect(job.closed_by_id, spec.name).toBeNull();
      if (spec.expect === 'DONE') {
        // completed on 4 March: that is the day it was closed, not the day of the release
        expect(job.closed_at, spec.name).toBe(spec.completedAt === null ? '2026-05-06T07:08:09' : '2026-03-04T15:20:00');
      } else {
        expect(job.closed_at, spec.name).toBeNull();
      }
      expect(job.sub_status_id, spec.name).toBeNull();
      expect(job.completed_at, spec.name).toBe(spec.completedAt === null ? null : '2026-03-04T15:20:00');
      expect(job.updated_at, spec.name).toBe('2026-05-06T07:08:09');
    }
    // A job it did not move has no entry.
    for (const { id } of jobs.filter((j) => j.spec.expect === 'UNTOUCHED')) {
      expect(all.filter((e) => e.entity_id === id)).toHaveLength(0);
    }
  }, 300_000);

  it('leaves a cancelled job with its written reason as the note and no reason code', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    const cancelled = await seedJob(db, co, { name: 'cancelled', status: 'CANCELLED', cancelledReason: 'Customer went elsewhere', lines: [[1, 100]] });

    applyMigration(dbUrl);

    const [row] = await db.$queryRawUnsafe<Array<{ status: string; cancelled_reason: string | null; cancel_reason_code: string | null; cancelled_at: Date | null }>>(
      `SELECT status::text AS status, cancelled_reason, cancel_reason_code, cancelled_at FROM jobs WHERE id = '${cancelled}'::uuid`,
    );
    expect(row).toMatchObject({ status: 'CANCELLED', cancelled_reason: 'Customer went elsewhere', cancel_reason_code: null });
    expect(row!.cancelled_at).not.toBeNull();
    expect(await entries(db, cancelled)).toHaveLength(0);
  }, 300_000);

  it('agrees with the money-owed rule Mark Done uses, job by job, to the cent', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    const other = await newCompany(db);
    const ids: Array<{ id: string; org: string; spec: JobSpec }> = [];
    for (const spec of NAMED.filter((s) => s.expect !== 'UNTOUCHED')) ids.push({ id: await seedJob(db, co, spec), org: co.org, spec });
    for (const spec of randomSpecs(150)) ids.push({ id: await seedJob(db, other, spec), org: other.org, spec });

    // The app's rule, on the very same rows (a scope that is not a number cannot be priced by the app either).
    const { readJobMoneyOwed } = await import('../lib/job-money-owed.js');
    const rule = new Map<string, number>();
    // A job invoiced for less than it was sold for: the live rule keeps the rest of the work owed (adding an invoice never
    // lowers what a job owes, S06.13), where the migration is the frozen rule of the day it ran and reads the invoice.
    const undercut = new Set<string>();
    for (const j of ids) {
      const read = await readJobMoneyOwed({ orgId: j.org, jobId: j.id, db });
      rule.set(j.id, read.owedCents);
      const live = (j.spec.invoices ?? []).filter((i) => !i.voided && (i.kind ?? 'STANDARD') === 'STANDARD');
      const invoiced = live.reduce((sum, i) => sum + Math.round(i.total * 100), 0);
      if (live.length > 0 && read.contractCents > invoiced) undercut.add(j.id);
    }

    // The migration's own plan, before anything moves: the money it found owed, to the cent.
    const plan = await db.$queryRawUnsafe<Array<{ id: string; owed_cents: bigint; target: Target; undecided: boolean }>>(closeOutUpgradePlanSql());
    expect(plan).toHaveLength(ids.length);
    const planned = new Map(plan.map((p) => [p.id, p]));
    for (const j of ids) {
      const p = planned.get(j.id)!;
      if (p.undecided) {
        expect(p.target, j.spec.name).toBe('READY_TO_CLOSE');
        continue;
      }
      if (undercut.has(j.id)) {
        // The live rule only ever owes more than the invoice alone says.
        expect(rule.get(j.id)!, j.spec.name).toBeGreaterThanOrEqual(Number(p.owed_cents));
        continue;
      }
      expect(Number(p.owed_cents), j.spec.name).toBe(rule.get(j.id));
    }

    applyMigration(dbUrl);

    const rows = await jobRows(db);
    let toReady = 0;
    for (const j of ids) {
      const owed = undercut.has(j.id) ? Number(planned.get(j.id)!.owed_cents) : rule.get(j.id)!;
      const undecided = planned.get(j.id)!.undecided;
      const expected: Target = owed > 0 || undecided ? 'READY_TO_CLOSE' : 'DONE';
      expect(rows[j.id]!.status, `${j.spec.name} (owed ${owed} cents)`).toBe(expected);
      if (expected === 'READY_TO_CLOSE') toReady++;
    }
    // The set is wide: both outcomes, in numbers, so an agreement on "everything is Done" proves nothing.
    expect(toReady).toBeGreaterThan(40);
    expect(ids.length - toReady).toBeGreaterThan(40);
  }, 600_000);

  it('changes nothing on a second run', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    await seedNamed(db, co);
    applyMigration(dbUrl);
    const rows = await jobRows(db);
    const history = await entries(db);
    const others = await otherTableCounts(db);

    const again = runFileAgain(dbUrl);
    expect(again.status, `${again.stdout}\n${again.stderr}`).toBe(0);

    expect(await jobRows(db)).toEqual(rows);
    expect(await entries(db)).toEqual(history);
    expect(await otherTableCounts(db)).toEqual(others);
  }, 300_000);

  it('moves a job an older backend completed during the deploy when the file is run again, and no other', async () => {
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    await seedNamed(db, co);
    applyMigration(dbUrl);
    const straggler = await seedJob(db, co, { name: 'late', lines: [[1, 100]] });
    const rows = await jobRows(db);

    expect(runFileAgain(dbUrl).status).toBe(0);

    const after = await jobRows(db);
    expect(after[straggler]!.status).toBe('READY_TO_CLOSE');
    expect(await entries(db, straggler)).toHaveLength(1);
    for (const [id, row] of Object.entries(rows)) if (id !== straggler) expect(after[id]).toEqual(row);
  }, 300_000);

  it('runs for every company at once and counts each company on its own', async () => {
    const { dbUrl, db } = await scratch();
    const companies = [await newCompany(db), await newCompany(db), await newCompany(db)];
    // company 0: 2 Done, 1 Ready; company 1: nothing Completed; company 2: 1 Ready
    await seedJob(db, companies[0]!, { name: 'a', expect: 'DONE' });
    await seedJob(db, companies[0]!, { name: 'b', lines: [[1, 100]], invoices: [paidInFull] });
    await seedJob(db, companies[0]!, { name: 'c', lines: [[1, 100]] });
    await seedJob(db, companies[1]!, { name: 'd', status: 'SCHEDULED', lines: [[1, 100]] });
    await seedJob(db, companies[2]!, { name: 'e', lines: [[1, 100]] });

    applyMigration(dbUrl);

    const counts = await db.$queryRawUnsafe<Array<{ organization_id: string; status: string; n: bigint }>>(
      `SELECT organization_id, status::text AS status, count(*) AS n FROM jobs GROUP BY 1, 2`,
    );
    const of = (c: Company, status: string) => Number(counts.find((r) => r.organization_id === c.org && r.status === status)?.n ?? 0);
    expect([of(companies[0]!, 'DONE'), of(companies[0]!, 'READY_TO_CLOSE')]).toEqual([2, 1]);
    expect([of(companies[1]!, 'DONE'), of(companies[1]!, 'READY_TO_CLOSE'), of(companies[1]!, 'SCHEDULED')]).toEqual([0, 0, 1]);
    expect([of(companies[2]!, 'DONE'), of(companies[2]!, 'READY_TO_CLOSE')]).toEqual([0, 1]);
  }, 300_000);

  it('prints how many jobs will move per company and how many did (read through psql)', async () => {
    if (!hasPsql) return;
    const { dbUrl, db } = await scratch();
    const co = await newCompany(db);
    await seedJob(db, co, { name: 'a' });
    await seedJob(db, co, { name: 'b', lines: [[1, 100]] });
    const run = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION_SQL], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain(`S06.32 org ${co.org}: 1 Completed jobs will move to Done, 1 to Ready to close`);
    expect(run.stderr).toContain('S06.32 all orgs: 2 of 2 Completed jobs moved (1 to Done, 1 to Ready to close), 2 History rows written');
  }, 300_000);

  describe('the dry run and the proof check', () => {
    it('writes nothing, previews exactly what the run then does, and the proof confirms it', async () => {
      const { dbUrl, db } = await scratch();
      const a = await newCompany(db);
      const b = await newCompany(db);
      await seedJob(db, a, { name: 'a1' });
      await seedJob(db, a, { name: 'a2', lines: [[1, 100]], invoices: [paidInFull] });
      await seedJob(db, a, { name: 'a3', lines: [[1, 100]] });
      await seedJob(db, a, { name: 'a4', status: 'READY_TO_CLOSE', lines: [[1, 100]] });
      await seedJob(db, b, { name: 'b1', lines: [[2, 50]] });
      await seedJob(db, b, { name: 'b2', lines: [[1, 100]], invoices: [{ number: 'I1', total: 100 }] });
      const rows = await jobRows(db);
      const others = await otherTableCounts(db);
      const history = await entries(db);

      const dry = await dryRunReport(db);
      // the dry run left every row as it was
      expect(await jobRows(db)).toEqual(rows);
      expect(await otherTableCounts(db)).toEqual(others);
      expect(await entries(db)).toEqual(history);

      expect(dry.companies).toBe(2);
      expect(dry.totals).toEqual({ jobs: 5, done: 2, ready: 3, unpriced: 0 });
      expect(dry.perCompany).toEqual([
        { organization_id: a.org, done: 2, ready: 1, unpriced: 0, queue_now: 1 },
        { organization_id: b.org, done: 0, ready: 2, unpriced: 0, queue_now: 0 },
      ].sort((x, y) => (x.organization_id < y.organization_id ? -1 : 1)));

      // Before the run the proof says nothing has landed; the dry run's counts are what it is then checked against.
      const early = await proofReport(db, dry);
      expect(early.ok).toBe(false);
      expect(early.stillCompleted).toBe(5);

      applyMigration(dbUrl);

      const proof = await proofReport(db, dry);
      expect(proof).toMatchObject({ ok: true, stillCompleted: 0, doubleEntries: 0, badStamps: 0, differences: [] });
      expect(proof.totals).toEqual({ done: dry.totals.done, ready: dry.totals.ready });
      // after the move the dry run finds nothing left to do
      expect((await dryRunReport(db)).totals.jobs).toBe(0);
    }, 300_000);

    it('proof names a company whose counts differ from the dry run, and a job still Completed', async () => {
      const { dbUrl, db } = await scratch();
      const co = await newCompany(db);
      await seedJob(db, co, { name: 'x1' });
      await seedJob(db, co, { name: 'x2', lines: [[1, 100]] });
      const dry = await dryRunReport(db);
      applyMigration(dbUrl);
      await seedJob(db, co, { name: 'late' });

      const wrong = { ...dry, perCompany: dry.perCompany.map((c) => ({ ...c, done: c.done + 3 })) };
      const proof = await proofReport(db, wrong);

      expect(proof.ok).toBe(false);
      expect(proof.stillCompleted).toBe(1);
      expect(proof.differences).toEqual([{ organization_id: co.org, expected: { done: 4, ready: 1 }, found: { done: 1, ready: 1 } }]);
      const lines = formatProofReport(proof, true).join('\n');
      expect(lines).toContain('jobs still Completed: 1');
      expect(lines).toContain(co.org);
      expect(lines).toContain('NOT OK');
    }, 300_000);

    it('runs over one connection', async () => {
      const { dbUrl, db } = await scratch();
      const co = await newCompany(db);
      await seedJob(db, co, { name: 'one', lines: [[1, 100]] });
      const single = clientAt(`${dbUrl}${dbUrl.includes('?') ? '&' : '?'}connection_limit=1`);
      clients.push(single);
      const dry = await dryRunReport(single);
      expect(dry.totals.ready).toBe(1);
      applyMigration(dbUrl);
      expect((await proofReport(single, dry)).ok).toBe(true);
    }, 300_000);

    it('the script prints ids and counts only, never the database address, a name or a job number', async () => {
      const { dbUrl, db } = await scratch();
      const co = await newCompany(db);
      await seedJob(db, co, { name: 'p1' });
      await seedJob(db, co, { name: 'p2', lines: [[1, 100]] });
      const out = join(mkdtempSync(join(tmpdir(), 's0632-out-')), 'dry.json');
      tempDirs.push(dirname(out));
      const script = (args: string[]) =>
        spawnSync(process.execPath, [TSX_CLI, REPORT_SCRIPT, ...args], { cwd: join(__dirname, '..', '..'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });

      const dry = script(['dry-run', '--url', dbUrl, '--out', out]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(co.org);
      expect(dry.stdout).toContain('Completed jobs to move: 2');
      expect(JSON.parse(readFileSync(out, 'utf8')).totals).toEqual({ jobs: 2, done: 1, ready: 1, unpriced: 0 });

      applyMigration(dbUrl);
      const proof = script(['proof', '--url', dbUrl, '--expect', out]);
      expect(proof.status, proof.stderr + proof.stdout).toBe(0);
      expect(proof.stdout).toContain('companies whose counts differ from the dry run: 0');

      const printed = `${dry.stdout}${dry.stderr}${proof.stdout}${proof.stderr}`;
      for (const secret of [dbUrl, new URL(dbUrl).host, 's0632-', 'Pat', 'Payer', 'J-']) expect(printed).not.toContain(secret);
      // the dry run also refuses to do anything without a URL
      const none = script(['dry-run']);
      expect(none.status).toBe(2);
      // and the database was only read
      expect(await db.$queryRawUnsafe(`SELECT 1 FROM jobs WHERE status = 'COMPLETED'`)).toHaveLength(0);
    }, 300_000);
  });

  it('reports a company with a job that cannot be priced as waiting, not Done', async () => {
    const { db } = await scratch();
    const co = await newCompany(db);
    await seedJob(db, co, { name: 'unpriced', scopes: [{ title: 'x', flat_price: 'ask' }] });
    const dry = await dryRunReport(db);
    expect(dry.totals).toEqual({ jobs: 1, done: 0, ready: 1, unpriced: 1 });
    expect(formatDryRunReport(dry).join('\n')).toContain('could not be priced');
  }, 300_000);
});
