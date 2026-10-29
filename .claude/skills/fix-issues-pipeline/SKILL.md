---
name: fix-issues-pipeline
description: "Interactive multi-agent pipeline for fixing a batch of GitHub issues with high confidence. Runs a mandatory per-issue VALIDATE gate (reproducible + still relevant?) before any planning, then propose×3↔adjudicate, plan↔review, and per-issue ship (Mode A: direct merge to staging — interactive default; Mode B: open a PR for the nightly merge-train — unattended). Use when the user wants to 'fix issues', 'do an issue-fixing session', run the 'agentic/multi-agent issue pipeline', or batch-fix GitHub issues"
user_invocable: true
---

# Fix-Issues Pipeline

Multi-agent, human-gated pipeline for batch-fixing GitHub issues on `ranro1/ALPHA_CRM`. This is
interactive, runs in the foreground via the **Workflow** tool, and targets **`staging`** as default, unless the user told otherwise.

> **Environment context (two-env topology, 2026-06-26 cutover):** `staging` is the **TESTING** line —
> the QA demo (`servwave-demo.vercel.app`) redeploys from it, and QA verifies fixes there. `main` is
> **LIVE/prod** (`app.servwave.com`). The retired `servwave` branch is no longer a deploy target.
> Fixes land on `staging`; Ran promotes `staging → main` separately to ship them live.

## Non-negotiables

- **Base = `staging`, on a dedicated branch by default.** Unless the user says otherwise, the
  pipeline creates and works on its own batch branch cut from `origin/staging`
  (default name `fix/issues-batch-<YYYY-MM-DD>`) — never directly on `staging`, never `main`.
- **`staging` is the TESTING line.** Two ship modes (see Implementation run → Ship): **Mode A —
  direct merge** (interactive default): the approved fix is merged straight into `staging`, which
  redeploys the demo. **Mode B — PR for the merge-train** (unattended nightly): the approved fix is
  pushed as a PR and a separate `merge-train` skill integrates it. Either way there is no human PR
  review, so the in-pipeline adversarial review + green tests are the ONLY gate — a fix must pass
  both before it ships.
- **VALIDATE before you plan.** Phase 0 is mandatory and gated. Do NOT plan or fix an issue
  that hasn't passed a dedicated reproducibility+relevance check. (This is the step that gets
  forgotten — see Red Flags.)
- **Plan-only first.** Phases 0–3 write NO product code. Implementation is a separate run the
  user explicitly approves.
