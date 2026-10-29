# UI Kit Migration - Primary Goal & Working Contract

Status: **APPROVED 2026-07-29** - work in progress (created 2026-07-29)
Owner: ront3t
This file is the durable statement of intent. If context is lost, re-read this first.

---

## 1. The user's original instructions (verbatim intent)

Replace the whole UI interface of ServWave by swapping old components for the new
components already built under the `crm-ui-kit*` folders. Specifically:

1. Go over all the pages of this project, one by one.
2. Do a full web-crawl of the project's web pages and map everything that happens
   and opens after events, so it can be replicated later with the new components.
3. After mapping each page with all its events, create branches for each page.
4. In each branch, create a new page with the new components. **Do not hurt the
   business logic - replace UI components only.**
5. Spawn agents: an agent for mapping, an agent for creating pages, agents for
   testing that everything still works, an agent for code review, and more as needed.
6. Use git worktrees to work in parallel on each page for efficiency.
7. After mapping, developing and testing are done, open a PR per branch and **wait
   for approval**. Use tags or meaningful names so branches are identifiable on the
   GitHub PR page.
8. Before starting any work, write this md file and get approval.
9. Chrome debugging is available against the live page `https://servwave-demo.vercel.app/jobs`.

**Follow-up instructions (2026-07-29):**

10. **Keep React 19.** Do not downgrade the kit - upgrade the app instead.
11. **Create new pages, do not delete the old ones.** Keep the originals in place.
12. **Build a new presentation layer alongside the old one**, for comparison and rollback.

**Non-negotiable:** business logic, data fetching, mutations, permissions,
validation and routing behaviour must survive unchanged. This is a presentation-layer
addition, not a rewrite.

---

## 2. Decisions confirmed by the user (2026-07-29)

| # | Question | Decision |
|---|----------|----------|
| 1 | Token reconciliation | **Port kit tokens into `design-system/tokens.css`** as tier-1 primitives + tier-2 semantic aliases. Keep `tailwind.config.js` as the mapping layer. |
| 2 | Branch granularity | **One branch per module (~13 PRs)**, not one per route. |
| 3 | Foundation | **Foundation PR first.** Page branches are cut from the merged foundation. |
| 4 | PR base | **Target `staging`.** Never commit directly to `main` or `staging`. |
| 5 | React version | **Upgrade the app to React 19.** The kit stays as authored. |
| 6 | Coexistence | **Parallel `/v2` routes plus a `VITE_UI_V2` flag.** Old pages stay live and untouched. |
| 7 | Component sourcing | **Kit components ONLY in v2 pages.** No old shared UI components. The kit's `DataTable` replaces `ResizableTable`, `StatCard` replaces `KpiStrip`, kit `Sheet`/`Select`/`Combobox`/`Card` replace their app equivalents. The app's components stay untouched for the old pages. |

### 3a. The one exception to kit-only (decision 7)

**Charts.** The kit ships no chart component - 21 UI primitives, 6 form, 9 data, 7 layout,
10 CRM domain, and not one chart. Reports and Dashboard therefore keep `recharts` and the
`design-system/tokens.ts` `token()` / `chartPalette` / `severityRamp` accessors, because
there is no new component to move to. Only the chrome around a chart changes: the card it
sits in, the KPI tiles above it, the filter bar beside it.

Chart internals are a hard no-touch boundary. Colour there carries meaning (green up / red
down; the severity ramp gets worse as it goes), so a token substitution inside a chart prop
is a behaviour change, not a restyle.

---

## 3. The coexistence model (requirements 11 + 12)

```
/jobs      ->  pages/JobsPage.tsx       (old, always live, never modified)
/v2/jobs   ->  pages/v2/JobsPage.tsx    (new, always live)

VITE_UI_V2=true   =>  /jobs also renders the v2 page
Rollback          =>  unset the flag, or drop the /v2 route block
```

Rules that follow from this:

- **No existing page file is edited or deleted.** New files land under
  `frontend/src/pages/v2/`, mirroring the existing structure.
