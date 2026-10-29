# Hermes Handoff — Nightly Automation

Hermes (always-on Mac) takes over the nightly fix-cron + vault-sync + vault-audit from the user's Windows laptop, so nothing depends on the Windows Claude Code session staying open.

## Mission split

| Job | Where it runs | When | What it does |
|---|---|---|---|
| `/log-issue` (interactive) | Windows laptop | On demand | User reports a bug → creates a GitHub issue with labels |
| **fix-cron** | **Hermes** | 1:00 AM ET daily | Picks up to 5 `auto-fix-eligible` GitHub issues, opens one PR each against `staging` |
| **vault-sync** | **Hermes** | 2:30 AM ET daily | For each PR merged in the last 24h, writes `Learnings/<slug>.md` + appends to `log.md` in the vault repo, pushes |
| **vault-audit** | **Hermes** | 2:45 AM ET daily | Reads vault clone + GitHub issues/PRs, emails findings to ran@alphasecurityus.com via Resend MCP |
| Obsidian Git plugin | Windows laptop | Continuous (Obsidian open) | Auto-pulls Hermes's vault writes; auto-pushes user's edits |

## Architecture

```
┌──────────────────────────────┐                 ┌──────────────────────────────┐
│  Windows (interactive)       │                 │  Hermes (Mac, always-on)     │
│  ─────────────────────       │                 │  ─────────────────────       │
│  /log-issue → GitHub issue   │                 │  cron OR launchd schedule    │
│  Obsidian + Obsidian Git     │                 │   1:00 AM ET → fix-cron      │
│   plugin (auto-pull/push)    │                 │   2:30 AM ET → vault-sync    │
│                              │                 │   2:45 AM ET → vault-audit   │
└──────────────┬───────────────┘                 └──────────────┬───────────────┘
               │                                                │
               │ pushes vault edits        pulls + pushes vault │
               ▼                                                ▼
       ┌──────────────────────────────────────────────────────────┐
       │  GitHub (single source of truth)                          │
       │   • ranro1/ALPHA_CRM         — code, issues, PRs          │
       │   • ranro1/ALPHA_CRM_VAULT   — Obsidian vault             │
       │   • Tracking issue #39       — fix-cron state JSON        │
       └──────────────────────────────────────────────────────────┘
```

## Configuration values

| Key | Value |
|---|---|
| Code repo | `ranro1/ALPHA_CRM` |
| Vault repo | `ranro1/ALPHA_CRM_VAULT` |
| Suggested vault clone path on Hermes | `~/vaults/ALPHA_CRM_VAULT` |
| Tracking issue (fix-cron state) | `#39` in `ranro1/ALPHA_CRM` |
| Timezone | America/New_York (Hermes will need to translate to UTC if cron uses UTC) |
| Email recipient | `ran@alphasecurityus.com` |
| Email sender (Resend) | `vault@alphasecurityus.com` |

## One-time setup checklist (Hermes)

```bash
# 1. Verify prerequisites
claude --version          # Claude Code installed
gh auth status            # gh CLI authed with repo scope to ranro1/ALPHA_CRM
git config user.name      # commits attribute correctly
node --version            # Node 20+ (for backend test runs)
npm --version

# 2. Code repo — already cloned on Hermes per user. Verify it's up to date:
cd <path/to/alpha_crm>
git fetch origin && git pull origin main

# 3. Vault repo — fresh clone
mkdir -p ~/vaults && cd ~/vaults
git clone https://github.com/ranro1/ALPHA_CRM_VAULT.git
cd ALPHA_CRM_VAULT
git config user.email "ranro3@gmail.com"
git config user.name "ran.roffe"

# 4. Worktree parent dir for fix-cron (Hermes equivalent of alpha_crm-worktrees)
mkdir -p ~/alpha_crm-worktrees   # or wherever Hermes prefers

# 5. (Optional but recommended) Install Resend MCP on Hermes for vault-audit emails
#    See https://github.com/resend/mcp-send-email — needs RESEND_API_KEY env var.

# 6. Set Hermes timezone to America/New_York OR translate cron times to UTC:
#    1:00 AM ET → 06:00 UTC (during EDT) / 05:00 UTC (during EST)
#    2:30 AM ET → 07:30 UTC / 06:30 UTC
#    2:45 AM ET → 07:45 UTC / 06:45 UTC
#    Simpler: set Hermes TZ to ET (sudo systemsetup -settimezone America/New_York) and use ET in cron.
```

## Invocation pattern

Each scheduled job invokes Claude Code headlessly:

```bash
claude -p "$(cat /path/to/orchestrator-prompt.md)" --dangerously-skip-permissions
```

**About `--dangerously-skip-permissions`:** Recommended for these jobs because the orchestrator's blast radius is tightly scoped (worktrees off `staging`, never touches `main`, no destructive ops). Hermes should confirm this is acceptable before first run. If Hermes prefers to wrap each action in a more constrained permission profile, that's fine too.

