# Promotion parity check (staging -> main)

Run this **before** opening a promotion PR and **after** Render finishes deploying.

It exists because of a specific failure on 2026-08-18: two-way email was believed
to work in staging and to have broken on the way to prod. It had not broken. The
code was byte-identical, every migration was present, and the provider config was
shared. The behaviour differed because a **different code path** was exercised in
each place - Inbox compose in staging, a transactional estimate in prod - and only
one of them minted a reply token.

That is the class of thing this check is for. "It works in staging" is a claim
about an environment; a promotion moves *code*. The two only line up if you have
checked the three axes below, and code is the axis least likely to be at fault.

## Axis 1 - code: is it actually the same?

Cheapest check, and it settles most arguments. Run it first.

```bash
git fetch origin --quiet && git diff --stat origin/main origin/staging -- <the files the feature lives in>
```

Empty output means the two branches are identical for that surface, and **no
promotion can change that behaviour**. If someone reports a staging/prod
difference on a surface that diffs empty, stop looking at the promotion: either
the environments differ (axis 2/3) or the two observations exercised different
code paths. Confirm which path each one used before doing anything else.

Then the branch-cut gate, which is not optional:

```bash
git merge-base --is-ancestor origin/main origin/staging; echo "exit=$?"
```

`0` - branch off `main`. Non-zero - **branch off `staging`**, or the PR into
staging will show thousands of phantom files. See CLAUDE.md for why this does not
self-heal: squash- and rebase-merged promotions never create the link.

## Axis 2 - schema: is the migration ledger the same?

Query both Supabase projects (staging `knriiqdqxgfoecsfarlx`, prod
`fvcjinnllchzqcupmrah`) and diff the names, not the counts. A matching count can
still hide two different missing migrations.

```sql
select string_agg(migration_name, E'\n' order by migration_name) as names,
       count(*) as n
from _prisma_migrations where finished_at is not null;
```

Then check nothing is wedged:

```sql
select migration_name, started_at, rolled_back_at, left(coalesce(logs,''), 300)
from _prisma_migrations
where finished_at is null
order by started_at;
```

A row with `rolled_back_at` set is a healed scar and does **not** block
`migrate deploy`. A row with `finished_at` and `rolled_back_at` both NULL is a
live blocker - nothing further will apply until it is resolved.

Expect staging to be ahead by exactly the migrations added since the last
promotion. Anything else - prod ahead, or a name present in prod but absent from
staging - means a hand-applied migration that never made it into a branch, and it
will be silently reverted by the next wholesale merge. Find it before you promote.

## Axis 3 - environment and provider config

Neither of these is in git, so a promotion cannot carry them. They are the axis
that actually breaks.

**Render env vars.** Anything added to `backend/src/config/env.ts` since the last
promotion needs a value in the prod service. A var with a `z.string().default(...)`
will *not* fail loudly - it will run on the default and look fine. Enumerate the
diff and check each one:

```bash
git diff origin/main origin/staging -- backend/src/config/env.ts
```

**Resend.** Domains and webhooks are **account-wide**, not per-environment - one
account serves staging and prod. Consequences worth holding onto:

- A domain verified for staging is already verified for prod. Sending and
  **receiving** are separate switches; check the one you need.
- Both environments receive each other's webhook events. Each drops what it
  cannot attribute, so this is noisy but harmless - do not "fix" it by deleting
  the other endpoint.
- The **signing secret is per endpoint**. A new prod endpoint needs its own
  `RESEND_WEBHOOK_SECRET` in Render, and the handler fails closed (401) without
  it, so this breaks silently rather than loudly.

**Per-org flags.** `email_sending_enabled`, `sms_sending_enabled` and
`feature_overrides` are data, not code. A promotion does not move them, and their
defaults differ by migration vintage. Check the orgs that matter:

```sql
select name, is_demo, plan, email_sending_enabled, feature_overrides
from organizations order by name;
```

## Axis 4 - verify the path, not the table

The trap that caused the 2026-08-18 confusion, stated generally: **a backfill
makes a column look healthy while no new write sets it.**

Staging's `emails` table read as fully populated - 126 of 143 rows had `direction`
and `thread_id`. But every one of those 126 was sent on or before the backfill
date, and all 17 rows written since were NULL. The table was evidence about the
past, not about the code.

So when verifying a promoted feature, split any "is it working" query by whether
the row was written **before or after** the migration:

```sql
select (<column> is not null) as populated, count(*),
       min(to_timestamp(ts/1000))::date as first,
       max(to_timestamp(ts/1000))::date as last
from <table> group by 1 order by 1;
```

