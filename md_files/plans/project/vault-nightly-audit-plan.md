# Nightly Vault Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a `/vault-audit-setup` skill that installs a durable nightly cron job. The cron spawns 5 agents (4 parallel auditors + 1 report compiler) to compare the Obsidian vault against the codebase and email a detailed report.

**Architecture:** Single SKILL.md file containing the orchestrator prompt. The orchestrator uses the Agent tool to spawn 4 parallel audit agents, collects results, then spawns a report compiler agent that sends the email via Resend MCP. CronCreate with `durable: true` for persistence.

**Tech Stack:** CronCreate (durable), Agent tool, Obsidian MCP (`mcp__obsidian__*`), Resend MCP (`mcp__resend__send-email`), Bash/Glob/Grep/Read for codebase inspection.

**Spec:** `md_files/plans/project/vault-nightly-audit-design.md`

---

## File Structure

| File | Purpose |
|------|---------|
| `.claude/skills/vault-audit-setup/SKILL.md` | The skill — creates the durable cron with full orchestrator prompt |
| `Ideas/Vault-Lint-Skill.md` (vault) | Update status from `active` to `in-progress` |
| `log.md` (vault) | Append entry for this implementation |

The orchestrator prompt lives INSIDE the SKILL.md — it's the string passed to `CronCreate`'s `prompt` parameter. No separate file needed.

---

### Task 1: Create the `/vault-audit-setup` Skill

**Files:**
- Create: `.claude/skills/vault-audit-setup/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
ls .claude/skills/  # verify directory exists
```

- [ ] **Step 2: Write SKILL.md with frontmatter**

Create `.claude/skills/vault-audit-setup/SKILL.md` with:

```markdown
---
name: vault-audit-setup
description: "Set up the nightly vault audit cron job. Creates a durable cron that spawns 5 agents to audit the Obsidian vault against the codebase and emails a report. Run once per week to renew (auto-expires after 7 days)."
user_invocable: true
---

# Vault Audit Setup

## Purpose
Create (or renew) the nightly vault audit cron job. The job runs at 2:27 AM ET, spawns 4 parallel audit agents + 1 report compiler, and sends an email to ran@alphasecurityus.com.

## Prerequisites
- Claude Code session must be running for the cron to fire
- Obsidian MCP server must be connected (mcp__obsidian__* tools)
- Resend MCP server must be connected (mcp__resend__send-email)

## Procedure

### 1. Check Existing Crons
Use CronList to check if a vault audit cron already exists. If it does, report its status and ask if the user wants to renew it.

### 2. Create the Durable Cron
Use CronCreate with these parameters:
- **cron:** `27 2 * * *` (2:27 AM local)
- **durable:** `true`
- **prompt:** The full orchestrator prompt below (substitute CREATION_DATE with today's date YYYY-MM-DD)

### 3. Confirm
Output:
```
## Vault Audit Cron Active

