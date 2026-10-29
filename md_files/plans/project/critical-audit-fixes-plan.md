# Critical Audit Findings Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 5 critical findings from the 2026-04-10 vault audit — no code changes, only vault notes, KB files, and CLAUDE.md.

**Architecture:** Pure documentation fixes across 3 systems: Obsidian vault (MCP tools), memory KB files (direct file edits), and CLAUDE.md (direct file edit).

**Tech Stack:** mcp__obsidian__write_note, mcp__obsidian__patch_note, Edit tool, Read tool

---

## Findings Map

| ID | Finding | Fix Location | Effort |
|----|---------|-------------|--------|
| C-1 | tag.controller.ts has no vault module note | Obsidian vault: create Modules/Tags.md | Medium |
| C-2 | pipeline-status.md claims "Open known issues: 0" (actual: 15) | memory/pipeline-status.md | Trivial |
| C-3 | pipeline-status.md claims "Fixed during test: 4" (actual: 3) | memory/pipeline-status.md | Trivial |
| C-4 | Pipeline KI cross-references are wrong (different numbering scheme) | memory/pipeline-status.md | Medium |
| C-5 | tag.controller.ts / tag.routes.ts not in CLAUDE.md | CLAUDE.md | Trivial |

C-2, C-3, and C-4 all touch the same file (pipeline-status.md), so they are combined into one task.

---

### Task 1: Create Modules/Tags.md vault note (C-1)

**Target:** Obsidian vault — `Modules/Tags.md`
**Tool:** `mcp__obsidian__write_note`
**Depends on:** Nothing

The tag module is small (2 standalone endpoints + 2 lead sub-endpoints) and tightly coupled to Leads. The vault note should be concise — document what exists, link to Leads.

- [ ] **Step 1: Create Modules/Tags.md**

Use `mcp__obsidian__write_note` with path `Modules/Tags.md`:

```markdown
---
type: module
module: general
status: active
created: 2026-04-10
updated: 2026-04-10
tags:
  - backend
---

# Tags

> Color-coded labels for lead categorization. Standalone CRUD + lead attachment.

## Overview
Tags are color-coded labels attached to leads via a many-to-many relationship (LeadTag). They support autocomplete-driven creation: users can pick an existing tag or type a new name to create one inline. Each tag has a name (unique, max 50 chars) and a hex color (default `#6B7280`).

## Data Model

| Model | Fields | Notes |
|-------|--------|-------|
| Tag | id, name (unique), color, created_at | `@@map("tags")` |
| LeadTag | lead_id, tag_id | Composite PK, cascade delete both directions |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/tags | ADMIN, SALES, DISPATCHER | List all tags (for autocomplete) |
| POST | /api/tags | ADMIN, SALES, DISPATCHER | Create tag (name + color, 409 on duplicate) |
| POST | /api/leads/:id/tags | ADMIN, SALES, DISPATCHER | Attach tag to lead (by tag_id or create-by-name) |
| DELETE | /api/leads/:id/tags/:tagId | ADMIN, SALES, DISPATCHER | Remove tag from lead |

## Key Behaviors
- **Inline creation** — `POST /api/leads/:id/tags` accepts either `tag_id` (existing) or `name` (find-or-create), making the UX seamless
- **Duplicate protection** — `POST /api/tags` returns 409 with the existing tag if name already taken; `POST /leads/:id/tags` returns 409 if tag already attached
- **No TECHNICIAN access** — Tags are a sales/dispatch tool, not field-facing
- **Cascade delete** — Deleting a lead removes all LeadTag links; deleting a tag removes all LeadTag links

## Files
- `backend/src/controllers/tag.controller.ts` — 4 handlers (list, create, addTagToLead, removeTagFromLead) + 2 Zod schemas
- `backend/src/routes/tag.routes.ts` — 2 standalone routes (GET /, POST /); lead tag routes are in lead.routes.ts
- Frontend: `frontend/src/components/leads/TagInput.tsx` — Autocomplete tag input component

## Current State
Complete. No unit tests (E2E only via lead specs). The standalone `/api/tags` routes are mounted in app.ts at line 56.

