# Communication - components with no kit equivalent

Module 12. Pages rebuilt under `frontend/src/pages/v2/communication/`:
`PhonePage`, `TextPage`, `WhatsAppPage`, `InboxPage`, `PhoneTabPage`.
Routes registered by `pages/v2/routes/communication.{paths.ts,routes.tsx}`.

The behaviour map (`md_files/specs/ui-redesign/communication-behavior-map.md`) is
materially stale; the disagreements are listed at the bottom of this file. Everything
below was read from the code.

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `communication/phone/CallsView` | component | PhonePage | the whole call log: 9-facet filter panel, 8 stat cards, search, page size, export, row drawer, per-row callback/block/dismiss | `data/dataTable` | the table is the smallest part of it - the drawer, the recording player, the job reassign menu and `useCallsPipeline` are the feature | - | KEEP |
| `communication/phone/CallFlows` | component | PhonePage | node-graph IVR builder that replaces the list in place | none | the kit has no canvas, no node editor and no target picker | - | KEEP |
| `communication/phone/CallGroups` | component | PhonePage | ring-group editor with per-person device toggles | none | - | - | KEEP |
| `communication/phone/NumbersView` | component | PhonePage | owned-number inventory, portalled ad-group and flow menus, buy-a-number slide-over | none | the two menus measure and flip themselves against the viewport; a kit Popover changes the DOM position and breaks the measurement | - | KEEP |
| `communication/phone/CallMaskingView` | component | PhonePage | five-step masking accordion, TTS disclaimer preview | none | - | - | KEEP |
| `communication/phone/BlockedCallersView` | component | PhonePage | blocked-number list + block modal | none | - | - | KEEP |
| `communication/phone/TrainingView` | component | PhonePage | training scenarios, history, and a Web-Speech call simulator | none | - | - | KEEP |
| `communication/phone/DispatchView` | component | PhonePage | callback queue + recent-calls board | none | - | - | KEEP |
| `communication/phone/PerformanceView` | component | PhonePage | agent scorecards and the agent drawer | none | - | - | KEEP |
| `communication/phone/SmsInboxView` | component | TextPage | three-pane SMS messenger, unrouted tray, job reassign | none | the kit has no messenger layout and no composer | - | KEEP |
| `communication/phone/TextingView` | component | TextPage | templates, automations and SMS compliance editors | none | - | - | KEEP |
| `communication/phone/Dialer` (`DialerWorkspace`) | component | PhoneTabPage | search + softphone + call-history pane; the CTM device owner | none | the kit ships no dialer and no WebRTC surface; `V2AppLayout` already reuses `GlobalDialer` from the same file for the same reason | (shell) | KEEP |
| `communication/phone/shared` (`DateRangeControl`) | component | PhonePage | preset + custom date range, anchored on the module's own "now" | `form/datePicker` | the kit picker is a single date, not a preset list feeding a range | - | KEEP |
| `communication/inbox/ComposeWindow` (`ComposeWindow`, `InlineComposer`, `NoMailboxChip`) | component | InboxPage, readingPane | Gmail-style floating and inline composers, attachments, AI assist | `ui/dialog` | a compose window is docked and non-modal by design; a Dialog would trap focus and block the mail list behind it | - | KEEP |
| `communication/inbox/InboxDirectory` (`ManageDirectoryModal`) | component | InboxPage | members / groups / forwarding management modal | `ui/dialog` | would be a genuine a11y win (it is hand-rolled, no `role="dialog"`) but converting it is a behaviour change needing sign-off, and the file is shared with the legacy page | - | KEEP |
| `communication/shared/atoms` (`JobBadge`) | component | WhatsAppPage, InboxPage, readingPane | the ocean job pill and its muted "no job" counterpart | `ui/badge` | Badge has no "job pill" tone and the no-job fallback is part of the contract; it is also rendered by the legacy Jobs and Customers tabs, so a v2 copy would fork the look | Jobs, Customers | KEEP |
| a tabs primitive | kit API | PhonePage, TextPage | tab strip with `role="tablist"` / `role="tab"` | none - the kit ships 21 primitives, none of them tabs | every module so far has hand-rolled one; this module reuses `pages/v2/leads/components/tabs.tsx` rather than writing a tenth | Leads, Jobs, Customers, Estimates, Invoices, Settings, Service Plans, Tasks, Automations | BUILD |
| `data/progress` tone | kit API | components/planUsage | a progress bar whose fill colour carries the warning (green / amber / red by threshold) | `ui/progress` | the indicator is hard-coded `bg-brand` with no `tone` prop and no way in; substituting it silently deletes the limit warning | - | BUILD |
| `data/statCard` icon | kit API | PhonePage | the legacy KPI tiles carried a channel icon per tile | `data/statCard` | StatCard deliberately ships no icon slot ("a briefcase glyph beside Open jobs carries no information"). Accepted, not worked around - the `tone` rail carries the same colour coding | - | KEEP |

