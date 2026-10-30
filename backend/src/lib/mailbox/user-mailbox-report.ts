import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import { inReadOnlyTransaction } from '../permissions/switches/presetMigrationReport';

/**
 * The two checks around the one-time issue of a mailbox to every active user (Roles & Permissions, PRD 10, S10.3): the
 * dry run that previews it and the proof check that shows it landed.
 *
 * Each runs against any database URL in a READ-ONLY transaction that is rolled back, so neither can write anything, and
 * prints counts, company ids and user ids only: never a company name, a person's name or an address. The dry run runs
 * the migration's own plan (the SELECT between the plan markers in the migration file, read from disk), so what it
 * previews is exactly what the migration will do. The namesake list is by user id: it is what a person reads to see
 * whose address is decided by the earlier-created-wins rule before it runs.
 *
 * THE STOP CONDITIONS. The migration stops, rolling everything back, when its end state is wrong: a user with two live
 * mailboxes (the unique index cannot be built), an active user left without a mailbox, an active user mailbox left
 * without a primary address. The dry run evaluates all three against the end state the plan would produce and prints
 * PASS or FAIL for each, with the ids of what would trip it; the proof check evaluates the same three on the written
 * state. Why a model of the migration's checks and not the migration itself run inside a rolled-back transaction: a
 * rehearsal would take the migration's table locks on a live database and hold a write transaction open, and the dry
 * run is the thing run against production in working hours, so it stays read-only. The migration file is applied
 * on staging and can never change again, and two things keep the model honest: a test that the file raises exactly
 * the errors modelled here (and no other), and real-database tests that apply the migration to databases built to
 * trip each condition and compare its failure with what the dry run said (user-mailboxes-migration-db.test.ts).
 * What a model cannot see, a trigger or an unforeseen constraint on the two tables, it does not predict.
 */

/** The migration's folder name; sorts after every migration that exists when this slice is built. */
export const USER_MAILBOX_MIGRATION = '20261012320000_user_mailboxes';

type Db = Pick<PrismaClient, '$transaction'>;

export function userMailboxMigrationSql(): string {
  return readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'migrations', USER_MAILBOX_MIGRATION, 'migration.sql'), 'utf8');
}

/** The plan SELECT of the migration: one row per active user without a live mailbox, with what that user gets. */
export function userMailboxPlanSql(migrationSql: string = userMailboxMigrationSql()): string {
  // The markers sit alone on their line, so a comment that mentions them cannot be taken for them.
  const region = /^[ \t]*-- @plan[ \t]*\r?\n([\s\S]*?)^[ \t]*-- @end[ \t]*$/m.exec(migrationSql);
  if (!region) throw new Error('The user mailbox migration has no plan region');
  return region[1]!.trim();
}

const num = (v: unknown): number => Number(v);

/** Why a user is put in "address needed" instead of being given an address. */
export const NEEDED_REASONS = ['namesake', 'taken', 'no_name', 'no_company_part'] as const;
export type NeededReason = (typeof NEEDED_REASONS)[number];

// ─── Dry run ────────────────────────────────────────────────────────────────────────────────────────

export interface CompanyCounts {
  organization_id: string;
  /** Active users with no live mailbox yet: the ones the migration acts on. */
  users: number;
  /** Mailboxes that get a first.last.company address. */
  issue: number;
  /** Mailboxes created in "address needed", with no address. */
  address_needed: number;
  /** Of those, by reason. */
  by_reason: Record<NeededReason, number>;
}

/** Users who asked for a name part someone else in the company gets: the earlier-created user wins. */
export interface NamesakeGroup {
  organization_id: string;
  /** The user who gets the address. */
  winner_user_id: string;
  /** The users who land in "address needed". */
  loser_user_ids: string[];
}

/** The user mailboxes a company already has when the dry run is taken (none on an environment that has not run it yet), by state. */
export interface ExistingMailboxes {
  organization_id: string;
  active_with_address: number;
  /** Active with no primary address: the state that stopped the migration on staging. */
  active_without_address: number;
  address_needed: number;
  merged: number;
}

export type StopConditionKey = 'one_live_mailbox_per_user' | 'every_active_user_has_a_mailbox' | 'every_active_mailbox_has_a_primary_address';

