# Nightly Auto-Fix Cron — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Skill to build:** `/fix-issues-setup`

---

## Overview

A new nightly cron job fires at **1:00 AM ET**, 87 minutes before the existing vault audit (2:27 AM ET). A Team Lead agent reads `known-issues.md`, scores all open medium/low issues, picks the top 5 most important + fixable, and dispatches 5 parallel Fix Agents. Each Fix Agent independently investigates, codes, tests, and commits (or reverts). The Team Lead then records results. When the vault audit runs at 2:27 AM, it reads the updated `known-issues.md` and `fixed-issues.md` — overnight fixes appear automatically in the morning email.

**One email. Everything in it. No new infrastructure beyond the cron.**

---

## Architecture

```
1:00 AM  →  Fix Cron (new — /fix-issues-setup)
               Team Lead Agent
               ├── reads known-issues.md
               ├── scores + picks top 5 medium/low issues
               └── spawns 5 parallel Fix Agents
                       ├── Fix Agent 1
                       ├── Fix Agent 2
                       ├── Fix Agent 3
                       ├── Fix Agent 4
                       └── Fix Agent 5
               Team Lead collects results
               → updates known-issues.md
               → updates fixed-issues.md
               → writes fix-agent-state.json
               → appends to vault log.md

2:27 AM  →  Vault Audit Cron (existing, no changes to agents 1-4)
               Agent 5 reads updated known-issues.md + fixed-issues.md
               Report Compiler highlights overnight auto-fixes
               → single morning email with everything
```

---

## Skill: `/fix-issues-setup`

Same pattern as `/vault-audit-setup`:
- Check for existing fix cron (CronList)
- Create durable cron: `0 1 * * *`
- Auto-expires after 7 days
- Renewal: run `/fix-issues-setup` again

**Prerequisites:** Same as vault audit — Claude Code session must be running, Resend MCP connected.

---

## Team Lead Agent

### Inputs
- `memory/known-issues.md` — all open issues
- `memory/fix-agent-state.json` — last night's attempt log (created by this agent; **if file does not exist, treat as empty — no penalties applied on first run**)

### Deadline Check
Before dispatching any Fix Agents, the Team Lead checks the current time:
- **Before 1:30 AM** → proceed normally, dispatch all 5
- **After 1:30 AM** → skip dispatch entirely, write `fix-agent-state.json` with `{ "date": "...", "skipped": true, "reason": "late start" }`, append "skipped — late start" to vault log, exit

This protects the 2:27 AM vault audit window regardless of cron cold-start delays.

### Scoring Model

Each open medium/low issue is scored:

| Factor | Points |
|--------|--------|
| Priority: Medium | +2 |
| Priority: Low | +1 |
| Single file likely (CSS, form field, one controller) | +2 |
| Multi-file but same module | +1 |
| Root cause clearly described in KI | +2 |
| Root cause vague ("needs review", "visual fixes") | −1 |
| Attempted and reverted last night | −3 |

Top 5 by score are selected. Ties broken by KI number (lower = older = higher priority).

**Hard exclusions from selection (never attempted autonomously):**
- Any issue touching auth, payments, Stripe, or webhooks
- Any issue requiring a database migration
- Any issue with "needs your attention" flag in the description

### Outputs
- 5 assigned issues sent to parallel Fix Agents
- After collection: updated memory files + vault log entry

---

## Fix Agent

Each agent receives one KI assignment and follows this exact sequence:

### 1. Investigate
- Read the KI description
- Use Grep/Glob to locate relevant files
- Read the files — no editing until root cause is confirmed in code

### 2. Plan
- Identify minimal change (Rule 4: simplest solution that works)
- **Abort immediately if any of:**
  - Fix requires more than 5 files
  - Fix touches auth / payments / Stripe / webhook logic
  - Fix requires a database migration
  - Root cause not visible in code after investigation
- Abort returns: `{ status: "aborted", reason: "..." }`

**Per-agent time budget:** Each Fix Agent has a maximum of **60 minutes from dispatch time** OR must complete before **2:10 AM wall clock** (17-minute buffer before vault audit), whichever comes first. If the agent cannot complete within that window, it aborts with `{ status: "aborted", reason: "timeout" }` and makes no code changes. The 2:10 AM wall-clock limit ensures the Team Lead always has time to finish recording before the vault audit fires at 2:27 AM.

### 3. Fix
- Edit using Edit/Write tools only
- No refactoring, no added comments, no unrelated changes

### 4. Test (scoped)
| Files touched | Test command |
|---------------|-------------|
| `backend/src/**` only | `npm test --workspace=backend` (from repo root) |
| `frontend/src/**` only | `npx tsc --noEmit` (from `frontend/`) |
| Both | Both commands |

- Tests pass → proceed to commit
- Tests fail → `git checkout -- <changed files>` then return `{ status: "reverted", reason: "tests failed" }`

### 5. Commit or Revert
- **Commit:** `git add <specific files>` + conventional commit referencing KI
  - Format: `fix: <description> (KI-XXX)`
  - Example: `fix: last name field shows first name on new lead form (KI-007)`
  - NO Co-Authored-By lines (per CLAUDE.md Rule 8)