## Related
- [[Leads]] — Tags attach to leads via LeadTag
- [[Database-Schema]] — Tag and LeadTag models
- [[API-Patterns]] — 4 tag endpoints counted in the 111 total
```

- [ ] **Step 2: Update index.md to include Tags module**

Use `mcp__obsidian__patch_note` on `index.md` to add Tags to the Modules list. Insert after the Settings line:
```
- [[Tags]] — Color-coded lead labels, standalone CRUD + lead attachment
```

- [ ] **Step 3: Link from Leads.md**

Use `mcp__obsidian__patch_note` on `Modules/Leads.md` to add Tags to the Related section:
```
- [[Tags]] — Color-coded categorization labels
```

- [ ] **Step 4: Verify — read back the note**

Use `mcp__obsidian__read_note` on `Modules/Tags.md` to confirm it was created correctly.

---

### Task 2: Fix pipeline-status.md (C-2, C-3, C-4)

**Target:** `C:\Users\ranro\.claude\projects\C--Users-ranro-Documents-ALPHA-CRM-alpha-crm\memory\pipeline-status.md`
**Tool:** Edit
**Depends on:** Nothing

Three fixes in one file:
- C-2: Summary says "Open known issues: 0" → should be 15
- C-3: Summary says "Fixed during test: 4" → should be 3
- C-4: Pipeline rows use wrong KI numbers (pre-formalization numbering)

The KI cross-reference mapping (from pipeline's old numbering to known-issues.md):
- Pipeline KI-001 on "Estimate → Job creation" = scheduler stale cache after job creation → **KI-013** (Fixed)
- Pipeline KI-001 on "Job scheduling" = same issue → **KI-013** (Fixed)
- Pipeline KI-002 on "Job scheduling" = sidebar green checkmark on error → not formally tracked in known-issues.md, was fixed inline → remove reference
- Pipeline KI-003 on "Stripe payment" = public invoice card-only → **KI-016** (Fixed)
- Pipeline KI-004 on "Stripe payment" = missing payment_methods DB setting → not formally tracked, was fixed inline → remove reference

Additionally, open KIs should be linked to their relevant pipeline stages:
- KI-018 (Critical) → "Invoice generation" and "Payment recording"
- KI-009, KI-010 → "Estimate creation & send" and "Job scheduling / calendar"
- KI-017 → "Invoice send (email)"
- KI-011, KI-014, KI-015 → "Email triggers (all)"

- [ ] **Step 1: Fix pipeline table KI cross-references**

Edit the pipeline table rows to use correct KI numbers from known-issues.md:

Old:
```
| Estimate → Job creation | ✅ | Manually + unit | Medium | KI-001 ✅ |
| Job scheduling / calendar | ✅ | Manually + unit | Medium | KI-001 ✅, KI-002 ✅ |
```
New:
```
| Estimate → Job creation | ✅ | Manually + unit | Medium | KI-013 ✅ |
| Job scheduling / calendar | ✅ | Manually + unit | Medium | KI-009, KI-010, KI-013 ✅ |
```

Old:
```
| Stripe payment (invoice) | ✅ | Unit only | Low | Never tested live, KI-003 ✅, KI-004 ✅ |
```
New:
```
| Stripe payment (invoice) | ✅ | Unit only | Low | Never tested live, KI-016 ✅ |
```

Add open KI refs to stages that need them:

Old:
```
| Estimate creation & send | ✅ | Manually + unit | Medium | |
```
New:
```
| Estimate creation & send | ✅ | Manually + unit | Medium | KI-009 |
```

Old:
```
| Invoice generation | ✅ | Manually + unit | Medium | |
```
New:
```
| Invoice generation | ✅ | Manually + unit | Medium | KI-018 |
```

Old:
```
| Invoice send (email) | ✅ | Manually + unit | Medium | |
```
New:
```
| Invoice send (email) | ✅ | Manually + unit | Medium | KI-017 |
```

Old:
```
| Payment recording | ✅ | Unit only | Medium | |
```
New:
```
| Payment recording | ✅ | Unit only | Medium | KI-018 |
```

Old:
```
| Email triggers (all) | ✅ | Unit + partial manual | Low | |
```
New:
```
| Email triggers (all) | ✅ | Unit + partial manual | Low | KI-011, KI-014, KI-015 |
```

- [ ] **Step 2: Fix summary counts**

Old:
```
| Open known issues | 0 |
| Fixed during test | 4 |
```
New:
```
| Open known issues | 15 |
| Fixed during test | 3 |
```

- [ ] **Step 3: Update "Last updated" date**

Change `Last updated: 2026-04-09` to `Last updated: 2026-04-10`.

- [ ] **Step 4: Verify — read back the file**

Read the file and confirm all changes are correct.

---

### Task 3: Update CLAUDE.md directory structure (C-5)

**Target:** `CLAUDE.md`
**Tool:** Edit
**Depends on:** Nothing

Add tag.controller.ts and tag.routes.ts to the directory structure listings.

- [ ] **Step 1: Add tag controller to controllers listing**

In the `controllers/` section of the directory structure, add after `state-tax-rate.controller.ts`:
```
│   │   │   ├── tag.controller.ts        # Tag CRUD + lead tag attach/detach
```

- [ ] **Step 2: Add tag routes to routes listing**

In the `routes/` section, add after `state-tax-rate.routes.ts`:
```
│   │   │   ├── tag.routes.ts        # /api/tags/*
```

- [ ] **Step 3: Update controllers count comment**

The controllers comment currently says "Controllers (14)" — verify this count is already correct (tag.controller.ts is the 14th), or increment if needed.

- [ ] **Step 4: Verify — search CLAUDE.md for "tag"**

Grep CLAUDE.md for "tag" to confirm the entries are present.

---

## Execution Order

Tasks 1, 2, and 3 are fully independent — they can run in parallel.

## Verification

After all tasks complete:
1. Run the vault audit Agent 5 (Pipeline & Known Issues Agent) to confirm C-2/C-3/C-4 are resolved
2. Grep CLAUDE.md for "tag" to confirm C-5
3. Read Modules/Tags.md from the vault to confirm C-1

## NOT in scope
- No code changes
- No test changes
- No KI status changes (the issues themselves are not being fixed, only the documentation)
- The 12 warnings and 12 suggestions from the audit are separate work
