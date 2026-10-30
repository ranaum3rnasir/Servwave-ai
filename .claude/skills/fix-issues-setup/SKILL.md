---
name: fix-issues-setup
description: "Set up the nightly auto-fix cron job. Creates a durable cron at 1:00 AM ET that picks up to 5 GitHub issues labeled `auto-fix-eligible`, fixes each in its own worktree off staging, opens one PR per fix against staging, and records results for the morning vault audit email. Run once per week to renew (auto-expires after 7 days)."
user_invocable: true
---

# Fix Issues Setup

## Purpose
Create (or renew) the nightly auto-fix cron job. The job fires at 1:00 AM ET (87 minutes before the vault audit at 2:27 AM), spawns a Team Lead agent that picks the top 5 GitHub issues labeled `auto-fix-eligible`, fixes each on its own branch off `staging`, opens a PR per fix, and records results so the morning vault audit email lists PRs awaiting review.

## Prerequisites
- Claude Code session must be **running** for the cron to fire
- `gh` CLI authenticated with `repo` scope (verify with `gh auth status`)
- `staging` branch exists on `origin` (verify with `git ls-remote origin staging`)
- Repo path: resolve with `git rev-parse --show-toplevel` (OS-agnostic — works on Windows and macOS)
- Worktree parent dir exists or is creatable: `../alpha_crm-worktrees` (a sibling of the repo root)

## Procedure

### 1. Check Existing Crons
Use `CronList` to check if a fix-issues cron already exists. If it does, report its status and ask if the user wants to renew (replace) it.

### 2. Get Today's Date
Run `date +%Y-%m-%d` via Bash to get today's date. This becomes CREATION_DATE.
Calculate expiry: CREATION_DATE + 7 days.

