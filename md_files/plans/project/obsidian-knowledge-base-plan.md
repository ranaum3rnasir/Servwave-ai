# Obsidian Knowledge Base — Implementation Plan

> **Goal:** Extract all ALPHA CRM project knowledge into an Obsidian vault that acts as the single source of truth ("second brain"). Then set up workflows to keep it current as development continues.

## Context & Design Principles

Based on Andrej Karpathy's LLM Wiki pattern and our brainstorming:

- **The vault is LLM-maintained.** Claude writes and maintains all wiki pages. Ran reads, browses, and queries.
- **Knowledge compounds.** Every session adds to the wiki. Good answers get filed back as pages.
- **Cross-references on every change.** A single feature completion may touch 5-10 wiki pages.
- **Smart routing.** Claude consults the vault for architecture, decisions, planning, history, and ideas. Small code fixes → just read the code.
- **Two systems coexist:** `md_files/` = active technical plans and specs. Obsidian = the full picture (architecture, decisions, learnings, ideas, status, history).
- **Sync cadence:** End of every session (integrated into existing `/end-session` skill). Claude reminds at milestones only.

---

## Phase 1 — Vault Structure & Conventions (The Schema)

### Directory Structure

```
ALPHA_CRM_VAULT/
├── index.md                    # Project MOC — Claude's entry point, always read first
├── log.md                      # Chronological session log (append-only)
│
├── Modules/                    # One note per CRM module
│   ├── Auth.md
│   ├── Customers.md
│   ├── Leads.md
│   ├── Estimates.md
│   ├── Deposits.md
│   ├── Jobs.md
│   ├── Scheduling.md
│   ├── Invoices.md
│   ├── Payments.md
│   ├── Price-Book.md
│   ├── Attachments.md
│   ├── Search.md
│   └── Settings.md
│
├── Architecture/               # System-level knowledge
│   ├── Tech-Stack.md
│   ├── Database-Schema.md
│   ├── API-Patterns.md
│   ├── Auth-Architecture.md
│   ├── Email-System.md
│   ├── Stripe-Integration.md
│   ├── Design-System.md
│   └── Testing-Strategy.md
│
├── Decisions/                  # Why we chose X over Y
│   └── (one file per decision, named descriptively)
│
├── Ideas/                      # Inbox for future improvements
│   └── (one file per idea)
│
├── Learnings/                  # Bugs, gotchas, patterns that burned us
│   └── (one file per learning)
│
├── Status/                     # Build progress and roadmap
│   ├── Build-Progress.md       # The master checklist (Steps 1-10)
│   ├── Roadmap.md              # What's planned beyond MVP
│   └── Tech-Debt.md            # Known shortcuts and their cost
│
└── Sessions/                   # End-of-session logs
    └── (YYYY-MM-DD_summary.md)
```

### Why This Structure

- **Flat within categories** — Claude searches by text and reads by path. Deep nesting hurts discoverability.
- **Module notes are the hubs** — each one links to relevant decisions, ideas, learnings, and architecture notes. These are the backlink magnets in Obsidian's graph view.
- **index.md is the router** — Claude reads this first to find the right page. It lists every page with a one-line description, grouped by category.
- **log.md is the timeline** — append-only, parseable, shows what happened and when.
- **Decisions, Ideas, Learnings are separate directories** — not embedded in module notes — because they cross-cut modules and are independently queryable.

### Frontmatter Convention

Every note gets YAML frontmatter for queryability:

```yaml
---
type: module | architecture | decision | idea | learning | status | session
module: auth | customers | leads | estimates | deposits | jobs | scheduling | invoices | payments | price-book | attachments | search | settings | general
status: active | completed | parked | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - backend
  - frontend
  - stripe
  - prisma
  - etc.
---
```

**Rules:**
- `type` and `created` are mandatory on every note
- `module` is mandatory except for architecture and status notes (use `general` if cross-cutting)
- `status` is mandatory for ideas, decisions, and learnings
- `updated` is set whenever Claude modifies a note
- `tags` are for cross-cutting concerns (tech, area, priority)

### Wikilink Conventions