/** A condition the migration stops on, evaluated against the end state it would leave. Ids only, never names or addresses. */
export interface StopCondition {
  key: StopConditionKey;
  /** What it guards, in words. */
  rule: string;
  /** How many the migration's own check would count. */
  count: number;
  pass: boolean;
  /** The error the migration stops with when this fails, with the count. */
  message: string;
  mailbox_ids: string[];
  user_ids: string[];
  company_ids: string[];
}

/** Where the migration stands on the ledger of the database asked. */
export type Ledger = 'applied' | 'failed_unresolved' | 'not_recorded';

export interface DryRunReport {
  /** The ledger row of the migration on this database. */
  ledger: Ledger;
  /** True when the migration is already applied here: nothing is planned or checked. */
  alreadyApplied: boolean;
  /** Companies with at least one active user to give a mailbox to. */
  companies: number;
  existing: ExistingMailboxes[];
  perCompany: CompanyCounts[];
  totals: { users: number; issue: number; address_needed: number; by_reason: Record<NeededReason, number>; namesake_groups: number };
  namesakes: NamesakeGroup[];
  /** In the order the migration meets them. */
  stopConditions: StopCondition[];
}

const noReasons = (): Record<NeededReason, number> => ({ namesake: 0, taken: 0, no_name: 0, no_company_part: 0 });

const RULES: Record<StopConditionKey, string> = {
  one_live_mailbox_per_user: 'no user has two live mailboxes (the unique index the migration builds)',
  every_active_user_has_a_mailbox: 'every active user ends with a mailbox',
  every_active_mailbox_has_a_primary_address: 'every active user mailbox ends with a primary address',
};

/**
 * The error the migration stops with for a condition, with the count. The first is Postgres's own, for the index the migration
 * builds; the other two are the migration's RAISE EXCEPTION texts, which a test compares with the file.
 */
export function stopConditionMessage(key: StopConditionKey, count: number): string {
  switch (key) {
    case 'one_live_mailbox_per_user':
      return 'could not create unique index "mailboxes_one_live_per_user"';
    case 'every_active_user_has_a_mailbox':
      return `S10.3: ${count} active users are left without a mailbox`;
    case 'every_active_mailbox_has_a_primary_address':
      return `S10.3: ${count} active user mailboxes are left without a primary address`;
  }
}

/** A plan with no rows: the end state IS the state of the database (the proof check). Same columns as the migration's plan. */
const NO_PLAN = `SELECT NULL::uuid AS user_id, NULL::uuid AS organization_id, NULL::timestamp AS created_at, NULL::text AS outcome,
                        NULL::uuid AS winner_user_id, NULL::text AS local_part WHERE false`;

interface Offender {
  mailbox_id: string | null;
  user_id: string | null;
  organization_id: string;
}

function condition(key: StopConditionKey, offenders: Offender[], count: number): StopCondition {
  const ids = (pick: (o: Offender) => string | null) => [...new Set(offenders.map(pick).filter((v): v is string => v !== null))].sort();
  return {
    key,
    rule: RULES[key],
    count,
    pass: count === 0,
    message: stopConditionMessage(key, count),
    mailbox_ids: ids((o) => o.mailbox_id),
    user_ids: ids((o) => o.user_id),
    company_ids: ids((o) => o.organization_id),
  };
}