- **Revert:** already done in step 4

### 6. Return Result
```json
{
  "ki": "KI-007",
  "status": "committed" | "reverted" | "aborted",
  "reason": "...",
  "files_changed": ["frontend/src/pages/LeadFormPage.tsx"],
  "commit_sha": "abc123"
}
```

---

## Recording & Integration

### After all 5 agents return, Team Lead:

**1. Update `memory/known-issues.md`**
- Remove entries for all `committed` KIs (they are fixed)

**2. Update `memory/fixed-issues.md`**
- Append one entry per committed fix:
  ```
  **KI-XXX** | Module | Fixed: YYYY-MM-DD (auto-fix) | Commit: <sha>
  Root cause: <one-line summary>
  ```

**3. Write `memory/fix-agent-state.json`**

Full schema (all fields):
```json
{
  "date": "2026-04-11",
  "skipped": false,
  "attempts": [
    {
      "ki": "KI-007",
      "status": "committed" | "reverted" | "aborted",
      "reason": "tests failed",
      "files_changed": ["frontend/src/pages/LeadFormPage.tsx"],
      "commit_sha": "abc123"
    }
  ]
}
```
- `skipped: true` + empty `attempts: []` when Team Lead exits early (late start)
- `reason` only required when status is `reverted` or `aborted`
- `commit_sha` only required when status is `committed`
- All four consumers (Team Lead read, Fix Agent write, Agent 5 PART C, Report Compiler) use this exact schema

**4. Append to vault `log.md`**
```
## [YYYY-MM-DD] fix-cron | Overnight auto-fix run
| KI | Status | Files | Commit |
|----|--------|-------|--------|
| KI-011 | committed | email.ts | a1b2c3 |
| KI-007 | reverted | LeadFormPage.tsx | — (tests failed) |
```

---

## Vault Audit Integration (minimal change)

**Agent 5 patch (Pipeline & Known Issues Agent):** Add a new step to Agent 5's prompt after PART B:

```
PART C — OVERNIGHT AUTO-FIXES
Read the file at [KNOWLEDGE BASE]/fixed-issues.md using the Read tool.
Filter for entries containing today's date in format "(auto-fix)" on a line dated YYYY-MM-DD.
For each such entry, extract: KI number, module, commit SHA, root cause.

Read the file at [KNOWLEDGE BASE]/fix-agent-state.json using the Read tool (if it exists; skip if not found).
From the attempts array, collect all entries where status is "reverted" or "aborted".

OUTPUT FORMAT (use these exact delimiters — the Report Compiler parses them):
=== OVERNIGHT AUTO-FIXES ===
[list each committed fix: KI-XXX | Module | Commit: <sha> | Root cause: <one-line>]
If none: write "None."
=== OVERNIGHT FIX ATTEMPTS (non-committed) ===
[list each reverted/aborted attempt: KI-XXX | Status | Reason]
If none: write "None."
```

**Report Compiler patch:** Agent 5's output now includes the `=== OVERNIGHT AUTO-FIXES ===` section. The Report Compiler receives it and adds a sub-section to the Known Issues Dashboard:

```
🤖 Fixed overnight (N): KI-XXX, KI-YYY  [green styling]
⚠️  Attempted but not committed (M): KI-ZZZ — reason  [amber styling]
```

Placed immediately above the "Open High" issues. If all 5 agents aborted, this section explains why (abort reasons visible in morning email — no silent failure).

**Files affected in vault audit skill:** Agent 5 prompt (PART C addition) + Report Compiler prompt (Known Issues Dashboard section).

---

## Files Created/Modified

| File | Action |
|------|--------|
| `.claude/skills/fix-issues-setup/SKILL.md` | New skill |
| `memory/fix-agent-state.json` | Created at first run, updated nightly |
| `memory/known-issues.md` | Modified (fixed KIs removed) |
| `memory/fixed-issues.md` | Modified (fixed KIs appended) |
| `vault log.md` | Appended nightly |
| `.claude/skills/vault-audit-setup/SKILL.md` | Small addition to Report Compiler prompt only |

---

## Timing

| Time | Event |
|------|-------|
| 1:00 AM ET | Fix cron fires — Team Lead starts |
| 1:02 AM | 5 parallel Fix Agents dispatched |
| 1:02–2:00 AM | Fix Agents work (up to 58 min window) |
| ~2:00 AM | Team Lead records results |
| 2:27 AM | Vault audit fires — sees updated files |
| ~3:00 AM | Morning email arrives |

---

## Safety Boundaries

The auto-fix system will **never** autonomously:
- Touch auth, payments, Stripe, or webhook code
- Run database migrations
- Push to remote (commits are local only — but since main is local-only in this setup, this is fine)
- Fix Critical or High priority issues (Team Lead filters these out before scoring)
- Retry a fix that was reverted last night (−3 penalty effectively eliminates it)

---

## Morning Routine

1. Open email — single vault audit email from `vault@alphasecurityus.com`
2. "Fixed overnight" section shows what was auto-fixed with commit SHAs
3. Remaining open issues show what still needs your attention
4. Review commits with `git log --oneline` if you want to inspect specific changes
5. `git revert <sha>` to undo any fix you disagree with
