# Mobile compatibility: rubric re-scored (slice 75)

- **Date:** 2026-10-06
- **Code scored:** branch `mobile/s75-gate-enforce`: `origin/staging` at `ac69ce524` plus slice 75 (builder round, fixer round 1 and fixer round 2).
- **Baseline:** the 2026-10-01 audit (`02-current-state-audit.md`, `origin/staging` at `3cecd6fbb`): 5 PASS, 13 PARTIAL, 67 FAIL, 3 untested, 1 N/A.
- **Standard:** `01-audit-rubric.md`, 89 items. Severity and the baseline verdict are copied from the audit's scorecard.

## How this was scored

Three kinds of evidence, and each row says which it rests on:

1. **The gate, measured.** One full sweep of `npm run test:mobile:sweep` on the branch: every key route and overlay (116 states) on all 15 device projects of the matrix, plus every targeted spec, the self-tests and the Lighthouse budget (75 minutes: 3,214 passed, 3 flaky and passed on retry, 246 skipped as not applicable to that device; the 11 failures were the specs `known-failing.json` records, which fail on staging itself, and one new `schedule` offender that is now documented in the allow-list). The allow-list was rebuilt from that sweep: a pair that measured clean was deleted (so it is enforced), and every pair that still offends is documented with an owner and a reason in `frontend/e2e/mobile/allowlist.json`.
   **Fixer round 1 (2026-10-07), after the first review.** The first re-score left 50 report pairs, most of them colour contrast and small ARIA findings that are page fixes, not decisions. They were fixed in the pages and the tokens, and the gate was re-run in two ways on the final code: (a) `MOBILE_GATE_ENFORCE_ALL=1` over every state (116) on all 15 devices, which treats even an allow-listed pair as a failure: 1,612 passed, 83 skipped (not applicable to that device), 120 failed, and every failure is one of three things: `vendorConsole` lines (115; report-only by design, see below), the scheduler's double-booked cards (documented, Ran's decision) and the inbox reader on a landscape phone (slice 46); (b) the plain gate (`npm run test:mobile`, six devices, every targeted spec): 1,968 passed, 1 flaky (a seed request answered 500 and passed on retry), 5 failed: the 4 specs in `known-failing.json` (Filters-popover date sheet x3, job document delete on desktop) and `settings-users` on the iPad Mini, which passes when the dev server is warm and failed twice on a cold or loaded one (a late layout moves the Team column's centre across its scroll box's edge; the check now waits for fonts and re-tests the clip when it judges).
   **Fixer round 2 (2026-10-07), after the independent check.** (a) The plain gate's one new failure, `settings-payments` (axe `color-contrast` on the single `.rounded` node on every touch device, then never again), was found and fixed: the throwaway org carries a fake connected account, the nightly account-status refresh on staging (07:30 UTC) fails it closed, and the payments status badge moves from "Active" to "Under review"; its amber tint was 4.38:1 and the red one 4.19:1. The tints are now the design system's own surface and text pairs, a Vitest test computes every tint from the token file, and the gate measures the Under review and Paused states on their own (the status read stubbed), so the route no longer depends on when a run happens. Reproduced red on the old badge (4.39 and 4.19 on the `.rounded` node), green on the new one on six devices. (b) `MOBILE_GATE_SWEEP=1 MOBILE_GATE_ENFORCE_ALL=1`, `gate.spec.ts`, 15 projects, 118 states, no retries, 31.5 minutes: 1,647 passed, 83 skipped (not applicable to that device), 116 failed. Every failure is a documented pair: 110 are Firefox states (109 print the realtime socket URL into the console, one the phone embed's warnings), 2 are the phone tab on the iPad Mini (portrait and landscape: the phone embed's origin warning), 2 are the scheduler's double-booked cards (`schedule/targets` and `schedule/a11y` on the iPad Mini, portrait and landscape), 1 is the inbox reader on an iPhone SE held sideways (`comm-inbox/a11y`), and 1 was a page that navigated under a check (`settings-job-sub-statuses`, iPhone SE), which the gate now measures again once instead of failing. No other pair offended.
   **Fixer round 3 (2026-10-07), after the second review.** (1) The three copilot panel files are back to staging's text: the class-only `overscroll-contain` edits broke the rule that the copilot is never changed, so SCR-01 counts three lines lower. (2) `settings-users/scrollReach` on the iPad Mini failed whenever the desktop control ran beside it: the users table scrolls up and down inside its own box, the box's own 11 px scrollbar sits over the right edge, and the Team select's raw centre fell under it, so the hit test landed on the box. The check now judges a control at the centre of the part a finger can reach (its rect cut to every clipping ancestor's content box); a red/green fixture in `selftest.spec.ts` fails on the old rule and passes on the new one. (3) The date-picker-sheet Filters spec follows the phone Filters sheet, and `known-failing.json` is empty.
   **Staging fix 1 (2026-10-07), after the staging check of the merge.** The plain gate (`npm run test:mobile`, six devices, 3 workers) exited 1 on the merged staging commit: `hover-policy.spec` "job photo and document delete" failed. The "passes on desktop" claim in round 2 was true only when the spec ran alone. The six projects upload to the same throwaway job, so the Photos card held several tiles, and on a touch device each tile's two 44 px buttons (Actions and Delete) were wider than the 43 to 67 px tile and spilled over the neighbour: the next tile's Actions button covered this tile's Delete (a real defect on a job with two or more photos on a phone or tablet, not only a gate artefact). Fixed in the page (two columns on touch, buttons in a row under the picture), and the spec now uploads a second photo of its own, asserts each tile's buttons stay inside the tile (red on five touch devices before the fix, green after) and re-hovers on every poll. The throwaway org also hid three colour-contrast cases the demo org showed: the dashboard's red delta chip, "past due" pill and Needs Attention badge (4.19:1, now the danger surface/text pair, with a Vitest test that computes them from the token file) and the Texting inbox "Auto text-back" label (opacity 0.8 dropped). So the claim "colour contrast clean on all 116 states" holds for the gate's own data, not for every shape of real data; the gate cannot see a state its throwaway org never has (past-due money, falling trends, mail in the inbox). The plain gate on the fix: 1,994 passed, 191 skipped, 0 failed, 0 flaky, exit 0, 49.9 minutes. `known-failing.json` is empty, which is now true on the commit that says so.
