# UI Kit Full Migration - Plan for approval

Status: **AWAITING APPROVAL** (drafted 2026-08-04)
Owner: ront3t
Continuation of `UI_KIT_MIGRATION_PLAN.md` (approved 2026-07-29), now that Phase 0 (foundation) and
module 2 (Leads) are done and the Leads design is signed off.

---

## 1. Where we actually are (verified, not assumed)

Read from the repo on 2026-08-04:

- **Foundation is merged.** `refactor(ui): Phase 0 - React 19, CRM UI kit, and the /v2 scaffold (#1054)`
  is in history: React 19, the kit at `frontend/src/ui-kit/`, ported tokens, the `/v2` scaffold and the
  `VITE_UI_V2` flag.
- **Leads is built and approved.** `refactor/ui-kit-02-leads` = PR **#1126**
  ("refactor(ui): add v2 Leads pages built on the CRM UI kit"), 18 commits past foundation.
  `frontend/src/pages/v2/leads/` - 16 files - plus the shared v2 shell
  (`V2AppLayout`, `V2Routes`, `navSections`, `pageBreadcrumbs`, `SidebarCreateMenu`, `uiV2`).
- **The kit shell already exists.** Kit `sidebar.tsx` / `topBar.tsx` / `breadcrumbs.tsx` / `appShell.tsx`
  are what `V2AppLayout` renders. So the topbar and sidebar are not "to be replaced" so much as
  "to be finished": today their nav only knows about Leads.
- **The app still has 493 old components** across 27 directories and **113 legacy page files**.
- **69 routes** in `App.tsx` - more than the 50 the July plan counted, because automations,
  service-plans, upgrade and six new inventory routes landed since.
- **Behaviour maps exist for 13 modules** on `docs/ui-redesign-maps`, but **not** for
  automations/workflows or service-plans, and they are not committed on the #1126 branch.

### One thing to fix before anything starts

The `ui-kit-02-leads` worktree has **uncommitted local-demo hacks**:

```
frontend/src/App.tsx        initAuthListener() commented out   // LOCAL DEMO ONLY
frontend/index.html         a <script> injecting a fake admin user into localStorage
frontend/vite.config.ts     devMockApi() plugin
frontend/dev-mock-api.mjs   untracked mock API
frontend/src/components-ui-new.zip   untracked
```

They make the app run without a backend. They must **never** reach a module branch or the integration
branch - a commented-out `initAuthListener()` plus a hardcoded `manage all` ability is an auth bypass.
Step 0.1 handles this explicitly.

---

## 2. Decisions confirmed by the user (2026-08-04)

