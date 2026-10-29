---
name: vault-audit-setup
description: "Set up the nightly vault audit cron job. Creates a durable cron that spawns 5 agents to audit the Obsidian vault against the codebase and emails a report. Run once per week to renew (auto-expires after 7 days)."
user_invocable: true
---

# Vault Audit Setup

## Purpose
Create (or renew) the nightly vault audit cron job. The job runs at 2:27 AM ET, spawns 5 parallel audit agents + 1 report compiler, and sends a detailed email report to ran@alphasecurityus.com.

## Prerequisites
- Claude Code session must be **running** for the cron to fire (it only fires while the REPL is idle)
- Obsidian MCP server must be connected (`mcp__obsidian__*` tools)
- Resend MCP server must be connected (`mcp__resend__send-email`)
- `gh` CLI authenticated with `repo` scope (Agent 5 reads issues + PRs from GitHub)

## Procedure

### 1. Check Existing Crons
Use `CronList` to check if a vault audit cron already exists. If it does, report its status and ask if the user wants to renew (replace) it.

### 2. Get Today's Date
Run `date +%Y-%m-%d` via Bash to get today's date. This becomes CREATION_DATE.
Calculate expiry: CREATION_DATE + 7 days.

### 3. Create the Durable Cron

Use `CronCreate` with:
- **cron:** `27 2 * * *`
- **durable:** `true`
- **prompt:** Use the EXACT orchestrator prompt below, replacing every instance of `__CREATION_DATE__` with today's actual date (YYYY-MM-DD format) and every instance of `__REPO_ROOT__` with the output of `git rev-parse --show-toplevel` (the repo's absolute path on THIS machine — works in bash on Windows and macOS).

### 4. Confirm
Output:
```
## Vault Audit Cron Active

**Schedule:** Every night at 2:27 AM ET
**Created:** [CREATION_DATE]
**Expires:** [CREATION_DATE + 7 days]
**Email to:** ran@alphasecurityus.com
**Email from:** vault@alphasecurityus.com

Prerequisite: Keep this Claude Code session running.
Renewal: Run /vault-audit-setup again before [expiry date].
```

---

## Orchestrator Prompt

Everything below this line is the prompt passed to CronCreate. Copy it exactly, replacing `__CREATION_DATE__` with the actual date and `__REPO_ROOT__` with `git rev-parse --show-toplevel`.

---

You are the Nightly Vault Audit orchestrator for ALPHA CRM. Cron created on: __CREATION_DATE__ (expires 7 days later).

YOUR JOB: Spawn 5 parallel audit agents, collect their findings, then spawn a report compiler agent to email the results. Do NOT modify any vault notes or code — this is report-only.

VAULT ACCESS: Use mcp__obsidian__* MCP tools (read_note, search_notes, list_directory, get_frontmatter, get_vault_stats).
CODEBASE: __REPO_ROOT__
EMAIL: mcp__resend__send-email (to: ran@alphasecurityus.com, from: vault@alphasecurityus.com)

VAULT STRUCTURE:
- index.md (MOC), log.md (session log)
- Modules/ (13 notes: Auth, Customers, Leads, Estimates, Deposits, Jobs, Scheduling, Invoices, Payments, Price-Book, Attachments, Search, Settings)
- Architecture/ (8 notes), Workflows/ (6 md + 2 canvas), Product/ (3 notes)
- Decisions/ (12 notes), Ideas/ (10 notes), Learnings/ (8 notes)
- Status/ (6 notes: Build-Progress, Roadmap, Tech-Debt, Current-Focus, Module-Health, Open-Questions)
- Bases/ (5 .base files), Plans-Index.md

FRONTMATTER CONVENTION: Every note has type, created. Most have module, status, updated, tags.
- Valid types: module, architecture, decision, idea, learning, status, workflow, product, index, log
- Valid modules: auth, customers, leads, estimates, deposits, jobs, scheduling, invoices, payments, price-book, attachments, search, settings, general

STEP 1: SPAWN 5 AUDIT AGENTS IN PARALLEL

Send a SINGLE message with 5 Agent tool calls. Each agent returns structured findings as text.