const offenders = (rows: Array<Record<string, unknown>>): Offender[] =>
  rows.map((r) => ({
    mailbox_id: r.mailbox_id == null ? null : String(r.mailbox_id),
    user_id: r.user_id == null ? null : String(r.user_id),
    organization_id: String(r.organization_id),
  }));

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * The migration's stop conditions, evaluated against the end state it would leave: what the database holds plus what
 * `planSql` would write (the migration's own plan for the dry run, none for the proof check). Read-only. Returned in
 * the order the migration meets them.
 */
async function evaluateStopConditions(tx: Tx, planSql: string): Promise<StopCondition[]> {
  // 1. The unique index the migration builds first: a user with two live mailboxes stops it.
  const doubles = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT m.id AS mailbox_id, m.user_id, m.organization_id
     FROM mailboxes m
     WHERE m.kind = 'user' AND m.status <> 'merged'
       AND m.user_id IN (SELECT user_id FROM mailboxes
                         WHERE kind = 'user' AND status <> 'merged' AND user_id IS NOT NULL
                         GROUP BY user_id HAVING count(*) > 1)`,
  );
  // 2. "active users are left without a mailbox": active, no live mailbox, and not in the plan that gives them one.
  const without = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `WITH plan AS (\n${planSql}\n)
     SELECT NULL::uuid AS mailbox_id, u.id AS user_id, u.organization_id
     FROM users u
     WHERE u.is_active
       AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.kind = 'user' AND m.user_id = u.id AND m.status <> 'merged')
       AND NOT EXISTS (SELECT 1 FROM plan p WHERE p.user_id = u.id)`,
  );
  // 3. "active user mailboxes are left without a primary address": every active user mailbox already there with none, and
  // every planned address the register would skip because another planned row (or an existing one) holds the same local
  // part (the migration's INSERT ... ON CONFLICT DO NOTHING). Of two rows planned for one local part, the later-created
  // is the one named; which the database loses is its choice.
  const bare = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `WITH plan AS (\n${planSql}\n),
     issued AS (
       SELECT p.user_id, p.organization_id, p.local_part,
              row_number() OVER (PARTITION BY p.local_part ORDER BY p.created_at, p.user_id) AS place
       FROM plan p WHERE p.outcome = 'issue'
     )
     SELECT m.id AS mailbox_id, NULL::uuid AS user_id, m.organization_id
     FROM mailboxes m
     WHERE m.kind = 'user' AND m.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id = m.id AND a.is_primary)
     UNION ALL
     SELECT NULL::uuid, i.user_id, i.organization_id
     FROM issued i
     WHERE i.place > 1 OR EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.local_part = i.local_part)`,
  );
  const doubleOffenders = offenders(doubles);
  return [
    condition('one_live_mailbox_per_user', doubleOffenders, new Set(doubleOffenders.map((o) => o.user_id)).size),
    condition('every_active_user_has_a_mailbox', offenders(without), without.length),
    condition('every_active_mailbox_has_a_primary_address', offenders(bare), bare.length),
  ];
}

/** Where the migration stands on this database's ledger (Prisma's `_prisma_migrations`). */
async function ledgerOf(tx: Tx): Promise<Ledger> {
  const [table] = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS present`);
  if (!table!.present) return 'not_recorded';
  const rows = await tx.$queryRawUnsafe<Array<{ finished: boolean; rolled_back: boolean }>>(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations WHERE migration_name = $1`,
    USER_MAILBOX_MIGRATION,
  );
  if (rows.some((r) => r.finished && !r.rolled_back)) return 'applied';
  if (rows.some((r) => !r.finished && !r.rolled_back)) return 'failed_unresolved';
  return 'not_recorded';
}

/** The mailboxes a company already has, by state, merged ones too. */
async function existingMailboxes(tx: Tx): Promise<ExistingMailboxes[]> {
  const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT m.organization_id,
            count(*) FILTER (WHERE m.status = 'active' AND EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id = m.id AND a.is_primary)) AS active_with_address,
            count(*) FILTER (WHERE m.status = 'active' AND NOT EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id = m.id AND a.is_primary)) AS active_without_address,
            count(*) FILTER (WHERE m.status = 'address_needed') AS address_needed,
            count(*) FILTER (WHERE m.status = 'merged') AS merged
     FROM mailboxes m
     WHERE m.kind = 'user'
     GROUP BY m.organization_id
     ORDER BY m.organization_id`,
  );
  return rows.map((r) => ({
    organization_id: String(r.organization_id),
    active_with_address: num(r.active_with_address),
    active_without_address: num(r.active_without_address),
    address_needed: num(r.address_needed),
    merged: num(r.merged),
  }));
}

/**
 * What the migration would do, computed by its own plan in a read-only transaction, and whether any of its stop
 * conditions would trip on the end state. On a database that already has the migration it says so and plans nothing.
 * Writes nothing.
 */