2. **The rubric's own static detect commands**, re-run against the live source (files reachable from the app entry; dead pre-redesign pages are not counted, as in the audit).
3. **The slice record and the committed specs** (`md_files/specs/qa/`), where the item is a device behaviour the gate emulates.

`[D]` items need a real device. **PASS [D]** means every emulated and static check passes and the real-device row of `md_files/specs/qa/real-device-run-01.md` is still marked "to be run by Ran": it is not a real-device pass. Nothing in this document claims a real-device result.

## Result

| Run | PASS | PARTIAL | FAIL | UNTESTED | N/A | critical (P/Pa/F/U/NA) | high | medium | low |
|---|---|---|---|---|---|---|---|---|---|
| Baseline (2026-10-01, `3cecd6fbb`) | 5 | 13 | 67 | 3 | 1 | 1/0/15/0/0 | 1/6/38/2/0 | 3/6/14/1/1 | 0/1/0/0/0 |
| Re-scored (this document) | 77 | 10 | 0 | 1 | 1 | 15/1/0/0/0 | 42/5/0/0/0 | 19/4/0/1/1 | 1/0/0/0/0 |

Columns on the right are per severity as PASS/PARTIAL/FAIL/UNTESTED/N-A for critical, high, medium and low.

**PRD target (every critical and high item PASS):** 57 of 63 critical and high items are PASS (12 of them PASS [D]: emulation passes, the real-device row is still to be run). 6 are not PASS: TOUCH-01 (PARTIAL), CMP-02 (PARTIAL), CMP-15 (PARTIAL [D]), PUB-02 (PARTIAL [D]), PERF-03 (PARTIAL), A11Y-04 (PARTIAL). Each carries its reason and the action that closes it in the tables below.


