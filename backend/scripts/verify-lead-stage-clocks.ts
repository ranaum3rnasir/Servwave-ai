/**
 * Proves the lead stage clocks are actually populated on whichever database you point it at
 * (spec #1751 D10).
 *
 * READ-ONLY. It writes nothing, so it is safe to run against production.
 *
 *   npm run verify:lead-stage-clocks --workspace=backend
 *
 * WHY THIS EXISTS AT ALL. D10's backfill ships as a migration precisely so it cannot be aimed at
 * the wrong host — but "the migration is in the ledger" is not the same claim as "the columns
 * hold values", and this repo has already been burned by exactly that gap (a migration recorded
 * as applied while the enum labels it was supposed to create were absent; see
 * 20260819190000_jobstatus_enum_repair). So this asks the catalog, not the ledger.
 *
 * It also prints the database host it is talking to before it says anything else, because the
 * standing hazard here is a one-off run reporting success against STAGING while the operator
 * believed it was production. backend/.env points at staging. To check another database, pass
 * its URL in explicitly:
 *
 *   DATABASE_URL='postgresql://…' npx tsx scripts/verify-lead-stage-clocks.ts
 *
 * Exits non-zero when a lead has evidence in the visit or estimate rows that its clock should
 * hold a value and the clock is null — i.e. the backfill has not run here, or did not finish.
 * A null clock with NO underlying evidence is not a failure: D10 requires unknown to stay null.
 */
import { prisma } from '../src/lib/prisma';

type Row = {
  org: string;
  leads: bigint;
  booked_set: bigint;
  booked_gap: bigint;
  completed_set: bigint;
  completed_gap: bigint;
  last_completed_set: bigint;
  last_completed_gap: bigint;
  sent_set: bigint;
  sent_gap: bigint;
  won_set: bigint;
  won_gap: bigint;
  contacted_set: bigint;
  out_of_order: bigint;
};

function describeTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  // Host only. Never print the URL itself — it carries the password.
  const match = /@([^/?]+)/.exec(url);
  return match ? match[1] : '(DATABASE_URL not set)';
}

const n = (v: bigint) => Number(v);

async function main(): Promise<void> {
  console.log(`Database: ${describeTarget()}\n`);

  const rows = await prisma.$queryRaw<Row[]>`
    WITH ev AS (
      SELECT l.id, l.organization_id, l.status,
             l.contacted_at,
             l.walkthrough_first_booked_at, l.walkthrough_first_completed_at,
             l.last_visit_completed_at, l.first_estimate_sent_at, l.won_at,
             (SELECT MIN(v.created_at) FROM visits v WHERE v.lead_id = l.id) AS ev_booked,
             (SELECT MIN(v.completed_at) FROM visits v
                WHERE v.lead_id = l.id AND v.completed_at IS NOT NULL AND v.status <> 'CANCELLED') AS ev_first_completed,
             (SELECT MAX(v.completed_at) FROM visits v
                WHERE v.lead_id = l.id AND v.completed_at IS NOT NULL AND v.status <> 'CANCELLED') AS ev_last_completed,
             (SELECT MIN(e.sent_at) FROM estimates e
                WHERE e.lead_id = l.id AND e.sent_at IS NOT NULL) AS ev_sent,
             (SELECT MIN(e.approved_at) FROM estimates e
                WHERE e.lead_id = l.id AND e.approved_at IS NOT NULL) AS ev_approved
      FROM leads l
    )
    SELECT o.name AS org,
           count(*) AS leads,
           count(*) FILTER (WHERE walkthrough_first_booked_at IS NOT NULL) AS booked_set,
           count(*) FILTER (WHERE walkthrough_first_booked_at IS NULL AND ev_booked IS NOT NULL) AS booked_gap,
           count(*) FILTER (WHERE walkthrough_first_completed_at IS NOT NULL) AS completed_set,
           count(*) FILTER (WHERE walkthrough_first_completed_at IS NULL AND ev_first_completed IS NOT NULL) AS completed_gap,
           count(*) FILTER (WHERE last_visit_completed_at IS NOT NULL) AS last_completed_set,
           count(*) FILTER (WHERE last_visit_completed_at IS NULL AND ev_last_completed IS NOT NULL) AS last_completed_gap,
           count(*) FILTER (WHERE first_estimate_sent_at IS NOT NULL) AS sent_set,
           count(*) FILTER (WHERE first_estimate_sent_at IS NULL AND ev_sent IS NOT NULL) AS sent_gap,
           count(*) FILTER (WHERE won_at IS NOT NULL) AS won_set,
           count(*) FILTER (WHERE won_at IS NULL AND status = 'WON' AND ev_approved IS NOT NULL) AS won_gap,
           count(*) FILTER (WHERE contacted_at IS NOT NULL) AS contacted_set,
           -- The one ordering invariant that must hold on every database: the FIRST completion
           -- cannot be later than the LAST. If it is, something overwrote a monotonic clock.
           count(*) FILTER (WHERE walkthrough_first_completed_at IS NOT NULL
                              AND last_visit_completed_at IS NOT NULL
                              AND walkthrough_first_completed_at > last_visit_completed_at) AS out_of_order
    FROM ev JOIN organizations o ON o.id = ev.organization_id
    GROUP BY o.name
    ORDER BY count(*) DESC`;

  let gaps = 0;
  let disorder = 0;

  for (const r of rows) {
    const g =
      n(r.booked_gap) + n(r.completed_gap) + n(r.last_completed_gap) + n(r.sent_gap) + n(r.won_gap);
    gaps += g;
    disorder += n(r.out_of_order);
    console.log(`${r.org} — ${n(r.leads)} leads`);
    console.log(`  walkthrough booked      ${n(r.booked_set)} set, ${n(r.booked_gap)} derivable but null`);
    console.log(`  walkthrough completed   ${n(r.completed_set)} set, ${n(r.completed_gap)} derivable but null`);
    console.log(`  latest visit completed  ${n(r.last_completed_set)} set, ${n(r.last_completed_gap)} derivable but null`);
    console.log(`  first estimate sent     ${n(r.sent_set)} set, ${n(r.sent_gap)} derivable but null`);
    console.log(`  won                     ${n(r.won_set)} set, ${n(r.won_gap)} derivable but null`);
    // Reported, never failed on. D10 accepts contact history as unrecoverable, so a low number
    // here is the expected state of every org that predates the D5 writers - not a defect.
    console.log(`  contacted (not backfilled, D10) ${n(r.contacted_set)} set`);
    if (n(r.out_of_order) > 0) {
      console.log(`  !! ${n(r.out_of_order)} lead(s) whose FIRST completion is later than their LAST`);
    }
    console.log('');
  }

  if (disorder > 0) {
    console.error(`FAIL: ${disorder} lead(s) violate first-completion <= last-completion.`);
    process.exit(1);
  }
  if (gaps > 0) {
    console.error(
      `FAIL: ${gaps} clock value(s) are derivable from the visit or estimate rows but still null.\n` +
      `The D10 backfill migration has not run against this database, or did not finish.`,
    );
    process.exit(1);
  }
  console.log('OK — every clock the data can support is populated.');
}

main()
  .catch((err) => {
    console.error('Verification failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