AGENT 1 — VAULT HEALTH INSPECTOR:
description: "Vault Health Inspector"
prompt: |
  You are the Vault Health Inspector for ALPHA CRM's Obsidian vault. Check structural integrity using mcp__obsidian__* MCP tools. Report-only — do NOT modify anything.

  CHECK 1 — ORPHAN NOTES:
  Use list_directory on each folder: Modules, Architecture, Decisions, Ideas, Learnings, Status, Workflows, Product.
  For each .md note found, use search_notes with the note's name (without path/extension) to check if ANY other note mentions it in a [[wikilink]].
  If zero results from other notes, it's an orphan.
  EXCLUDE from orphan detection: index.md, log.md, Plans-Index.md, Welcome.md, all .base files, all .canvas files.

  CHECK 2 — BROKEN WIKILINKS:
  Read each note in Modules/ and Architecture/ (the hub pages with the most links).
  Find all [[WikiLink]] patterns in the content using regex.
  For each unique link target, use search_notes to verify a note with that name exists.
  Flag any [[Link]] where the target note doesn't exist.

  CHECK 3 — MISSING FRONTMATTER:
  Use get_frontmatter on every .md note in every folder.
  Required fields: type, created. Flag any note missing these.

  CHECK 4 — STALE DATES:
  For each note with an 'updated' frontmatter field, check if it's more than 14 days before today.
  Flag as stale with the path, last updated date, and days since update.

  CHECK 5 — EMPTY SECTIONS:
  Read each note in Modules/. Check if the "Current State" section exists and has actual content (not just the heading or a placeholder like "Complete" with no detail).

  CHECK 6 — FRONTMATTER CONSISTENCY:
  For every note, verify 'type' is one of: module, architecture, decision, idea, learning, status, workflow, product, index, log.
  If 'module' field exists, verify it's one of: auth, customers, leads, estimates, deposits, jobs, scheduling, invoices, payments, price-book, attachments, search, settings, general.
  Flag any invalid values.

  OUTPUT FORMAT:
  Return your findings as structured text with clear category headers:
  === ORPHAN NOTES ===
  === BROKEN WIKILINKS ===
  === MISSING FRONTMATTER ===
  === STALE NOTES ===
  === EMPTY SECTIONS ===
  === FRONTMATTER ISSUES ===
  For each finding, include the file path and specific detail. If a category has zero findings, write "None found."

AGENT 2 — CODE-TO-VAULT SYNC CHECKER:
description: "Code-to-Vault Sync Checker"
prompt: |
  You are the Code-to-Vault Sync Checker for ALPHA CRM. Compare recent codebase changes against the Obsidian vault. Report-only — do NOT modify anything.

  FIRST: Read log.md from the vault (mcp__obsidian__read_note path='log.md'). Find the date of the last session entry (look for lines starting with "## [YYYY-MM-DD]"). Use that date for all 'since' comparisons. If no date found, use '7 days ago'.

  CHECK 1 — RECENT COMMITS:
  Run via Bash: git log --oneline --since='[LAST_SYNC_DATE]'
  List all commits found. These are potential vault gaps.

  CHECK 2 — NEW CONTROLLERS:
  Run via Bash: ls backend/src/controllers/
  For each controller file, read the corresponding vault module note (e.g., customer.controller.ts → Modules/Customers.md).
  Check if the module note's "API Endpoints" table is reasonably complete. Flag any controller that seems to have more endpoints than documented.

  CHECK 3 — NEW ROUTES:
  Run via Bash: ls backend/src/routes/
  Use Grep to count route definitions (router.get, router.post, router.patch, router.delete) per file.
  Compare these counts against the endpoint tables in vault module notes. Flag significant discrepancies (>2 difference).

  CHECK 4 — SCHEMA CHANGES:
  Run via Bash: git diff HEAD~10 -- backend/prisma/schema.prisma
  If there are changes, read Architecture/Database-Schema.md from the vault.
  Check if new models, fields, or enums from the diff are documented. Flag any missing.

  CHECK 5 — NEW PAGES:
  Run via Bash: ls frontend/src/pages/
  Read index.md from vault and check the Modules section. Flag any page file not mentioned in any vault note.

  CHECK 6 — DEPENDENCY CHANGES:
  Run via Bash: git diff HEAD~10 -- package.json backend/package.json frontend/package.json
  If new dependencies were added, read Architecture/Tech-Stack.md from vault. Flag new deps not documented.

  OUTPUT FORMAT:
  === RECENT COMMITS (since [date]) ===
  === CONTROLLER SYNC ===
  === ROUTE COUNT DRIFT ===
  === SCHEMA CHANGES ===
  === NEW PAGES ===
  === DEPENDENCY CHANGES ===
  For each finding, include specific file paths and details. If a category has zero findings, write "None found."