### VP: Viewport and layout

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| VP-01 | critical | PASS | **PASS** | Unchanged: `frontend/index.html:12` has `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`; no zoom lock anywhere. |
| VP-02 | high | PARTIAL [D] | **PASS [D]** | Slice 52. `viewport-fit=cover` is set and 59 `env(safe-area-inset-*)` uses pad the shell, bottom bars, sheets and the toaster. `safe-areas.spec` 20 passed (Chromium; 46 skipped where the engine cannot emulate insets). Real notch: RD-02. |
| VP-03 | high | FAIL [D] | **PASS [D]** | Slice 54. `interactive-widget=resizes-content` plus the `useKeyboardInset` visual-viewport fallback. `keyboard-inset.spec` 18 passed. Real keyboard: RD-03, RD-04, RD-05. |
| VP-04 | critical | FAIL | **PASS** | Rubric pattern now has 5 live hits, none a bare `100vh` frame: the legacy toast viewport (never mounted), two `min()`/`clamp()` caps in the email composer bounded by `--visible-height`, one comment. The task board's `calc(100vh - ...)` became `100dvh` in slice 75. Gate `overlays` is enforced on every overlay state. |
| VP-05 | high | PARTIAL | **PASS** | Rubric pattern: 0 hits (baseline: the pop-out Phone page). `phone-page-fit.spec` 12 passed. |
| VP-06 | critical | FAIL | **PASS [D]** | Gate `scrollReach` is enforced on every route on 15 devices x 116 states except one documented pair (the scheduler on the iPad in landscape: a covered double-booked card, the same Ran decision as TOUCH-01). Baseline offenders (login landscape, text Send, estimate detail) are clean. Slice 75 made the check scroll to the page end and judge a list that scrolls in its own box by whether the box is on screen; selftest red/green fixtures for both. Device: RD-01. |
| VP-07 | high | FAIL | **PASS** | `job-header.spec` 6, `detail-headers.spec` 30, `public-pages.spec` 23 passed; the invoice customer name no longer collapses (slices 28, 41, 55); `overflow` enforced. |
| VP-08 | high | FAIL | **PASS** | No bare `1fr` track is left (21 at baseline, 17 allow-listed at the start of fixer round 2): the last 17 are `minmax(0,1fr)`, the guard's allow-list is empty and its ceiling is 0, so a new one fails. The rubric's own command (`rg -n "grid-cols-\[[^\]]*1fr\|gridTemplateColumns" frontend/src \| rg -v "minmax\(0"`) now prints two lines, both `minmax(240px,1fr)` and `minmax(140px,1fr)` tracks that have a real minimum, which the guard accepts. |
| VP-09 | high | FAIL | **PASS** | Rubric pattern: 4 live hits, all tables inside their own named scroll box (Numbers, Training, call flows, call groups: product decision 3). The page overflows nowhere. `fixed-width.guard.test.ts` ratchet holds 7 (slice 75 retired one). |
| VP-10 | critical | FAIL | **PASS** | `overflow` and `topbarOverflow` are enforced on every route and overlay on 15 devices; no page scrolls sideways (baseline: 8 routes at 320, plus the Phone Numbers tab on every phone, fixed in slice 75). The main record lists and the line-items table from md up are documented intended scrollers (`record-list`, `line-items-table`). |
| VP-11 | high | FAIL | **PASS** | The invoice customer link and public emails wrap or truncate (slices 28, 55); `public-pages.spec` and the `overflow` gate are clean. |
| VP-12 | high | FAIL | **PASS** | Measured on landscape phones: the gate's `chromeRatio` (the top bar plus fixed or sticky bands at most 20% of the height, stricter than the rubric's 40%) is enforced on every route and now passes on all of them. Two causes were closed: the check counted a table's empty state that sticks only sideways (it scrolls away, so it is not chrome; the check now says so, with a red fixture for a band that sticks to the top), and the job page's Mark Complete dock stuck to the bottom of a 320 px tall screen (it is now the last row of the page on a short screen). The md layout keeps at least 200 px of content (`phone-page-fit.spec`, `scrollReach`). |
| VP-13 | medium | PASS | **PASS** | Unchanged (keep). |

### SCR: Scrolling

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| SCR-01 | high | FAIL | **PASS** | The rubric's own command (`rg -n "overflow-y-(auto\|scroll)\|overflow-auto" frontend/src`, test files and stories left out) finds 200 lines and 183 carry `overscroll`; 13 of the other 17 are comments that name the class. The four live scrollers without it are the legacy table wrapper (below) and the three copilot panel scrollers (`CopilotPanel`, `CopilotSheet`, `Transcript`), which are left alone because the programme never changes the copilot (the same exclusion the PERF-01 bundle count makes). Counting tests and stories too it is 239 and 187. Fixer round 2 swept every list, popover, menu, sheet and dialog body scroller, and the four CSS scrollers (`.canvas-body`, `.sb-nav`, the all-day cell and the phone month view) now have `overscroll-behavior: contain`. One scroller is deliberately untouched, because a Vitest guard pins its classes byte for byte: the legacy table wrapper (`components/data/table.tsx`, the desktop-parity freeze). The legacy auto-grow textarea does have the class, with its guard updated to list it. Earlier numbers in this row (43 of 168) were counted on a different file set than the detect command. |
| SCR-02 | high | FAIL | **PASS** | `dialogScrollers` is enforced (slice 65). The gate records nested vertical scrollers on every phone state: none (baseline: inbox, text, phone, WhatsApp, settings/profile). |
| SCR-03 | medium | PARTIAL | **PASS** | No live `window.scroll*` (0 hits); route changes reset the main scroller (slice 34). |
| SCR-04 | medium | PASS | **PASS** | Unchanged (keep). |

