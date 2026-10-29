# ToggleGroup migration triage worksheet (Phase 4d)

Companion to `2026-07-25-shared-component-library-consolidation.md` section 4d. This is the mandatory
hand-triage pass before any site is converted to `<ToggleGroup>` - no site listed here has been converted yet.

## Summary

- Total candidate sites: 201
- Sites with no ARIA state attribute today (the strongest accessibility argument for conversion): 134 site-level, but treat this figure as approximate - a few of the 7 parallel triage batches left the optional ARIA field blank rather than explicitly false, so a raw per-row recount lands closer to 160. The reliable number is scoped to the convert-candidates below: **79 of the 101** segmented/pill-single/pill-multi sites have no ARIA state today (see the next section, sorted with those 79 first) - use that, not the headline figure, when prioritizing.
- By classification: {"segmented":55,"pill-single":35,"pill-multi":11,"leave-alone":64,"selectable-card":19,"listbox-option":17}

## Convert candidates (segmented / pill-single / pill-multi)

| File | Line | Classification | Has ARIA today | Rationale |
|---|---|---|---|---|
| `components/communication/phone/CallsView.tsx` | 326 | pill-multi | No | facet-filter option row toggled independently in/out of an array (multi-select), just styled as a list item rather than a rounded chip. |
| `components/communication/phone/NumbersView.tsx` | 793 | segmented | No | code comment literally says 'Number type toggle'; Local/Toll-free 2-option switch inside a bordered/background track (rounded-card border p-1 grid-cols-2). |
| `components/communication/phone/SmsInboxView.tsx` | 489 | pill-single | No | THREAD_FILTERS chip row - single active filter among a small set of rounded-full free-standing chips, no shared track. |
| `components/inventory/FiltersPopover.tsx` | 273 | pill-multi | No | shared Chip component backing every multi-select facet row (kind/stock/vendor/flags), each toggles independently via array membership. |
| `features/estimate-workspace/components/ScopePresetPicker.tsx` | 93 | pill-single | No | 'All' category chip, single-select among scope-preset categories, free-standing (flex-wrap row, no track). |
| `features/estimate-workspace/components/ScopePresetPicker.tsx` | 105 | pill-single | No | per-category chip sibling to the 'All' chip above, same single-select filter row. |
| `components/communication/inbox/ComposeWindow.tsx` | 67 | pill-single | No | AccountChip - single-select 'from' mailbox pill, used by InlineComposer's account row (confirmed usage at line 433). |
| `components/crm/IconRail.tsx` | 82 | segmented | No | 2-icon Activity/Attachments rail switching which slide-over panel is open, sits inside its own bordered rail container (border-l, dedicated width). |
| `components/inventory/PODetailDialog.tsx` | 853 | segmented | No | InnerTab - Lines/Activity/Documents/3-Way Match, 4-option local view switch under an underline-tab border-b container. |
| `pages/reports/WeeklyRepDiagnostic.tsx` | 195 | segmented | No | code comment literally says 'Conversion-formula toggle'; 2-option HCP/Jobber switch inside a rounded-full bordered track (border border-border bg-white p-0.5). |
| `components/crm/LineItemsEditor.tsx` | 217 | pill-single | No | Free-standing rounded-full 'All' category chip in a flex-wrap row (no bordered track), single-select against `selectedCategory`, no aria-pressed. |
| `components/crm/LineItemsEditor.tsx` | 228 | pill-single | No | Mapped category chips (same row as the 'All' chip above), single-select rounded-full filter, no aria-pressed. |
| `components/crm/LineItemsEditor.tsx` | 246 | segmented | No | 'All' segment of a 3-way type filter inside `rounded-md border overflow-hidden` track, single-select, no aria-pressed. |
| `components/crm/LineItemsEditor.tsx` | 251 | segmented | No | SERVICE segment of the same bordered 3-way track; toggles selectedTypeFilter between SERVICE and null. |
| `components/crm/LineItemsEditor.tsx` | 256 | segmented | No | MATERIAL segment of the same bordered 3-way track, completing the segmented group with SERVICE/All. |
| `components/communication/phone/TextingView.tsx` | 589 | segmented | No | 'Use a template' mode button inside `inline-flex rounded-md border border-border p-0.5` track, single-select between 2 compose modes. |
| `components/communication/phone/TextingView.tsx` | 599 | segmented | No | 'Write from scratch' button, second segment of the same bordered 2-way mode track as line 589. |
| `components/communication/phone/TextingView.tsx` | 707 | segmented | No | TextSubTab underline-style tab button (Templates / Automations / Compliance, 3 fixed views), single-select via `active` prop; no role=tab despite being a tab bar - flag for real ARIA tabs or ToggleGroup treatment. |
| `components/communication/phone/shared.tsx` | 340 | pill-single | No | RANGE_PRESETS option button in a date-range popover grid, single-select ternary styling (bg-primary-subtle vs hover), no listbox/option roles present so treat as a free-standing option grid rather than a real combobox. |
| `components/inventory/SignatureField.tsx` | 262 | segmented | No | 'Signing as' identity toggle (expected signer) inside a bordered `rounded-md border border-border` container with a second mutually exclusive option - 2-way mode switch. |
| `components/inventory/SignatureField.tsx` | 274 | segmented | No | 'Sign as yourself' option, second segment of the same bordered identity-toggle group as line 262. |
| `pages/MarketingAnalyticsPage.tsx` | 181 | segmented | No | 'Owner' view button inside `inline-flex rounded-full border border-border overflow-hidden` track, single-select 2-way view switch. |
| `pages/MarketingAnalyticsPage.tsx` | 187 | segmented | No | 'Director' view button, second segment of the same bordered Owner/Director track. |
| `pages/reports/JobStatisticsReport.tsx` | 470 | segmented | No | segBtn('day'/'week'/'month') helper rendered inside `inline-flex rounded-lg bg-background-light p-0.5` track - classic 3-way granularity segmented control. |
| `components/inventory/ApprovalsView.tsx` | 254 | pill-single | No | Filter chip (rounded-full, free-standing in a scrollable toolbar row, not a bordered track) among 4 mutually exclusive status filters. |
| `components/inventory/POEmailDialog.tsx` | 309 | pill-multi | No | Vendor-contact suggestion chip that independently adds/removes itself from the recipients array (multiple can be active at once) - free-standing rounded-full pill. |
| `components/communication/phone/TrainingView.tsx` | 376 | segmented | No | TrainingSubTab switches between exactly 2 fixed views (Run training / History) as underline tabs under a shared border-b track; no role='tab' or aria-selected present. |
| `components/inventory/NewPODialog.tsx` | 988 | pill-single | No | 'All' category filter chip in a horizontally wrapping row (not a bordered track), single-selecting among item categories. |
| `components/inventory/NewPODialog.tsx` | 1000 | pill-single | No | Per-category filter chip in the same free-standing wrapping row as the 'All' chip, single-select and mutually exclusive with it. |
| `pages/communication/InboxPage.tsx` | 664 | segmented | No | Folder nav button (Inbox/Starred/Sent/Drafts/Archive - exactly 5) inside a bordered vertical rail, single-select mode switch with no aria-selected/role='tab'. |
| `pages/inventory/InventoryPage.tsx` | 1536 | segmented | No | ViewTab switches between 6 fixed inventory views (Items/Staging/Assets/Low stock/Activity/Logistic Orders) as underline tabs under a shared border-b track; no role='tab'/aria-selected. |
| `pages/reports/JobsReport.tsx` | 457 | pill-multi | No | Multi-column filter-panel option row (Status/Team/Created By/Tags/Job type/Origin/Source) that toggles independently in/out of a values array - functionally multi-select even though it renders as a plain list row, not a rounded chip. |
| `components/inventory/PrePODetailDialog.tsx` | 568 | segmented | No | InnerTab switches between 3 fixed tabs (Items/Estimate/Email Activity) as underline tabs under a shared border-b track; no role='tab'/aria-selected. |
| `pages/ReportsPage.tsx` | 115 | segmented | No | TabButton switches between Main + one tab per report group + Custom reports (dynamic count) as underline tabs under a shared border-b track; no role='tab'/aria-selected. |
| `pages/reports/CallTrackingReport.tsx` | 137 | segmented | No | dirBtn (All/Inbound/Outbound) renders inside an explicit bordered/overflow-hidden track - the closest thing to a textbook segmented control in this pass; no role='tab'/aria-selected. |
| `pages/settings/BrandingPage.tsx` | 159 | pill-single | No | Document-template picker (Classic / CRM Default) as free-standing chips in a plain flex row (no shared track), single-select with a trailing checkmark on the active pick. |
| `pages/communication/PhonePage.tsx` | 727 | pill-single | No | "Pick a question" topic chips in ReachSalesModal are free-standing rounded-full pills with single-select `topic` state and no shared bordered track. |
| `pages/communication/PhonePage.tsx` | 1266 | segmented | No | ModuleTab primary nav (Calls/Numbers/Flows/Masking/Groups/Training/Blocked): underline single-select tab row, though the visible set ranges 3-7 depending on demo/pilot gating, which can exceed the usual 2-5 segmented ceiling. |
| `pages/communication/PhonePage.tsx` | 1342 | segmented | No | Calls/Dispatch & Calls/Performance & QA sub-tab row (2-3 items), border-b-2 underline style inside the bordered header strip - classic single-select view switch. |
| `pages/reports/EstimatesReport.tsx` | 84 | segmented | No | List/By rep view switch sits inside a bordered "flex rounded-lg border ... p-0.5" track with a filled-pill active state - textbook 2-item segmented control. |
| `pages/reports/EstimatesReport.tsx` | 91 | segmented | No | Second button of the same List/By-rep segmented track (view === 'by-rep'). |
| `pages/reports/EstimatesReport.tsx` | 102 | segmented | No | Date-preset row (All time/30d/90d/1y), same bordered-track pattern as the view switch above, 4 mutually exclusive options. |
| `components/inventory/StagingView.tsx` | 506 | pill-single | No | filterTabs chips (All Stages/Awaiting/Partial/Ready/Ready for pickup): free-standing rounded-full pills in a horizontal scroller, single-select `filter` state, no shared track. Note the StatTile quick-stats row just above drives the same `filter` state but renders via a dynamic `"button"\|"div"` element, not a literal <button>, so it's excluded here despite being a duplicate segmented-like control worth the implementer's awareness. |
| `pages/reports/LeadsReport.tsx` | 354 | pill-multi | No | FilterPanel column options (Status/Team/Created by/Tags/Job type/Source) each toggle independently into a string[] filter; rendered as full-width checklist rows inside a popover rather than pill-shaped chips, but functionally multi-select. |
| `components/inventory/RestockDialog.tsx` | 249 | pill-single | No | Explicitly commented "Source pill selector": 5 free-standing rounded-md chips, single-select `source` state, no shared bordered track. |
| `pages/communication/TextPage.tsx` | 149 | segmented | No | Inbox/Settings tab row (2 items), underline border-b-2 style, single-select page switch - same shape as PhonePage's ModuleTab. |
| `components/communication/phone/CallFlows.tsx` | 1038 | pill-single | No | TargetEditor's Person/Group/Number/Voicemail kind picker is a single-select rounded-full chip row (`flex flex-wrap gap-1`) with no bordered track wrapper. |
| `components/communication/phone/CallFlows.tsx` | 1195 | pill-single | No | The 'Always open'/'On a schedule' hoursMode toggle is single-select but its wrapper (`flex gap-1`) has no visible border/background track, so it reads as free-standing chips rather than a segmented control. |
| `pages/reports/CommissionsReport.tsx` | 401 | pill-single | No | Report-type (Standard/Tech/External) switcher buttons are auto-width, gap-2, no bordered track - single-select free-standing chips despite behaving like view tabs. |
| `pages/reports/CommissionsReport.tsx` | 415 | pill-single | No | By-Time (Created/Scheduled/Closed) buttons are single-select, auto-width, in an unbordered `flex items-center gap-1` row - free-standing chips, not a segmented track. |
| `components/ai-center/BookingModal.tsx` | 131 | pill-single | No | Day-picker tiles are single-select, arranged in a CSS grid but with no bordered/background track around the group - compact two-line chip, not large enough or grid-framed enough to be a selectable-card. |
| `components/ai-center/BookingModal.tsx` | 154 | pill-single | No | Time-slot buttons are single-select free-standing chips in a plain CSS grid, same pattern as the day picker above. |
| `components/inventory/AddItemDialog.tsx` | 605 | segmented | No | Catalog/Internal visibility toggle sits inside a real track (`rounded-md border border-border bg-white p-0.5`) with flex-1 equal-width buttons - the textbook segmented-control shape. |
| `components/inventory/AddItemDialog.tsx` | 619 | segmented | No | Second button of the same Catalog/Internal segmented pair, same bordered track wrapper. |
| `components/inventory/TransferDialog.tsx` | 667 | segmented | No | DestPill (Location vs Job/PO) renders inside a `rounded-md bg-background-light p-1` track as flex-1 equal-width buttons with a ring-1 active state - clean segmented-control candidate (2-line hint text is the one wrinkle worth a second look). |
| `components/inventory/TransferDialog.tsx` | 810 | segmented | No | ModeButton (Single item / By PO / By Job) is used inside a `rounded-md bg-background-light p-1` track with flex-1 buttons - same segmented shape as DestPill. |
| `pages/inventory/VendorsPage.tsx` | 342 | segmented | No | The all/active/inactive status filter sits in an explicit bordered track (`inline-flex overflow-hidden rounded-md border border-border`) - a clean segmented-control fit. |
| `pages/settings/UsersTeamsPage.tsx` | 215 | pill-single | No | All/active/inactive user-status filter is single-select, rounded-full, in an unbordered `flex gap-1` row - free-standing chips, no track. |
| `pages/SchedulePage.tsx` | 2322 | segmented | No | Standard/Member View button sits in a bordered p-0.5 track (line 2321) with 'Member View' as its exclusive sibling, active state via bg-white/shadow-sm ternary, no aria-pressed/role=tab. |
| `pages/SchedulePage.tsx` | 2330 | segmented | No | Member View button, the second member of the same 2-option bordered-track toggle as line 2322; single-select mutually exclusive with Standard. |
| `pages/SchedulePage.tsx` | 2392 | segmented | No | Day/Week/Month switcher, 2-3 buttons mapped from an array inside a bordered p-0.5 track with bg-white/shadow-sm active styling; no aria-selected/role=tab despite being a classic segmented control. |
| `pages/SchedulePage.tsx` | 2437 | segmented | No | Full day/Morning/Afternoon time-window buttons mapped from a fixed 3-item array inside a bordered p-0.5 track, single-select active styling, no aria state. |
| `pages/reports/EstimateConversionReport.tsx` | 200 | pill-single | No | FilterChips are explicitly comment-labeled 'Single-select filter chips'; each is a free-standing rounded-full chip (not in a bordered track) with primary-fill-vs-outline ternary, no aria state. |
| `pages/reports/EstimateConversionReport.tsx` | 562 | segmented | No | Date-anchor buttons mapped from the ANCHORS array inside an 'inline-flex overflow-hidden rounded-lg border' track, single-select bg-primary-vs-white ternary, no aria state. |
| `pages/reports/EstimateConversionReport.tsx` | 612 | segmented | No | Won/Decided vs Won/Sent conversion-formula toggle, 2 fixed options in a bordered rounded-lg track, single-select ternary styling, no aria state. |
| `components/communication/phone/CallGroups.tsx` | 302 | segmented | No | Ring-strategy 'all' vs 'round_robin' buttons, 2 fixed mutually-exclusive options rendered flex-1 inside a shared 'flex gap-1' track with primary-vs-background ternary; no aria state. |
| `components/schedule/QuickScheduleCard.tsx` | 158 | segmented | No | Jobs tab button, one of a fixed 2-item ActiveTab set inside a 'flex gap-1 bg-background-light rounded-lg p-0.5' track with bg-white/shadow-sm active ternary; no aria state despite being tab-like. |
| `components/schedule/QuickScheduleCard.tsx` | 168 | segmented | No | Walkthroughs tab button, the second member of the same 2-option bordered track as line 158. |
| `pages/reports/CommunicationTrackingReport.tsx` | 60 | segmented | No | Cadence/QA/Training-impact tab bar, 3 fixed mutually-exclusive views with an underline (border-b-2) active ternary inside a bordered container; classic tab UI but no role="tab"/aria-selected, a real accessibility gap. |
| `pages/settings/RolesPage.tsx` | 203 | segmented | No | Per-subject scope picker (SCOPES.map, small fixed set e.g. All/Own/Team) rendered in a 'flex gap-1' track per row, active ternary styling, no aria state. |
| `components/inventory/VendorDetailDialog.tsx` | 720 | pill-multi | No | PO-transmit-method chips are explicitly multi-select ('Pick every channel this vendor accepts'), free-standing (flex flex-wrap gap-1, no bordered track), active ternary but no aria-pressed. |
| `pages/tasks/views/CalendarView.tsx` | 575 | segmented | No | Day/Week/Month CalendarViewMode switcher, VIEW_OPTIONS.map over a fixed 3-item array inside a bordered rounded-lg p-0.5 track, active bg-primary/shadow-soft ternary, no aria state. |
| `components/ai-center/AiCenterModal.tsx` | 164 | pill-single | No | Mobile 'All' category chip in a horizontally-scrolling row of free-standing rounded-full pills, single-select via the filter state. |
| `components/ai-center/AiCenterModal.tsx` | 173 | pill-single | No | Mobile per-category chip (same chipCls) toggling the single active category filter; free-standing, not enclosed in a shared bordered track. |
| `components/communication/inbox/InboxDirectory.tsx` | 237 | pill-multi | No | Per-member rounded-full chip inside a group-edit card; each member toggles in/out of the group independently, a genuine multi-select set. |
| `components/inventory/AddVendorDialog.tsx` | 257 | pill-multi | No | PO transmit-method chip (email/portal/edi/phone); each channel toggles independently and more than one can be selected at once (guarded only against zero-selection). |
| `components/tasks/LinkedEntitySelect.tsx` | 213 | pill-single | No | JOB/LEAD/CUSTOMER/ESTIMATE type-toggle chips (4 fixed options) inside the popover; free-standing (flex-wrap row, no shared bordered track), single-select. |
| `components/workflows/WaitForm.tsx` | 160 | segmented | Yes | aria-pressed 2-option 'Wait a set time' vs 'Before/after' mode switch, laid out in a grid-cols-2 pair. |
| `components/workflows/WaitForm.tsx` | 168 | segmented | Yes | second button of the same relative/anchored mode switch. |
| `components/workflows/WaitForm.tsx` | 187 | pill-single | Yes | duration preset chip (1 of 5 + Custom) in a free-standing flex-wrap row, not a bordered track. |
| `components/workflows/WaitForm.tsx` | 201 | pill-single | Yes | Custom pill sibling to the preset chips directly above (6-option single-select set). |
| `components/workflows/WaitForm.tsx` | 265 | segmented | Yes | Before/After direction 2-option switch, grid-cols-2, same pattern as the mode switch. |
| `components/workflows/WaitForm.tsx` | 273 | segmented | Yes | second button of the Before/After direction switch. |
| `components/workflows/WaitForm.tsx` | 290 | pill-single | Yes | anchored-offset preset chip, identical pattern to the relative-mode presets above. |
| `components/workflows/WaitForm.tsx` | 301 | pill-single | Yes | anchored-offset Custom pill, sibling of the anchored preset chips. |
| `pages/reports/ItemsServicesReport.tsx` | 71 | segmented | Yes | Company/Technician 2-option view switch inside an 'inline-flex rounded-lg bg-background-light p-0.5' track; already carries aria-pressed. |
| `pages/reports/ItemsServicesReport.tsx` | 79 | segmented | Yes | second button of the same Company/Technician view switch. |
| `components/workflows/trigger/DateModePanel.tsx` | 194 | pill-single | Yes | Preset timing chip (rounded-pill, border, free-standing in a flex-wrap row), single-select, already carries aria-pressed via presetChipClass/active. |
| `components/workflows/trigger/DateModePanel.tsx` | 205 | pill-single | Yes | 'Custom…' chip, same free-standing pill row as the presets, mutually exclusive with them, aria-pressed already present. |
| `components/workflows/trigger/DateModePanel.tsx` | 250 | segmented | Yes | Before/After direction button inside a bordered `inline-flex ... rounded border border-border` track, 2-way single-select, aria-pressed already present. |
| `components/inventory/lo/LOList.tsx` | 108 | pill-single | Yes | Status filter chip (rounded-full, free-standing in a scrollable row), single-select via `filter`, already carries aria-pressed. |
| `components/leads/TagInput.tsx` | 182 | pill-single | Yes | Color-swatch picker button (10 free-standing circular options, no bordered track), single-select with ring highlight, already carries aria-pressed. |
| `components/workflows/MergeFieldChips.tsx` | 126 | pill-multi | Yes | Merge-field chip (rounded-pill, border) whose aria-pressed reflects whether that specific field is already used in the message body; multiple chips can be 'pressed' simultaneously and independently. |
| `components/copilot/Transcript.tsx` | 23 | pill-single | Yes | Thumbs-up feedback button; paired with thumbs-down as a mutually exclusive free-standing pair (not a bordered track) - already carries aria-pressed. |
| `components/copilot/Transcript.tsx` | 35 | pill-single | Yes | Thumbs-down feedback button, the other half of the mutually exclusive UP/DOWN pair - already carries aria-pressed. |
| `components/filters/FilterBar.tsx` | 143 | segmented | Yes | Facet-rail button inside an explicit role='tablist' container, already has role='tab' + aria-selected - a working single-select tab pattern and the cleanest existing model in this pass for a Tabs/ToggleGroup migration. |
| `components/invoices/CreateJobInvoiceDialog.tsx` | 258 | segmented | Yes | Billing-mode toggle (Amount/Percent/Itemized) inside a bordered/padded track (role='tablist', p-0.5 pill container) with role='tab' + aria-selected already present - the clearest textbook ToggleGroup(type='single') candidate found in this pass. |
| `components/jobs/items/ReceiptCard.tsx` | 273 | segmented | Yes | ModeToggleGroup is a hand-rolled $/% two-button segmented control with an explicit bordered track (`inline-flex overflow-hidden rounded-md border`), role="group" wrapper, and per-button aria-pressed - exactly the pattern Phase 4d should replace with the real ToggleGroup primitive. |
| `components/service-plans/RecurrenceBuilder.tsx` | 119 | pill-multi | Yes | Weekday chips (S M T W T F S) are multi-select, each toggles independently via aria-pressed, free-standing rounded-full buttons with no track - a clean ToggleGroup type="multiple" candidate. |
| `components/communication/phone/CallGroups.tsx` | 404 | pill-multi | Yes | DeviceToggle (Cell/Softphone) already carries aria-pressed={on} and toggles independently per person - a real multi-select chip pair, free-standing (border rounded-md, not in a track). |
| `components/communication/JobCommunicationsTab.tsx` | 191 | segmented | Yes | Text/Email channel switch sits in a bordered, padded track (rounded-lg border p-0.5), exactly 2 mutually exclusive modes, and already carries aria-pressed - a clean ToggleGroup fit. |