**About Claude Code vs. Codex on Hermes:** The orchestrators below are written in Claude Code idiom (`Read`/`Edit`/`Glob`/`Grep`/`Bash`/`Agent` tools, `mcp__*` for MCPs). If Hermes prefers Codex, it can port them — the workflow logic is platform-agnostic; only the tool calls differ. Either way, the end states (PRs opened, vault notes written, email sent) are identical.

## Job 1 — fix-cron (1:00 AM ET)

**Source of truth for the prompt:** `.claude/skills/fix-issues-setup/SKILL.md` in this repo, "Orchestrator Prompt" section.

**Hermes adaptations to that prompt:**

1. **State storage** — instead of reading/writing `memory/fix-agent-state.json` (Windows-local), read/write the body of tracking issue **#39**:
   - **Read:** `gh issue view 39 --json body --jq .body > /tmp/state.json`
   - **Write:** `gh issue edit 39 --body-file /tmp/state.json`
   - Schema is documented in issue #39's current body.
2. **Update `last_heartbeat`** on every run so the vault-audit can detect Hermes outages.
3. **Drop the "append to vault log.md" step** (STEP 10 in the skill). The vault-sync job at 2:30 AM handles all vault writes.
4. **Worktree path** — replace `C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\fix-<NN>-<slug>` with `~/alpha_crm-worktrees/fix-<NN>-<slug>` (or wherever Hermes set it up).
5. **Deadline check** — keep the 01:30 abort, but the wall-clock targets are now in ET (Hermes local). If Hermes runs in UTC, translate.

Cron line (Hermes local time = ET):
```cron
0 1 * * *  cd /path/to/alpha_crm && claude -p "$(cat /path/to/hermes-fix-cron-prompt.md)" --dangerously-skip-permissions >> /var/log/hermes/fix-cron.log 2>&1
```

## Job 2 — vault-sync (2:30 AM ET)

**New job.** Embedded prompt:

```
You are the Vault Sync agent for ALPHA CRM. Your job: for each PR merged into the project's staging or main branch in the last 24 hours, write a Learnings/ note (if substantive) and a log.md entry to the Obsidian vault, then push.

VAULT REPO: ~/vaults/ALPHA_CRM_VAULT
CODE REPO: <Hermes's local clone path>

SEQUENCE:

1. Sync vault: cd ~/vaults/ALPHA_CRM_VAULT && git pull origin main

2. Get yesterday's merged PRs:
   gh pr list --repo ranro1/ALPHA_CRM --state merged --search "merged:>=$(date -v-1d +%Y-%m-%dT%H:%M:%S) base:staging" --json number,title,body,mergedAt,closingIssuesReferences

   Also include PRs merged to main (the staging→main promotion may have happened): repeat with base:main.

3. Filter for SUBSTANTIVE fixes — skip if title is purely typo/lint/whitespace.
   A fix is substantive if its PR body contains a "Root cause" section or it closes a labeled issue with priority:medium or above.

4. For each substantive PR, write Learnings/<slug>.md where <slug> is derived from the PR title (lowercase, hyphens, max 40 chars). Skip if a file with the same slug already exists today.

   File format:
   ```
   ---
   type: learning
   module: <pick from closed issue's module:* label, or 'general'>
   created: <YYYY-MM-DD>
   updated: <YYYY-MM-DD>
   tags: [fix, auto-sync]
   ---

   # <Original PR title>

   **PR:** #<NN> · **Closes:** #<issue_NN> · **Merged:** <date>

   ## What broke
   <one or two sentences from issue body>

   ## Root cause
   <copy from PR body "Root cause" section>

   ## Fix
   <copy from PR body "Fix" section>
   ```

5. Append one entry to ~/vaults/ALPHA_CRM_VAULT/log.md (oldest entries at top — APPEND at the bottom):
   ```
   ## [<YYYY-MM-DD>] vault-sync | Merged PRs → vault notes

   | PR | Closes | Title | Note |
   |----|--------|-------|------|
   | #NN | #NN | <title> | [[Learnings/<slug>]] |
   ...

   <N> notes written. <M> non-substantive PRs skipped.
   ```

6. Commit + push vault:
   ```
   cd ~/vaults/ALPHA_CRM_VAULT
   git add Learnings/ log.md
   git commit -m "vault: daily sync <YYYY-MM-DD>" --no-gpg-sign  # only if no GPG configured
   git push origin main
   ```

7. If push fails due to non-fast-forward (someone edited the vault concurrently), pull --rebase and retry once. If still fails, log to /var/log/hermes/vault-sync-conflicts.log and exit non-zero.

RULES:
- Never edit existing Learnings/ files. Only create new ones.
- Never edit module notes, decision notes, or Status/* notes — those are user-edited.
- Append to log.md only; never delete entries.
- Skip PRs whose title contains "Merge branch" or "Merge pull request" (these are merge commits, not fixes).
```