### KB: Virtual keyboard and forms

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| KB-01 | critical | FAIL | **PASS** | `inputFont` is enforced on every key route on touch devices (slice 14); `input-size.guard` passes; rubric static pattern: 0 live hits. |
| KB-02 | high | FAIL | **PASS** | Slice 36: every phone field is the phone input; `phone-field.guard` + `phone-fields.spec` 36 passed. |
| KB-03 | high | FAIL | **PASS** | Slice 23: field kinds for email, name, address, postal code, one-time code; `field-kind.guard` + `field-kinds.spec` 60 passed. |
| KB-04 | high | FAIL | **PASS** | Rubric pattern: 27 live hits, every one a chart axis; 0 form inputs are `type="number"` (baseline: about 92). `number-field.guard`, `money-fields.spec` 12 passed. |
| KB-05 | medium | FAIL | **PASS** | Search is `type="search"` with its enter key via the field kind; the create forms move with Next/Done (slice 38: `form-flow.spec` 24). `shortcut-hint.guard` passes. |
| KB-06 | critical | FAIL [D] | **PASS [D]** | Slice 54: composers, sheet footers and dialogs read the keyboard inset. `keyboard-inset.spec` 18, `sms-chat-single-pane.spec` 18 passed. Real keyboard: RD-03, RD-04, RD-05, RD-58. |
| KB-07 | high | PARTIAL [D] | **PASS [D]** | Slices 43 and 54: a focused field stays above the keyboard and the sticky footer (`keyboard-inset.spec` 18). Real keyboard: RD-03. |
| KB-08 | medium | FAIL | **PASS** | `autofocus.guard` holds every JSX `autoFocus` to `canAutoFocus()` (no keyboard on touch); `labels-autofocus.spec` 48 passed. |
| KB-09 | high | FAIL [D] | **PASS [D]** | Slices 57 and 66: notes, visit edits and walkthrough notes survive rotation, backgrounding and an update. `field-drafts.spec` 12, `drafts-walkthrough-and-create-guard.spec` 30 passed. Real reclaimed tab: RD-07, RD-08. |
| KB-10 | medium | FAIL | **PASS** | The baseline's orphan inputs are labelled (14 on company settings, 7 on new customer, 4 on new job: slices 24 and 33; `labels-autofocus.spec` 48 passed). The three axe `label` failures the first re-score still listed are fixed in slice 75: the Texting settings caller-ID field (`for`/`id`), the new-inventory camera input and the tax-rates fields (accessible names). axe `label` finds nothing on 116 states x 15 devices. |

### TOUCH: Touch input and hover

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| TOUCH-01 | critical | FAIL | **PARTIAL** | Gate `targets` is clean on every phone and every route (baseline: 104 under-24 px targets on tax rates alone), and axe `target-size` is clean everywhere except one pair: overlapping double-booked events in the scheduler are 20 to 26 px slivers on md-and-up screens and landscape phones (`schedule/targets` and `schedule/a11y`, documented in the allow-list; phones in portrait use the Day list). Slice 75 fixed the others the first re-score listed: the customer link on the Leads and Jobs lists (24 px target) and the filter checkboxes on a tablet (their rows were squeezed to 21 px by a missing `shrink-0`). Close it: Ran decides how simultaneous events are laid out (SchedulePage.tsx records that he chose side by side over the cascade). |
| TOUCH-02 | high | FAIL | **PASS** | `targets` is enforced on touch: top-bar icons, dialog close, checkboxes, switches, pagination at 44 px (slices 13, 22, 25, 26, 53). Slice 75 gave the notification panel's "Mark all read" a 24 px box. |
| TOUCH-03 | high | FAIL | **PASS** | `future.hoverOnlyWhenSupported: true` (`tailwind.config.js:96`); `hover-policy.spec` 20 passed. |
| TOUCH-04 | critical | FAIL | **PASS** | Rubric pattern: 6 live hits, all decorative glyphs (a chevron, a pencil), none an action; hover-only Delete is gone (slice 15, `hover-policy.spec`). |
| TOUCH-05 | high | FAIL | **PASS** | Slice 40: a disabled action explains itself on tap (`disabled-reasons.spec` 6; `disabled-reason-guard`). |
| TOUCH-06 | medium | PARTIAL | **PASS** | Slice 60: Plan Mode Confirm/Remove and widening a day by tap (`scheduler-tap-alternatives.spec` 12). The remaining mouse-only code is column and sidebar resizing, a desktop affordance. |
| TOUCH-07 | high | FAIL | **PASS** | The task board card is no longer `touch-none` (slice 32); the 11 live uses are drag handles, resize grips and the signature canvas. |
| TOUCH-08 | critical | FAIL | **PASS** | Every live `DndContext` has explicit sensors: board (mouse + touch long-press + keyboard), line items and the automation builder (pointer with a distance rule + keyboard, `touch-none` handles). |
| TOUCH-09 | high | FAIL (static) [D] | **PASS [D]** | Slices 32 and 58: a swipe scrolls, a long press drags (`task-board.spec` 18, `scheduler-touch-drag.spec` 22 on Chromium touch; WebKit swipes are synthesised). Real finger: RD-09, RD-10. |
| TOUCH-10 | critical | FAIL | **PASS** | Every drag has a tap path: settings lists and dashboard widgets (`reorder-by-tap.spec` 30), line items (`line-items-cards.spec` 18), scheduler (slices 60, 70), task board. |
| TOUCH-11 | medium | PARTIAL | **PASS** | The toast close is always visible (slice 27, `toaster.spec` 6); no other swipe gesture without a button. |
| TOUCH-12 | medium | PASS, needs device confirmation [D] | **PARTIAL [D]** | No handler navigates or mutates on a down event. But slice 73 reproduced F73-1: a scroll that starts on a row's three-dot button opens its menu (5 of 5 touch projects). No slice owns the fix (`ui-kit/components/ui/dropdownMenu.tsx`: open on the tap, not the press). RD-11. |

