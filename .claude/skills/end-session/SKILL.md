---
name: end-session
description: "End-of-session save: write only what is worth keeping to the Obsidian vault (lessons, decisions, ideas, module facts, open state). Touches nothing else - no repo files, no memory/, no CLAUDE.md."
user_invocable: true
---

# End Session

## Purpose
Keep what the next session can't recover on its own, and nothing more. The vault is the only destination.

**Never write:**
- repo files (`memory/`, `CLAUDE.md`, `md_files/`, plans, anything tracked)
- the auto-memory directory under `~/.claude/projects/`
- Linear or GitHub issues
- git commits

If the MCP server `mcp__obsidian__*` is unavailable, stop and say so. Do not fall back to local files.

Vault: `/Users/ranroffe/ALPHA_CRM/Vault/ALPHA_CRM_VAULT`. Always use the `mcp__obsidian__*` tools.

## The bar: what is worth saving

Save something only if **both** tests pass:

1. **It can't be recovered.** The code, `git log`, the PR, the issue tracker and the existing vault notes don't already say it.
2. **It changes behaviour.** A future session that knows it would act differently: check a different thing, avoid a trap, or respect a ruling.

What passes, and where it goes:

| Kind | What it is | Where |
|---|---|---|
| **Learning** | A lesson that wasn't obvious: a trap, a misleading signal, or a measured fact that contradicted an assumption or the docs. It includes *how to tell* next time. | `Learnings/<The-Lesson-As-A-Claim>.md` |
| **Decision** | A ruling from Ran, or a design choice, together with **why** and what was rejected. | `Decisions/<The-Choice-As-A-Claim>.md` |
| **Idea** | Future work Ran wanted kept that was not filed as an issue. | `Ideas/<Title>.md` |
| **Module fact** | A module now behaves differently: a new business rule, a changed flow, a new constraint. | Edit `Modules/<Module>.md` in place (Business Rules / Current State) |
| **Infra / architecture fact** | How prod, CI, the hosting or the security setup actually works, where that differs from what was believed. | Edit the matching `Architecture/*.md` in place |
| **Open state** | Something unfinished that the next session must pick up: a step waiting on Ran, a blocker, a follow-up that was promised. | `Status/Current-Focus.md` (replace stale lines, don't append history) |

**Never saved, even if it feels significant:**
- A narrative of what was done this session, or file lists, SHAs, PR numbers or test counts as a story. Git and GitHub hold these.
- Anything already captured in an issue, a PR description or an existing note. Link to it at most.
- CI flakes that fit a signature already recorded.
- Secrets, tokens, passwords, env values (or partial ones), or real customer names.
- Copilot (Servy) internals written up as live defects.
- Guesses. Only measured or confirmed facts. If something is unverified, say so in the note or leave it out.

Most sessions produce **0–2 notes**. A session with nothing worth saving writes nothing, and that is a valid outcome.

## Procedure

### 1. Pick candidates
Review the session and list each candidate against the table above. Apply both tests and drop anything that fails. Watch in particular for:
- a moment where something was misdiagnosed or went in circles, and what finally showed the truth
- a correction from Ran
- a ruling from Ran

These are the highest-value lessons.

### 2. Search before writing
For each survivor, `mcp__obsidian__search_notes` for its key terms across `Learnings/`, `Decisions/`, `Architecture/` and `Modules/`.
- **An existing note covers it:** patch that note by adding a dated section, and bump `updated`. Do not create a near-duplicate.
- **An existing note is now wrong:** correct it. Say what changed and when.

### 3. Write
New notes use this frontmatter:
```yaml
---
type: learning | decision | idea
module: <module or platform>
status: active            # decisions/ideas only
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [..]
---
```
Structure the body like this:
- **Bold one-paragraph claim.** This is the lesson itself.
- **What happened.** Brief, with the concrete evidence (the measured output).
- **How to apply.** Numbered and actionable.
- **Related.** `[[links]]` to related notes.

Name the file after the lesson, not the incident. For example, use `Cloudflare-Picks-The-Zone-By-Hostname-Not-IP`, not `Origin-Verify-Session`.

### 4. Link it in (only for new notes)
- `index.md`: add one line under **Recent Learnings / Recent Decisions / Recent Ideas**, in the form `- [[Note]] - one sentence. (YYYY-MM-DD)`. Don't touch Quick Status or anything else in index.md.
- `log.md`: add **one** entry of at most three lines, right after the frontmatter (the log is newest-first; `write_note` append mode puts it at the bottom, so don't use that):
  ```
  ## YYYY-MM-DD | <one-line topic>
  - Saved: [[Note-A]], [[Note-B]]; updated [[Module]]
  ```
  If nothing was saved, add no log entry.

### 5. Report
Keep it short:
```
Saved to vault:
- new: [[...]] - why it passed the bar
- updated: [[...]] - what changed
Skipped: <one line per notable candidate that failed the bar, and which test>
```
If nothing was saved, say "Nothing worth saving this session" and give one line on why.