Cron line:
```cron
30 2 * * *  cd /path/to/alpha_crm && claude -p "$(cat /path/to/hermes-vault-sync-prompt.md)" --dangerously-skip-permissions >> /var/log/hermes/vault-sync.log 2>&1
```

## Job 3 — vault-audit (2:45 AM ET, optional)

**Source of truth:** `.claude/skills/vault-audit-setup/SKILL.md` in this repo.

**Hermes adaptations:**

1. **Vault access** — instead of `mcp__obsidian__*` tools, Hermes reads the vault clone at `~/vaults/ALPHA_CRM_VAULT` via filesystem ops (Read/Glob/Grep). Every vault check is implementable as file reads:
   - Orphan notes → `grep -r "[[NoteName]]"` across the vault
   - Broken wikilinks → for each `[[Link]]`, check if `Link.md` exists anywhere in the vault
   - Missing/inconsistent frontmatter → parse YAML at top of each `.md`
   - Stale notes → check `mtime` on each file
   - Empty sections → grep + content extraction
2. **Email** — use Resend MCP if installed on Hermes; otherwise post the audit summary as a comment on tracking issue #39.
3. **Agent 5 / Part B (Pipeline Coverage)** — `memory/pipeline-status.md` lives on Windows-only and is not in any repo. Skip Part B (controller/route/test coverage matrix) OR have Hermes generate a synthetic version from `gh issue list` + `find backend/src/__tests__ -name "*.test.ts"`.
4. **Cron day banner** — drop. Hermes scheduler doesn't auto-expire; we keep running indefinitely.

Cron line:
```cron
45 2 * * *  cd /path/to/alpha_crm && claude -p "$(cat /path/to/hermes-vault-audit-prompt.md)" --dangerously-skip-permissions >> /var/log/hermes/vault-audit.log 2>&1
```

## First-run validation

Run each job once manually before enabling the schedule:

```bash
# 1. Dry-run fix-cron at noon when there's an obviously auto-fixable issue open
cd <path/to/alpha_crm>
claude -p "$(cat /path/to/hermes-fix-cron-prompt.md)" --dangerously-skip-permissions

# Verify on GitHub:
# - One or more PRs opened against staging
# - Tracking issue #39 body updated with today's attempts
# - last_heartbeat field is fresh

# 2. After at least one PR is merged, dry-run vault-sync
claude -p "$(cat /path/to/hermes-vault-sync-prompt.md)" --dangerously-skip-permissions

# Verify:
# - New file in ~/vaults/ALPHA_CRM_VAULT/Learnings/
# - log.md has a new entry at the bottom
# - git log shows a "vault: daily sync" commit pushed

# 3. Dry-run vault-audit
claude -p "$(cat /path/to/hermes-vault-audit-prompt.md)" --dangerously-skip-permissions

# Verify:
# - Email arrived (or comment posted on issue #39)
```

## Failure modes & recovery

| Failure | Symptom | Fix |
|---|---|---|
| Hermes offline / quiet | tracking issue #39 `last_heartbeat` >48h old | Restart Hermes; verify scheduler entries; check `/var/log/hermes/fix-cron.log` |
| gh auth expired | Cron run fails with 401 | `gh auth refresh` on Hermes |
| Vault push conflict | vault-sync logs to `vault-sync-conflicts.log` | Manually pull/rebase in `~/vaults/ALPHA_CRM_VAULT` once, push |
| Claude quota exceeded | All jobs hard-fail; PRs not opened | Wait for quota reset or upgrade plan |
| Resend API failure (vault-audit email) | Audit ran but no email | Audit fallback posts comment on issue #39 — check there |

## What stays on Windows (user side)

- `/log-issue` skill — interactive issue creation when finding bugs
- Obsidian (interactive editing)
- Obsidian Git plugin — auto-syncs vault repo while Obsidian is open
- `memory/pipeline-status.md` — per-stage confidence tracker, maintained by `/log-issue`
- `memory/MEMORY.md` health summary — auto-loaded at session start
- The vault audit's vault MCP-specific checks (if anything bypasses Hermes for any reason)

## User to-do after Hermes is configured

- [ ] Install Obsidian Git plugin on Windows ([docs](https://github.com/Vinzent03/obsidian-git))
  - Settings → Community plugins → search "Obsidian Git" → install + enable
  - Settings → Obsidian Git → set "Vault backup interval" to e.g. 5 minutes
  - First-run: it'll prompt for the remote — point at `https://github.com/ranro1/ALPHA_CRM_VAULT.git`
- [ ] Verify the first Hermes fix-cron run produces a PR (within 24h of cron enable)
- [ ] Verify Obsidian Git plugin pulls Hermes's first vault-sync within a few minutes of vault-sync running