### CMP: Components and patterns

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| CMP-01 | critical | FAIL | **PASS** | Every `DataTable` renders cards below md (15 lists) and a table from md up; the gate finds no table wider than the viewport on a phone. Tablet tables scroll inside their own box (documented). Call log: slice 71; line items: slice 59. |
| CMP-02 | high | FAIL | **PARTIAL** | No live list is virtualised (the one `useVirtualizer` hit is a comment). Lists are bounded another way: tasks paged on the server (72), inventory (31), text threads one pane (69). The inbox list is slice 46 (PR waiting on Ran). Close it: virtualise or page the inbox and service-plan lists. |
| CMP-03 | high | FAIL | **PASS** | Slices 26, 53, 65: form dialogs are full-screen or bottom sheets below md with a 44 px close and a footer that does not move (`adaptive-overlay-forms.spec` 24, `legacy-modal.spec` 132, `remaining-dialogs.spec` 90 passed). |
| CMP-04 | critical | FAIL | **PASS** | `overlays` is enforced on every overlay state on the phones (menus, filters, Create New, notifications, pickers). The entity picker on the desktop control, the one pair that used to report, now passes. |
| CMP-05 | high | FAIL | **PASS** | Slices 44, 51, 64: the filter is a sheet below md (`popovers-and-pickers.spec` 24). Slice 75 gave the five remaining 320-340 px popovers (`w-80`, `w-[340px]`) a `max-w-[calc(100vw-1rem)]`. |
| CMP-06 | high | FAIL | **PASS [D]** | Slices 43 and 66: dirty guards on every create form and sheet (`dirty-guard.spec` 6, `create-forms-leave-guard`). System Back: RD-06, RD-39. |
| CMP-07 | high | FAIL | **PASS** | Slice 33 (global search is a full-screen sheet on phones) and 44 (searchable pickers full-screen): `popovers-and-pickers.spec` 24, `phone-drawer.spec` 10. |
| CMP-08 | high | FAIL | **PASS** | Slice 45: the date picker is a bottom sheet with 40 px days below md (`date-picker-sheet.spec` passes on the three phones, the iPad Mini and the desktop control; fixer round 3 repaired its Filters-popover test, which still looked for a "Created" tab that the phone sheet no longer has: below md the Filters panel is a sheet that drills into one facet, and the spec now follows it). |
| CMP-09 | high | FAIL | **PASS** | Slices 22, 41, 55: the drawer has a 44 px trigger, traps focus, closes on navigation and Escape (`phone-drawer.spec` 10); detail pages have a Back control (`job-header.spec`, `detail-headers.spec` 30). |
| CMP-10 | medium | FAIL | **PASS** | Clock in/out, Settings and Sign out are in the drawer (22); Mark Complete sits in a bottom dock in reach (41, `job-header.spec`). |
| CMP-11 | critical | FAIL | **PASS** | Slices 2 and 42: Day/agenda by default on phones, compact toolbar, month usable (`scheduler-phone.spec` 13 passed). |
| CMP-12 | high | PASS | **PASS** | Unchanged (keep); `overflow` clean on `schedule`. |
| CMP-13 | high | PARTIAL | **PASS** | Slice 9: both camera and library, per-file progress and retry on cellular. Verified on staging. |
| CMP-14 | critical | FAIL | **PASS [D]** | Slice 5: buffer = box x pixel ratio, at least 300 x 160 at 320, 44 px Clear, survives rotation (`signature.spec` 6 passed). Real 3x screen: RD-12. |
| CMP-15 | high | FAIL | **PARTIAL [D]** | Done: tap a number for Call or Text everywhere (slice 50, `contact-action.spec` 12) and the same-tab dialer by device (slice 63, `calling-by-device.spec` 5 passed + 1 flaky). NOT done: ringing the caller's own profile phone first (slices 11 and 21: the spike has not run, the request is not built). F73-2: the statement's PDF window opens after an awaited request and is predicted blocked on iPhone (RD-15, no slice owns it). RD-13, RD-46. |
| CMP-16 | medium | PARTIAL (static) | **PASS [D]** | Slice 27: one toaster, top-centre under the bar, always closable (`toaster.spec` 6). RD-16. |
| CMP-17 | medium | PARTIAL | **PASS** | Slices 3 and 41: the shared `TabStrip` is one scrolling row (`tabs-one-row.test`); the Phone page's sub-tabs and the Texting settings' sub-tabs (slice 75) do the same. |
| CMP-18 | medium | FAIL | **PARTIAL** | The four create forms, the visit dialog and Add Item are one column below sm (`form-fields.spec` 30, slice 20). The guard still holds 89 unprefixed form grids in other dialogs and pages (`form-grid.guard.test.ts` ceiling 89); the gate measures none overflowing. Close it: prefix them. |
| CMP-19 | low | PARTIAL | **PASS** | Slice 30: titles wrap, axes do not overlap (`reports-readable.spec` 24 passed). |

