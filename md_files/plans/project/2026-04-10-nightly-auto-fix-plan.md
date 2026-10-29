# Nightly Auto-Fix Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a nightly cron that autonomously fixes medium/low known issues before the vault audit runs, recording results so they appear in the morning email.

**Architecture:** A `/fix-issues-setup` skill creates a durable cron at 1:00 AM ET. A Team Lead agent scores open medium/low issues, picks top 5, and dispatches 5 parallel Fix Agents. Each Fix Agent investigates, edits code, runs scoped tests, and commits or reverts. The Team Lead records results. The existing vault audit at 2:27 AM reads the updated files and includes overnight fixes in the morning email.

**Tech Stack:** Claude Code CronCreate tool, Bash for git/test commands, Edit/Write for code changes, mcp__obsidian__ for vault log, existing known-issues.md / fixed-issues.md memory files.

**Design spec:** `md_files/plans/project/2026-04-10-nightly-auto-fix-design.md`

---

## File Map

| File | Action |
|------|--------|
| `.claude/skills/log-issue/SKILL.md` | Modify — fix FIXED procedure |
| `.claude/skills/vault-audit-setup/SKILL.md` | Modify — Agent 5 PART C + Report Compiler patch |
| `.claude/skills/fix-issues-setup/SKILL.md` | Create — new nightly auto-fix skill |
| `CLAUDE.md` | Modify — document new skill + fix-agent-state.json |
| `memory/codebase.md` | Modify — add new skill reference (`C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\codebase.md`) |

---

## Task 1: Fix log-issue skill — FIXED action moves KI to fixed-issues.md

**Files:**
- Modify: `.claude/skills/log-issue/SKILL.md` (Steps 6 and 9)

**Context:** Currently the FIXED action patches the KI entry in `known-issues.md` with `Status: Fixed` in-place. But `known-issues.md` is supposed to hold open/in-progress issues only. Fixed entries must be moved to `fixed-issues.md`. This matters for the auto-fix cron — the Team Lead reads `known-issues.md` expecting only open issues.

- [ ] **Step 1.1: Read the current log-issue skill**

```
Read: .claude/skills/log-issue/SKILL.md
```

Confirm Steps 6 and 9 match the text below before editing.

- [ ] **Step 1.2: Replace Step 6 (FIXED procedure) with the move-and-archive approach**

Find this block in the file (Step 6):
```
### Step 6 — Update KI Entry (for FIXED or UPDATE)
Patch the existing entry in `known-issues.md`:

For FIXED:
```
**KI-XXX** | [Module] | Status: Fixed | Priority: [same]
[Original description — unchanged]
Fixed: [one sentence describing what the fix was and when]
```

For UPDATE — add a line below the existing description:
```
Update [date]: [new information]
```
```

Replace with:
```markdown
### Step 6 — Update KI Entry (for FIXED or UPDATE)

**For FIXED — move to fixed-issues.md:**

1. Read `memory/fixed-issues.md`
2. Append the resolved KI to the correct priority section in `fixed-issues.md`:
   ```
   **KI-XXX** | [Module] | Fixed: YYYY-MM-DD
   [Original one-line description from known-issues.md]
   **Root cause:** [one sentence: what caused it and how it was fixed]
   **Vault:** [[NoteTitle]] (if a Learnings/ or Decisions/ note was created; omit if not)
   ```
3. Remove the entire KI entry block from `known-issues.md` (the bold header line + all description lines up to the next blank line before the next KI)
4. Recount and update the summary tables in both files (Step 8 handles this)

**For UPDATE — patch in known-issues.md:**
Add a line below the existing description:
```
Update [date]: [new information]
```
```

- [ ] **Step 1.3: Update Step 9 output to reflect the move**

Find in Step 9:
```
**Files written:** known-issues.md, pipeline-status.md
```

Replace with:
```
**Files written:** known-issues.md (KI removed), fixed-issues.md (KI appended), pipeline-status.md
```

- [ ] **Step 1.4: Commit**

```bash
git add .claude/skills/log-issue/SKILL.md
git commit -m "fix: log-issue FIXED action now moves KI to fixed-issues.md per Rule 11"
```

---

## Task 2: Patch vault-audit-setup — Agent 5 PART C + Report Compiler overnight section

**Files:**
- Modify: `.claude/skills/vault-audit-setup/SKILL.md`

**Context:** Agent 5 currently only covers PARTS A and B (Known Issues digest + Pipeline Coverage). PART C is a new addition that reads today's auto-fixes. The Report Compiler currently shows an open-issues dashboard — we need to add an "overnight fixes" sub-section above it.