AGENT 3 — STATUS & ACCURACY AUDITOR:
description: "Status & Accuracy Auditor"
prompt: |
  You are the Status & Accuracy Auditor for ALPHA CRM. Check if the vault's status notes still tell the truth. Report-only — do NOT modify anything.

  CHECK 1 — BUILD PROGRESS:
  Read Status/Build-Progress.md from the vault.
  For each step marked "Not started", check if relevant code exists:
  - Step 7 (Technician Mobile): check frontend/src/pages/ for technician-specific pages
  - Step 9A (Dashboard): check if backend/src/controllers/dashboard.controller.ts or frontend/src/pages/DashboardPage.tsx has real content beyond a placeholder
  - Step 9B (Reports): check for report-related controllers or pages
  - Step 10 (Polish): check for recent test/lint/security commits
  For completed steps, spot-check that the code actually exists (e.g., Step 8B — does InvoiceDetailPage.tsx exist?).
  Flag any mismatches.

  CHECK 2 — CURRENT FOCUS:
  Read Status/Current-Focus.md from the vault.
  Check if the "Next Step" recommendation is still the actual next uncompleted step.
  Run via Bash: git log --oneline -10 to see what's been worked on recently. If recent work doesn't match the stated focus, flag it.
  Check if any listed "Blockers" have been resolved.

  CHECK 3 — TECH DEBT:
  Read Status/Tech-Debt.md from the vault.
  For each active item, try to verify if it's been fixed:
  - "Number generation race condition" → grep for SELECT FOR UPDATE or sequence in migration files
  - "Decimal serialization" → grep for Decimal handling utilities
  - "34 open scheduler issues" → check if scheduler files were recently modified
  Flag any items that appear resolved but still listed as active.

  CHECK 4 — MODULE HEALTH:
  Read Status/Module-Health.md from the vault.
  Run via Bash: npm test --workspace=backend 2>&1 | tail -3
  Extract the current test count. Compare against the count documented in Module-Health.md. Flag if they differ.

  CHECK 5 — OPEN QUESTIONS:
  Read Status/Open-Questions.md from the vault.
  For each question, check if it's been answered:
  - "Dashboard chart library" → grep frontend/package.json for recharts, nivo, chart.js
  - "Dashboard endpoint design" → check if dashboard routes exist
  - "Technician mobile approach" → check for mobile-specific code
  Flag any questions that appear answered by the codebase.

  OUTPUT FORMAT:
  === BUILD PROGRESS ===
  === CURRENT FOCUS ===
  === TECH DEBT ===
  === MODULE HEALTH ===
  === OPEN QUESTIONS ===
  For each finding, include specific details. If a category has zero findings, write "None found."

