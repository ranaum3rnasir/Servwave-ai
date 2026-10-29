---
name: log-issue
description: "Use ONLY for pipeline-stage testing (TESTED action) or updating/closing an existing GitHub issue. Do NOT use for new bugs — those go to /to-issues. Do NOT use for new feature ideas — those go to /log-idea."
user_invocable: true
---

# Log Issue

## Purpose
Keep `pipeline-status.md` accurate in real time and manage existing GitHub issues. **New bugs and improvements go to `/to-issues`. New feature ideas go to `/log-idea`.** This skill handles: marking pipeline stages tested, updating existing issues, and the rare case of manually closing an issue not covered by a PR.

## Issue tracker
**GitHub Issues** — `ranro1/ALPHA_CRM` (private repo). See `docs/agents/issue-tracker.md` for the full label vocabulary. Local `memory/known-issues.md` and `memory/fixed-issues.md` are **archived** (`*.md.archived-2026-05-19`) and read-only.

## Trigger Phrases
Invoke this skill when Ran says things like:
- "I found a bug / issue / problem"
- "This is broken / not working"
- "I just fixed #NN / this issue"
- "I tested this stage / flow"
- "Update the files with this"
- "Log this"

---

## Procedure

### Step 1 — Identify the Action Type

| Action      | Trigger                              | What to do                                                                 |
|-------------|--------------------------------------|----------------------------------------------------------------------------|
| **NEW**     | Bug or issue found                   | Create GitHub issue + update pipeline row                                  |
| **FIXED**   | Issue was resolved (rare — usually auto-closed by PR merge) | Close GitHub issue with root-cause comment + mark pipeline row `#NN ✅`    |
| **TESTED**  | A stage was manually tested          | Update pipeline row only                                                   |
| **UPDATE**  | Existing issue needs more detail     | Post a comment on the GitHub issue + optionally relabel                    |

---

### Step 2 — Read Current State First

Always read before writing:
- `gh issue list --state open --json number,title,labels --jq '...'` — current open issues
- `memory/pipeline-status.md` — current pipeline rows + summary

Never write without reading first.

---

### Step 3 — Decide Priority + Module + Eligibility (for NEW only)

Make the call yourself — do not ask Ran. He's confirmed this should be automatic.

**Priority** (apply exactly one `priority:*` label):

| Priority   | Criteria                                                                            |
|------------|-------------------------------------------------------------------------------------|
| `critical` | Financial data wrong, data loss, security issue, blocks core pipeline entirely     |
| `high`     | Core workflow broken or unusable; blocks testing of other stages                    |
| `medium`   | Feature works but incorrectly; visible to customers; causes confusion              |
| `low`      | UI/UX issue; cosmetic; minor inconvenience                                          |

**Module** (apply exactly one `module:*` label). Valid modules: `auth`, `customers`, `leads`, `estimates`, `deposits`, `jobs`, `scheduler`, `invoices`, `payments`, `price-book`, `attachments`, `search`, `settings`, `walkthrough`, `dashboard`, `reports`, `technician-mobile`, `departments`, `email`, `general`.

**Category** (one of, optional but recommended): `bug` for things that worked and broke, `enhancement` for new feature requests.

**`auto-fix-eligible` workflow label** — apply only when ALL are true:
- Root cause is described or obvious (specific file/function/setting)
- Fix is ≤5 files
- Does NOT touch: auth, payments, Stripe, webhooks, database migrations
- The issue is `bug` (not `enhancement`)

**`ready-for-*` triage state label** — apply one:
- `ready-for-agent` — root cause clear, AFK-ready (any agent can pick up with no extra context)
- `ready-for-human` — needs human judgment (env config, multi-system feature, design call)
- `needs-info` — root cause not yet identified; needs profiling/repro first
- (Omit, or use `needs-triage`, when uncertain)

---

### Step 4 — Create the GitHub Issue (NEW)

Write the body to a temp file (avoids heredoc quoting pitfalls):