- Both layers are live at once, so any v2 page can be diffed against its original
  in two browser tabs at the same URL path plus prefix.
- The router gains one `/v2/*` block and one flag resolver. That is the only edit
  to `App.tsx`, and it is additive.
- Shared non-page code (hooks, queries, stores, `lib/ability.ts`, zod schemas) is
  **imported by v2 pages, never forked.** If a v2 page needs a change in shared
  logic, that is a signal the swap is not purely presentational - stop and raise it.
- Rollback at any point is deleting the `/v2` block and the `pages/v2/` directory.

---

## 4. What actually exists (verified, not assumed)

Read from the repo on 2026-07-29:

- **App routes:** ~50 real routes in `frontend/src/App.tsx`.
- **Page files:** 105 `.tsx` files under `frontend/src/pages/`.
- **Largest pages (risk concentration):** `SchedulePage.tsx` 3,290 lines,
  `JobDetailPage.tsx` 1,523 lines, `JobsPage.tsx` 501 lines.
- **Kit source:** `crm-ui-kit-complete_1/crm-ui-kit/src/` - 68 files.
  21 UI primitives, 6 form, 9 data (DataTable suite), 7 layout, 10 CRM domain
  components, plus a reference `pages/jobs/` implementation.
- **Kit previews:** `crm-ui-kit-previews/previews/` - 14 files.
  `jobsPagePreview.html` is described by the kit authors as the behavioural spec.
- **Root entry** uses `ReactDOM.createRoot` already, so the React 19 root API needs
  no change.
- **`node_modules` is not installed anywhere in the repo.** Every dependency claim
  below is from `package.json` text, not from a resolved tree. Phase 0 verifies
  empirically.

### The React 19 upgrade (requirement 10)

App is on `react@^18.3.1` / `react-dom@^18.3.1` / `@types/react@^18.3.18`.
The kit is authored for React 19. Per the decision, the app moves up.

Libraries in `frontend/package.json` that need their React 19 support confirmed
before the upgrade is called done. Listed as candidates to check, not as known
failures:

- `react-big-calendar@^1.19.4` - drives the whole Schedule page
- `react-signature-canvas@^1.1.0-alpha.2` - alpha, used for job signatures
- `vite-plugin-pwa@^1.2.0`
- `recharts@^2.15.1` - all report and dashboard charts
- `@casl/react@^7.0.0` - permission gating
- `react-day-picker@^10.0.1` - kit was written against the v9 API
- `@testing-library/react@^16.3.2` - whole frontend test suite

If any of these has no React 19 support, the options are: pin via an override and
verify at runtime, replace the library, or report back and let you decide. **No
library gets swapped out silently** - that would be a business-logic change wearing
a dependency costume.

### Other kit / app gaps

| | Kit expects | App has |
|---|---|---|
| Tailwind | v4 (`@theme inline`) | 3.4.17 - stays v3, tokens ported per decision 1 |
| Missing deps | `cmdk`, `sonner`, `@dnd-kit/*`, `tw-animate-css`, `@radix-ui/react-progress` | not installed |
| Font | Figtree | to confirm |

The kit's own `CLAUDE.md` states plainly: **"tsc has never run"**, and flags three
shaky spots - `SidebarItem`'s `asChild` prop, the `ColumnDef` `meta` typing
(`meta.fixed`, `meta.label`), and `Table`'s `forwardRef` in `ui/table.tsx`.
Phase 0 absorbs all of it.

---

## 5. Module breakdown (13 page modules + foundation)

Each row becomes one worktree, one branch, one PR. Every module produces files under
`frontend/src/pages/v2/` and adds its routes to the `/v2` block.