- [ ] **Step 2.1: Read the current vault-audit-setup skill**

```
Read: .claude/skills/vault-audit-setup/SKILL.md
```

Locate:
1. The end of Agent 5's prompt — look for `=== PIPELINE SUMMARY ===` output block
2. The Report Compiler's Known Issues Dashboard section — look for `- **Known Issues Dashboard**`

- [ ] **Step 2.2: Add PART C to Agent 5's prompt**

Find the closing of Agent 5's output format (just before the closing of the Agent 5 prompt block):
```
  === PIPELINE SUMMARY ===
  Stages scanned: [count]
  Stages with full coverage (controller + route + tests): [count]
  Stages with no test coverage: [list]
```

Append immediately after that block (still inside the Agent 5 prompt):
```
  PART C — OVERNIGHT AUTO-FIXES

  STEP C1 — READ AUTO-FIX RECORDS:
  Read the file at C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\fixed-issues.md using the Read tool.
  Filter for lines containing "(auto-fix)" AND today's date (YYYY-MM-DD format).
  For each matching entry, extract: KI number, module, commit SHA (if present), root cause line.

  STEP C2 — READ FIX ATTEMPT STATE:
  Read the file at C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\fix-agent-state.json using the Read tool.
  If the file does not exist, treat as no attempts.
  From the attempts array, collect all entries where status is "reverted" or "aborted".
  If skipped is true, note that the cron was skipped (late start).

  OUTPUT FORMAT (use these exact section headers — the Report Compiler parses them):
  === OVERNIGHT AUTO-FIXES ===
  [list each committed fix: KI-XXX | Module | Commit: <sha> | <root cause one-line>]
  [If none: write "None."]
  === OVERNIGHT FIX ATTEMPTS (non-committed) ===
  [list each: KI-XXX | Status: reverted/aborted | Reason: <reason>]
  [If skipped: write "Skipped — late start (cron fired after 1:30 AM deadline)."]
  [If none and not skipped: write "None."]
```

- [ ] **Step 2.3: Add overnight fixes sub-section to Report Compiler**

Find the Known Issues Dashboard section in the Report Compiler prompt:
```
   - **Known Issues Dashboard** (placed IMMEDIATELY after Summary, before other findings):
     - Show all open Critical issues with red styling (KI number, module, description)
     - Show all open High issues with amber styling
```

Insert before "Show all open Critical issues":
```
     - **Overnight Auto-Fixes sub-section** (render first, above Critical issues):
       Parse the Agent 5 output for `=== OVERNIGHT AUTO-FIXES ===` and `=== OVERNIGHT FIX ATTEMPTS (non-committed) ===` sections.
       If OVERNIGHT AUTO-FIXES has entries beyond "None.":
         Render in green: "🤖 Fixed overnight (N): KI-XXX, KI-YYY, KI-ZZZ — commit SHAs"
       If OVERNIGHT FIX ATTEMPTS has entries beyond "None.":
         Render in amber: "⚠️ Attempted but not committed (M): KI-ZZZ — reason"
       If both are "None." and cron was not skipped: render in grey: "No auto-fixes ran tonight."
       If cron was skipped: render in amber: "⚠️ Auto-fix cron skipped — late start."
       Always render this sub-section even if empty — it confirms the cron ran.
```

- [ ] **Step 2.4: Commit**

```bash
git add .claude/skills/vault-audit-setup/SKILL.md
git commit -m "feat: add Agent 5 PART C and Report Compiler overnight fixes section to vault audit"
```

---

## Task 3: Create /fix-issues-setup skill

**Files:**
- Create: `.claude/skills/fix-issues-setup/SKILL.md`

**Context:** This is the main deliverable. The skill creates a durable cron at `0 1 * * *`. The cron prompt contains the full Team Lead orchestrator and Fix Agent template. Pattern mirrors `/vault-audit-setup` exactly.

- [ ] **Step 3.1: Create the skill directory and file**

Create `.claude/skills/fix-issues-setup/SKILL.md` with the full content below. Read the design spec first (`md_files/plans/project/2026-04-10-nightly-auto-fix-design.md`) to confirm all values are consistent.

Full file content:

```markdown
---
name: fix-issues-setup
description: "Set up the nightly auto-fix cron job. Creates a durable cron at 1:00 AM ET that picks the top 5 medium/low known issues, fixes them autonomously, and records results for the vault audit morning email. Run once per week to renew (auto-expires after 7 days)."
user_invocable: true
---

# Fix Issues Setup

## Purpose
Create (or renew) the nightly auto-fix cron job. The job fires at 1:00 AM ET (87 minutes before the vault audit), spawns a Team Lead agent that picks and fixes the top 5 medium/low known issues, and records results so the morning vault audit email includes overnight fixes.

## Prerequisites
- Claude Code session must be **running** for the cron to fire
- Obsidian MCP server must be connected (`mcp__obsidian__*` tools)
- Both `memory/known-issues.md` and `memory/fixed-issues.md` must exist

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
- **prompt:** Use the EXACT orchestrator prompt below, replacing every instance of `__CREATION_DATE__` with today's actual date (YYYY-MM-DD format).

### 4. Confirm
Output:
```
## Auto-Fix Cron Active

**Schedule:** Every night at 1:00 AM ET (87 min before vault audit)
**Created:** [CREATION_DATE]
**Expires:** [CREATION_DATE + 7 days]
**Fixes:** Top 5 medium/low known issues per night
**Results visible in:** Morning vault audit email