## Replaced (the audit trail)

Every `@/components/...` import in the four legacy pages plus `pages/phone/PhoneShell.tsx`,
and what the v2 pages do with it.

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/use-toast` (`useToast`) | `ui-kit/components/ui/sonner` (`toast`) | PhonePage + TextPage. Both toasters are mounted globally by `App.tsx`; the message strings are unchanged. The two PAGE-LOCAL toasters (WhatsApp, Inbox) were NOT moved to sonner - see "Behaviour not reproduced" |
| `ui/modal` (`Modal`) | `ui-kit/components/ui/dialog` | the Reach-sales composer. Gains a real `role="dialog"` and focus trap |
| `ui/popover` | `ui-kit/components/ui/popover` | the plan-usage panel |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | the reading pane's Snooze and More menus |
| `ui/empty-state` (`EmptyState`) | `ui-kit/components/data/emptyState` | the inbox list's two empty states, and the access-denied bodies on Phone and Text |
| legacy `ModuleTab` / `TabButton` (page-local) | `pages/v2/leads/components/tabs.tsx` (`TabStrip`) | Phone's 7-section nav, Phone's 3 sub-tabs, Text's 2 tabs |
| legacy `KPITile` (page-local) | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | `aria-pressed` and the active state are the primitive's; the tone rail replaces the tinted card |
| legacy `PlanUsage` / `PlanUsageMeter` / `ReachSalesModal` (page-local) | `pages/v2/communication/components/planUsage.tsx` | same copy, same thresholds, same non-persistence; kit Popover + Dialog + Button + Input + Label + Textarea |
| legacy `ReadingPane` (page-local) | `pages/v2/communication/components/readingPane.tsx` | still mounted twice by the page |
| legacy folder rail (inline in InboxPage) | `pages/v2/communication/components/inboxRail.tsx` | kit Button rows + Badge counts + Avatar |
| legacy `IconBtn` (from `inbox/ComposeWindow`) | `ui-kit/components/ui/button` (`variant="ghost" size="icon-sm"`) | reading-pane action bar only. `IconBtn` is still imported and used INSIDE `ComposeWindow`/`InlineComposer`, which are reused whole. Both `aria-label` and `title` are still set to the same string |
| legacy raw `<select>` caller-ID picker (PhoneShell) | `ui-kit/components/ui/select` | same `aria-label="Calling from"`, same option labels including the ` (Company)` suffix |
| legacy header `<h1>` (all four pages) | `ui-kit/components/layout/pageHeader` (`PageHeader`) | PageHeader owns the only `h1`; the reading pane's subject and the phone tab's title use `role="heading"` + `aria-level` so the raw-tag ratchet stays at its floor |
| legacy search inputs (WhatsApp, Inbox) | `ui-kit/components/form/searchInput` | gains a clear button and Escape-to-clear; the filter predicate is unchanged |
| legacy avatar spans + `tintFor`/`getInitials` (WhatsApp, Inbox) | `ui-kit/components/ui/avatar` (`Avatar`) | the kit's own hash tint replaces the page-local one |
| legacy status/label/unread pills | `ui-kit/components/ui/badge` | inbox labels map to the soft variants: Customer -> softGreen, Vendor -> softAmber, Lead/Billing -> softBlue, Reviews -> softRed, unknown -> softNeutral |
| `communication/phone/BlockedCallersView` | reused as-is | |
| `communication/phone/CallFlows` | reused as-is | |
| `communication/phone/CallGroups` | reused as-is | |
| `communication/phone/CallMaskingView` | reused as-is | |
| `communication/phone/CallsView` | reused as-is | |
| `communication/phone/Dialer` (`DialerWorkspace`) | reused as-is | props untouched, `surface="phone-tab"` preserved |
| `communication/phone/DispatchView` | reused as-is | |
| `communication/phone/NumbersView` | reused as-is | |
| `communication/phone/PerformanceView` | reused as-is | |
| `communication/phone/SmsInboxView` | reused as-is | |
| `communication/phone/TextingView` | reused as-is | |
| `communication/phone/TrainingView` | reused as-is | |
| `communication/phone/shared` (`DateRangeControl`, `callNeedsAttention`, `computeRange`, `countCallsOnDay`, `DEMO_NOW`) | reused as-is | |
| `communication/inbox/ComposeWindow` (`ComposeWindow`, `InlineComposer`, `NoMailboxChip`) | reused as-is | |
| `communication/inbox/InboxDirectory` (`ManageDirectoryModal`) | reused as-is | |
| `communication/shared/atoms` (`JobBadge`) | reused as-is | |
| `pages/communication/TextPage` (`mergeServerThreads`) | imported, not copied | business logic; one convergent merge or polling duplicates conversations |

## Shape differences forced by the kit

| What | Where | Detail |
|---|---|---|
| routed-tab plumbing | `pages/v2/communication/components/routedTabs.tsx` | the STRIP is leads' `TabStrip`; only the URL read/write lives here. `ModuleTabPanel` exists because leads' `TabPanel` renders a div with no layout at all, and every Communication panel has to own the height of a three-pane |
| plan-usage constants | `pages/v2/communication/components/planUsage.tsx` | `CURRENT_PLAN`, `UPGRADE_PLANS` and `SALES_EMAIL` are page-local consts in the legacy file with no export, so they are duplicated verbatim rather than imported. They are prototype billing seeds, not logic. If the legacy page is deleted at cutover the duplication goes with it |
| sub-tab underline | PhonePage | the legacy sub-tab row drew one border across the whole row including the date picker. `TabStrip` owns its own `border-b`, and `border-b-0` does not resolve in this Tailwind config, so the underline now stops where the tabs stop |

## Behaviour not reproduced

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|
| PhonePage's `ModulePlaceholder` + its own `SECTION_META` | not ported | dead code in the legacy file: the branch that renders it is `section !== "calls"`, and every non-calls section already has its own branch above it. Nothing can reach it |
| InboxPage's per-message account dot (`mAcct.dot`, a raw palette class from the seam) | the provider NAME is still shown; the coloured dot is not | `ACCOUNTS[].dot` is a raw Tailwind palette class (`bg-red-500`) handed out by the data seam. Rendering it would put a raw palette class in a v2 component, which the repo boundary forbids. The seam would have to hand out a token or a variant name instead - flagged, not fixed |

Everything else is reproduced, including the parts that are arguably wrong: see
"Observed but not fixed".

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| Routed `:tab` navigation is a no-op | `PhonePage`, `TextPage`, both legacy and v2 | the tab is READ from `params.tab` first, but `goToTab` only WRITES the search param, so from `/communication/phone/numbers` clicking "Call flows" lands on `/communication/phone/numbers?tab=flows` and the page stays on numbers. Reproduced exactly; fixing it changes where a click lands |
| `WhatsAppPage` has no ability gate at all | `pages/communication/WhatsAppPage.tsx` | it never imported `useAppAbility`. A user the backend 403s still gets the page. Reproduced as-is; adding a gate changes who can reach it |
| `InboxPage`'s gate swaps only the message list | `pages/communication/InboxPage.tsx` | the folder rail keeps rendering the team roster, the email groups and the forwarding rules for a user without `read Communication`. A real org-data leak, and a security question rather than a UI one |
| Every page fires its queries above the gate | all four | a denied user generates a burst of 403s on mount. Moving the hooks below the gate would change the request pattern |
| `useCallsPipeline`'s date window is anchored on a hardcoded demo "now" for demo orgs | `components/communication/phone/shared.tsx` (`DEMO_NOW`) | intentional for the demo org; real orgs already use the real clock (`computeRange(..., isDemo)`) |
| Nothing in Call flows, Call groups, Call masking, the texting Save-Settings bar or the plan upgrade persists | the reused sub-views | `useSaveCallFlow` / `useSaveCallGroup` exist in the seam and are never called. Known prototype scope; unchanged here |
| `emanuel@alphasecurityus.com` is user-visible prototype identity | `communication-shared` | copy, not code; changing it is a product decision. The `planUsage` half is CLOSED - Reach sales now names `info@servwave.com` and posts to `POST /api/support/sales-request`, which really delivers there |
| `ACCOUNTS[].dot` hands raw Tailwind palette classes out of the data seam | `lib/api/communication-shared/email.ts` | a token boundary violation in shared data, not in a component. Fixing it means changing a seam every legacy page reads |

## Stale behaviour-map corrections

Recorded because the map is what the next reader will reach for first.

| The map says | The code says |
|---|---|
| "There is NO per-route sub-gate... no feature gate" (s.1) and "the `phone` entitlement gates nothing in this checkout" (s.2, s.12 q2) | `App.tsx` wraps all six `/communication/*` routes in `<RequireFeature feature="phone">`, `frontend/src/lib/entitlements` exports `useFeature`, and `V2AppLayout` already gates the comms shortcuts on it. The entitlement is live on the frontend |
| the module has 4 pages and 6 routes | there is a seventh route, `/phone`, with its own page (`pages/phone/PhoneShell.tsx`) and its own guard (`RequireCommunicationCreate`) - the sole CTM device-owner surface. The map does not mention it |
| `GlobalDialer` is mounted by `components/layout/Header.tsx` on every page | still true for legacy; `V2AppLayout` mounts it too, and gates it on `useFeature('phone')` |
| WhatsApp sends progress `sent -> delivered -> read` on 700ms/1800ms timers | there is no simulated progression. The page posts through `useSendWhatsApp`, rolls the optimistic bubble back on error, and shows `whatsAppSendErrorMessage`. The header reads "Not connected" |
| InboxPage shows `PRIMARY_ACCOUNT` (a hardcoded gmail identity) | the page reads a real connected mailbox via `useEmailAccounts`, offers Connect / Reconnect through `useConnectGmail`, persists read-state with `useMarkEmailThreadRead`, renders sanitized `bodyHtml`, and downloads real attachments through the backend proxy |
| PhonePage seeds `numbers` from `SEED_NUMBERS` exported by NumbersView | numbers come from `useNumbers()` (`GET /api/communication/numbers`), with a real `isLoading` |
| PhonePage owns `blocked` as lifted local state, with a client-side duplicate check | blocked numbers are server state (`useBlockedNumbers`), and the duplicate check is the server's 409 |
| PhonePage embeds a dialer overlay and a `simulateIncoming()` handler | it does not. The Dialer button calls `openPhoneTab()`; `simulateIncoming` is gone and `TrainingView` takes no `onSimulateIncoming` |
| every section is visible to everyone | `masking` is demo-org only, and `flows` / `groups` / `training` are pilot-or-demo only. A deep link to a hidden section falls back to Calls |
| `components/communication/` has "about 30 files" / the map lists 19 | 47 files, including `CallTranscript`, `OfficeSoftphoneWarmup`, `useCallsPipeline`, and the whole `shared/` set (`CommRow`, `CommJobMenu`, `CommRowJobControl`, `EntityCallDrawer`, `EntitySmsDrawer`) that the map does not list |
| there is no `data-testid` and no test coverage beyond 3 files | `components/communication/phone/__tests__/` holds 15 test files, plus `pages/communication/__tests__/` (2) and `pages/phone/__tests__/` (3) |
