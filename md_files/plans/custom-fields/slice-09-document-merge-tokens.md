# Slice 9 - Merge tokens in document templates

**Parent:** SRVW-115 · **Type:** AFK · **Blocked by:** Slice 6
**Not approved to start.**

## What to build

Custom-field values become referenceable from document templates, so an org can print the gate code
it captured at intake onto the work order it hands the technician.

This is where the `key` slug from slice 1 earns its place. Tokens bind to the human-readable slug -
`{{job.custom.gate_code}}` - and resolve slug -> definition -> UUID at render time. Nobody types a
UUID into a template.

Behaviour that has to be decided up front, because each has a wrong default:

* **Missing value** - renders empty, not the literal token text and not a crash.
* **Archived definition** - a template referencing it keeps rendering historical values rather than
  breaking every previously-issued document.
* **Renamed slug** - either rewrite existing templates or resolve through a slug history. Silently
  breaking live templates is not acceptable.
* **Token discovery** - the template editor lists available custom tokens per entity, or nobody finds
  them.

Scope note: ServWave has two fixed PDF templates today plus the branding surface. This slice adds
tokens to what exists; the document designer itself is SRVW-175 and is not in this program.

## Acceptance criteria

- [ ] Custom-field tokens resolve in document templates for every supported entity
- [ ] Tokens bind to the slug, not the UUID, and survive a label rename with no template edit
- [ ] A slug rename either rewrites referencing templates or resolves through history; live templates never silently break
- [ ] A missing value renders empty; an archived definition still renders stored historical values
- [ ] All five field types render sensibly, with dates and numbers formatted per org conventions rather than raw JSON
- [ ] The template editor surfaces the available custom tokens per entity
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Blocked by

- Slice 6 (MVP complete)
