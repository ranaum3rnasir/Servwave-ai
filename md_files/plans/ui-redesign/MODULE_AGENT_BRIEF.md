# Module agent brief - rebuilding one module on the CRM UI kit

Read this in full before touching anything. It is the contract for every module branch.
Plan: `UI_KIT_FULL_MIGRATION_PLAN.md`. Your module's behaviour: `md_files/specs/ui-redesign/<module>-behavior-map.md`.

## What you are doing

Rebuilding one module's pages on the CRM UI kit (`frontend/src/ui-kit/`), as **new files** under
`frontend/src/pages/v2/<module>/`. The legacy pages stay exactly where they are and keep working.

This is a **presentation swap**. Business logic, data fetching, mutations, permissions, validation
and routing behaviour must survive unchanged.

## The reference implementation

`frontend/src/pages/v2/leads/` is a finished, user-approved module. Read it before you design
anything. It shows the page shape, how the kit's DataTable is driven, how filters and dialogs are
composed, and how `v2Path` is used for navigation between v2 pages.

## Order of work

1. **Read.** Your behaviour map, then your legacy pages, then `pages/v2/leads/`. Never state
   anything about code you have not opened.

   **The maps are stale. Treat them as orientation, never as specification.** They were written
   2026-07-29 and the codebase has moved under them. Verified examples:

   - The **estimates** map describes `EstimateDetailPage.tsx` and `EstimateFormPage.tsx`, four
     routes, and a tabbed detail card. Both files have since been deleted; there are three routes;
     the detail page is now a workspace with a 320px rail and no tab strip; `/estimates/new` is a
     redirect that POSTs an empty draft; and the API returns `won`/`archived` where the map says
     `approved`/`cancelled`.
   - The **invoices** map describes a Notes tab, a payment-waterfall card and a `window.confirm`
     delete, none of which exist, and misses IconRail, receipt cards, card service fees, PDF
     preview, tags and bulk send.

   **The task brief you were given may be stale too** - file counts and component names in it come
   from the same era. The estimates brief named 18 components where 15 exist, and pointed at a
   `crm/LineItemsEditor` that the module does not use.

   So: before planning anything, list the module's actual files and read them. Where code and map
   disagree, **the code wins**, and every such disagreement goes in your report. Finding that your
   map is wrong is a normal outcome, not a blocker, and not a reason to stop and ask.
2. **Enumerate.** Grep every `@/components/...` import across your module's pages into a checklist.
   This list is the definition of done. You must account for **every** row.
3. **Map each import** to its kit equivalent (the table in `UI_KIT_MISSING_COMPONENTS.md` section 1
   covers the common ones). No equivalent -> use the old component and write a ledger row.
4. **Build** under `pages/v2/<module>/`.
5. **Register** by adding `pages/v2/routes/<module>.paths.ts` and
   `pages/v2/routes/<module>.routes.tsx`. Read `pages/v2/routes/README.md` first.
6. **Write your ledger**: `md_files/plans/ui-redesign/gaps/<module>-missing-components.md`.
   Format in `md_files/plans/ui-redesign/gaps/README.md`. The Replaced table is not optional -
   it is how the audit works.
7. **Verify**: `npx tsc --noEmit` and `npx vitest run` in `frontend/`. Report what actually happened.

## Hard rules

**Never edit a shared file.** Fourteen branches are running in parallel off one base. Do not touch
`V2Routes.tsx`, `routes/index.tsx`, `routes/paths.ts`, `uiV2.ts`, `navSections.ts`, `V2AppLayout.tsx`,
or any legacy page or component. Registration is additive by design. If you believe you need a
change in a shared file, **stop and escalate** - that is a signal, not an obstacle.

**Never fork business logic.** Import the existing hooks, TanStack queries, zod schemas,
`lib/ability.ts` and capability checks. If a behaviour cannot be reproduced without changing shared
logic, **stop and escalate**. Copying a hook into your module to tweak it is the failure mode this
rule exists to prevent.

**Guards are copied, not designed.** Same `ProtectedRoute` roles, same `RequireFeature` key, same
route order as `App.tsx`. A restyle must not change who can reach a page or what they can do on it.

**Carry over every `data-testid`.** They are the e2e selector surface and must survive cutover.
Where the legacy page has no testid and the map lists an accessible name as the hook, preserve the
accessible name instead.

**Stay in scope.** You will find bugs. Log them in your ledger's "Observed but not fixed" table and
move on. Fixing them here makes the diff unreviewable and mixes a restyle with a behaviour change.

## Repo boundaries (from CLAUDE.md, non-negotiable)

- **Design tokens only.** Never a raw hex or a raw Tailwind palette class in a component. Tokens
  live in `frontend/src/design-system/tokens.css`.
- **Plain hyphens `-`.** Never em or en dashes, in prose, comments, commit messages or code.
- **No AI attribution in any git artifact.** Conventional-commit lines only. No `Co-Authored-By`,
  no "Generated with".
- Never commit to `main` or `staging`. Your branch merges into the UI integration branch only.

## Charts are a no-touch boundary

The kit ships no chart component. Reports and Dashboard keep `recharts` and the
`design-system/tokens.ts` accessors. Only the chrome around a chart changes - the card it sits in,
the tiles above it, the filter bar beside it. Colour inside a chart carries meaning (green up, red
down), so substituting a token inside a chart prop is a behaviour change, not a restyle.

## What "done" means

- every row of your import checklist accounted for, in the ledger's Replaced table
- `npx tsc --noEmit` clean
- `npx vitest run` with no NEW failures (the suite has pre-existing failures; establish which by
  running it once before you start, and report the delta, not the raw number)
- every legacy page still renders unchanged - you did not edit any of them
- your ledger written, including gaps and out-of-scope observations

## Your report back

- the import checklist, with what replaced what
- the gaps you hit and what you did instead
- test results as actually run, with the before/after delta
- anything you escalated or could not determine
- anything you noticed that is out of scope
