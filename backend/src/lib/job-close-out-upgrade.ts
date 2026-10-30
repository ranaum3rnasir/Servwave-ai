import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import { inReadOnlyTransaction } from './permissions/switches/presetMigrationReport';

/**
 * The two checks around the one-time move of existing Completed jobs (Roles & Permissions, PRD 6, S06.32): the dry run that
 * previews it and the proof check that shows it landed.
 *
 * Each runs against any database URL in a READ-ONLY transaction that is rolled back, so neither can write anything, and
 * prints counts and company ids only: never a company name, a job number or a person. The dry run runs the migration's
 * own plan (the SELECT between the plan markers in the migration file, read from disk), so what it previews is
 * exactly what the migration will do.
 */

/** The migration's folder name; sorts after every migration that exists when this slice is built. */
export const CLOSE_OUT_UPGRADE_MIGRATION = '20261012280000_job_close_out_upgrade';

/** The History entry each moved job gets: its event type, its words and the `via` key in its metadata. */
export const CLOSE_OUT_UPGRADE_EVENT = 'JOB_CLOSE_OUT_UPGRADED';
export const CLOSE_OUT_UPGRADE_NOTE = 'Moved by the job close-out upgrade';
export const CLOSE_OUT_UPGRADE_VIA = 'job_close_out_upgrade';

type Db = Pick<PrismaClient, '$transaction'>;

export function closeOutUpgradeMigrationSql(): string {
  return readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', CLOSE_OUT_UPGRADE_MIGRATION, 'migration.sql'), 'utf8');
}

/** The plan SELECT of the migration: one row per Completed job, with the status it moves to and the money owed on it. */
export function closeOutUpgradePlanSql(migrationSql: string = closeOutUpgradeMigrationSql()): string {
  // The markers sit alone on their line, so a comment that mentions them cannot be taken for them.
  const region = /^[ \t]*-- @plan[ \t]*\r?\n([\s\S]*?)^[ \t]*-- @end[ \t]*$/m.exec(migrationSql);
  if (!region) throw new Error('The job close-out upgrade migration has no plan region');
  return region[1]!.trim();
}

const num = (v: unknown): number => Number(v);

// ─── Dry run ────────────────────────────────────────────────────────────────────────────────────────

export interface CompanyCounts {
  organization_id: string;
  /** Completed jobs that move to Done (paid in full, or a zero total). */
  done: number;
  /** Completed jobs that move to Ready to close (money owed, work not yet invoiced included). */
  ready: number;
  /** Of those, jobs that could not be priced (a scope with no usable price): they wait Ready to close. */
  unpriced: number;
  /** Jobs already Ready to close before the move: the closers' queue count today. */
  queue_now: number;
}

export interface DryRunReport {
  /** Companies with at least one Completed job: the ones the move changes anything in. */
  companies: number;
  perCompany: CompanyCounts[];
  totals: { jobs: number; done: number; ready: number; unpriced: number };
  /** Where the money owed came from, over all companies. */
  byBasis: Array<{ basis: string; done: number; ready: number }>;
}