- Every mention of a module name → `[[Module Name]]` (e.g., `[[Estimates]]`)
- Every mention of an architecture concept → `[[Concept Name]]` (e.g., `[[Stripe-Integration]]`)
- Decisions reference the modules they affect: `Affects: [[Estimates]], [[Deposits]]`
- Module notes have a `## Related` section at the bottom with links to decisions, ideas, and learnings

### index.md Structure

```markdown
---
type: index
updated: YYYY-MM-DD
---

# ALPHA CRM — Project Wiki

> FSM CRM for SMB contractors (5-30 technicians). Phase 0 MVP.

## Quick Status
- **Current step:** Step 9A — Dashboard
- **Steps complete:** 10/14
- **Last session:** YYYY-MM-DD — [summary]

## Modules
- [[Customers]] — Customer CRUD, locations, stats, notes
- [[Leads]] — Lead lifecycle, assignment, walkthrough, conflict detection
- [[Estimates]] — Estimate CRUD, send with deposit config, public signing
- [[Deposits]] — Stripe/non-Stripe deposits, mark received, waive, refund
- [[Jobs]] — Standard + urgent flows, status lifecycle, charges
- [[Scheduling]] — Calendar, DnD, By-Tech grid, conflict detection
- [[Invoices]] — Invoice CRUD, send, void, Stripe checkout, deposit credit
- [[Payments]] — Payment recording, row-locked, multi-method
- [[Auth]] — Supabase Auth, JWT, RBAC, no self-registration
- [[Price-Book]] — Categories, items, image upload
- [[Attachments]] — Polymorphic, Supabase Storage
- [[Search]] — Global multi-word search, schedule scope
- [[Settings]] — App settings, state tax rates

## Architecture
- [[Tech-Stack]] — React 18, Express, Prisma, Supabase, Stripe, Resend
- [[Database-Schema]] — 19 models, key relationships, enums
- [[API-Patterns]] — REST conventions, auth chain, validation
- [[Auth-Architecture]] — JWT flow, middleware chain, rate limits
- [[Email-System]] — Resend, 11 send functions, templates
- [[Stripe-Integration]] — Checkout sessions, webhooks, deposits, invoice payments
- [[Design-System]] — Colors, typography, components, layout rules
- [[Testing-Strategy]] — 591 backend tests, Playwright E2E, test patterns

## Status
- [[Build-Progress]] — Steps 1-10 checklist
- [[Roadmap]] — Post-MVP plans
- [[Tech-Debt]] — Known shortcuts

## Recent Decisions
(last 5, linked)

## Recent Ideas
(last 5, linked)

## Recent Learnings
(last 5, linked)
```

### log.md Structure

```markdown
---
type: log
---

# Session Log

## [2026-04-08] seed | Initial vault creation
- Seeded vault with full project knowledge from CLAUDE.md, md_files/, codebase, and git history
- Created 13 module notes, 8 architecture notes, 3 status notes
- Pages created: XX

## [YYYY-MM-DD] session | Brief description
- What was built/changed
- Decisions made
- Wiki pages updated: [list]
```

---

## Phase 2 — Initial Knowledge Extraction & Seeding

This is the big one-time operation. We extract knowledge from all existing sources and populate the vault.

### Source → Vault Mapping

| Source | Extracts Into |
|--------|--------------|
| CLAUDE.md — Directory Structure | Architecture notes, Module notes |
| CLAUDE.md — Build Progress | `Status/Build-Progress.md` |
| CLAUDE.md — Tech Stack | `Architecture/Tech-Stack.md` |
| CLAUDE.md — Core Workflows | Module notes (Estimates, Jobs, Invoices) |
| CLAUDE.md — Roles & Permissions | `Architecture/Auth-Architecture.md` |
| CLAUDE.md — Design System | `Architecture/Design-System.md` |
| CLAUDE.md — API Pattern | `Architecture/API-Patterns.md` |
| CLAUDE.md — Auth Architecture | `Architecture/Auth-Architecture.md` |
| `memory/codebase.md` | Module notes (endpoints, controllers, what exists) |
| `md_files/plans/` | Referenced from module notes (not copied — plans stay in md_files/) |
| `md_files/specs/` | Referenced from module notes |
| `backend/prisma/schema.prisma` | `Architecture/Database-Schema.md` |
| Git history (key commits) | `Decisions/` and `Learnings/` (major architectural choices, bug fixes with lessons) |
| Git history (build timeline) | `Status/Build-Progress.md` (dates for each step) |

