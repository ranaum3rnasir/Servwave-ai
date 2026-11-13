/* =============================================================================
   #3468: the database's stage rules (SQL `spider_stage_of`) give the same answer as Spider's own (`spiderStageOf`,
   services/spider/config.ts) on every combination of the ten lead columns they read.

   The watch list is written by the database (triggers on leads) with the SQL function, and read by Spider with the
   TypeScript rules in mind, so the two must never disagree. Every combination: each lead status, and each of the eight
   nullable clocks set or not (2^8), so each stage, each closed state (Won, Lost, cancelled, by status or by clock),
   `returned_to_new_at`, and Contacted with and without `contacted_at` all occur. Every clock carries its own instant, so
   the entry instant names the column it came from. The SQL runs on the migrated database, as the triggers call it.

   Also a guard: the function's arguments and the update trigger's WHEN clause name exactly the columns
   SPIDER_LEAD_TIMES_SELECT reads, so a column added to the rules later fails here until the database reads it too.

   Skips when TEST_DATABASE_URL is unset. Read-only: it writes nothing.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, LeadStatus } from '@prisma/client';
import { spiderStageOf, SPIDER_LEAD_TIMES_SELECT, type SpiderLeadTimes } from '../services/spider/config';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

/** The eight clocks that may be unset; created_at never is. */
const NULLABLE = [
  'contacted_at',
  'returned_to_new_at',
  'walkthrough_first_booked_at',
  'last_visit_completed_at',
  'first_estimate_sent_at',
  'won_at',
  'lost_at',
  'cancelled_at',
] as const;

/** Each clock its own instant (with milliseconds, which timestamp(3) keeps), so an entry instant names its column. */
const INSTANT: Record<'created_at' | (typeof NULLABLE)[number], string> = {
  created_at: '2026-03-01T08:00:00.111Z',
  contacted_at: '2026-03-02T09:00:00.222Z',
  returned_to_new_at: '2026-03-03T10:00:00.333Z',
  walkthrough_first_booked_at: '2026-03-04T11:00:00.444Z',
  last_visit_completed_at: '2026-03-05T12:00:00.555Z',
  first_estimate_sent_at: '2026-03-06T13:00:00.666Z',
  won_at: '2026-03-07T14:00:00.777Z',
  lost_at: '2026-03-08T15:00:00.888Z',
  cancelled_at: '2026-03-09T16:00:00.999Z',
};

type Combination = { i: number } & Record<keyof typeof SPIDER_LEAD_TIMES_SELECT, string | null>;

function combinations(): Combination[] {
  const out: Combination[] = [];
  for (const status of Object.values(LeadStatus)) {
    for (let mask = 0; mask < 1 << NULLABLE.length; mask++) {
      const c = { i: out.length, status, created_at: INSTANT.created_at } as Combination;
      NULLABLE.forEach((col, bit) => { c[col] = mask & (1 << bit) ? INSTANT[col] : null; });
      out.push(c);
    }
  }
  return out;
}

/** What Spider's own rules say, as `stage|entered ISO` (or `none`). */
function tsAnswer(c: Combination): string {
  const lead = Object.fromEntries(
    Object.entries(c).filter(([k]) => k !== 'i').map(([k, v]) => [k, k === 'status' ? v : v === null ? null : new Date(v)]),
  ) as unknown as SpiderLeadTimes;
  const r = spiderStageOf(lead);
  return r ? `${r.stage}|${r.enteredAt.toISOString()}` : 'none';
}

