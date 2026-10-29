# Session Skills: end-session + start-session

## Context
We need two workflow skills to make multi-session development efficient:
- **End of session**: sync all knowledge base files + CLAUDE.md so nothing is lost between sessions
- **Start of session**: warm up Claude's context quickly with the files actually needed for the current step (MEMORY.md + CLAUDE.md are already auto-loaded; the skill reads CODE files)

## Skill 1: `/end-session`

**File:** `.claude/skills/skills/end-session/SKILL.md`

**What it does (in order):**
1. Scan codebase with Glob (exclude node_modules, .git, dist, md files/) — find new/changed source files vs `codebase.md`
2. Read all new/changed source files
3. Update `memory/codebase.md` — directory tree + file descriptions + "What's NOT Built Yet"
4. Update `memory/MEMORY.md` — build progress checkboxes + skill count
5. Update domain KB files only if their area changed:
   - `memory/api-endpoints.md` — if new routes were added
   - `memory/security-architecture.md` — if auth/middleware changed
   - `memory/business-rules.md` — if validation/permissions changed
   - `memory/data-model.md` — if schema.prisma changed
6. Update `CLAUDE.md` — directory structure tree + build progress checklist
7. Report: list of source files changed, KB files updated, current build step

**Relationship to `update-knowledge-base`:** End-session is the superset — it does everything update-knowledge-base does PLUS CLAUDE.md. Keep update-knowledge-base for mid-session KB syncs.

## Skill 2: `/start-session`

**File:** `.claude/skills/skills/start-session/SKILL.md`

**What it does (in order):**
1. Read `memory/MEMORY.md` build progress to identify current step (already in context, but confirms it)
2. Read `memory/codebase.md` — full directory tree + file descriptions for the current state
3. Based on current step, read the most relevant source files (see mapping below):
   - **Step 3 (Layout):** `frontend/src/App.tsx`, `frontend/tailwind.config.js`, `frontend/src/components/ProtectedRoute.tsx`, `memory/ui-design-system.md`
   - **Step 4 (Customers/Leads):** relevant controllers + routes when built, `memory/data-model.md`
   - **Step 5 (Estimates/Deposits):** estimate + deposit files, `memory/business-rules.md`
   - **Step 6 (Jobs):** job controller + routes, `memory/workflows.md`
   - **Step 7 (Technician):** technician-facing routes/pages
   - **Step 8 (Invoicing):** invoice + payment files
   - **Step 9 (Dashboard):** dashboard + reports files
   - **Step 10 (Polish):** test files, CI config
   - **Generic fallback:** read 5 most recently modified source files (Glob sorted by mod time)
4. Output a structured **Session Brief**:
   ```
   ## Session Brief
   **Current step:** Step X — [name]
   **Completed steps:** 1, 2, ...
   **Key files in context:** [list of what was just read]
   **What was last built:** [from codebase.md]
   **What's next:** [first action items for current step]
   **Ready.**
   ```

## Files to Create

| File | Action |
|------|--------|
| `.claude/skills/skills/end-session/SKILL.md` | Create |
| `.claude/skills/skills/start-session/SKILL.md` | Create |
| `memory/skills-reference.md` | Update — add both new skills |

## Notes
- Both skills are read-only in terms of codebase — only write to KB files and CLAUDE.md
- Skills cannot be invoked via Skill tool (project-level skills); user types `/end-session` or `/start-session` as a chat message
- MEMORY.md and CLAUDE.md are auto-loaded into every session (first 200 lines of MEMORY.md), so start-session avoids redundantly re-reading them — it focuses on source code files
- end-session replaces the manual "run update-knowledge-base" step before ending a session
