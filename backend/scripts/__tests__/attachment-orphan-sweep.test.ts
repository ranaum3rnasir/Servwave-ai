import { describe, it, expect } from 'vitest';
import { MIN_GRACE_HOURS, DEFAULT_GRACE_HOURS } from '../../src/lib/attachment-orphan-sweep';
import { USAGE, parseSweepArgs, selectSweepTargets, sweepExitProblem } from '../attachment-orphan-sweep';

/**
 * S3 — the CLI half of the orphan sweep.
 *
 * The only acceptance criterion that lives entirely in argv handling is "a dry-run mode exists
 * and is the default", and it inverts this repo's convention, so it is the single most likely
 * thing to be un-inverted by a later edit that assumes the usual `--dry-run` opt-in. These
 * tests exist so that edit fails loudly instead of arming a deleter.
 */

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('parseSweepArgs — dry-run is the DEFAULT, deleting is opt-in', () => {
  it('is a dry-run when no mode flag is given at all', () => {
    expect(parseSweepArgs([`--org=${ORG}`]).dryRun).toBe(true);
  });

  it('is STILL a dry-run when the repo-conventional --dry-run is passed', () => {
    // An operator carrying the habit over from reseed-builtin-keys.ts must not be surprised
    // either way: the flag is redundant here, never an arming flag.
    expect(parseSweepArgs([`--org=${ORG}`, '--dry-run']).dryRun).toBe(true);
  });

  it('only deletes when --delete is passed explicitly', () => {
    expect(parseSweepArgs([`--org=${ORG}`, '--delete']).dryRun).toBe(false);
  });

  it('is a dry-run for --all-orgs too', () => {
    const parsed = parseSweepArgs(['--all-orgs']);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.allOrgs).toBe(true);
    expect(parsed.error).toBeUndefined();
  });
});

describe('parseSweepArgs — refusals, all before any storage call', () => {
  it('refuses a run with neither --org nor --all-orgs', () => {
    expect(parseSweepArgs([]).error).toMatch(/usage/i);
  });

  it('refuses a malformed --org', () => {
    expect(parseSweepArgs(['--org=not-a-uuid']).error).toMatch(/usage/i);
  });

  it('refuses a grace window below the floor, even in dry-run', () => {
    const parsed = parseSweepArgs([`--org=${ORG}`, `--min-age-hours=${MIN_GRACE_HOURS - 1}`]);
    expect(parsed.error).toMatch(/floor/i);
    expect(parsed.dryRun).toBe(true);
  });

  it('refuses a non-numeric grace window rather than defaulting silently', () => {
    expect(parseSweepArgs([`--org=${ORG}`, '--min-age-hours=soon']).error).toMatch(/must be a number/);
  });

  it('accepts a grace window at or above the floor, and defaults to 7 days', () => {
    expect(parseSweepArgs([`--org=${ORG}`]).graceHours).toBe(DEFAULT_GRACE_HOURS);
    expect(parseSweepArgs([`--org=${ORG}`, `--min-age-hours=${MIN_GRACE_HOURS}`]).error).toBeUndefined();
    expect(parseSweepArgs([`--org=${ORG}`, '--min-age-hours=720']).graceHours).toBe(720);
  });
});

