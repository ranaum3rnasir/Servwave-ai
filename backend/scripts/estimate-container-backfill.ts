#!/usr/bin/env tsx
/**
 * Estimate-container backfill — one-off script (editable record IDs
 * foundation, SERV10X-61 follow-up).
 *
 * Recovers Estimate.container_kind/container_seq for existing container-style
 * estimates ("<parentNumber>-<seq>", e.g. "L00005-1", "698159-3") by
 * re-deriving the parent number from the estimate_number string and matching
 * it against the org's own Lead/Customer/Job number columns. A flat/legacy
 * estimate number (no trailing "-<digits>" suffix — "E00001", a bare
 * Workiz-imported "698470") is left alone entirely.
 *
 * ALL work runs inside runWithOrg(orgId): with DB_TENANT_GUARD=on a standalone
 * script has no request context, so every query would otherwise fail CLOSED
 * (zero rows) — see src/lib/estimate-container-backfill.ts and
 * src/lib/tenant-context.ts. The core logic lives there; this file is just the
 * argv/print wrapper (precedent: scripts/ctm-backfill.ts).
 *
 * Usage:
 *   npm run backfill:estimate-containers -- --org=<uuid> [--dry-run]
 *   npm run backfill:estimate-containers -- --all-orgs [--dry-run]
 *
 *   --org       the ServWave organization id to backfill (this or --all-orgs)
 *   --all-orgs  every org that still has an un-backfilled container-style estimate. Each org is
 *               an independent run: one org's ambiguity guard tripping does NOT abort the others,
 *               and the exit code is 1 if any org failed. Preferred for the production sweep —
 *               it removes the step where an operator hand-copies four org uuids.
 *   --dry-run   classify + count only; ZERO estimate.update calls
 *
 * Ambiguity guard: if any estimate's parsed parent number matches more than
 * one candidate across Lead/Customer/Job for this org, the run refuses to
 * write ANYTHING (resolved rows included) and throws — this is intentional,
 * not a bug. Resolve the collision manually (the error lists every ambiguous
 * row) and re-run.
 *
 * Exit codes: 0 = run completed (unmatched rows are expected and reported,
 * not fatal); 1 = --org missing/malformed, or the ambiguity guard threw.
 */