- **No AI attribution** in any commit, PR, or issue comment (CLAUDE.md rule #8).
- **Worktrees** under `../alpha_crm-worktrees/`; resolve root via `git rev-parse --show-toplevel`.
- **`tenantWhere(req)`** must appear in every authed Prisma `where`/`data` — reviewers verify it.
- Workflow requires explicit opt-in; only launch after the user says go.

## Pre-flight checklist

- [ ] Confirm the issue set with the user (numbers). Don't infer scope.
- [ ] `git fetch origin staging`. **By default, create & checkout a dedicated batch branch off
      `origin/staging`** (`fix/issues-batch-<YYYY-MM-DD>`) — only skip/rename if the user
      specifies a different branch or base.
- [ ] Working tree clean enough to switch (park colliding untracked files in a scoped stash).
- [ ] `gh auth status` OK.

## Phase 0 — VALIDATE & RELEVANCE  ← the gate, never skip

**One dedicated agent per issue, fanned out (`parallel()` barrier).** Each agent:
1. `gh issue view <n>` — read body + acceptance criteria.
2. Locate the implicated code on **current staging** (file:line) and trace actual behavior.
3. Return a schema-enforced verdict:

| Verdict | Meaning | Action |
|---|---|---|
| `REPRODUCIBLE` | Bug still present, confirmed at file:line | → continue to Phase 1 |
| `ALREADY_FIXED` | Behavior already correct | → skip; recommend close (cite fix commit/PR) |
| `NOT_REPRODUCIBLE` | Can't confirm / behaves as intended | → skip; recommend `needs-info` |
| `STALE` / `OBSOLETE` | Code path removed or superseded | → skip; recommend `wontfix` |
| `DUPLICATE` | Same root cause as another issue | → skip; link it |

Each verdict carries: evidence (file:line + quoted code), repro confirmed/failed, one-line relevance note.

**→ HARD CHECKPOINT:** stop. Report the verdict table to the user. Only issues the user
confirms `REPRODUCIBLE` proceed. No planning tokens spent on dead issues.

## Phase 1 — Propose ×3 ↔ Adjudicate  (per survivor)

- 3 agents independently propose competing solutions (different angles).
- 1 adjudicator scores them on correctness, blast radius, and CLAUDE.md "simplicity above all";
  picks a winner, grafting good ideas from runners-up. Loop once if no clear winner.

## Phase 2 — Plan ↔ Review  (per survivor)

- Planner writes a file:line-grounded plan: root cause, exact edits, acceptance criteria,
  multi-tenancy (`tenantWhere`) note, and a test plan.
- Reviewer adversarially checks it: missed call sites, regressions, contract/migration impact,
  diff-vs-issue coverage. Loop until `approved`.

Phases 1–2 run as a `pipeline()` per survivor (each issue flows propose→adjudicate→plan→review
independently — no barriers, no wasted wall-clock).

## Phase 3 — Emit artifacts  (per approved plan)

- [ ] Write `md_files/plans/{module}/issue-<n>.md` (git-ignored).
- [ ] Create local `fix/issue-<n>-<slug>` branch off `staging` (unpushed scaffold).
- [ ] Post a summary/assessment comment on each GitHub issue.

**→ STOP. Report to the user. Await go for implementation.**

## Implementation run  (separate, only after explicit approval)

The implement → test → review steps are identical in both ship modes; only the final **Ship** step
differs. Because there is no human PR review, the in-pipeline review + green tests are the ONLY gate —
nothing ships that isn't green + review-approved.

- Worktree-isolation Workflow: one agent per `fix/issue-<n>` branch (`isolation: 'worktree'`)
  so parallel edits don't collide.
- Each agent: implement the plan → run scoped tests (`npm test --workspace=backend` /
  frontend `npx tsc --noEmit`) → commit (conventional message, no AI attribution).
- Adversarial review fan-out: diff-vs-plan + commit-hygiene + `tenantWhere` presence.
  **A fix must be green AND review-approved before it is eligible to ship.**

### Ship — pick the mode

**Mode A — direct merge (interactive default).** Merge each approved fix branch into `staging` and
push (the demo redeploys from `staging`):
  ```bash
  git fetch origin staging
  git checkout staging && git pull --ff-only origin staging
  git merge --no-ff fix/issue-<n> -m "fix: <summary> (#<n>)"   # aborts on conflict
  git push origin staging
  ```
  On conflict, STOP for that issue, `git merge --abort`, and report it — never force a conflicted
  auto-merge. (staging must allow direct pushes.) After the push succeeds, (1) record a
  **promotion-ledger** entry so `/promote-approved` can later ship this fix to `main`, then (2)
  update the QA sheet to "need review" (the fix is now live where QA tests):
  ```bash
  ROOT=$(git rev-parse --show-toplevel)
  # (1) promotion ledger — the just-pushed merge commit is the staging tip (issue = the SHEET number)
  bash "$ROOT/.claude/skills/promote-approved/record-ledger.sh" <N> "$(git rev-parse origin/staging)"
  # (2) QA sheet → need review
  set -a && source "$ROOT/backend/.env" && set +a
  if [ -n "$SHEETS_WEBAPP_URL" ] && [ -n "$SHEETS_WEBAPP_TOKEN" ]; then
    curl -sL "${SHEETS_WEBAPP_URL}?token=${SHEETS_WEBAPP_TOKEN}&issue=<N>&status=need%20review"
  fi
  ```
  If `backend/.env` is unset, skip the sheet update silently — never fail the workflow over it. The
  ledger entry is what makes the fix promotable later, so don't skip it (it pushes to `staging`).

**Mode B — PR for the merge-train (unattended nightly).** Do NOT merge and do NOT touch the sheet
here — the separate `merge-train` skill integrates the PR and updates the sheet on merge. Instead,
per approved fix:
  ```bash
  git push -u origin fix/issue-<n>
  gh pr create -R ranro1/ALPHA_CRM --base staging --head fix/issue-<n> \
    --title "fix: <summary> (#<n>)" \
    --body "Refs #<n>. Automated fix; CI gates the merge; integrated by the nightly merge-train."
  gh issue edit <n> -R ranro1/ALPHA_CRM --remove-label ready-for-agent --add-label pr-pending
  ```
  Use **`Refs #<n>`, never `Fixes #<n>`** — the issue must stay OPEN through QA review (a `Fixes`
  keyword would auto-close it at the eventual `main` merge, bypassing the sheet's promote step). The
  `fix/issue-<n>` branch name + the `pr-pending` issue label are how the merge-train finds workflow
  PRs and avoids re-opening one for an issue already in flight.

In BOTH modes, the GitHub issue stays OPEN after shipping to `staging` (staging ≠ main). It is NOT
closed by the pipeline — only when QA marks the row "approved" AND Ran promotes the fix to `main`
(the QA sheet's "Finalize promoted" step closes the issue + deletes the row). Do not close it here.

## Red Flags — STOP, you're about to repeat a known miss

| Thought | Reality |
|---|---|
| "The issue's obviously still valid, skip validation" | Phase 0 is mandatory. Issues get fixed/obsoleted between filing and now. Validate. |
| "I'll plan all of them, validate later" | Validation is the GATE. Planning a dead issue wastes a full propose→review cycle. |
| "I'll branch off main" | Bug-fix work is `staging`-based here (staging = the testing line). Never `main`. |
| "I'll branch off the old servwave branch" | `servwave` is retired and no longer deployed. Base everything on `staging`. |
| "I'll merge to staging and the issue auto-closes" | It does not (`Fixes #` closes only on `main`). Leave it OPEN — it's closed at promotion (QA "approved" → Ran promotes → sheet "Finalize promoted" closes it). |
| "I'll open a PR to staging" | Only in **Mode B** (the unattended merge-train). In interactive **Mode A** there's no PR — merge straight in. Pick the mode deliberately; don't half-do both. |
| "Mode B, so I'll write `Fixes #n` in the PR" | Use `Refs #n`. `Fixes` auto-closes the issue, bypassing the QA-review→promote→sheet-finalize close path. |
| "Tests are red but the fix looks right, I'll ship" | Never. No human PR review = the in-pipeline review is the only second gate. Red tests or an unapproved review block the ship, full stop. |
| "Old-base branch, I'll just merge it" | Branches cut from a stale base collide with main-repo untracked e2e specs. `git stash push -u -- <paths>` first. |
| "I'll add a Co-Authored-By line" | Never. CLAUDE.md rule #8. |

## Workflow script skeleton

```js
export const meta = {
  name: 'fix-issues-pipeline',
  description: 'Validate-gated multi-agent issue fixing (plan-only)',
  phases: [{ title: 'Validate' }, { title: 'Propose' }, { title: 'Adjudicate' }, { title: 'Plan' }, { title: 'Review' }],
}
const ISSUES = args.issues           // e.g. [186,187,113,172] passed via Workflow args
// Phase 0 — barrier: validate ALL, then the human gate happens OUTSIDE the workflow.
phase('Validate')
const verdicts = await parallel(ISSUES.map(n => () =>
  agent(`Validate GitHub issue #${n} on current staging: reproduce it at file:line and judge relevance. ` +
        `Return verdict REPRODUCIBLE|ALREADY_FIXED|NOT_REPRODUCIBLE|STALE|DUPLICATE with evidence.`,
        { label: `validate:#${n}`, phase: 'Validate', schema: VALIDATE_SCHEMA, agentType: 'Explore' })))
return verdicts.filter(Boolean)
// → I report the table, user confirms survivors, THEN a second Workflow run does Phases 1–3
//   over survivors using pipeline(survivors, propose↔adjudicate, plan↔review).
```

Run Phase 0 as its own Workflow invocation so the checkpoint is a real stop. Pass the confirmed
survivor list into the second invocation for Phases 1–3.
