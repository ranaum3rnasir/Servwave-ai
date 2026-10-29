# Goal: one source of truth for every UI component

## The goal, in one sentence

Every visual decision in the ServWave frontend is made in exactly one place, that place
is findable without searching, and it cannot be silently overridden.

This is stricter than "we use design tokens" and looser than "no component ever accepts a
className". Read the four layers below before assuming which one a given task belongs to.

## Why this is worth real effort

This is a one-time structural investment. Every future UI change - a rebrand, a density
pass, a new status, a dark mode - costs either one edit or hundreds, and which one it costs
is decided by the work described here. Do not optimise for finishing quickly. Optimise for
never having to do it again.

## The four layers

A visual decision can live at four levels. "One source of truth" means something different
at each, and they are not equally important.

| Layer | The one source | Violated when |
|---|---|---|
| 1. Value | a semantic token (`--success-text`, `--radius-card`) | raw hex, raw Tailwind palette class, inline `style={{}}` |
| 2. Appearance | one primitive per element (`Button`, `Card`, `Badge`, `Modal`) | a hand-rolled `<button className=...>`, or a forked copy of the primitive |
| 3. Meaning | one registry mapping domain state to visual intent | each call site decides for itself that `PENDING` is amber |
| 4. Composition | one primitive per recurring layout | every page reinvents its own page header, empty state, confirm dialog |

Layer 3 is the one usually left unnamed and it carries the most leverage. A component that
takes `color="amber"` has moved the decision back to the call site: 40 call sites is 40
sources of truth even when every one of them uses a perfect token. Call sites must pass
**meaning** (`<StatusBadge kind="estimate" status={e.status} />`), and appearance must be
derived from that meaning exactly once.

Two cross-cutting properties make the four layers hold:

- **Findability.** A single source of truth is worthless if nobody can locate it. A developer
  new to the repo, asked to change how a pending badge looks, should land on the right file
  from the name alone, without grepping. This implies a real component index and a naming
  rule under which the canonical implementation is obviously the canonical one.
- **Inverted drift cost.** Today it is *easier* to copy-paste a badge than to extend the
  shared one. That asymmetry, not carelessness, is the root cause of the 12 duplicate
  StatusBadges. Done means extending the canonical component is the path of least resistance
  and forking it is the thing that takes effort and trips a check.

## Acceptance tests

Not metrics. Change requests. Each must be a one-file edit, and the last one is the real bar:

1. "Make the brand blue slightly darker." -> one token; the whole app moves.
2. "Pending estimates should read grey, not amber." -> one registry line.
3. "Our buttons feel too round." -> one radius token.
4. "Cards get a subtle border instead of a shadow." -> one primitive.
5. "Add a new job status, `AWAITING_PARTS`." -> one registry entry, and it renders correctly
   everywhere it appears without visiting a single page.

Test 5 is the hardest and the most diagnostic, because it can only pass if no call site was
ever allowed to enumerate statuses itself.

## Anti-goals

Overshooting here would make the codebase worse. Explicitly NOT the goal:

- **Not "className is banned."** Removing the escape hatch entirely causes prop explosion
  (`marginTop`, `isCompact`, `variantForThatOnePage`). The correct rule is a **layering
  rule**: `className` may adjust *layout* (margin, width, grid placement, order) but never
  *appearance* (color, radius, shadow, typography, border). That is mechanically checkable
  at call sites, which "use good judgment" is not.
- **Not "one component per visual."** Genuinely different things should look different. The
  target is no *accidental* divergence, not enforced uniformity.
- **Not "zero raw `<button>`."** A tab strip or a toolbar icon affordance can legitimately be
  a bare element. What matters is that when it is, it does not restate appearance values a
  primitive already owns.

## Measured starting state (2026-07-26 - re-verify before acting, do not trust these numbers)

Branch `refactor/shared-component-library` in worktree `../alpha_crm-worktrees/shared-components`,
cut from `origin/staging`. Four commits landed, not pushed, no PR opened. `npx tsc --noEmit`
clean; 324 test files / 2571 tests passing.

Done:
- Token vocabulary complete and WCAG AA verified, including a four-role status scale
  (`-surface` / `-border` / `-text` / `-strong`). The previously recommended alpha form
  (`bg-success/10`) fails AA in every family and must not be reintroduced.
- `rounded-control` registered (20 sites had been using it unregistered, rendering no radius).
- Token guard rewritten bracket-aware; it previously passed vacuously over
  `data-[state=open]:bg-slate-100`. Whole-tree ratchets in place at 949 palette / 1302
  white-black / 52 CSS hex - these may only ever be lowered.
- `scripts/check-unresolved-classes.mjs` gates the dominant silent failure mode: Tailwind
  exits 0 and emits nothing for an unknown class.
- ~60 dead-class sites repaired across 25 files (the destructive toast had no background at
  all; NewEstimateDialog's entire hover state was dead).
- Modal, ToggleGroup, useIsMobile, report toolbar unified. All money now routes through
  `formatCurrency` / org currency.

Not done, roughly in leverage order:
- No status registry. 44 files reference StatusBadge / StatusPill / StateChip / StatusTag;
  12+ real implementations. 9 domains with colliding enum values (`SENT` means different
  things for an estimate and an invoice; the canonical file already carries a bolt-on
  override map admitting this).
- 13 KpiTile variants, 3-5 SectionCard, 23-26 hand-rolled overlays, duplicate EmptyState /
  ConfirmDialog / initials helpers.
- ~940 raw `<button>` elements.
- 949 palette classes + 1302 bare `bg-white`/`text-white` + 153 inline `style={{}}` across
  283 files still bypass the token layer. Worklist at `scratchpad/palette-worklist.md`.
- The layering rule is unenforced. `cn()` is `twMerge(clsx())`, so the caller always wins;
  `KpiStrip.tsx:37` *documents* its escape hatch as "lets existing callers pass raw Tailwind
  classes", which is exactly the thing the rule must forbid.
- Tailwind's `theme.extend.colors` escape hatch still open. Closing it (moving to
  `theme.colors`) must happen LAST, and must re-declare `white`/`black`/`transparent`/
  `current` or it silently drops 1,328 sites and flips Preflight's default border colour.
- `features/estimate-workspace/components/` not absorbed; 4 zero-importer barrels not deleted.

## Sequencing principle

Do **not** start with the 949 palette classes. It is the most visible progress and close to
the least valuable, and it has a genuinely harmful second-order effect: converting a rogue
`StatusPill` to tokens makes it *harder* to find, because `bg-amber-50` is a visible smell
today while `bg-warning-surface` reads exactly like the canonical component.

Correct order is meaning before values:

1. **Status registry** (layer 3). Kills ~12 implementations and establishes the pattern every
   other consolidation copies. This is real design work, not mechanical: it requires deciding
   how 9 domains with colliding enum values map onto a shared intent vocabulary.
2. **Remaining duplicate concepts** (layers 2 and 4) - KpiTile, SectionCard, overlays,
   EmptyState, ConfirmDialog.
3. **The layering rule**, enforced. Decide the API change (semantic components take variants
   plus layout-only className), then add the call-site check that makes it stick.
4. **Then** the palette/white/inline-style conversion (layer 1), by which point converting a
   site no longer risks camouflaging a duplicate.
5. **Last**, close the Tailwind escape hatch and tokenise the remaining radius scale.

## Rules of engagement

- **Never narrow scope silently.** If a phase looks too large, say so and propose the split
  explicitly. Do not quietly redefine a phase to cover a subdirectory, and do not substitute a
  worksheet or an audit document for the conversions the phase actually calls for. Scaling the
  work down is the owner's call.
- **Measure, do not assert.** Every count in this document was wrong at least once before it
  was verified. Re-run the scripts rather than trusting the prose, including this prose.
- **Guard before migration.** A migration under a guard that passes vacuously is worse than no
  guard, because it reports green over real violations. Prove each guard by injecting a
  violation and watching it fail before relying on it.
- **Duplicates hide behind correctness.** Any conversion pass must be paired with duplicate
  detection, or it will bury the very thing the next phase needs to find.
- Project constraints from `CLAUDE.md` are in force throughout: worktree off the appropriate
  base under `../alpha_crm-worktrees/`, PR into `staging` first and never commit directly to
  `main` or `staging`; no AI attribution in any git artifact; plain hyphens only, never em or
  en dashes, in prose, commit and PR text, comments and code; no raw hex or raw Tailwind
  palette class in a component; before claiming done, run `npx tsc --noEmit` and
  `npm test --workspace=backend` and report the real result.

## Definition of done

> Changing how something looks is a **token** edit. Changing how a *kind of thing* looks is a
> **primitive** edit. Changing what a *domain state* means is a **registry** edit. Nothing
> below those three layers ever restates a decision made above it, and the build fails when it
> tries.

All five acceptance tests pass. Findability and inverted drift cost both hold. The ratchets
read zero, or the residue is enumerated with a written reason each entry is legitimate.

## Driving this with `/goal`

`/goal` sets a completion condition and keeps starting turns until a checker model agrees the
condition holds. Three mechanics constrain how the condition must be written:

- **The evaluator does not run tools.** It is the small fast model (Haiku by default) and it
  judges only what the working model has already surfaced in the conversation. A condition
  referencing a file it cannot read is unverifiable. Every criterion must be provable from
  printed output, which is why each phase goal below mandates a fixed evidence block.
- **The condition is capped at 4,000 characters** and doubles as the opening directive, since
  setting a goal starts a turn immediately.
- **One goal per session.** This work is therefore one goal per phase, not one for the whole
  thing. Run them in the sequencing order above; `/goal clear` between phases.

Each phase condition should carry: one measurable end state, the exact command that proves it,
the constraints that must not change on the way there, and a turn bound (`stop after N turns`)
so a stuck loop reports instead of grinding. Pair with auto mode to let turns run unattended.

Phase conditions, in order:

1. **Status registry** - DONE 2026-07-26. One registry (`design-system/status-registry.ts`, 16
   domains) plus one rendering component; all duplicates deleted (48 files -> 45, all classified);
   `AWAITING_PARTS` probe proved a new status is a one-line edit; ratchets tightened
   (949/1302/52 -> 905/1301/50, never raised). tsc clean, 2675 frontend + 6276 backend tests green.
