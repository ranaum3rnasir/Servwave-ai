# Issue tracker: GitHub

Issues and PRDs for `ranro1/ALPHA_CRM` live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..." --label "..."`. Use `--body-file` (heredoc piped to a temp file) for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels --jq '...'` with `--label` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Edit labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` infers the repo from `git remote -v` automatically.

## Label vocabulary

Every issue carries exactly one priority label + one module label. May optionally carry a triage state label and workflow labels.

**Priority** (exactly one, required):
- `priority:critical` — blocks core pipeline; data loss / security / financial wrong
- `priority:high` — core workflow broken; blocks other testing
- `priority:medium` — feature works incorrectly; visible to customers
- `priority:low` — UI/UX or cosmetic

**Module** (exactly one, required): `module:auth`, `module:customers`, `module:leads`, `module:estimates`, `module:deposits`, `module:jobs`, `module:scheduler`, `module:invoices`, `module:payments`, `module:price-book`, `module:attachments`, `module:search`, `module:settings`, `module:walkthrough`, `module:dashboard`, `module:reports`, `module:email`, `module:communication`, `module:inventory`, `module:permissions`, `module:tasks`, `module:automations`, `module:ai-center`, `module:general`

- Vault module notes without their own label: Events -> `module:scheduler`, Purchasing -> `module:inventory`, Organization and Departments -> `module:settings`, Tags -> `module:general`.
- Mobile work has no module of its own. The native app mirrors the web app, so a mobile issue takes the module of the screen it is about.
- `module:general` is only for issues about the whole app or no single area: a crash report with no clear screen, whole-app work (e.g. mobile compatibility), repo-wide security or tooling. If one area owns the issue, use that area's label.

**Category** (one of, optional): `bug`, `enhancement`, `documentation`, `question`

**Workflow** (zero or more):
- `auto-fix-eligible` — picked up by the nightly auto-fix cron (1:00 AM ET). Apply only to issues with clear root cause and ≤5-file fix. NEVER apply to issues touching auth, payments, Stripe, webhooks, or DB migrations.
- `pr-pending` — has an open PR awaiting review (auto-applied by fix-cron when it opens a PR; auto-removed when the PR is merged or closed).
- `queue:runner` — a ticket done on the CI machine itself (runner labels, runner services), by the agent that runs there, never by a cloud or repo agent.
- `ci-budget` — the one open ticket the weekly CI time budget job (`.github/workflows/ci-budget.yml`) opens or comments on; its body carries a hidden marker, and the job finds the ticket by this label plus the marker.
- `in-progress` — claimed by an agent; the newest `CLAIMED` comment says which one.

**Triage state** (optional, from `triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Handing tickets between agents on different machines

When one ticket graph is worked by more than one agent (for example a cloud build session and
the agent on the CI machine), GitHub is the only shared state. The rules, the same for every agent:

1. **Startable** = open, not claimed, and every issue in its `## Blocked by` section is **closed**.
   A repo ticket is closed only after its change is merged into `staging`, so "closed" means
   "live for the next agent". `node scripts/issue-frontier/run.mjs --label <queue>` lists a
   queue's startable, claimed and blocked tickets (exit 0 when something is ready, 3 when not).
2. **Claim**: comment `CLAIMED <agent> <UTC time>` and add `in-progress`. One claimant at a time.
3. **Done**: close the issue with a comment starting `DONE:` holding the proof (commands run,
   their output, the resulting state). Remove `in-progress`.
4. **Stuck**: comment `STUCK:` with the reason, swap `in-progress` for `ready-for-human`, and
   tell Ran. Never close a ticket to unblock the other side.

A nudge between agents (a chat message, a webhook) carries no instructions, only "check your
queue". The issue bodies are the instructions.

## Branching policy

Both bug fixes and features open their first PR into `staging`; **never commit directly to `main` or
`staging`.** The base to cut from is decided by one command, every time:

```bash
git fetch origin main staging
git merge-base --is-ancestor origin/main origin/staging && echo "cut from main" || echo "cut from staging"
```

**Target state (set 2026-08-05): cut from `main`.** That keeps the later promotion PR small and reviewable,
and it is what the process is aimed at.

**Today the gate says `staging`, and here is why.** A PR's diff is computed against the *merge base*, not
against the current trees. Every PR in this repo is squash-merged, so the 2026-08-05 staging->main
promotion (#1259) copied staging's tree onto `main` without ever linking their histories. The merge base is
still **2026-07-03**. Consequence, reproduced 2026-08-05 on PR #1289: a `main`-based branch opened into
`staging` showed **1,963 files** changed, against a real tree delta of **34**. This is the same failure
first measured on issue #1148 (a 22k-line phantom conflict).

**`git diff --stat origin/main origin/staging` is the wrong check.** Tree closeness does not make a
`main`-based branch diff cleanly; only a shared history does. Do not substitute it for the gate above.

To reach the target state, one promotion has to land as a real **merge commit** rather than a squash - after
that, `main` is an ancestor of `staging`, the gate flips, and the rest of this section applies as written.

- **Bug fix.** Cut a worktree from the base the gate names, under `../alpha_crm-worktrees/`
  (`git worktree add ../alpha_crm-worktrees/<branch> -b <branch> origin/<base>`). Branch naming:
  `fix/<issue-number>-<short-slug>`. Open a PR into `staging`; the PR body must contain `Fixes #<n>`
  so GitHub auto-closes the issue on merge.
- **Feature / normal ship.** Same base, `feat/<slug>`, PR into `staging`.
  Full standard/hotfix/rollback flow -> the `ship-changes` skill.
- **Sanity-check the opened PR.** If its file count is wildly larger than what you touched, the base was
  wrong - re-cut from `staging` rather than asking anyone to review a phantom diff.

### Promotion to `main`

- **Only when Ran explicitly asks, in the current session.** After a staging PR merges, *offer* the
  promotion and wait - never open it unprompted. Approval for one promotion does not carry to the next.
- Cherry-pick the merged staging commit with `-x` onto a fresh `main`-based branch (`promote/<slug>`),
  and open a second PR into `main`.
- **Promote the whole interlocking set.** Before assuming a PR stands alone, check what the target files
  actually contain on `main` - cherry-picking a fix whose dependency is still only on `staging` lands
  broken code on prod. A dependency already promoted under a different commit will cherry-pick as a
  verified no-op, which is the cheap way to confirm it.
- Keep `staging` close to `main`. Divergence is what broke the old process, and an unpromoted fix is
  what causes divergence.

## GitHub vs Linear

Feature **ideas** live in Linear (`SRVW-…`, filed by `/log-idea`). These skills never publish there. GitHub issues hold the work tied to code: bugs, specs and their slices. A spec built from a Linear idea links its `SRVW-…` id.

## When a skill says "publish to the issue tracker"
Create a GitHub issue.

## When a skill says "fetch the relevant ticket"
Run `gh issue view <number> --comments`.