describe('parseSweepArgs — argv hardening (this is a deleter)', () => {
  it('refuses an unknown flag rather than ignoring it', () => {
    // `--min-age-hourz=720` would otherwise run at the 168h default, and `--delele` would
    // run as a dry-run. Both fail safe, but an operator who mistypes should be told.
    expect(parseSweepArgs([`--org=${ORG}`, '--min-age-hourz=720']).error).toMatch(/unknown/i);
    expect(parseSweepArgs([`--org=${ORG}`, '--delele']).error).toMatch(/unknown/i);
  });

  it('refuses a repeated flag instead of silently taking the first', () => {
    // `.find` is first-wins: `--min-age-hours=48 --min-age-hours=720` used 48. An operator
    // appending a LARGER window to be safer would silently keep the smaller one.
    const parsed = parseSweepArgs([`--org=${ORG}`, '--min-age-hours=48', '--min-age-hours=720']);
    expect(parsed.error).toMatch(/more than once/i);
  });

  it('still accepts the documented flags', () => {
    const parsed = parseSweepArgs([
      `--org=${ORG}`, '--min-age-hours=720', '--delete', '--include-orgless-prefixes',
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.dryRun).toBe(false);
    expect(parsed.includeOrglessPrefixes).toBe(true);
  });

  it('does not include orgless prefixes unless asked', () => {
    expect(parseSweepArgs(['--all-orgs']).includeOrglessPrefixes).toBe(false);
  });
});

describe('selectSweepTargets — orgless prefixes are reported, not swept', () => {
  const LIVE = 'dddddddd-0000-4000-8000-000000000004';
  const DEAD = 'eeeeeeee-0000-4000-8000-000000000005';
  const dbOrgs = [{ id: LIVE, name: 'Live Org' }];

  // Every per-org safety net is INERT on a prefix with no Organization row: there are no rows
  // to refuse on and none to protect with, so the condemnation is 100% by construction. Worse,
  // "org deleted" and "org row not visible to this query" are indistinguishable here — a soft
  // delete, a new `where` clause, or a replica read would all look identical. On staging this
  // was 6 of 13 orphans, so it is not hypothetical.
  it('skips a prefix with no Organization row by default', () => {
    const { targets, skippedOrgless } = selectSweepTargets(dbOrgs, [LIVE, DEAD], false);
    expect(targets.map((t) => t.id)).toEqual([LIVE]);
    expect(skippedOrgless).toEqual([DEAD]);
  });

  it('includes it only when explicitly asked, and labels it', () => {
    const { targets, skippedOrgless } = selectSweepTargets(dbOrgs, [LIVE, DEAD], true);
    expect(targets.map((t) => t.id).sort()).toEqual([LIVE, DEAD].sort());
    expect(skippedOrgless).toEqual([]);
    expect(targets.find((t) => t.id === DEAD)?.name).toMatch(/NO ORGANIZATION ROW/);
  });

  it('never drops a live org that happens to have no objects in the bucket', () => {
    const { targets } = selectSweepTargets(dbOrgs, [], false);
    expect(targets.map((t) => t.id)).toEqual([LIVE]);
  });
});

describe('parseSweepArgs — --delete and --dry-run together', () => {
  // `dryRun = !args.includes('--delete')` resolved the PAIR toward deletion. An operator
  // hedging with both flags got the outcome instead of the report, which is the exact failure
  // the inverted default exists to prevent.
  it('refuses the contradictory pair rather than picking deletion', () => {
    const parsed = parseSweepArgs([`--org=${ORG}`, '--delete', '--dry-run']);
    expect(parsed.error).toMatch(/--delete.*--dry-run|--dry-run.*--delete/);
  });

  it('refuses it for --all-orgs too, and in either order', () => {
    expect(parseSweepArgs(['--all-orgs', '--dry-run', '--delete']).error).toBeTruthy();
    expect(parseSweepArgs(['--all-orgs', '--delete', '--dry-run']).error).toBeTruthy();
  });
});

describe('USAGE names every flag the parser accepts', () => {
  // The whole safety story is "read the dry-run output first", so help that describes
  // behaviour the tool no longer has, or omits a flag that changes what gets deleted, is a
  // defect rather than a documentation nit.
  it.each(['--org', '--all-orgs', '--min-age-hours', '--delete', '--include-orgless-prefixes'])(
    'documents %s',
    (flag) => {
      expect(USAGE).toContain(flag);
    },
  );
});

describe('sweepExitProblem — delete failures must reach the exit code', () => {
  // Untested before: dropping totalRemoveFailures from the exit code survived the whole
  // suite, because main() has no harness. The improvement exists for cron and `&&` chains,
  // which is exactly where nobody reads the output.
  it('is silent on a clean run', () => {
    expect(sweepExitProblem(0, 0)).toBeUndefined();
  });

  it('fails when an org was refused', () => {
    expect(sweepExitProblem(1, 0)).toMatch(/1 org/);
  });

  it('fails when objects could not be deleted, even with every org fine', () => {
    expect(sweepExitProblem(0, 12)).toMatch(/12 object/);
  });

  it('reports both', () => {
    const p = sweepExitProblem(2, 3);
    expect(p).toMatch(/2 org/);
    expect(p).toMatch(/3 object/);
  });
});