AGENT 4 — KNOWLEDGE GAP FINDER:
description: "Knowledge Gap Finder"
prompt: |
  You are the Knowledge Gap Finder for ALPHA CRM. Identify knowledge that should exist in the vault but doesn't. Report-only — do NOT modify anything.

  FIRST: Read log.md from the vault (mcp__obsidian__read_note path='log.md'). Find the date of the last session entry. Use that for 'since' comparisons. If no date found, use '7 days ago'.

  CHECK 1 — UNDOCUMENTED DECISIONS:
  Run via Bash: git log --oneline --since='[LAST_SYNC_DATE]'
  Look for commits containing 'feat:', 'refactor:', or keywords suggesting architectural choices (e.g., "switch to", "replace", "migrate", "add library").
  For each candidate, use mcp__obsidian__search_notes to check if a related Decisions/ note exists.
  Flag commits that look like decisions without a corresponding note. Suggest a note title.

  CHECK 2 — MISSING LEARNINGS:
  Run via Bash: git log --oneline --since='[LAST_SYNC_DATE]' --grep='fix:'
  For significant fixes (not typos or formatting), use mcp__obsidian__search_notes to check if a Learnings/ note exists.
  Flag fixes that seem like they taught a lesson but aren't documented.

  CHECK 3 — STALE IDEAS:
  Use mcp__obsidian__list_directory on Ideas/. Read each idea note's frontmatter.
  Flag ideas where status is 'active' AND the 'updated' date is more than 30 days ago.
  These are ideas going stale — either work on them or park them.

  CHECK 4 — UNINDEXED PLANS:
  Use the Glob tool with pattern 'md_files/plans/**/*.md' to find all plan files in the project.
  Read Plans-Index.md from the vault.
  Flag any plan file not referenced in Plans-Index.md.

  CHECK 5 — LOG STALENESS:
  Read log.md from the vault. Find the last entry date.
  Calculate days since last entry. Flag as:
  - OK: 0-2 days
  - WARNING: 3-6 days
  - CRITICAL: 7+ days (vault sync discipline has lapsed)

  CHECK 6 — WORKFLOW DRIFT:
  Run via Bash: git log --oneline --since='[LAST_SYNC_DATE]' -- backend/src/controllers/lead.controller.ts backend/src/controllers/estimate.controller.ts backend/src/controllers/job.controller.ts backend/src/controllers/invoice.controller.ts
  If any of these controllers changed, the business rules may have shifted.
  Read the corresponding Workflows/ notes (Standard-Flow.md, Urgent-Flow.md) and flag if the documented steps might be outdated.

  OUTPUT FORMAT:
  === UNDOCUMENTED DECISIONS ===
  === MISSING LEARNINGS ===
  === STALE IDEAS ===
  === UNINDEXED PLANS ===
  === LOG STALENESS ===
  === WORKFLOW DRIFT ===
  For each finding, include specific details and suggested actions. If a category has zero findings, write "None found."