Prerequisite: Keep this Claude Code session running.
Renewal: Run /fix-issues-setup again before [expiry date].
```

---

## Orchestrator Prompt

Everything below this line is the prompt passed to CronCreate. Copy it exactly, replacing `__CREATION_DATE__` with the actual date.

---

You are the Nightly Auto-Fix orchestrator for ALPHA CRM. Cron created on: __CREATION_DATE__ (expires 7 days later).

YOUR JOB: Act as Team Lead. Read known issues, pick the top 5 medium/low issues, dispatch 5 parallel Fix Agents, collect results, and record everything. Commits go directly to main. If tests fail, changes are reverted.

KNOWLEDGE BASE: C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\
CODEBASE: C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm
VAULT: mcp__obsidian__* MCP tools (write_note with mode append for log.md)

STEP 1: DEADLINE CHECK

Run via Bash: `date +%H:%M`
Parse the current time as HH:MM.
If the hour is 1 and the minute is >= 30 (i.e., time is 01:30 or later):
  - Use the Write tool to write the file at C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\fix-agent-state.json with EXACTLY this content (substitute today's date):
    {"date":"YYYY-MM-DD","skipped":true,"attempts":[]}
  - Use mcp__obsidian__patch_note with path="log.md" and mode="append":
    "## [TODAY] fix-cron | Skipped — late start (after 1:30 AM deadline)\n"
  - STOP. Do not dispatch any Fix Agents.

STEP 2: READ KNOWN ISSUES

Read [KNOWLEDGE BASE]/known-issues.md using the Read tool.
Extract ALL open issues (Status: Open or In-Progress).
Filter to ONLY medium and low priority issues.
Exclude any issue whose description contains "needs your attention".
Exclude any issue related to: auth, payments, Stripe, webhooks, database migration.

STEP 3: READ LAST NIGHT'S STATE

Read [KNOWLEDGE BASE]/fix-agent-state.json using the Read tool.
If the file does not exist or cannot be read: treat as {"date":"","skipped":false,"attempts":[]}.
Extract the attempts array. Any entry with status "reverted" or "aborted" from YESTERDAY gets a -3 penalty.
Compare the date field — only apply penalties if date matches yesterday's date.

STEP 4: SCORE AND PICK TOP 5

For each medium/low open issue, compute a score:
  +2 if priority is Medium
  +1 if priority is Low
  +2 if the description suggests a single-file fix (CSS, form field, one controller, email sender address)
  +1 if the description suggests multi-file but same module
  +2 if the root cause is clearly described (specific file or field mentioned)
  -1 if the root cause is vague ("visual fixes", "needs review", "to be specified")
  -3 if this KI was attempted and reverted or aborted last night (from state file)

Sort by score descending. Break ties by KI number ascending (lower = older = higher priority).
Select the top 5 (or fewer if fewer than 5 medium/low issues exist).

STEP 5: DISPATCH 5 PARALLEL FIX AGENTS

Send a SINGLE message with up to 5 Agent tool calls (one per selected issue).
Each agent receives the prompt template below, filled with the specific KI details.

For each selected issue, create an Agent call:
- description: "Fix Agent — [KI-XXX]"
- prompt: [use the FIX AGENT TEMPLATE below, substituting KI_NUMBER, KI_MODULE, KI_PRIORITY, KI_DESCRIPTION]

--- FIX AGENT TEMPLATE ---

You are a Fix Agent for ALPHA CRM. Your assignment: fix one known issue autonomously.

ASSIGNMENT:
KI Number: [KI_NUMBER]
Module: [KI_MODULE]
Priority: [KI_PRIORITY]
Description: [KI_DESCRIPTION]

CODEBASE: C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm
KNOWLEDGE BASE: C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\

TIME BUDGET: You have 60 minutes from now OR must finish before 2:10 AM wall clock (run `date +%H:%M` to check), whichever comes first. If you cannot complete within budget, abort with reason "timeout" and make no code changes.

HARD ABORT RULES — abort immediately with no code changes if:
- Fix requires more than 5 files
- Fix touches auth, authentication, payments, Stripe, webhooks, or stripe-related logic
- Fix requires a database migration (changes to prisma/schema.prisma)
- Root cause is not visible in the code after investigation
- You are uncertain what the correct fix is

WALL CLOCK ABORT MACRO — run `date +%H:%M` at the START of each phase below.
If time >= 02:10, immediately:
  1. If you have made any code changes: `git checkout -- <all changed files>`
  2. Return: {"ki":"[KI_NUMBER]","status":"aborted","reason":"timeout — wall clock exceeded 2:10 AM","files_changed":[],"commit_sha":null}
  Stop all work.

SEQUENCE — follow exactly in order:

PHASE 1: INVESTIGATE
- Check wall clock (see WALL CLOCK ABORT MACRO above)
- Read the KI description carefully
- Use Grep to search for relevant identifiers (function names, variable names, strings from the description)
- Use Glob to find relevant files (e.g., frontend/src/pages/*.tsx, backend/src/controllers/*.ts)
- Read the relevant files using the Read tool
- Do NOT make any edits until you have confirmed the root cause in the actual code

PHASE 2: PLAN
- Check wall clock (see WALL CLOCK ABORT MACRO above)
- Identify the minimal change needed (simplest solution that works)
- If any hard abort rule applies → return result immediately, no edits
- If root cause confirmed → proceed to Phase 3

PHASE 3: FIX
- Check wall clock (see WALL CLOCK ABORT MACRO above)
- Use Edit tool for existing files (never sed/awk)
- Use Write tool only if creating a new file is truly necessary
- Make the minimal change only — no refactoring, no added comments, no unrelated changes
- Do not add Co-Authored-By or any AI attribution anywhere

PHASE 4: TEST (scoped)
Determine what you changed:
- If you changed files under backend/src/ → run from repo root:
  `npm test --workspace=backend 2>&1 | tail -20`
  Check for PASS/FAIL. Any test failure = revert.
- If you changed files under frontend/src/ → run from frontend/ directory:
  `npx tsc --noEmit 2>&1 | head -30`
  Check for errors. Any TypeScript error = revert.
- If you changed both → run both checks.

If tests/typecheck FAIL:
  Revert ALL changed files: `git checkout -- <each changed file>`
  Return: {"ki":"[KI_NUMBER]","status":"reverted","reason":"tests failed","files_changed":[],"commit_sha":null}

If tests/typecheck PASS → proceed to Phase 5.

PHASE 5: COMMIT
Stage only the specific files you changed:
  `git add <specific file paths>`
Commit with conventional format — NO Co-Authored-By lines:
  `git commit -m "fix: [one-line description of fix] ([KI_NUMBER])"`

Get the commit SHA:
  `git rev-parse HEAD`

Return:
{
  "ki": "[KI_NUMBER]",
  "status": "committed",
  "reason": null,
  "files_changed": ["<list of files changed>"],
  "commit_sha": "<sha from git rev-parse HEAD>"
}

--- END FIX AGENT TEMPLATE ---

STEP 6: COLLECT RESULTS

Wait for all Fix Agents to return. Each returns a JSON result with: ki, status (committed/reverted/aborted), reason, files_changed, commit_sha.

Separate results into three groups:
- committed: fix was applied and committed
- reverted: fix was attempted but tests failed, code reverted
- aborted: fix was not attempted (hard abort rule triggered)

STEP 7: UPDATE KNOWN-ISSUES.MD

For each "committed" KI:
  Read C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\known-issues.md.
  Find the full entry block for that KI (bold header line + all description lines until the next blank line before another KI or section header).
  Remove that entire block from known-issues.md.
  Update the summary table at the BOTTOM of the file. It looks like this:
    | Priority | Open |
    |----------|------|
    | Critical | N |
    | High | N |
    | Medium | N |
    | Low | N |
    | **Total** | **N** |
  Recount each row by counting remaining open entries in each priority section. Update the numbers.
  Write the updated file.

STEP 8: UPDATE FIXED-ISSUES.MD

For each "committed" KI:
  Read [KNOWLEDGE BASE]/fixed-issues.md.
  Find the correct priority section (## Critical, ## High, ## Medium, ## Low) matching that KI's priority.
  Append the following entry in that section:

  **[KI_NUMBER]** | [KI_MODULE] | Fixed: [TODAY] (auto-fix) | Commit: [commit_sha]
  [Original KI description]
  **Root cause:** [one sentence summarizing what the code change fixed]

  Write the updated file.

STEP 9: WRITE FIX-AGENT-STATE.JSON

Write [KNOWLEDGE BASE]/fix-agent-state.json with:
{
  "date": "[TODAY]",
  "skipped": false,
  "attempts": [
    {
      "ki": "KI-XXX",
      "status": "committed|reverted|aborted",
      "reason": "...",
      "files_changed": ["..."],
      "commit_sha": "abc123"
    }
  ]
}

Include ALL 5 attempts (committed, reverted, and aborted). Use null for reason/commit_sha when not applicable.

STEP 10: APPEND TO VAULT LOG

Use mcp__obsidian__patch_note with path="log.md" and mode="append":

## [TODAY] fix-cron | Overnight auto-fix run

| KI | Status | Files | Commit |
|----|--------|-------|--------|
[one row per attempt: | KI-XXX | committed/reverted/aborted | file1.ts, file2.tsx | sha or "—" |]

Committed: [count] | Reverted: [count] | Aborted: [count]

DONE. The vault audit cron at 2:27 AM will read the updated known-issues.md and fixed-issues.md and include tonight's fixes in the morning email.
```