export async function dryRunReport(db: Db, planSql: string = userMailboxPlanSql()): Promise<DryRunReport> {
  const { ledger, counts, losers, existing, stopConditions } = await inReadOnlyTransaction(db, async (tx) => {
    const ledger = await ledgerOf(tx);
    if (ledger === 'applied') {
      return { ledger, counts: [], losers: [], existing: [], stopConditions: [] };
    }
    const counts = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH plan AS (\n${planSql}\n)
       SELECT p.organization_id,
              count(*) AS users,
              count(*) FILTER (WHERE p.outcome = 'issue') AS issue,
              count(*) FILTER (WHERE p.outcome = 'namesake') AS namesake,
              count(*) FILTER (WHERE p.outcome = 'taken') AS taken,
              count(*) FILTER (WHERE p.outcome = 'no_name') AS no_name,
              count(*) FILTER (WHERE p.outcome = 'no_company_part') AS no_company_part
       FROM plan p
       GROUP BY p.organization_id
       ORDER BY p.organization_id`,
    );
    const losers = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH plan AS (\n${planSql}\n)
       SELECT p.organization_id, p.winner_user_id, p.user_id, p.created_at
       FROM plan p
       WHERE p.outcome = 'namesake'
       ORDER BY p.organization_id, p.winner_user_id, p.created_at, p.user_id`,
    );
    return { ledger, counts, losers, existing: await existingMailboxes(tx), stopConditions: await evaluateStopConditions(tx, planSql) };
  });
  const perCompany: CompanyCounts[] = counts.map((r) => {
    const by_reason = { namesake: num(r.namesake), taken: num(r.taken), no_name: num(r.no_name), no_company_part: num(r.no_company_part) };
    return {
      organization_id: String(r.organization_id),
      users: num(r.users),
      issue: num(r.issue),
      address_needed: by_reason.namesake + by_reason.taken + by_reason.no_name + by_reason.no_company_part,
      by_reason,
    };
  });
  const groups = new Map<string, NamesakeGroup>();
  for (const row of losers) {
    const key = `${row.organization_id}/${row.winner_user_id}`;
    const group = groups.get(key) ?? { organization_id: String(row.organization_id), winner_user_id: String(row.winner_user_id), loser_user_ids: [] };
    group.loser_user_ids.push(String(row.user_id));
    groups.set(key, group);
  }
  const by_reason = noReasons();
  for (const c of perCompany) for (const reason of NEEDED_REASONS) by_reason[reason] += c.by_reason[reason];
  const sum = (pick: (c: CompanyCounts) => number) => perCompany.reduce((n, c) => n + pick(c), 0);
  return {
    ledger,
    alreadyApplied: ledger === 'applied',
    companies: perCompany.length,
    existing,
    perCompany,
    totals: { users: sum((c) => c.users), issue: sum((c) => c.issue), address_needed: sum((c) => c.address_needed), by_reason, namesake_groups: groups.size },
    namesakes: [...groups.values()],
    stopConditions,
  };
}

/** 0 when the migration would apply; 1 when any stop condition would trip, so a release script cannot miss it. */
export function dryRunExitCode(r: DryRunReport): number {
  return r.stopConditions.some((c) => !c.pass) ? 1 : 0;
}

/** Ids printed per kind before "and N more"; the JSON carries them all. */
const MAX_IDS_PRINTED = 50;

function stopConditionLines(conditions: StopCondition[]): string[] {
  const out: string[] = [];
  const ids = (label: string, list: string[]) => {
    if (!list.length) return;
    const shown = list.slice(0, MAX_IDS_PRINTED).join(', ');
    out.push(`        ${label}: ${shown}${list.length > MAX_IDS_PRINTED ? ` and ${list.length - MAX_IDS_PRINTED} more` : ''}`);
  };
  for (const c of conditions) {
    if (c.pass) {
      out.push(`  PASS  ${c.rule}`);
      continue;
    }
    out.push(`  FAIL  ${c.message} (${c.rule}; ${c.count} found)`);
    ids('mailboxes', c.mailbox_ids);
    ids('users', c.user_ids);
    ids('companies', c.company_ids);
  }
  return out;
}

