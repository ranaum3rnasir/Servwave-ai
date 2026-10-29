---
name: start-session
description: "Lite session loader: 1 bash + 1 read + terse brief. Health and focus are in auto-loaded MEMORY.md. Directory tree is in codebase.md (read once)."
user_invocable: true
---

# Start Session (v3)

## Purpose
Warm up Claude's context with git state, dev environment, and the codebase map.
Everything else is already auto-loaded:
- **MEMORY.md** — project health, KI counts, current focus, build progress
- **CLAUDE.md** — dev rules, tech stack, DB schema, API patterns, auth, design system, vault guide

This skill adds only what can't be in static files: runtime checks and the file inventory.

---

## Token Budget

| Step | Target |
|------|--------|
| 0 — Combined bash (git + env + worktrees) | ~400 |
| 1 — Read codebase.md | ~1,500 |
| 2 — Terse brief | ~300 |
| **Skill total (Messages)** | **~2,200** |

---

## Procedure

### Step 0 — Combined Runtime Check (ONE bash call)

Run everything in a single command:

```bash
echo "=== GIT ===" && git status -s && git branch --show-current && git log --oneline -3 && echo "=== WORKTREES ===" && git worktree list 2>/dev/null | tail -n +2 || echo "none" && echo "=== SERVERS ===" && node -e "require('net').connect(3000,'127.0.0.1').on('connect',function(){console.log('Backend: up');this.end()}).on('error',()=>console.log('Backend: DOWN'))" && node -e "require('net').connect(5173,'127.0.0.1').on('connect',function(){console.log('Frontend: up');this.end()}).on('error',()=>console.log('Frontend: DOWN'))" && echo "=== PRISMA ===" && cd backend && npx prisma migrate status 2>&1 | grep -iE "pending|unapplied|behind" || echo "up to date"
```

**Flags:**
- Dirty tree → "Uncommitted changes"
- Not on main → "On branch [name]"
- Worktrees found → list them
- Servers down → flag
- Pending migrations → flag

---

### Step 1 — Read Codebase Map (ONE read)

Read the codebase map using the Read tool. It lives in the repo-relative
`memory/` directory (same folder as the project knowledge files):

`memory/codebase.md`

This is the full directory tree with file descriptions. It persists in
context for the rest of the session so Claude knows where every file lives
without re-reading.

---

### Step 2 — Terse Brief (keep under 15 lines)

```
## Session Brief -- [date]

Branch: [name] | [clean/N dirty] | Worktrees: [list/none]
Servers: BE [up/DOWN] | FE [up/DOWN] | Prisma: [ok/pending]
Health: [N] Critical | [N] High | [N] Broken stages (from MEMORY.md)
Focus: [current focus from MEMORY.md]

[WARNINGS only if: dirty tree, wrong branch, servers down, migrations pending, or Critical/Broken items. Omit if none.]

Ready. What would you like to work on?
```

That's it. No file lists, no vault reads, no verbose sections.

---

## Rules
- **ONE bash call, ONE read, ONE brief.** Three tool interactions maximum.
- Health data comes from MEMORY.md (auto-loaded). Do NOT read pipeline-status.md or known-issues.md.
- Current focus comes from MEMORY.md. Do NOT read vault notes.
- Codebase map is the only file read. It persists for the session.
- Use `git status -s` (short format). Never bare `git status`.
- Filter all command output — only surface problems.
- This skill is READ-ONLY — it does not modify any files.
- Keep the brief under 15 lines. No markdown headers in the brief beyond the title.

## Maintenance
`/log-issue` and `/end-session` MUST update the Project Health and Current
Focus sections in MEMORY.md to keep the auto-loaded summary in sync.