import { runUnscoped, tenantConfigValues } from '../src/lib/tenant-context';
import {
  defaultDeps,
  runEstimateContainerBackfillForOrg,
  type BackfillRunResult,
} from '../src/lib/estimate-container-backfill';

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printResult(label: string, dryRun: boolean, result: BackfillRunResult): void {
  const { counters, unmatched, ambiguous } = result;
  console.log(`\n${label} — backfill ${dryRun ? 'dry-run ' : ''}complete:`);
  console.log(`  scanned:            ${counters.scanned}`);
  console.log(`  resolved:           ${counters.resolved}`);
  console.log(`  ...via rename trail:${counters.recoveredByRename}`);
  console.log(`  unmatched:          ${counters.unmatched}`);
  console.log(`  ambiguous:          ${counters.ambiguous}`);

  if (unmatched.length > 0) {
    console.log('\nUnmatched (no candidate parent found — left untouched):');
    for (const u of unmatched) console.log(`  - ${u.id} (${u.estimateNumber})`);
  }

  // Reaching here with ambiguous.length > 0 is unreachable in practice — the
  // guard inside runEstimateContainerBackfillForOrg throws first — but listed
  // defensively so a future refactor that softens the guard still prints them.
  if (ambiguous.length > 0) {
    console.log('\nAmbiguous (multiple candidate parents — left untouched):');
    for (const a of ambiguous) {
      const candidateList = a.candidates.map((c) => `${c.kind}:${c.id}`).join(', ');
      console.log(`  - ${a.id} (${a.estimateNumber}): ${candidateList}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgId = argValue(args, '--org');
  const dryRun = args.includes('--dry-run');
  const allOrgs = args.includes('--all-orgs');

  if (!allOrgs && (!orgId || !UUID_RE.test(orgId))) {
    console.error(
      'Usage: npm run backfill:estimate-containers -- (--org=<uuid> | --all-orgs) [--dry-run]',
    );
    process.exit(1);
    return;
  }

  const deps = defaultDeps();

  if (!allOrgs) {
    console.log(`Estimate-container backfill — org=${orgId}${dryRun ? ' (dry-run)' : ''}`);
    printResult(
      `org ${orgId}`,
      dryRun,
      await runEstimateContainerBackfillForOrg(deps, { orgId: orgId as string, dryRun }),
    );
    return;
  }

  // Only orgs that still hold an un-backfilled container-style estimate. Same predicate the run
  // itself filters on (container_kind IS NULL + a trailing "-<digits>"), so an org listed here
  // always has something to do.
  //
  // runUnscoped, NOT bare: this is the one cross-org query in the whole backfill, and with
  // DB_TENANT_GUARD=on a standalone script has no request context — tenantConfigValues() would
  // return neither session var, the RLS policies would match nothing (they FAIL CLOSED), and this
  // query would come back empty. `organizations`, `estimates` and `audit_logs` all have
  // relrowsecurity AND relforcerowsecurity set in production, so that is the live configuration
  // this run meets. Same contract as the per-org work, which runs inside runWithOrg(orgId).
  // The context self-check is read INSIDE the same wrapper as the query, because that is the
  // context the query actually ran in — reading it afterwards would prove nothing about it.
  const { orgs, tenant } = await runUnscoped(async () => ({
    orgs: await deps.prisma.organization.findMany({
      where: {
        estimates: { some: { container_kind: null, estimate_number: { contains: '-' } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    tenant: tenantConfigValues(),
  }));

  // An empty sweep must never be AMBIGUOUS. Zero orgs means either "nothing left to backfill" or
  // "the tenant guard ate the discovery query" (DB_TENANT_GUARD=on with no context => the RLS
  // policies fail closed and match nothing), and on the one script whose whole job is telling you
  // whether it wrote anything, an operator mistaking the second for the first is the worst
  // available outcome.
  //
  // The two cases are distinguishable for free: `bypass === 'on'` is a pure in-process check of
  // the context this query ran in, no round trip. So this exits 0 for the genuine case and throws
  // only for the broken one. Re-running the count cross-org would NOT work as a discriminator —
  // it goes through the very same guard. And "always exit 1" would be worse than useless: it
  // trains an operator to shrug at exit 1 here, which spends exactly the signal the throw buys.
  if (orgs.length === 0) {
    if (tenant.bypass !== 'on') {
      throw new Error(
        'Discovery found 0 orgs with candidate rows AND the cross-org bypass was NOT in effect ' +
          '(tenantConfigValues().bypass !== "on"), so the query was scoped away rather than ' +
          'genuinely empty: with DB_TENANT_GUARD=on the RLS policies fail closed. NOTHING WAS ' +
          "BACKFILLED. Verify with: SELECT count(*) FROM estimates WHERE container_kind IS NULL " +
          "AND estimate_number LIKE '%-%'; — and re-run with --org=<uuid> if it is non-zero.",
      );
    }
    console.log(
      'Nothing to do: 0 orgs hold an un-backfilled container-style estimate. This is the genuine ' +
        'empty case, not a scoping failure — the discovery query ran with the cross-org bypass in ' +
        'effect (tenantConfigValues().bypass === "on").',
    );
    return;
  }

  console.log(
    `Estimate-container backfill — ${orgs.length} org(s) with candidate rows${dryRun ? ' (dry-run)' : ''}`,
  );

  let failed = 0;
  for (const org of orgs) {
    try {
      printResult(
        `${org.name} (${org.id})`,
        dryRun,
        await runEstimateContainerBackfillForOrg(deps, { orgId: org.id, dryRun }),
      );
    } catch (err) {
      // One org's ambiguity guard must not stop the sweep — report it and keep going.
      failed += 1;
      console.error(`\n${org.name} (${org.id}) FAILED — nothing written for this org:`);
      console.error(err instanceof Error ? err.message : err);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} org(s) failed; every other org was backfilled.`);
  }
}

// Only run when executed directly (not when imported by tests) — same guard as
// scripts/ctm-backfill.ts.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Backfill failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