**Schedule:** Every night at 2:27 AM ET
**Created:** [today's date]
**Expires:** [today + 7 days]
**Email to:** ran@alphasecurityus.com
**Email from:** vault@alphasecurityus.com

**Prerequisite:** Keep this Claude Code session running.
**Renewal:** Run /vault-audit-setup again before [expiry date].
```

## Orchestrator Prompt

The following is the EXACT prompt to pass to CronCreate. Replace `CREATION_DATE` with today's date in YYYY-MM-DD format.

---

You are the Nightly Vault Audit orchestrator for ALPHA CRM. Created on: CREATION_DATE (expires 7 days later).

## Your Job
Spawn 4 parallel audit agents, collect their findings, then spawn a report compiler agent to email the results.

## Vault Info
- Path: Obsidian vault accessed via mcp__obsidian__* MCP tools
- Vault structure: index.md (MOC), log.md (session log), Modules/ (13), Architecture/ (8), Workflows/ (6+2 canvas), Product/ (3), Decisions/ (12), Ideas/ (10), Learnings/ (8), Status/ (6), Bases/ (5), Plans-Index.md
- Frontmatter convention: every note has type, created; most have module, status, updated, tags

## Codebase Info
- Path: C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm
- Monorepo: backend/ (Express + Prisma) + frontend/ (React + Vite)
- Schema: backend/prisma/schema.prisma
- Controllers: backend/src/controllers/
- Routes: backend/src/routes/
- Pages: frontend/src/pages/

## Step 1: Spawn 4 Audit Agents in Parallel

Send a SINGLE message with 4 Agent tool calls (all parallel):

### Agent 1: Vault Health Inspector
Prompt: "You are the Vault Health Inspector for ALPHA CRM's Obsidian vault. Check structural integrity. Use mcp__obsidian__* tools.

Checks:
1. ORPHAN NOTES: Use list_directory on each folder (Modules, Architecture, Decisions, Ideas, Learnings, Status, Workflows, Product). For each note found, use search_notes to check if any OTHER note mentions its name in a wikilink [[NoteName]]. If zero results (excluding itself), it's an orphan. Exclude: index.md, log.md, Plans-Index.md, .base files, .canvas files from orphan detection.
2. BROKEN WIKILINKS: Read each note in Modules/ and Architecture/ (these are the hub pages). Find all [[WikiLink]] patterns in content. For each link, verify the target note exists by checking if search_notes finds it.
3. MISSING FRONTMATTER: Use get_frontmatter on every .md note. Check for required fields: type and created. Flag any note missing these.
4. STALE DATES: Check the 'updated' frontmatter field. If it's more than 14 days before today, flag as stale.
5. EMPTY SECTIONS: Read each Modules/*.md note. Check if 'Current State' section exists and has content (not just a heading).
6. FRONTMATTER CONSISTENCY: For every note, verify that the 'type' value is one of: module, architecture, decision, idea, learning, status, workflow, product, index, log. Verify that 'module' (if present) is one of: auth, customers, leads, estimates, deposits, jobs, scheduling, invoices, payments, price-book, attachments, search, settings, general. Flag any invalid values.

Output your findings as structured text with clear categories. For each finding include the file path and specific detail."

### Agent 2: Code-to-Vault Sync Checker
Prompt: "You are the Code-to-Vault Sync Checker for ALPHA CRM. Compare recent codebase changes against the Obsidian vault.

First, read log.md from the vault (mcp__obsidian__read_note path='log.md') to find the date of the last session entry. Use that date for 'since' comparisons. If no date found, use '7 days ago'.

Checks:
1. RECENT COMMITS: Run 'git log --oneline --since=[last_sync_date]' via Bash to see what changed.
2. NEW CONTROLLERS: Run 'ls backend/src/controllers/' via Bash. Compare against the controllers documented in vault Modules/ notes. Any controller not mentioned in its module note is a gap.
3. NEW ROUTES: Run 'ls backend/src/routes/' via Bash. Count endpoints per file (grep for router.get/post/patch/delete). Compare counts against vault module notes' endpoint tables.
4. SCHEMA CHANGES: Run 'git diff HEAD~10 -- backend/prisma/schema.prisma' via Bash. If changes exist, read Architecture/Database-Schema.md from vault and check if new models/fields/enums are documented.
5. NEW PAGES: Run 'ls frontend/src/pages/' via Bash. Compare against pages mentioned in vault module notes.
6. DEPENDENCY CHANGES: Run 'git diff HEAD~10 -- package.json backend/package.json frontend/package.json' via Bash. Flag new dependencies not in Architecture/Tech-Stack.md.

Output your findings as structured text with clear categories."

### Agent 3: Status & Accuracy Auditor
Prompt: "You are the Status & Accuracy Auditor for ALPHA CRM. Check if the vault's status notes are still truthful.

Checks:
1. BUILD PROGRESS: Read Status/Build-Progress.md from vault. For each step marked 'not started', check if relevant code exists (e.g., Step 9A dashboard — check if backend/src/controllers/dashboard.controller.ts or frontend/src/pages/DashboardPage.tsx has real content beyond a placeholder). For completed steps, verify the code actually exists.
2. CURRENT FOCUS: Read Status/Current-Focus.md. Check if the 'next step' and 'blockers' are still accurate by comparing against recent git activity.
3. TECH DEBT: Read Status/Tech-Debt.md. For each active item, grep the codebase to see if it's been fixed. Example: if 'dead validators directory' is listed, check if backend/src/validators/ still exists.
4. MODULE HEALTH: Read Status/Module-Health.md. Run 'npm test --workspace=backend 2>&1 | tail -5' via Bash to get current test count. Compare against documented count.
5. OPEN QUESTIONS: Read Status/Open-Questions.md. For each question, check if recent code changes or new dependencies answer it (e.g., 'chart library choice' — check if recharts/nivo/chart.js is in package.json).

Output your findings as structured text with clear categories."

### Agent 4: Knowledge Gap Finder
Prompt: "You are the Knowledge Gap Finder for ALPHA CRM. Identify knowledge that should exist in the vault but doesn't.

First, read log.md from the vault to find the last sync date.

Checks:
1. UNDOCUMENTED DECISIONS: Run 'git log --oneline --since=[last_sync_date] --grep=feat --grep=refactor' via Bash. For each commit, search the vault Decisions/ folder for a related note. Flag commits that look like architectural choices without a corresponding Decision note.
2. MISSING LEARNINGS: Run 'git log --oneline --since=[last_sync_date] --grep=fix' via Bash. For significant fixes (not typos), check if a Learnings/ note exists.
3. STALE IDEAS: Read each note in Ideas/ folder. Check if status is 'active' and the 'updated' date is >30 days ago. These are ideas going stale.
4. UNINDEXED PLANS: Use the Glob tool with pattern 'md_files/plans/**/*.md' to find all plan files. Read Plans-Index.md from vault. Flag any plan file not referenced in the index.
5. LOG STALENESS: Read log.md, find the last entry date, calculate days since. If >3 days, flag as warning. If >7 days, flag as critical.
6. WORKFLOW DRIFT: If recent commits touched controllers for leads/estimates/jobs/invoices, check if the corresponding Workflows/ notes still describe the current business rules accurately.

Output your findings as structured text with clear categories."

## Step 2: Collect Results

After all 4 agents complete, you will have 4 text results. Assemble them into a single context block.

Calculate the cron day: today's date minus CREATION_DATE = day number (1-7).

## Step 3: Spawn Report Compiler Agent

Spawn Agent 5 with ALL findings plus the day number:

Prompt: "You are the Report Compiler for the ALPHA CRM nightly vault audit. You have findings from 4 audit agents below. Your job: classify severity, format an HTML email, and send it.

CRON DAY: [X] of 7 (created CREATION_DATE)

AUDIT FINDINGS:
=== VAULT HEALTH INSPECTOR ===
[paste agent 1 results]

=== CODE-TO-VAULT SYNC CHECKER ===
[paste agent 2 results]

=== STATUS & ACCURACY AUDITOR ===
[paste agent 3 results]

=== KNOWLEDGE GAP FINDER ===
[paste agent 4 results]

SEVERITY RULES:
- CRITICAL (red): Code contradicts vault, broken wikilinks to module/architecture notes, missing module notes for new code, log staleness >7 days
- WARNING (yellow): Stale notes >14 days, orphan pages, frontmatter issues, test count drift, log staleness 3-7 days
- SUGGESTION (green): Undocumented decisions, missing learnings, stale ideas, unindexed plans

INSTRUCTIONS:
1. Read vault stats: use mcp__obsidian__get_vault_stats for note count and folder count
2. Read log.md last entry date for 'last sync' info
3. Classify each finding into CRITICAL, WARNING, or SUGGESTION
4. Count totals per severity and per agent
5. If CRON DAY is 7 (last day), add a prominent expiration warning banner. If day 6, add a softer reminder.
6. Format the email as HTML with sections: Summary, Critical, Warnings, Suggestions, Agent Breakdown, All Clear sections
7. Also create a plain text version (same content, no HTML)
8. Send via mcp__resend__send-email:
   - to: ['ran@alphasecurityus.com']
   - from: 'vault@alphasecurityus.com'
   - subject: 'ALPHA CRM Vault Audit — [today date]' (add checkmark emoji if zero findings)
   - html: [the HTML email]
   - text: [the plain text version]

If ALL agents reported zero findings, send a short all-clear email instead.
If any agent FAILED (returned error), include an 'Agent Failures' section noting which agent failed and why."

---
```

- [ ] **Step 3: Verify the skill is recognized**

```bash
ls .claude/skills/vault-audit-setup/SKILL.md
```

The skill should now appear in the available skills list after the next session reload.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/vault-audit-setup/SKILL.md
git commit -m "feat: add /vault-audit-setup skill for nightly vault audit cron"
```

---

### Task 2: Update Obsidian Vault

**Files:**
- Modify (vault): `Ideas/Vault-Lint-Skill.md` — update status
- Modify (vault): `log.md` — append entry

- [ ] **Step 1: Update Vault-Lint-Skill idea status**

Use `mcp__obsidian__update_frontmatter` on `Ideas/Vault-Lint-Skill.md`:
- Change `status` from `active` to `in-progress`
- Change `updated` to today's date

- [ ] **Step 2: Append to log.md**

Use `mcp__obsidian__write_note` with `mode: "append"` on `log.md`:

```
## [YYYY-MM-DD] feat | Nightly vault audit system
- Created /vault-audit-setup skill
- 5-agent architecture: Vault Health Inspector, Code Sync Checker, Status Auditor, Knowledge Gap Finder, Report Compiler
- Durable cron at 2:27 AM ET, emails to ran@alphasecurityus.com
- Design spec: md_files/plans/project/vault-nightly-audit-design.md
```

- [ ] **Step 3: Verify vault updates**

Use `mcp__obsidian__get_frontmatter` on `Ideas/Vault-Lint-Skill.md` to confirm status is `in-progress`.
Read `log.md` to confirm entry was appended.

---

### Task 3: Test the Setup Skill

- [ ] **Step 1: Run /vault-audit-setup**

Invoke the skill to create the cron job. Verify it reports:
- Schedule: 2:27 AM ET
- Created date
- Expiry date (7 days)
- Prerequisite reminder

- [ ] **Step 2: Verify cron exists**

Use CronList to confirm the job was created with the correct schedule.

- [ ] **Step 3: Dry-run the orchestrator (optional)**

Manually trigger the cron job or run the orchestrator prompt once to verify:
- All 4 agents spawn and return results
- Report compiler sends an email
- Email arrives at ran@alphasecurityus.com

This is optional but recommended for first-time validation.

- [ ] **Step 4: Commit any fixes**

If testing revealed issues, fix and commit:

```bash
git add .claude/skills/vault-audit-setup/SKILL.md
git commit -m "fix: vault-audit-setup skill adjustments from testing"
```