/** What the move would do, computed by the migration's own plan in a read-only transaction. Writes nothing. */
export async function dryRunReport(db: Db, planSql: string = closeOutUpgradePlanSql()): Promise<DryRunReport> {
  const { perCompany, byBasis } = await inReadOnlyTransaction(db, async (tx) => {
    const perCompany = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH plan AS (\n${planSql}\n)
       SELECT p.organization_id,
              count(*) FILTER (WHERE p.target = 'DONE') AS done,
              count(*) FILTER (WHERE p.target = 'READY_TO_CLOSE') AS ready,
              count(*) FILTER (WHERE p.undecided) AS unpriced,
              (SELECT count(*) FROM jobs q WHERE q.organization_id = p.organization_id AND q.status = 'READY_TO_CLOSE') AS queue_now
       FROM plan p
       GROUP BY p.organization_id
       ORDER BY p.organization_id`,
    );
    const byBasis = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `WITH plan AS (\n${planSql}\n)
       SELECT p.basis,
              count(*) FILTER (WHERE p.target = 'DONE') AS done,
              count(*) FILTER (WHERE p.target = 'READY_TO_CLOSE') AS ready
       FROM plan p
       GROUP BY p.basis
       ORDER BY p.basis`,
    );
    return { perCompany, byBasis };
  });
  const companies: CompanyCounts[] = perCompany.map((r) => ({
    organization_id: String(r.organization_id),
    done: num(r.done),
    ready: num(r.ready),
    unpriced: num(r.unpriced),
    queue_now: num(r.queue_now),
  }));
  const sum = (pick: (c: CompanyCounts) => number) => companies.reduce((n, c) => n + pick(c), 0);
  const done = sum((c) => c.done);
  const ready = sum((c) => c.ready);
  return {
    companies: companies.length,
    perCompany: companies,
    totals: { jobs: done + ready, done, ready, unpriced: sum((c) => c.unpriced) },
    byBasis: byBasis.map((r) => ({ basis: String(r.basis), done: num(r.done), ready: num(r.ready) })),
  };
}

/** The lines the dry run prints: counts and ids, never a name. */
export function formatDryRunReport(r: DryRunReport): string[] {
  const out: string[] = ['Job close-out upgrade dry run (read-only, nothing written)'];
  out.push(`companies with Completed jobs: ${r.companies}`);
  out.push(`Completed jobs to move: ${r.totals.jobs}`);
  out.push(`  to Done (paid in full, or a zero total): ${r.totals.done}`);
  out.push(`  to Ready to close (money owed, work not yet invoiced included): ${r.totals.ready}`);
  out.push(`  of those, jobs that could not be priced (kept out of Done): ${r.totals.unpriced}`);
  out.push('where the money owed was read from:');
  for (const b of r.byBasis) out.push(`  ${b.basis}: ${b.done} to Done, ${b.ready} to Ready to close`);
  out.push('per company (Done, Ready to close; the closers\' queue today -> after):');
  for (const c of r.perCompany) {
    out.push(`  ${c.organization_id}: ${c.done} Done, ${c.ready} Ready to close; queue ${c.queue_now} -> ${c.queue_now + c.ready}`);
  }
  return out;
}

// ─── Proof ──────────────────────────────────────────────────────────────────────────────────────────

export interface ProofCompany {
  organization_id: string;
  /** Jobs that carry the upgrade's History entry, by the status the entry says they moved to. */
  done: number;
  ready: number;
}

export interface ProofReport {
  perCompany: ProofCompany[];
  totals: { done: number; ready: number };
  /** Jobs still Completed: none unless an older backend completed one during the deploy. Run the migration file again. */
  stillCompleted: number;
  /** Jobs with more than one upgrade entry: always zero. */
  doubleEntries: number;
  /** Jobs the upgrade moved to Done that do not hold a Done stamp, or moved to Ready to close that hold one: always zero. */
  badStamps: number;
  /** Companies whose counts differ from the dry run's, when it was given. */
  differences: Array<{ organization_id: string; expected: { done: number; ready: number }; found: { done: number; ready: number } }>;
  ok: boolean;
}

/** Counts what the move left behind, and compares it with the dry run's counts when they are given. Writes nothing. */
export async function proofReport(db: Db, expected?: DryRunReport): Promise<ProofReport> {
  const { rows, stillCompleted, doubleEntries, badStamps } = await inReadOnlyTransaction(db, async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT te.organization_id,
              count(DISTINCT te.entity_id) FILTER (WHERE te.metadata ->> 'to' = 'DONE') AS done,
              count(DISTINCT te.entity_id) FILTER (WHERE te.metadata ->> 'to' = 'READY_TO_CLOSE') AS ready
       FROM timeline_events te
       WHERE te.entity_type = 'JOB' AND te.event_type = '${CLOSE_OUT_UPGRADE_EVENT}'
       GROUP BY te.organization_id
       ORDER BY te.organization_id`,
    );
    const [still] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM jobs WHERE status = 'COMPLETED'`);
    const [dup] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM (
         SELECT entity_id FROM timeline_events
         WHERE entity_type = 'JOB' AND event_type = '${CLOSE_OUT_UPGRADE_EVENT}'
         GROUP BY entity_id HAVING count(*) > 1) d`,
    );
    // A job that has since moved on (marked Done, reopened) legitimately differs, so a stamp is only judged on a job
    // still in the status the upgrade gave it.
    const [bad] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n
       FROM timeline_events te JOIN jobs j ON j.id = te.entity_id
       WHERE te.entity_type = 'JOB' AND te.event_type = '${CLOSE_OUT_UPGRADE_EVENT}'
         AND ((te.metadata ->> 'to' = 'DONE' AND j.status = 'DONE' AND j.closed_at IS NULL)
           OR (te.metadata ->> 'to' = 'READY_TO_CLOSE' AND j.status = 'READY_TO_CLOSE' AND j.closed_at IS NOT NULL))`,
    );
    return { rows, stillCompleted: num(still!.n), doubleEntries: num(dup!.n), badStamps: num(bad!.n) };
  });
  const perCompany: ProofCompany[] = rows.map((r) => ({ organization_id: String(r.organization_id), done: num(r.done), ready: num(r.ready) }));
  const found = new Map(perCompany.map((c) => [c.organization_id, c]));
  const differences: ProofReport['differences'] = [];
  if (expected) {
    const ids = new Set([...expected.perCompany.map((c) => c.organization_id), ...found.keys()]);
    for (const id of [...ids].sort()) {
      const want = expected.perCompany.find((c) => c.organization_id === id);
      const have = found.get(id);
      const e = { done: want?.done ?? 0, ready: want?.ready ?? 0 };
      const f = { done: have?.done ?? 0, ready: have?.ready ?? 0 };
      if (e.done !== f.done || e.ready !== f.ready) differences.push({ organization_id: id, expected: e, found: f });
    }
  }
  const sum = (pick: (c: ProofCompany) => number) => perCompany.reduce((n, c) => n + pick(c), 0);
  return {
    perCompany,
    totals: { done: sum((c) => c.done), ready: sum((c) => c.ready) },
    stillCompleted,
    doubleEntries,
    badStamps,
    differences,
    ok: stillCompleted === 0 && doubleEntries === 0 && badStamps === 0 && differences.length === 0,
  };
}

export function formatProofReport(r: ProofReport, comparedWithDryRun: boolean): string[] {
  const out: string[] = ['Job close-out upgrade proof (read-only, nothing written)'];
  out.push(`jobs moved by the upgrade: ${r.totals.done + r.totals.ready}`);
  out.push(`  moved to Done: ${r.totals.done}`);
  out.push(`  moved to Ready to close: ${r.totals.ready}`);
  out.push(`jobs still Completed: ${r.stillCompleted}${r.stillCompleted ? ' (run the migration file again to move them)' : ''}`);
  out.push(`jobs with more than one upgrade History entry: ${r.doubleEntries}`);
  out.push(`jobs whose Done stamp does not fit the status the upgrade gave them: ${r.badStamps}`);
  if (comparedWithDryRun) {
    out.push(`companies whose counts differ from the dry run: ${r.differences.length}`);
    for (const d of r.differences) {
      out.push(
        `  ${d.organization_id}: dry run ${d.expected.done} Done, ${d.expected.ready} Ready to close; ` +
          `found ${d.found.done} Done, ${d.found.ready} Ready to close`,
      );
    }
  }
  out.push('per company (Done, Ready to close):');
  for (const c of r.perCompany) out.push(`  ${c.organization_id}: ${c.done} Done, ${c.ready} Ready to close`);
  out.push(r.ok ? 'OK' : 'NOT OK');
  return out;
}
