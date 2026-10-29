# Nightly Vault Audit — Design Spec

> Multi-agent system that audits the Obsidian vault against the codebase every night and sends a detailed email report.

## Overview

A local cron job fires at 2:27 AM ET nightly. An orchestrator spawns 4 parallel audit agents, each with a focused mandate. A 5th agent compiles their findings into an HTML email sent to `ran@alphasecurityus.com`. Report-only — no auto-fixes.

## Architecture

```
CronCreate (durable, 2:27 AM ET nightly)
  │
  ▼
Orchestrator (cron prompt)
  │
  ├─ Agent 1: Vault Health Inspector ──────┐
  ├─ Agent 2: Code-to-Vault Sync Checker ──┤  parallel
  ├─ Agent 3: Status & Accuracy Auditor ───┤
  ├─ Agent 4: Knowledge Gap Finder ────────┘
  │
  ▼ (collect all 4 results)
  │
  └─ Agent 5: Report Compiler → formats + sends email via Resend
```

## Agent Definitions

### Agent 1: Vault Health Inspector

**Mission:** Structural integrity of the vault.

**Checks:**
1. **Orphan notes** — Notes with zero inbound wikilinks from other notes
2. **Broken wikilinks** — `[[X]]` references where X doesn't exist as a note
3. **Missing frontmatter** — Notes missing required fields: `type`, `created`
4. **Stale dates** — Notes where `updated` field is >14 days old
5. **Empty sections** — Module notes with empty or placeholder "Current State"
6. **Frontmatter consistency** — Invalid `type` or `module` values not in the allowed enums

**Tools:** `mcp__obsidian__list_directory`, `mcp__obsidian__read_note`, `mcp__obsidian__search_notes`, `mcp__obsidian__get_frontmatter`

**Output:** Structured text with categories: orphans, broken_links, missing_frontmatter, stale_notes, empty_sections

### Agent 2: Code-to-Vault Sync Checker

**Mission:** Has the codebase changed in ways the vault doesn't reflect?

**Checks:**
1. **Recent commits** — `git log --oneline` since last `log.md` entry date (or 24h fallback)
2. **New/modified controllers** — Controller files not reflected in their module note's endpoint table
3. **New/modified routes** — Route files or endpoints added since last sync
4. **Schema changes** — `schema.prisma` changes: new models, fields, enums not in `Architecture/Database-Schema.md`
5. **New pages** — Frontend pages in `src/pages/` not documented in module notes
6. **Dependency changes** — `package.json` additions that might affect `Architecture/Tech-Stack.md`

**Tools:** `Bash` (git log, git diff), `Glob`, `Grep`, `Read`, `mcp__obsidian__read_note`

**Output:** Structured text with: recent_commits, new_controllers, new_routes, schema_changes, new_pages, dependency_changes

### Agent 3: Status & Accuracy Auditor

**Mission:** Are the status notes still truthful?

**Checks:**
1. **Build-Progress.md** — Cross-reference completed/not-started steps against actual code existence
2. **Current-Focus.md** — Is "next step" still accurate? Blockers resolved? Recommendations outdated?
3. **Tech-Debt.md** — Any active items that have been fixed? (grep for the fix in codebase) New debt introduced?
4. **Module-Health.md** — Test counts match actual output? Known issues resolved?
5. **Open-Questions.md** — Any questions answered by recent code changes or dependency additions?

**Tools:** `mcp__obsidian__read_note`, `Bash` (git log, npm test output), `Grep`, `Glob`

**Output:** Structured text with: build_progress_issues, focus_outdated, debt_resolved, health_drift, questions_answered

### Agent 4: Knowledge Gap Finder

**Mission:** What knowledge should exist but doesn't?

**Checks:**
1. **Undocumented decisions** — Recent `feat:` or `refactor:` commits without corresponding `Decisions/` notes
2. **Missing learnings** — Recent `fix:` commits suggesting bug lessons without `Learnings/` notes
3. **Stale ideas** — Ideas with `status: active` but no related vault or code activity in 30+ days
4. **Unindexed plans** — New files in `md_files/plans/` not referenced in `Plans-Index.md`
5. **Log staleness** — Days since last `log.md` entry (indicator of sync discipline)
6. **Missing workflow updates** — If job/lead/estimate/invoice business rules changed, are workflow notes still accurate?

**Tools:** `Bash` (git log), `Glob`, `mcp__obsidian__read_note`, `mcp__obsidian__search_notes`

**Output:** Structured text with: undocumented_decisions, missing_learnings, stale_ideas, unindexed_plans, days_since_last_log, workflow_drift

