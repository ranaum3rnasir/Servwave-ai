/**
 * Spider's alert log writes in bulk (#2990): the claims of a run go in with one insert, its sent
 * texts with one usage update, and its delivery records with one update, however many leads the
 * run alerts.
 *
 * - Claims (`claimVisits`): one `INSERT ... ON CONFLICT DO NOTHING RETURNING` (createManyAndReturn
 *   with skipDuplicates) on the claim key (company, lead, stage, entered-stage instant,
 *   counted-from). A visit already claimed by an earlier or a parallel run is skipped by the unique
 *   key and is NOT in the result, so the run sends only for the claims it wrote itself.
 * - Releasing (`releaseClaims`): a claim this run wrote but never acted on (the run lost its lease,
 *   or Spider was switched off before that lead's turn) is deleted again, in one statement, so the
 *   visit is left unclaimed exactly as it was before claims were written in bulk: the next run
 *   alerts it, and History never shows an alert that was not raised.
 * - Delivery records (`recordDeliveries`): one parameterised `UPDATE ... FROM (VALUES ...)` that
 *   replaces each row's `channels` (and `delivery`, when given) with the run's record, exactly as
 *   the per-row update did. Every value is a bound parameter with an explicit type; nothing is
 *   built into the SQL text. If that one write fails, each record is written on its own instead,
 *   so one bad moment never loses a whole run's History; each failure is logged by alert id.
 *
 * Logs carry ids only.
 */
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * Writes the claims in one insert and returns, by lead id, the alert ids of the claims THIS call
 * wrote. A claim key already taken is skipped and left out. One lead appears at most once per call
 * (a lead has one current stage visit). Throws when the insert fails: then nothing was claimed.
 */
export async function claimVisits(rows: Prisma.SpiderAlertCreateManyInput[]): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const written = await prisma.spiderAlert.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
    select: { id: true, lead_id: true },
  });
  return new Map(written.map((w) => [w.lead_id, w.id]));
}

/** The alert-log columns a claim may set: the table's own, never a name built from data. */
const CLAIM_COLUMNS: ReadonlySet<string> = new Set(Object.values(Prisma.SpiderAlertScalarFieldEnum));

/**
 * The check's claim (tick.ts, #3469): writes the claims of one company's due stays and clears their watch rows'
 * `pending`, in ONE statement (a data-modifying CTE), so a crash can never leave a claimed stay pending, nor a settled
 * stay unclaimed. Returns, by lead id, the alert ids of the claims THIS call wrote.
 *
 * A row is claimed only while its stay is still the lead's watched stay (the watch row's stage and entered-stage instant
 * match the claim) and Spider is still on for the company in the switched-on period the check read (`activatedAt`): the
 * check's switch check, in the same statement, so a check that began before a switch-off never claims into it (D4).
 * A stay already claimed by anyone (the sweep, the starting summary, another server's check) is skipped by the unique
 * key and left out of the result; its watch row's `pending` is cleared all the same (a backfilled or repaired row comes
 * back pending, #3468). The watch row of a stay that moved on meanwhile is never touched: its new stay stays pending.
 * Takes no lock beyond the statement's own writes. Throws when the statement fails: then nothing was claimed or cleared.
 */
export async function claimWatchedStays(
  orgId: string,
  activatedAt: Date,
  rows: readonly Prisma.SpiderAlertCreateManyInput[],
): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  const withIds = rows.map((r) => ({ ...r, id: r.id ?? randomUUID(), organization_id: orgId }));
  const columns = [...new Set(withIds.flatMap((r) => Object.keys(r)))];
  for (const c of columns) {
    if (!CLAIM_COLUMNS.has(c)) throw new Error(`claimWatchedStays: unknown alert-log column ${c}`);
  }
  const list = Prisma.raw(columns.map((c) => `"${c}"`).join(', '));
  const fromBatch = Prisma.raw(columns.map((c) => `b."${c}"`).join(', '));
  // Dates go in as ISO text ending in Z: a timestamp-without-time-zone column takes the UTC wall time as written.
  const batch = JSON.stringify(withIds);
  const written = await prisma.$queryRaw<{ id: string; lead_id: string }[]>`
    WITH batch AS (
      SELECT * FROM json_populate_recordset(NULL::spider_alerts, ${batch}::json)
    ),
    live AS (
      SELECT w.lead_id
        FROM spider_lead_watch w
        JOIN batch b ON b.lead_id = w.lead_id
       WHERE w.organization_id = ${orgId}::uuid
         AND b.organization_id = ${orgId}::uuid
         AND w.stage = b.status::text
         AND w.entered_at = b.entered_status_at
         AND EXISTS (
           SELECT 1 FROM spider_settings s
            WHERE s.organization_id = ${orgId}::uuid
              AND s.is_active
              AND s.activated_at = (${activatedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    ),
    ins AS (
      INSERT INTO spider_alerts (${list})
      SELECT ${fromBatch} FROM batch b WHERE b.lead_id IN (SELECT lead_id FROM live)
      ON CONFLICT DO NOTHING
      RETURNING id, lead_id
    ),
    settled AS (
      UPDATE spider_lead_watch w
         SET pending = false
        FROM batch b
       WHERE w.lead_id IN (SELECT lead_id FROM live)
         AND w.lead_id = b.lead_id
         AND w.organization_id = ${orgId}::uuid
         AND w.stage = b.status::text
         AND w.entered_at = b.entered_status_at
         AND w.pending
      RETURNING w.lead_id
    )
    SELECT id::text AS id, lead_id::text AS lead_id FROM ins`;
  return new Map(written.map((w) => [w.lead_id, w.id]));
}