| # | Question | Decision |
|---|----------|----------|
| 1 | Base and merge target | **`refactor/ui-kit-02-leads` (PR #1126)**. Every module branch cuts from it and merges back into it. Nothing goes to `staging` or `main` in this plan. |
| 2 | Strategy | **`/v2` layer now, cutover last.** Module branches add pages under `frontend/src/pages/v2/`. No legacy page is edited or deleted until a final, separately-approved cutover phase. |
| 3 | Missing kit components | Use the old component, keep working, **record it**. One consolidated gap report at the end. |
| 4 | Scope discipline | Presentation only. Unrelated bugs are logged, not fixed. |
| 5 | Where the gap report lives | **`UI_KIT_MISSING_COMPONENTS.md` at the repo root.** Per-module ledgers stay under `md_files/plans/ui-redesign/gaps/` as working files and are consolidated into the root report. |
| 6 | The demo mock API | **Stashed, local only.** Never committed, on any branch. |
| 7 | PR mechanics | `git push` works (HTTPS + Windows Credential Manager), but `gh` and the GitHub MCP are unauthenticated, so I cannot open or label PRs. Until `gh auth login` is run, module branches **merge into #1126 locally** and no PRs are opened. |

---

## 3. Module breakdown - 14 branches

Leads (module 2) is done. Module 0 is new and blocks everything else.

| # | Module | Branch `refactor/ui-kit-NN-*` | Routes | Legacy weight |
|---|--------|------|--------|--------|
| **0** | **Shell + nav + maps** | `00b-shell` | none (infrastructure) | `components/layout/` 7 |
| 1 | Dashboard | `01-dashboard` | `/` + widgets, layout, catalog | 9 widgets |
| 3 | Customers | `03-customers` | `/customers` x4 + `/customers/:id/statement` | 3 |
| 4 | Estimates | `04-estimates` | `/estimates` x3 | 18 |
| 5 | Jobs | `05-jobs` | `/jobs` x3 + `/jobs/:jobId/statement` | 30 |
| 6 | Invoices | `06-invoices` | `/invoices` x3 + standalone invoice form | 10 |
| 7 | Schedule | `07-schedule` | `/schedule` | 18 (page is 3,290 lines) |
| 8 | Tasks | `08-tasks` | `/tasks` + 6 views | 11 |
| 9 | Reports | `09-reports` | `/reports`, `/reports/:slug`, `/marketing` | ~35 report files + 10 charts |
| 10 | Inventory | `10-inventory` | `/inventory` x9 (incl. logistic-orders, assets, approvals, staging, low-stock) | 57 |
| 11 | Settings & Users | `11-settings` | `/settings/*` (13 tabs), `/users` | 6 + 14 pages |
| 12 | Communication | `12-communication` | `/communication/*` x6, `/phone` | 30 |
| 13 | Auth & Public | `13-auth-public` | `/login`, `/auth/callback`, `/accept-invite`, `/p/estimates/:id`, `/p/invoices/:id`, not-authorized, `/upgrade` | - |
| 14 | Automations & Workflows | `14-automations` | `/automations` x4 | 36 |
| 15 | Service Plans | `15-service-plans` | `/service-plans` | 1 |

**PR title:** `refactor(ui): add v2 <module> pages built on the CRM UI kit`
**PR base:** `refactor/ui-kit-02-leads`. **Labels:** `ui-kit-migration` + `module:<name>`.

---

## 4. Phase 0 - Shell, nav and merge-conflict prevention (sequential, blocks all)

Done by me directly on branch `refactor/ui-kit-00b-shell`, one PR into #1126.

**0.1 Quarantine the demo hacks.** `git stash` them on the leads worktree so `git status` is clean on the
base before any worktree is cut. They stay local and are never committed to any branch (decision 6). The
stash entry is named so it is recoverable: `git stash push -m "LOCAL DEMO ONLY - mock api + fake auth"`,
with `dev-mock-api.mjs` and `components-ui-new.zip` included via `--include-untracked`. Phase 2's visual
cross-check re-applies the stash locally when a backend-free run is wanted.

**0.2 Bring the behaviour maps onto the base.** Merge `docs/ui-redesign-maps` into #1126 so every module
agent can read `md_files/specs/ui-redesign/<module>-behavior-map.md` from its own worktree.

**0.3 Write the two missing maps.** Mapping agents (read-only, documentation only) for
**automations/workflows** and **service-plans**, in the same format as the existing 13.

**0.4 Kill the guaranteed merge conflict.** Today every module would edit the same three files
(`V2Routes.tsx`, `uiV2.ts`, `navSections.ts`) - 14 branches, 14 conflicts, every time. Refactor so each
module owns its own files:

```
pages/v2/routes/<module>.routes.tsx   one module's <Route> block
pages/v2/nav/<module>.nav.ts          one module's sidebar entries + breadcrumb labels
pages/v2/routes/index.ts              collects them (the only shared line a module touches)
```

Leads is migrated to this shape first, as the worked example, with no behaviour change.

**0.5 Finish the shell** (your "including the general layout components like topbar and sidebar").
Kit `sidebar` / `topBar` / `breadcrumbs` gain the full nav tree for all 15 modules, driven by the same
nav config, permission and feature gates the legacy `Sidebar.tsx` uses. Global search, the notification
bell and the user menu move onto kit primitives (`command`, `dropdownMenu`, `popover`, `avatar`), or get
recorded as gaps if the kit cannot express them.

**0.6 Seed the gap ledger.** `md_files/plans/ui-redesign/gaps/README.md` plus the known primitive-level
gaps in section 6, so module agents append to a format rather than invent one.

**Gate:** `npx tsc --noEmit` clean, frontend vitest green, every legacy route still renders, `/v2/leads`
visually identical to the approved design. Merged into #1126 before Phase 1 starts.

---

## 5. Phase 1 - Module build (parallel worktrees, 4 waves)

Waves are sized so the pattern is proven before the hard modules are attempted, and so no more than four
`node_modules` installs run at once on your machine.

| Wave | Modules | Why together |
|------|---------|--------------|
| A | Customers, Estimates, Invoices, Service Plans | Closest in shape to the approved Leads page - list + detail + form. Proves the pattern at low risk. |
| B | Jobs, Tasks, Dashboard, Auth & Public | Jobs is the kit authors' own reference implementation. Dashboard and Auth are self-contained. |
| C | Inventory, Settings & Users, Automations & Workflows | High file count, low novelty - tables, forms and tabs the earlier waves already solved. |
| D | Schedule, Reports, Communication | The three that cannot be done by pattern: `react-big-calendar`, `recharts`, and a real-time comms surface. Done last, with the most context available. |

### Each worktree

```
git worktree add ../alpha_crm-worktrees/ui-kit-<module> -b refactor/ui-kit-NN-<module> refactor/ui-kit-02-leads
```

### The contract every module agent works to

1. **Read first**: the module's behaviour map, its legacy pages, and `pages/v2/leads/` as the reference
   implementation. Never claim anything about code it has not opened.
2. **Enumerate mechanically**: grep every `@/components/...` import in the module's pages into a
   checklist. This is how "make sure each one is replaced" gets *verified* rather than asserted - the
   agent must account for every row.
3. **Map old -> kit** using section 6. Where the kit has no equivalent: **use the old component**, wrap
   it so it inherits kit tokens, and append a row to
   `md_files/plans/ui-redesign/gaps/<module>-missing-components.md` with what it is, where it is used,
   and what building a kit version would take.
4. **Build** under `pages/v2/<module>/`, registered via its own `.routes.tsx` and `.nav.ts`.
5. **Business logic is imported, never forked** - hooks, TanStack queries, zod schemas, `lib/ability.ts`,
   `canOnJob`. If a behaviour cannot be reproduced without touching shared logic, the agent **stops and
   escalates**. That is the tripwire protecting "keep the business logic intact".
6. **Carry over every `data-testid`** so e2e selectors survive the eventual cutover.
7. **Guards mirror `App.tsx` exactly** - same `ProtectedRoute` roles, same `RequireFeature`, same route
   ordering. A restyle must not change who can reach a page.
8. **Boundaries**: no raw hex, no raw Tailwind palette class, tokens only. Plain hyphens everywhere. No
   AI attribution in any commit or PR text.
9. **Scope**: unrelated bugs are written to the module's gap file as observations, not fixed.
10. **Self-gate before PR**: `npx tsc --noEmit` and the frontend vitest suite, reported as actually run.

**Skills in play**: `agent-ui-expert` / `ui-ux-pro-max` / `tailwind-patterns` for the component work,
`react-patterns` + `react-best-practices` for composition, `lint-and-validate` after every change,
`systematic-debugging` when something breaks, `concise-planning` for each agent's own checklist,
`ship-changes` for PR mechanics. `test-driven-development` applies if any backend file is ever opened -
it should not be.

---

## 6. Old -> kit component map, and the gaps I can already name

The kit ships 24 UI primitives, 6 form, 9 data, 7 layout, 10 CRM components. Direct replacements:

| Old | Kit |
|-----|-----|
| `data/ResizableTable`, `data-table`, `table` | `data/dataTable/*` (+ toolbar, pagination, view options, column header) |
| `data/KpiStrip` | `data/statCard` |
| `data/status-badge`, `TagChips`, `filter-chip` | `ui/badge`, `crm/tagInput` |
| `data/ContactCell` | done in leads as `contactCell.tsx` |
| `patterns/PageHeader`, `Toolbar`, `ListPageShell` | `layout/pageHeader`, `data/dataTable/dataTableToolbar`, `layout/container` + `masterDetail` |
| `patterns/FormField` | `form/formField` |
| `patterns/TabStrip`, `ui/tabs` | **no kit equivalent** - see gaps |
| `filters/FilterBar`, `AppliedChips` | `crm/filterBar` (+ the leads `appliedFilters` / `filterPopover` pattern) |
| `form/SelectField`, `DateTimePicker`, `TimeSelect` | `form/statusSelect`, `form/datePicker`, `ui/calendar`, leads `timeSelect` |
| `form/DateRangeField`, `DateRangeFilter` | **no kit equivalent** - see gaps |
| `layout/AppLayout`, `Sidebar`, `Header` | `layout/appShell`, `layout/nav/sidebar`, `layout/nav/topBar` |
| `crm/ActivityPanel` | `crm/activityFeed`, `data/timeline` |
| `crm/AssigneeSelect`, `MultiAssigneeSelect`, `CustomerPickerWithCreate` | `form/combobox` + `ui/command` (leads `pickCustomer` is the worked example) |
| `ui/confirm-dialog`, `modal`, `dialog`, `sheet`, `popover`, `dropdown-menu`, `tooltip`, `select`, `input`, `textarea`, `checkbox`, `switch`, `label`, `avatar`, `card`, `separator`, `skeleton`, `calendar`, `button`, `badge`, `breadcrumb`, `empty-state` | 1:1 kit equivalents exist |
| `ui/toast`, `toaster`, `use-toast` | `ui/sonner` - **API differs**, call sites change shape |

### Known gaps up front (the kit has nothing for these)

Presentation primitives: `tabs` / `TabStrip`, `alert`, `chip`, `collapse`, `toggle-group`, `thumbnail`,
`action-link`, `link`, and the layout primitives `box`, `stack`, `inline`, `surface`, `heading`, `text`.

Rich components: all 10 `components/charts/*` and `recharts` (kit ships no chart - already an approved
exception), `react-big-calendar` (kit ships no calendar view), `AttachmentLightbox`,
`VideoPreviewDialog`, `crm/LineItemsEditor`, `crm/address-autocomplete`, `crm/service-location-map`,
`crm/AttachmentSection`, `filters/RangeSlider`, signature capture, and `layout/GlobalSearch`.

This is the *starting* list, from comparing directory inventories. The per-module ledgers make it exact,
and section 8 turns it into the single report you asked for.

---

## 7. Phase 2 - Verification (after all modules are merged into #1126)

Run against the integrated #1126 branch, not per-module, so cross-module regressions are visible:

1. **`branch-test-verifier` agent** - baselines on the branch point first, so every failure is attributed
   to this work or exonerated as pre-existing. Runs `npx tsc --noEmit`, frontend vitest,
   `npm test --workspace=backend`, and the Playwright specs. **The legacy e2e specs must still pass
   untouched** - the old pages were never edited, so any failure there is a real regression.
2. **`branch-code-reviewer` agent** - one question per module: does the v2 page reproduce the mapped
   behaviour exactly, with no logic drift? Plus the repo boundaries (tokens, hyphens, attribution).
3. **`/code-review` skill** on the accumulated diff.
4. **Visual cross-check** - Chrome against `https://servwave-demo.vercel.app/` and against the locally
   running legacy route, per module, side by side: `/v2/<module>` vs `/<module>`. Findings go back to the
   owning module branch, not into a drive-by fix.

---

## 8. Phase 3 - Reports to you

1. **Missing-components report** - `UI_KIT_MISSING_COMPONENTS.md` **at the repo root** (decision 5). The
   consolidated ledger: every old component still in use because the kit has no equivalent, every place
   it is used, and a build/keep/drop recommendation for each. Written incrementally - it exists from
   Phase 0 and each wave appends to it, so you can read it before the whole migration finishes rather
   than only at the end.
2. **Coverage report** - per module, every old component the module used and what replaced it, so
   "make sure each one is replaced" is auditable rather than a claim.
3. **Observed-but-not-fixed list** - the unrelated bugs found along the way, ready to feed `/to-issues`
   if you want them tracked.

---

## 9. Phase 4 - Cutover (NOT in this plan, needs its own approval)

Promoting `/v2` to the primary routes and deleting the legacy pages and components is the last step and a
separate decision. It is where the e2e suite genuinely changes and where rollback stops being "delete a
directory". I will come back with a cutover plan once Phase 3's reports are in your hands.

---

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Demo hacks leak into a branch (auth bypass) | Step 0.1 quarantines them before any worktree is cut; the reviewer checks for them explicitly |
| 14 branches conflicting on the same route/nav files | Step 0.4 gives each module its own files |
| Agent "fixes" business logic while restyling | Rule 5: import never fork, stop and escalate. Reviewer checks for any diff outside `pages/v2/` |
| Schedule (3,290 lines) is unreviewable in one PR | Wave D, may split into sub-PRs |
| Reports has no kit chart component | Already-approved exception - chart internals are no-touch, only the chrome around them changes |
| Gap list grows until v2 is half old components | Reported per wave, not just at the end, so you can call it early |
| Drift between `pages/` and `pages/v2/` while this runs | Waves are time-boxed; the base rebases onto #1126's tip between waves |

---

## 11. Approval

Work does not start until you approve this document.

- [ ] Approved by ront3t
