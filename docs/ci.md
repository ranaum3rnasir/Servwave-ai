# CI design

Two workflows. `ci.yml` is the PR gate; `dependencies.yml` is scheduled.

## The constraint everything follows from

The runner pool looks like six machines and is two:

| Runner label set | Reality |
|---|---|
| `self-hosted, macOS, ARM64` x5 | Five runner **processes on one Mac mini** |
| `self-hosted, Linux, ARM64` x1 | One separate Linux box |

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
| `Pick runners` (not required) | GitHub-hosted | Chooses self-hosted or GitHub-hosted for the four jobs below (see Runner fallback) |
| `Secret scan (gitleaks)` | macOS | Leaked credentials across the PR commit range |
| `Workflow lint (actionlint)` (not required) | macOS | Every workflow file parses; shellcheck on their `run:` scripts |
| `Backend (build + tests)` | Linux | Prisma generate, `tsc` (build + scripts + **the suites' own types**), the backend suite incl. static guards |
| `Frontend (lint + type-check + tests + build)` | macOS | `tsc --noEmit`, vitest, vite build, ESLint on changed files |
| `Database (migrations + RLS)` | macOS | Migrations apply + no drift, RLS isolation, seed, role-permission drift |

One `npm ci` per job, three total. `Database` runs against a native Postgres
(`postgresql@16` via Homebrew) installed directly on the mini, not a Docker
container - see "Database runs on native Postgres, not Docker" below. It stays
on macOS because that is where Postgres is installed; moving it to Linux is
possible later but was not the fix that was needed.

### Linting is changed-files-only

The frontend had a 239-error / 1012-warning backlog when the gate was added, so
`eslint .` could never be blocking. Only files the PR adds or modifies are
linted: new code must be clean, the backlog blocks nobody, and it shrinks as
files get touched. Touching a legacy file can surface *its* pre-existing errors -
that is the intended ratchet.

Lint runs last in the job so a lint failure never hides a test result.

## Database runs on native Postgres, not Docker

`Database` used to start a fresh `postgres:16` container per run, on a
Docker-assigned host port so concurrent runs on different runner processes
would not collide. That port-forward step failed intermittently - the
container's own Postgres was always healthy (`database system is ready to
accept connections` in its log), the HOST port simply never became reachable.
Correlated 7/7 across a burst of ten PRs: the first `Database` job on a given
runner process passed, every later job on the same process failed. That is
Docker Desktop's userland port forwarder degrading after container churn on
that runner, not a Postgres or CI-script problem.

The fix: install Postgres directly on the mini (`brew install postgresql@16`,
`brew services start postgresql@16` so it survives reboots) and connect over
`127.0.0.1:5432` with no container in between. Auth is `trust` for
`127.0.0.1`/`::1` in that cluster's `pg_hba.conf` - Homebrew's default - so the
connection URLs in `ci.yml` carry no password on purpose, not because one was
forgotten.

**This trades container isolation for a shared, persistent cluster**, and that
has one real consequence: Postgres **roles** are cluster-wide (databases are
not). `rls-isolation.test.ts` and `login-lockout-rls.test.ts` both do role DDL
(`CREATE`/`DROP ROLE`, `GRANT`) using fixed names (`rls_demo_role`, `app_rls`).
Two `Database` jobs running at once - plausible, since any of the five macOS
runner processes can pick one up - would race on the system catalog exactly
like the two-vitest-files-in-one-step bug already documented below, just
across jobs instead of within one.

Mutual exclusion is a **lock directory on the runner's own disk**
(`/tmp/ci-native-pg-database.lock`), acquired via `mkdir` (atomic on a POSIX
filesystem) right before the database-touching steps and released in the
final `if: always()` step. A first attempt used a GitHub Actions job-level
`concurrency` group instead, and it made the problem WORSE: when several PRs'
`Database` jobs enter the same group within seconds of each other, GitHub
keeps only the most-recently-queued one and **cancels every earlier waiter
outright** rather than queuing it. Observed doing exactly this across a batch
of 10 PRs pushed together - 7 of 10 cancelled within seconds of starting, not
delayed. A lock directory has no such eviction: these runners are persistent
(unlike ephemeral GitHub-hosted ones), so the directory survives between job
runs on the same machine and every waiting job eventually gets in. The lock is
scoped tightly to just the Postgres-touching steps - `npm ci`/`prisma
generate` run unlocked beforehand, so waiting jobs are not blocked on work
that never touches Postgres. A lock older than 35 minutes (past this job's own
30-minute timeout) is reaped on the next acquire attempt, so a runner crash or
hard-killed job cannot wedge the lock forever. Each run still gets its own
throwaway database named `test_ci_${{ github.run_id }}`, dropped alongside the
lock in the final step, so a crashed or cancelled run cannot leave state that
confuses the next one.

The tradeoff to watch: a burst of PRs now serializes on this one job instead of
occasionally flaking on it. At roughly 1-2 minutes of real work per run this is
a good trade today. If PR volume grows enough that the queue itself becomes the
complaint, the alternative is parameterizing `rls_demo_role`/`app_rls` per run
instead of relying on serialization - not done here to keep this fix scoped to
`ci.yml` alone, with no changes to the test files it is protecting.

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

They join ~20 existing filesystem guards in that directory (for example
`no-hardcoded-stripe-secrets.test.ts`) and the schema guard at
`frontend/src/design-system/__tests__/status-registry-schema-guard.test.ts`.

DB-backed tests use the `TEST_DATABASE_URL ? describe : describe.skip` idiom, so
they skip locally and run in the `Database` job.

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
   (busy or idle) per label, `macOS` and `Linux`.
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

On `ubuntu-latest` the Database job starts its own `postgres:16` container on
127.0.0.1:5432 (trust auth, the runner's OS user as superuser, the same shape as
the Mac's native cluster), and the lock step returns at once because nothing
else uses that cluster. The native-Postgres PATH step only runs on self-hosted.

On `ubuntu-latest` the frontend suite runs as `Frontend tests N/6`, six parallel VMs
(`vitest --shard`), because one hosted VM was still running it at 60 minutes against ~22 on
the Mac. The required `Frontend` job then skips its own Tests step and fails unless every
shard passed. On self-hosted runs the shard job is skipped and nothing changes.

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

- The Backend job runs it as the step "Authorization suite (release gate)", on every pull request and on every push to main.
  The suites that need no database run there.
- The Database job runs its real-database suites (every `*-db.test.ts` is dealt to a shard by name), on the same triggers.
- `authorization-suite.test.ts` fails when a listed file is missing, when a ticket lists nothing, or when ci.yml stops running
  the suite. Backend and Database are required checks in branch protection, so a red authorization test blocks the merge.