/** Deletes claims this run wrote and never acted on (see the header). One statement. */
export async function releaseClaims(orgId: string, alertIds: readonly string[]): Promise<void> {
  if (alertIds.length === 0) return;
  await prisma.spiderAlert.deleteMany({ where: { organization_id: orgId, id: { in: [...alertIds] } } });
}

/** One alert-log row's delivery record: the History tab's per-channel record and, for a per-lead alert, the outcomes. */
export interface DeliveryRecord {
  id: string;
  channels: unknown;
  /** Left as it is when undefined (a starting summary's claim records its channels only). */
  delivery?: unknown;
}

/** Rows per statement: 3 parameters each, far below the protocol's parameter limit. */
const ROWS_PER_WRITE = 2_000;

/**
 * Writes the delivery records of one company's run: one statement per 2,000 rows (one for any
 * run the per-run cap allows). Never throws: a record that cannot be written is logged by id.
 * `label` names the row in the logs ("alert", or "summarized alert").
 */
export async function recordDeliveries(
  orgId: string,
  rows: readonly DeliveryRecord[],
  label: 'alert' | 'summarized alert' = 'alert',
): Promise<void> {
  for (let i = 0; i < rows.length; i += ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + ROWS_PER_WRITE);
    try {
      await prisma.$executeRaw(deliveryUpdate(orgId, chunk));
    } catch (err) {
      logger.error(`[spider] could not record ${chunk.length} delivery records in one write for org ${orgId}, writing them one by one: ${errorName(err)}`);
      for (const row of chunk) await recordOne(row, label);
    }
  }
}

/**
 * The one statement. `channels` is always replaced; `delivery` is replaced when the row carries one
 * and kept otherwise (a NULL parameter, then COALESCE). A row of another company is never touched.
 */
function deliveryUpdate(orgId: string, rows: readonly DeliveryRecord[]): Prisma.Sql {
  const values = rows.map(
    (r) =>
      Prisma.sql`(${r.id}::uuid, ${r.delivery === undefined ? null : JSON.stringify(r.delivery)}::jsonb, ${JSON.stringify(r.channels)}::jsonb)`,
  );
  return Prisma.sql`
    UPDATE spider_alerts AS a
       SET channels = v.channels,
           delivery = COALESCE(v.delivery, a.delivery)
      FROM (VALUES ${Prisma.join(values)}) AS v(id, delivery, channels)
     WHERE a.id = v.id
       AND a.organization_id = ${orgId}::uuid`;
}

/**
 * Adds a run's sent texts to each alert-log row's count (comm-usage.ts sums the column into the company's texting
 * usage): one `UPDATE ... FROM (VALUES ...)` per 2,000 rows, typed bound parameters only. Never throws. Unlike the
 * delivery records it is NOT retried row by row when the one write fails: an addition is not safe to repeat (a write
 * that reached the database before its answer was lost would be counted twice, and usage is what a company is
 * billed on). The texts left uncounted are logged by alert id and number.
 */
export async function countSentTexts(orgId: string, counts: ReadonlyMap<string, number>): Promise<void> {
  const rows = [...counts].filter(([, n]) => n > 0);
  for (let i = 0; i < rows.length; i += ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + ROWS_PER_WRITE);
    const values = chunk.map(([id, n]) => Prisma.sql`(${id}::uuid, ${n}::int)`);
    try {
      await prisma.$executeRaw`
        UPDATE spider_alerts AS a
           SET texts_sent = a.texts_sent + v.sent
          FROM (VALUES ${Prisma.join(values)}) AS v(id, sent)
         WHERE a.id = v.id
           AND a.organization_id = ${orgId}::uuid`;
    } catch (err) {
      logger.error(
        `[spider] could not count sent texts for org ${orgId} - uncounted: ${chunk.map(([id, n]) => `alert ${id} ${n}`).join(', ')}: ${errorName(err)}`,
      );
    }
  }
}

/** The fallback: the per-row update every record used before #2990. */
async function recordOne(row: DeliveryRecord, label: string): Promise<void> {
  try {
    await prisma.spiderAlert.update({
      where: { id: row.id },
      data: {
        channels: row.channels as Prisma.InputJsonValue,
        ...(row.delivery === undefined ? {} : { delivery: row.delivery as Prisma.InputJsonValue }),
      },
    });
  } catch (err) {
    logger.error(`[spider] could not record delivery for ${label} ${row.id}: ${errorName(err)}`);
  }
}

/** An error's class name only - never its message, which can carry the values it failed on. */
function errorName(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.name} ${err.code}`;
  return err instanceof Error ? err.name : 'unknown error';
}
