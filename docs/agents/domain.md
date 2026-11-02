# Domain Docs

How the engineering skills consume this repo's domain documentation.

## Before exploring, read these

1. **`CONTEXT.md`** at the repo root: the glossary. Use its terms; never the words it lists under _Avoid_.
2. **`docs/adr/`**: read only the ADRs whose title touches the area you are working in. Never read them all.
3. **`CLAUDE.md`**: the project rules (vendor names, accounting reads, Servy, test runner).
4. **For bugs:** the Obsidian vault at `/Users/ranroffe/ALPHA_CRM/Vault/ALPHA_CRM_VAULT`
   (`mcp__obsidian__search_notes`, or `grep -ril`), `Learnings/` first, then `Decisions/`, `Architecture/`,
   `Modules/<Module>.md`, as `CLAUDE.md` requires.

## Layout

Single context: one `CONTEXT.md` and one `docs/adr/` at the root. No `CONTEXT-MAP.md`.

## Keep them small (guardrails)

- **Glossary entries: one to three sentences.** What the term IS, plus an _Avoid_ line. No file paths,
  code, or implementation detail. Those belong in a spec, an ADR or the vault.
- **ADRs: a short paragraph** (context, decision, why). Add "Considered options" or "Consequences" only when
  a future reader would otherwise re-suggest a rejected option.
- **Size trigger:** when `CONTEXT.md` passes ~300 lines, split it into one `CONTEXT.md` per area
  (e.g. money, permissions, scheduling, communication) with a root `CONTEXT-MAP.md` pointing to them.
  Raise the split with Ran first.

## Flag conflicts

If your output contradicts an ADR or a vault Decision note, say so explicitly rather than overriding it:

> _Contradicts ADR-0004 (a refund never reopens amount due), but worth reopening because…_