/** The lines the dry run prints: counts and ids, never a name or an address. */
export function formatDryRunReport(r: DryRunReport): string[] {
  const out: string[] = ['User mailbox dry run (read-only, nothing written)'];
  if (r.alreadyApplied) {
    out.push('already applied: nothing to do (the migration is recorded as applied on this database)');
    return out;
  }
  if (r.ledger === 'failed_unresolved') out.push('note: an earlier attempt of this migration is recorded as failed and not yet resolved on this database');
  const sumExisting = (pick: (e: ExistingMailboxes) => number) => r.existing.reduce((n, e) => n + pick(e), 0);
  out.push(
    `user mailboxes that already exist: ${sumExisting((e) => e.active_with_address)} active with an address, ` +
      `${sumExisting((e) => e.active_without_address)} active WITHOUT an address, ${sumExisting((e) => e.address_needed)} address needed, ${sumExisting((e) => e.merged)} merged`,
  );
  for (const e of r.existing) {
    out.push(`  ${e.organization_id}: ${e.active_with_address} active with an address, ${e.active_without_address} active WITHOUT an address, ${e.address_needed} address needed, ${e.merged} merged`);
  }
  out.push(`companies with active users to give a mailbox: ${r.companies}`);
  out.push(`active users without a mailbox: ${r.totals.users}`);
  out.push(`  mailboxes to issue, with a first.last.company address: ${r.totals.issue}`);
  out.push(`  mailboxes created in "address needed", with no address: ${r.totals.address_needed}`);
  out.push(`    a namesake of an earlier-created user in the same run: ${r.totals.by_reason.namesake}`);
  out.push(`    name already issued to someone in the company before: ${r.totals.by_reason.taken}`);
  out.push(`    no usable name: ${r.totals.by_reason.no_name}`);
  out.push(`    company has no frozen company part: ${r.totals.by_reason.no_company_part}`);
  out.push(`  namesake groups (one winner each): ${r.totals.namesake_groups}`);
  out.push('per company (users: issue, address needed [namesake / taken / no name / no company part]):');
  for (const c of r.perCompany) {
    const b = c.by_reason;
    out.push(`  ${c.organization_id}: ${c.users}: ${c.issue} issue, ${c.address_needed} address needed [${b.namesake} / ${b.taken} / ${b.no_name} / ${b.no_company_part}]`);
  }
  if (r.namesakes.length) {
    out.push('namesakes (company: the user who gets the address -> the users who are in address needed):');
    for (const g of r.namesakes) out.push(`  ${g.organization_id}: ${g.winner_user_id} -> ${g.loser_user_ids.join(', ')}`);
  }
  out.push('stop conditions of the migration, checked against the end state the plan would leave:');
  out.push(...stopConditionLines(r.stopConditions));
  out.push(dryRunExitCode(r) === 0 ? 'result: every stop condition passes' : 'result: the migration would STOP (exit code 1)');
  return out;
}

// ─── Proof ──────────────────────────────────────────────────────────────────────────────────────────

export interface ProofCompany {
  organization_id: string;
  /** Live (not merged) user mailboxes. */
  mailboxes: number;
  active: number;
  address_needed: number;
}

export interface ProofReport {
  perCompany: ProofCompany[];
  totals: { mailboxes: number; active: number; address_needed: number };
  /** Active users with no live mailbox: none unless an older backend created one after the migration ran. Run the migration file again. */
  usersWithoutMailbox: number;
  /** Users with more than one live mailbox: always zero (a unique index). */
  doubleMailboxes: number;
  /** Active mailboxes with no primary address, or "address needed" ones that hold an address: always zero. */
  badAddresses: number;
  /** Local parts shared by two rows: always zero (a unique index). */
  sharedAddresses: number;
  /** Companies whose counts differ from the dry run's, when it was given. */
  differences: Array<{ organization_id: string; expected: { active: number; address_needed: number }; found: { active: number; address_needed: number } }>;
  /** The migration's own stop conditions, evaluated on the written state (the dry run evaluates them on the planned one). */
  stopConditions: StopCondition[];
  ok: boolean;
}

/**
 * Counts what the migration left behind and checks the invariants. With the dry run's counts it also compares company by
 * company: what the company already had live when the dry run was taken, plus what the dry run planned. Writes nothing.
 */
