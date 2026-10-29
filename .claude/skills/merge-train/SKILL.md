---
name: merge-train
description: "Serially integrate the nightly auto-fix PRs into staging, CI-gated, with agent conflict resolution and ONE end-of-train deploy health check. Processes only workflow PRs (head branch fix/issue-*) one at a time: CI green → squash-merge; conflict → rebase / resolve via agent → merge; failure → leave open + flag for human. Use when the user wants to 'run the merge train', integrate the auto-fix PRs, or as the nightly merge phase after the fix-issues-pipeline opens its PRs."
user_invocable: true
---

# Merge-Train

The integration half of the nightly QA auto-fix loop. The `fix-issues-pipeline` skill (Mode B) opens
one PR per fix (`fix/issue-<n>` → `staging`, issue labeled `pr-pending`). This skill merges those
PRs into `staging` **one at a time**, gating each on CI, resolving conflicts with an agent, and
verifying staging is healthy once at the end. Runs unattended (nightly routine) or on demand.

> **Topology:** `staging` = TESTING line → demo `servwave-demo.vercel.app` (FE) +
> `alpha-crm-test-env.onrender.com` (BE) redeploy from it; QA verifies there. `main` = LIVE/prod —
> **never touched here.** Issues close only at promotion (QA "approved" → Ran promotes → sheet
> "Finalize promoted"), never by this skill.

## Non-negotiables

- **Only workflow PRs.** Operate exclusively on open PRs whose **head branch matches `fix/issue-*`**
  AND whose linked issue is still labeled **`pr-pending`**. Any other PR (human PRs, different branch
  names, issues already escalated to `ready-for-human`) is invisible to the train — never merge it.
- **Serial.** One PR fully resolved (merged or flagged) before the next. Re-evaluate mergeability
  fresh for each, because every merge advances `staging`.
- **CI is the gate.** A PR merges only when **all its checks are green**. Red or still-failing →
  flag for human, never merge. (`staging` is intentionally unprotected, so the gate lives HERE.)
- **Never force a conflicted merge.** Conflicts go through rebase → (if needed) a resolution agent
  whose result must be green before merge. An unresolved conflict is a flag-for-human, not a merge.