| # | Module | Branch | Routes |
|---|--------|--------|--------|
| 0 | **Foundation** | `refactor/ui-kit-00-foundation` | React 19 upgrade, kit import, deps, tokens, `/v2` scaffold, tsc green |
| 1 | Dashboard | `refactor/ui-kit-01-dashboard` | `/` + `dashboard/widgets/*`, `dashboard/layout/*` |
| 2 | Leads | `refactor/ui-kit-02-leads` | `/leads`, `/new`, `/:id`, `/:id/edit` |
| 3 | Customers | `refactor/ui-kit-03-customers` | `/customers` x4 + `/customers/:id/statement` |
| 4 | Estimates | `refactor/ui-kit-04-estimates` | `/estimates` x4 |
| 5 | Jobs | `refactor/ui-kit-05-jobs` | `/jobs`, `/jobs/new`, `/jobs/:id`, `/jobs/:jobId/statement` |
| 6 | Invoices | `refactor/ui-kit-06-invoices` | `/invoices`, `/invoices/new`, `/invoices/:id` |
| 7 | Schedule | `refactor/ui-kit-07-schedule` | `/schedule` (3,290 lines - highest risk) |
| 8 | Tasks | `refactor/ui-kit-08-tasks` | `/tasks` + 6 views (Board/Calendar/Dashboard/History/List/MyDay) |
| 9 | Reports | `refactor/ui-kit-09-reports` | `/reports`, `/reports/:slug` + ~30 report components, `/marketing` |
| 10 | Inventory | `refactor/ui-kit-10-inventory` | `/inventory` x3, price-book, purchase-orders, vendors |
| 11 | Settings & Users | `refactor/ui-kit-11-settings` | `/settings/*` (8), `/users`, `/settings/organization` |
| 12 | Communication | `refactor/ui-kit-12-communication` | phone, whatsapp, inbox, text |
| 13 | Auth & Public | `refactor/ui-kit-13-auth-public` | login, auth/callback, accept-invite, `/p/estimates/:id`, `/p/invoices/:id`, not-authorized |

**PR labels:** every PR gets `ui-kit-migration` plus a module label
(`module:jobs`, `module:schedule`, ...).
**PR titles:** `refactor(ui): add v2 <module> pages built on CRM UI kit`.

---

## 6. Phases

### Phase 0 - Foundation (sequential, blocks everything)
Single branch, no parallelism, no page work.
1. Install dependencies and get a working tree for the first time.
2. Upgrade `react`, `react-dom`, `@types/react`, `@types/react-dom` to 19.
   Work through the compat list in section 4 and report what actually broke.
3. Copy kit `src/components`, `src/hooks`, `src/lib/utils.ts` into `frontend/src/`
   under a clear namespace that cannot collide with existing `components/ui/`.
4. Install missing kit deps (`cmdk`, `sonner`, `@dnd-kit/*`, `tw-animate-css`,
   `@radix-ui/react-progress`).
5. Port kit tokens into `design-system/tokens.css`; extend `tailwind.config.js`.
   Rewrite the kit's `@theme inline` blocks into v3 `theme.extend`. No raw hex in
   components (CLAUDE.md boundary).
6. Mount `TooltipProvider` + `Toaster` at the app root.
7. Add the `/v2` route block, the `VITE_UI_V2` flag resolver, and an empty
   `pages/v2/` directory.
8. Get `npx tsc --noEmit` fully green. Fix the three known-shaky kit spots.
9. Render the kit's reference `jobsPage.tsx` at `/v2/_kit-reference` and diff it
   against `jobsPagePreview.html`.

**Gate:** `npx tsc --noEmit` clean, frontend vitest green, `npm test --workspace=backend`
green, and **every existing page still renders unchanged**. The last one is the real
test of the React 19 upgrade. PR into `staging` and merge before Phase 2 starts.

### Phase 1 - Mapping (parallel, read-only, can run during Phase 0)
One mapping agent per module. Each produces
`md_files/specs/ui-redesign/<module>-behavior-map.md` containing:
- every route and its guards (`ProtectedRoute` roles, feature gates, entitlements)
- every interactive element and what it opens (dialog / sheet / popover / drawer / toast / navigation)
- every API call: hook, endpoint, method, cache invalidation targets
- every form: zod schema, fields, validation rules, submit path
- every conditional render: permission (`canOnJob`, CASL ability), plan gate, status
- empty / loading / error states
- the existing `data-testid` and selector surface that e2e specs depend on