### Agent 5: Report Compiler

**Mission:** Compile all findings into an HTML email and send it.

**Input:** Text outputs from Agents 1-4

**Severity classification:**
- **Critical (red):** Code contradicts vault, broken wikilinks to module/architecture notes, missing module notes for new code
- **Warning (yellow):** Stale notes >14 days, orphan pages, frontmatter issues, test count drift, log staleness >3 days
- **Suggestion (green):** Undocumented decisions, missing learnings, stale ideas, unindexed plans

**Email format:**
```
Subject: ALPHA CRM Vault Audit — YYYY-MM-DD

📊 SUMMARY
━━━━━━━━━━━
Vault: XX notes, XX folders
Last sync: YYYY-MM-DD (X days ago)
Findings: X critical, X warnings, X suggestions
Cron expires in: X days [⚠️ RENEW SOON if ≤1 day]

🔴 CRITICAL
━━━━━━━━━━
• [Finding] — [file path] — [specific detail] — [recommended action]

🟡 WARNINGS
━━━━━━━━━━
• [Finding] — [detail]

🟢 SUGGESTIONS
━━━━━━━━━━━━━
• [Finding] — [detail]

📋 AGENT BREAKDOWN
━━━━━━━━━━━━━━━━━━
Vault Health: X findings (X critical, X warning, X suggestion)
Code Sync: X findings
Status Accuracy: X findings
Knowledge Gaps: X findings

✅ ALL CLEAR: [sections with zero findings]
```

**Day 7 expiration warning:**
When the cron job is on its last day (day 7), the Report Compiler adds a prominent banner:

```
⚠️ CRON EXPIRING TOMORROW
━━━━━━━━━━━━━━━━━━━━━━━━━
This is the last nightly audit. The cron job expires after 7 days.
To renew, run in any Claude Code session:
  /vault-audit-setup
```

**All-clear email (zero findings):**
```
Subject: ALPHA CRM Vault Audit — YYYY-MM-DD ✅

Vault is in sync. XX notes, XX folders.
Last sync: YYYY-MM-DD. No issues found.
[Day X of 7 — cron renews automatically / expires in X days]
```

**Tools:** `mcp__resend__send-email` (must provide both `html` AND `text` parameters — Resend requires plaintext fallback when HTML is provided)

## Coordination

1. Orchestrator cron fires at 2:27 AM ET
2. Orchestrator spawns Agents 1-4 in a **single message with 4 parallel Agent tool calls**
3. Each agent runs independently (~30-90 seconds each)
4. Orchestrator collects all 4 results
5. Orchestrator spawns Agent 5 with all findings as context
6. Agent 5 classifies severity, formats HTML, sends email
7. Total execution: ~2-5 minutes

**Failure handling:**
- If an agent fails, orchestrator notes which agent failed
- Report Compiler sends partial report with "[Agent X] failed — error: ..." section
- Email is always sent, even if partially empty

## Cron Configuration

- **Expression:** `27 2 * * *` (2:27 AM local)
- **Durable:** `true` (persists to `.claude/scheduled_tasks.json`)
- **Auto-expires:** After 7 days (CronCreate limitation)
- **Requires:** Claude Code session must be running. Cron only fires while the REPL is idle. If Claude Code is closed, the cron does not fire.
- **Creation timestamp:** The `/vault-audit-setup` skill embeds the creation date into the orchestrator prompt so Agent 5 can calculate days remaining (Day X of 7) for the expiration warning.

## Renewal Skill: `/vault-audit-setup`

A project-level skill at `.claude/skills/vault-audit-setup/SKILL.md` that:
1. Creates the durable cron job with the full orchestrator prompt
2. Confirms creation with next fire time
3. Reports current cron status if one already exists

User runs `/vault-audit-setup` once per week (or whenever they restart Claude Code).

**Prerequisite:** Claude Code must be running for the cron to fire. The skill reminds the user of this.

## Email Configuration

- **To:** `ran@alphasecurityus.com`
- **From:** `vault@alphasecurityus.com`
- **Domain:** `alphasecurityus.com` (verified in Resend)
- **API:** Resend MCP (`mcp__resend__send-email`)

## File Locations

| Artifact | Path |
|----------|------|
| Design spec (this file) | `md_files/plans/project/vault-nightly-audit-design.md` |
| Setup skill | `.claude/skills/vault-audit-setup/SKILL.md` |
| Vault audit idea note | `Ideas/Vault-Lint-Skill.md` (update status to "in-progress") |
