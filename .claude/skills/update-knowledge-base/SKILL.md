---
name: update-knowledge-base
description: "Update the project knowledge base with current codebase state and project context. Use when the user runs /update-knowledge-base."
user_invocable: true
---

# Update Knowledge Base

## Purpose
Scan the entire codebase, compare it against the existing knowledge base files, and update them to reflect the current state of the project.

## Knowledge Base Location
`memory/` at the repository root (repo-relative; same on every machine).

## Files to Update

### 1. `codebase.md` — Current codebase state
- Scan the full directory tree (exclude node_modules, .git, md files/)
- Read all source files that are new or have changed
- Update the directory tree
- Update file descriptions, key configs, and dependency versions
- Update the "What's NOT Built Yet" section based on current progress

### 2. `MEMORY.md` — Master index + build progress
- Update the "Build Progress" checklist based on what steps are actually completed
- Update the Knowledge Base Index if new files were added
- Keep it under 200 lines (truncated beyond that in system prompt)

### 3. `data-model.md` — If schema.prisma changed
- Re-read `backend/prisma/schema.prisma`
- Update models, enums, relationships, indexes

### 4. `api-endpoints.md` — If new routes were added
- Scan `backend/src/routes/` (or wherever routes live)
- Update endpoint listings

### 5. `business-rules.md` — If validation/permission logic changed
- Scan validators, middleware, service files
- Update rules and permission matrix

### 6. `security-architecture.md` — If auth/security changed
- Check middleware, auth files, Stripe integration
- Update security documentation

### 7. `ui-design-system.md` — If design tokens or components changed
- Check tailwind.config.js, component patterns
- Update design system docs

### 8. `development-plan.md` — If milestones changed
- Update phase progress based on CLAUDE.md and actual code
- Mark completed steps

## Procedure

1. **Explore**: Use Glob/Grep to find all source files. Compare against the directory tree in `codebase.md` to identify what's new or changed.

2. **Read changes**: Read files that are new or modified since last update. Focus on:
   - New directories and files
   - New route definitions
   - New components or pages
   - Schema changes
   - Config changes
   - New dependencies in package.json

3. **Update selectively**: Only update knowledge base files where changes are relevant. Don't rewrite files that haven't changed.

4. **Report**: After updating, provide a brief summary of what changed:
   - Files added/modified in the codebase
   - Knowledge base files updated
   - Current build progress status

## Rules
- Read before writing — always read the current knowledge base file before updating
- Keep descriptions concise — this is a reference, not documentation
- Preserve existing structure — don't reorganize unless necessary
- Don't remove information unless it's outdated or wrong
- Update CLAUDE.md build progress checklist to match reality