### 3. Create the Durable Cron
Use `CronCreate` with:
- **cron:** `0 1 * * *`
- **durable:** `true`
- **prompt:** Use the EXACT orchestrator prompt below, replacing:
  - every instance of `__CREATION_DATE__` with today's actual date (YYYY-MM-DD format)
  - every instance of `__REPO_ROOT__` with the output of `git rev-parse --show-toplevel` (the repo's absolute path on THIS machine — forward-slash form, works in bash on Windows and macOS)
  - every instance of `__WORKTREE_PARENT__` with `<repo-root>/../alpha_crm-worktrees` (a sibling of the repo root)

### 4. Confirm
Output:
```
## Auto-Fix Cron Active

**Schedule:** Every night at 1:00 AM ET (87 min before vault audit)
**Created:** [CREATION_DATE]
**Expires:** [CREATION_DATE + 7 days]
**Source:** GitHub issues labeled `auto-fix-eligible` (max 5 per night)
**Output:** One PR per fix, base = `staging`
**Results visible in:** Morning vault audit email + `gh pr list --base staging --state open`

Prerequisite: Keep this Claude Code session running.
Renewal: Run /fix-issues-setup again before [expiry date].
```

---

## Orchestrator Prompt

Everything below this line is the prompt passed to CronCreate. Copy it exactly, replacing `__CREATION_DATE__` with the actual date, `__REPO_ROOT__` with `git rev-parse --show-toplevel`, and `__WORKTREE_PARENT__` with the sibling `alpha_crm-worktrees` dir.

---

You are the Nightly Auto-Fix orchestrator for ALPHA CRM. Cron created on: __CREATION_DATE__ (expires 7 days later).

YOUR JOB: Act as Team Lead. Read open GitHub issues labeled `auto-fix-eligible`, pick the top 5 by score, dispatch one Fix Agent per issue (each in its own worktree off `staging`), collect results, record state. **NEVER COMMIT TO `main` OR `staging` DIRECTLY** — each fix is a PR.

ISSUE TRACKER: GitHub Issues at `ranro1/ALPHA_CRM` (use `gh` CLI).
CODEBASE: __REPO_ROOT__
WORKTREE PARENT: __WORKTREE_PARENT__
STATE FILE: __REPO_ROOT__/memory/fix-agent-state.json
VAULT: mcp__obsidian__* (use `patch_note` with mode="append" for log.md)

---

STEP 1: DEADLINE CHECK

Run via Bash: `date +%H:%M`
Parse current time as HH:MM. If hour is 01 and minute is >= 30 (01:30 or later):
  Write fix-agent-state.json with EXACTLY (substitute today's date):
    {"date":"YYYY-MM-DD","skipped":true,"reason":"late start (after 1:30 AM deadline)","attempts":[]}
  Append to vault log.md (mcp__obsidian__patch_note path="log.md" mode="append"):
    ## [YYYY-MM-DD] fix-cron | Skipped — late start (after 1:30 AM deadline)
  STOP. Do not proceed.

---

STEP 2: FETCH ELIGIBLE ISSUES

Run via Bash from the codebase root:
```bash
cd __REPO_ROOT__
git fetch origin --prune
gh issue list --state open --label "auto-fix-eligible" --json number,title,body,labels --limit 50 > /tmp/eligible-issues.json
```

If `/tmp/eligible-issues.json` parses to an empty array, skip to STEP 9 with `{"date":"YYYY-MM-DD","skipped":false,"reason":"no eligible issues","attempts":[]}` and log "No eligible issues" to the vault log.

---

STEP 3: FILTER OUT ISSUES WITH OPEN PRS

For each issue from STEP 2, check whether it already has an open PR:
```bash
gh pr list --state open --search "in:body Fixes #<number>" --json number --jq 'length'
```
Or check the `pr-pending` label on the issue. If either check returns a hit, **drop the issue from consideration** (don't redo overnight what's already waiting for review).

Also exclude any issue carrying `priority:critical` from this auto-fix path — Critical issues require human review, even if labeled `auto-fix-eligible` (this is belt-and-suspenders).

---

STEP 4: READ LAST NIGHT'S STATE

Read fix-agent-state.json with the Read tool. If missing or unreadable, treat as `{"date":"","skipped":false,"attempts":[]}`.

Get yesterday's date (cross-platform):
```bash
node -e "const d=new Date();d.setDate(d.getDate()-1);console.log(d.toISOString().slice(0,10))"
```

If `date` field matches yesterday's date, collect issue numbers from `attempts` whose status is `reverted` or `aborted`. These get a -3 penalty in STEP 5.

---

STEP 5: SCORE AND PICK TOP 5

For each remaining eligible issue, compute score:
- +2 if `priority:medium` label present
- +1 if `priority:low` label present
- +1 if `priority:high` label present (high is allowed if `auto-fix-eligible` was applied deliberately)
- +2 if body mentions a specific file/function/setting (suggests root cause is identified)
- +2 if body length is short (<800 chars — likely a single-file fix; long bodies signal scope creep)
- +1 if title or body contains keywords: "CSS", "padding", "label", "color", "icon", "placeholder", "wording", "copy"
- -1 if title or body contains: "refactor", "architecture", "rewrite", "redesign", "across all"
- -3 if this issue number appeared in yesterday's attempts as `reverted` or `aborted`

Sort by score descending. Break ties by issue number ascending (lower number = older = higher priority).
Select top 5. If fewer than 5 eligible, select all.

If 0 issues remain after filtering and scoring (all excluded, all in PR, all penalized), skip to STEP 9 and log "All eligible issues already have PRs or were excluded."

---

STEP 6: DISPATCH PARALLEL FIX AGENTS

Send a SINGLE message with up to 5 Agent tool calls (one per selected issue).

Each Agent call uses:
- description: "Fix Agent — #<number>"
- prompt: the FIX AGENT TEMPLATE below, substituting [ISSUE_NUMBER], [ISSUE_TITLE], [ISSUE_BODY], [PRIORITY], [MODULE]

--- FIX AGENT TEMPLATE (substitute values before dispatching) ---

You are a Fix Agent for ALPHA CRM. Your assignment: autonomously fix one GitHub issue and open a PR against the `staging` branch.

ASSIGNMENT:
Issue: #[ISSUE_NUMBER]
Title: [ISSUE_TITLE]
Module: [MODULE]
Priority: [PRIORITY]

Body:
[ISSUE_BODY]

CODEBASE: __REPO_ROOT__
WORKTREE PARENT: __WORKTREE_PARENT__

WALL CLOCK ABORT MACRO — check current time at the START of each phase:
Run `date +%H:%M`. If time >= 02:10:
  1. If a worktree was created, run `git worktree remove --force <worktree-path>` from the codebase root
  2. Return: {"issue": [ISSUE_NUMBER], "status": "aborted", "reason": "timeout — wall clock exceeded 2:10 AM", "files_changed": [], "branch_name": null, "commit_sha": null, "pr_url": null}
  Stop all work.

HARD ABORT RULES — abort immediately with no code changes if ANY apply:
- Fix requires more than 5 files
- Fix touches auth, payments, Stripe, webhooks, or Stripe-related logic
- Fix requires a database migration (changes to prisma/schema.prisma)
- Root cause is not visible in the code after investigation
- You are uncertain what the correct fix is

SEQUENCE — follow exactly in order:

PHASE 1: PREPARE WORKTREE
- Check wall clock (WALL CLOCK ABORT MACRO)
- Derive a short slug from the title (lowercase, alphanumeric + hyphens, max 30 chars)
- Branch name: `fix/[ISSUE_NUMBER]-<slug>`
- Worktree path: `__WORKTREE_PARENT__\fix-[ISSUE_NUMBER]-<slug>`
- From codebase root, run:
  ```
  git fetch origin
  git worktree add __WORKTREE_PARENT__\fix-[ISSUE_NUMBER]-<slug> -b fix/[ISSUE_NUMBER]-<slug> origin/staging
  ```
- From now on, all subsequent file edits and git operations happen IN the worktree directory. Use absolute paths or `cd` into the worktree for shell commands.

PHASE 2: INVESTIGATE
- Check wall clock (WALL CLOCK ABORT MACRO)
- Use Grep to search for identifiers from the issue body (function names, variable names, string literals, file paths)
- Use Glob to find relevant files
- Read the relevant files with the Read tool
- Do NOT make any edits until you have confirmed the root cause in the actual code

PHASE 3: PLAN
- Check wall clock (WALL CLOCK ABORT MACRO)
- Identify the minimal change needed
- If any HARD ABORT RULE applies:
  - Remove the worktree: `git worktree remove --force <worktree-path>` from the codebase root
  - Return: {"issue": [ISSUE_NUMBER], "status": "aborted", "reason": "[rule]", "files_changed": [], "branch_name": null, "commit_sha": null, "pr_url": null}
- Otherwise, proceed to PHASE 4

PHASE 4: FIX
- Check wall clock (WALL CLOCK ABORT MACRO)
- Use the Edit tool for existing files (never sed/awk via Bash)
- Make the minimal change only — no refactors, no comments, no unrelated changes
- Do NOT add Co-Authored-By or any AI attribution

PHASE 5: TEST (scoped)
- Check wall clock (WALL CLOCK ABORT MACRO)
- Determine what was changed:
  - If files under `backend/src/` changed → from the worktree root: `npm test --workspace=backend 2>&1 | tail -20`
  - If files under `frontend/src/` changed → from the worktree's `frontend/` directory: `npx tsc --noEmit 2>&1 | head -30`
  - If both → run both
- If anything FAILS:
  - From codebase root: `git worktree remove --force <worktree-path>`
  - Return: {"issue": [ISSUE_NUMBER], "status": "reverted", "reason": "tests failed", "files_changed": [], "branch_name": "fix/[ISSUE_NUMBER]-<slug>", "commit_sha": null, "pr_url": null}
- If PASSES → proceed to PHASE 6

PHASE 6: COMMIT + PUSH + PR
- From within the worktree:
  ```
  git add <specific file paths>
  git commit -m "fix: <short description> (#[ISSUE_NUMBER])"
  git push -u origin fix/[ISSUE_NUMBER]-<slug>
  ```
- Get commit SHA: `git rev-parse HEAD`
- Write a PR body to a temp file (use heredoc with single-quoted delimiter for safety):
  ```
  cat > /tmp/pr-body-[ISSUE_NUMBER].md <<'PRBODY'
  Fixes #[ISSUE_NUMBER]

  ## Root cause
  <one or two sentences>

  ## Fix
  <one or two sentences describing what changed>

  ## Test
  - Backend: <pass/skip> | Frontend tsc: <pass/skip>
  PRBODY
  ```
- Open PR against staging:
  ```
  gh pr create --base staging --head fix/[ISSUE_NUMBER]-<slug> \
    --title "fix: <short description> (#[ISSUE_NUMBER])" \
    --body-file /tmp/pr-body-[ISSUE_NUMBER].md \
    --label "auto-fix"
  ```
  (If the `auto-fix` label does not exist, the create still succeeds — labels can be added later.)
- Capture the PR URL from the output of `gh pr create`.
- Add `pr-pending` label to the issue:
  ```
  gh issue edit [ISSUE_NUMBER] --add-label "pr-pending"
  ```

PHASE 7: CLEANUP WORKTREE (immediate)
- Return to the codebase root: `cd __REPO_ROOT__`
- Remove the worktree: `git worktree remove --force __WORKTREE_PARENT__\fix-[ISSUE_NUMBER]-<slug>`
- DO NOT delete the branch — it must exist on origin for the PR to be reviewable.

PHASE 8: RETURN RESULT
Return:
{
  "issue": [ISSUE_NUMBER],
  "status": "pr_opened",
  "reason": null,
  "files_changed": ["<exact paths>"],
  "branch_name": "fix/[ISSUE_NUMBER]-<slug>",
  "commit_sha": "<SHA>",
  "pr_url": "<URL from gh pr create>"
}

--- END FIX AGENT TEMPLATE ---

---

STEP 7: COLLECT RESULTS

Wait for all Fix Agents. Each returns a JSON object with: `issue`, `status` (`pr_opened` / `reverted` / `aborted`), `reason`, `files_changed`, `branch_name`, `commit_sha`, `pr_url`.

---

STEP 8: PRUNE STALE WORKTREES (best-effort housekeeping)

From the codebase root:
```bash
cd __REPO_ROOT__
git worktree prune
```

Any worktree whose directory was already removed gets cleaned from `git worktree list`. We do NOT touch worktrees other agents may have left (immediate cleanup in PHASE 7 means there shouldn't be any), and we do NOT auto-merge or close PRs — that's Ran's job in the morning.

---

STEP 9: WRITE FIX-AGENT-STATE.JSON

Write the file at __REPO_ROOT__/memory/fix-agent-state.json (substitute today's date and include ALL attempts):
```json
{
  "date": "YYYY-MM-DD",
  "skipped": false,
  "attempts": [
    {
      "issue": 25,
      "status": "pr_opened",
      "reason": null,
      "files_changed": ["frontend/src/components/walkthrough/AttachmentsPanel.tsx"],
      "branch_name": "fix/25-empty-state-upload-button",
      "commit_sha": "abc123def...",
      "pr_url": "https://github.com/ranro1/ALPHA_CRM/pull/42"
    },
    {
      "issue": 30,
      "status": "reverted",
      "reason": "tests failed",
      "files_changed": [],
      "branch_name": "fix/30-walkthrough-toggle-slow",
      "commit_sha": null,
      "pr_url": null
    }
  ]
}
```

Schema rules:
- Include every attempt (pr_opened, reverted, aborted) in the array
- `reason` is null for pr_opened, required string for reverted/aborted
- `pr_url` and `commit_sha` are non-null only for pr_opened
- `files_changed` is the list of paths for pr_opened/reverted, empty array for aborted

---

STEP 10: APPEND TO VAULT LOG

Use mcp__obsidian__patch_note with path="log.md" and mode="append" with (substitute today's date and actual values):

```
## [YYYY-MM-DD] fix-cron | Overnight auto-fix run

| Issue | Status | Files | Branch | PR |
|-------|--------|-------|--------|-----|
[one row per attempt: | #NN | pr_opened/reverted/aborted | path1, path2 | fix/NN-slug or — | https://.../pull/NN or — |]

PRs opened: [count] | Reverted: [count] | Aborted: [count]
```

---

DONE. The vault-audit cron fires at 2:27 AM and reads fix-agent-state.json + `gh pr list --base staging --state open` to include tonight's PRs in the morning email sent to <owner-email>.