AGENT 5 — PIPELINE & GITHUB ISSUES AGENT:
description: "Pipeline & GitHub Issues Agent"
prompt: |
  You are the Pipeline & GitHub Issues Agent for ALPHA CRM. Audit GitHub issues + pipeline-status.md against the actual codebase. Report-only — do NOT modify any files or issues.

  ISSUE TRACKER: GitHub Issues at `ranro1/ALPHA_CRM` (use `gh` CLI).
  KNOWLEDGE BASE: __REPO_ROOT__/memory/
  CODEBASE: __REPO_ROOT__

  PART A — OPEN ISSUES SUMMARY

  STEP A1 — FETCH OPEN ISSUES:
  From the codebase root, run via Bash:
  `gh issue list --state open --json number,title,labels --limit 100 --jq '[.[] | {n: .number, t: .title, p: ([.labels[].name] | map(select(startswith("priority:"))) | .[0]), m: ([.labels[].name] | map(select(startswith("module:"))) | .[0])}]'`

  STEP A2 — OPEN ISSUES DIGEST:
  Group by priority (priority:critical first, then priority:high, priority:medium, priority:low, then issues without priority label).
  Format each as: "#NN | <module> | <title>"
  Count totals per priority.

  STEP A3 — SPOT-CHECK RECENTLY CLOSED ISSUES (last 7 days):
  Run: `gh issue list --state closed --limit 30 --json number,title,closedAt --jq '[.[] | select(.closedAt > (now - 7*86400 | todate))]'`
  For each, infer the file path from the title or fetch the issue body, then verify the file/keyword still exists in the codebase. Flag any closure where the fix appears to have been reverted.

  STEP A4 — STALENESS CHECK:
  Run: `gh issue list --state open --json number,title,updatedAt --limit 100`
  Flag any open issue whose `updatedAt` is more than 30 days ago (potential abandoned/stale issue).

  PART B — PIPELINE COVERAGE

  STEP B1 — READ PIPELINE STATUS:
  Read [KNOWLEDGE BASE]/pipeline-status.md using the Read tool.

  STEP B2 — SCAN TEST FILES:
  Use Glob to find all files in backend/src/__tests__/*.test.ts.
  For each test file, use Grep to count test cases (pattern: "it\(|test\(").
  Record which modules are covered and approximate test count per file.

  STEP B3 — SCAN CONTROLLERS AND ROUTES:
  Use Glob to find all files in backend/src/controllers/*.controller.ts and backend/src/routes/*.routes.ts.
  For each pipeline stage, determine:
  - Controller exists: yes / no / partial
  - Route registered: yes / no
  - Unit test file exists: yes / no
  - Approx test count: number or 0

  STEP B4 — FLAG ANOMALIES:
  Report any of the following:
  - A stage marked as Built (✅) but no controller found
  - A stage with zero test coverage
  - A test file that exists but has no tests
  - A route registered but no controller handling it
  - A significant change in test counts since last audit
  - A pipeline stage at Low confidence with no known issues explaining why

  RULES:
  - Do NOT change Confidence levels — only Ran can set these after manual testing
  - Do NOT modify any GitHub issues or labels
  - Do NOT mark stages as manually tested (✅ in the Tested column means tested by Ran)
  - If unsure whether a controller covers a specific stage, note it as "uncertain"

  OUTPUT FORMAT:
  === OPEN ISSUES DIGEST ===
  **Open Critical:** [count]
  [list each: #NN | <module> | <title>]
  **Open High:** [count]
  [list each: #NN | <module> | <title>]
  **Open Medium:** [count]
  [list each: #NN | <module> | <title>]
  **Open Low:** [count]
  [list each: #NN | <module> | <title>]
  **Total open:** [count]
  === CLOSED ISSUE SPOT-CHECK (last 7 days) ===
  [list any apparently-reverted closures or "All recent closures verified."]
  === ISSUE STALENESS ===
  [list any open issues with no activity in 30+ days, or "None found."]
  === COVERAGE MATRIX ===
  [table: Stage | Controller | Route | Test File | Test Count]
  === PIPELINE ANOMALIES ===
  [list of anomalies or "None found."]
  === PIPELINE SUMMARY ===
  Stages scanned: [count]
  Stages with full coverage (controller + route + tests): [count]
  Stages with no test coverage: [list]

  PART C — OVERNIGHT PRs AWAITING REVIEW

  STEP C1 — READ TONIGHT'S FIX ATTEMPT STATE:
  Read the file at __REPO_ROOT__/memory/fix-agent-state.json using the Read tool.
  If the file does not exist, treat as no attempts.
  If `skipped` field is true, note the cron was skipped and the reason.
  From the `attempts` array, separate entries by status: `pr_opened`, `reverted`, `aborted`.

  STEP C2 — LIST ALL OPEN AUTO-FIX PRs (incl. older ones still awaiting review):
  From the codebase root, run via Bash:
  `gh pr list --base staging --state open --json number,title,url,createdAt,labels --limit 50`

  For each PR whose head branch matches the pattern `fix/<NN>-...` OR carries the `auto-fix` label, capture: PR number, title, URL, age in days, linked issue number (parsed from `Fixes #NN` in body if present — fetch with `gh pr view <n> --json body`).

  OUTPUT FORMAT (use these exact section headers — the Report Compiler parses them):
  === TONIGHT'S PRs OPENED ===
  [list each pr_opened from fix-agent-state.json: #ISSUE -> PR <url> | <title>]
  [If none: write "None."]
  === ALL PRs AWAITING REVIEW (base: staging) ===
  [list each open auto-fix PR sorted oldest first: PR <url> | age: Xd | fixes #ISSUE | <title>]
  [If none: write "None — queue is empty."]
  === TONIGHT'S FIX ATTEMPTS (not PR'd) ===
  [list each: #ISSUE | Status: reverted/aborted | Reason: <reason>]
  [If cron skipped: write "Skipped — <reason>."]
  [If none and not skipped: write "None."]

STEP 2: COLLECT RESULTS

After all 5 agents return, you have 5 text blocks of findings. Calculate the cron day number:
- Parse __CREATION_DATE__ as the creation date
- Calculate: today minus __CREATION_DATE__ = day number (day 1 = creation day, day 7 = last day)
- If calculation fails, default to "unknown"

STEP 3: SPAWN REPORT COMPILER AGENT

Spawn a single Agent with description "Report Compiler" and the following prompt (substitute the actual findings and day number):

You are the Report Compiler for the ALPHA CRM nightly vault audit.

CRON DAY: [DAY_NUMBER] of 7 (created __CREATION_DATE__)

AUDIT FINDINGS:
=== VAULT HEALTH INSPECTOR ===
[paste agent 1 full results here]

=== CODE-TO-VAULT SYNC CHECKER ===
[paste agent 2 full results here]

=== STATUS & ACCURACY AUDITOR ===
[paste agent 3 full results here]

=== KNOWLEDGE GAP FINDER ===
[paste agent 4 full results here]

=== PIPELINE COVERAGE AGENT ===
[paste agent 5 full results here]

YOUR JOB:
1. Use mcp__obsidian__get_vault_stats to get current vault note count and folder count.
2. Read log.md (mcp__obsidian__read_note path='log.md') to get the last sync date.
3. Classify EVERY finding into one of three severities:
   - CRITICAL: Code contradicts vault, broken wikilinks to module/architecture notes, missing module notes for new code, log staleness >7 days
   - WARNING: Stale notes >14 days, orphan pages, frontmatter issues, test count drift, log staleness 3-7 days
   - SUGGESTION: Undocumented decisions, missing learnings, stale ideas, unindexed plans
4. Count totals: X critical, X warnings, X suggestions. Count per agent too.
5. If CRON DAY is 7: Add this prominent banner at the TOP of the email:
   "CRON EXPIRING TODAY — This is the last nightly audit. Run /vault-audit-setup in any Claude Code session to renew."
   If CRON DAY is 6: Add a softer note: "Reminder: Vault audit cron expires tomorrow. Run /vault-audit-setup to renew."
6. Build the HTML email with these sections (IN THIS ORDER):
   - Summary (vault stats, last sync, finding counts, cron status)
   - **Issues Dashboard** (placed IMMEDIATELY after Summary, before other findings):
       IMPORTANT: Always render the PRs Awaiting Review sub-section first, before open issues. Do not skip it even if the queue is empty.
     - **PRs Awaiting Review sub-section** (render first, above Critical issues):
       Parse the Agent 5 output for `=== TONIGHT'S PRs OPENED ===`, `=== ALL PRs AWAITING REVIEW (base: staging) ===`, and `=== TONIGHT'S FIX ATTEMPTS (not PR'd) ===`.
       If TONIGHT'S PRs OPENED has entries beyond "None.":
         Render in green at the top: "🤖 PRs opened tonight (N): linked list of PR URLs with `Fixes #NN` references"
       Then render ALL PRs AWAITING REVIEW as a sorted-by-age table: PR # | Age | Fixes # | Title — link. Oldest at top so stale PRs surface.
       If TONIGHT'S FIX ATTEMPTS has entries beyond "None.":
         Render in amber: "⚠️ Attempted but not PR'd (M): #ISSUE — reason"
       If TONIGHT'S FIX ATTEMPTS contains the word "Skipped": render in amber: "⚠️ Auto-fix cron skipped — <reason from state file>."
       Always render this sub-section even if empty.
     - Show all open Critical issues with red styling (#NN, module, title — link to GitHub issue)
     - Show all open High issues with amber styling
     - Show open Medium/Low counts as a single line (don't list each one)
     - Show total: "X open issues (Y Critical, Z High, W Medium, V Low)"
     - If any recently closed issues failed spot-check, flag them in red
   - Critical findings (red styling)
   - Warnings (yellow/amber styling)
   - Suggestions (green styling)
   - Pipeline Coverage (coverage matrix summary + anomalies)
   - Agent Breakdown (count per agent)
   - All Clear sections (list any agents with zero findings)
   Use clean, readable HTML. Tables for structured data. Bullet points for findings. Each finding should include the file path and a specific recommended action.
7. Build a PLAIN TEXT version with the same content (no HTML tags).
8. Send the email using mcp__resend__send-email:
   - to: ["ran@alphasecurityus.com"]
   - from: "vault@alphasecurityus.com"
   - subject: "ALPHA CRM Vault Audit — [today's date]" (if zero total findings, append " ✅")
   - html: [the HTML email]
   - text: [the plain text version]

If ALL agents reported zero findings across all categories, send a short all-clear email instead:
Subject: "ALPHA CRM Vault Audit — [date] ✅"
Body: "Vault is in sync. [X] notes, [X] folders. Last sync: [date]. No issues found. [Cron day X of 7]"

If any agent FAILED (returned an error instead of findings), include an "Agent Failures" section in the email noting which agent failed and the error message. Still send the email with partial results.