### PUB: Public customer-facing pages

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| PUB-01 | critical | FAIL [D] | **PASS [D]** | Slices 4, 5, 28, 47: the public estimate and invoice pass `overflow`, `inputFont`, `targets` and `overlays` on 15 devices, the signature spec, and open cold (`public-pages.spec` 23, `public-bundle.spec` 24). In-app browsers: RD-14, RD-17. |
| PUB-02 | high | FAIL | **PARTIAL [D]** | The public tree has no `window.open` and no download-only PDF (slice 4: the PDF link opens). F73-2 (statement window opened after an awaited request, `customers/StatementPage.tsx`) is predicted to be blocked on Safari and in-app browsers; slice 73 tied it to this item. RD-15. No slice owns it. |
| PUB-03 | high | FAIL | **PASS** | Slice 47: customers' links are served by a separate light entry; the build enforces at most 200 KB gzipped initial JS and no service worker on that page; `public-bundle.spec` 24 passed. |

### PWA: Installed and standalone mode

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| PWA-01 | high | FAIL | **PASS** | Slice 6: manifest has `id`, 192/512/maskable icons (`pwa-manifest.ts`), `apple-touch-icon` in `index.html`. |
| PWA-02 | high | FAIL (static) [D] | **PASS [D]** | Slice 52: header and bottom bars clear the notch and home indicator. RD-02. |
| PWA-03 | high | PARTIAL | **PASS** | Slice 67: "Update available" is applied without losing work (`update-available.spec` 12 passed). |
| PWA-04 | high | FAIL | **PASS** | Slice 8: a stale lazy chunk reloads once instead of landing on the error screen (`lib/platform/chunkRecovery.ts`, tests). |
| PWA-05 | medium | FAIL | **PARTIAL** | The in-scope part is done (slice 68: a failed detail load shows an error with Retry, `detail-tabs-and-errors.spec` 36 passed). Still open: (1) one failed `/api/auth/me` still signs the user out globally (`stores/auth.store.ts:187`, the `catch` in `runCheckAuth`); the PRD files that separately as the critical auth bug #2377, outside this programme; (2) no offline banner or mutation queue, which the PRD marks out of scope (0 hits for `onlineManager`/`navigator.onLine`). |
| PWA-06 | medium | FAIL | **PASS [D]** | Slice 6: `theme-color` and `color-scheme` are declared (`index.html:14,16`). Forced dark mode cannot be emulated: RD-18. |
| PWA-07 | medium | N/A | **N/A** | Unchanged: no push or badging APIs. |

### PERF: Performance on phones

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| PERF-01 | high | PARTIAL | **PASS** | Routes are code-split. Measured on this branch with `npm run build`: the staff entry is **344.0 KB gzipped excluding the copilot** (439.9 KB with it), under the 350 KB target, and the build enforces that 350 KB (`STAFF_CEILING_BYTES`, slice 61 round 2; the shimmed unused data, storage and functions clients took about 12 KB out). The earlier 361 KB and 363 KB figures were from before that round. The copilot is excluded by decision. |
| PERF-02 | high | UNTESTED | **PASS** | Slice 61 recorded INP at CPU 4x: open a job 120 ms, status, search, scheduler day all under 200 ms (`mobile-first-paint-measurements.md`). `first-paint-metrics.spec` needs `MOBILE_GATE_PROD_BUILD=1`, so it was skipped in this sweep. |
| PERF-03 | high | UNTESTED | **PARTIAL** | Lighthouse mobile: public estimate and invoice LCP 2.28 s / 2.26 s, enforced (slice 61 round 3). The technician landing page (the scheduler) is 7.3 s, still in report mode with a ceiling of 8 s; slice 61 records that the staff entry cannot reach 2.5 s without an auth-client or tracing decision for Ran. |
| PERF-04 | medium | FAIL | **PASS** | Slices 7, 31, 69, 70, 72 cut the heaviest routes (baseline: text 2,317 nodes, scheduler 1,772, inventory activity 1,628). The 1,500-node bar is asserted for inventory, inventory activity and staging, the unscheduled sheet and the text threads, and passes. Slice 75 repaired the stale activity assertion (it waited for a "600 total" label the page no longer shows) and removed it from `known-failing.json`. |
| PERF-05 | medium | FAIL | **PARTIAL** | Attachment tiles use thumbnails (slice 9), but 43 live `<img>` have no width/height or `loading` (baseline: none had). Close it: size and lazy-load them. |
| PERF-06 | medium | PARTIAL | **PASS** | `scrimBlur` is enforced and clean: every scrim blur is behind `pointer-fine:` (slice 16). The remaining `backdrop-blur` is the copilot (excluded) and one bar. |