```bash
cat > /tmp/issue-body.md <<'KIEOF'
<original description in Ran's words>

## Root cause / hypothesis (if known)
<one or two sentences>

## Likely fix (if known)
<one or two sentences scoping the fix>
KIEOF

gh issue create \
  --title "[<Module>] <one-line summary>" \
  --body-file /tmp/issue-body.md \
  --label "<category>,priority:<level>,module:<m>,<triage-state>[,auto-fix-eligible]"
```

The command returns the new issue URL. Extract the issue number — this is what goes in `pipeline-status.md`.

Title convention: `[<Module name>] <short imperative or symptom>`. Examples:
- `[Estimates] PDF preview iframe renders blank in detail modal`
- `[Walkthrough] Attachment upload [+] button missing in empty state`

---

### Step 5 — Update pipeline-status.md (NEW)

Find the matching stage row. Add `#NN` to the Known Issues column. If confidence was High → drop to Medium. If Medium → drop to Low. If already Low → leave.

If the issue spans no clear single stage (cross-cutting like performance), don't force it onto a row — note it in the file's header line at the top instead.

---

### Step 6 — Close a GitHub Issue (FIXED — rare path)

Most fixes auto-close via PR merge (`Fixes #NN` in the PR body). The FIXED path is only for issues fixed without a PR (manual env config, doc-only updates, etc.).

```bash
gh issue close <number> --comment "Fixed in <commit-sha-or-deploy>: <one-sentence root cause>"
```

Then update the pipeline row: change `#NN` to `#NN ✅`. If all open issues on that row are resolved, raise confidence one level (Low → Medium). **Never raise to High** without Ran's explicit confirmation that the stage works cleanly.

---

### Step 7 — Comment on an Existing Issue (UPDATE)

```bash
gh issue comment <number> --body "Update <date>: <new info>"
```

If the new info changes the priority or auto-fix eligibility, also edit labels:
```bash
gh issue edit <number> --add-label "priority:high" --remove-label "priority:medium"
gh issue edit <number> --add-label "auto-fix-eligible"
```

---

### Step 8 — Mark a Stage Tested (TESTED)

Update `pipeline-status.md` only:
- Change tested column to `✅` (or `Manually + unit`, etc.)
- Update confidence based on what was found:
  - No issues found → `High`
  - Minor issues only → `Medium`
  - Something broken → `Low` or `Broken`
  - Not sure yet → `Unknown`

Confidence scale (exactly these): `High` | `Medium` | `Low` | `Broken` | `Unknown`.

---

### Step 9 — Update MEMORY.md Health Summary

The **Project Health** section at the top of `memory/MEMORY.md` is auto-loaded into the system prompt every session. Keep it in sync.

After any NEW / FIXED action, regenerate the issue count by running:

```bash
gh issue list --state open --json labels --jq '[.[] | .labels[].name] | group_by(.) | map({label: .[0], count: length}) | .[] | select(.label | startswith("priority:"))'
```

Update these lines:
```
- **Issues:** [N] Critical | [N] High | [N] Medium | [N] Low | [N] total open (GitHub Issues `ranro1/ALPHA_CRM`)
- **Critical:** [list of #NN with one-line summaries]
- **High:** [list of #NN with one-line summaries]
```

---

### Step 10 — Confirm Back to Ran

Output a concise summary:

```
## Issue Logged ✅

**Action:** [NEW / FIXED / TESTED / UPDATE]
**Issue:** #NN — <title>      ← URL: https://github.com/ranro1/ALPHA_CRM/issues/NN
**Labels:** <comma-list>
**Pipeline row:** <stage name> → Confidence: <level> | Issues: <list>
**Files written:** pipeline-status.md, MEMORY.md (if NEW or FIXED)
```

For FIXED, also list any vault `Learnings/` or `Decisions/` note that should be created.

---

## Rules
- Read before writing — always
- Never close an issue that has not actually been verified fixed
- Never raise pipeline confidence to High unless Ran confirms it works cleanly
- For NEW: judge priority + module yourself; do NOT ask Ran
- If the issue is cross-cutting and affects multiple pipeline stages, mention it in the pipeline header line, not in any single row
- Keep titles short and prefixed with module: `[Estimates] short symptom`
- Issue bodies should explain what's broken in Ran's words first, then add hypothesis/likely fix sections only if known