- **Never weaken/skip a test, never touch `main`, never force-push `staging`, never commit secrets.**
- **No AI attribution** in commits / PR / issue comments (CLAUDE.md rule #8).
- **Worktrees** under `../alpha_crm-worktrees/`; resolve root via `git rev-parse --show-toplevel`.

## DRY_RUN

`echo "$DRY_RUN"`. If `1`: list the PRs the train would process and, for each, what it WOULD do
(merge / rebase / resolve-conflict / flag), but make **no** merge/push/label/comment/sheet/health
change. Then exit.

## Step 1 — Select the train (oldest first)

```bash
gh pr list -R ranro1/ALPHA_CRM --state open --base staging \
  --json number,headRefName,title,mergeable,mergeStateStatus,statusCheckRollup --limit 200
```
Keep only PRs where `headRefName` matches `fix/issue-<n>`. For each, parse `<n>` and confirm the
issue still carries `pr-pending`:
```bash
gh issue view <n> -R ranro1/ALPHA_CRM --json state,labels
```
Drop any whose issue is closed or no longer `pr-pending` (already merged or already escalated).
Sort the survivors by PR number ascending. That ordered list IS the train.

## Step 2 — Process each PR in order

For PR `#p` (issue `#n`, branch `fix/issue-<n>`):

1. **Wait for CI to finish, then gate on it.**
   ```bash
   gh pr checks <p> -R ranro1/ALPHA_CRM   # poll until no check is "pending"; cap ~15 min
   ```
   - Any check **fail** → **flag-for-human** (Step 4). Do not merge.
   - All **pass** → continue.

2. **Check mergeability.** `gh pr view <p> --json mergeable,mergeStateStatus`.
   - `MERGEABLE` (no conflict) → **merge** (Step 3). Fast path — reuses the CI that already ran.
   - `CONFLICTING` → **rebase + maybe resolve** (Step 2a), then merge.
   - `UNKNOWN` → wait briefly and re-query (GitHub is still computing); if it stays UNKNOWN, treat
     as conflicting and rebase.

2a. **Rebase / resolve conflict** (only when conflicting):
   ```bash
   ROOT=$(git rev-parse --show-toplevel); WT="$ROOT/../alpha_crm-worktrees/mt-issue-<n>"
   git fetch origin staging fix/issue-<n>
   git worktree add "$WT" fix/issue-<n>
   git -C "$WT" rebase origin/staging
   ```
   - **Rebase clean** → `git -C "$WT" push --force-with-lease origin fix/issue-<n>` → its CI re-runs
     → go back to Step 1 (wait for CI) → merge.
   - **Rebase conflicts** → dispatch a **conflict-resolution agent** (one subagent) into `$WT`:
     it must resolve every conflict **preserving both sides' intent** (never blindly drop a side),
     follow `systematic-debugging` + `test-driven-development`, and leave the worktree with
     **green scoped tests** (`npm test --workspace=backend` / frontend `npx tsc --noEmit`).
     - Agent succeeds (conflicts resolved + tests green) → `git -C "$WT" rebase --continue`,
       `push --force-with-lease`, wait for CI, merge.
     - Agent cannot cleanly resolve → `git -C "$WT" rebase --abort` → **flag-for-human** (Step 4).
   - Always `git worktree remove "$WT"` when done.

## Step 3 — Merge (success path)

```bash
gh pr merge <p> -R ranro1/ALPHA_CRM --squash --delete-branch
git fetch origin staging -q
SHA=$(git rev-parse origin/staging)   # the new staging tip (squash commit)
# promotion ledger — so /promote-approved can later ship this fix to main (issue = the SHEET number)
bash "$ROOT/.claude/skills/promote-approved/record-ledger.sh" <n> "$SHA"
gh issue edit <n> -R ranro1/ALPHA_CRM --remove-label pr-pending
gh issue comment <n> -R ranro1/ALPHA_CRM --body "Merged to staging (\`$SHA\`). Live on the demo for QA to test."
# QA sheet → "need review" (this is where the sheet is touched — at the REAL merge, not at PR-open)
set -a && source "$ROOT/backend/.env" && set +a
if [ -n "$SHEETS_WEBAPP_URL" ] && [ -n "$SHEETS_WEBAPP_TOKEN" ]; then
  curl -sL "${SHEETS_WEBAPP_URL}?token=${SHEETS_WEBAPP_TOKEN}&issue=<n>&status=need%20review"
fi
```
Issue stays OPEN (it auto-closes later when its promotion PR merges to `main`). Move to the next PR.

## Step 4 — Flag-for-human (failure path)

Red CI, an unresolvable conflict, or a merge error: do **not** merge. Leave the PR **open**, and:
```bash
gh pr comment <p> -R ranro1/ALPHA_CRM --body "Merge-train could not auto-merge: <one-line reason>. Left open for a human."
gh issue edit <n> -R ranro1/ALPHA_CRM --remove-label pr-pending --add-label ready-for-human
gh issue comment <n> -R ranro1/ALPHA_CRM --body "Auto-merge failed: <one-line reason>. Flagged for a human."
```
Removing `pr-pending` makes the train skip this PR on future runs. Continue to the next PR.

## Step 5 — End-of-train health check (once, only if ≥1 PR merged)

Each merge auto-triggers a Render (BE) + Vercel (FE) deploy from `staging`; the last one wins.
Verify the NEW build is actually serving — `/health` returns the running commit SHA:
```bash
TARGET=$(git rev-parse origin/staging)
BE="${STAGING_HEALTH_URL:-https://alpha-crm-test-env.onrender.com/health}"
FE="${STAGING_FE_URL:-https://servwave-demo.vercel.app}"
# poll up to ~15 min: BE /health is 200 AND its sha matches TARGET (not a stale deploy), FE is 200
```
- **Healthy** (BE 200 + `sha`≈`TARGET`, FE 200) → log success with the merged count + SHA.
- **Unhealthy after timeout** → open ONE incident (do NOT auto-revert — each PR passed CI, so a
  deploy-only failure is environmental and needs eyes):
  ```bash
  gh issue create -R ranro1/ALPHA_CRM --label ready-for-human \
    --title "staging unhealthy after nightly merge-train ($TARGET)" \
    --body "The merge-train merged N PR(s) then the staging deploy did not come up healthy: <BE/FE status, sha seen vs expected>. Investigate before promoting."
  ```

## Output

End with a one-line summary per PR (merged `<sha>` / rebased+merged / resolved+merged / flagged
`<reason>`), the totals, and the health-check result.

## Red Flags — STOP

| Thought | Reality |
|---|---|
| "I'll merge all the PRs in parallel" | The train is **serial** — each merge moves `staging`; the next PR's conflict state changes. One at a time. |
| "CI is still pending, the diff looks fine, merge it" | Never. Wait for green. CI is the only gate (staging is unprotected). |
| "Conflict — I'll merge with `-X theirs`/`ours`" | No blind strategy merges. Rebase; if it conflicts, an agent resolves preserving both sides, tests green, then merge. |
| "This human PR is also red/stale, I'll tidy it" | Out of scope. Only `fix/issue-*` PRs with a `pr-pending` issue. Never touch human PRs. |
| "Deploy looks down, I'll revert the merges" | Don't auto-revert. Open an incident; a human decides (each PR was green). |
| "I'll write `Fixes #n` so it closes" | No — issues close only at promotion via the sheet. Never close here. |