## Explicitly excluded - do NOT convert to ToggleGroup

| File | Line | Classification | Rationale |
|---|---|---|---|
| `components/communication/phone/CallsView.tsx` | 1586 | selectable-card | KPI StatCard in a responsive grid, ring-2 ring-primary + shadow when active, two-line content (value+label) - matches the card signature more than a plain pill despite having aria-pressed already. |
| `components/timeclock/StoreAddressSearch.tsx` | 221 | listbox-option | role='option' + aria-selected inside a role='listbox' address-autocomplete combobox with aria-activedescendant keyboard nav - must never become a ToggleGroup. |
| `components/communication/phone/TextingView.tsx` | 215 | listbox-option | Option row rendered inside a `role="listbox"` container (CleanSelect dropdown) with active-item styling from rowCls - must stay a real listbox, not become a ToggleGroup. |
| `components/communication/phone/CallMaskingView.tsx` | 264 | listbox-option | Option row inside the CleanSelect `role="listbox"` container, active-state styling via rowCls - must remain a real listbox. |
| `components/communication/phone/TrainingView.tsx` | 194 | selectable-card | Role-selection tile in a 2/4-col grid with icon + label + blurb + scenario count (multi-line, rounded-lg border, ring-1 when active) - a larger card, not a small button; track as a future RadioCard candidate. |
| `components/communication/phone/TrainingView.tsx` | 239 | selectable-card | Scenario tile in a 2-col grid with title, difficulty badge, script-focus blurb, trainer + duration meta - same larger multi-line card pattern as the role tile above. |
| `components/communication/phone/TrainingView.tsx` | 1030 | selectable-card | TrainStat KPI tile (label + chevron + big value) in a 2x4 grid that opens a breakdown drawer - already has aria-pressed, but its card-shaped multi-line layout fits a future RadioCard better than ToggleGroup. |
| `components/inventory/StagingAreaPicker.tsx` | 307 | listbox-option | Staging-area option row inside a panel explicitly marked role='listbox' - must stay a listbox pattern; the button itself is missing role='option'/aria-selected, a real accessibility gap but not a ToggleGroup candidate. |
| `components/schedule/ScheduleSearch.tsx` | 150 | listbox-option | Search-result row with role='option' + aria-selected inside a role='listbox' panel wired to a role='combobox' input with aria-activedescendant - a real combobox; must never become a ToggleGroup. |
| `pages/communication/PhonePage.tsx` | 479 | selectable-card | Upgrade-plan picker row (Scale/Enterprise) in the plan-usage panel: ring-2 + multi-line name/price/description content in a vertical list, same shape as a card grid despite being single-column. |
| `pages/communication/PhonePage.tsx` | 1233 | selectable-card | KPITile (Calls today/Missed/Unread/Needs Attention) already has aria-pressed; it's a 4-tile grid of bordered stat cards with icon+label+value and a ring-2 active state. |
| `components/inventory/StageDetailDialog.tsx` | 1648 | selectable-card | PDF page-picker thumbnail grid: multi-select (Select all/Clear nearby) toggle per page with border-2/ring-2 selected state and image+caption multi-line content. |
| `components/inventory/AddGroupDialog.tsx` | 748 | selectable-card | GroupTypeOption (Individual items / Flat rate): 2-item grid, border-2, multi-line title+subtitle content, ring-free but bg-tinted active state. |
| `pages/inventory/PriceBookPage.tsx` | 1487 | selectable-card | KPITile (In Catalog/Hidden/With Photo/No Price Set) already has aria-pressed and is a 4-tile rounded-card grid with ring-2 active state; the four tiles actually drive three independent filter variables (visibility/photo/price), reinforcing this isn't a clean single-shared-state ToggleGroup fit. |
| `components/jobs/EditJobLocationDialog.tsx` | 174 | selectable-card | Saved-address picker rows: single-select with multi-line content (address + optional "Current" label + checkmark) inside a bordered/divided list container. |
| `pages/reports/DateRangeControl.tsx` | 71 | listbox-option | Preset/date-field dropdown rows opened from the two header buttons; the file's own header comment says these are "custom-styled (not native <select>)" - a custom listbox/select replacement that must not become a ToggleGroup. |
| `components/communication/phone/CallFlows.tsx` | 723 | selectable-card | NodeCard is a larger multi-line (label + subtitle) flow-diagram button with ring-2 ring-primary/20 when selected, chosen one-at-a-time from a variable-length chain of nodes rather than a small fixed option set. |
| `components/communication/phone/CallFlows.tsx` | 1127 | listbox-option | MiniSelect renders a hand-rolled select dropdown (trigger + absolute overlay of option rows highlighted on match); converting to ToggleGroup would break its select/combobox semantics even though no ARIA role is currently applied - also flag as an a11y gap separately. |
| `pages/reports/CommissionsReport.tsx` | 261 | listbox-option | Row inside the RANGE_PRESETS dropdown opened from a trigger button, single-select with a checkmark indicator - functions as a custom listbox/menu, not a ToggleGroup candidate. |
| `pages/reports/CommissionsReport.tsx` | 266 | listbox-option | 'Custom range…' item lives in the same dropdown menu as the presets above it and shares the identical selected/checkmark treatment - part of the same listbox, not standalone. |
| `pages/inventory/VendorsPage.tsx` | 789 | selectable-card | KPITile is a large multi-line (label/badge + value + hint) card with ring-2 ring-primary on the active state, rendered in a KPI grid - already has aria-pressed but is a RadioCard candidate, not a ToggleGroup one. |
| `components/workflows/trigger/SubjectPicker.tsx` | 117 | listbox-option | Search-result row explicitly carries role="option" + aria-selected inside a role="listbox" container - must never become a ToggleGroup, it would break the search/combobox pattern; the always-false aria-selected is itself worth a follow-up bug. |
| `components/inventory/CategoryManagerDropdown.tsx` | 154 | listbox-option | 'All categories' option is a direct child of the PopoverContent that carries role="listbox" (line 139); selected look via primary-subtle ternary but no aria-selected - converting to ToggleGroup would break the combobox semantics. |
| `components/inventory/CategoryManagerDropdown.tsx` | 227 | listbox-option | Per-category row button, also a child of the same role="listbox" popover content, isSelected ternary drives bold/primary text; must stay a listbox option, not become a ToggleGroup item. |
| `components/crm/AssignTeamPopover.tsx` | 154 | listbox-option | role="option" with aria-selected already set, child of a role="listbox" container (line 146) with aria-multiselectable; a searchable team-member combobox row that must never become a ToggleGroup. |
| `components/inventory/AddLocationDialog.tsx` | 270 | selectable-card | Location-type picker, larger rounded-card grid tile with border+ring-1 active state and multi-line content (icon, label, hint text) - a RadioCard candidate, not a small ToggleGroup button. |
| `components/inventory/NewApprovalRequestDialog.tsx` | 294 | selectable-card | Action-Type picker, grid-cols-2/4 rounded-md border-2 tile with icon/label/hint multi-line content and an active-tint ternary - same card-grid shape as AddLocationDialog's type picker. |
| `components/settings/TemplateSelector.tsx` | 64 | selectable-card | Invoice-template picker, rounded-xl border-2 with ring-2 when selected, wraps a multi-line thumbnail+label - classic RadioCard shape from a 2-item grid. |
| `features/estimate-workspace/components/AiImagePanel.tsx` | 86 | selectable-card | AI image-suggestion tile in a 2-col grid, rounded-card border with ring-2 when selected; larger image tile rather than a small button, so it should stay a card-select pattern, not ToggleGroup. |
| `components/inventory/CategorySelector.tsx` | 91 | listbox-option | 'All Categories' reset row rendered directly inside PopoverContent's role='listbox' - a combobox option row, must never become a ToggleGroup. |
| `components/inventory/CategorySelector.tsx` | 138 | listbox-option | Per-category row inside the same role='listbox' popover, part of a searchable/scrollable combobox option list. |
| `components/workflows/trigger/ModeFork.tsx` | 52 | selectable-card | 'Right after something happens' large rounded-card option with icon + title + description and a ring-[3px] selected state; a RadioCard candidate, not a small ToggleGroup button. |
| `components/workflows/trigger/ModeFork.tsx` | 75 | selectable-card | 'Before or after a date' matching multi-line card in the same 2-option mode picker, ring-highlighted when selected (plus a disabled/locked variant). |
| `components/crm/AssigneeSelect.tsx` | 92 | listbox-option | User row with role='option' plus aria-selected inside a search popover; a combobox option row that must stay out of ToggleGroup. |
| `components/layout/GlobalSearch.tsx` | 173 | listbox-option | Search result row with role='option'/aria-selected plus arrow-key active-descendant navigation driven from the search input; a textbook combobox option, never a ToggleGroup. |
| `pages/inventory/PurchaseOrdersPage.tsx` | 1360 | selectable-card | KPITile is a rounded-card, ring-2-highlighted, multi-line (label/value/hint) clickable filter tile arranged in a 2x4 grid - a RadioCard candidate, not a small ToggleGroup button. |