suite('Spider stage rules: the database function agrees with spiderStageOf (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  afterAll(() => db.$disconnect());

  it('on every combination of status and the eight clocks', async () => {
    const all = combinations();
    expect(all).toHaveLength(Object.values(LeadStatus).length * 256);

    // One statement: every combination through the function, as the trigger calls it (named arguments).
    const rows = await db.$queryRawUnsafe<{ i: number; answer: string }[]>(
      `SELECT x.i,
              CASE WHEN s.stage IS NULL AND s.entered_at IS NULL THEN 'none'
                   ELSE coalesce(s.stage, '?') || '|' || coalesce(to_char(s.entered_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '?') END AS answer
         FROM jsonb_to_recordset($1::jsonb) AS x(
                i int, status "LeadStatus", created_at timestamp(3), contacted_at timestamp(3), returned_to_new_at timestamp(3),
                walkthrough_first_booked_at timestamp(3), last_visit_completed_at timestamp(3), first_estimate_sent_at timestamp(3),
                won_at timestamp(3), lost_at timestamp(3), cancelled_at timestamp(3))
        CROSS JOIN LATERAL spider_stage_of(
                status => x.status, created_at => x.created_at, contacted_at => x.contacted_at,
                returned_to_new_at => x.returned_to_new_at, walkthrough_first_booked_at => x.walkthrough_first_booked_at,
                last_visit_completed_at => x.last_visit_completed_at, first_estimate_sent_at => x.first_estimate_sent_at,
                won_at => x.won_at, lost_at => x.lost_at, cancelled_at => x.cancelled_at) s
        ORDER BY x.i`,
      // jsonb_to_recordset reads '...Z' into a timestamp without time zone as the UTC wall clock, as Prisma stores it.
      JSON.stringify(all.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' && k !== 'status' ? v.replace('Z', '') : v])))),
    );
    expect(rows).toHaveLength(all.length);

    const disagreements = rows
      .map((r) => ({ c: all[r.i]!, sql: r.answer, ts: tsAnswer(all[r.i]!) }))
      .filter((d) => d.sql !== d.ts)
      .map((d) => `${JSON.stringify(d.c)}: sql=${d.sql} ts=${d.ts}`);
    expect(disagreements.slice(0, 10), `${disagreements.length} combinations disagree`).toEqual([]);

    // The combinations really reach every outcome and every entry clock (a parity over one answer would prove nothing).
    const answers = new Set(all.map(tsAnswer));
    expect([...answers].sort()).toEqual(
      [
        'none',
        `NEW|${INSTANT.created_at}`,
        `NEW|${INSTANT.returned_to_new_at}`,
        `CONTACTED|${INSTANT.created_at}`, // Contacted with no contacted_at counts from creation
        `CONTACTED|${INSTANT.contacted_at}`,
        `WALKTHROUGH_COMPLETED|${INSTANT.last_visit_completed_at}`,
      ].sort(),
    );
  });

  it('is declared IMMUTABLE and takes exactly the columns SPIDER_LEAD_TIMES_SELECT reads', async () => {
    const [fn] = await db.$queryRawUnsafe<{ volatility: string; args: string[]; modes: string[] | null }[]>(
      `SELECT p.provolatile AS volatility, p.proargnames AS args, p.proargmodes::text[] AS modes
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'spider_stage_of'`,
    );
    expect(fn).toBeDefined();
    expect(fn!.volatility).toBe('i');
    const inputs = fn!.args.filter((_, k) => (fn!.modes?.[k] ?? 'i') === 'i');
    expect(inputs.sort()).toEqual(Object.keys(SPIDER_LEAD_TIMES_SELECT).sort());
  });

  it("the update trigger fires on exactly those columns, and every lead insert has its trigger", async () => {
    const triggers = await db.$queryRawUnsafe<{ name: string; def: string }[]>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS def FROM pg_trigger
        WHERE tgrelid = 'public.leads'::regclass AND NOT tgisinternal AND tgname LIKE 'spider_lead_watch%' ORDER BY tgname`,
    );
    expect(triggers.map((t) => t.name)).toEqual(['spider_lead_watch_on_insert', 'spider_lead_watch_on_update']);
    const [onInsert, onUpdate] = triggers;
    expect(onInsert!.def).toMatch(/AFTER INSERT ON (public\.)?leads FOR EACH ROW EXECUTE FUNCTION (public\.)?spider_lead_watch_sync\(\)$/);
    expect(onUpdate!.def).toMatch(/AFTER UPDATE ON (public\.)?leads FOR EACH ROW WHEN \(.*\) EXECUTE FUNCTION (public\.)?spider_lead_watch_sync\(\)$/);
    const watched = [...onUpdate!.def.matchAll(/old\.(\w+) IS DISTINCT FROM new\.(\w+)/gi)].map((m) => {
      expect(m[1]).toBe(m[2]);
      return m[1]!;
    });
    expect(watched.sort()).toEqual(Object.keys(SPIDER_LEAD_TIMES_SELECT).sort());
  });
});