2. **Remaining duplicate concepts** - DONE 2026-07-26 (all 5 sub-phases 2a-2e). Re-audited
   2026-07-26, the "13/3-5/23-26" counts below were wrong in both directions; do not trust them
   either without re-measuring - every sub-phase below re-measured before starting and every one
   found the prior count wrong. Net across 2a-2e: ratchet 905/1295/50 (start, end of phase 1) ->
   897/1212/50 (end of 2e); tsc clean and frontend 2675/2682 held steady the entire way (zero
   regressions across ~15 parallel migration agents); backend untouched throughout (0 files).
   Split into sub-phases
   by leverage, same reasoning as phase 1's own split:
   - **2a. SectionCard + KpiTile** - DONE 2026-07-26. `CommissionsReport.tsx`'s local `SummaryCard`
     deleted, its 3 call sites (Total Profits, Total by type, Report History) now render the
     canonical `SectionCard`. 5 local KpiTile duplicates deleted (`WorkflowsHome.tsx` StatTile,
     `CallsView.tsx` StatCard, `StagingView.tsx` StatTile, `ApprovalsView.tsx` StatTile,
     `VendorDetailDialog.tsx` SpendCard), all redirected to the canonical `KpiTile`
     (`components/data/KpiStrip.tsx`); `InventoryPage.tsx`'s `StatTile` wrapper untouched as
     specified. KpiTile needed two prop extensions to absorb the duplicates: its `tint` prop was
     declared but dead (never applied to the DOM) - wired it up; added a `className` passthrough
     for grid placement (`VendorDetailDialog`'s spend cards need `col-span-3`). 3 duplicates had no
     icon at all (`CallsView`, `StagingView`, `VendorDetailDialog`) - KpiTile requires one, so
     reasonable per-stat icons were chosen rather than making the prop optional. tsc clean, 2675
     frontend tests green (unchanged), backend 6275/6320 (1 pre-existing failure in
     `statement-job.test.ts`, unrelated - zero backend files touched this phase). Ratchet: white/
     black tree count dropped 1301 -> 1295 from deleting the duplicates; palette (905) and hex (50)
     unchanged.
   - **2b. Initials helper** - DONE 2026-07-26. Re-measured before starting per "measure, do not
     assert": the "12 real duplicates" estimate was itself stale and undercounted by 6 - actual
     count was 18 implementations / 21 call sites (one, `phone/shared.tsx`'s `initials()`, was
     also imported cross-file by `TrainingView.tsx`). Built one canonical `getInitials(name,
     fallback = '?')` in `lib/utils.ts`; all 18 local implementations deleted and every call site
     redirected. Two byte-identical clusters collapsed cleanly (`AssignTeamPopover.tsx`/
     `TeamCard.tsx`; `MemberWeekBoard.tsx`/`TechnicianGridView.tsx`); a near-identical cluster of
     4 (`phone/shared.tsx`, `InboxDirectory.tsx`, `InboxPage.tsx`, `WhatsAppPage.tsx`) collapsed
     the same way. `CustomersPage.tsx` genuinely needed a first/last -> `company_name` fallback
     cascade (functional, not cosmetic) - kept as a thin page-local `customerInitials()` wrapper
     that composes the canonical helper rather than re-implementing name-splitting. Per Ran's
     "don't chase fidelity" feedback, algorithmic outliers were migrated straight onto the
     canonical algorithm without preserving their exact old output: `TaskCard.tsx` (took first
     letter of first 2 words, not first+last) and `WeeklyRepDiagnostic.tsx` (same, plus was
     missing `.toUpperCase()` entirely - a latent bug, now fixed) both now match every other call
     site. 4 sites using bare `name.charAt(0)` for AI-agent avatars (`AgentCard.tsx`,
     `AgentDetailModal.tsx`, `AiJobAssistantBar.tsx`, `AiCenterModal.tsx`) are a different concept
     (no name-splitting) and were left alone. tsc clean, frontend 2675/2682 (unchanged), zero
     backend files touched. Ratchet: palette (905) and white/black (1295) unchanged, as expected
     for a logic-only migration touching no className strings.
   - **2c. EmptyState** - DONE 2026-07-26. Re-measured before starting: the naive "80 files" was
     wrong in both directions (missed structural patterns like `ResizableTable`'s `empty=` prop
     callers using entity-specific copy; overcounted comments/toasts/banners/dropzones/menu items).
     Real count came to 104 files across 3 shapes (table-row 39, bare-block 56, bordered-card 10,
     plus 12 "other" - confirmed-different semantics, e.g. confirmation banners, interactive
     dropzones, 404 stubs - left untouched). Built the canonical `EmptyState`
     (`components/ui/empty-state.tsx`): `icon?`, `title`, `description?`, `action?`, `variant`
     (`'bare'` - no chrome, drops into any container; `'card'` - bordered chrome for standalone
     page states, default `'bare'`), `className` (layout-only). Icon treatment is the circular
     `rounded-ic bg-background-light` badge already used by `WorkflowActivity.tsx` - picked as the
     one consistent look per the "don't chase fidelity" rule rather than preserving each
     duplicate's bare-icon-vs-badge choice. `PurchaseOrdersPage.tsx`'s local `EmptyState` (the
     richest pre-existing implementation) was promoted: its icon was hardcoded and there was no
     `action` slot, so it's now a thin `PoEmptyState` wrapper resolving per-tab copy and calling
     the canonical component. `data-table.tsx`'s two hardcoded "No results found." states
     (desktop table-row + mobile card) now redirect through the canonical component, covering 5
     downstream pages (`CustomersPage`/`JobsPage`/`LeadsPage`/`InvoicesPage`/`EstimatesPage`) with
     one edit. 93 files now import the canonical component (some had >1 empty state). 4 parallel
     agents handled the bulk migration by shape/area (`ResizableTable` `empty=` string callers,
     hand-rolled table-row, bordered-card, picker/dropdown one-liners, page-level panels) after I
     built the component and handled the highest-leverage shared files myself; each ran its own
     tsc/vitest pass and did a self-sweep for duplicates the initial file lists missed (several
     found: `PriceBookPicker.tsx`, `TagInput.tsx`, `TrackedItemSearch.tsx`,
     `CustomerCommunicationsTab.tsx`, `WalkthroughTab.tsx`, `ReportsPage.tsx`, and more). One agent
     hit a `git stash`/`stash pop` mishap mid-run in the shared worktree (recovered, verified clean
     - `git stash list` empty, phase 1/2b work intact, tsc/tests green). tsc clean across the whole
     worktree; frontend 2675/2682 (unchanged); backend untouched (0 files). Ratchet: palette
     905 -> 902, white/black 1295 -> 1280 - both real drops from deleting duplicate markup (e.g.
     `text-slate-400` inside the old `MemberWeekBoard`/`TechnicianGridView` duplicate blocks).
   - **2d. ConfirmDialog** - DONE 2026-07-26. Built `components/ui/confirm-dialog.tsx`, composing
     `ui/dialog.tsx` directly (matching `PublicEstimatePage.tsx`'s reference pattern): `icon?`,
     `title`, `description?`, `variant` (`'default' | 'destructive'` - tints the icon badge +
     Confirm button), `confirmLabel`/`cancelLabel` (both overridable per call site, e.g.
     `PublicEstimatePage`'s "Go Back"/"Yes, Decline"), `onConfirm`, `isLoading`, and a `children`
     slot for rich body content between the description and the footer. All three identified
     sites migrated: `PublicEstimatePage.tsx`'s decline-confirmation now calls the canonical
     component instead of re-composing raw Dialog primitives itself. `JobDetailPage.tsx`'s bare
     `window.confirm()` became declarative state (`deleteConfirmOpen`) + a `ConfirmDialog` call -
     required rewriting `__tests__/job-detail-page.test.tsx`'s delete-confirm test off
     `vi.spyOn(window, 'confirm')` onto querying the rendered dialog's description text and
     clicking Cancel/Confirm buttons; both cases (synced-lines stock-return sentence present vs
     absent) still covered, 14/14 passing. `RescheduleConfirmDialog.tsx` (the richest case - a
     FROM/TO time panel, crew list, and conditional email-recipients notice) kept its own external
     prop contract unchanged and became a thin wrapper passing its bespoke body through
     `ConfirmDialog`'s `children` slot - `SchedulePage.tsx`'s call site needed no changes. This
     surfaced a real gap in `shadow-component-guard.test.ts`: its Modal/Dialog concept bucket only
     recognized literal `<Modal>`/`<Dialog>` composition, so `RescheduleConfirmDialog` composing
     the new `ConfirmDialog` would have been (incorrectly) flagged as still-noncompliant - extended
     `CONCEPT_PRIMITIVES` to add `confirm-dialog`/`<ConfirmDialog>` to that bucket (mirroring the
     existing Modal-composes-Dialog reasoning) and removed the now-stale allowlist entry; guard's
     8 tests still green. tsc clean, frontend 2675/2682 (unchanged), backend 6276/6320 (0 files
     touched; the 1 failure seen on an earlier full run was `socket hang up` on an unrelated test,
     confirmed flaky - passes in isolation). Ratchet: white/black 1280 -> 1278 (RescheduleConfirmDialog's
     own `bg-white` wrapper deleted, now supplied by the shared Dialog primitive); palette (902)
     unchanged - the email-notice `amber-*` classes moved into the `children` slot verbatim, not
     removed (out of scope for this phase; layer-1 conversion is phase 4).
   - **2e. Overlays** - DONE 2026-07-26. Re-measured before starting: real count was 30 files /
     48 instances (not 28), splitting into full modal/dialog/lightbox (18 files, 26 instances),
     slide-in drawer (6 files), dropdown/popover catcher (11 files, 14 instances), plus 4
     false-positive/out-of-scope files (`CopilotSheet.tsx` - immersive full-viewport takeover, no
     dismiss affordance; `InboxPage.tsx`'s mobile reading-pane swap - responsive layout, not a
     dialog; `PublicEstimatePage.tsx` / `PublicInvoicePage.tsx` - `fixed inset-0` used only to fill
     the viewport as page background, no backdrop/escape logic). Migrated across 6 parallel agents,
     grouped by FILE rather than by target primitive so no two agents ever wrote the same file
     concurrently (the alternative - grouping by primitive - would have split coupled work like
     `CallsView.tsx`+`EntityCallDrawer.tsx` or the `TextingView.tsx`+`CallMaskingView.tsx`
     `CleanSelect` duplicate pair across agents that don't coordinate).
     - **Modal**: 3 byte-identical "Visible fields" `FieldsModal` pickers (`JobsReport.tsx`,
       `LeadsReport.tsx`, `SalesReport.tsx`) plus 15 more hand-rolled dialogs, all clean swaps -
       `InboxDirectory.tsx`'s `ManageDirectoryModal`, `BlockedCallersView.tsx`'s
       `BlockNumberModal`, `CallGroups.tsx`'s `GroupModal`, `SmsInboxView.tsx`'s
       `NewMessageDialog` (a genuine blind spot - the file already correctly used `DropdownMenu`
       elsewhere), `Dialer.tsx`'s `ActiveCallPopup` + `ConferencePicker`, `CallFlows.tsx`'s
       `StructureChoiceModal`, `TextingView.tsx`'s `NewTemplateModal` + `AutomationModal`,
       `TrainingView.tsx`'s `SimulationModal`, `PhonePage.tsx`'s `ReachSalesModal`,
       `NumbersView.tsx`'s `GetNumberDialog` (had a nested stacked confirm layer - now a nested
       `ConfirmDialog` rendered conditionally; two stacked Radix dialogs already dismiss the
       innermost first on Escape, so the manual stacking `useEffect` was pure deletion).
     - **Sheet**: `CallsView.tsx`'s `CallDetailDrawer`, `PerformanceView.tsx`'s
       `AgentDetailDrawer`, `TrainingView.tsx`'s `TrainingSessionDrawer`, `EntitySmsDrawer.tsx`,
       plus `EntityCallDrawer.tsx`'s inner loading-shell wrapper (now also `Sheet`-shaped so the
       frame doesn't change shape when the lazy-loaded real drawer swaps in). `IconRail.tsx`'s
       sliding panel was investigated and deliberately NOT converted - `SheetContent`'s Radix
       `Overlay` + `aria-hidden`/focus-trap (`modal=true`) would break the icon rail's existing,
       tested requirement that its OTHER trigger icons stay clickable while the panel is open
       (confirmed via `activity-note-guard.test.tsx`'s "re-click while dirty" case); a bespoke
       non-modal Radix composition would work but stops being a drop-in Sheet swap. Left as a
       documented residual with an inline code comment; its own internal "Discard unsaved note?"
       dialog WAS migrated onto the canonical `ConfirmDialog` as a smaller, safe win.
     - **Popover/DropdownMenu**: `AiAssistMenu.tsx`, `ComposeWindow.tsx`'s emoji picker,
       `CallFlows.tsx`'s `InsertDot` + `MiniSelect`, `CallsView.tsx`'s `CallFilterBar`,
       `NumbersView.tsx`'s `FlowSelect` + `AdGroupSelect` (deleted a whole manual
       `createPortal` + viewport-coordinate positioning system - Popover already portals and
       positions), `shared.tsx`'s date-range preset picker, `LeadDetailPage.tsx`'s
       `StatusDropdown` (blind spot - file already used `DropdownMenu` elsewhere),
       `InboxPage.tsx`'s Snooze + More menus (blind spot - nested inside an un-exported inner
       `ReadingPane`), `PhonePage.tsx`'s `PlanUsage`.
     - **Genuine duplicate deduplicated, not redirected onto Modal/Sheet/Popover**:
       `CallMaskingView.tsx` and `TextingView.tsx` each hand-rolled an identical `CleanSelect` -
       a portal + `getBoundingClientRect`-positioned select widget, deliberately NOT a simple
       click-outside catcher (the positioning exists to escape an `overflow:hidden` ancestor).
       Extracted one shared `CleanSelect` into `shared.tsx` (satisfies that file's own
       ">=2 view files" inclusion rule) with a `tone` prop preserving each call site's original
       accent color; both files now import it instead of forking it. This is why `shared.tsx`
       still shows a `fixed inset-0` click-catcher in the residual count below - it's now a
       single canonical implementation, not a duplicate.
     - **Lightbox cluster**: `StageDetailDialog.tsx`'s inline `lightboxPhoto` block and
       `ProductThumb.tsx`'s hand-rolled `createPortal` lightbox both now redirect onto
       `components/ui/AttachmentLightbox.tsx` (self-documented as the intended absorption point
       for exactly this duplicate). `AttachmentLightbox` gained an optional `kind?: 'image' |
       'video'` prop (default `'image'`, backward-compatible) to cover `StageDetailDialog`'s
       video attachments. `StageDetailDialog.tsx`'s `pdfPicker` block (deliberately dismissible
       ONLY via its Cancel button, never backdrop-click or Escape - mirrors the file's own
       `lockEscape` convention) needed raw `Dialog`/`DialogContent` rather than `Modal`, since
       `Modal`'s `lockEscape` only guards Escape, not backdrop-click - added an explicit
       `onPointerDownOutside` guard. **Residual, not executed**: `components/ui/
       VideoPreviewDialog.tsx` remains a separate primitive (still has 3 real call sites -
       `AttachmentSection.tsx`, `AttachmentsPanel.tsx`, `JobDetailPage.tsx`) near-duplicating
       `AttachmentLightbox`. Merging two already-in-use primitives with their own call sites is a
       bigger decision than "redirect a straggler onto an established primitive" (there wasn't
       yet a clear canonical between the two before this phase); flagging explicitly rather than
       silently merging or silently dropping.
     - **`SchedulePage.tsx`'s 6 inline blind-spot overlays**: the single biggest miss (no named
       components, all `{state && (...)}` blocks reading local state directly in the page's
       return). 3 migrated - "Ghost Confirm Dialog" and "Confirm All Dialog" onto `ConfirmDialog`
       (rich list body via its `children` slot), "Plan Mode Exit Dialog" onto `Modal` (needed 3
       footer actions, more than `ConfirmDialog`'s fixed 2-button footer holds). **3 left as a
       documented residual with inline comments**: "Conflict Modal", the empty-crew warning (D5),
       and the D6 unschedule confirm. Traced through the actual handler code: these three can be
       triggered from INSIDE an already-open `EventEditor`/`UnifiedDropModal`, which the file's
       existing gating logic (`open={!conflictToast && !unscheduleConfirm}` etc.) deliberately
       prevents from co-existing with a real Radix dialog, because Radix's exit-animation
       Presence keeps the old dialog mounted mid-close, and swapping in a second focus-trapped
       Radix dialog on the same tick reproduces the exact stacking/focus-lock bug the gating
       exists to avoid. `SchedulePage.tsx` has no test file, so this was judged too risky to
       force - a correct fix needs a redesign of the gating, not a mechanical primitive swap.
     - Guard-file consistency (mirroring the fix made in 2d): `ManageDirectoryModal` and
       `RescheduleConfirmDialog`'s (from 2d) `shadow-component-guard.test.ts` allowlist entries
       removed as each was migrated - the allowlist is down to 2 entries, both genuinely
       different variants, not duplicates (`SendInvoiceDialog` correctly uses Sheet already,
       `AddStepButton` correctly uses Popover already). One test file needed updates for DOM
       structure that no longer exists (`entity-sms-drawer.test.tsx`'s backdrop-click test ->
       Escape-dismiss test; `sms-compose-to-number.test.tsx`'s `.relative`-wrapper query ->
       `getByRole('dialog')`); `job-detail-page.test.tsx` was already updated in 2d.
     - tsc clean across the whole worktree; frontend 2675/2682 (exact match to baseline, zero
       regressions across all 6 agents); backend 6276/6320 (0 files touched). Ratchet: palette
       902 -> 897, white/black 1278 -> 1212 (a 66-site drop - the single largest of any phase 2
       sub-phase, from deleting dozens of hand-rolled `bg-white`/`bg-black/30` backdrop and panel
       divs across 27 files).
3. **The layering rule, enforced** - semantic components accept layout-only `className`; a
   call-site check fails the build when an appearance class is passed. Starts by removing the
   documented hatch at `KpiStrip.tsx:37`.

   **Measured 2026-07-26** (re-measure before acting - this number was 18 on a first naive
   single-line grep, then 1015 on a scanner that mis-attributed nested JSX inside prop values,
   before landing here). Scanner rule: a violation is an *appearance* class appearing as a
   **direct** `className` attribute on a component exported from `components/ui`,
   `components/data`, `components/layout` or `design-system` - 109 such components accept
   `className` today. `className` on nested JSX passed *through* a prop (a `footer={<div .../>}`
   or a `columns={[{ className }]}` cell) is NOT a violation; it is ordinary markup.

   **Corrected 2026-07-27 by the guard itself** - the three numbers below were the third
   estimate and still wrong. The guard (`layering-guard.test.ts`) is now the only authority;
   it sees template literals and self-closing tags that the throwaway scanner missed:

   - **487 hard occurrences** (not 453). Hard = background, text colour (token *or* palette - a
     perfect token at a call site is still a call-site decision), border colour, radius, shadow,
     ring, fill/stroke.
   - **255 soft occurrences** (not 250): type size, weight, tracking, leading, structural
     `border`/`border-t`. Deliberately **allowed** in phase 3 and tracked by a second, separate
     ratchet so the decision stays visible rather than buried. Folding them in would grow the
     phase by 55% for the least meaning-carrying classes; revisit after 3f.
   - **28 appearance-carrying props** (not 31), *all* `KpiTile.tint`/`accent`. This is the
     `KpiStrip.tsx:37` hatch, made countable.

   Three claims made before the guard existed, now retracted:

   - **`ResizableTable.color` does not exist.** The component has no `color` prop; those 3
     "violations" were `color=` on nested JSX inside a `columns={[...]}` render function. The
     nested-JSX exclusion removes them correctly.
   - **The bare colour words were never KpiTile.** `tint="yellow"`/`"red"`/`"green"` belong to
     a local `LegendDot`, and `tint="emerald"` to a local `ActionButton`, where those are valid
     domain values. There is no live no-tint bug. Retracted in full.
   - **Phase 1's registry did leak, and this part holds.** `CustomerDetailPage.tsx` and
     `InvoiceDetailPage.tsx` hand-roll `bg-amber-50 text-amber-700 border-amber-200` onto a raw
     `<Badge>` - status meaning re-decided at the call site, exactly what phase 1 existed to
     kill. It survived because it is spelled as a `Badge` override, not as a duplicate
     `StatusBadge`. 3f closes it.

   What the guard cannot see, recorded so it is not mistaken for zero: **local components that
   launder appearance through their own props.** `InventoryPage`'s `StatTile` was one and is now
   deleted, but `Chip.tint` (FiltersPopover), `ActionButton.tint` (ScanDialog), `FunnelCell.accent`
   (CampaignRoiReport), `Stat.tone="text-success"` (InventoryPage) and `LegendDot.tint` remain.
   They are outside phase 3's fence, which governs shared exports only. A phase 3g could pull the
   fence around local components too; that is a scope decision for the owner, not an oversight.

   Sub-phases, ordered cheapest-proof-first (same reasoning as phases 1 and 2):

   - **3a. Rule + guard + the KpiStrip hatch.** DONE 2026-07-27. `layering-guard.test.ts` written
     with three lowerable ratchets, discovering its governed set (109 shared components) rather
     than listing it, so a new primitive is governed the day it lands. Proved by injecting
     `className="bg-red-500 rounded-full"` on a real `<Button>`: 487 -> 489, reverted, green.
     `KpiTile.tint`/`accent` deleted; 28 sites mapped onto `tone`. **Props 28 -> 0.**
     Three things the sub-phase turned up that were not in the plan:
     - `tone`'s tint half was **dead code**: the tile always rendered `bg-white`, so `TONE[tone].tint`
       never applied. `tone` now drives the accent only and the surface is white always, which is
       what the file header documented as canonical all along. The 28 migrated tiles lose a
       background tint they had via `tint=`; that is convergence on the documented look, not a
       regression, and it is the "one canonical look" rule from phase 2 applied again.
     - `InventoryPage.StatTile` was a **local shadow wrapper** whose entire job was forwarding
       `accent`/`tint` into `KpiTile` (`emphasize={!!props.accent}`). Deleted; its 4 call sites
       now render `KpiTile` directly. The guard could not see it - it governs shared exports, and
       this was local. Same class of miss as the phase 2e `SchedulePage` inline overlays.
     - The tone vocabulary itself was **palette-named** (`emerald`/`amber`/`rose`), which is the
       exact sin the phase exists to kill: a call site saying `tone="emerald"` has named a colour,
       not a meaning. Renamed to `success`/`warning`/`danger` and `info`/`strong` added, across 28
       files, with `tsc` as a complete oracle. This widened 3a beyond its brief; flagged rather
       than done silently. Two blanket-rename overreaches were caught by `tsc` and reverted -
       `PhonePage`, `PriceBookPage`, `PurchaseOrdersPage` and `VendorsPage` have their own local
       `tone` unions that legitimately use palette names.
   - **3b. Surface redundancy.** DONE 2026-07-27. **487 -> 412 hard (-75).** `DropdownMenuItem`
     gained `variant="destructive"`, absorbing 20 hand-rolled `text-danger` items across 7 files -
     the single biggest win in the sub-phase and a concept that simply did not exist before.
     `PopoverContent` standardised on `rounded-card` + `shadow-lg` (it already shipped
     `border-border bg-white`), then 55 redundant surface classes deleted from 22 files across
     `PopoverContent`, `DialogContent`, `SelectTrigger`, `SheetTitle`, `DropdownMenuLabel` and
     `DropdownMenuContent`. Almost all of it was call sites re-declaring what the primitive
     already painted.
   - **3c. Small variant additions.** DONE 2026-07-27. **412 -> 344 -> 294 hard.** First pass:
     `Skeleton` gained `shape="block"|"circle"` (default radius moved to `rounded-card`), `Label`
     gained `tone="default"|"strong"`; 50 classes dropped and 19 promoted to props across 32
     files. `Label`'s 20 `text-text-secondary` sites turned out to be pure redundancy - the
     primitive already shipped it.

     Before finishing the tail, the guard itself needed a fix, found by re-measuring rather than
     trusting the "Calendar (4)" estimate: **`layering-guard.test.ts` scanned by JSX tag name
     only, blind to import source.** `Calendar`, `Badge`, `Sheet` and `Table` are all governed
     component names that also exist as same-named `lucide-react` icons; every one of the 6
     `<Calendar>` "violations" turned out to be the icon (`text-cyan-600`, `text-text-secondary`
     sized `h-4 w-4` - icon tinting, not the DayPicker primitive), imported from `lucide-react` in
     files that never touch `components/ui/calendar.tsx`. `Badge` was checked against the same
     collision and cleared - its 17 are all real. Fixed by making the guard import-aware:
     `importSources()` resolves each file's own imports (`@/...`, relative, or a bare package
     specifier) and `scanFile` now only counts a governed name when its import resolves to the
     component's own defining file; a name it cannot resolve is still counted, fail-safe, rather
     than silently exonerated. Two new detector tests lock this in. **344 -> 338 hard** from the
     fix alone, before any code changed.

     Tail, 338 -> 294:
     - `Avatar` gained `ring="none"|"stack"|"ai"` (`shadow-sm ring-2 ring-white` for a card tile,
       `ring-2 ring-ai-200` for the Copilot halo). `AvatarFallback` gained
       `tone="default"|"solid"|"subtle"|"custom"` - `custom` is `text-white` only, for the three
       AI-agent cards whose background is a *per-record* `style={{ backgroundColor:
       agent.avatarColor }}`, not a static class; the component still owns the one appearance
       decision it can make (white reads on any of them), the record still owns its own colour
       as data. 8 files, 23 -> 0.
     - `Input` gained `invalid?: boolean` (`border-danger`, replacing 9 hand-rolled sites across
       `CustomerFormPage` and `BrandingPage`) and `tone="sage"` (`border-sage-200`, matching the
       `tone="sage"` vocabulary `ReceiptCard`'s own local segmented control already used for the
       same deposit box - 1 site). **2 legitimate residuals left, documented rather than forced
       into a variant nobody else uses**: `AssigneeSelect.tsx:82` (`border-0
       focus-visible:ring-0` - a borderless search box inside a `PopoverContent` that already
       supplies the surface; a one-off "ghost" concept with no second call site to generalise
       from) and `ScopeOfWorkCard.tsx:148` (`bg-white` - an input sitting on a
       `bg-primary-subtle/30` dashed card, needing a solid fill to stay legible; also a single
       use). 12 -> 2.
     - `TableCell` gained `tone="default"|"muted"|"highlight"` (`muted` = `text-text-secondary`,
       6 sites; `highlight` = an overdue service-plan date). The call site's original
       `text-rose-600` did not survive into the primitive - the canonical-surface token guard is
       zero-tolerance for raw palette classes even inside `components/data`, so `highlight`
       converged onto the existing `danger` token instead of adding a bespoke rose one. 5 files,
       7 -> 0.
     - `TrendDelta` gained `tone?: 'success' | 'danger'`, independent of `direction`. The one call
       site (`KpiCard.tsx`) needed exactly this decoupling already, by its own comment: "a falling
       cost can be good" - glyph shape follows the number's sign, tint follows business meaning.
       `direction` alone was never going to cover it. 1 file, 4 -> 0.
     - `Calendar`: 0 real, per the guard fix above.

     Evidence: `npx tsc --noEmit` clean, full frontend `npx vitest run` 325 files / 2691 passed /
     7 skipped (0 new failures, 2 added for the import-aware guard).
   - **3d. The tabs cluster.** DONE 2026-07-27. **294 -> 167 hard (-127), 253 -> 202 soft (-51).**
     Real count was 127, not the estimated ~89 (`TabsTrigger` 105, `TabsList` 18, `Tabs` 4) -
     re-measured by the guard rather than trusting the phase-3 estimate, per the standing rule.

     `Tabs` gained `surface?: 'plain' | 'card'` (it was a bare `TabsPrimitive.Root` re-export
     with no className handling at all until now; `card` = `rounded-card border border-border
     bg-white shadow-card`, JobDetailPage's 8-tab scaffold). `TabsList` gained `variant?: 'line' |
     'pill'` (`line` = the existing default, unchanged; `pill` = `bg-background-light`,
     PriceBookPicker). `TabsTrigger` gained `variant?: 'line' | 'underline' | 'underline-fill' |
     'pill'`:
     - `line` - the existing default, rebuilt from a shared `TRIGGER_BASE` plus a per-variant
       class map instead of one fixed string, so variants can't leak conflicting classes onto
       each other (each variant supplies its own complete border/text/size, never a partial
       override of another variant's).
     - `underline` - the dominant pattern: `border-b-[3px] border-transparent`, `text-primary`
       and `font-semibold` when active. Found duplicated near-verbatim in 7+ places: inline 7x in
       `LeadDetailPage`, behind a local `TAB_TRIGGER_CLASS` constant in `JobDetailPage` (10 uses)
       and `TasksHubPage` (7 uses), inline in `PriceBookPage`, `VendorsPage` (3x) and
       `PurchaseOrdersPage`'s `TabStripTrigger`. `InvoiceDetailPage`'s own `TAB_TRIGGER_CLASS` was
       almost entirely redundant with the plain `line` default (`border-b-2`, not `border-b-
       [3px]`) - deleted outright rather than migrated to a variant nobody needed.
     - `underline-fill` - `CustomerDetailPage`'s own pattern, already centralised once in
       `lib/tab-styles.ts` (`tabTriggerClass` + `tabContentClass`) but never promoted into the
       primitive, so the guard still charged every call site for it. No border on the trigger;
       instead wraps `children` in an internal span with an `after:` pseudo-element bar
       (`group-data-[state=active]:after:bg-primary`) - the primitive now does this wrapping
       itself, so the 8 call sites no longer hand-author the wrapper span. `lib/tab-styles.ts`
       deleted (its only consumer).
     - `pill` - `PriceBookPicker`'s segmented-control look (`rounded`, `bg-primary-subtle` +
       `text-primary` when active).

     `TabsList`'s 18 violations were almost entirely pure redundancy, not a missing variant: the
     base already ships `border-b border-border` with no `bg-*`/`rounded-*` at all, so
     `rounded-none`/`bg-transparent`/a duplicated `border-border` at 7 of 8 call sites were no-ops
     against a component that never set those properties - deleted rather than converted. Same
     finding as 3b's `PopoverContent` redundancy, recurring.

     One guard blind spot found and left open rather than papered over: `className={
     TAB_TRIGGER_CLASS}` / `className={tabTriggerClass}` (a bare identifier, not a string or
     template literal) is invisible to `classTokens()` - it doesn't resolve the identifier to the
     string it names, so those 26 call sites (JobDetailPage 10, TasksHubPage 7, InvoiceDetailPage
     5, CustomerDetailPage 4) contributed **zero** to the pre-migration count despite being the
     exact duplication phase 3 exists to catch. All 26 were migrated anyway, on the merits, not
     because the guard demanded it - but the guard itself still cannot see this class of
     violation today. Recorded so a future "0 hard violations" reading is not mistaken for "no
     call site anywhere hands a shared component a bare appearance-string constant"; closing it
     would mean resolving local/imported string-constant identifiers in `scanFile`, deliberately
     not attempted here given the risk of false positives against legitimate `cva()`/`cn()`-result
     variables.

     Evidence: `npx tsc --noEmit` clean, full frontend `npx vitest run` 325 files / 2691 passed /
     7 skipped (identical to 3c-tail's run - no new failures, no new tests needed since behaviour
     is covered by each page's existing render tests).
   - **3e. Button.** DONE 2026-07-27. **167 -> 97 hard (-70).** Real count was 77, not 79 - close
     this time, but still re-measured rather than trusted. The dark-surface inverse was real but a
     minority (4 sites); five distinct families were duplicated across the app, not one:
     - `onDark` (4: `ApprovalCard`, `CopilotPanel`, `CopilotSheet`, `SchedulePage`'s plan-mode
       toolbar) - `text-white/70 hover:bg-white/10 hover:text-white`. Idle opacity varied 60-80
       across sites; picked 70 as the one canonical value rather than keep three near-identical
       variants for a barely-visible difference. `ApprovalCard`'s version was `variant="outline"`
       with a `border-white/20` override; converged onto the same borderless look as the other
       three - a Cancel button next to a `business`-coloured Confirm doesn't need its own border
       to read as secondary.
     - `ghostMuted` (8: every "Back" button on the four `*FormPage`s, every "Clear all" on the
       four list pages) - `text-text-secondary hover:bg-background-light hover:text-text-primary`.
       Plain `ghost` only styles its hover state; every one of these 8 sites was restating the
       idle half of the same pairing because the primitive under-specifies it. Scoped to a new
       variant rather than added to `ghost` itself - `ghost` is also the base for `onDark` and the
       two destructive-ghost variants below, and baking a text colour into it would fight their
       own overrides on Tailwind's cascade (rule order, not class-string order, decides ties).
     - `ghostDestructive` (10: inline delete/void/revoke rows) and `ghostDestructiveReveal` (4:
       `LODetailSheet`/`LOLinePicker` - muted until the row is hovered, then red) - two real,
       different semantics, not one. The bare `text-danger` sites (6 of the 10) relied on ghost's
       own `hover:text-text-primary` to fire on hover, which faded the delete affordance to grey
       on the one interaction where it matters most; standardising on
       `hover:bg-danger/10 hover:text-danger` for all 10 fixes that as a side effect of
       consolidating, not as a separate change.
     - `destructiveOutline` (4: `WorkflowSettings`'s danger zone, `PublicEstimatePage` x2,
       `SchedulePage`'s exit-plan-mode confirm) - the bordered sibling of the existing solid
       `destructive` variant. 3 of the 4 spelled it in raw `text-red-600`/`hover:text-red-700`/
       `hover:bg-red-50` instead of the `danger` token; converged onto the token, not the raw
       palette, closing 3 raw-Tailwind-class sites as a side effect.
     - Deleted outright rather than migrated: `disabled:bg-border` (`POEmailDialog`,
       `PrePODetailDialog`, `VendorDetailDialog`) and `disabled:bg-secondary disabled:text-white`
       (`ApprovalDetailDialog`) - four independent re-decisions of the disabled look that the base
       `disabled:opacity-50` (already in every variant) already covers.
     - **3 residuals left, documented rather than forced into a variant nobody else uses**:
       `EventEditor.tsx:229` (`text-text-soft hover:text-primary`, an icon-only "open full page"
       button) and `:415` (`text-primary hover:text-primary`, redundant but harmless) - both
       single-site, both in the same file, neither generalises. `SchedulePage.tsx:2482`
       (`bg-white text-amber-900 hover:bg-white/90`, a solid CTA on the amber plan-mode toolbar) -
       a one-off, not the `onDark` ghost pattern next to it. 7 hard remain.

     Evidence: `npx tsc --noEmit` clean, full frontend `npx vitest run` 325 files / 2691 passed /
     7 skipped (no new failures).
   - **3f. Badge + Card status leaks, then the long tail.** DONE 2026-07-27. **44 -> 33 hard
     (-11 in this pass; 3g below finds and closes 9 more of the 33, landing phase 3 at 29
     overall).** Real count for Badge+Card was 55 (17 + 38), matching the estimate for once.

     `Badge` gained `intent?: StatusIntent`, resolving through the exact `STATUS_INTENT_CLASSES`
     map `StatusBadge` already used - the phase-1 leak the spec called out
     (`CustomerDetailPage`'s "Archived" pill, `InvoiceDetailPage`'s "Deposit"/"Service Plan"
     pills, `PhoneSmsPage`'s SMS-readiness pill) all hand-rolled `bg-amber-50 text-amber-700
     border-amber-200` or equivalent instead of asking the registry. Confirmed rather than assumed
     equal to the token: `InvoiceDetailPage`'s `bg-sage-50 text-sage-700 border-sage-200` is
     byte-for-byte `success-surface`/`success-text`/`success-border` (`--success-text` and
     `--sage-700` are the same RGB triple) - not a coincidence, `success-border` is *defined* as
     `var(--sage-200)`. `CustomerDetailPage`'s amber matched to within 1 unit of rounding.
     `StatusBadge` (domain + status enum -> label + intent) stays the right choice whenever a
     status has a registry entry; `intent` is for the cases with no domain entry to look up (a
     boolean flag, a kind, a readiness check) - Badge, 17 -> 0.

     `Card` gained the same `tone?: StatusIntent` (background + border only - unlike Badge, a
     tinted callout's own text keeps its normal colours, so `tone` deliberately does not pull in
     `STATUS_INTENT_CLASSES`' text component). 12 raw-palette callout cards on the two
     customer-facing public pages (`PublicEstimatePage` 8, `PublicInvoicePage` 4) converged onto
     it, plus 2 already-tokenised ones on `PhoneNumbersSettingsPage`. `Card` also gained
     `flat?: boolean` (`shadow-none`, 2 sites: nested cards inside another panel that already
     provides elevation) - Card, 38 -> 2.

     The guard case that stops recurrence is the layering guard itself: it already fences `Badge`
     and `Card` like every other shared component, so a future hand-rolled `bg-amber-50` on either
     is caught the same way these were - no separate mechanism needed.

     Long tail, closed where a real second use existed, documented where it didn't:
     - `DialogHeader` and `SheetHeader` both gained `divider?: boolean` (`border-b border-border`)
       - 4 sites across 2 different primitives wanted the identical hairline-under-header, not
         spotted until scanning the tail because Card/Badge's 55 crowded it out. 4 -> 0.
     - `ResizableTable` gained `flat?: boolean`, the same concept and prop name as Card's, for the
       same reason (nested-in-another-panel reports). 4 -> 0.
     - `SelectTrigger` gained `invalid?: boolean` and `tone?: 'sage'`, mirroring `Input`'s own
       vocabulary exactly (`CustomerFormPage`'s `errors.source`, `ReceiptCard`'s deposit-box
       sibling to the `Input` already converted in 3c-tail). 3 -> 0.
     - **10 residuals left, documented rather than forced into mechanisms nobody else uses**:
       `SelectTrigger` in `InboxDirectory.tsx:299` (a 5-class custom focus-ring override, one
       site) and `VendorCategoryPicker.tsx:91-92` (5 more, including `borderCls`/`ringCls` -
       *local variables*, not classes; the guard's tokenizer accepts any bare lowercase-leading
       identifier as a token, the same blind spot 3d found in `TAB_TRIGGER_CLASS`, just
       unresolved here rather than migrated, given how deeply this component reimplements
       `SelectTrigger`'s whole surface for a two-element `inEdit` warning state shared between a
       `Select` and a plain `<input>`). `DropdownMenuItem` (7 across 4 files: `AiAssistMenu`'s
       AI-highlighted suggestion and its `text-text-primary` refine options, `SmsInboxView` and
       `CommJobMenu`'s identical disabled "No open jobs" placeholder, `InboxPage`'s snooze-option
       list) - a real duplicate pair (`SmsInboxView`/`CommJobMenu`) sits inside a wider scatter of
       one-off idle-colour choices with no single dominant shape the way Button's families had;
       narrower than 3e's variants would be guessing at intent instead of reading it off a repeat.
       `DialogContent` in `AiCenterModal.tsx:79` (`rounded-none bg-background-light`, one site).
       `PopoverContent` in `shared.tsx:321` (`ring-border`) and `PhonePage.tsx:398`
       (`shadow-2xl`) - two different one-offs in two different files, not the same concept twice.
       `Input`'s 2 (`AssigneeSelect`'s borderless popover search, `ScopeOfWorkCard`'s
       bg-white-on-tinted-card) and `Card`'s 2 (`ServicePlansPage`'s two empty-state messages,
       `p-8 text-center text-text-secondary`) carry over undecided from 3c-tail/3f - still single
       sites, still no second user to generalise from. 33 hard remain.

     Evidence: `npx tsc --noEmit` clean, full frontend `npx vitest run` 325 files / 2691 passed /
     7 skipped, tokens-guard (palette/white-black/hex) unchanged at 897/1212/50 and still green -
     several of this pass's conversions (raw `red-600`/`amber-50`/`blue-50`/`slate-50`/etc.) were
     themselves raw-palette classes, so the real palette count went down, not just the layering
     count, though the ratchet ceiling itself is phase 4's to lower.

   - **3g. Closed the bare-identifier blind spot 3d/3f both flagged and left open.** DONE
     2026-07-27. **33 -> 38 -> 29 hard.** The guard's `directClassNames`/`classTokens` pair reads
     a `className="..."` string and a `className={cn(...)}` call correctly (parens are token
     delimiters, so a call's literal arguments already fall out of the scan), but a bare
     identifier - `className={TAB_TRIGGER_CLASS}` - was never resolved to the value it names; the
     identifier itself either fails the token filter (uppercase-leading) or classifies as
     `layout` (lowercase-leading, matches no hard/soft prefix), so it silently vanishes either
     way. Fixed with `localStringConstants()`: a local `const NAME = '...'` (or `` `...` ``,
     optionally `+`-joined, never a function call) is resolved by name when `directClassNames`
     returns a bare identifier that matches one. Deliberately narrow - `const x = cva(...)` or
     `const x = cn(...)` never matches a string-literal-only right-hand side, so a computed
     variant result stored in a variable is never mistaken for a plain string; three detector
     tests lock this in, including one proving the cva/cn case stays unresolved (no new false
     positive).

     Turning the guard's own eyes on meant re-measuring before believing "0 real instances left" -
     33 -> 38 the moment the fix landed: `DropdownMenuItem` had 5 more sites hidden behind
     `InboxPage`'s local `menuItemCls` constant, on top of the 7 already-visible ones. All 9 (the
     5 plus `InboxPage`'s own inline snooze item and `AiAssistMenu`'s refine options, which used
     the identical `text-text-primary`-at-rest idea without a shared name) turned out to be one
     real, previously invisible pattern: `DropdownMenuItem` gained `tone?: 'default' | 'strong' |
     'muted'` - `strong` is always-readable text instead of only-on-focus (7 sites: the "More"
     menu, snooze options, AI refine options), `muted` is the disabled-placeholder pair
     (`SmsInboxView`/`CommJobMenu`'s "No open jobs") already flagged as a real duplicate in 3f.
     `DropdownMenuItem` 12 -> 3 - the one left is `AiAssistMenu`'s single AI-highlighted
     suggestion (`text-primary bg-primary/10`), a distinct one-off, not this pattern a third time.
     Net for the tree: 33 -> 29.

     Evidence: `npx tsc --noEmit` clean, full frontend `npx vitest run` 325 files / 2694 passed /
     7 skipped (3 new detector tests, 0 failures).

   Interaction with phase 4, stated so neither phase silently absorbs the other: phase 4 fixes
   *which* class a call site names (`bg-amber-50` -> `bg-warning-surface`). Phase 3 fixes whether
   the call site names a colour **at all**. The 157 `text-color-token` occurrences here are
   already perfect tokens and are invisible to phase 4's ratchet, which is precisely why phase 3
   has to run first: converting them in phase 4 would make them *look* compliant while leaving
   157 sources of truth in place.
4. **Layer-1 conversion** - palette classes, bare white/black, inline styles, raw hex. End
   state: ratchets at zero or residue enumerated with a written justification per entry.

   **Measured 2026-07-27, guard-verified** (re-measure before acting). Every number below is
   what `tokens-guard.test.ts` itself reports, comment-stripped, excluding `tokens.ts`/
   `tokens.css` and the two demo routes (`pages/prototype`, `pages/design-system`):

   | Category | Real | Ratchet ceiling | Guard |
   |---|---|---|---|
   | palette classes | 852 | 897 | existing |
   | bare white/black | 1184 | 1212 | existing |
   | raw hex in `.css` | 50 | 50 | existing |
   | raw hex in `.ts`/`.tsx` | 139 | 139 | **new, this prep** |
   | inline appearance literals | 31 | 31 | **new, this prep** |

   Two of those guards did not exist before this prep and the gap they closed is not cosmetic:

   - **Raw hex in `.ts`/`.tsx` was fenced by nothing at all.** The hex ratchet walked `.css`
     only, and the zero-tolerance hex check covers just the canonical surface, so 139
     occurrences across 26 page/feature files were invisible to every guard in the repo. This
     is where laundering lives: `activity-logic.ts`'s `BAND_HEX = { good: '#10B981' }` and
     `arAging.data.ts`'s `BUCKET_COLOR` reach both a `style={{}}` and a chart `fill=` as
     innocent-looking identifiers. `arAging.data.ts` is a live duplicate-with-drift:
     `ArAgingReport.tsx` computes the same six bucket colours from the `severityRamp` token
     while `arAging.data.ts` hardcodes them as hex.
   - **Inline `style={{}}` had no guard either.** A naive grep says 148 occurrences; that
     number is unusable. Broken down by property, 171 of 248 style properties are *geometry*
     (`width: `${pct}%``, `top: i * ROW_H`, `tableLayout`), which is legitimate by the same
     rule phase 3 already applies to `className`: a runtime-computed width cannot be a token
     and never could be. The fence therefore covers appearance properties only, and counts
     **literal values only**. An expression (`backgroundColor: agent.avatarColor`,
     `background: BUCKET_COLOR[b]`) is deliberately out of scope, because its value lives at
     its own definition site where the hex ratchet catches it. That split is what keeps this
     detector free of the identifier-resolution blind spot that cost phase 3 a whole
     sub-phase (3g) to close - there is nothing to resolve, by construction.

   Both new ratchets were proven the way the rules of engagement require, not assumed:
   injecting one `'#AB12CD'` and one `style={{ boxShadow: '0 0 1px red' }}` into a real
   component moved them 139 -> 140 and 31 -> 32 and failed the build; reverted, green.
   Three detector tests lock the geometry-vs-appearance split and the expression exclusion.

   **The first action of the phase is free.** The 897 and 1212 ceilings are stale: phase 3's
   own conversions dropped the real counts to 852 and 1184 without lowering them (3f flagged
   this explicitly - "the ratchet ceiling itself is phase 4's to lower"). 73 sites of slack
   to reclaim before a single file is touched.

   **Targets already exist and are already in use** - the white/black bucket needs no design
   decision, which is what makes it the mechanical one despite being the largest:
   `bg-white` (740) -> `bg-surface-light`, `text-white` (387) -> `text-on-fill`. Together
   those two spellings are 1127 of the 1184. `tokens.css` already records the reasoning at
   the `--text-on-fill` declaration: literal white "hardcodes the assumption that every fill
   is dark, which is the one thing that provably will not repaint if a token moves."
   Converting is also what makes dark mode possible later - `.dark` remaps `--surface-light`,
   so every converted site starts working the day the theme is switched on, and every
   unconverted one stays white forever.

   Distribution, for sizing rather than for trusting:

   - Concentration is high. 50% of palette+white/black lives in the top 29 files, 80% in the
     top 91, out of 287 files carrying any layer-1 violation at all.
   - Palette by family: neutrals (slate 195, gray 103) = 298; status (amber 155, emerald 93,
     rose 63, red 43, green 36) = 390; brand/info (blue 76, sky 24, cyan 16, indigo 6) = 122;
     misc (orange 23, pink 6, violet 5, yellow 4, teal 4) = 42.
   - Biggest single concentrations: `components/inventory` 287 white/black, `PublicInvoicePage`
     95 palette, `InboxPage` 60 palette, `components/communication` 190 white/black.
   - The 390 status-family palette classes are the ones to watch: any of them that encodes a
     domain state is a phase-1 registry leak that phase 3 could not see, because phase 3 only
     fenced shared components and these sit in pages. Expect real registry work in that
     bucket, not mechanical substitution.

   Sub-phases, cheapest-proof-first and dependency-ordered:

   - **4a. Lower the stale ceilings, then the raw hex in `.ts`/`.tsx`.** 897 -> 852 and
     1212 -> 1184 for free, then 139 hex. Ordered first because hex is the *root* of the
     laundering: converting `BAND_HEX`/`BUCKET_COLOR` at the definition site fixes their
     `style={{}}` and chart `fill=` consumers at once. Heavily concentrated - 80 of the 139
     sit in 5 files (`lib/ai-center/agents.ts` 31, `lib/api/_mock/inventory/inventory.ts` 17,
     `NotificationItem` 11, `SchedulePage` 11, `TagInput` 10). Two of those are likely
     documented residuals rather than conversions (per-agent avatar colours and mock fixture
     data are both record data, the same call phase 3 already made for `AvatarFallback`), so
     the real conversion target is nearer 91. Decide that explicitly, do not let it drift.
   - **4b. Inline appearance styles.** 31 across 19 files. Runs after 4a because several
     reference the constants 4a rewrites. Three clusters, not 31 one-offs: the copilot
     glow/gradient effects (8), an identical chart-axis `fontSize: 10|11` repeated across 8
     report files (one shared constant, not 8 edits), and `SchedulePage` (6).
   - **4c. Bare white/black.** 1184, the largest bucket and the most mechanical - both target
     tokens exist, are already in use, and cover 1127 of the 1184. Parallelise by file, the
     way 2e did, never by utility.
   - **4d. Palette classes.** 852, the judgment-heavy bucket. Starts with one written
     family-and-role -> token mapping table, agreed before any file is touched; then executes
     against that table. Deciding the mapping once and executing by area is deliberate: doing
     it the other way round, area by area, re-decides what `amber-50` means in every area and
     rebuilds the exact drift this whole effort exists to remove. Execution splits by family
     group so each goal has one coherent decision behind it: **4d-i** neutrals (298),
     **4d-ii** status (390, the registry-leak bucket), **4d-iii** brand/info + misc (164).

   **The 4d mapping table (written 2026-07-27, before any palette file was
   touched).** Measured with the guard's own detector, variant chain stripped so
   the table is one row per *decision* rather than per spelling. Deciding this
   once and executing against it is the whole point: deciding per area re-decides
   what `amber-50` means in every area and rebuilds the drift this effort exists
   to remove.

   Family, raw -> semantic:

   | Raw families | Semantic family | Note |
   |---|---|---|
   | slate, gray, zinc, neutral, stone | neutral / text / border / surface | chrome, no domain meaning |
   | emerald, green, lime | `success` | |
   | amber, yellow, orange | `warning` | orange folds into warning; it has no own family |
   | red, rose | `danger` | |
   | blue, sky, cyan | `info` | status only |
   | indigo, violet, purple, fuchsia | `ai` | reserved for AI moments |
   | pink, teal | case by case | no semantic home; decide and record each |

   Shade -> role. The status families carry four roles each, so the shade is what
   picks the role:

   | Raw shade | Used as | Role suffix |
   |---|---|---|
   | 50, 100 | tinted background | `-surface` |
   | 200, 300 | hairline, divider, ring | `-border` |
   | 400 | soft text or icon | `-text` (or neutral `text-soft`) |
   | 500, 600 | solid fill carrying white text (`bg-`, `fill-`) | `-strong` |
   | 600, 700, 800, 900 | label on a tint or on white (`text-`) | `-text` |

   Neutrals resolve to the plain text/border/surface tokens, not to a status
   family:

   | Raw | Token |
   |---|---|
   | `text-{slate,gray}-{700,800,900}` | `text-text-primary` |
   | `text-{slate,gray}-{500,600}` | `text-text-secondary` |
   | `text-{slate,gray}-{300,400}` | `text-text-soft` |
   | `bg-{slate,gray}-{50,100}` | `bg-background-light` as page canvas; `bg-neutral-surface` as a neutral status chip |
   | `bg-{slate,gray}-{200,300}` | `bg-neutral-border` |
   | `border-{slate,gray}-{100,200}` | `border-border` |
   | `border-{slate,gray}-300` | `border-neutral-border` |

   `bg-background-light` and `bg-neutral-surface` are the same value today. They
   are still two rows on purpose: one means "this is the page canvas", the other
   means "this is a neutral status chip", and only the second should follow the
   status families if they ever move.

   **The rule that makes 4d more than substitution:** if a class encodes a
   *domain state* - a job status, an estimate state, an invoice state - swapping
   `bg-amber-50` for `bg-warning-surface` is the WRONG fix. It is a phase-1
   registry leak that phase 3 could not see, because phase 3 fenced shared
   components only and these sit in pages. Route it through
   `design-system/status-registry.ts` instead. Substituting a token and calling
   it done is the failure mode of this sub-phase.

   2256 real sites is larger than any phase so far. The prep recommended six separate goals;
   **Ran's call, 2026-07-27, is one goal for the whole phase**, which is what this document's
   own "one goal per phase" rule says anyway, and matches how phase 3 actually ran (3c-tail
   through 3f went as a single combined condition). The sub-phases above stay as the execution
   order inside that one goal, not as six goals. Condition text:
   `md_files/specs/frontend/2026-07-27-phase-4-goal-condition.md`.

   The rules of engagement still forbid quietly redefining the phase to fit the turn budget:
   if a sub-phase proves too large inside the run, say so and propose the split rather than
   silently narrowing it.

   ---

   **4a. Stale ceilings + raw hex in `.ts`/`.tsx` - DONE 2026-07-27.**
   Ratchets `897 -> 852` and `1212 -> 1184` reclaimed for free (73 sites of slack phase 3 had
   already earned). Raw hex in `.ts`/`.tsx` **139 -> 66**, and 66 is a floor, not slack: every
   survivor is enumerated below with a reason.

   First, the guard was made to report itself. Every ratchet now prints its real count and its
   remaining slack on each run, so `npx vitest run tokens-guard.test.ts` *is* the measurement -
   no migration ever needs an ad hoc grep, which is the habit that put wrong numbers in this
   document repeatedly. `scanTsHex` and `stripComments` were exported so the guard and any
   reporting share one detector rather than two that can disagree.

   Conversions (73):
   - `arAging.data.ts` (6) - the flagged duplicate-with-drift is gone. There were literally two
     `BUCKET_COLOR` maps: a rainbow of six raw hexes in the data layer and a `severityRamp`-derived
     copy in `ArAgingReport.tsx` that shadowed it. One definition now, in the data layer, derived
     from the ramp; the report imports it.
   - `activity-logic.ts` (3) - `BAND_HEX` became `bandFill(band)`, resolving `--success-strong` /
     `--warning-strong` / `--danger-strong` at CALL time. Its 6 consumers were updated. `BAND_TEXT`
     also moved off `text-emerald-600`-style palette classes onto the `-text` roles (-3 palette).
   - `MetricDetailPanel` (3), `CallTrackingReport` (1), copilot cluster (12+2 gradients),
     WhatsApp channel brand (9), `NotificationItem` (11), `SchedulePage` (11), inventory print CSS
     (3), `Sidebar` (3), brand-colour default (8 -> 1), Google mark (8 -> 4, via dedupe).
   - Two real bugs surfaced and were fixed on the way. `NotificationItem` read
     `var(--color-primary, #0C2D3A)` - **that token does not exist**, so the hardcoded fallback was
     what shipped; the whole category map was pointing at names that never resolved. And the entire
     four-role status scale was missing from `tokens.ts`'s fallback map, so every
     `token('--success-strong')`-style read returned `#000000` under jsdom and SSR.
   - Two duplicates were removed rather than converted twice: the Google "G" SVG (byte-identical in
     `LoginPage` and `AcceptInvitePage`) became `components/brand/GoogleIcon.tsx`, and the copilot
     night surface (byte-identical inline gradient in `CopilotPanel` and `CopilotSheet`) became
     `components/copilot/surface.ts`.

   Tokens added, all because a conversion needed a value the scale did not carry:
   `--ai-300`, `--ai-gradient-to`, `--danger-on-dark`, `--warning-on-dark` (the `-text` roles are
   AA-tuned for a LIGHT surface and are unreadable on the copilot's dark one), `--ai-night-top` /
   `--ai-night-bottom`, `--amber-900` (the scale had exactly one amber, so an amber *ramp* had
   nowhere to start and a gradient had silently collapsed to a flat band), and the
   `--channel-whatsapp*` group. `--amber-900` is deliberately NOT registered as a Tailwind colour:
   doing so would mint `bg-amber-900`, a token spelled exactly like the thing the guard bans.

   Residuals (66), each with its reason:
   | Where | Count | Why it is legitimate |
   |---|---|---|
   | `lib/ai-center/agents.ts` | 31 | Per-record avatar identity. Consumed only as `style={{ backgroundColor: agent.avatarColor }}` - the same call phase 3 made for `AvatarFallback`. |
   | `lib/api/_mock/inventory/inventory.ts` | 17 | Seed FIXTURE data. Third-party vendor brand tones baked into `data:` URI placeholders that production replaces with real uploads. Re-theming ServWave must not repaint someone else's logo. |
   | `components/leads/TagInput.tsx` | 10 | Not a default - the user's swatch PICKER. The chosen value persists as `tag.color` in Postgres, so a theme change cannot repaint tags that already exist. |
   | `components/brand/GoogleIcon.tsx` | 4 | Google's registered brand mark. A re-themed Google "G" is a trademark problem. |
   | `copilot/voice/voiceLog.ts`, `voiceDebugTap.ts` | 3 | `%c` devtools console styling. Never renders in the app and cannot be themed. |
   | `lib/branding.ts` | 1 | DOM contract: `<input type="color">` accepts `#rrggbb` only, the API stores hex, and the help text shows the default to the user. One named constant, imported by both call sites. |

   **4b. Inline appearance styles - DONE 2026-07-27. `31 -> 0`.**
   Handled as the three clusters, not 31 one-offs: the copilot glow/gradients, the chart-axis
   `fontSize` repeated across 8 report call sites, and `SchedulePage`.

   The chart-label cluster turned out to have a better answer than "one shared constant":
   `chartTheme.ts` already exported `axisTick` with exactly that typography for the Recharts `tick`
   prop, so `chartLabelStyle` was *derived* from it rather than declared beside it - value labels
   and axis ticks now cannot drift apart. The 10-vs-11 drift across those 8 sites collapsed to 11.

   One detector correction was needed to reach zero, and it is worth recording because it is the
   opposite of relaxing a guard. Six survivors were CSS strings whose every value already came from
   tokens - `background: 'linear-gradient(135deg, rgb(var(--amber-900)), rgb(var(--warning-strong)))'`.
   Those are string literals, so the fence counted them, but they are not bypasses: re-pointing the
   token repaints them, and some properties (multi-stop gradients, computed-alpha fills) have no
   Tailwind spelling worth using. `scanInlineStyles` now exempts a literal that references
   `var(--...)` AND contains no raw colour. The exemption is deliberately narrow: `rgb(var(--x))`
   passes, `rgba(0,0,0,0.2)` and `linear-gradient(#fff, var(--x))` still fail, so a token reference
   cannot launder a raw value sitting next to it.

   Both new floors were proven the way the rules require, not assumed. Injecting `'#AB12CD'` moved
   hex 66 -> 67 and failed the build; injecting `boxShadow: "0 0 1px rgba(0,0,0,0.3)"` and
   `background: "linear-gradient(#fff, rgb(var(--primary)))"` each moved inline 0 -> 1 and failed.
   All three reverted green.

   **A THIRD laundering route, found mid-phase and closed.** Auditing the diff for bypasses turned
   up `shadow-[0_8px_30px_rgba(91,109,255,0.18)]` - a raw colour inside an ARBITRARY Tailwind
   value. Every existing fence missed it: not a hex, so the hex ratchet skips it; not a
   `style={{}}`, so the inline fence skips it; not `bg-slate-500`, so the palette detector skips
   it. And `rgba(91,109,255)` IS `--ai-600`, the value the token layer already owns, restated
   where nothing could see it. A new `scanArbitraryRgba` ratchet now fences it, counting only a
   channel that opens on a DIGIT so the correct spelling `rgb(var(--ai-600) / 0.18)` keeps passing.
   Four sites existed; they are being converted, not grandfathered.

   **4c. Bare white/black - DONE 2026-07-27. `1184 -> 0`.**
   The largest bucket and, as predicted, the most mechanical - but not blind substitution. The
   rule that decided every one of the ~1180 sites was ROLE, not spelling:

   - White as a SURFACE (card, panel, dialog, page background, input background) -> `bg-surface-light`.
   - White as a FOREGROUND on a solid coloured or dark fill (label, icon, hairline, focus ring,
     toggle knob, status dot, translucent hover highlight) -> `text-on-fill` / `bg-on-fill/NN` /
     `border-on-fill` / `ring-on-fill` / `fill-on-fill`.

   That distinction is the whole value of the sub-phase, because the two tokens diverge under
   `.dark`: `--surface-light` remaps to `#1F2937`, `--text-on-fill` does not move. Getting a
   toggle knob or a dark-chrome label backwards would make it vanish the day the theme switches
   on. Real examples the rule caught: `ui/switch.tsx` uses `bg-white` twice and needed two
   different answers (unchecked TRACK is a surface, the THUMB riding on it is a foreground);
   `Sidebar` and the whole copilot panel are dark surfaces where nearly every white is a
   foreground; a segmented control's raised pill on a recessed track is a surface, while the same
   pill's badge sitting on `bg-primary` is a foreground.

   `ring-white` needed its own call each time, and it split both ways: a halo that punches an
   element out of the SURFACE behind it (an avatar on a card, a notification badge) is
   `ring-surface-light`; a ring drawn ON a dark fill (`ring-offset-primary-dark`) is
   `ring-on-fill`. One site was initially converted the wrong way and corrected.

   Black got a token rather than an exemption. Every `bg-black/NN` was a modal scrim, and "how
   much does the app dim behind an overlay" is a design decision that was being re-guessed at each
   overlay, so `--scrim` was added and 11 sites now read `bg-scrim/NN`. `ring-black/5` is a
   different thing - an elevation hairline, not a scrim - and became `ring-border`, the token
   already doing that job everywhere else.

   The ratchet reaches ZERO, with no residual list, because the one category that would have
   needed one is invisible to the detector by construction: `background: white !important` inside
   the `@media print` CSS strings of the inventory preview dialogs is raw CSS, not a Tailwind
   utility, so `WHITE_BLACK_UTIL` never matched it. That is the right outcome either way - print
   white is PAPER, and a themed token there could render a dark page on a printer - but it is
   worth stating that those three sites are outside the fence rather than exempted by it.

   **4d. Palette classes - DONE 2026-07-27. `852 -> 0`.**
   Zero across the whole tree, not just the canonical surface, with no residual list. The `dark:`
   exemption still stands (dark mode is inert; those classes are dead code tracked separately for
   deletion) and the two demo routes are still skipped, since they exist to display raw palette
   values.
   The mapping table above was written into this document BEFORE any palette file was touched, and
   every agent executed against it rather than re-deriving it per area. That ordering is the point:
   deciding area by area would have re-decided what `amber-50` means in each area and rebuilt the
   drift this effort exists to remove.

   **One leak was not just found but CLOSED, and it is the one that mattered most.**
   `components/layout/search-shared.tsx` held `STATUS_DOT`: a single flat 17-entry
   `status -> colour` map covering job, lead AND estimate states at once, with a comment in the
   file apologising for the WON / CANCELLED / SENT collisions it could not resolve. That is
   precisely the cross-domain collision hazard the registry was built to replace, and phase 3
   could not see it because it fenced shared components only. Because the search rows already
   carried `entity_type`, it now resolves per domain:
   `statusDotClass(entityType, status)` maps entity -> domain, reads
   `STATUS_REGISTRY[domain][status].intent`, and renders through a local 6-entry intent -> solid
   fill map (`STATUS_INTENT_CLASSES` spells a tinted chip; a 6px dot needs a fill). `STATUS_DOT`
   and its `|| 'bg-gray-300'` fallbacks are deleted. The visible consequence is intended: search
   dots now agree with the badge the same record shows everywhere else, which means in-flight jobs
   and new leads move blue/green -> warning and `LOST` moves grey -> danger.

   **The remaining registry leaks are real, numerous, and NOT silently absorbed.** The phase-4 plan predicted
   "expect real registry work in that bucket, not mechanical substitution" for the 390 status-family
   classes. That was correct, and the honest finding is that it is bigger than a token conversion
   should swallow. Every one below was converted to tokens so the tree is clean, and every one is
   recorded here rather than fixed by inventing registry domains - creating 8+ new domains is a
   layer-3 design decision that belongs to the owner, not a side effect of a layer-1 pass.

   Four are outright DISAGREEMENTS between the registry and what ships today, and they form a
   pattern worth naming rather than four separate bugs: **on both customer-facing documents the
   page deliberately de-escalates a state the internal registry treats as needing attention.**
   - `invoice.OVERDUE` is `danger` in the registry; `PublicInvoicePage` paints it `warning`.
   - `estimate.PENDING` is `warning` in the registry; `PublicEstimatePage` paints it `info`.
   - `estimate.DECLINED` is `danger` in the registry; `PublicEstimatePage` paints it `neutral`,
     identical to `ARCHIVED`.
   - `invoice.PARTIAL` is `warning` in the registry; `InvoicesReport` paints it `info`.

   If "do not alarm the homeowner" is the intended rule, it is a real product decision that the
   registry cannot currently express - it has one intent per state, with no notion of an internal
   vs customer-facing audience. That is the shape of the fix, and it is layer-3 work.

   Domain-state maps the registry cannot key, because the report/UI vocabularies are synthetic
   Title-Case strings rather than the backend enums the registry uses: `JobsReport.STATUS_STYLE`,
   `LeadsReport.STATUS_STYLE`, `InvoicesReport.STATUS_STYLE`.

   Domains the registry does not model at all: approval ACTION type (`approvalTypeTint`, distinct
   from the approval STATUS it does model), blocked-caller reason (`BLOCK_REASON_TONE`), commission
   settlement (Settled/Unsettled), OT review state (suggested domain `otReview`), punch geofence
   (suggested `punchZone`), task PRIORITY (it models task status), customer archived state,
   line-item origin (Estimate vs Job), price-book item type (MATERIAL/SERVICE), attachment context,
   and ad source.

   One case where routing through the registry would be actively WRONG today: the walkthrough
   banners in `WalkthroughTab` and `LeadDetailPage`. The registry maps both
   `WALKTHROUGH_SCHEDULED` and `WALKTHROUGH_COMPLETED` to `warning`, so routing them would make
   scheduled and completed indistinguishable. That needs a product decision, not a mechanical fix.

   The cleanest follow-up: `CalendarView`'s `STATUS_DOT` / `STATUS_CHIP` are the `task` domain,
   fully covered by the registry, with intents that line up exactly - but neither shape fits,
   because `STATUS_INTENT_CLASSES` only exports the full `bg`+`text`+`border` trio. A dot needs a
   bare fill and a chip needs hover states. The registry wants a per-intent fill export.

   Costs accepted, recorded rather than hidden:
   - Ad sources collapse 8 categories to 5 and attachment contexts collapse cyan+blue to one
     `info`, because the token set has no CATEGORICAL scale. No information is lost (each badge
     renders its own label) but colour redundancy is.
   - `AD_SOURCE_STYLES`, the MATERIAL/SERVICE map, and the attachment-context map are each
     copy-pasted verbatim across two files - duplicates this pass surfaced but did not hoist.
   - `pink` and `indigo` were routed to the `ai` family per the table, which sits in tension with
     `tailwind.config.js` calling `ai` "reserved for AI moments". `StatusIntent` has no `ai`
     member, which is itself evidence domain badges were never meant to reach it. Five sites.
   - Gmail's brand red became `danger-strong` in four places (the canonical constant in
     `communication-shared/email.ts` plus three duplicated literals that were matched to it).
     This is the one conversion that made something actively WORSE: a red "danger" dot now marks a
     *healthy* Gmail connection. It wants a `channel-gmail` token alongside the `whatsapp` group
     added in 4a. Flagged rather than fixed, because minting a second channel-brand family is a
     token-layer decision, not a substitution.
   - Categorical tints collapse wherever the source used hue purely to distinguish. `LABEL_TONE`
     in `InboxPage` mapped five email labels to five hues; blue and sky both resolve to `info`, so
     **Lead and Billing now render identically**, and the table also gives Vendor a "warning" and
     Reviews a "danger" meaning the raw colours never carried. Same mechanism, harmless, in the
     hash-based `AVATAR_TINTS` (6 slots -> 5). The root cause is that the token set has no
     CATEGORICAL family - only semantic ones. That is the single clearest thing the token layer is
     still missing after this phase.
   - `hover:` on a tinted surface has no token answer: `bg-amber-50` and `hover:bg-amber-100` both
     map to `-surface`, so the hover disappears. Two agents independently reached for
     `hover:bg-{family}-border/30..40` to keep a perceptible darkening. There is no house rule for
     this; the scale wants a `-surface-hover` role.

   Two more registry findings from the communication sweep:
   - **`emailAccount` is a CONFIRMED leak into a domain that already exists.** `InboxPage`
     hand-rolls Gmail connection status at 6 sites, and the states map exactly onto the registry's
     `EMAIL_ACCOUNT_STATUS` - `EmailSettingsPage` already renders the same thing via
     `<StatusBadge domain="emailAccount">`. It was NOT routed, because routing is not a colour
     change here: the labels differ, one branch is a `<button>` that triggers the connect flow, and
     each pill carries a status dot the badge has no slot for. Real follow-up, correctly scoped out.
   - WhatsApp message delivery state (`sent | delivered | read`) is a domain the registry does not
     model.
   **4e. Raw hex in `.css` - DONE 2026-07-27. `50 -> 0`, plus a seventh ratchet.**
   Not in the original sub-phase split: the `.css` hex ratchet read `50 / 50` at baseline, and
   "no slack" was mistaken for "at floor". It was neither - all 50 were ordinary convertible
   values, and raw hex is named in this phase's own scope line. 46 sat in `schedule-dark.css`,
   which despite its name is not a dark theme at all but the schedule's light,
   Google-Calendar-styled react-big-calendar override sheet.
   - Three were verbatim `--ocean-800` and two verbatim `--ocean-900`, exactly as the guard's
     header comment predicted.
   - Two were `#F7F7F2`, the warm canvas `tokens.css` records as SUPERSEDED. Both moved to the
     current cool canvas; that colour shift is the drift being removed, not a regression.
   - The Google-red `#ea4335` current-time bar became `--danger` (terracotta). The most visible
     change on the page, and called out rather than slipped in.
   - All four hexes in `RangeSlider.css` were inside COMMENTS; the rules were already tokenised.
     The documentation was the entire debt, and no rendered colour changed.

   Then a seventh fence, for the same reason the third one existed: after the hexes were gone,
   `schedule-dark.css` still held eleven `rgba(...)` literals, six of them `rgba(12, 45, 58, x)` -
   a verbatim copy of `--primary`. Fencing hex alone reads green over every one of them. All
   eleven are converted and `MAX_CSS_RGBA` now guards them. Its floor is 3, all the same residual:
   `RangeSlider.css`'s `.dark .range-slider__track { background: rgb(30 41 59) }` and the two
   comment lines explaining it. It is dark-mode-only, which the palette guard already exempts
   tree-wide because dark mode is inert, and it deliberately matches the `dark:border-slate-800`
   its sibling Card and Input use - converting it alone would make it diverge from them.

   **Phase 4 final state, guard-verified 2026-07-27.** Every ratchet at its real floor, every
   floor above zero enumerated with a written reason, and every one proven by injecting a
   violation and watching the build fail:

   | Ratchet | Start | End | Floor is |
   |---|---|---|---|
   | palette classes | 852 | **0** | clean |
   | bare white/black | 1184 | **0** | clean |
   | raw hex `.css` | 50 | **0** | clean |
   | raw rgba() `.css` | 11 | **3** | one dark-mode-only rule + its 2 comment lines |
   | raw hex `.ts`/`.tsx` | 139 | **66** | 6 enumerated residual classes (table in 4a) |
   | inline appearance | 31 | **0** | clean |
   | arbitrary rgba() | 4 | **0** | clean |

   2256 measured sites at the start; 2190 converted, 66 residual. The guard grew from 4 fences to
   7 - and three of the new ones (hex in `.ts`/`.tsx`, inline appearance, arbitrary rgba) cover
   laundering routes that NOTHING in the repo had ever fenced.

   What phase 4 deliberately did NOT do, and what should be booked as follow-on work rather than
   assumed done: the registry leaks catalogued above are converted to tokens but not routed
   through `status-registry.ts`, because that means inventing 8+ new domains and resolving 4
   registry-vs-page semantic disagreements - layer-3 design decisions that are the owner's call,
   not a side effect of a layer-1 conversion. The clearest gap the phase exposed is that the token
   layer has no CATEGORICAL scale: every collapse recorded above (ad sources 8 -> 5, trades
   5 -> 3, email labels, attachment contexts) traces to semantic status families being pressed
   into service as category colours.

5. **Close the Tailwind escape hatch** - `theme.extend.colors` to `theme.colors`, re-declaring
   `white`/`black`/`transparent`/`current`, plus the remaining radius scale. Must run last.
   Re-measured 2026-07-27 with a new detector (`scanSource(...).radius` in `tokens-guard.test.ts`) -
   the prior "1,328 sites" white/black figure was two phases stale (phase 4c cleared it to 0; real
   residue at the start of phase 5 was 41, all in guard fixtures/comments/skipped mockups, not code).
   Split into sub-phases, run in order (5c depends on 5a and 5b):
   - **5a. Name the radius scale, then convert** - DONE 2026-07-27. 1501 sites (not 1510) held a
     Tailwind default `borderRadius` key with no project registration: `rounded-md` 655,
     `rounded-full` 507, `rounded-lg` 323, `rounded-2xl` 12, `rounded-none` 4 (each including its
     directional variants, e.g. `first:rounded-t-lg`, `rounded-l-2xl`). Rather than rewriting 1501
     call sites to alternate spellings that would render identically, every one of those Tailwind
     keys was registered directly in `tailwind.config.js`'s `borderRadius` object - the same
     "two names, one primitive" pattern the file already used for `sm`/`DEFAULT`/`control` and
     `xl`/`card` - so `rounded-md` etc. remain valid spellings, now backed by a named token instead
     of Tailwind's implicit default scale. Zero site edits; zero visual regression except one
     deliberate one:
     | Class | Tailwind default | Registered to | Value change | Reasoning |
     |---|---|---|---|---|
     | `rounded-md` | 6px | `var(--radius-control)` | none (6px=6px) | coincides exactly with the existing control primitive |
     | `rounded-lg` | 8px | `var(--radius-card)` | **8px -> 6px** | sampled sites are cards/dropdown panels/textareas/dialogs - the card role, not a distinct size; repoints the drift into compliance with the documented "6px crisp" rule, the same move already made for `xl` |
     | `rounded-full` | 9999px | `9999px` (new `full` key) | none | kept as a separate key from the existing `pill` (9999px) rather than renaming 507 sites to `pill`, so `pill`'s documented narrow role (notify-count/avatar/switch) is not overloaded onto every circular element in the tree |
     | `rounded-2xl` | 16px | `var(--radius-bubble)` (new primitive) | none | all 12 sampled sites are chat/SMS message bubbles (copilot, SMS drawer, dialer training, compose panel) or the legacy floating `LineItemRow` row - consistently bigger than card, on purpose, not drift |
     | `rounded-none` | 0px | `0px` (new `none` key) | none | full-screen mobile dialog, `ResizableTable`'s flat variant, WhatsApp's pointed-bubble-tail corners - all intentional square corners |
     `--radius-badge` (defined in `tokens.css`, zero consumers, same 6px as `control`/`card`) was
     **deleted** rather than registered - grepped the whole tree including `Badge`'s own component
     (`ui/badge.tsx` uses bare `rounded`, i.e. `--radius-control`), confirmed no file referenced it.
     `rounded-3xl` (0 sites) and the `rounded-rect` sightings (4, all inside code comments describing
     an SVG path, not classNames) needed no action. A radius ratchet was added to
     `tokens-guard.test.ts` (`scanSource(...).radius`, ceiling `MAX_RADIUS_TREE = 0`) tracking the one
     Tailwind default key deliberately left unregistered (`3xl`) as the forward guard against the
     hatch effectively reopening. `node scripts/check-unresolved-classes.mjs` surfaced 19 pre-existing
     unrelated false positives once run for the first time (doc-comment prose in this same guard file,
     plus regex-literal source in `layering-guard.test.ts`'s color classifier - none are real class
     usage, none touch radius, all predate this phase per `git show HEAD`); baselined them explicitly
     (`--write`, 30 -> 49 entries, purely additive) rather than leaving the check permanently red for
     debt this phase did not create. tsc clean.
   - **5b. Kill the `dark:` exemption** - DONE 2026-07-27. Re-measured: 71 `dark:*-slate-*` sites
     across 13 `components/ui/*` files (not "~55"), six distinct shadcn shades (300/400/50/800/900/950).
     The bigger finding: `tokens.css`'s `.dark { --background-light: var(--background-dark);
     --surface-light: var(--surface-dark); }` already re-themes every `bg-background-light` /
     `bg-surface-light` call site with no `dark:` variant needed - so 27 of the 71 sites (every
     `dark:bg-slate-950`, plus the `dark:bg-slate-800` / `dark:hover:bg-slate-800` /
     `dark:focus:bg-slate-800` / `dark:data-[state=open]:bg-slate-800` instances sitting on a
     `bg-background-light`-family base) were pure dead weight fighting an already-correct auto-flip,
     not real conversions - deleted outright rather than re-pointed. The other 44 sites compensate for
     roles `.dark` does NOT reassign (`--border-color`, `--text-primary`, `--text-secondary`,
     `--primary-subtle`, `--border-soft`) and needed real tokens. Four new dark-surface-chrome
     primitives added to `tokens.css`, named by role rather than by which slate shade they replace:
     `--chrome-dark` (was slate-800 - border + secondary/hover bg where the base doesn't auto-flip),
     `--on-dark` (was slate-50 - primary text + the checkbox's inverted checked-fill), `--on-dark-muted`
     (was slate-400 - secondary/description text), `--focus-dark` (was slate-300 - focus ring colour).
     Ring-offset sites (was slate-950) reuse the existing `surface.dark` token rather than a fifth new
     one, since ring-offset just needs to match the surrounding panel. Checkbox's checked-state icon
     colour (was slate-900) reuses `text-text-primary` (16 32 43 vs slate-900's 15 23 42 - close enough
     that inventing a token for a 1-off near-duplicate would be the same drift this phase exists to
     remove). Found and fixed a real (if inert) bug along the way: checkbox.tsx carried
     `dark:border-slate-800 dark:border-slate-50` back to back with no state qualifier on either - two
     unconditional border-color rules on the same element, almost certainly a dropped
     `data-[state=checked]:` prefix. Restored the qualifier while converting it
     (`dark:data-[state=checked]:border-on-dark`). Confirmed via whole-tree grep that no
     `dark:*-slate-*` (or any other palette family) exists anywhere outside `components/ui` before
     removing the exemption, so removing it is a no-op today and a real fence going forward; updated
     the six asserted-example tests that encoded the old tolerate-dark behaviour. `RangeSlider.css`'s
     `.dark .range-slider__track` - phase 4's documented reason `MAX_CSS_RGBA` sat at 3, "matches
     `dark:border-slate-800`" - was routed through the same `--chrome-dark` token; the residual reason
     no longer exists, so the ratchet dropped 3 -> 0 (not left at the old ceiling with slack). While
     rewriting that comment, noticed it also named `input.tsx` as sharing the pattern; input's border is
     actually structural (`border-transparent`) and has never carried a `dark:border-*` class - a
     pre-existing inaccuracy, unrelated to this phase, corrected in passing. tsc clean, `npx vitest run`
     325 files / 2705 passed / 7 skipped (was 2703 - the two new radius/ratchet assertions from 5a),
     zero regressions.
   - **5c. Close the hatch** - DONE 2026-07-27. `theme.extend.colors` -> `theme.colors`,
     `theme.extend.borderRadius` -> `theme.borderRadius`; `fontFamily`/`boxShadow`/`spacing`/
     `keyframes`/`animation` stayed under `extend` (they only ever added keys, never replaced a stock
     scale, so they were never the hatch). Re-measured 2026-07-27, not the spec's stale "1,328 sites":
     `transparent` 75 (not "70"), `current` 3 (2 `fill-current`, 1 `text-current` - confirmed by hand,
     `aria-current`/`save-current`/`always-current` are prose false matches from a greedy grep, not
     Tailwind classes), `inherit` 0 (and was never a real Tailwind default key to begin with - not
     registered, would have been inventing one). `white`/`black`: 0 production sites (phase 4c already
     cleared them); the only consumers are this guard's own test fixtures and the two `TREE_SKIP`'d
     `pages/design-system` mockup pages, both of which need the LITERAL colour rather than a token that
     could later repaint out from under them - registered as literal `#ffffff`/`#000000`, not routed
     through `--surface`/`--scrim`. `transparent`/`current` registered as Tailwind's own keyword values
     (`'transparent'`, `'currentColor'`) - zero site edits for any of the four, same "register the key"
     pattern as 5a.

     Closing the hatch surfaced one thing none of the prior sub-phases' greps had caught: Tailwind's
     default preset derives `borderColor.DEFAULT` from `theme('colors.gray.200', 'currentColor')` - with
     no `gray` family left in `colors`, that fallback silently resolved to `currentColor`. Verified by
     diffing compiled Preflight output against `HEAD` (`*, ::before, ::after { border-color: ... }`):
     `#e5e7eb` before, `currentColor` after - exactly the flip this sub-phase's own condition named as
     the thing to confirm didn't happen. It did happen, and would have meant any element relying on a
     bare `border` utility with no explicit `border-{color}` rendering its border in its own text colour
     instead of a neutral line - not always visible (many elements' text and intended border are close in
     tone), which is what let it slip past every visual/count-based check up to this point. Fixed by
     re-declaring `borderColor` explicitly as its own theme key -
     `({ theme }) => ({ ...theme('colors'), DEFAULT: 'rgb(var(--border-color) / <alpha-value>)' })` -
     spreading `colors` back in so every `border-{token}` utility (`border-danger`, `border-primary/20`,
     etc.) keeps resolving, while pointing the bare-`border` default at this project's own border token
     instead of Tailwind's stock gray-200. Verified both halves directly against the compiled CSS: the
     Preflight rule now reads `border-color: rgb(var(--border-color) / 1)`, and `border-danger` /
     `border-primary` / `border-primary/20` / `border-transparent` / `border-current` / `border-border`
     all still compile.

     `node scripts/check-unresolved-classes.mjs` against the real (now hatch-closed) config surfaced 21
     new entries - the check working exactly as designed, not incidental noise. Every one traced by hand:
     3 are historical comments in production files describing already-completed migrations
     (`components/ui/badge.tsx`, `button.tsx`, `components/data/table.tsx` - prose like "the call site's
     `text-rose-600` converged onto the existing `danger` token", not live classNames); the rest are this
     guard's own asserted-example fixtures (`tokens-guard.test.ts`, `layering-guard.test.ts`) or
     `.not.toHaveClass(...)` / `.not.toContain(...)` regression assertions in component tests
     (`TechnicianGridView.test.tsx`, `select-item-highlight.test.tsx`) confirming an OLD raw class is
     gone - none are live rendered UI, none depend on the class actually resolving. Baselined
     (`--write`, 49 -> 70 entries, purely additive). tsc clean, `npx vitest run` 325 files / 2705 passed /
     7 skipped, zero regressions from before the hatch closed.
   - **5d. Make it stick** - DONE 2026-07-27. `scripts/check-unresolved-classes.mjs` was wired into no
     test and no CI job, confirmed by grep before starting; CI's frontend job (`.github/workflows/ci.yml`)
     runs `npm test -- --run --retry=2`, which is `vitest run` scoped to `src/**/*.test.{ts,tsx}` only
     (`vitest.config.ts`) - `scripts/` itself is outside that glob, so the fix is a thin wrapper inside
     `src/`, not a CI YAML change. Added
     `src/design-system/__tests__/unresolved-classes-guard.test.ts`, importing the script's existing
     `extractCandidates`/`findUnresolved` exports and asserting the result against the committed baseline
     - same comparison the CLI already did, now gated in the suite CI already runs. Needed one companion
     file, `scripts/check-unresolved-classes.d.mts` (TS resolves a plain sibling `.d.ts` against a `.mjs`
     import under `moduleResolution: "bundler"`, but not against `.d.ts` - it wants the `.d.mts` extension
     specifically; confirmed by trying `.d.ts` first, watching `tsc` still fail with TS7016, then renaming).
     Proved the new guard is real, not vacuous, per the "guard before migration" rule: injected a genuine
     violation (`bg-totally-fake-nonexistent-color-xyz123` in a scratch file), watched the test fail with
     the offending class printed, deleted the scratch file, watched it pass again. (A first attempt at this
     - `rounded-3xl`, thinking it'd trip the radius ratchet - didn't fail at all, because that exact string
     was already sitting in the baseline from 5c's own asserted-example fixtures; switched to a string with
     no possible baseline collision.) The radius ratchet added in 5a already sits alongside the seven
     colour ratchets in `tokens-guard.test.ts`'s single ratchet block - no separate sub-phase work needed
     here, just confirmed it still reports on every run (`unregistered radius 0 / 0`).

   **Phase 5 final state, guard-verified 2026-07-27.** Every ratchet at floor (eight now, radius added
   5a), the unresolved-class check clean against a purely-additive baseline (30 -> 49 -> 70 entries
   across 5a/5c, zero real violations baselined at any step), zero production sites touched by 5a's 1501
   radius conversions or 5c's four re-declared keys (every one resolved by registering a Tailwind key,
   not editing a className string), and one real bug the closure work surfaced and fixed along the way
   that no prior phase's greps had caught: Preflight's default `border-color` silently flipping from
   `#e5e7eb` to `currentColor` once `colors` lost its `gray` family, verified by diffing compiled CSS
   against `HEAD` and fixed with an explicit `borderColor` theme key.

   | Sub-phase | Sites converted | New tokens/keys added | Real bugs found+fixed |
   |---|---|---|---|
   | 5a radius | 1501 (0 site edits - all via key registration) | `--radius-bubble`; `md`/`lg`/`2xl`/`none`/`full`/`bubble` Tailwind keys; `--radius-badge` deleted (stranded) | - |
   | 5b dark exemption | 71 (27 deleted as redundant, 44 converted) | `--chrome-dark`/`--on-dark`/`--on-dark-muted`/`--focus-dark` | checkbox's unconditional double `dark:border-*` (missing `data-[state=checked]:` qualifier) |
   | 5c close hatch | 78 (0 site edits - `transparent`/`current`/`white`/`black` via key registration) | `transparent`/`current`/`white`/`black` colour keys; explicit `borderColor` theme key | Preflight `border-color` silently flipped to `currentColor` |
   | 5d make it stick | - | `unresolved-classes-guard.test.ts` wired into `npm test` (and therefore CI) | guard proved live via injected-violation test, not just asserted |

   tsc clean. `node scripts/check-unresolved-classes.mjs` clean (70-entry baseline, purely additive
   across the phase). `npx vitest run`: 327 files / 2707 passed / 7 skipped (was 325 / 2703 / 7 at phase
   4's close - the growth is new guard assertions, zero regressions). `npx vitest run
   src/design-system/__tests__/tokens-guard.test.ts`: 26/26 green, every one of the eight ratchets
   printed at its floor.