### Seeding Order

1. **index.md** — The MOC (will be updated as pages are created)
2. **Architecture notes** (8) — These are referenced by everything else
3. **Module notes** (13) — The hub pages
4. **Status notes** (3) — Build progress, roadmap, tech debt
5. **Decisions** (extract 5-10 key decisions from git history and code patterns)
6. **Learnings** (extract 3-5 key learnings from scheduler audit, Stripe integration, etc.)
7. **Ideas** (seed with known future work: Step 7, 9A, 9B, 10)
8. **log.md** — First entry documenting the seed operation

### Module Note Template

```markdown
---
type: module
module: {name}
status: active
created: 2026-04-08
updated: 2026-04-08
tags: [backend, frontend]
---

# {Module Name}

> One-line description of what this module does.

## Overview
2-3 sentences describing the module's purpose and scope.

## Key Concepts
- Concept 1 — brief explanation
- Concept 2 — brief explanation

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/resource | List all |
| POST | /api/resource | Create |
| ... | ... | ... |

## Data Model
Key models and relationships (link to [[Database-Schema]] for full detail).

## Business Rules
- Rule 1
- Rule 2

## Current State
What's built, what works, known limitations.

## Related
- Decisions: [[Decision 1]], [[Decision 2]]
- Ideas: [[Idea 1]]
- Learnings: [[Learning 1]]
- Plans: `md_files/plans/{module}/` (active technical plans)
- Depends on: [[Other Module]]
- Depended on by: [[Other Module]]
```

---

## Phase 3 — CLAUDE.md Addition

Add this section to CLAUDE.md:

```markdown
## Obsidian Knowledge Base

**Vault path:** `C:\Users\ranro\Documents\ALPHA_CRM\Vault\ALPHA_CRM_VAULT`
**Access:** MCP tools (`mcp__obsidian__*`) — search_notes, read_note, write_note, etc.

### When to Consult the Vault (Smart Routing)
- **Architecture, decisions, history, planning, ideas** → Search vault FIRST, then code
- **Small bug fixes, code-level changes** → Just read the code
- **"Why did we do X?"** → Check `Decisions/` in the vault
- **"What should I work on?"** → Read `index.md` → `Status/Build-Progress.md`
- **"How does X work?"** → Read the module note (e.g., `Modules/Estimates.md`)
- **"What ideas exist for X?"** → Search `Ideas/` with module tag
- **"What went wrong with X?"** → Search `Learnings/`

### How to Search the Vault
1. **Start with index.md** — read it to orient, find the right page
2. **search_notes** for keywords when you don't know the exact page
3. **read_note** when you know the path (e.g., `Modules/Invoices.md`)
4. **get_frontmatter** to filter by type/module/status

### Vault Conventions
- **Frontmatter:** Every note has `type`, `created`, and usually `module`, `status`, `tags`
- **Wikilinks:** Module names are always linked: `[[Estimates]]`, `[[Stripe-Integration]]`
- **index.md** is the MOC — lists every page with a one-line summary
- **log.md** is append-only — chronological record of sessions and changes

### Two-System Split
- `md_files/` = active technical plans and specs (implementation details, step-by-step)
- Obsidian vault = the full picture (architecture, decisions, ideas, status, history, learnings)
- Plans in `md_files/` are REFERENCED from vault module notes, not duplicated
```

---

## Phase 4 — Skill Extensions

### `/start-session` — Add Vault Warm-Up

After the existing Step 3 (Read Step-Relevant Source Files), add:

```
### 3.5. Read Vault Context
- Read `index.md` from the Obsidian vault (via mcp__obsidian__read_note)
- Read the module note for the current build step's module
- Check `log.md` last entry to see what was done in the previous session
- Include vault context in the Session Brief output

**Session Brief addition:**
**Vault context:**
- Last session: [date] — [summary from log.md]
- Current module state: [from module note]
- Open ideas for this module: [count]
- Recent decisions: [last 1-2]
```

### `/end-session` — Add Vault Sync

After the existing Step 5 (Update CLAUDE.md), add:

```
### 6. Update Obsidian Vault

#### 6a. Write Session Log Entry
Append to `log.md`:
- Date, type (session/ingest/lint), brief description
- What was built/changed
- Decisions made
- Wiki pages updated

#### 6b. Update Module Notes
For each module affected this session:
- Update "Current State" section
- Update "API Endpoints" if new routes were added
- Update "Business Rules" if logic changed
- Add links to any new decisions or learnings

#### 6c. Update index.md
- Update "Quick Status" (current step, last session)
- Update "Recent Decisions/Ideas/Learnings" lists
- Add any new pages to the appropriate category

#### 6d. Create Decision/Learning/Idea Notes (if applicable)
If the session involved:
- A non-obvious architectural choice → create a Decision note
- A bug that taught us something → create a Learning note
- An idea for future work → create an Idea note

#### 6e. Report Vault Updates
Add to the existing session sync report:
**Vault updates:**
- Session log: appended
- Module notes updated: [list]
- New pages created: [list]
- index.md: updated
```

---

## Phase 5 — Ongoing Operations

### Ingest (built into /end-session)
Every session syncs changes to the vault. A single session might touch:
- 1 session log entry
- 1-3 module notes
- 0-1 decision notes
- 0-1 learning notes
- 0-2 idea notes
- index.md update

### Query (built into /start-session + ad-hoc)
Claude searches the vault when:
- Starting a session (warm-up context)
- User asks architecture/decision/history questions
- Planning new work (check existing ideas, learnings, decisions)

### Lint (periodic, manual trigger)
Run periodically (e.g., weekly or at milestones) to:
- Find orphan pages (no inbound links)
- Find stale content (updated date > 2 weeks, module has changed since)
- Find missing pages (concepts mentioned but no page exists)
- Find contradictions (vault says X, code says Y)
- Suggest new questions to investigate

Could be a future `/vault-lint` skill.

---

## Execution Plan

### Step A — Create Vault Structure
- Create all directories
- Write index.md (skeleton)
- Write log.md (empty)
- Estimated: ~5 minutes

### Step B — Seed Architecture Notes (8 pages)
- Extract from CLAUDE.md + codebase
- Read schema.prisma for Database-Schema.md
- Read tailwind.config.js for Design-System.md
- Estimated: ~20 minutes

### Step C — Seed Module Notes (13 pages)
- Extract from CLAUDE.md, codebase.md, controllers, routes
- Cross-reference with each other and architecture notes
- Estimated: ~30 minutes

### Step D — Seed Status Notes (3 pages)
- Build-Progress.md from CLAUDE.md checklist + git history dates
- Roadmap.md from remaining steps + known future work
- Tech-Debt.md from code patterns and known shortcuts
- Estimated: ~10 minutes

### Step E — Seed Decisions & Learnings (8-15 pages)
- Extract from git history (major commits, merge commits)
- Extract from scheduler audit reports
- Extract from Stripe integration patterns
- Estimated: ~15 minutes

### Step F — Seed Ideas (5-10 pages)
- Future steps (7, 9A, 9B, 10) as idea seeds
- Known improvements from code comments and md_files/
- Estimated: ~10 minutes

### Step G — Finalize
- Update index.md with all pages
- Write first log.md entry
- Verify all cross-references
- Estimated: ~10 minutes

### Step H — Update CLAUDE.md & Skills
- Add Obsidian Knowledge Base section to CLAUDE.md
- Update start-session SKILL.md
- Update end-session SKILL.md
- Estimated: ~10 minutes

**Total estimated effort: Steps A-H, done in one session.**

---

## Success Criteria

After implementation, these queries should all be answerable from the vault alone:

1. "What's the current state of the project?" → index.md Quick Status
2. "How does the deposit flow work?" → Modules/Deposits.md + Modules/Estimates.md
3. "Why did we choose Supabase over Firebase?" → Decisions/
4. "What should I work on next?" → Status/Build-Progress.md + Ideas/
5. "What bugs have we hit with Stripe?" → Learnings/ (stripe tag)
6. "What tech debt exists?" → Status/Tech-Debt.md
7. "What's the API pattern for a new module?" → Architecture/API-Patterns.md
8. "What ideas exist for the invoicing module?" → Ideas/ (module: invoices)