Sources: the code itself, plus a Chrome crawl of `https://servwave-demo.vercel.app`
for live event behaviour. **Mapping agents write documentation only, never code.**

**Gate:** you review and approve the behaviour maps before any v2 page is built.

### Phase 2 - Build (parallel, one worktree per module)
Worktrees under `../alpha_crm-worktrees/ui-kit-<module>/`, branched from the merged
foundation. One builder agent per worktree. Rules for builders:
- **Create new files under `pages/v2/`. Never edit or delete an existing page.**
- Import shared hooks, queries, schemas and ability checks - never fork them.
- Swap presentation only. If a behaviour cannot be reproduced without touching
  shared logic, stop and escalate rather than improvise.
- Carry over every `data-testid` from the original page.
- No raw hex, no raw Tailwind palette class - tokens only.
- Plain hyphens in all prose, comments and commit text. No AI attribution in any
  git artifact.

### Phase 3 - Test (parallel, per module)
Test agent per module:
- `npx tsc --noEmit`
- frontend vitest suite
- Playwright specs (`frontend/e2e/specs/`) - **the old specs must still pass
  untouched**, because the old pages are untouched. This is a strong safety net
  that the coexistence model buys us.
- new v2 coverage where the behaviour map calls for it
- Chrome visual pass: v2 page against its original, side by side

Because old pages stay live, a broken v2 page cannot take down an existing flow.
Any existing spec that breaks is a genuine regression from the foundation work, not
an expected selector churn, and gets treated as a bug.

### Phase 4 - Review (per module)
Code-review agent per module, checking the diff against one question: **does the v2
page reproduce the mapped behaviour exactly, with no logic drift?** Findings go back
to the builder before the PR opens.

### Phase 5 - PR and wait
One PR per module into `staging`, labelled and titled as in section 5. PR body
includes the behaviour map link, the test results as actually run, and the `/v2`
URLs to click through. **Then stop and wait for your approval. No merging.**

---

## 7. Risk register

| Risk | Mitigation |
|------|------------|
| React 19 upgrade breaks a library | Phase 0 gate is "every existing page still renders". Findings reported to you, no silent library swaps |
| `react-big-calendar` on React 19 | Highest-value unknown - it owns the Schedule page. Checked first in Phase 0 |
| Kit has never compiled | Phase 0 absorbs it before any page work |
| Tailwind v4 -> v3 token mapping | Kit README documents the v3 path; tokens go into existing tokens.css |
| `SchedulePage.tsx` at 3,290 lines | Scheduled last among big modules; may split into sub-PRs if the diff is unreviewable |
| Kit ships no calendar | Schedule keeps `react-big-calendar` and gets kit chrome only |
| dnd-kit keyboard path untested | Flagged by kit authors; verified in Phase 3 wherever Kanban is used |
| Two visual systems in one app | Intended, not a defect - that is the comparison model |
| `pages/v2/` drifts from `pages/` over time | Migration is time-boxed per module; cutover or deletion decided by you at the end |

---

## 8. Standing constraints (from CLAUDE.md)

- No AI attribution in any git artifact. Conventional-commit lines only.
- Plain hyphens `-`, never em or en dashes, in prose, commits, comments and code.
- Never commit directly to `main` or `staging`. Worktrees off the base branch.
- Design tokens only - never a raw hex or raw Tailwind palette class in a component.
- Before claiming done: run `npx tsc --noEmit` and `npm test --workspace=backend`
  and report the real result.
- Multi-tenancy, migrations and backend TDD rules are untouched by this work, but
  still apply if any backend file is opened.

---

## 9. Approval

Work does not start until the user approves this document.

- [x] Approved by ront3t - 2026-07-29
