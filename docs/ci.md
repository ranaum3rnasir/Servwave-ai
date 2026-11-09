# CI design

`ci.yml` is the PR gate. `dependencies.yml`, `ci-budget.yml`, `sentry-filer.yml` and `ci-nightly.yml` run on a schedule beside it; `ci-nightly.yml` is the nightly full run of `staging` (below).

## The constraint everything follows from

The runner pool looks like five machines and is **one**:

| Runner label set | Reality |
|---|---|
| `self-hosted, macOS, ARM64` | Two general runner **programs on the one Mac mini** |
| `database` (and no other label) | A runner program on the same Mac mini, **reserved** for the Database job so nothing else can land on it |
| `frontend` (and no other label) | A runner program on the same Mac mini, **reserved** for the Frontend job, for the same reason |
| `self-hosted, Linux, ARM64` x1 | A **virtual machine inside the same Mac mini** (not a second machine; limited to 4 cores, which is what keeps the Backend job from starving the other three) |

So fanning work out into more jobs is not parallelism, it is oversubscription of
one box. Six concurrent jobs each spawning a worker-per-core vitest run is what
produced the mass, non-reproducible test timeouts on PRs #1030/#1033/#1034.

Two rules fall out of this, and both are load-bearing:

**Never use `cache: 'npm'` on a self-hosted runner.** (On the GitHub-hosted
fallback below, setup-node does cache npm, because there the VM is thrown away.) `actions/cache` exists to carry `~/.npm` across the
ephemeral VMs of GitHub-hosted runners. These runners are persistent, so the
cache never leaves the machine - the action tars and uploads it at job exit,
then downloads and untars it at the next job start, for nothing. It cost **917
seconds per PR, 72% of all runner time**, including one 641-second save on a job
whose real work took 45 seconds. `npm ci` still uses the local `~/.npm`.

**Pin every job to a label.** `backend` is pinned to Linux because it is the
heaviest suite and needs neither macOS nor Docker. Every other job is pinned to
macOS *in order to reserve Linux for it* - a bare `self-hosted` job can land on
Linux and head-of-line block the one job that can only run there. Do not widen
one job back to bare `self-hosted` without un-pinning the rest.

## The PR gate (`ci.yml`)