export async function proofReport(db: Db, expected?: DryRunReport): Promise<ProofReport> {
  const { rows, stopConditions, doubleMailboxes, badAddresses, sharedAddresses } = await inReadOnlyTransaction(db, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT m.organization_id,
              count(*) AS mailboxes,
              count(*) FILTER (WHERE m.status = 'active') AS active,
              count(*) FILTER (WHERE m.status = 'address_needed') AS address_needed
       FROM mailboxes m
       WHERE m.kind = 'user' AND m.status <> 'merged'
       GROUP BY m.organization_id
       ORDER BY m.organization_id`,
    );
    const [dup] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM (
         SELECT user_id FROM mailboxes WHERE kind = 'user' AND status <> 'merged' AND user_id IS NOT NULL
         GROUP BY user_id HAVING count(*) > 1) d`,
    );
    const [bad] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM mailboxes m
       WHERE m.kind = 'user'
         AND ((m.status = 'active' AND NOT EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id = m.id AND a.is_primary))
           OR (m.status = 'address_needed' AND EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.mailbox_id = m.id)))`,
    );
    const [shared] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM (SELECT local_part FROM mailbox_addresses GROUP BY local_part HAVING count(*) > 1) s`,
    );
    return { rows, stopConditions: await evaluateStopConditions(tx, NO_PLAN), doubleMailboxes: num(dup!.n), badAddresses: num(bad!.n), sharedAddresses: num(shared!.n) };
  });
  const usersWithoutMailbox = stopConditions.find((c) => c.key === 'every_active_user_has_a_mailbox')!.count;
  const perCompany: ProofCompany[] = rows.map((r) => ({
    organization_id: String(r.organization_id), mailboxes: num(r.mailboxes), active: num(r.active), address_needed: num(r.address_needed),
  }));
  const found = new Map(perCompany.map((c) => [c.organization_id, c]));
  const differences: ProofReport['differences'] = [];
  if (expected) {
    const ids = new Set([...expected.perCompany.map((c) => c.organization_id), ...expected.existing.map((c) => c.organization_id), ...found.keys()]);
    for (const id of [...ids].sort()) {
      const want = expected.perCompany.find((c) => c.organization_id === id);
      const have = found.get(id);
      const was = expected.existing.find((c) => c.organization_id === id);
      const e = { active: (was ? was.active_with_address + was.active_without_address : 0) + (want?.issue ?? 0), address_needed: (was?.address_needed ?? 0) + (want?.address_needed ?? 0) };
      const f = { active: have?.active ?? 0, address_needed: have?.address_needed ?? 0 };
      if (e.active !== f.active || e.address_needed !== f.address_needed) differences.push({ organization_id: id, expected: e, found: f });
    }
  }
  const sum = (pick: (c: ProofCompany) => number) => perCompany.reduce((n, c) => n + pick(c), 0);
  return {
    perCompany,
    totals: { mailboxes: sum((c) => c.mailboxes), active: sum((c) => c.active), address_needed: sum((c) => c.address_needed) },
    usersWithoutMailbox,
    doubleMailboxes,
    badAddresses,
    sharedAddresses,
    differences,
    stopConditions,
    ok: stopConditions.every((c) => c.pass) && doubleMailboxes === 0 && badAddresses === 0 && sharedAddresses === 0 && differences.length === 0,
  };
}

export function formatProofReport(r: ProofReport, comparedWithDryRun: boolean): string[] {
  const out: string[] = ['User mailbox proof (read-only, nothing written)'];
  out.push(`live user mailboxes: ${r.totals.mailboxes}`);
  out.push(`  with an address: ${r.totals.active}`);
  out.push(`  in address needed: ${r.totals.address_needed}`);
  out.push(`active users without a mailbox: ${r.usersWithoutMailbox}${r.usersWithoutMailbox ? ' (run the migration file again to give them one)' : ''}`);
  out.push(`users with more than one live mailbox: ${r.doubleMailboxes}`);
  out.push(`mailboxes whose address does not fit their status: ${r.badAddresses}`);
  out.push(`addresses held by more than one row: ${r.sharedAddresses}`);
  out.push('stop conditions of the migration, checked on the written state:');
  out.push(...stopConditionLines(r.stopConditions));
  if (comparedWithDryRun) {
    out.push(`companies whose counts differ from the dry run: ${r.differences.length}`);
    for (const d of r.differences) {
      out.push(
        `  ${d.organization_id}: dry run ${d.expected.active} with an address, ${d.expected.address_needed} address needed; ` +
          `found ${d.found.active} with an address, ${d.found.address_needed} address needed`,
      );
    }
  }
  out.push('per company (with an address, address needed):');
  for (const c of r.perCompany) out.push(`  ${c.organization_id}: ${c.active} with an address, ${c.address_needed} address needed`);
  out.push(r.ok ? 'OK' : 'NOT OK');
  return out;
}
