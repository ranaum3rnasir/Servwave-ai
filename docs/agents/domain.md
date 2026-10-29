# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root — primary domain reference (modules, tech stack, workflows, design system, API patterns, auth, vault routing).
- **The Obsidian vault** at `C:\Users\ranro\Documents\ALPHA_CRM\Vault\ALPHA_CRM_VAULT` (accessed via `mcp__obsidian__*` MCP tools). Module hub pages: `Modules/Auth.md`, `Modules/Customers.md`, etc. Architectural decisions: `Decisions/*.md`. Past lessons: `Learnings/*.md`. Hand-curated context that `CLAUDE.md` does not duplicate.
- **`memory/codebase.md`** — full directory tree with per-file descriptions (single source of truth for the file layout).

There is no `CONTEXT.md` or `docs/adr/` in this repo. `CLAUDE.md` + the Obsidian vault fill those roles. Treat them as the equivalents.

## File structure

Single-context repo. One `CLAUDE.md` at the root drives every skill's domain understanding.

```
/
├── CLAUDE.md                 ← primary domain reference
├── docs/agents/              ← agent skills configuration (this folder)
├── memory/codebase.md        ← directory tree
├── md_files/plans/           ← implementation plans
├── md_files/specs/           ← broader specs
├── backend/
└── frontend/
```

The Obsidian vault sits outside the repo but is part of the same knowledge system — see `CLAUDE.md`'s "Obsidian Knowledge Base" section for routing rules ("when to consult the vault").

## Use the codebase's vocabulary

When naming a domain concept (issue title, refactor proposal, hypothesis, test name), use the term as it appears in `CLAUDE.md` or the vault module note for that area. Examples: "estimate" not "quote"; "walkthrough" not "site visit"; "deposit" not "down payment". When in doubt, search the vault.

## Flag vault contradictions

If your output contradicts an existing Decisions note or Learnings note in the vault, surface it explicitly rather than silently overriding:

> _Contradicts [[Per-Org-Numbering-Strategy]] — but worth reopening because…_