| Job | Runner | Covers |
|---|---|---|
| `Pick runners` (not required) | GitHub-hosted | Chooses where each of the jobs below runs: self-hosted or GitHub-hosted (see Runner fallback) |
| `Secret scan (gitleaks)` | macOS | Leaked credentials across the PR commit range |
| `Workflow lint (actionlint)` (not required) | macOS | Every workflow file parses; shellcheck on their `run:` scripts |
| `Backend (build + tests)` | Linux | Prisma generate, `tsc` (build + scripts + **the suites' own types**), the backend suite incl. static guards |
| `Frontend (lint + type-check + tests + build)` | the reserved `frontend` runner (else the general Mac runners, else a hosted Linux machine) | `tsc --noEmit`, vitest, vite build, ESLint on changed files |
| `Database (migrations + RLS)` | the reserved runner (else the general Mac runners, else a hosted Linux machine) | One command, `npm run test:db`: migrations apply + no drift, the boot check, RLS isolation, seed, role-permission drift, and every real-database test file across lanes (see "The Database check"). The lanes are skipped on a pull request that changes only irrelevant paths (see "Skipping the lanes") |

One `npm ci` per job, three total. `Database` runs its own throwaway Postgres 16
server, started and deleted by the command inside the job: nothing is shared
between runs (see "The Database check").

### Frontend job: workers, hook limit, one type-check

- **Workers.** The Mac's Frontend tests run with the repository variable `FRONTEND_TEST_WORKERS`
  workers; unset means 4. Change or roll back the number in the repository's variables, no pull
  request needed. It is a fixed number, never sensed from load. Measured on the CI machine with no
  test changed: 2 workers 21.7 min, 4 workers 11.2 min (3.0 GB peak). Six waits for a machine that
  runs one Frontend test job at a time, because of memory. The hosted fallback shards stay at 2.
- **Hook limit.** `hookTimeout` equals `testTimeout` (30 s) in `frontend/vitest.config.ts`: a loaded
  machine, not slow code, is what crosses either limit.
- **One type-check.** The `Type-check` step runs `npx tsc --noEmit`, after deleting
  `frontend/node_modules/.tmp` (tsc's build state). `tsc --noEmit` does not read it, so the deletion is
  defensive cleanup on a persistent runner. The `Build` step runs `vite build` and the bundle-budget
  check without a second `tsc`; `npm run build` keeps its own `tsc -b` for local use and the hosting
  provider.

### Frontend tests: one command, one verdict (`npm run test:ci`)

The Mac job, the hosted fallback shards, the agents' CI-mirror run and a laptop all run the frontend
tests the same way: `npm run test:ci` in `frontend/` (`scripts/test-ci.mjs`, decisions in
`scripts/test-ci-lib.mjs`). It runs the test tool once with `--retry=2` and `--allowOnly=false`
(`--bail=50` on pull requests) and a reporter of our own that appends one line per event to a file as
it happens. That file, not the tool's end-of-run report, decides the result.

It prints a preflight block (worker count and why, 1-minute load, swap in use, other test runs seen),
then one machine-readable line, and appends the same information to the job summary, including
**every retried test** (file, test, attempts, time, first error line):

    TEST-CI-VERDICT result=<word> code=<n> reasons=<codes> mode=full files=<ran>/<expected> passed=<n> failed=<n> retried=<n>

With test selection switched on or to shadow (see "Selected runs" below) the line also carries `selection=` after the mode. With selection `on` it is the reason (`selection=changed-files`, `selection=lockfile`, ...); in `shadow` it is the word `shadow`, because the run was full whatever the selector would have done, and the reason is on the `test-select:` and `TEST-SELECT-SHADOW` lines. `mode` can be `selected-N-of-M` (with selection `on` only).

Under the verdict line the log carries one `TEST-CI-RETRIED attempts=<n> file=<file> test=<name>` line per retried test (the job summary has the same list, but GitHub's API does not return summaries; the weekly report, see "The Frontend section", reads these lines).

Workers: never above an explicitly set `FRONTEND_TEST_WORKERS` or `VITEST_MAX_WORKERS`, 4 when neither
is set. Never sensed from load.

| Result word | Exit code | What it means for you |
|---|---|---|
| `passed` | 0 | Every expected file ran once, each had a passed test, nothing outside the skip allow-list was skipped, the passed count met the floor, at most 10 tests needed a retry. |
| `failed` | 10 | A test failed, a file failed to load, or there was an unhandled error, a dead worker, or a hook timeout. A hook timeout, an unhandled error or a dead worker is never forgiven by a retry that passed. Fix the named test or file. |
| `incomplete` | 11 | The run did not prove itself, whatever the tests said: an expected file never ran (`file-missing`), a file ran that was not expected (`file-extra`), a file ran twice, started and never finished, or had no passed test (`zero-tests`), a skipped or todo test is not in the allow-list (`undeclared-skip`), fewer tests passed than the floor (`floor-not-met`), a `.only` is present (`only-present`), the tool exited non-zero with nothing to explain it, or the check itself threw (`check-exception`). Fix the cause; do not touch the allow-list or the floor to make it pass. |
| `stalled` | 12 | No test event for 240 s, or one file ran longer than its test limit times its test count times its attempts (`--retry=2` is 3) plus a margin, so a test that passes on its last retry is never killed as stalled. The tool's whole process group was killed. The log names the last healthy file and the files in flight: start with those. |
| `overloaded` | 13 | More than 10 tests needed a retry in one run (exactly 10 is fine). The summary lists them. This is a signal that the machine was starved or a test is flaky: look at the list, do not re-run until green. |
| `cancelled` | 14 | The runner cancelled the job. The log prints "failed so far" from the event file. |

Any non-zero code fails the workflow step. A hosted shard checks completeness against its own slice of the
full list, computed the way the tool computes it (`--shard`), and an empty slice fails (`empty-slice`).
`--shard` together with a file selection (`--files-from`) is refused.

`.only` is refused by the tool under `--allowOnly=false`; the reporter records that as `only-present` (incomplete), not as a failed test. A `beforeAll` that throws inside a describe fails its suite: `failed` with `suite-failed`. A missing or invalid floor is `incomplete` with `invalid-floor`, and an unknown option exits 11 with usage instead of running anything. If the command is killed with SIGKILL, the test tool notices its parent is gone within about 2 s and takes its own process group down. Each retried test's attempts are timed one by one inside the worker by a setup file that only this command adds (the tool's own duration spans all attempts together), so the job summary shows e.g. `attempt 1 failed 800 ms; attempt 2 passed 0 ms`. A hook that times out in `beforeAll` or `beforeEach` is `hook-timeout`. A bad `--shard` prints usage and exits 11.

Where the numbers live, all in `frontend/scripts/test-ci-policy.json`: the **floor** (16,900 passed
tests for a full run; raise it by hand when the suite grows, never lower it), the **skip allow-list**
(today's seven skipped tests in one file; it may only shrink, pinned by `src/__tests__/test-ci-lib.test.ts`)
and the retry limit. There are no step time limits in the Frontend job: the job limit (45 minutes on
the Mac) is the only one, plus the watchdog above. No test file path may be a substring of another
(guard: `src/__tests__/test-file-paths.guard.test.ts`), because the tool selects files by substring.

### The brake on frontend test growth (#3254)

`npm run test:ci` also applies four ratchets after a passed run and prints `TEST-BRAKE-VERDICT` (exit 15 when only
the brake is red). Decisions are pure functions in `frontend/scripts/test-brake-lib.mjs`.

| Ratchet | Rule | Where the number lives |
|---|---|---|
| Time ceiling | In a test file the pull request added or changed: a test over 2 s or a file over 10 s of summed body time fails and names it. A file over the line is re-run alone once and judged on that run only. Not judged on the staging to main promotion pull request (below). Needs the pull request's changed files (`GITHUB_BASE_REF`, or `--changed-from=FILE` / `--base=REF`); without a base nothing is judged and the summary says so. | `frontend/test-time-baseline.json`: tests and files already over the line, exact entries, may only shrink (compared with the base's copy). Generate with `node scripts/test-brake.mjs baseline --events=FILE` from the event file of a full run. |
| Files per page | How many test files mount each `src/pages/**/*Page.tsx`: a test file mounts a page when it imports the page or that page's harness (the one mapping `PAGE_HARNESSES` in `frontend/scripts/test-brake-lib.mjs`; a page with a harness is listed there, so moving a file onto the harness does not lower the count, only merging files does). Judged on the pull request's own change: a page fails only if the pull request adds a test file that mounts it (or makes an existing one mount it) and its count is then over the ceiling. Raising a ceiling fails; lowering is free; a page not in the file starts at 3. The guard test in the ordinary suite only checks that the file is well-formed. | `frontend/test-page-ceilings.json`; `node scripts/test-brake.mjs page-ceilings [--write]` |
| Budget (full run only) | CPU-seconds of the run, minutes of the test step (the idle machine's budget: judged only on the nightly run, which sets `TEST_CI_NIGHTLY=1`, and only at the budget's worker count; a pull request or push run reports its minutes in a note and is never red for them), number of test files (see below). Figures are in the job summary on every full run. CPU over budget only WARNS while `cpuEnforcement` is `"warn"` (until a 6-worker Mac baseline is recorded; exit unchanged, warning in the log and summary); at `"fail"` it is red (`cpu-over-budget`, exit 15). A missing or unknown value reads as `"fail"`. Every other reason stays red in both modes. | `frontend/test-budget.json` |
| Slowest files | The 20 slowest files of a full run by body time, in the log and the job summary. | none |

**Judged on the pull request's own change.** A number the pull request did not change can never fail it, so two pull
requests that each add a test file and merge cleanly never turn a third one red. The base is the merge-base of HEAD
with `origin/$GITHUB_BASE_REF` (default `origin/staging`; `--base=REF` overrides). On a pull request into `main` the page ceilings and the file count are judged against the merge-base with `origin/main`
like any other. The time ceiling is not judged only when the pull request's head branch is `staging` (the staging to main
promotion): every change in it was already time-judged on its way into staging, and the verdict line says
`time=not-judged (PR from staging into main)` with no file re-run alone (judging it would add about 24 minutes). `promote/*`,
hotfix and every other branch into `main` are time-judged against their merge-base with `origin/main` (Ran's decision,
R17); a missing head branch is judged too. The Frontend job checks out with
`fetch-depth: 0`, so that ref exists there. The hosted shards check out one commit (no `fetch-depth: 0`, hosted minutes are
scarce), so they have no base. With no base (shard mode, a shallow clone, or a local run with no remote) the page
ceilings are NOT JUDGED: the verdict line says `pages=not-judged (no base: shallow checkout or no remote)`, the summary
says the ceilings were not checked, and the step never fails or claims a pass for them. The Mac job, which has a base,
is where they are judged. The test-file count is judged on every run, selected and shard runs included (it is a `git ls-files` count and does not depend on which tests ran); a run with no
base prints `files=not-judged` the same way. The test-file count (with a base) must equal the pull request's own change to
`maxTestFiles`: adding k test files means raising `maxTestFiles` by k in the same diff, deleting means lowering it,
or the check fails and names both numbers (`file-count-not-in-budget`). `maxTestFiles` moving with the file count is
bookkeeping; the raises Ran reviews are CPU-seconds, minutes, a page ceiling and the over-the-line list.
The agents' rule is in the project rules file, "Frontend tests: where a test belongs".

### The nightly full run of staging (`ci-nightly.yml`, #3256)

Once a night (03:11 UTC, clear of the other scheduled jobs at 05:23, 05:43 and 06:17 UTC) the full Frontend suite runs on
`staging` through `npm run test:ci`, on the Mac. It is the safety net under selected runs: a selected pull request run may skip files,
this one never does. It keeps **one** open issue, labelled `priority:medium`, `module:general` and `ci-nightly`, found again by a hidden
marker in its body:

| Night | What the job does |
|---|---|
| Red (any non-zero exit including `cancelled` (14), a verdict that is not a passed full run, no verdict line, a job that failed, was cancelled or hit its time limit before a report) | No issue open: opens one with the verdict lines, the failed files, the commit, the run link, the run time and the budget figures. An issue already open: comments the same on it. Never a second issue. |
| Green (a passed run in mode full) | Closes the open issue with a "green again" comment, if the rule below allows it. |

Red `staging` **alerts**; it does not block merges (nightly, not after every merge, Ran's choice). A scheduled workflow runs the
default branch's copy of the file, so the run job checks `staging` out explicitly; until the file is on `main` the schedule does not fire.
The run job (read-only token) executes the code under test; the report job (`issues: write`, no install, no checkout of that code) edits
the issue. Every writer shares the constant concurrency group `ci-nightly-writer`, never cancelled mid-write, so two runs cannot
open two issues (GitHub keeps one pending run per group, so an older pending update can be replaced by a newer one). The run job has its own group, `ci-nightly-run`, so two nightly suites never overlap. The run job is on the reserved `frontend` runner, the one the pull request Frontend job uses, so a nightly suite and a pull request's never run on the Mac at once: whichever arrives second waits for that runner (a nightly can start late when a pull request is running; it has a 60-minute limit of its own once it starts). The job summary shows the run time, both verdict lines, the failed files and the budget figures; the weekly budget reads its job data from the run.

**Drill (planted failure).** Cut a throwaway branch from the lane head or later (it must contain `scripts/ci-nightly/collect.mjs`, or the run is red for the wrong reason and lists no failed files) and add one failing test. Actions > CI nightly full run > Run workflow, `ref` = that
branch, `apply` ticked: a red run of any ref opens (or updates) the one issue, and the issue records which ref opened it and every ref
that went red (a hidden marker plus the line "Refs that were red"). A green run closes the issue only if it is a full run (`mode=full`) and
its ref is `staging`, or its ref is the ref that opened the issue and no `staging` run has been red since. So a green throwaway branch can
close only its own drill issue, never a real staging failure. Scheduled runs are always `staging`. The ref that decides is the workflow's own input (`ref`, default `staging`), never anything the branch under test reports: only `staging` and `refs/heads/staging` count as staging (a branch literally named `origin/staging` or `heads/staging` does not, nor does a tag or a commit), a name git would not accept touches nothing, and the state is read only from the block the job writes at the very end of the body, never from text a run can influence. For the drill: run the planted branch (red,
issue filed), then run the same branch with the test fixed or removed (green, the drill issue closes). Unticked `apply` is a dry run that prints the decision only. Delete the branch afterwards.

**Promotion checklist** (before opening the promotion pull request to `main`):

1. Read the open `ci-nightly` issue, if there is one (`gh issue list --label ci-nightly --state open`). Open means the last full run of
   `staging` was red: fix it or say in the promotion pull request why it does not matter.
2. Read the pull request's own Frontend check as usual; it does not replace the nightly full run.
3. Run the promotion parity check (`docs/promotion-parity-check.md`).

### Selected runs on pull requests into `staging` (#3257)

A pull request into `staging` can run only the frontend test files its change can reach, instead of all of them. It is switched by one
repository variable, `FRONTEND_TEST_SELECTION`, with three values:

| Value | What the Frontend check does |
|---|---|
| unset, empty or `off` | The full run, exactly as before. Nothing is selected and nothing extra is printed. **`off` is the rollback**: set it (or delete the variable) and the next run is full, with no code change. |
| `shadow` | Still runs **every** test file. It also works out what it would have selected and logs that beside what actually failed: `TEST-SELECT-SHADOW would=selected-N-of-M reason=... failing=<files that failed> misses=<failing files outside the would-be selection>` (and one `TEST-SELECT-SHADOW-MISS <file>` line per miss). A run in shadow is never made red by the selector. |
| `on` | Runs the selection. The verdict line says `mode=selected-N-of-M selection=<reason>` (or `mode=full selection=<reason>` when it ran everything) and the job summary repeats it. |

Any other value counts as a doubt: a full run with `selection=invalid-mode`. The variable is only switched to `on` after at least 100
pull request runs in shadow with zero misses (the tally goes on #3257), the nightly run (below) has been seen red on a planted
failure, and agents' test runs give way to CI (#3241).

**How a selection is made.** The test tool's own change-detection (`vitest list --changed <base>`) lists the test files whose imports
reach a changed file. The policy around it is ours: one pure function (`frontend/scripts/test-select-lib.mjs`) that is given the facts and
returns `full` or `selected`, with a reason code. `frontend/scripts/test-select-io.mjs` only gathers the facts from local `git`.
`node scripts/test-select.mjs` (in `frontend/`) prints the decision for the current checkout without running a test.

- The base is the **merge base** of the merge ref's two parents. The changed-path list and the tool's file list come from the same
  tree; if the tree changed in between (a dirty checkout), it is a full run (`tree-mismatch`).
- The selection always contains the **always-run list** (`alwaysRun` in `frontend/scripts/test-select-lists.json`): every test that reads
  the disk, runs a child process or has a computed import, because the import graph cannot see what those depend on (a backend file read
  at run time, a file named in a variable). That includes a test that does it only through a local test-support module it imports (a
  `__tests__`, `support`, `harness` or similar helper, found by following relative and `@/` imports transitively; type-only imports are
  skipped; application code is not followed, the import graph already covers it). The patterns go by file name; the guard `src/__tests__/test-select-always-run.guard.test.ts`
  fails when a test does any of those things and is not matched, naming the file. So "nothing to run" is never an outcome.
- A changed snapshot file selects the test beside it.
- Full-run triggers (`triggers` in the same file): any `package.json`, the lockfile, `tsconfig*`, the test and bundler configs and what they
  import, the test set-up file, `.github/workflows`, `frontend/.env*`, and the command and its lists (the selector and the files it reads,
  hard-coded in the policy so a pull request cannot change what counts as "the selector").

**Every doubt is a full run, with a reason code printed and a unit test.** `selector-threw`, `selector-timeout` (the child that asks the tool
gets 60 s; there is no network call), `not-pull-request`, `base-not-staging`, `not-two-parent-merge`, `head-mismatch`, `no-merge-base`,
`base-not-merge-base`, `tree-mismatch`, `shallow-clone`, `deleted-source`, `renamed-source`, `too-many-paths` (more than 300 changed paths),
`unclassified-path`, `case-mismatch` (imports are matched against the tracked-file list, not the disk), `listed-not-tracked`,
`changed-not-tracked`, `selector-bad-output`, `snapshot-without-test`, `empty-always-run`, `selector-edited`, plus the triggers
(`lockfile`, `package-manifest`, `tsconfig`, `test-config`, `setup-file`, `workflows`, `env-file`). There is no "changed since the last green run"
logic, so a force-push is safe.

**Always full, whatever the variable says:** promotion pull requests into `main` (`promotion-into-main`), pushes to `main`, the nightly run
(`nightly`), the hosted fallback (a shard refuses selection, `hosted-shard`), manual runs (`manual`), and anything run outside Actions
without an event.

**What a green selected run proves, and what it does not.** It proves that every test file that imports (directly or through other modules)
a file you changed passed, that every test that reads the disk or spawns a process or imports by a computed name passed, and that the
changed tests themselves passed. It does **not** prove that the files it skipped still pass. A skipped test can in principle depend on
something the import graph cannot see and the always-run list does not yet cover. That gap is closed after the fact by the **nightly full run**
of `staging` (above): a miss shows up there within a day, as the one open `ci-nightly` issue. Read that issue before a promotion. A green
selected run is a fast, honest answer to "did my change break what it can reach", not a replacement for the full run.

### Speed-ups that were tried on the CI machine and do not work

Do not re-try these.

- **Running test files without isolation** (`isolate: false`): 8,114 failures, then a hang.
- **happy-dom instead of jsdom**: crashes in the animated components.
- **Skipping the accessibility-tree check in role queries**: slower, and 31 files break.
- **The VM-based worker pool** (`vmForks`), trialled in #3260 on a 4-core cloud box (not the CI machine; no number from it is
  a CI number). NOT adopted. It was faster there (24 min against 33 min wall), but memory was far above the default pool and
  stayed high: total peak 8.8 GiB at 4 workers and 12.3 GiB at 6, against 4.5 GiB in the default pool at 4 workers (mean 6.1
  and 8.9 GiB against 1.6). At 4 workers each, that is about twice the peak and nearly four times the average. 27 and 28
  worker processes died of heap exhaustion, and every file they were running still shows up as passed: 7 and 5 of them with
  0 tests, the other 20 and 23 with tests that never ran (225 and 207 tests left pending). 24 files failed in each vm run.
  The 8 that redefine `window.location` cannot run in the VM window: `auth-listener-recovery`, `lead-detail-page`,
  `eventEditor`, `SecurityPage.changePassword`, `publicEstimatePayments`, `publicEstimateSignedNotPaid`,
  `publicInvoicePartialAndTips`, `publicInvoicePayPanel`. Files that load Playwright fail when a second one loads in the same
  worker; this was seen in reruns of 24 files after the streams fix, not in the 4- and 6-worker trials. The 11 files that set
  `TZ` themselves all passed under `vmForks`. Do not re-try without a fix for the memory.

### Linting is changed-files-only

The frontend had a 239-error / 1012-warning backlog when the gate was added, so
`eslint .` could never be blocking. Only files the PR adds or modifies are
linted: new code must be clean, the backlog blocks nobody, and it shrinks as
files get touched. Touching a legacy file can surface *its* pre-existing errors -
that is the intended ratchet.

Lint runs last in the job so a lint failure never hides a test result.

## The Database check

`Database (migrations + RLS)` is **one command**, `npm run test:db` in `backend/` (code in `backend/scripts/ci-db/`, plain Node run by
`tsx`). The same command runs in CI, on a laptop, on the agents' test runner and on a hosted machine. Everything is in one place on
purpose: the job is checkout, Node, install, build, the command, and an always-run `npm run test:db:stop`.

What a run does, in order:

1. **Starts a private Postgres 16 server** that belongs to this run alone: found on `PATH`, then in the usual package locations (the
   command stops with a one-line hint when it is not major version 16). Data directory under the runner's per-job temporary folder
   (`RUNNER_TEMP`, emptied by the runner at the start and end of every job) or a private temporary folder elsewhere. Loopback TCP only,
   no Unix socket, trust authentication; encoding UTF8, locale `C` and time zone UTC on every platform (the locale variable is set for
   creation and start); `max_connections` 300; durable settings. Its port is claimed by the server's own bind: the first free one in
   24500-24531 (never 5432, 5433 or 3111, never in the kernel's random range 49152-65535); the boot check's port is that plus 100. The
   command exports `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` to every later step, and asserts that the server answering is the one
   it started (its data directory) before anything else runs, so a bare `psql` can never fall through to a shared server. **It never
   connects to a server on 5432 and never touches the old lock path.**
2. **Core checks**, in order, on one database, with **no retry**, and every one runs even when an earlier one fails (an early red never hides
   a later one): the outside roles, migrations apply, migration status and drift, the boot of the built server (`dist/index.js`, in CI and
   with `--boot` elsewhere; it confirms the process answering `/health/deep` is the process it started), RLS isolation, login-not-locked-out
   under RLS (it must come before the lanes: it creates a cluster-wide role that two lane files would otherwise race to create), RLS
   coverage, the seed and its verification, then the six suites that used to have a step each (task-category starters, writes and delete;
   walkthrough removal race; technician lead scope with the walkthrough window; fixed lead statuses).
3. **Copies that database once per lane** (`lane_1` ... `lane_N`), then **closes the template to connections** until the lanes finish, so
   "lanes never share a database" is enforced by Postgres, not by a string a test matches.
4. **Runs every remaining real-database file in one vitest run with one worker per lane.** `src/__tests__/db-lane-setup.ts` (called from
   `setup.ts`; a no-op unless the command started the run, so setting `TEST_DATABASE_URL` by hand and running one file works as ever)
   points each worker at its own lane database before a file loads and **throws, never skips,** when the worker id is missing or outside the
   lanes. Each file takes an advisory lock on its lane for its whole run (a second worker on a lane fails loudly, classified as
   infrastructure) and ends leftover connections to the lane. Lane workers get only the test database setting; lane addresses carry no
   connection-limit parameter. Lanes keep today's `--retry=2` for the rollout; the hook time limit is raised to 60 s for the lane run only.
5. **Reopens the template** and runs the numbering integration suite and the permission drift check on it (no retry).
6. **Proves every expected file ran** by reading the test tool's events (`scripts/ci-db/reporter.ts`), not the log. It fails unless: the set of
   executed files equals the expected set (every tracked `*-db.test.ts`, the three RLS files and the numbering suite, including a file
   written today and not yet added to git), each exactly once; every executed file has a passed test; nothing is skipped outside the
   allow-list in `backend/scripts/ci-db/policy.json` (the three payment-sandbox files plus the recorded baseline, which may only shrink);
   the passed-test count is at or above the floor in the same file (raised by hand); every lane finished a file. **Retried tests** are listed
   in the job summary (file, test, lane, attempts, first error line) and more than 10 fail the run.
7. **Stops the server and deletes it**, unconditionally: prints the tail of the server log, stops the server, removes the directory. The
   `Stop the private database server` step runs it again with `if: always()` and is idempotent; it is what leaves nothing behind after a
   cancel or a kill. Before a run starts it sweeps **orphans by identity, never by age**: a server whose data directory is under this
   runner's own temporary folder (a runner program runs one job at a time) is stopped gracefully, then forcibly; servers under other
   folders and the two long-lived servers are never touched; outside CI a server is an orphan only when the process that started it is
   dead. Shared-memory segments owned by the runner's user are removed only with zero attachments **and** a dead creator; the count is
   printed on every run.

**Filtered runs.** `npm run test:db -- <file-name pattern> ...` does the same setup (server, roles, migrations) and runs only the matching
files (substring of the path), and applies the same proof to the selected files only (no floor). `tsx scripts/ci-db/cli.ts list [pattern]`
prints the file list and the order of the checks as JSON without running anything.

**On a laptop.** The command ignores the database settings of the shell and does not read `backend/.env` (or any other env file) in any
process it starts, so the only database a test sees is its own lane database on the private server; your `.env` is left as it is.

**Lanes.** One setting, `DB_LANES`: six on the reserved runner (`Pick runners` sets it there), otherwise the smaller of four and the
processor count, at least one. If the single run ever misbehaves in soak, the fallback is one test process per lane, dealt by the command
(proven twice on the CI machine: 373 of 373 green); it is a fallback, not a second maintained path.

**What a run prints.** A preflight block (runner kind, lane count and why, load, swap in use, Postgres version, port, collation, data
directory, shared-memory segment count), and in the job summary: the core checks with their times, per-lane time, files and tests, every
retried test, problems, the ten slowest files, total test seconds against the budget in `policy.json` (a warning from 80%), fatal lines
from the server log and peak connections. The last line is the classified verdict, also an error annotation when red:

```
DB-CI-VERDICT result=<word> [kind=<kind>] code=<n> reasons=<...> files=<ran>/<expected> passed=<n> failed=<n> retried=<n> lanes=<n> [suites-skipped=<n>]
```

| Exit code | Result | Meaning |
|---|---|---|
| 0 | `passed` | every expected file ran once and passed |
| 10 | `failed` | a test, a file that would not load, or a core check; the reasons name the file or phase |
| 11 | `incomplete` | a file did not run, ran twice, skipped outside the allow-list, had no passed test, a lane finished nothing, or the count is under the floor |
| 12 | `stalled` | no test file finished for `DB_CHECK_STALL_SECONDS` (default 300); the summary names the in-flight file per lane |
| 13 | `overloaded` | more than 10 tests needed a retry to pass (the lanes are overloaded or the tests are flaky); the reasons give the count |
| 14 | `cancelled` | the run was cancelled (SIGINT/SIGTERM); the server was still stopped |
| 20 | `infrastructure`, `kind=server-start` | PostgreSQL 16 missing or wrong, no free port, initdb or start failed |
| 21 | `infrastructure`, `kind=clone` | the template could not be copied or closed |
| 22 | `infrastructure`, `kind=lane-died` | a worker started a file and never finished it, or the worker process died |
| 23 | `infrastructure`, `kind=wiring` | a worker with no lane or a second worker on a lane, the file list could not be produced, a tool is missing |
| 24 | `infrastructure`, `kind=server-died` | the private server stopped while the run was going |

**Time limits.** There is one job-level limit (25 minutes on the self-hosted Mac, set from the #3236 drill runs; 60 on a hosted machine, not yet measured) and the
stall detector inside the command, which fails a stuck run as infrastructure and names the stuck file long before the job limit. There
are no step limits and no arithmetic between limits. A time limit is never raised to silence the budget warning: make tests cheaper or
add lanes.

**Runner choice.** `Pick runners` sends the Database job to the reserved runner (label `database`, six lanes) when one is online, otherwise
to the general Mac runners (labels `self-hosted, macOS`), otherwise to a hosted Linux machine (`ubuntu-latest`, never a hosted macOS one),
and the same command runs in all three. The hosted path needs no Postgres step: the image carries PostgreSQL 16 and the command finds it.
The repository variable `CI_RUNNERS` still overrides (`hosted`, or `self-hosted` for the general Mac runners).

**Why a private server, and what was deleted.** The Database check used to run 380 real-database test files one at a time against one
shared Postgres on the Mac, behind a machine-wide lock directory, in three serial shard steps (about 43 minutes typically, 92 at worst, and
19 of the 22 failed executions were the machine, not the pull request). The shared cluster, its lock, the lock arithmetic between five time
limits, the dealing script and the skip list kept in three places, the role create-then-drop life cycle and the hosted `postgres:16`
container path are gone. Rollback is a plain revert: the shared server on 5432 is never touched, so older branches and `main`-based pull
requests keep working beside the new job until they pick up the new workflow.

**Skipping the lanes.** A pull request that provably cannot affect the real-database suites gets a green `Database (migrations + RLS)` in about
two minutes instead of running about 400 test files. The rule is a pure function inside the command (`backend/scripts/ci-db/skip.ts`) and it is
**fail-open**: any doubt runs everything.

- **Skip only when every changed path is on the list**: the `frontend/` folder, the docs folders (`docs/`, `md_files/`), the agent-tooling
  folder (`.claude/`) and root-level Markdown files. A package manifest or lockfile (`package.json`, `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`) is never on the list, wherever it sits, so `frontend/package.json` runs everything. Any other path (a
  backend file, a workflow, an unknown top-level folder, a malformed name) runs everything, including paths nobody thought of.
- **What is skipped**: only the lanes and what follows them (the numbering suite and the permission drift check). **Migrations, the boot check,
  the three RLS suites, the seed and the six core suites run on every pull request.**
- **The changed paths** are the checked-out merge commit against its first parent (`git diff --name-only --no-renames -z HEAD^1 HEAD`), so a file
  renamed out of `backend/` shows as a delete there and runs everything. The Database job checks out two commits (`fetch-depth: 2`) for this.
  A failed git command, a checkout that is not a two-parent merge commit (a shallow cut, or a commit other than the one the event is about), an
  empty list, a list that was cut off, or more than 3000 paths all run everything.
- **Pull requests only.** The rule applies to the `pull_request` event. A push (to `main`), a laptop run, the agents' runner and any other event
  run everything. The authorization suites therefore still run in full on every push to `main` (except the one case in "Push to main", where
  the whole check is skipped and says so); `backend/src/__tests__/authorization-suite.test.ts` pins this through the command's own answer.
- **The summary says so.** The job summary carries `suites skipped: no relevant path changed`, the phase table shows `lanes` as `skipped: no
  relevant path changed`, and the verdict line ends with `suites-skipped=<files>`. The completeness check treats "skipped by rule" as different
  from "did not run": the lane files are not expected, a core file that did not run is still `missing`, a skipped file that ran anyway is `extra`,
  and the full-run floor does not apply to a skipped run.
- **Why it is safe**: a guard in the Backend check (`backend/scripts/__tests__/ci-db-suites.test.ts`, "read nothing above the backend folder")
  pins the premise. No real-database suite, and no file one imports, reads a path above the backend folder (the installed packages of the
  workspace root excepted: only a manifest or lockfile change alters those, and those always run). A suite that starts reading the frontend, the
  docs or the repository root fails the Backend check until the skip list in `skip.ts` is changed or the suite is.

**What a green check means for those pull requests, and the accepted gap.** For a skipped pull request a green check means "passed, or clearly
not relevant", not "every suite passed on this commit". CI does not run on pushes to `staging`, so the next pull request of any kind used to show
that `staging` itself was broken. With skips, a screens-only or docs-only pull request no longer shows that for the suites it skips; the next
backend pull request still does. Running the Database check on every push to `staging` would cost more machine time than the skips save, so the
gap is accepted. The core checks still run on a skipped pull request, so a broken migration or a tenant-isolation hole never passes unseen.

**The integration suites that never run in CI (#3232).** Eight real-database suites read `DATABASE_URL` behind `RUN_INTEGRATION_TESTS` and run
nowhere in CI (only the numbering suite does, with that variable set by the command). They are listed in
`backend/scripts/__tests__/ci-db-suites.test.ts` so the list can only shrink: a suite moved into the command comes off it, and a new
one that is not on it fails the guard.

## Push to main

Every push to `main` runs the whole gate again, the authorization suite with it, so that a permission regression cannot reach production unnoticed. One narrowing, approved on 2026-11-05 (#3240): when the pushed commit's tree is byte-for-byte the tree the merged pull request's own run tested, and that run's `Frontend`, `Backend` and `Database` checks were all green and each ran its full suites, the three checks finish green on the push with the notice "identical tree already tested on pull request N" and skip every step. Each of those checks, on a pull-request run, ends by naming the tree it checked out in the name of its last step (`Tested tree <hash> full`), which only runs when every step before it succeeded; a `Database` run that skipped its lanes (see "Skipping the lanes") writes no such step, so it never counts. The `Pick runners` job (read-only token: Actions, pull requests, contents; no other secret) finds the pull request whose merge commit is the pushed commit, reads that pull request's final-head runs and their jobs from GitHub's run data, and compares the recorded trees with the pushed commit's tree (`scripts/ci-main-skip/`, the decision is a pure function and unit-tested). Anything else runs everything exactly as before: a direct push, a merge that changed the tree, no record, a pull request that cannot be found, any API error, a check that was red, skipped or cancelled, a push to any other branch; the promotion pull request itself always runs everything, and the required check names and time limits do not change. `authorization-suite.test.ts` pins that this one condition is the only way the Authorization suite step is skipped. Limits you should know: the record is the workflow's own, so a pull request that edits `ci.yml` is reviewed like any workflow change; and the saving is the whole push run on the one machine, about 1.9 runs a day.

## The weekly time budget

The number of real-database test files went from 6 to 380 in five weeks with nothing watching, and each time the Database check got slow a
time limit was raised instead (four times in October). `ci-budget.yml` watches the growth: every Monday it reads the last seven days of
`Database (migrations + RLS)` job data from GitHub's run data (calculation in `scripts/ci-budget/lib.mjs`, pure and unit-tested with
`node --test scripts/ci-budget/lib.test.mjs`, which the required `Backend (build + tests)` job runs on every pull request; the reader/writer is
`scripts/ci-budget/run.mjs`).

- **What counts**: a job that **succeeded on its first execution on a self-hosted machine**. Re-runs (attempt 2 and up), cancelled and failed
  executions, and executions on a hosted machine are left out of the figures and counted in the report ("Left out: ..."). A pull request that
  skipped its lanes ("Skipping the lanes") is a successful first execution and counts, so the figures describe what pull requests actually wait for.
- **The figures**: run time is from the job starting to it finishing. The **typical run** is the median; the **slowest tenth** is the run time
  nine in ten runs stay within (nearest-rank 90th percentile; with a single run, that run). The report also gives the longest run, the
  previous seven days beside this week with the change between them, and the ten slowest test files from the newest run whose job log printed
  that table.
- **Queue time is separate**: the wait for the reserved runner (job created to job started) is reported on its own and never added to run
  time or compared with the budget. A busy week of many pull requests makes the wait longer, not the tests slower.
- **The budget**: the slowest tenth of run time above **8 minutes** (strictly above). Under it the job does nothing.
- **The ticket**: above it, the job opens **one** ticket, labelled `priority:medium`, `module:general` and `ci-budget`, or, when a ticket with
  that label and the report's hidden marker is already open, adds the week's report to it as a comment. It never opens a second one: every run that can write (the schedule and any manual run, on any branch) shares one queued concurrency group, and looks the ticket up again just before opening. Close the
  ticket when the figures are back under the budget; the next breach opens a new one.
- **Running it by hand**: Actions > CI weekly time budget > Run workflow. A manual run is a dry run (prints the report and what it would have
  done, writes nothing) unless "apply" is ticked. Locally: `node scripts/ci-budget/run.mjs --dry-run`.
- **Cost and permissions**: it runs on the self-hosted macOS runners (no hosted minutes, no install, plain Node), is not part of the PR gate and
  is not a required check. Its token can read Actions run data and write issues, nothing else.
- **Other checks add a section**: the report is a list of sections, each `{ id, title, breach, markdown }`. The Frontend section (below) is the
  second one. The Database ticket opens only when the Database section is over its budget; the Frontend causes have tickets of their own.

### The Frontend section (#3258)

The same weekly run also reads the last seven days of the `Frontend (lint + type-check + tests + build)` check and adds a "Frontend check"
section to the report. The calculation is a pure function, `frontendReport` in `scripts/ci-budget/frontend.mjs`, unit-tested with
`node --test scripts/ci-budget/frontend.test.mjs` (the same required `Backend (build + tests)` step runs it); `run.mjs` only reads the run data and
logs and writes the tickets. It reads the job's log lines: the `TEST-CI-VERDICT` line, the `TEST-SELECT-SHADOW` line and one
`TEST-CI-RETRIED` line per retried test (printed by `npm run test:ci` since #3258).

- **Runs by selection mode and reason**: a table of the week's executions (every attempt) by selection (`off`, `shadow`, `on`, or `shard` for
  a hosted shard), what ran (`full` or `selected`), the reason code and, in shadow, what the selector would have run. With the selection variable
  off, which is today, every run is one row: `off`, `full`.
- **Error-type fallbacks**: runs that went full because the selector itself failed: `selector-threw`, `selector-timeout` (it hung),
  `unclassified-path`, `no-changed-list`, `selector-bad-output`, `listed-not-tracked`, `changed-not-tracked`, `case-mismatch`,
  `empty-always-run` (the list `ERROR_FALLBACK_REASONS` in `frontend.mjs`; a test pins that each is a code the selector prints). A deliberate
  full run (a lockfile change, a promotion, a workflow edit, a doubt about the checkout) is not one. When they are **strictly more than 5%** of the
  week's runs that printed a verdict, the job opens **one** ticket (`priority:medium`, `module:general`, `ci-budget`) or, when it is already
  open, comments on it.
- **Tests retried in two or more runs**: a test counts once per workflow run (two attempts of one run are one run). Each test retried in at
  least two different runs this week gets its own ticket (`priority:low`), or a comment on the one already open for it. Runs from before the
  `TEST-CI-RETRIED` line existed logged only how many tests were retried, not which; they are counted in the report as "names not logged" and are never
  guessed.
  Only trusted runs count: pushes to `staging` or `main`, and the scheduled nightly runs. A pull request's Frontend job runs the pull request's own
  code (merged or not), so what its log says never becomes ticket text. At most **5** flaky-test tickets are opened or commented per run (the
  most-retried first); the section says how many more were over the line. Every piece of text that came from a log (file, test, selection reason,
  slowest-file name) is written as one code span, with backticks and line breaks removed, so it cannot carry a mention, a `#123` link or markup,
  and each hidden marker counts only as the last line of a ticket body, never in the middle of one.
- **One open ticket per cause**: each cause (the fallbacks, and each flaky test) has its own hidden marker in the ticket body, different from the
  Database ticket's. The job finds the open ticket by marker (a pull request never matches), comments on the oldest when more than one is open,
  looks again right before writing, and shares the Database ticket's single queued writer group, so two runs can never open two tickets for one
  cause. Close a ticket when its cause is gone; the next breach opens a new one.
- **The 20 slowest files and the budget figures** come from the latest nightly full run's log (the tables `npm run test:ci` prints on every full
  run), with the measured figures set against `frontend/test-budget.json`. The minutes figure is compared only when the run used the budget's
  worker count. Until a nightly run exists the report uses the newest full pull request run and says so; with neither it prints "Not available:
  <reason>".
- **The Frontend check's duration**: typical run and slowest tenth (job start to job end, successful first executions on a self-hosted machine,
  as for the Database check), with the previous week beside them. Queue time is reported separately and never added.
- **Cost**: the same self-hosted job as above; no hosted minutes, no install, no new workflow.

**The rule: a time limit is never raised to silence this alert, or the Frontend section.** When the slowest tenth is over 8 minutes, or the
Frontend check or its test files keep growing, the remedy is cheaper tests, more lanes or more capacity. Raising the job limit, the stall limit,
the 8-minute budget or the test-second budget in `policy.json`, or the figures in `frontend/test-budget.json`, is not a remedy and is not accepted
as closing a ticket. A retried test is fixed, not retried more; selection errors are fixed in the selector, not hidden by switching selection off.

## What is deliberately NOT in the PR gate

**`audit-ci`** queries the live npm advisory database, so its result changes with
no commit. On every PR it reddens work that touched zero dependencies because
someone published a CVE overnight, which trains people to ignore a red check.
It runs on dependency-manifest changes and nightly instead (`dependencies.yml`),
and is **not** a required status check - a path-filtered workflow that does not
trigger leaves a required check pending forever.

**CodeQL** was deleted. Code Scanning is not enabled on this private repo (it
needs GitHub Advanced Security), so `codeql-action/analyze` was 403ing on upload
and every result was discarded - the workflow carried `continue-on-error: true`
and produced nothing for months. To bring it back: enable Code Scanning, then add
a workflow with a `pull_request` trigger, and drop `security-extended` to keep
runs cheap.

## Checks that live in the test suites instead

A static scan of source files is a test, not a CI job. These moved out of YAML,
which means they also run locally before you push:

| Check | Now lives in |
|---|---|
| EstimateStatus rename guard | `backend/src/__tests__/estimate-status-rename-guard.test.ts` |
| Security override floors | `backend/src/__tests__/security-overrides.test.ts` |
| Seeded default org exists | `backend/src/__tests__/seed-organization-db.test.ts` |
| Seed copy is unbranded + demo-org guard | `backend/src/__tests__/seed-organization.test.ts` |
| Test file isolation stays on (every config the backend can run with, resolved through vitest itself, must be isolated forks with the one setup file; `isolation-probe-a/b.test.ts` observe it, but only when both land in one worker) and no runtime dependency is replaced in tests except two named ones (each is compared with the real module loaded by plain node, including the shared helpers every suite imports) | `backend/src/__tests__/test-setup-guards.test.ts`, `backend/src/__tests__/isolation-probe-a.test.ts` |

They join ~20 existing filesystem guards in that directory (for example
`no-hardcoded-stripe-secrets.test.ts`) and the schema guard at
`frontend/src/design-system/__tests__/status-registry-schema-guard.test.ts`.

DB-backed tests use the `TEST_DATABASE_URL ? describe : describe.skip` idiom, so
they skip locally and run in the `Database` job.

### Frontend tests: no real sleeps

A frontend test never waits on a real clock, because its margin is then the clock and it is the first test to time
out on a loaded machine. Two rules, enforced by `frontend/src/__tests__/no-real-timer-sleeps.test.ts` (it scans every
frontend test file, so a new file needs no list to edit):

1. **No real timer over 100 ms.** The guard walks each file's syntax tree. A `setTimeout` / `setInterval` call (bare,
   `window.` or `globalThis.`) with a delay over 100, a call to a sleep helper (`sleep`, `wait`, `pause`, or any function in
   the file or in a shared support file whose body calls a timer) with an argument over 100, or a `retryDelay` over 100,
   fails. The number is a literal or a same-file numeric `const`; anything else (a `let`, a computed value) is flagged,
   because it cannot be shown to be 100 ms or less (a helper passing on its own parameter is fine, and its call sites are
   checked, including a default parameter). Use fake timers (`vi.useFakeTimers({ shouldAdvanceTime:
   true })`, then `vi.advanceTimersByTimeAsync(ms)`), or pass the delay into the code under test, or hold a promise open
   and release it (a gate). Fake timers exempt only where they are active: inside the `it` that installs them, or
   throughout the `describe` whose `beforeEach` installs them; a sibling `describe` is not covered, and `toFake: ['Date']`
   alone does not fake timers, and fake timers installed inside a plain helper function exempt nothing. Limit: a helper
   imported from outside the support files is not seen.
2. **Never prove absence with a rejected `findBy`.** `await screen.findByX().catch(...)` burns the whole wait limit
   before it can "pass". Wait for something that DOES appear (the same thing happening in a case that shows it, or the
   request being made), then use `queryBy`. A replaced absence test must still fail when the element is present.

The global wait limit for `findBy` / `waitFor` is 5 s (`frontend/src/__tests__/setup.ts`). A test that needs more
passes its own `{ timeout }` and says why in a comment beside it.

### The switch catalog copy

The shared render helper (`frontend/src/__tests__/helpers.tsx`) builds its default ability set from the frontend's own
copy of the backend permission-switch catalog, `frontend/src/__tests__/support/switchCatalog.generated.json`, so no
frontend test reads a backend file. The copy is generated by `frontend/scripts/switch-catalog.mjs`; regenerate it after
a backend catalog change with `npm --prefix frontend run gen:switch-catalog` and commit the result. One guard test,
`frontend/src/__tests__/switch-catalog-copy.test.ts`, fails when the copy and the backend catalog differ (its message
names that command) and when the render helper starts reading a file from disk again. It is the only frontend test that
reads the backend catalog file.

### Counting queries in a test

To prove a code path runs a fixed number of queries however many rows it handles, use
`countQueries` from `backend/src/__tests__/support/query-counter.ts`:
`const { count, queries } = await countQueries(async () => { await theCode(); })`. It counts every statement the
client sends (interactive-transaction queries, BEGIN/COMMIT and the tenant guard's `set_config` included) and returns
the SQL, so `writes(queries, ['leads'])` / `reads(queries, ['leads'])` count only those. It reads the client
`lib/prisma` exports at call time, so a suite that mocks `lib/prisma` with its own client counts that client; pass a
client as the second argument for another. Prisma sends query events only to a client built with an event log:
`setup.ts` sets `PRISMA_QUERY_EVENTS=on` for the shared client (ignored in production), and a client a test builds
needs `log: QUERY_EVENT_LOG`. A client without it throws instead of reporting zero. Each count is bounded by two
marker queries of its own (never counted), so late query events land in the right count. Separate counts on one client
(or on it and its tenant-guard wrap) run one after another. A count inside another count's block on the same client is
refused with an error, so count each part on its own. Anything else using the client during a count is counted too.
Example: `query-counter-db.test.ts`.

**Before adding a new CI job, ask whether the check needs anything CI has that a
test does not** - the PR's git history, a live external service, a real database,
or a compiled artifact. If not, write a test.

## Required status checks

Branch protection on `staging` and `main` must list exactly:

- `Secret scan (gitleaks)`
- `Backend (build + tests)`
- `Frontend (lint + type-check + tests + build)`
- `Database (migrations + RLS)`

Renaming a job orphans its context and every PR then waits forever on a check
that will never report. Update branch protection in the same change.

## Runner fallback

Both machines can go offline at once (2026-07-29: all six runner entries; again
2026-10-24). A job sent to an offline self-hosted label waits in `QUEUED`
forever, which looks exactly like a busy queue.

So `ci.yml` starts with `Pick runners`, a ~10 second job on `ubuntu-latest`:

1. It lists this repo's runners through the API and counts the **online** ones
   (busy or idle) per label, `macOS`, `Linux`, `database` and `frontend`.
2. A label with at least one online runner keeps its jobs. A label with none
   sends its jobs to `ubuntu-latest` instead. Each label is decided on its own.
3. If it cannot tell (no token, request failed, unreadable answer), it sends
   everything to `ubuntu-latest`. Not knowing must never mean hanging.
4. The repository variable `CI_RUNNERS` overrides it: `hosted` forces
   `ubuntu-latest`, `self-hosted` forces the old labels. Unset or anything else
   means automatic.

Listing runners needs the repository secret `RUNNER_STATUS_TOKEN`: a fine-grained
personal access token, this repository only, permission "Administration:
Read-only". `GITHUB_TOKEN` cannot list runners. Dependabot PRs read Dependabot
secrets, not Actions secrets, so the same token must also be saved there or
Dependabot PRs always run hosted.

`Pick runners` is not a required check. The four required jobs run with
`if: !cancelled()`, and if `Pick runners` produced nothing they fall back to
their usual self-hosted labels. That matters: a required job that is *skipped*
counts as passing, so the required jobs must never depend on it succeeding.

The Database job has its own pick: `Pick runners` also outputs `database`. It is the reserved runner (label `database`) when it is online,
otherwise the general Mac runners, otherwise `ubuntu-latest`, and `database_lanes` is `6` only for the reserved runner. On `ubuntu-latest` the
job runs the same `npm run test:db`, with its own private Postgres 16 server on the throwaway VM and the hosted time limit (60 minutes).

The Frontend job picks the same way: `Pick runners` outputs `frontend`, the reserved runner (label `frontend`) when it is online, otherwise the general
Mac runners, otherwise `ubuntu-latest`; `CI_RUNNERS=hosted` forces hosted and `self-hosted` forces the general Mac labels. The job's time limit
follows that output (45 minutes self-hosted, 30 hosted). The hosted `Frontend tests N/6` shards below still follow the Mac output only, so they run whenever that output is hosted, even when the Frontend job itself landed on the reserved runner.

On `ubuntu-latest` the frontend suite runs as `Frontend tests N/6`, six parallel VMs
(`vitest --shard`), because one hosted VM was still running it at 60 minutes against ~22 on
the Mac. The required `Frontend` job then skips its own Tests step and fails unless every
shard passed. When the Mac output is a self-hosted label the shard job is skipped and nothing changes. When the Mac output is hosted but the Frontend job is on the reserved runner (the general Mac runners offline), the shards still run, and the Frontend job runs its own full suite and ignores their result.

The backend and frontend test steps set `TZ: America/New_York`, the self-hosted runners' zone, because
hosted runners are UTC and some snapshots print local dates.

Limits:
- Only new runs pick runners. A run already queued on an offline label stays
  queued: cancel it and re-run, or push.
- Hosted minutes are billed on a private repo.
- A runner that is online when `Pick runners` checks but drops right after
  still strands the job. Re-run it.

## Known gaps

Still open after the fallback:
- A scheduled job that polls `/actions/runners` and alerts when one drops. The
  fallback keeps CI moving, but nobody is told the machines are down.
- A second Linux runner. Also relieves the serialization point below.

**One Linux runner serializes every backend job.** That is fine at roughly 60
seconds per job, but if that box drops, no PR can pass `Backend (build + tests)`.

**The backend suite has order-dependent tests.** Distinct from runner starvation
and not fixed by capping workers: on an idle machine, three consecutive full-suite
runs gave 0, 2 and 0 failures, and the failing tests passed in isolation. In CI,
`comm-calls-lead.test.ts` has returned 200 and then 500 for the same assertion
across retries. `--retry=2` hides some of this; it is not a fix.

## The authorization suite (release gate)

The tests that prove who may do what are one named suite, `npm run test:authorization` (`backend/vitest.authorization.config.ts`).
Its files are listed ticket by ticket in `backend/src/__tests__/authorization-suite.ts`, and it also takes every `permission-*`
test, so a new permission test joins the gate the day it lands.

- The Backend job runs it as the step "Authorization suite (release gate)", on every pull request and on every push to main (except a push whose tree the
  merged pull request's run already tested in full, see "Push to main").
  The suites that need no database run there.
- The Database job runs its real-database suites (every `*-db.test.ts` is in the list `npm run test:db` runs, across the lanes), on the same triggers.
- `authorization-suite.test.ts` fails when a listed file is missing, when a ticket lists nothing, or when ci.yml stops running
  the suite. Backend and Database are required checks in branch protection, so a red authorization test blocks the merge.