### A11Y: Accessibility on mobile

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| A11Y-01 | critical | FAIL | **PASS** | Slice 6: the manifest has no `orientation` and nothing locks it (the only `orientation` hits are ARIA and separators). |
| A11Y-02 | high | FAIL | **PASS** | Slice 18: `text-200.spec` 54 passed on the measured screens. |
| A11Y-03 | high | FAIL | **PASS** | axe `button-name` and `link-name` find nothing on any of 116 states x 15 devices; `control-names.guard` passes (slices 25, 27, 33). |
| A11Y-04 | high | FAIL | **PARTIAL** | The navigation drawer, the activity rail (a Sheet on phones; the tablet panel is deliberately non-modal), the lightboxes and the schedule confirms are on the shared primitives (slices 16, 22, 56). One hand-rolled overlay is left: the inbox reading overlay, `InboxPage.tsx:744` (`fixed inset-0`), which is slice 46: PR #2460 is open, 33 commits behind staging and conflicting, waiting on Ran. |
| A11Y-05 | high | FAIL | **PASS** | Slice 16: reduced motion is app-wide (`overlay-motion.spec` 18 passed). |
| A11Y-06 | medium | FAIL | **PASS** | Slices 14 and 24: the email composer fields and the ghost input replace the outline with a `focus-visible` ring. |
| A11Y-07 | medium | FAIL (static) | **PASS** | Slice 38: an empty submit lands on the first invalid field, in view and linked to its error (`form-flow.spec` 24); the public shell's error banner is `role="alert"` and takes focus (`publicShell.tsx:90`). |
| A11Y-08 | medium | UNTESTED [D] | **UNTESTED [D]** | Static blockers addressed: list cards are one named link (slice 39), the signature pad has an accessible name (`signaturePad.tsx:124`, slice 5). A VoiceOver and TalkBack run has not happened: RD-20, RD-26, RD-37, RD-38. |

### TEST: Test infrastructure

| ID | Severity | Baseline | Now | Evidence |
|---|---|---|---|---|
| TEST-01 | high | FAIL | **PASS** | `playwright.mobile.config.ts`: six gate devices plus nine sweep devices from `devices[...]` (D0 to D13 and Firefox). |
| TEST-02 | high | FAIL | **PASS** | `overflow` runs on every key route and overlay on every project; `npm run test:mobile:sweep` runs all of them. |
| TEST-03 | high | FAIL | **PASS** | `targets` and `inputFont` run on every state; red/green fixtures in `selftest.spec.ts` (all pass). |
| TEST-04 | medium | FAIL | **PASS** | axe-core in the gate on touch devices (`a11y.ts`), with a per-rule allow-list. |
| TEST-05 | medium | FAIL | **PASS** | Real touch gestures (`touch.ts`, `touch-selftest.spec`) drive the board, scheduler and signature specs. |
| TEST-06 | medium | FAIL | **PASS** | Lighthouse budget in the sweep (slices 61, 62) and 58 phone baselines (slice 74). Three baselines (`lead-detail~statusChoice`) are out of date because #2515 added two lead statuses: re-record them. |
| TEST-07 | high | FAIL | **PASS [D]** | Slices 10 and 73: `real-device-release-checklist.md` and the run sheet `real-device-run-01.md` (58 RD rows marked "to be run by Ran"). |

## What is left, and who has to act

### Rows that are not PASS