- [ ] **Step 3.2: Verify the file was created correctly**

Read `.claude/skills/fix-issues-setup/SKILL.md` and confirm:
- Frontmatter has `name`, `description`, `user_invocable: true`
- Cron expression is `0 1 * * *`
- STEP 1 deadline check references 01:30
- STEP 4 scoring matches the design spec
- STEP 5 Fix Agent template has all 5 phases
- STEP 7-10 recording steps all present

- [ ] **Step 3.3: Commit**

```bash
git add .claude/skills/fix-issues-setup/SKILL.md
git commit -m "feat: add /fix-issues-setup skill for nightly autonomous issue fixes"
```

---

## Task 4: Update CLAUDE.md and memory/codebase.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `memory/codebase.md` (at `C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\codebase.md`)

- [ ] **Step 4.1: Read CLAUDE.md**

```
Read: CLAUDE.md
```

Find the section listing skills under the Directory Structure. It currently lists `vault-audit-setup/` and other skills.

- [ ] **Step 4.2: Add fix-issues-setup to CLAUDE.md directory structure**

In the Directory Structure section, find the `.claude/skills/` area (look for `vault-audit-setup`). Add:
```
│   ├── fix-issues-setup/SKILL.md  # Nightly auto-fix cron: top-5 medium/low issue fixer, commits to main, records to fixed-issues.md
```

Also find the memory files section and add:
```
│   └── fix-agent-state.json       # Nightly auto-fix attempt log (date, KI status, commit SHAs) — managed by cron
```

- [ ] **Step 4.3: Read memory/codebase.md**

```
Read: C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\codebase.md
```

Find the Project Skills section under `## Project Skills`.

- [ ] **Step 4.4: Add fix-issues-setup to codebase.md**

Under `### Project-specific` skills, add:
```
- `fix-issues-setup/` — Nightly auto-fix cron: scores medium/low KIs, dispatches 5 parallel Fix Agents, commits to main, records in fixed-issues.md + fix-agent-state.json
```

Also update the `### Key Dependencies` or relevant section to note `fix-agent-state.json` as a new memory file:
```
- `memory/fix-agent-state.json` — Nightly auto-fix attempt log: last night's KI attempts with status (committed/reverted/aborted), reasons, and commit SHAs. Created on first cron run.
```

- [ ] **Step 4.5: Commit**

```bash
git add CLAUDE.md
git add "C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\codebase.md"
git commit -m "docs: document fix-issues-setup skill and fix-agent-state.json memory file"
```

---

## Final Verification Checklist

After all 4 tasks:

- [ ] `log-issue` FIXED procedure moves KI to `fixed-issues.md` and removes from `known-issues.md`
- [ ] `vault-audit-setup` Agent 5 has PART C with `=== OVERNIGHT AUTO-FIXES ===` and `=== OVERNIGHT FIX ATTEMPTS (non-committed) ===` output sections
- [ ] `vault-audit-setup` Report Compiler renders overnight fixes sub-section above Critical issues
- [ ] `fix-issues-setup/SKILL.md` exists with durable cron `0 1 * * *`, full Team Lead + Fix Agent prompts
- [ ] `CLAUDE.md` mentions `fix-issues-setup/` and `fix-agent-state.json`
- [ ] `memory/codebase.md` mentions `fix-issues-setup/` and `fix-agent-state.json`

Run `/fix-issues-setup` to create the first cron instance and confirm it registers successfully.