If the populated rows all predate the deploy and the NULL ones all postdate it,
the backfill worked and the **writer** does not. That is a code gap the promotion
was never going to fix.

Then exercise the real path end to end and read the row it produced, rather than
inferring from an aggregate.

## Axis 5 - phones, tablets and foldables: the full mobile sweep

The mobile-compatibility work ships to `main` in batches, and each batch is judged on the whole
app, not on the routes its own slices touched. **Before opening any promotion PR to `main` that
carries mobile work (batches 3 and 4 of the programme; any other promotion whose diff touches
`frontend/`), run the full sweep on the staging commit being promoted, and attach its report.**
Do not open the promotion without a passing report. Batches 1 and 2 may use the plain gate
(`npm run test:mobile`) because the sweep lands in batch 3.

From `frontend/`, in a worktree on the staging commit you are promoting (a fresh worktree needs
`npm ci` at the repo root, `npx prisma generate` in `backend/`, `backend/.env` and `frontend/.env`
copied in, and `npx playwright install`):

```bash
npm run test:mobile:sweep          # one command; exit 0 only if the report passed
npm run test:mobile:sweep:check    # the promotion check: is there a passing report for this commit?
npm run test:mobile:visual         # the phone visual baselines: exit 0 only if every photograph matches
```

**The phone visual baselines run beside the sweep, on macOS, on the same staging commit.** The sweep
measures (overflow, targets, fonts, reach); the baselines compare pixels, so they catch a layout
that is still inside every measurement but no longer looks as it was reviewed. `npm run test:mobile:visual`
photographs the main phone screens (the customer's public estimate and invoice, the detail pages,
the dialogs, text messages) at 320, 393 and one landscape size in its own throwaway org with fixed
data, and fails on any difference from the committed PNGs in `frontend/e2e/visual-baselines/phone/`.
It takes a few minutes. It is a local macOS gate (the PNGs are named for their platform), not CI.
A difference you intended is re-recorded with `npm run test:mobile:visual:update` and the changed
PNGs are reviewed and committed in the same PR as the layout change, never in the promotion PR.
Paste the run's last lines (`N passed`) beside the sweep's report in the promotion PR description.

What the sweep runs, in one throwaway org on the staging database (not CI, so no staging
credentials sit on the runners): every key route and overlay on the six gate devices with all
their targeted specs; the same routes plus the audit's unswept routes on the rest of the device
matrix (iPhone 17 Pro Max, Pixel 7 portrait and landscape, iPhone SE landscape 568x320, Galaxy Z
Fold 7 cover and unfolded, iPad Mini landscape, Galaxy Tab S9 at exactly `sm`, Firefox); the
technician job-completion flow; and the Lighthouse mobile budget (LCP at most 2.5 s, CLS at most
0.1) on the public estimate, the public invoice and the technician landing page, measured on the
production build. It also runs the self-tests that show the checks and the budget can go red.
Allow roughly an hour on a busy machine.

- **Where the report is kept:** `frontend/e2e/test-results-mobile/sweep/latest.md` (and `.json`),
  with every run kept beside it as `sweep/<UTC time>-<commit>/report.md`. These are local and
  gitignored, so a report lives in the worktree that ran it; set `MOBILE_SWEEP_REPORT_DIR` to keep
  them somewhere shared. Paste the report's first lines (verdict, commit, devices) and its path into
  the promotion PR description.
- **What passes the check:** the report passed, swept this commit (or a later staging head that
  contains it), was a full run on a clean tree, covers every device and all three Lighthouse
  pages, and is at most 72 hours old. A promotion that cherry-picks one staging commit passes
  `--sha <that commit>`.
- **A failure that was already there.** A targeted spec that fails on the staging base itself is
  listed in `frontend/e2e/mobile/known-failing.json` with the error text, a reason and an owner, so
  one stale spec cannot block every promotion forever. The report prints each one under "Known
  failing specs"; a failure on another device or with another message is new and still fails the
  sweep. Never add an entry to make a promotion green.
- **A sweep that dies half way** (the runner is killed, the machine sleeps) writes a FAIL report,
  tears its throwaway org down, and names the org in the report if it could not. To clear one by
  hand: `npm run test:mobile:teardown` in `frontend/`. The next run does the same at its start.
- **What the sweep cannot see:** the on-screen keyboard, the notch and the Home Screen app. Those
  stay on the real-device release checklist, `docs/qa/real-device-release-checklist.md`.