| Item | What is open | Who |
|---|---|---|
| A11Y-04 | The email reader is still a hand-rolled overlay (slice 46). | Ran: rebase or "Update branch" PR #2460 onto staging, then the run re-verifies and ships it. |
| CMP-15 | The ring-the-caller's-own-phone-first request is not built (slices 11 and 21); F73-2 (statement PDF window) is predicted blocked on iPhone. | Ran: run the slice 11 spike with the test number, then a follow-up writes the proven request. Live calls were not touched by slice 75. |
| PUB-02 | F73-2, the same statement window (`customers/StatementPage.tsx`). | Ran: confirm on an iPhone (RD-15); then a fix opens the window inside the click. No slice owns it. |
| TOUCH-12 | F73-1: a scroll that starts on a row's three-dot button opens its menu (`ui-kit/components/ui/dropdownMenu.tsx`). | Ran: confirm by finger (RD-11); then a fix opens it on the tap. No slice owns it. |
| TOUCH-01 | Overlapping scheduler events are 20 to 26 px wide when four or more share a time. | Ran: decide how simultaneous events are laid out (fewer per column with a +N chip, a wider scrolling week, or the cascade he rejected). Then a slice builds it and deletes the three `schedule` allow-list pairs. |
| CMP-18, PERF-05 | Static ratchets: 89 unprefixed form grids and `<img>` without size. Neither is measured failing on any route. | A cleanup slice, or accept the ratchets as the standing guard. |
| CMP-02 | No virtualised list (lists are paged instead). | Waits on slice 46 (inbox). |
| PWA-05 | `/api/auth/me` failure still signs the user out (#2377, filed separately); no offline banner (out of scope). | Ran: schedule #2377. |
| PERF-03 | Technician landing page LCP 7.3 s (report, ceiling 8 s); Ran accepted this deviation on 2026-10-06 (`mobile-first-paint-measurements.md`). | Ran: the page-load tracing decision, if the 2.5 s target is wanted back. |
| A11Y-08 | No VoiceOver/TalkBack run. | Ran: real-device run, rows RD-20, RD-26, RD-37, RD-38. |

### The allow-list: 4 pairs on 2 routes, plus one report-only check, all documented

`frontend/e2e/mobile/allowlist.json` held 156 report pairs and 3 enforce pairs at the start of slice 75. The first re-score deleted the 102 that measured clean and kept 50. Fixer round 1 fixed or re-attributed all but four of those 50 by changing the pages and tokens, not by writing reasons. Left, each with a `slice`, a `reason` and, for axe, the rule ids it excuses (a Vitest test, `mobile-gate-allowlist.test.ts`, fails without them):

| Pair | Why it is still allowed | Who has to act |
|---|---|---|
| `comm-inbox/a11y` (`scrollable-region-focusable`, iPhone SE landscape) | Slice 46 owns this page; its PR (#2460) is open and waiting on Ran. This is the one exception the run brief listed (a slice not merged on staging). Closes when 46 merges. | Ran: update and merge #2460. |
| `schedule/targets`, `schedule/a11y` (`target-size`), `schedule/scrollReach` | Double-booked events side by side are 20 to 26 px wide; a layout decision for Ran (see TOUCH-01). **This is a third exception the run brief did not list.** `SchedulePage.tsx` records that Ran chose side by side over the cascade, which is why it is held here and not changed in a page. | Ran: accept the exception, or decide how simultaneous events are laid out. |

Not a route/check pair, but listed the same way: **`vendorConsole` is report-only by design** and is recorded under `reportOnlyChecks` in `allowlist.json` with an owner (`unowned`) and a reason; the same Vitest test fails if a check is made report-only without that entry. It is **another exception the brief did not list**: the project rule says the browser console may not name a vendor. What the last sweep found: 109 states on the Firefox project print the realtime socket URL when its socket is refused, 3 phone-tab states (Firefox and the two iPad Mini projects) print the phone embed's origin warnings, and the payments page's own two lines (the processor's script was fetched on every visit) are gone, because the script is now loaded only when the setup drawer starts. No copy edit removes the rest, and they land on different devices each run. Ran has to accept this, or the phone embed and the realtime transport have to change.

Not on the list at all: `vendorTerms` (enforced from day one, clean).

The calling slices (11 and 21) have no pair here because nothing is built: the live-call behaviour (ringing the caller's own phone first) is unproven until Ran's slice 11 spike. The layout parts of 63 and 71 are merged and enforced.

The Lighthouse budget has one report-mode page left: the technician landing page (slice 61: LCP 7.28 s against 2.5 s, ceiling 8 s; accepted by Ran). The public estimate and invoice are enforced and pass (2.27 s, 2.26 s).

`known-failing.json` (specs that fail on staging itself) is now empty: its last entry, the Filters-popover date sheet spec (slice 45), was spec drift and is repaired in round 3. The inventory activity assertion was repaired in the first round and the job-document delete entry on the desktop control is removed in round 2 (the spec passes there).

`reorder-by-tap.test.tsx` ("Dashboard widgets in edit mode") failed in the independent check's environment, with the tree reverted to staging as well. Round 3 found the cause: the copied `frontend/.env` and `frontend/.env.local` files, which make the dashboard fetch real URLs; with them moved aside the file passes 18 of 18. It is an environment trap for whoever runs the Vitest suite in a worktree, not a defect of this branch. The builder's 10 s `waitFor` is harmless and stays.

### The real-device run

Slice 73 wrote the run sheet and ran its emulation half: 58 rows marked "to be run by Ran" in `md_files/specs/qa/real-device-run-01.md`. Every `[D]` item above is **PASS [D]** until Ran records the run there. The checklist is `md_files/specs/qa/real-device-release-checklist.md`.

### The phone visual baselines

`test:mobile:visual` passes 49 of 52; the three failures are `lead-detail~statusChoice` on the three baseline phones, because staging's walkthrough-statuses change added two lead statuses to the menu. Re-record those three (`npm run test:mobile:visual:update` after looking at the diff). Slice 75 changed no baseline.