Cross-check against the plan's already-known excluded sites: role="option" listbox items in
`crm/AssignTeamPopover.tsx`, `crm/AssigneeSelect.tsx`, `layout/GlobalSearch.tsx`,
`schedule/ScheduleSearch.tsx`, `timeclock/StoreAddressSearch.tsx`, `workflows/trigger/SubjectPicker.tsx`;
selectable cards in `settings/TemplateSelector.tsx`, `estimate-workspace/AiImagePanel.tsx`,
`inventory/AddLocationDialog.tsx`. All nine sites are present in this pass's data with the same
classification the plan already assumed (`listbox-option` for the first six, `selectable-card` for the
last three) - no mismatch found.

## Leave-alone

| File | Line | Rationale |
|---|---|---|
| `components/communication/phone/CallsView.tsx` | 415 | SortHeader column-sort button - active/inactive ternary is asc/desc sort state per column, not an exclusive-choice group; a poor ToggleGroup fit. |
| `components/communication/phone/NumbersView.tsx` | 93 | FlowSelect custom-dropdown trigger button; not a member of a fixed exclusive-option set, it opens an overlay. |
| `components/communication/phone/NumbersView.tsx` | 123 | 'Assign a flow…' (none) row inside the same hand-rolled dropdown, no role=listbox/option wiring so it isn't a strict listbox-option either. |
| `components/communication/phone/NumbersView.tsx` | 139 | per-flow option row in the same non-ARIA custom dropdown. |
| `components/communication/phone/NumbersView.tsx` | 270 | AdGroupSelect custom-dropdown trigger, same pattern/rationale as the FlowSelect trigger. |
| `components/communication/phone/NumbersView.tsx` | 314 | 'Assign An Ad Group' (none) row inside the ad-group custom dropdown. |
| `components/communication/phone/NumbersView.tsx` | 324 | per-ad-group option row in the same non-ARIA custom dropdown. |
| `components/communication/phone/SmsInboxView.tsx` | 556 | conversation/thread list row highlighting the open thread; the list is unbounded in length, so it doesn't fit the small-fixed-set or chip patterns. |
| `components/inventory/FiltersPopover.tsx` | 122 | Filters popover trigger button whose look reacts to open-state/active-count; a solo disclosure trigger, not a sibling in an exclusive-choice group. |
| `components/inventory/ApprovalEmailDialog.tsx` | 270 | quick-add recipient chip becomes permanently disabled once clicked (one-way add, not a reversible toggle) - not a good ToggleGroup fit. |
| `components/layout/Sidebar.tsx` | 198 | nav-group expand/collapse button whose className also reacts to 'has active-route child'; this is route highlighting plus a disclosure toggle, not a member of an exclusive-choice set. |
| `features/estimate-workspace/components/EstimateTabs.tsx` | 107 | per-lead estimate tab strip navigates via react-router and has an unbounded/dynamic sibling count (not a fixed 2-5 set); carries aria-current (not one of the tracked aria-pressed/role=tab/aria-selected attributes). |
| `pages/phone/IncomingCallCard.tsx` | 127 | solo Mute/Unmute boolean toggle button with no sibling options - a Radix Toggle candidate, not a ToggleGroup member. |
| `components/crm/LineItemsEditor.tsx` | 391 | Single standalone button that flips its own label/color between Material and Service on each click - not a set of options to pick from, so it isn't a ToggleGroup member. |
| `components/crm/LineItemsEditor.tsx` | 552 | Mobile-card duplicate of the line-391 self-toggling Material/Service badge button; same single-button toggle, not a picker group. |
| `components/communication/phone/TextingView.tsx` | 162 | CleanSelect's own trigger button; className ternary reflects open/closed dropdown state, not a member of a selectable option set. |
| `pages/reports/JobStatisticsReport.tsx` | 502 | Underline tab bar over 9 TABS values - exceeds the 2-5 fixed-set range for segmented and is a genuine horizontally-scrolling tab strip better served by real role=tab semantics than ToggleGroup. |
| `components/communication/phone/CallMaskingView.tsx` | 211 | CleanSelect trigger button; className ternary is for open/closed dropdown chrome, not a selectable option among peers. |
| `components/estimates/DuplicateEstimateDialog.tsx` | 102 | Full-width scrollable list row for picking a target lead (variable-length list, thin single border, compact two-line content) - doesn't match the small fixed-set segmented/pill shapes or the card-grid selectable-card shape. |
| `pages/DashboardPage.tsx` | 54 | Single 'Customize home page' / 'Done' button that flips its own label and color between two modes - a standalone toggle, not a set of peer options for ToggleGroup. |
| `pages/reports/ActivityReport.tsx` | 112 | Breadcrumb-style drill-down button (Company / Division / Person) with active-node styling - hierarchical navigation, not a mutually exclusive option set, shouldn't become a ToggleGroup. |
| `pages/reports/_shared.tsx` | 219 | Full-width multi-select option row inside a scrollable column of a multi-facet filter popover; behaves like a checkbox-list combobox rather than a free-standing chip group, so it doesn't cleanly fit pill-multi or listbox-option (no role=listbox/option present). |
| `components/communication/phone/TrainingView.tsx` | 1002 | Sortable table column header toggling text-primary vs hover by current sort key - a sort-direction control, not a view/filter selector, so no ToggleGroup bucket fits. |
| `components/communication/phone/TrainingView.tsx` | 1477 | Solitary 'Tap to talk / Listening' mic toggle button, not part of a multi-option group, so ToggleGroup does not apply even though its look flips on state. |
| `components/inventory/NewPODialog.tsx` | 1109 | Item row inside the full-catalog 'Pick an item' search modal - an unbounded scrollable list with no role='listbox'/'option' semantics, so it is neither a clean listbox-option nor a small-set toggle group. |
| `pages/communication/InboxPage.tsx` | 917 | Email/thread row in the dynamic-length message list - selected/unread styling ternary exists but the list is unbounded, so it is a master-list selection, not a small ToggleGroup set. |
| `components/inventory/StagingAreaPicker.tsx` | 180 | Dropdown trigger button whose style flips on whether a value is set (needs-attention vs picked) - it is the popover trigger, not one of the selectable options. |
| `components/communication/phone/Softphone.tsx` | 826 | Solitary Mute/Unmute button during an active call - a single toggle, not a set of mutually exclusive options, so ToggleGroup does not apply; also lacks aria-pressed, worth a separate a11y fix. |
| `components/inventory/EmailComposeDialog.tsx` | 177 | Suggested-recipient 'quick add' chip that becomes permanently disabled once clicked (not a real toggle/select-among-options), so it doesn't fit any ToggleGroup bucket. |
| `components/workflows/TriggerNode.tsx` | 43 | The single fixed trigger bubble at the top of the workflow canvas; its ring style toggles on the `selected` prop, but it is a lone node, not one of several mutually exclusive options. |
| `pages/communication/PhonePage.tsx` | 372 | PlanUsage popover trigger: ternary swaps border/ring style between open and closed, but it's a single standalone disclosure button, not a set of sibling options - a plain aria-pressed Toggle fits better than a ToggleGroup. |
| `components/inventory/StagingView.tsx` | 328 | "From PO" popover trigger: ternary is open/closed disclosure styling on one standalone button, not a group of alternatives to pick between. |
| `pages/inventory/PriceBookPage.tsx` | 824 | Catalog/Internal visibility chip in the Items table is a single button per row that flips one boolean on click - closer to a Switch than a set of options to choose between. |
| `pages/reports/LeadsReport.tsx` | 426 | FieldsModal column-visibility row: the button's own className ternary is about the locked "alwaysOn" field, not the on/off look (that's a separate inner span), and rows migrate between "Selected fields"/"Unselected fields" groups on toggle, which a plain ToggleGroup wouldn't reproduce. |
| `components/copilot/Composer.tsx` | 53 | Mic toggle already correctly uses aria-pressed; it's a single standalone binary toggle, not a set of sibling options, so it doesn't need (and shouldn't become) a ToggleGroup. |
| `components/inventory/EstimateComparisonDialog.tsx` | 302 | "Use this vendor" CTA per quote card: the ternary reflects the data-driven recommended-vendor flag, not a persisted user selection, and clicking fires an immediate pick-and-close action rather than toggling a stored value. |
| `components/schedule/SettingsGearDropdown.tsx` | 90 | Staff Filter menu rows (All Staff/Technicians/Sales) in the settings popover are a genuine 3-option single-select, but styled as full-width menu rows with a checkmark rather than chips or a bordered track, so neither pill nor segmented cleanly fits. |
| `components/workflows/trigger/EventModePanel.tsx` | 69 | Trigger-event picker already implements role="radiogroup"/role="radio"/aria-checked (not literally aria-pressed/role=tab/aria-selected, but an equivalent correct pattern) for a genuine single-select list with multi-line label+description; converting to ToggleGroup would change the semantics from radio to toggle-button. |
| `pages/settings/PhoneNumbersSettingsPage.tsx` | 224 | Per-user "make default number" star toggle inside an assignee chip already correctly uses aria-pressed; it's a standalone per-row toggle, not a set of sibling alternatives, so it isn't a ToggleGroup candidate. |
| `components/communication/phone/CallFlows.tsx` | 1220 | Assigned-numbers rows are full-width multi-select list items with a separate checkbox-square indicator glyph, closer to a Checkbox list than a compact chip/segmented pattern - not a confident ToggleGroup fit. |
| `pages/reports/SalesReport.tsx` | 342 | Filter-panel facet options are full-width checkbox-styled list rows (w-full, justify-between, Check icon) inside a multi-column dropdown, not compact free-standing chips - safer left for manual review. |
| `components/copilot/VoiceOrb.tsx` | 49 | This is a single boolean mic on/off toggle (aria-pressed present, but the button's own className has no active/inactive ternary) - a Switch/Toggle candidate, not a multi-option ToggleGroup. |
| `components/inventory/AddCategoryDialog.tsx` | 175 | Ternary (`form.photoUrl ? ... : ...`) reflects an upload dropzone's filled-vs-empty state, not a selected/active state among options - not a selection control at all. |
| `components/inventory/LocationSelector.tsx` | 53 | Ternary (`open ? ring-2 ... : border-border ...`) is a Popover trigger's open/closed styling, i.e. a Select/Combobox trigger button, not a selected-state control; the actual location option rows (line 185) have no ternary on their own className so they don't qualify for this triage at all. |
| `components/inventory/VendorCard.tsx` | 42 | The `isInactive` ternary dims archived vendors but the whole card always just navigates on click - it's not a selection/toggle state at all, so it doesn't belong in a ToggleGroup migration. |
| `pages/communication/WhatsAppPage.tsx` | 231 | Conversation-list rows are a scrollable, unbounded inbox-style single-select navigation list with rich multi-line content, not a small bounded option set - not a good ToggleGroup fit. |
| `pages/reports/PaymentsReport.tsx` | 108 | Same multi-column filter-facet checkbox-list-as-buttons pattern seen in SalesReport/CommissionsReport - full-width rows with a Check indicator, not compact chips. |
| `pages/SchedulePage.tsx` | 2346 | Plan Mode is a lone free-standing binary on/off button (no sibling options to select among) with a ternary amber-vs-white look; better suited to a single Toggle primitive than a ToggleGroup. |
| `pages/reports/EstimateConversionReport.tsx` | 533 | Sample-data demo toggle is a solo free-standing on/off button (amber vs white ternary), no sibling options - a Toggle candidate, not a ToggleGroup. |
| `pages/reports/CommunicationTrackingReport.tsx` | 37 | Sample-data/Live toggle is a solo free-standing binary button (warning tint vs default ternary), no sibling options - a Toggle candidate, not ToggleGroup. |
| `pages/settings/RolesPage.tsx` | 97 | Full-width vertical roles sidebar list (space-y-1, could exceed 5 items) acting as master-detail navigation, not a compact segmented/pill control; ToggleGroup doesn't fit this shape even though it has a selected-vs-not ternary. |
| `components/jobs/items/ScopeOfWorkCard.tsx` | 386 | 'Taxable: Yes/No' is a solo free-standing boolean pill toggling scope.is_taxable directly, no sibling options - a Toggle candidate, not a ToggleGroup. |
| `pages/reports/TechPerformanceBoard.tsx` | 184 | 'Active techs only'/'Showing inactive' is a solo free-standing filter toggle (primary-subtle vs white ternary), no sibling options - a Toggle candidate, not ToggleGroup. |
| `components/ai-center/AiCenterModal.tsx` | 119 | Full-width sidebar nav row (icon+label+count) toggling active/idle style for the 'All AI agents' filter; not chip-shaped and sits in an unbounded-length nav list, not a small fixed set or bordered track. |
| `components/ai-center/AiCenterModal.tsx` | 134 | Same full-width sidebar nav pattern repeated per category via .map; category count is unbounded (not a 2-5 fixed set) and not chip-shaped, so it doesn't cleanly become a ToggleGroup. |
| `components/communication/inbox/InboxDirectory.tsx` | 144 | Underline-style Members/Groups/Forwarding tab bar (3 fixed views, border-b-2 highlight) with no role=tab/aria-selected; real ARIA tab semantics are the correct fix here, not ToggleGroup. |
| `components/communication/inbox/InboxDirectory.tsx` | 286 | Single On/Off pill flipping one forward-rule's boolean 'enabled' field; a lone binary toggle is better modeled as a Switch than a ToggleGroup. |
| `components/communication/phone/Dialer.tsx` | 744 | Open-job chip highlights the currently 'focused' job but clicking navigates to /jobs/:id rather than setting in-component selection state, so it isn't a real togglable option. |
| `components/communication/phone/Dialer.tsx` | 1194 | 'Add'/'Added' button in the conference picker is a one-way, per-row action that becomes permanently disabled once added, not a reversible selection among sibling options. |
| `components/inventory/CategorySelector.tsx` | 54 | Popover/combobox trigger button showing its own open/filtered-state highlight; a single standalone instance, not a member of a toggle group. |
| `pages/reports/ExpensesReport.tsx` | 442 | Per-row receipt-attached toggle in an editable table cell; a single boolean flip on one field, not a set of mutually exclusive sibling options. |
| `pages/reports/ExpensesReport.tsx` | 458 | Per-row Settled/Pending status button that cycles one field on click; not a sibling group of selectable options. |
| `components/inventory/NotificationsDropdown.tsx` | 144 | Single bell-icon button toggling its own dropdown open/closed; one standalone popover trigger, not a group of selectable options. |
| `pages/reports/TimesheetsReport.tsx` | 212 | Hours/Attendance/Location/Job time underline tab bar (4 fixed views) with no role=tab/aria-selected; wants real Tabs semantics, not ToggleGroup - flagged as the clearest a11y gap in this batch. |

## Recommended conversion order

Convert the no-ARIA segmented and pill-single/pill-multi sites first - they are both the tidiness win
(collapsing hand-rolled bordered-track and free-standing-chip patterns onto one primitive) and the real
accessibility fix (adding `aria-pressed`/`role="tab"`/`aria-selected` where none exists today). Work one
screen at a time, verifying each conversion visually in-browser before merging, rather than doing a
repo-wide bulk pass - per the plan's own caution that a sweeping mechanical conversion across 100+ call
sites risks silent visual regressions that unit tests will not catch. The already-ARIA-aware sites (the
remaining 22 convert candidates) are lower urgency since they already communicate state to assistive tech
correctly, even though the underlying markup should still eventually move onto the shared primitive for
consistency. The listbox-option and selectable-card sites stay out of scope entirely - they are wrong
components for this primitive and must not be swept up on a later, less careful pass. The leave-alone sites
need individual human judgment call by call (self-toggling buttons, drill-down navigation, unbounded lists,
per-row cell toggles), not a batch decision.
